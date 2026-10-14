// The Telegram message a native reminder pings with, and the edit that retires its
// buttons (spec §4.4).
//
// Each button's callback data is `nr:<op>:<stateId>`, where stateId is the occurrence's
// state row (a 36-character UUID, so `nr:s15:<id>` is 43 bytes of Telegram's 64). The
// row lives as long as the occurrence keeps its time, so an old ping's buttons still work.

import TelegramBot from 'node-telegram-bot-api';
import { getBot } from '../telegram';
import { getBotMessage, getBotMessages } from '../../lib/bot-messages';
import { escapeHtml } from '../../utils/html';

/** `⏰ <b>title</b>`, and a "from: <creator>" line when someone else set it. */
export async function buildPingText(a: { title: string; creatorName?: string; language: string }): Promise<string> {
  const head = `⏰ <b>${escapeHtml(a.title)}</b>`;
  if (!a.creatorName) return head;
  const from = await getBotMessage(a.language, 'nativeReminders.ping.from', { name: escapeHtml(a.creatorName) });
  return `${head}\n${from}`;
}

/** ✅ Done on its own row, the three snoozes under it. */
export async function buildPingKeyboard(stateId: string, language: string): Promise<TelegramBot.InlineKeyboardMarkup> {
  const buttons = (await getBotMessages(language)).nativeReminders.buttons;
  return {
    inline_keyboard: [
      [{ text: buttons.done, callback_data: `nr:d:${stateId}` }],
      [
        { text: buttons.snooze15, callback_data: `nr:s15:${stateId}` },
        { text: buttons.snooze60, callback_data: `nr:s60:${stateId}` },
        { text: buttons.snoozeTomorrow, callback_data: `nr:st:${stateId}` },
      ],
    ],
  };
}

/** Send a ping. Resolves to its message id, which the state row keeps for later edits. */
export async function sendPing(chatId: bigint, text: string, keyboard: TelegramBot.InlineKeyboardMarkup): Promise<number> {
  const message = await getBot().sendMessage(chatId.toString(), text, { parse_mode: 'HTML', reply_markup: keyboard });
  return message.message_id;
}

/**
 * Edit a ping to `text`, which is HTML, with no buttons. A ping that already reads so,
 * or that the user deleted, needs nothing; any other failure is the caller's.
 */
export async function stripPingButtons(chatId: bigint | number, messageId: number, text: string): Promise<void> {
  try {
    await getBot().editMessageText(text, { chat_id: chatId.toString(), message_id: messageId, parse_mode: 'HTML' });
  } catch (error) {
    const message = (error as { message?: string })?.message ?? '';
    if (message.includes('message is not modified') || message.includes('message to edit not found')) return;
    throw error;
  }
}
