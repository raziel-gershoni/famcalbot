// Settings' "Disconnect Google" (docs/superpowers/specs/2026-10-25-disconnect-google-design.md).
//
// POST /api/google-disconnect?user_id=…  — body { deleteCopies: boolean }: delete the FamCal
//   copy calendars from Google (when asked), revoke the token, clear everything local.
//   Answers { status: 'disconnected', leftover: string[] }: the copy calendars that couldn't
//   be deleted, named as they are in Google.
//
// Security: verifyUserAuth proves the caller (Telegram initData, or the WhatsApp session)
// with the settings limiter, as the neighbouring settings routes; the route acts only on the
// proved user (auth.user.id), never on the id in the URL. The body decides nothing else.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';
import { disconnectGoogle } from '@/src/services/google-disconnect';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let userId: number | undefined;
  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json().catch(() => null);
    const auth = await verifyUserAuth(request, searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'google-disconnect');
    if (!auth.success) return auth.response;
    userId = auth.user.id;

    if (typeof body?.deleteCopies !== 'boolean') {
      console.warn(`[google-disconnect] user ${userId}: refused a request without a boolean deleteCopies`);
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const result = await disconnectGoogle(userId, { deleteCopies: body.deleteCopies });
    return NextResponse.json({ status: 'disconnected', leftover: result.leftover });
  } catch (error) {
    captureError(error, 'google-disconnect', { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
