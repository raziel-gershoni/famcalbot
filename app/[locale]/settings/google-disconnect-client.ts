// The Settings page's side of POST /api/google-disconnect: disconnect Google, with or without
// deleting FamCal's copy calendars there. The initData goes in the header (initDataHeaders),
// never in the URL. Every failure comes back as a code the dialog words
// (messages settings.googleDisconnect.error*), and is logged with the status only.

import { initDataHeaders } from '@/src/lib/read-init-data';

export type DisconnectErrorCode = 'failed' | 'busy';
export type DisconnectResult = { kind: 'ok'; leftover: string[] } | { kind: 'error'; code: DisconnectErrorCode };

export async function requestDisconnect(userId: number, deleteCopies: boolean): Promise<DisconnectResult> {
  try {
    const res = await fetch(`/api/google-disconnect?user_id=${userId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...initDataHeaders() },
      body: JSON.stringify({ deleteCopies }),
    });
    const body = await res.json().catch(() => ({})) as { status?: unknown; leftover?: unknown };
    if (!res.ok || body.status !== 'disconnected') {
      console.warn(`[google-disconnect] the request answered ${res.status}`);
      return { kind: 'error', code: res.status === 429 ? 'busy' : 'failed' };
    }
    return { kind: 'ok', leftover: Array.isArray(body.leftover) ? body.leftover.filter((n): n is string => typeof n === 'string') : [] };
  } catch (error) {
    console.error('[google-disconnect] the request failed:', error);
    return { kind: 'error', code: 'failed' };
  }
}
