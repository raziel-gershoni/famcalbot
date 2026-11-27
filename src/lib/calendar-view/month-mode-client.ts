// Saves the Month's months (Gregorian or Hebrew) on the account: one POST to /api/settings, which validates the value.
// Client components only. Nothing here touches window at import.
//
// The init data goes in the header and the body, as the other Mini App POSTs send it (copy-client). user_id is the
// page's own, never swapped. A failure logs its status or error kind only: no user id, no body.

import { INIT_DATA_HEADER, readInitData } from '../read-init-data';
import type { MonthMode } from './month-mode';

/** True when the account holds the mode now. Never throws. */
export async function saveMonthMode(userId: number | string, mode: MonthMode): Promise<boolean> {
  const initData = readInitData();
  try {
    const res = await fetch(`/api/settings?user_id=${encodeURIComponent(String(userId))}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(initData ? { [INIT_DATA_HEADER]: initData } : {}) },
      body: JSON.stringify({ user_id: userId, monthMode: mode, ...(initData ? { initData } : {}) }),
    });
    if (res.status !== 200) {
      console.error(`[month mode] save failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[month mode] save failed: ${err instanceof Error ? err.name : 'unknown error'}`);
    return false;
  }
}
