// Notifications in the browser (web push spec 2026-11-05 §3.2): this browser subscribes and unsubscribes.
//
// POST   /api/push/devices?user_id=…  body { endpoint, keys: { p256dh, auth } }
//   → 200 { ok: true, count }: the device is stored (count is how many the account has on now), and a "Notifications are on"
//     notification goes to the account's devices after the answer (kind 'test': a reply to the person's own tap, not paused).
//   → 403 { ok: false, error: 'stale-sign-in' }: a new endpoint needs a sign-in from the last hour (refuseStaleSignIn); an
//     endpoint the account already has does not. An endpoint another account holds moves here: the browser just proved it
//     holds it, with that recent sign-in.
//   → 409 { ok: false, error: 'has-chat' }: Telegram or WhatsApp carries everything for this account.
//   → 400 { ok: false, error: 'bad-input' }, 503 { ok: false, error: 'push-off' } (no VAPID keys), 500 { ok: false, error: 'failed' }.
// DELETE /api/push/devices?user_id=…  body { endpoint }
//   → 200 { ok: true }: this account's own device is gone (another account's endpoint, or none, changes nothing and
//     answers the same). No recent sign-in asked, and it works while push is off.
// Both: src/services/web-push/request.ts first (same origin and JSON, the session cookie, 20 a minute per account).
// POST /api/push/devices/check is the sibling route.
//
// No log line, capture or answer holds the endpoint or the keys: a failure is told by its kind (captureSignInFailure),
// because a Prisma error prints the values of its query.

import { NextRequest, NextResponse, after } from 'next/server';
import { getBotMessage } from '@/src/lib/bot-messages';
import { hasChat } from '@/src/lib/has-chat';
import { captureError } from '@/src/lib/error-capture';
import { refuseStaleSignIn } from '@/src/lib/recent-sign-in';
import { appPageUrl } from '@/src/lib/web-session';
import type { UserConfig } from '@/src/types';
import { normalizeLocale } from '@/src/utils/locale';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { addDevice, deleteOwnDevice, isOwnDevice, isValidDeviceInput } from '@/src/services/web-push/devices';
import { endpointOf, pushFront, readPushBody, unknownPushHost } from '@/src/services/web-push/request';
import { sendWebPush } from '@/src/services/web-push/send';

export const dynamic = 'force-dynamic';

/** The "Notifications are on" notification, after the answer. It never throws: a failure is captured. */
async function sendTurnedOn(user: UserConfig, endpoint: string): Promise<void> {
  try {
    const lang = normalizeLocale(user.language);
    await sendWebPush(user, {
      kind: 'test',
      title: await getBotMessage(lang, 'push.turnedOn'),
      body: await getBotMessage(lang, 'push.turnedOnBody'),
      url: appPageUrl(lang, 'dashboard', user.id),
      tag: 'push-turned-on',
      lang,
      onlyEndpoint: endpoint,
    });
  } catch (error) {
    captureError(error, 'push-turned-on', { api_route: '/api/push/devices', user_id: user.id }, 'warning');
  }
}

export async function POST(request: NextRequest) {
  let userId: number | undefined;
  try {
    const front = await pushFront(request, 'push-devices', { needsPushOn: true });
    if (!front.ok) return front.response;
    const { auth } = front;
    userId = auth.user.id;
    if (hasChat(auth.user)) {
      console.warn(`[push] user ${userId}: subscribe refused: the account has a chat`);
      return NextResponse.json({ ok: false, error: 'has-chat' }, { status: 409 });
    }
    const body = await readPushBody(request, 'push-devices');
    if (!isValidDeviceInput(body)) {
      const host = unknownPushHost(body);
      console.warn(host === null ? `[push] user ${userId}: subscribe refused: bad input` : `[push] user ${userId}: subscribe refused: unknown push service ${host}`);
      return NextResponse.json({ ok: false, error: 'bad-input' }, { status: 400 });
    }
    // The hour is for a device the account does not have yet: one it already has re-subscribes with no new proof
    if (!(await isOwnDevice(userId, body.endpoint))) {
      const stale = refuseStaleSignIn(auth, 'push-devices');
      if (stale) return stale;
    }
    const { moved, count } = await addDevice(userId, { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } });
    console.log(`[push] user ${userId}: device ${moved ? 'moved here from another account' : 'added'} (${count} on this account)`);
    after(() => sendTurnedOn(auth.user, body.endpoint));
    return NextResponse.json({ ok: true, count });
  } catch (error) {
    captureSignInFailure(error, 'push-devices', { user_id: userId });
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  let userId: number | undefined;
  try {
    const front = await pushFront(request, 'push-devices-delete', { needsPushOn: false });
    if (!front.ok) return front.response;
    userId = front.auth.user.id;
    const endpoint = endpointOf(await readPushBody(request, 'push-devices-delete'));
    if (endpoint === null) {
      console.warn(`[push] user ${userId}: unsubscribe refused: bad input`);
      return NextResponse.json({ ok: false, error: 'bad-input' }, { status: 400 });
    }
    const removed = await deleteOwnDevice(userId, endpoint);
    console.log(`[push] user ${userId}: device ${removed ? 'removed' : 'not found; nothing removed'}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    captureSignInFailure(error, 'push-devices-delete', { user_id: userId });
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 });
  }
}
