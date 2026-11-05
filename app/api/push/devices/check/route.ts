// Notifications in the browser (web push spec 2026-11-05 §3.2): whether this browser's subscription is this account's. The
// app asks on every open, so a subscription a shared browser kept from an old account is unsubscribed, never moved.
//
// POST /api/push/devices/check?user_id=…  body { endpoint }
//   → 200 { ok: true, mine: boolean }: true only for an endpoint this account holds. Another account's endpoint and one
//     nobody holds get the same answer (false), so the route tells nothing about anyone else.
//   → 400 { ok: false, error: 'bad-input' }, 503 { ok: false, error: 'push-off' }, 500 { ok: false, error: 'failed' }.
// Same front as the sibling route (src/services/web-push/request.ts). The endpoint is never logged.

import { NextRequest, NextResponse } from 'next/server';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { isOwnDevice } from '@/src/services/web-push/devices';
import { endpointOf, pushFront, readPushBody } from '@/src/services/web-push/request';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let userId: number | undefined;
  try {
    const front = await pushFront(request, 'push-devices-check', { needsPushOn: true });
    if (!front.ok) return front.response;
    userId = front.auth.user.id;
    const endpoint = endpointOf(await readPushBody(request, 'push-devices-check'));
    if (endpoint === null) {
      console.warn(`[push] user ${userId}: check refused: bad input`);
      return NextResponse.json({ ok: false, error: 'bad-input' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, mine: await isOwnDevice(userId, endpoint) });
  } catch (error) {
    captureSignInFailure(error, 'push-devices-check', { user_id: userId });
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 });
  }
}
