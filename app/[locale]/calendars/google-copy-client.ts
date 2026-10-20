// The calendars page's side of /api/google-sync (google-sync spec §1, §3): load the copy
// rows, turn a copy on (or start Google's consent), turn it off with Remove or Keep, and make
// a copy again. The initData goes in the header (initDataHeaders), never in the URL.
// Every failure comes back as an error code the row words (messages googleCopy.errors.*),
// and is logged with ids only.

import { initDataHeaders } from '@/src/lib/read-init-data';
import type { CopiesView, CopyStatus } from '@/src/services/google-sync/view';
import type { UnlinkChoice } from '@/src/services/google-sync/marks';

export type CopyErrorCode = 'failed' | 'upgrade' | 'notFound' | 'openFailed';
export type CopyResult = { kind: 'ok' } | { kind: 'error'; code: CopyErrorCode };
export type StartResult = { kind: 'on' } | { kind: 'consent'; oauthUrl: string } | CopyResult;

/** Google's consent page is the only place a consent URL may lead. */
const GOOGLE_CONSENT = 'https://accounts.google.com/';

const api = (userId: number) => `/api/google-sync?user_id=${userId}`;

function errorCode(status: number, body: { error?: unknown }): CopyErrorCode {
  if (status === 403 && body.error === 'upgrade_required') return 'upgrade';
  if (status === 404) return 'notFound';
  return 'failed';
}

async function send(userId: number, method: 'POST' | 'DELETE', payload: Record<string, unknown>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; code: CopyErrorCode }> {
  try {
    const res = await fetch(api(userId), {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...initDataHeaders() },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[google-copy] ${method} ${String(payload.action ?? 'off')} answered ${res.status}`);
      return { ok: false, code: errorCode(res.status, body) };
    }
    return { ok: true, body };
  } catch (error) {
    console.error(`[google-copy] ${method} ${String(payload.action ?? 'off')} failed:`, error);
    return { ok: false, code: 'failed' };
  }
}

/** The page's copy rows. Throws when the server can't answer (the page shows googleCopy.errors.load). */
export async function loadCopies(userId: number): Promise<CopiesView> {
  const res = await fetch(api(userId), { credentials: 'same-origin', headers: initDataHeaders() });
  if (!res.ok) throw new Error(`google-sync GET answered ${res.status}`);
  return res.json();
}

/** Turn a copy on: on at once when the permission is held, else Google's consent URL to open. */
export async function startCopy(userId: number, calendarId: string): Promise<StartResult> {
  const r = await send(userId, 'POST', { action: 'enable', nativeCalendarId: calendarId });
  if (!r.ok) return { kind: 'error', code: r.code };
  if (r.body.status === 'consent') {
    const url = r.body.oauthUrl;
    if (typeof url === 'string' && url.startsWith(GOOGLE_CONSENT)) return { kind: 'consent', oauthUrl: url };
    console.warn('[google-copy] the consent answer had no Google URL');
    return { kind: 'error', code: 'failed' };
  }
  return { kind: 'on' };
}

/** Turn a copy off, with what happens to its Google calendar. */
export async function stopCopy(userId: number, calendarId: string, choice: UnlinkChoice): Promise<CopyResult> {
  const r = await send(userId, 'DELETE', { nativeCalendarId: calendarId, googleCopy: choice });
  return r.ok ? { kind: 'ok' } : { kind: 'error', code: r.code };
}

/** "Create it again" / "Copy again from scratch?". */
export async function recreateCopy(userId: number, linkId: string): Promise<CopyResult> {
  const r = await send(userId, 'POST', { action: 'recreate', linkId });
  return r.ok ? { kind: 'ok' } : { kind: 'error', code: r.code };
}

/** What a row's one action button does: start the consent, reconnect Google, or make the copy again. */
export function copyAction(status: CopyStatus): 'consent' | 'reconnect' | 'recreate' | null {
  switch (status) {
    case 'approve': return 'consent';
    case 'reconnect': return 'reconnect';
    case 'gone':
    case 'otherAccount': return 'recreate';
    default: return null;
  }
}

/** The calendar DELETE's body: the Google copy's fate only when the user was asked (spec §2). */
export function deleteCalendarBody(choice: UnlinkChoice | null, initData: string): Record<string, unknown> {
  return choice ? { initData, googleCopy: choice } : { initData };
}

/** Whether the page keeps asking: a copy is being made, or a consent waits for the user's tap. */
export function needsPolling(rows: ReadonlyArray<{ status: CopyStatus }>, waiting: number): boolean {
  return waiting > 0 || rows.some((r) => r.status === 'copying');
}
