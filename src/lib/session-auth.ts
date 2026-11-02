/**
 * The web session cookie (spec 2026-11-02-web-sign-in §2.4, §2.16, §3). An HMAC-signed JSON payload, kept nowhere but
 * the browser. It says who signed in (userId, the DB id), how (m: 'tg' | 'google' | 'email' | 'wa') and when (at,
 * epoch ms), plus when it was issued (iat) and when it ends (exp), in seconds.
 *
 * - A WhatsApp link's session lasts 24 hours and is never renewed (a fresh cookie for one, after Remove, keeps its old
 *   end: createSessionToken's `exp` and setSessionCookie's `maxAgeSec`).
 * - One made by signing in on famcal.bot lasts 30 days, and page-data renews it while it is used (needsRenewal),
 *   keeping its method and first sign-in time.
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

/** A session cookie that passed its signature and expiry check. signedInAt is epoch ms; iat and exp are seconds. */
export interface WebSession {
  userId: number;
  method: SignInMethod;
  signedInAt: number;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE_NAME = '__Host-famcal_session';

/** A WhatsApp link's session, and one from signing in on famcal.bot (from its last renewal). */
export const SESSION_TTL_SEC = { wa: 24 * 60 * 60, web: 30 * 24 * 60 * 60 } as const;

/** A famcal.bot session is renewed once it is older than this (by its iat). */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the cookie carries. A cookie made before 6b has no m and no at. */
interface SessionPayload {
  userId: number;
  m?: SignInMethod;
  at?: number;
  iat: number;
  exp: number;
}

const ttlFor = (method: SignInMethod) => (method === 'wa' ? SESSION_TTL_SEC.wa : SESSION_TTL_SEC.web);

const sign = (key: Buffer, body: string) => crypto.createHmac('sha256', key).update(body).digest('base64url');

const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };

/**
 * A signed session token for `userId`, issued now, lasting by `method`. `signedInAt` is the moment the person signed in
 * (epoch ms): now for a new sign-in, the first sign-in's time for a renewal. `opts.exp` (epoch seconds) keeps an
 * earlier end: a WhatsApp link's cookie made again after Remove ends when the first one did (spec §2.4, never
 * renewed). It is used as given, never later than the method's own life from now, and must be after now. Throws
 * without SESSION_SECRET (no fallback to another secret).
 */
export function createSessionToken(userId: number, method: SignInMethod, signedInAt: number, opts: { exp?: number } = {}): string {
  const key = appKey('session-cookie');
  if (!key) {
    throw new Error('SESSION_SECRET is not set: cannot sign a session cookie');
  }
  const iat = Math.floor(Date.now() / 1000);
  const latest = iat + ttlFor(method);
  if (opts.exp !== undefined && !(Number.isSafeInteger(opts.exp) && opts.exp > iat)) {
    throw new Error('createSessionToken: exp must be a whole number of seconds after now');
  }
  const payload: SessionPayload = { userId, m: method, at: signedInAt, iat, exp: opts.exp === undefined ? latest : Math.min(opts.exp, latest) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(key, body)}`;
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
  const method = payload?.m === undefined ? 'wa' : METHODS.includes(payload.m) ? payload.m : null;
  if (
    typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0
    || typeof iat !== 'number' || !Number.isFinite(iat)
    || typeof exp !== 'number' || !Number.isFinite(exp)
    || (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at)))
    || method === null
  ) {
    console.warn('[session] malformed session cookie');
    return null;
  }
  if (exp < Math.floor(Date.now() / 1000)) return null;
  return { userId, method, signedInAt: at ?? iat * 1000, iat, exp };
}

/** The request's session cookie, checked (signature and expiry only; verifyUserAuth checks the row). */
export function readSession(request: NextRequest): WebSession | null {
  const value = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return value ? validateSessionToken(value) : null;
}

/**
 * Sets the session cookie on a response. It lasts as long as the token's own method gives (30 days, or 24 hours for a
 * WhatsApp link), or `opts.maxAgeSec` seconds (a positive whole number) when a caller keeps an earlier end. A token that
 * is not a valid session of ours throws: only createSessionToken's output belongs in the cookie.
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
