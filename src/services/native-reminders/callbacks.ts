// ✅ Done and 💤 Snooze on a native reminder ping (spec §5). The rules (who may, what
// still applies, the writes) are actions.ts's; this file is the Telegram side: parsing the
// tap, the toast and the edit of the tapped message.
//
// The buttons never expire. A tap can come days later, after the reminder was
// moved, deleted or marked done, or after the pair unlinked, so every tap reads
// the state row and its series afresh and checks who is tapping. Every tap is
// answered exactly once, and nothing here throws: an error would fail the
// webhook with a 500, and Telegram would deliver the same tap again and again.

import type TelegramBot from 'node-telegram-bot-api';
import { prisma } from '../../utils/prisma';
import { getBot } from '../telegram/bot';
import { getUserByTelegramId } from '../user-service';
import { getBotMessage } from '../../lib/bot-messages';
import { captureError } from '../../lib/error-capture';
import { escapeHtml } from '../../utils/html';
import { stripPingButtons } from './ping';
import { applyReminderAction, loadLiveOccurrence, snoozeLabel, type ReminderAction } from './actions';

type NativeReminderOp = 'd' | 's15' | 's60' | 'st';

// nr:<op>:<state row id>, as ping.ts builds it; the webhook routes on the same `nr:`.
// Telegram caps callback data at 64 bytes, and `nr:s15:` leaves 57.
const CALLBACK_DATA = /^nr:(d|s15|s60|st):([A-Za-z0-9_-]{1,57})$/;

export function parseNativeReminderCallback(data: string): { op: NativeReminderOp; stateId: string } | null {
  const match = CALLBACK_DATA.exec(data);
  return match ? { op: match[1] as NativeReminderOp, stateId: match[2] } : null;
}

/**
 * Handle a tap on a ping's button. `now` is for smoke scripts. The toast carries
 * the outcome, so the callback is answered once the outcome is known, in a finally:
 * exactly once, whatever happens in between.
 */
export async function handleNativeReminderCallback(
  query: TelegramBot.CallbackQuery,
  now: Date = new Date()
): Promise<void> {
  let toast: string | undefined;
  try {
    toast = await handleTap(query, now);
  } catch (error) {
    captureError(error, 'native-reminder-callback', { user_id: query.from.id, callback_data: query.data });
  } finally {
    await answer(query.id, toast);
  }
}

type Say = (key: string, params?: Record<string, string>) => Promise<string>;
type PingMessage = { chatId: number; messageId: number };

const ACTION_OF: Record<NativeReminderOp, ReminderAction> = {
  d: 'done', s15: 'snooze15', s60: 'snooze60', st: 'snoozeTomorrow',
};

/** What a tap does. Returns the toast, or undefined when the edited ping says it all. */
async function handleTap(query: TelegramBot.CallbackQuery, now: Date): Promise<string | undefined> {
  const parsed = parseNativeReminderCallback(query.data ?? '');
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!parsed || chatId === undefined || messageId === undefined) return undefined;
  const ping: PingMessage = { chatId, messageId };

  const tapper = await getUserByTelegramId(query.from.id);
  const language = tapper?.language || 'en';
  const say: Say = (key, params) => getBotMessage(language, `nativeReminders.${key}`, params);

  // A button names a state row; the shared rules work on the occurrence's key.
  const state = await prisma.nativeReminderState.findUnique({
    where: { id: parsed.stateId },
    select: { seriesEventId: true, originalStartsAt: true },
  });
  if (!state) {
    await removeButtons(ping);
    return say('changed');
  }
  if (!tapper) {
    if (!(await loadLiveOccurrence(state))) {
      await removeButtons(ping);
      return say('changed');
    }
    return say('notYours');
  }

  const op = parsed.op;
  const result = await applyReminderAction(tapper, state, ACTION_OF[op], now, 'ping');
  switch (result.status) {
    case 'changed':
      await removeButtons(ping);
      return say('changed');
    case 'not_yours':
      // It was theirs when it pinged them; since then it is the creator's again.
      if (result.wasTarget) {
        await removeButtons(ping);
        return say('changed');
      }
      return say('notYours');
    case 'already_done':
      await editPing(ping, await say('done', { title: escapeHtml(result.title) }));
      return say('alreadyDone');
    case 'not_done':
      return undefined; // a ping button never undoes
    case 'ok':
      if (op === 'd') {
        await editPing(ping, await say('done', { title: escapeHtml(result.title) }));
      } else if (result.until && result.timeZone) {
        const time = snoozeLabel(result.until, ACTION_OF[op] as 'snooze15', language, result.timeZone);
        await editPing(ping, await say('snoozedUntil', { title: escapeHtml(result.title), time }));
      }
      return undefined;
  }
}

/** Show the outcome on the ping and drop its buttons. A failed edit must not cost the answer. */
async function editPing(ping: PingMessage, text: string): Promise<void> {
  try {
    await stripPingButtons(ping.chatId, ping.messageId, text);
  } catch (error) {
    captureError(error, 'native-reminder-callback-edit', { chat_id: ping.chatId }, 'warning');
  }
}

/** Drop a stale ping's buttons and leave its text as it was. */
async function removeButtons(ping: PingMessage): Promise<void> {
  try {
    await getBot().editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ping.chatId, message_id: ping.messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('message is not modified') || message.includes('message to edit not found')) return;
    captureError(error, 'native-reminder-callback-edit', { chat_id: ping.chatId }, 'warning');
  }
}

/** Answer the tap. It fails harmlessly when the tap waited too long ("query is too old"). */
async function answer(queryId: string, text?: string): Promise<void> {
  try {
    await getBot().answerCallbackQuery(queryId, text ? { text } : undefined);
  } catch (error) {
    console.warn('[NativeReminders] Could not answer a button tap:', error instanceof Error ? error.message : error);
  }
}
