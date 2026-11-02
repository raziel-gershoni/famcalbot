// Settings' side of the sign-in ways (spec 2026-11-02-web-sign-in §4): the "Sign in on the web" group's requests. Each one
// sends JSON with credentials: 'same-origin' (the session cookie in a browser; a POST carries the page's Origin, which
// the routes require), the account in the query string as every user route of the app reads it (?user_id=, the id is not
// a secret) and the initData in the X-Telegram-Init-Data header inside Telegram (initDataHeaders), never in a URL or a
// body. Every answer comes back as a result the group words (settings.signIn.*), and every failure is logged with the
// route (without its query) and the status only: never an address, a code or a link.

import type { SignInMethod } from '@/src/lib/session-auth';
import { initDataHeaders } from '@/src/lib/read-init-data';
import { readJsonBody } from '@/src/lib/read-json';
import type { SignInMethodsView } from '@/src/services/web-signin/identities';

export type MethodsView = SignInMethodsView & { session: SignInMethod | null };
export type RemoveWhich = 'google' | 'email' | 'calendar-google';
export type RequestError = 'failed' | 'busy';
export type AddEmailError = RequestError | 'invalid' | 'limit' | 'has-one';
/** 'codeLimit' is the confirm route's `limit` (too many wrong codes): Add's own `limit` is the day's codes. */
/** Turn on's answers besides success: 'shared' and 'reconnect' have words of their own; 'not-offered' reads as 'failed'. */
export type TurnOnError = RequestError | 'shared' | 'reconnect';
export type ConfirmEmailError = RequestError | 'wrong' | 'taken' | 'restart' | 'codeLimit' | 'has-one';

const TAG = '[signin-methods]';
const SESSION_METHODS: readonly string[] = ['tg', 'google', 'email', 'wa'];

const isAddress = (value: unknown) => value === null || (typeof value === 'object' && typeof (value as { address?: unknown }).address === 'string');

/** The shape GET /api/signin-methods answers, and the `methods` of the confirm and remove answers. */
export function isMethodsView(value: unknown): value is SignInMethodsView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const p = v.providers as Record<string, unknown> | null | undefined;
  return typeof v.telegram === 'boolean' && (v.googleFromCalendar === 'on' || v.googleFromCalendar === 'off' || v.googleFromCalendar === null) && isAddress(v.google) && isAddress(v.email) && !!p && typeof p.telegram === 'boolean' && typeof p.google === 'boolean' && typeof p.email === 'boolean';
}

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
  if (r.body?.error === 'invalid') return { kind: 'error', code: 'invalid' };
  if (r.body?.error === 'limit') return { kind: 'error', code: 'limit' };
  if (r.body?.error === 'has-one') return { kind: 'error', code: 'has-one' };
  return { kind: 'error', code: statusError(r.status) };
}

export async function confirmEmail(userId: number, code: string): Promise<{ kind: 'ok'; methods: SignInMethodsView } | { kind: 'error'; code: ConfirmEmailError }> {
  const r = await post('/api/signin-methods/email/confirm', userId, { code });
  if (!r) return { kind: 'error', code: 'failed' };
  if (r.ok && r.body?.ok === true && isMethodsView(r.body.methods)) return { kind: 'ok', methods: r.body.methods };
  const error = r.body?.error;
  if (error === 'wrong' || error === 'taken' || error === 'restart' || error === 'has-one') return { kind: 'error', code: error };
  if (error === 'limit') return { kind: 'error', code: 'codeLimit' };
  return { kind: 'error', code: statusError(r.status) };
}

export async function removeMethod(userId: number, which: RemoveWhich): Promise<{ kind: 'ok'; methods: SignInMethodsView } | { kind: 'error'; code: RequestError }> {
  const r = await post('/api/signin-methods/remove', userId, { which });
  if (r?.ok && r.body?.ok === true && isMethodsView(r.body.methods)) return { kind: 'ok', methods: r.body.methods };
  return { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

export async function turnOnCalendar(userId: number): Promise<{ kind: 'ok'; methods: SignInMethodsView } | { kind: 'error'; code: TurnOnError }> {
  const r = await post('/api/signin-methods/calendar-on', userId, {});
  if (r?.ok && r.body?.ok === true && isMethodsView(r.body.methods)) return { kind: 'ok', methods: r.body.methods };
  const error = r?.body?.error;
  if (error === 'shared' || error === 'reconnect') return { kind: 'error', code: error };
  return { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

export async function requestGoogleLink(userId: number): Promise<{ kind: 'ok'; url: string } | { kind: 'error'; code: RequestError }> {
  const r = await post('/api/auth/google/add-link', userId, {});
  if (r?.ok && typeof r.body?.url === 'string') return { kind: 'ok', url: r.body.url };
  return { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

export async function signOutHere(userId: number): Promise<{ kind: 'ok' } | { kind: 'error'; code: RequestError }> {
  const r = await post('/api/auth/signout', userId, {});
  return r?.ok && r.body?.ok === true ? { kind: 'ok' } : { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}

export async function signOutAll(userId: number): Promise<{ kind: 'ok' } | { kind: 'error'; code: RequestError }> {
  const r = await post('/api/auth/signout-all', userId, {});
  return r?.ok && r.body?.ok === true ? { kind: 'ok' } : { kind: 'error', code: r ? statusError(r.status) : 'failed' };
}
