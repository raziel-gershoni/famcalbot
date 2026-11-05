/**
 * The sign-in-within-the-hour rule, in one place (web sign-up spec 2026-11-03 §2.9 and its follow-ups §10). Connect
 * Telegram, Add Google, Add email, the browser Google connect and its claim, Turn on and Join add a way to an account (or
 * a Google account to a calendar) from a browser cookie, so each asks that the person signed in for real within the
 * last hour. The comparison reads the cookie's proved-at (`pa`, WebSession.provedAt) and never its sign-in time: a
 * renewal or a Remove re-issues the cookie but never restarts this hour (src/lib/session-auth.ts). Nothing else in the
 * app compares a proved-at with the clock (scripts/smoke-recent-sign-in.ts scans for it).
 *
 * Telegram initData is never asked: the Mini App proves the person on every request. Server only. No line here logs
 * more than the user id and the method.
 */

import { NextResponse } from 'next/server';
import type { AuthResult } from './api-auth';
import type { WebSession } from './session-auth';

/** A way is added only this soon after signing in on the browser that asks. */
export const RECENT_SIGN_IN_MS = 60 * 60 * 1000;

/** Whether a sign-in proved at `provedAt` (epoch ms) is still within the hour: 59:59.999 passes, 60:00.000 does not. */
export function recentlyProved(provedAt: number, now: number = Date.now()): boolean {
  return now - provedAt < RECENT_SIGN_IN_MS;
}

/**
 * Whether this session is the account's own and was proved within the hour. A WhatsApp link's session counts only when
 * the caller allows it: Connect Telegram never does (it needs a real sign-in), the other gates do (a WhatsApp-only
 * person adds Google from the link, within the hour like anyone).
 */
export function sessionRecentlyProved(session: WebSession, userId: number, opts: { allowWhatsApp: boolean }): boolean {
  return session.userId === userId && (opts.allowWhatsApp || session.method !== 'wa') && recentlyProved(session.provedAt);
}

type ProvedAuth = Extract<AuthResult, { success: true }>;

/**
 * null when the request may go on: Telegram initData (via 'telegram'), or a session proved within the hour. Otherwise the
 * answer to send, 403 { ok: false, error: 'stale-sign-in' }, with one log line (`tag` names the route). Call it right
 * after the auth check and before anything that redirects, mails or writes.
 */
export function refuseStaleSignIn(auth: ProvedAuth, tag: string): NextResponse | null {
  if (auth.via === 'telegram') return null;
  if (sessionRecentlyProved(auth.session, auth.user.id, { allowWhatsApp: true })) return null;
  console.warn(`[recent-sign-in] user ${auth.user.id}: ${tag} refused: the ${auth.session.method} sign-in is not recent`);
  return NextResponse.json({ ok: false, error: 'stale-sign-in' }, { status: 403 });
}
