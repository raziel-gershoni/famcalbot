// The item sheet's "Send a copy" (docs/superpowers/specs/2026-11-27-send-event-copy-design.md, "Sending from the
// Mini App"). One POST to /api/calendar/copy makes the offer and prepares the card in Telegram; the card then goes out
// through Telegram's own chat picker (shareMessage, Bot API 8.0+), or, when that can't be used, through Telegram's
// share link. Client components only. Nothing here touches window at import.
//
// The init data goes in the header and the body, as the other Mini App POSTs send it (reminder-client). user_id is
// the page's own, never swapped; the route acts on the proved user only. No title, token or card text is logged.

import { INIT_DATA_HEADER, readInitData } from '../read-init-data';
import { openTelegramLink, shareTelegramMessage } from '../telegram-ui';

/** sent: the picker sent it. closed: the person left the picker (no error). link: the share link opened. failed: the sheet shows its error note. */
export type SendCopyOutcome = 'sent' | 'closed' | 'link' | 'failed';

interface PreparedCopy {
  preparedId: string | null;
  link: string;
  text: string;
}

function isPrepared(value: unknown): value is PreparedCopy {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (typeof v.preparedId === 'string' || v.preparedId === null) && typeof v.link === 'string' && typeof v.text === 'string';
}

async function prepareCopy(userId: number | string, key: string): Promise<PreparedCopy | null> {
  const initData = readInitData();
  try {
    const res = await fetch('/api/calendar/copy', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(initData ? { [INIT_DATA_HEADER]: initData } : {}) },
      body: JSON.stringify({ user_id: userId, key, ...(initData ? { initData } : {}) }),
    });
    if (res.status !== 200) {
      console.error(`[event-copy] the card could not be prepared: status ${res.status}`);
      return null;
    }
    const body: unknown = await res.json();
    if (!isPrepared(body)) {
      console.error('[event-copy] the card could not be prepared: an answer that is not a card');
      return null;
    }
    return body;
  } catch (err) {
    console.error('[event-copy] the card could not be prepared: no answer', err);
    return null;
  }
}

/** The card goes to Telegram's chat picker, or its share link. Never throws. */
export async function sendEventCopy(userId: number | string, key: string): Promise<SendCopyOutcome> {
  const prepared = await prepareCopy(userId, key);
  if (!prepared) return 'failed';
  if (prepared.preparedId) {
    const shared = await shareTelegramMessage(prepared.preparedId);
    if (shared !== 'unsupported') return shared;
    console.log('[event-copy] shareMessage is not available here; the share link opens instead');
  }
  const url = `https://t.me/share/url?url=${encodeURIComponent(prepared.link)}&text=${encodeURIComponent(prepared.text)}`;
  if (openTelegramLink(url)) return 'link';
  console.error('[event-copy] the share link could not be opened');
  return 'failed';
}
