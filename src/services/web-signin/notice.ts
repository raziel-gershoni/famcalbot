/**
 * The notice that a way into the account was added (web sign-in spec §2.10, web sign-up spec 2026-11-03 §2.11): a
 * Google or email way added in Settings, the calendar's Google account used for the first time (§2.17), the ways a
 * Join brought in, or Telegram connected to an account made on famcal.bot. So a stolen session can't add a way
 * quietly, it goes to the ways that were there BEFORE the change, never to the one just added:
 * - an account with a chat: the chat, Telegram when it has it, else WhatsApp (the phone, else the BSUID), as in 6b;
 * - an account with no chat (hasChat, src/lib/has-chat.ts), and every Telegram connect (the chat is the new way): by
 *   email to the account's email way, else to its Google way's address, never the way of the kind just added
 *   (sendNoticeEmail, with the notices' own budget: 3 a day per account, then 10 a day in all).
 * A Google or email notice names the way with the address masked (maskEmail) and says where to remove it; Telegram
 * can't be removed in Settings, so its notice says to write to privacy@famcal.bot.
 *
 * It is the answer to the person's own action, so the Shabbat pause doesn't hold it (CLAUDE.md; scripts/smoke-pause.ts
 * lists this file and email-send.ts as NOT_PAUSED). On WhatsApp a free-form text outside the person's 24-hour window is
 * accepted by Meta and rejected later (131047), which the webhook's status handler logs. A notice that can't go out
 * (no address to send to, the account's or the day's notices spent, the mail or the chat refused) is a security event: one
 * `[signin-notice] SECURITY:` line and a captured warning. It never throws: the way is made either way. No log line
 * holds an address.
 */

import enMessages from '../../../messages/en.json';
import heMessages from '../../../messages/he.json';
import ruMessages from '../../../messages/ru.json';
import { captureError } from '../../lib/error-capture';
import { hasChat } from '../../lib/has-chat';
import { SafeSignInError, safeErrorSummary } from './safe-error';
import { normalizeLocale, type Locale } from '../../utils/locale';
import { getWhatsAppChatId } from '../user-service';
import { getWhatsAppService } from '../messaging';
import type { UserConfig } from '../../types';
import { maskEmail } from './email-address';
import { sendNoticeEmail, type NoticeRefusal } from './email-send';
import { noticeAddress, type IdentityKind } from './identities';

export type SignInNoticeEvent =
  | {
      kind: IdentityKind;
      /** The way's address, as stored; the notice shows it masked */
      address: string;
      /** added: from Settings; calendar: the first sign-in with the calendar's Google account; joined: the way came with the account Join brought in */
      via: 'added' | 'calendar' | 'joined';
    }
  | { kind: 'telegram'; via: 'connected' };

type NoticeCopy = typeof enMessages.signinNotice;
const WORDS: Record<Locale, NoticeCopy> = {
  en: enMessages.signinNotice,
  he: heMessages.signinNotice,
  ru: ruMessages.signinNotice,
};

/** The notice's text in the person's language. */
function noticeText(copy: NoticeCopy, event: SignInNoticeEvent): string {
  if (event.kind === 'telegram') return copy.telegramConnected;
  const template = event.via === 'calendar' ? copy.calendarGoogle
    : event.via === 'joined' ? (event.kind === 'google' ? copy.joinedGoogle : copy.joinedEmail)
    : event.kind === 'google' ? copy.addedGoogle : copy.addedEmail;
  return template.replace('{address}', maskEmail(event.address));
}

/** Each refusal of the notices' budget, as the SECURITY line says it. */
const REFUSED: Record<NoticeRefusal, string> = {
  'notice-account-day': "the account's notices are spent",
  'notice-budget': "the day's notices are spent",
  'store-down': "the notices' count could not be read",
};

/** A notice that did not go out: the security line and a captured warning, with the user id and why only. */
function dropped(user: UserConfig, what: string, why: string): void {
  console.error(`[signin-notice] SECURITY: notice for user ${user.id} not sent (${why})`);
  captureError(new SafeSignInError(`signin-notice not sent: ${why}`), 'signin-notice', { user_id: user.id, purpose: what }, 'warning');
}

export async function sendSignInNotice(user: UserConfig, event: SignInNoticeEvent): Promise<void> {
  const what = `${event.kind} (${event.via})`;
  try {
    const copy = WORDS[normalizeLocale(user.language)];
    const text = noticeText(copy, event);

    // The chat, when it was there before: never for a Telegram connect, whose chat is the way just added
    if (event.kind !== 'telegram' && hasChat(user)) {
      if (user.telegramId) {
        // Loaded here, as google-connect.ts does: the bot module pulls in the whole Telegram client
        const { getMessagingService } = await import('../telegram/bot');
        await getMessagingService().sendMessage(user.telegramId, text);
        console.log(`[signin-notice] user ${user.id}: the ${what} notice was sent on Telegram`);
        return;
      }
      // hasChat without Telegram is WhatsApp: the phone, else the BSUID
      const chatId = getWhatsAppChatId(user);
      if (chatId) {
        await getWhatsAppService().sendMessage(chatId, text);
        console.log(`[signin-notice] user ${user.id}: the ${what} notice was sent on WhatsApp`);
        return;
      }
    }

    // No chat before: the account's email way, else its Google way's address, never the kind just added
    const to = await noticeAddress(user.id, event.kind === 'telegram' ? null : event.kind);
    if (!to) {
      dropped(user, what, 'no address to send it to');
      return;
    }
    const subject = event.kind === 'telegram' ? copy.emailSubjectTelegram : copy.emailSubject;
    const outcome = await sendNoticeEmail({ to: to.address, locale: user.language, subject, lines: [text, copy.emailWhy], userId: user.id });
    if (outcome !== 'sent') {
      dropped(user, what, REFUSED[outcome]);
      return;
    }
    console.log(`[signin-notice] user ${user.id}: the ${what} notice was emailed to the ${to.kind} way`);
  } catch (error) {
    dropped(user, what, safeErrorSummary(error));
  }
}
