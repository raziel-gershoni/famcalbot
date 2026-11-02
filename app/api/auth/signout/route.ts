// POST /api/auth/signout: sign out on this device (web sign-in spec §2.4, §4). Clears this browser's session cookie.
// Origin and JSON are checked (same-origin.ts), so another site can't sign you out. No account read, no database query.

import { NextRequest, NextResponse } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { clearSessionCookie, readSession } from '@/src/lib/session-auth';

export async function POST(request: NextRequest) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const session = readSession(request);
  console.info(`[signout] ${session ? `user ${session.userId} (${session.method})` : 'a browser without a valid session'} signed out on this device`);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
