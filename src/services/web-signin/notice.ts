/**
 * The notice in the person's chat when a sign-in way is added (web sign-in spec §2.10), or when the Google account
 * their calendar is connected from is used for the first time (§2.17): so a stolen session can't add a way quietly.
 * It names the way with the address masked (maskEmail) and says where to remove it.
 *
 * It is the answer to the person's own action on the web, so the Shabbat pause doesn't hold it (CLAUDE.md;
 * scripts/smoke-pause.ts lists this file as NOT_PAUSED). The chat: Telegram when the account has it, else WhatsApp
 * (the phone, else the BSUID). On WhatsApp a free-form text outside the person's 24-hour window is accepted by Meta and
 * rejected later (131047), which the webhook's status handler logs; a refusal here is logged and captured. It never
 * throws: the way is made either way. No log line holds the address.
 */

import enMessages from '../../../messages/en.json';
import heMessages from '../../../messages/he.json';
import ruMessages from '../../../messages/ru.json';
import { captureSignInFailure, safeErrorSummary } from './safe-error';
import { normalizeLocale, type Locale } from '../../utils/locale';
import { getWhatsAppChatId } from '../user-service';
import { getWhatsAppService } from '../messaging';
import type { UserConfig } from '../../types';
import { maskEmail } from './email-address';
import type { IdentityKind } from './identities';

export interface SignInNoticeEvent {
  kind: IdentityKind;
  /** The way's address, as stored; the notice shows it masked */
  address: string;
  /** added: from Settings; calendar: the first sign-in with the calendar's Google account */
  via: 'added' | 'calendar';
}

type NoticeCopy = typeof enMessages.signinNotice;
const WORDS: Record<Locale, NoticeCopy> = {
  en: enMessages.signinNotice,
  he: heMessages.signinNotice,
  ru: ruMessages.signinNotice,
};

export async function sendSignInNotice(user: UserConfig, event: SignInNoticeEvent): Promise<void> {
  const what = `${event.kind} (${event.via})`;
  try {
    const copy = WORDS[normalizeLocale(user.language)];
    const template = event.via === 'calendar' ? copy.calendarGoogle : event.kind === 'google' ? copy.addedGoogle : copy.addedEmail;
    const text = template.replace('{address}', maskEmail(event.address));

    if (user.telegramId) {
      // Loaded here, as google-connect.ts does: the bot module pulls in the whole Telegram client
      const { getMessagingService } = await import('../telegram/bot');
      await getMessagingService().sendMessage(user.telegramId, text);
      console.log(`[signin-notice] user ${user.id}: the ${what} notice was sent on Telegram`);
      return;
    }
    const chatId = getWhatsAppChatId(user);
    if (!chatId) {
      console.warn(`[signin-notice] user ${user.id}: no chat to send the ${what} notice to`);
      return;
    }
    await getWhatsAppService().sendMessage(chatId, text);
    console.log(`[signin-notice] user ${user.id}: the ${what} notice was sent on WhatsApp`);
  } catch (error) {
    console.error(`[signin-notice] user ${user.id}: the ${what} notice was not sent: ${safeErrorSummary(error)}`);
    captureSignInFailure(error, 'signin-notice', { user_id: user.id, purpose: what });
  }
}
