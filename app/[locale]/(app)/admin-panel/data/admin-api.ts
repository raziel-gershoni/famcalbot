// The one way the admin panel talks to /api/admin/* (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Task 1).
//
// - A GET and a DELETE carry the Telegram launch data in the X-Telegram-Init-Data header (initDataHeaders), never in a
//   URL. A POST carries it twice: in the header, and as `initData` in the JSON body, because eight of the POST routes
//   (settings, user-overrides, subscription, send-reminder, reset-reminders, switch-platform, users/moderation,
//   users/blocklist) read the body only. It is read with readInitData(), which also finds it where the SDK has not.
// - Nothing here throws. Every call answers `{ ok: true, data }` or `{ ok: false, status, code? }`: `status` is the HTTP
//   status (0 when there was no answer at all), `code` the route's `error` when it is a code (SELF_BAN), never its prose,
//   which is English and not for the screen. A 200 whose body is not `success: true` is a failure too.
// - Every failure is logged here, once: `[admin] <path> failed:` with the method and what came back. A caller shows the
//   person a message in the page's language; it does not log the same failure again.
//
// `path` is the part after /api/admin/ ('user-overrides', 'users/blocklist').

import { initDataHeaders, readInitData } from '@/src/lib/read-init-data';

export interface AdminFailure {
  ok: false;
  /** The HTTP status; 0 when the request got no answer (offline, a throw, a body that is no JSON on a 2xx). */
  status: number;
  /** The route's error when it is a code in capitals (SELF_BAN). */
  code?: string;
}
export type AdminResult<T> = { ok: true; data: T } | AdminFailure;

/** What an action that changes something answers: it worked, or why not. */
export type Outcome = { ok: true } | AdminFailure;

/** The answer to a call that was ignored because the same one is already running. Not a failure to tell the person about. */
export const BUSY: AdminFailure = { ok: false, status: 0, code: 'BUSY' };
export const isBusy = (outcome: Outcome): boolean => !outcome.ok && outcome.code === 'BUSY';

type Params = Record<string, string | number | undefined>;

const BASE = '/api/admin/';
const CODE = /^[A-Z][A-Z0-9_]*$/;

function urlOf(path: string, params?: Params): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return `${BASE}${path}${text ? `?${text}` : ''}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params | undefined, body: Record<string, unknown> | undefined): Promise<AdminResult<T>> {
  try {
    const init: RequestInit = { method, headers: initDataHeaders() };
    if (body) {
      init.headers = { 'Content-Type': 'application/json', ...initDataHeaders() };
      init.body = JSON.stringify({ ...body, initData: readInitData() });
    }
    const response = await fetch(urlOf(path, params), init);
    const answer: unknown = await response.json().catch(() => null);
    const json = isRecord(answer) ? answer : null;
    if (response.ok && json?.success === true) return { ok: true, data: json as T };
    const error = json?.error;
    console.error(`[admin] ${path} failed:`, { method, status: response.status, error: typeof error === 'string' ? error : json === null ? 'no JSON body' : 'success was not true' });
    return { ok: false, status: response.status, code: typeof error === 'string' && CODE.test(error) ? error : undefined };
  } catch (error) {
    console.error(`[admin] ${path} failed:`, { method, error });
    return { ok: false, status: 0 };
  }
}

export const adminGet = <T>(path: string, params?: Params) => request<T>('GET', path, params, undefined);
export const adminPost = <T>(path: string, body: Record<string, unknown>) => request<T>('POST', path, undefined, body);
export const adminDelete = <T>(path: string, params?: Params) => request<T>('DELETE', path, params, undefined);

/** A result as the outcome of an action that has no answer to read. */
export const outcomeOf = (result: AdminResult<unknown>): Outcome => (result.ok ? { ok: true } : result);
