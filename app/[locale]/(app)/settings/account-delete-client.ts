// The Settings page's side of POST /api/account/delete (spec 2026-11-07-b-features §B3): delete the account. The initData
// goes in the header (initDataHeaders), never in the URL. Every answer comes back as a result the sheet words
// (settings.accountDelete.*), and a failure is logged with the status only.

import { initDataHeaders } from '@/src/lib/read-init-data';

export type AccountDeleteError = 'failed' | 'busy' | 'stale' | 'staleLink';
export type AccountDeleteResult =
  | { kind: 'deleted' }
  /** 404: the account is gone already (another tab or device deleted it); the server cleared the cookie. */
  | { kind: 'gone' }
  /** A browser's sign-in is over an hour old; `whatsapp`: a WhatsApp link's session, which asks for a new link. */
  | { kind: 'stale'; whatsapp: boolean }
  | { kind: 'error'; code: 'failed' | 'busy' };

const TAG = '[account-delete]';

export async function requestAccountDelete(userId: number): Promise<AccountDeleteResult> {
  try {
    const res = await fetch(`/api/account/delete?user_id=${userId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...initDataHeaders() },
      body: JSON.stringify({ confirm: true }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: unknown; error?: unknown; whatsapp?: unknown };
    if (res.ok && body.ok === true) return { kind: 'deleted' };
    if (res.status === 404) return { kind: 'gone' };
    if (res.status === 403 && body.error === 'stale-sign-in') return { kind: 'stale', whatsapp: body.whatsapp === true };
    console.warn(`${TAG} the request answered ${res.status}`);
    return { kind: 'error', code: res.status === 429 ? 'busy' : 'failed' };
  } catch (error) {
    console.error(`${TAG} the request failed: ${error instanceof Error ? error.name : typeof error}`);
    return { kind: 'error', code: 'failed' };
  }
}
