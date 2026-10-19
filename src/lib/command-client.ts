/**
 * Send to chat from the calendar home (spec §7.2, Ruling R5): POST /api/execute-command,
 * and the bot posts the answer in the user's chat.
 *
 * - The call is a Telegram one only when readInitData() is non-empty: the SDK defines
 *   Telegram.WebApp in any browser. The initData goes in the X-Telegram-Init-Data header,
 *   and in the JSON body as the fallback the route also reads.
 * - Inside Telegram the app closes only on a 2xx. Any other answer, or none, keeps it
 *   open, and the caller says why (429: try again in a minute).
 * - In a browser (the WhatsApp magic-link session cookie) the page always stays. A 2xx
 *   there means the answer went to WhatsApp, where every magic link comes from.
 *
 * No imports beyond read-init-data, so it stays a small client module.
 */

import { INIT_DATA_HEADER, readInitData } from './read-init-data';

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
 * - sent: a 2xx and the page stays. `chat` is where the answer went: WhatsApp in a
 *   browser; Telegram when the SDK couldn't close the app (blocked script, a throw).
 * - busy: 429, try again in a minute.
 * - failed: any other status, or null when no answer came (offline, blocked request).
 */
export type SendResult =
  | { outcome: 'closing' }
  | { outcome: 'sent'; chat: 'whatsapp' | 'telegram' }
  | { outcome: 'busy' }
  | { outcome: 'failed'; status: number | null };

/**
 * Asks the bot to post `item` in the user's chat. `userId` is the page's own user_id as
 * page-data hands it to the dashboard (a telegramId or a DB id; the route accepts either
 * for the proved user). `locale` rides along as the old call sent it.
 */
export async function sendToChat(userId: number, item: SendItem, locale: string): Promise<SendResult> {
  const initData = readInitData();
  const { command, args } = SEND_COMMANDS[item];

  let status: number;
  try {
    const res = await fetch('/api/execute-command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(initData ? { [INIT_DATA_HEADER]: initData } : {}) },
      body: JSON.stringify({ user_id: userId, command, args, language: locale, ...(initData ? { initData } : {}) }),
    });
    status = res.status;
  } catch (err) {
    console.error('[command-client] The send got no answer:', err);
    return { outcome: 'failed', status: null };
  }

  if (status === 429) return { outcome: 'busy' };
  if (status < 200 || status > 299) return { outcome: 'failed', status };
  if (!initData) return { outcome: 'sent', chat: 'whatsapp' };

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
