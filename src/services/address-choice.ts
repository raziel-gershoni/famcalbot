/**
 * "Address me as", asked once when an account is made in a chat (spec docs/superpowers/specs/2026-11-07-b-features-design.md
 * §B2). The web's sign-up asks it on its form (src/services/web-signin/signup.ts); a chat account starts as male and gets
 * this question after its first reply:
 *   - Telegram: after the first reply to /start (the welcome, a deep link's reply, a partner's invite) or to a first
 *     "accept <token>", for an account that call made (getOrCreateUser's `created`); never on /start connect, whose new
 *     account merges into a WhatsApp one that was asked. Two buttons, gd:m and gd:f; a press saves the choice for the
 *     presser's own account (by the press's Telegram id) and turns the question into a one-line confirmation.
 *   - WhatsApp: the last message of the language step (whatsapp-onboarding.ts), two reply buttons gender_m and gender_f,
 *     read by the webhook whenever they come (the onboarding state is gone by then). Anything else goes on as normal.
 * Not answering leaves male; Settings' row changes it any time. Every choice is checked by isGender's closed set.
 * A reply to the person's own action, never a scheduled send: scripts/smoke-pause.ts lists this file as not paused.
 * One log line per saved choice, `[gender] user <id> chose via <telegram|whatsapp>`: never a name, a Telegram id or a phone.
 */

import type { Gender } from '../lib/gender';
import { getBotMessages } from '../lib/bot-messages';
import { captureError } from '../lib/error-capture';
import { getUserByTelegramId, updateUserById } from './user-service';

const CALLBACK: Record<Gender, string> = { male: 'gd:m', female: 'gd:f' };
const WA_BUTTON: Record<Gender, string> = { male: 'gender_m', female: 'gender_f' };

const why = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** The choice a Telegram button carries, or null for anything but gd:m and gd:f. */
export function genderOfCallback(data: string): Gender | null {
  if (data === CALLBACK.male) return 'male';
  if (data === CALLBACK.female) return 'female';
  return null;
}

/** The choice a WhatsApp reply button carries (its id arrives as the message text), or null for anything else. */
export function genderOfWhatsAppButton(text: string): Gender | null {
  const id = text.trim();
  if (id === WA_BUTTON.male) return 'male';
  if (id === WA_BUTTON.female) return 'female';
  return null;
}

/** Saves the choice through the user update and logs it (the user id and the platform only). */
export async function saveAddressChoice(userId: number, gender: Gender, via: 'telegram' | 'whatsapp'): Promise<void> {
  await updateUserById(userId, { gender });
  console.log(`[gender] user ${userId} chose via ${via}`);
}

/** The Telegram question with its two buttons. Never throws: the welcome went already, and a failure is logged and reported. */
export async function sendAddressQuestion(chatId: number | string, userId: number, locale: string): Promise<void> {
  try {
    const t = (await getBotMessages(locale)).onboarding;
    const { getMessagingService } = await import('./telegram/bot');
    await getMessagingService().sendMessage(chatId, t.addressQuestion, {
      replyMarkup: { inline_keyboard: [[{ text: t.addressMale, callback_data: CALLBACK.male }, { text: t.addressFemale, callback_data: CALLBACK.female }]] },
    });
  } catch (error) {
    console.error(`[gender] user ${userId}: the Telegram question could not be sent (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'telegram', step: 'ask' }, 'warning');
  }
}

/** A press of gd:m or gd:f: the spinner is answered first, then the presser's own account saves it and the question becomes the confirmation. */
export async function handleAddressPress(chatId: number, messageId: number | undefined, queryId: string, telegramId: number, data: string): Promise<void> {
  const { getBot } = await import('./telegram/bot');
  const bot = getBot();
  await bot.answerCallbackQuery({ callback_query_id: queryId }).catch((error: unknown) => console.error(`[gender] could not answer an address button (${why(error)})`));
  const gender = genderOfCallback(data);
  if (!gender) {
    console.warn('[gender] refused a button that is not gd:m or gd:f');
    return;
  }
  let userId: number | undefined;
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      console.warn('[gender] a button from a Telegram id with no account was refused');
      return;
    }
    userId = user.id;
    await saveAddressChoice(user.id, gender, 'telegram');
    const t = (await getBotMessages(user.language || 'en')).onboarding;
    if (messageId !== undefined) await bot.editMessageText({ text: gender === 'female' ? t.addressSavedFemale : t.addressSavedMale, chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.error(`[gender] user ${userId ?? 'unknown'}: saving the Telegram choice failed (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'telegram', step: 'save' });
  }
}

/** The WhatsApp question with its two reply buttons, the last message of onboarding. Never throws (logged and reported). */
export async function sendAddressQuestionWhatsApp(to: string, userId: number, locale: string): Promise<void> {
  try {
    const t = (await getBotMessages(locale)).onboarding;
    const { getWhatsAppService } = await import('./messaging');
    await getWhatsAppService().sendMessage(to, t.addressQuestion, {
      whatsappButtons: [{ id: WA_BUTTON.male, title: t.addressMale }, { id: WA_BUTTON.female, title: t.addressFemale }],
    });
  } catch (error) {
    console.error(`[gender] user ${userId}: the WhatsApp question could not be sent (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'whatsapp', step: 'ask' }, 'warning');
  }
}

/** A tap of gender_m or gender_f on WhatsApp: saved, then confirmed in one line. Never throws (logged and reported). */
export async function answerAddressWhatsApp(to: string, userId: number, gender: Gender, locale: string): Promise<void> {
  try {
    await saveAddressChoice(userId, gender, 'whatsapp');
    const t = (await getBotMessages(locale)).onboarding;
    const { getWhatsAppService } = await import('./messaging');
    await getWhatsAppService().sendMessage(to, gender === 'female' ? t.addressSavedFemale : t.addressSavedMale);
  } catch (error) {
    console.error(`[gender] user ${userId}: saving the WhatsApp choice failed (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'whatsapp', step: 'save' });
  }
}
