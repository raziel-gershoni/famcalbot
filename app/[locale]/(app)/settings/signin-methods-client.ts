// Settings' side of the sign-in ways (spec 2026-11-02-web-sign-in §4): the "Sign in on the web" group's requests. Each one
// sends JSON with credentials: 'same-origin' (the session cookie in a browser; a POST carries the page's Origin, which
// the routes require), the account in the query string as every user route of the app reads it (?user_id=, the id is not
// a secret) and the initData in the X-Telegram-Init-Data header inside Telegram (initDataHeaders), never in a URL or a
// body. Every answer comes back as a result the group words (settings.signIn.*), and every failure is logged with the
// route (without its query) and the status only: never an address, a code or a link.
// The two sign-outs unsubscribe this browser's notifications first (web-push-client.ts turnOffPush).

import type { SignInMethod } from '@/src/lib/session-auth';
import { initDataHeaders } from '@/src/lib/read-init-data';
import { readJsonBody } from '@/src/lib/read-json';
import { currentPushEndpoint, turnOffPush } from '@/src/lib/web-push-client';
import type { SignInMethodsView } from '@/src/services/web-signin/identities';
import { isJoinSummary, type JoinSummary } from '@/src/lib/join-summary';

export type MethodsView = SignInMethodsView & { session: SignInMethod | null };
export type RemoveWhich = 'google' | 'email' | 'calendar-google';
export type RequestError = 'failed' | 'busy';
/**
 * The sign-in is over an hour old (6c-1 follow-ups): the routes that add a way answer 403 { error: 'stale-sign-in' } to a
 * browser's cookie, never to the Mini App. Matched by the body's error and never by the status alone (a 403 is also
 * "suspended"); the group then asks to sign in again (SignInMethods).
 */
export type StaleError = 'stale';
/** Remove's answers besides success: 'last-way' is the account's only durable way, which the server refuses. */
export type RemoveError = RequestError | 'last-way';
export type AddEmailError = RequestError | StaleError | 'invalid' | 'limit' | 'has-one';
/** 'codeLimit' is the confirm route's `limit` (too many wrong codes): Add's own `limit` is the day's codes. */
export type ConfirmEmailError = RequestError | StaleError | 'wrong' | 'taken' | 'restart' | 'codeLimit' | 'has-one';
/** Join's answers besides success: the question expired or was used, or the two can't be joined (any more). */
export type JoinError = RequestError | StaleError | 'expired' | 'refused';
/** Turn on's answers besides success: 'shared' and 'reconnect' have words of their own; 'not-offered' reads as 'failed'. */
export type TurnOnError = RequestError | StaleError | 'shared' | 'reconnect';

const TAG = '[signin-methods]';
const SESSION_METHODS: readonly string[] = ['tg', 'google', 'email', 'wa'];

const LAST_WAYS: readonly string[] = ['telegram', 'whatsapp', 'google', 'email'];

const isAddress = (value: unknown) => value === null || (typeof value === 'object' && typeof (value as { address?: unknown }).address === 'string');

/** The shape GET /api/signin-methods answers, and the `methods` of the confirm and remove answers. */
export function isMethodsView(value: unknown): value is SignInMethodsView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const p = v.providers as Record<string, unknown> | null | undefined;
  return typeof v.telegram === 'boolean' && (v.googleFromCalendar === 'on' || v.googleFromCalendar === 'off' || v.googleFromCalendar === null) && isAddress(v.google) && isAddress(v.email) && !!p && typeof p.telegram === 'boolean' && typeof p.google === 'boolean' && typeof p.email === 'boolean'
    && typeof v.chat === 'boolean' && (v.lastWay === null || LAST_WAYS.includes(String(v.lastWay)));
}

/** Whether a POST was refused for a sign-in over an hour old. */
const isStale = (r: { status: number; body: Record<string, unknown> | null } | null): boolean => r?.status === 403 && r.body?.error === 'stale-sign-in';

/** A 429 is the route's rate limit; anything else is a plain failure. */
const statusError = (status: number): RequestError => (status === 429 ? 'busy' : 'failed');

/** One POST for an account (`?user_id=`, as every user route reads it): its status and body, or null when it never got an answer (logged). */
async function post(pathname: string, userId: number, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null } | null> {
  try {
    const res = await fetch(`${pathname}?user_id=${userId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...initDataHeaders() },
      body: JSON.stringify(body),
    });
    const answer = await readJsonBody(res, `${TAG} ${pathname}`);
    if (!res.ok) console.warn(`${TAG} ${pathname} answered ${res.status}`);
    return { status: res.status, ok: res.ok, body: answer };
  } catch (error) {
    console.error(`${TAG} ${pathname} failed: ${error instanceof Error ? error.name : typeof error}`);
    return null;
  }
}

export async function loadMethods(userId: number): Promise<{ kind: 'ok'; view: MethodsView } | { kind: 'error' }> {
  try {
    const res = await fetch(`/api/signin-methods?user_id=${userId}`, { credentials: 'same-origin', headers: initDataHeaders() });
    const body = await readJsonBody(res, `${TAG} GET`);
    if (res.ok && isMethodsView(body)) {
      const session = (body as { session?: unknown }).session;
      return { kind: 'ok', view: { ...body, session: typeof session === 'string' && SESSION_METHODS.includes(session) ? (session as SignInMethod) : null } };
    }
    console.warn(`${TAG} GET answered ${res.status}`);
    return { kind: 'error' };
  } catch (error) {
    console.error(`${TAG} GET failed: ${error instanceof Error ? error.name : typeof error}`);
    return { kind: 'error' };
  }
}

export async function addEmail(userId: number, email: string): Promise<{ kind: 'ok' } | { kind: 'error'; code: AddEmailError }> {
  const r = await post('/api/signin-methods/email/add', userId, { email });
  if (!r) return { kind: 'error', code: 'failed' };
  if (r.ok && r.body?.ok === true) return { kind: 'ok' };
  if (isStale(r)) return { kind: 'error', code: 'stale' };
  if (r.body?.error === 'invalid') return { kind: 'error', code: 'invalid' };
  if (r.body?.error === 'limit') return { kind: 'error', code: 'limit' };
  if (r.body?.error === 'has-one') return { kind: 'error', code: 'has-one' };
  return { kind: 'error', code: statusError(r.status) };
}

export async function confirmEmail(
  userId: number,
  code: string,
): Promise<{ kind: 'ok'; methods: SignInMethodsView } | { kind: 'join'; joinId: string; summary: JoinSummary } | { kind: 'error'; code: ConfirmEmailError }> {
  const r = await post('/api/signin-methods/email/confirm', userId, { code });
  if (!r) return { kind: 'error', code: 'failed' };
  if (r.ok && r.body?.ok === true && isMethodsView(r.body.methods)) return { kind: 'ok', methods: r.body.methods };
  if (isStale(r)) return { kind: 'error', code: 'stale' };
  const error = r.body?.error;
  if (error === 'join' && typeof r.body?.joinId === 'string' && isJoinSummary(r.body.summary)) return { kind: 'join', joinId: r.body.joinId, summary: r.body.summary };
  if (error === 'wrong' || error === 'taken' || error === 'restart' || error === 'has-one') return { kind: 'error', code: error };
  if (error === 'limit') return { kind: 'error', code: 'codeLimit' };
  return { kind: 'error', code: statusError(r.status) };
}

/** Join: the answer to the question an Add email ended on. The question's id goes as `token` (the scrubber drops it). */
export async function joinAccount(userId: number, joinId: string): Promise<{ kind: 'ok'; methods: SignInMethodsView } | { kind: 'error'; code: JoinError }> {
  const r = await post('/api/signin-methods/join', userId, { token: joinId });
  if (!r) return { kind: 'error', code: 'failed' };
  if (r.ok && r.body?.ok === true && isMethodsView(r.body.methods)) return { kind: 'ok', methods: r.body.methods };
  if (isStale(r)) return { kind: 'error', code: 'stale' };
  const error = r.body?.error;
  if (error === 'expired' || error === 'refused') return { kind: 'error', code: error };
  return { kind: 'error', code: statusError(r.status) };
}

/**
 * Remove a way. Every other browser's session ends with it, and with them their notification devices; this browser's
 * subscription goes along (6c-2 spec §2.4), so its device stays. None in this browser: the body is { which } alone.
 */
export async function removeMethod(userId: number, which: RemoveWhich): Promise<{ kind: 'ok'; methods: SignInMethodsView } | { kind: 'error'; code: RemoveError }> {
  const endpoint = await currentPushEndpoint();
  const r = await post('/api/signin-methods/remove', userId, endpoint ? { which, endpoint } : { which });
  if (r?.ok && r.body?.ok === true && isMethodsView(r.body.methods)) return { kind: 'ok', methods: r.body.methods };
  if (r?.body?.error === 'last-way') return { kind: 'error', code: 'last-way' };
  return { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

export async function turnOnCalendar(userId: number): Promise<{ kind: 'ok'; methods: SignInMethodsView } | { kind: 'error'; code: TurnOnError }> {
  const r = await post('/api/signin-methods/calendar-on', userId, {});
  if (r?.ok && r.body?.ok === true && isMethodsView(r.body.methods)) return { kind: 'ok', methods: r.body.methods };
  if (isStale(r)) return { kind: 'error', code: 'stale' };
  const error = r?.body?.error;
  if (error === 'shared' || error === 'reconnect') return { kind: 'error', code: error };
  return { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

export async function requestGoogleLink(userId: number): Promise<{ kind: 'ok'; url: string } | { kind: 'error'; code: RequestError | StaleError }> {
  const r = await post('/api/auth/google/add-link', userId, {});
  if (r?.ok && typeof r.body?.url === 'string') return { kind: 'ok', url: r.body.url };
  if (isStale(r)) return { kind: 'error', code: 'stale' };
  return { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

/**
 * Sign out on this device. This browser's notifications end with its sign-in (6c-2 §2.4): it unsubscribes and its device is
 * deleted first (turnOffPush; a failure is logged there and never stops the sign-out, whose route stays query-free).
 */
export async function signOutHere(userId: number): Promise<{ kind: 'ok' } | { kind: 'error'; code: RequestError }> {
  await turnOffPush(userId);
  const r = await post('/api/auth/signout', userId, {});
  return r?.ok && r.body?.ok === true ? { kind: 'ok' } : { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

/** Sign out on all devices: this browser unsubscribes first, as for signOutHere (the route deletes every other device: Task 6). */
export async function signOutAll(userId: number): Promise<{ kind: 'ok' } | { kind: 'error'; code: RequestError }> {
  await turnOffPush(userId);
  const r = await post('/api/auth/signout-all', userId, {});
  return r?.ok && r.body?.ok === true ? { kind: 'ok' } : { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}
