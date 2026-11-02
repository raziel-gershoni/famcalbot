/**
 * Send to chat from the calendar home (spec §7.2, Ruling R5): POST /api/execute-command,
 * and the bot posts the answer in the user's chat.
 *
 * - The call is a Telegram one only when readInitData() is non-empty: the SDK defines
 *   Telegram.WebApp in any browser. The initData goes in the X-Telegram-Init-Data header,
 *   and in the JSON body as the fallback the route also reads.
 * - Inside Telegram the app closes only on a 2xx. Any other answer, or none, keeps it
 *   open, and the caller says why (429: try again in a minute).
 * - In a browser (a session cookie, however the person signed in) the page always stays. A
 *   2xx there names the chat the answer went to in its `platform` field (a WhatsApp-link
 *   session answers on WhatsApp, a Telegram, Google or email one on Telegram).
 * - 400 `wa_link_needed`: a WhatsApp-only account signed in another way; WhatsApp refuses
 *   free replies after 24 hours, so the sheet says to open FamCal from WhatsApp.
 *
 * Imports only read-init-data and read-json (the shared reader of an answer's JSON body), so it stays a small client
 * module.
 */

import { INIT_DATA_HEADER, readInitData } from './read-init-data';
import { readJsonBody } from './read-json';

const TAG = '[command-client]';

/** The send sheet's items, in its order. */
export const SEND_ITEMS = ['today', 'tomorrow', 'thisWeek', 'nextWeek', 'weather'] as const;
export type SendItem = (typeof SEND_ITEMS)[number];

export type SendCommand = { command: 'summary' | 'lookahead' | 'nextweek' | 'weather'; args?: 'tmrw' };

/** What /api/execute-command runs for each of the Send sheet's five items. */
export const SEND_COMMANDS: Record<SendItem, SendCommand> = {
  today: { command: 'summary' },
  tomorrow: { command: 'summary', args: 'tmrw' },
  thisWeek: { command: 'lookahead' },
  nextWeek: { command: 'nextweek' },
  weather: { command: 'weather' },
};

/**
 * - closing: Telegram answered 2xx and the app was asked to close. Keep the spinner.
 * - sent: a 2xx and the page stays. `chat` is where the answer went, as the route says in
 *   `platform`; Telegram when the SDK couldn't close the app (blocked script, a throw);
 *   'unknown' when a 2xx names no chat (the sheet then says only "Sent").
 * - busy: 429, try again in a minute.
 * - failed: any other status, or null when no answer came (offline, blocked request).
 *   `reason` is set for the one 400 the person can fix.
 */
export type SendResult =
  | { outcome: 'closing' }
  | { outcome: 'sent'; chat: 'whatsapp' | 'telegram' | 'unknown' }
  | { outcome: 'busy' }
  | { outcome: 'failed'; status: number | null; reason?: 'wa_link_needed' };

/**
 * Asks the bot to post `item` in the user's chat. `userId` is the page's own user_id as
 * page-data hands it to the dashboard (a telegramId or a DB id; the route accepts either
 * for the proved user). `locale` rides along as the old call sent it.
 */
export async function sendToChat(userId: number, item: SendItem, locale: string): Promise<SendResult> {
  const initData = readInitData();
  const { command, args } = SEND_COMMANDS[item];

  let res: Response;
  try {
    res = await fetch('/api/execute-command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(initData ? { [INIT_DATA_HEADER]: initData } : {}) },
      body: JSON.stringify({ user_id: userId, command, args, language: locale, ...(initData ? { initData } : {}) }),
    });
  } catch (err) {
    console.error('[command-client] The send got no answer:', err);
    return { outcome: 'failed', status: null };
  }

  const status = res.status;
  if (status === 429) return { outcome: 'busy' };
  if (status < 200 || status > 299) {
    if (status === 400 && (await readJsonBody(res, TAG))?.error === 'wa_link_needed') {
      return { outcome: 'failed', status, reason: 'wa_link_needed' };
    }
    return { outcome: 'failed', status };
  }
  if (!initData) {
    const platform = (await readJsonBody(res, TAG))?.platform;
    if (platform === 'whatsapp' || platform === 'telegram') return { outcome: 'sent', chat: platform };
    console.error('[command-client] The answer named no chat:', platform);
    return { outcome: 'sent', chat: 'unknown' };
  }

  try {
    const tg = window.Telegram?.WebApp;
    if (tg && typeof tg.close === 'function') {
      tg.close();
      return { outcome: 'closing' };
    }
  } catch (err) {
    console.error('[command-client] Could not close the Mini App:', err);
  }
  return { outcome: 'sent', chat: 'telegram' };
}
