/**
 * The web session cookie (spec 2026-11-02-web-sign-in §2.4, §2.16, §3). An HMAC-signed JSON payload, kept nowhere but
 * the browser. It says who signed in (userId, the DB id), how (m: 'tg' | 'google' | 'email' | 'wa') and when (at,
 * epoch ms), when the person last proved who they are by signing in (pa, epoch ms), plus when it was issued (iat) and
 * when it ends (exp), in seconds.
 *
 * - A WhatsApp link's session lasts 24 hours and is never renewed (a fresh cookie for one, after Remove, keeps its old
 *   end: createSessionToken's `exp` and setSessionCookie's `maxAgeSec`).
 * - One made by signing in on famcal.bot lasts 30 days, and page-data renews it while it is used (needsRenewal),
 *   keeping its method and first sign-in time.
 * - `at` and `pa` part only when a way is removed: the device's fresh cookie is signed in now (after the new
 *   sessionsValidAfter, so it stays signed in) but keeps its proved-at. Only a real sign-in (createSessionToken, called
 *   by finishSignIn alone) sets a fresh proved-at; every re-issue (reissueSessionToken) carries it over. Connect
 *   Telegram's "a sign-in within the hour" reads it (web sign-up spec §2.9), so no renewal and no removal restarts that
 *   hour.
 * - Ending sessions is the user row's sessionsValidAfter, which verifyUserAuth compares with `at`
 *   (src/lib/api-auth.ts).
 *
 * The cookie is __Host-famcal_session: always Secure, Path=/, no Domain, so no famcal.bot subdomain can plant one.
 * (Browsers accept a Secure cookie on http://localhost, so local runs keep working.) It sits beside Telegram initData
 * auth and does not replace it.
 */

import crypto from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { appKey } from './app-keys';

/** How the person signed in: Telegram, Google, an email code, or a WhatsApp link. */
export type SignInMethod = 'tg' | 'google' | 'email' | 'wa';
const METHODS: readonly SignInMethod[] = ['tg', 'google', 'email', 'wa'];

/**
 * A session cookie that passed its signature and expiry check. signedInAt (what sessionsValidAfter is compared with) and
 * provedAt (when the person last signed in for real) are epoch ms; iat and exp are seconds.
 */
export interface WebSession {
  userId: number;
  method: SignInMethod;
  signedInAt: number;
  provedAt: number;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE_NAME = '__Host-famcal_session';

/** A WhatsApp link's session, and one from signing in on famcal.bot (from its last renewal). */
export const SESSION_TTL_SEC = { wa: 24 * 60 * 60, web: 30 * 24 * 60 * 60 } as const;

/** A famcal.bot session is renewed once it is older than this (by its iat). */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the cookie carries. A cookie made before 6b has no m and no at; one made before 6c-1's fix has no pa. */
interface SessionPayload {
  userId: number;
  m?: SignInMethod;
  at?: number;
  pa?: number;
  iat: number;
  exp: number;
}

const ttlFor = (method: SignInMethod) => (method === 'wa' ? SESSION_TTL_SEC.wa : SESSION_TTL_SEC.web);

const sign = (key: Buffer, body: string) => crypto.createHmac('sha256', key).update(body).digest('base64url');

const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };

/** Signs a payload issued now, lasting by `method` (or until an earlier `exp`). Throws without SESSION_SECRET. */
function mint(userId: number, method: SignInMethod, signedInAt: number, provedAt: number, exp: number | undefined): string {
  const key = appKey('session-cookie');
  if (!key) {
    throw new Error('SESSION_SECRET is not set: cannot sign a session cookie');
  }
  const iat = Math.floor(Date.now() / 1000);
  const latest = iat + ttlFor(method);
  if (exp !== undefined && !(Number.isSafeInteger(exp) && exp > iat)) {
    throw new Error('a session token\'s exp must be a whole number of seconds after now');
  }
  const payload: SessionPayload = { userId, m: method, at: signedInAt, pa: provedAt, iat, exp: exp === undefined ? latest : Math.min(exp, latest) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(key, body)}`;
}

/**
 * The session token of a sign-in: `userId` signed in by `method` at `signedInAt` (epoch ms, now), which is also its
 * proved-at, lasting by `method` (or until an earlier `opts.exp`, as reissueSessionToken takes it). finishSignIn is its
 * only caller in the app (scripts/smoke-web-session.ts #4c): a session that already exists is issued again only with
 * reissueSessionToken. Throws without SESSION_SECRET (no fallback to another secret).
 */
export function createSessionToken(userId: number, method: SignInMethod, signedInAt: number, opts: { exp?: number } = {}): string {
  return mint(userId, method, signedInAt, signedInAt, opts.exp);
}

/**
 * The same session issued again, now: its user, method and proved-at carried over unchanged, so neither a renewal nor a
 * removal makes an old sign-in look recent. `opts.signedInAt` replaces the sign-in time (Remove: now, so the device
 * stays after the sessionsValidAfter it just moved); without it the session's own is kept (page-data's renewal).
 * `opts.exp` (epoch seconds) keeps an earlier end: a WhatsApp link's cookie made again after Remove ends when the first
 * one did (spec §2.4, never renewed). It is used as given, never later than the method's own life from now, and must be
 * after now. Throws without SESSION_SECRET.
 */
export function reissueSessionToken(session: WebSession, opts: { signedInAt?: number; exp?: number } = {}): string {
  return mint(session.userId, session.method, opts.signedInAt ?? session.signedInAt, session.provedAt, opts.exp);
}

/**
 * The session a token holds, or null: no key, a bad signature, not our shape, or expired. A cookie made before 6b
 * (no method, no sign-in time) reads as a WhatsApp link's, signed in at its iat; it can only arrive under the new
 * name if someone copies it, and then it is still that same person's 24-hour session. A malformed payload warns once,
 * never with the cookie.
 */
export function validateSessionToken(token: string): WebSession | null {
  // No key, no session: appKey reports the missing SESSION_SECRET once per process
  const key = appKey('session-cookie');
  if (!key) return null;

  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const got = Buffer.from(signature, 'base64url');
  const want = Buffer.from(sign(key, body), 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;

  let payload: Partial<SessionPayload> | null;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<SessionPayload> | null;
  } catch {
    // Signed by us but not our JSON: deny. Never log the cookie.
    console.warn('[session] malformed session cookie');
    return null;
  }
  const userId = payload?.userId;
  const iat = payload?.iat;
  const exp = payload?.exp;
  const at = payload?.at;
  const pa = payload?.pa;
  const method = payload?.m === undefined ? 'wa' : METHODS.includes(payload.m) ? payload.m : null;
  if (
    typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0
    || typeof iat !== 'number' || !Number.isFinite(iat)
    || typeof exp !== 'number' || !Number.isFinite(exp)
    || (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at)))
    || (pa !== undefined && (typeof pa !== 'number' || !Number.isFinite(pa)))
    || method === null
  ) {
    console.warn('[session] malformed session cookie');
    return null;
  }
  if (exp < Math.floor(Date.now() / 1000)) return null;
  // A cookie with no pa was made before the proved-at existed: its sign-in time is the best it says
  const signedInAt = at ?? iat * 1000;
  return { userId, method, signedInAt, provedAt: pa ?? signedInAt, iat, exp };
}

/** The request's session cookie, checked (signature and expiry only; verifyUserAuth checks the row). */
export function readSession(request: NextRequest): WebSession | null {
  const value = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return value ? validateSessionToken(value) : null;
}

/**
 * Sets the session cookie on a response. It lasts as long as the token's own method gives (30 days, or 24 hours for a
 * WhatsApp link), or `opts.maxAgeSec` seconds (a positive whole number) when a caller keeps an earlier end. A token that
 * is not a valid session of ours throws: only createSessionToken's and reissueSessionToken's output belongs in the cookie.
 */
export function setSessionCookie(response: NextResponse, token: string, opts: { maxAgeSec?: number } = {}): void {
  const session = validateSessionToken(token);
  if (!session) throw new Error('setSessionCookie: the token is not a valid session');
  if (opts.maxAgeSec !== undefined && !(Number.isSafeInteger(opts.maxAgeSec) && opts.maxAgeSec > 0)) {
    throw new Error('setSessionCookie: maxAgeSec must be a positive whole number of seconds');
  }
  response.cookies.set(SESSION_COOKIE_NAME, token, { ...COOKIE_OPTIONS, maxAge: opts.maxAgeSec ?? ttlFor(session.method) });
}

/**
 * Clears the session cookie: it is set again empty with Max-Age=0. Not cookies.delete: that sends no Secure, and a
 * browser takes a __Host- cookie only with Secure and Path=/, so the old one would stay.
 */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, '', { ...COOKIE_OPTIONS, maxAge: 0 });
}

/** Whether page-data renews this session: a famcal.bot sign-in's (never a WhatsApp link's) over a day old. */
export function needsRenewal(session: WebSession, nowMs: number): boolean {
  return session.method !== 'wa' && nowMs - session.iat * 1000 > RENEW_AFTER_MS;
}
