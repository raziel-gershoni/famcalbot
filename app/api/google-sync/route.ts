// The calendars page's "Copy to Google" rows (google-sync spec §1, §3, §4).
//
// GET    /api/google-sync?user_id=…  — a row per own live FamCal calendar: the copy's state
//        and progress (src/services/google-sync/view.ts), and the partner's first name for
//        the non-owner line.
// POST   /api/google-sync?user_id=…  — body { action: 'enable', nativeCalendarId }: turn the
//        copy on when the user holds calendar.app.created and a token, else start the 'sync'
//        consent (spec §3 Asked only on first use) and answer its Google URL; or
//        { action: 'recreate', linkId }: "Create it again" / "Copy again from scratch?".
// DELETE /api/google-sync?user_id=…  — body { nativeCalendarId, googleCopy: 'remove' | 'keep' }:
//        turn the copy off, the choice queued for the worker.
//
// Security: verifyUserAuth proves the caller (Telegram initData, or the WhatsApp session),
// with the general limiter for the page's polling GET and the settings one for writes, as
// the neighbouring calendar routes. A calendar must be the caller's own live calendar and a
// link the caller's own; ids from the body are used for nothing else. Turning on or making
// again needs the plan's google_sync; turning off never does, so a lapsed plan can always
// take its copies out of Google. Logs carry ids only.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { generalRateLimiter, settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';
import { prisma } from '@/src/utils/prisma';
import { createGoogleConsent } from '@/src/services/google-connect';
import { syncAllowed } from '@/src/services/google-sync/access';
import { enableSyncLink, recreateSyncLink } from '@/src/services/google-sync/links';
import { markedTransaction, unlinkSync, type UnlinkChoice } from '@/src/services/google-sync/marks';
import { hasSyncScope } from '@/src/services/google-sync/scopes';
import { copiesView } from '@/src/services/google-sync/view';

export const dynamic = 'force-dynamic';

/** A FamCal calendar id or a link id is a cuid; anything longer, or not a string, is not one. */
const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= 64;
const CHOICES = new Set<UnlinkChoice>(['remove', 'keep']);

/** The caller's own live calendar with this id, or null. */
async function ownCalendar(userId: number, id: string): Promise<{ id: string } | null> {
  return prisma.nativeCalendar.findFirst({ where: { id, ownerUserId: userId, isDeleted: false }, select: { id: true } });
}

export async function GET(request: NextRequest) {
  let userId: number | undefined;
  try {
    const { searchParams } = new URL(request.url);
    const auth = await verifyUserAuth(request, searchParams.get('user_id'), requestInitData(request), generalRateLimiter, 'google-sync-get');
    if (!auth.success) return auth.response;
    userId = auth.user.id;
    const view = await copiesView({ id: auth.user.id, pairingId: auth.user.pairingId ?? null }, Boolean(auth.user.googleRefreshToken));
    return NextResponse.json(view);
  } catch (error) {
    captureError(error, 'google-sync-get', { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let userId: number | undefined;
  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const auth = await verifyUserAuth(request, searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'google-sync-post');
    if (!auth.success) return auth.response;
    const user = auth.user;
    userId = user.id;

    const action = body?.action;
    const wanted = action === 'enable' ? body.nativeCalendarId : action === 'recreate' ? body.linkId : undefined;
    if (!isId(wanted)) {
      console.warn(`[google-sync] user ${user.id}: refused a copy request (action ${typeof action === 'string' ? action.slice(0, 20) : typeof action})`);
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (!(await syncAllowed(user.id))) {
      console.log(`[google-sync] user ${user.id}: ${action} refused: the plan lacks google_sync`);
      return NextResponse.json({ error: 'upgrade_required' }, { status: 403 });
    }

    if (action === 'recreate') {
      // recreateSyncLink acts only on the caller's own copy that is on, in 'gone' or 'otherAccount'.
      const done = await recreateSyncLink(user.id, wanted);
      return done
        ? NextResponse.json({ status: 'recreated' })
        : NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const calendar = await ownCalendar(user.id, wanted);
    if (!calendar) {
      console.warn(`[google-sync] user ${user.id}: no copy of calendar ${wanted}: not their own live calendar`);
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { googleScopes: true } });
    const scopes = row?.googleScopes ?? [];
    if (user.googleRefreshToken && hasSyncScope(scopes)) {
      // The permission is held: the copy turns on here (the commit's own enableSyncLink); the
      // worker adopts the token's account on its first pass.
      const result = await enableSyncLink(user.id, { nativeCalendarId: calendar.id, googleAccount: null }, scopes);
      if (result.status === 'not_owner') return NextResponse.json({ error: 'not_found' }, { status: 404 });
      return NextResponse.json({ status: result.status });
    }
    // First use (or no Google yet): Google's consent for calendar.app.created, with the
    // calendar in the state; the commit after the user's tap turns the copy on.
    const consent = await createGoogleConsent(user.id, { purpose: 'sync', nativeCalendarId: calendar.id });
    if (consent.status === 'upgrade_required') return NextResponse.json({ error: 'upgrade_required' }, { status: 403 });
    if (consent.status !== 'ok') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    console.log(`[google-sync] user ${user.id}: sync consent started for calendar ${calendar.id}`);
    // serverTime as oauth/start's: the page's tap on the server's clock.
    return NextResponse.json({ status: 'consent', oauthUrl: consent.oauthUrl, serverTime: Date.now() });
  } catch (error) {
    captureError(error, 'google-sync-post', { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  let userId: number | undefined;
  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const auth = await verifyUserAuth(request, searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'google-sync-delete');
    if (!auth.success) return auth.response;
    const user = auth.user;
    userId = user.id;

    const choice = body?.googleCopy as UnlinkChoice;
    if (!isId(body?.nativeCalendarId) || !CHOICES.has(choice)) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const calendar = await ownCalendar(user.id, body.nativeCalendarId);
    const link = calendar && await prisma.googleSyncLink.findFirst({
      where: { userId: user.id, nativeCalendarId: calendar.id, enabled: true },
      select: { id: true },
    });
    if (!link) {
      console.warn(`[google-sync] user ${user.id}: no copy that is on for calendar ${String(body.nativeCalendarId)} to turn off`);
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    await markedTransaction((tx) => unlinkSync(tx, { linkIds: [link.id] }, choice));
    console.log(`[google-sync] user ${user.id}: copy ${link.id} turned off (${choice})`);
    return NextResponse.json({ status: 'off' });
  } catch (error) {
    captureError(error, 'google-sync-delete', { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
