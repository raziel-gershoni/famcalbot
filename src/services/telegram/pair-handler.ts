// Shared pair-acceptance flow used by both:
//   - Telegram /start invite_<packed token> (deep link; src/lib/invite-link.ts packs the token to fit)
//   - Free-text "accept <token>" on Telegram and WhatsApp
//
// All routing converges here so the validation, error mapping, and inviter
// notification live in one place. The HTTP route at /api/pair/accept uses
// the same underlying pairing-service.acceptInvite — this file is the
// chat-side adapter.

import { acceptInvite, PairingError, type PairingErrorCode } from '../pairing-service';
import { prisma } from '../../utils/prisma';
import { getMessagingService as getMessagingServiceByPlatform, MessagingPlatform, MessageFormat, type IMessagingService } from '../messaging';
import { buildWhatsAppTemplate } from '../messaging/whatsapp-template';
import { getMessagingService } from './bot';
import { normalizeLocale, type Locale } from '../../utils/locale';
import { captureError } from '../../lib/error-capture';
import { escapeHtml } from '../../utils/html';
import { inviteTokenFromStart } from '../../lib/invite-link';
import { deliveryPlatformFor } from '../../lib/delivery-platform';

/** The factory needs the bot instance for Telegram; ./bot supplies it. */
function messagingFor(platform: MessagingPlatform): IMessagingService {
  return platform === MessagingPlatform.TELEGRAM ? getMessagingService() : getMessagingServiceByPlatform(platform);
}

type PairCopy = {
  errors: Record<Exclude<PairingErrorCode, 'NOT_PAIRED'>, string>;
  /** To the acceptor. The inviter's name comes in HTML-escaped, '' when there is none. */
  accepted: (inviterName: string) => string;
  /** To a Telegram inviter (a WhatsApp one gets the template). The acceptor's name comes in HTML-escaped, '' when there is none. */
  acceptedNotification: (acceptorName: string) => string;
};

/**
 * Chat pairing text per language. Errors are intentionally specific so users can
 * self-correct (expired vs already paired vs invalid token).
 */
const PAIR_COPY: Record<Locale, PairCopy> = {
  en: {
    errors: {
      INVITE_NOT_FOUND: '❌ Invite link is invalid.',
      INVITE_EXPIRED: '⌛ This invite link has expired. Ask for a new one.',
      INVITE_ALREADY_USED: '⚠️ This invite has already been used.',
      INVITE_REVOKED: '⚠️ This invite was revoked.',
      CANNOT_ACCEPT_OWN_INVITE: '🪞 You cannot accept your own invite.',
      INVITER_ALREADY_PAIRED: '⚠️ The inviter is already paired with someone else.',
      INVITEE_ALREADY_PAIRED: '⚠️ You are already paired with someone. Unlink first to switch.',
      ALREADY_PAIRED_TOGETHER: '🎉 You two are already paired!',
      UNKNOWN_ERROR: '❌ Could not accept the invite.',
    },
    accepted: name => (name ? `🎉 You are now paired with ${name}!` : '🎉 You are now paired!'),
    acceptedNotification: name =>
      name ? `🎉 ${name} accepted your invite. You are now paired.` : '🎉 Your invite was accepted. You are now paired.',
  },
  he: {
    errors: {
      INVITE_NOT_FOUND: '❌ קישור ההזמנה לא תקין.',
      INVITE_EXPIRED: '⌛ תוקף ההזמנה פג. בקשו קישור חדש.',
      INVITE_ALREADY_USED: '⚠️ כבר השתמשו בהזמנה הזו.',
      INVITE_REVOKED: '⚠️ ההזמנה הזו בוטלה.',
      CANNOT_ACCEPT_OWN_INVITE: '🪞 זו ההזמנה שלכם, אי אפשר לאשר אותה בעצמכם.',
      INVITER_ALREADY_PAIRED: '⚠️ הצד השני כבר מחובר למישהו אחר.',
      INVITEE_ALREADY_PAIRED: '⚠️ אתם כבר מחוברים למישהו. כדי להחליף, בטלו קודם את החיבור הנוכחי.',
      ALREADY_PAIRED_TOGETHER: '🎉 שניכם כבר מחוברים!',
      UNKNOWN_ERROR: '❌ לא הצלחנו לאשר את ההזמנה.',
    },
    accepted: name => (name ? `🎉 מעולה, אתם מחוברים עכשיו עם ${name}!` : '🎉 מעולה, אתם מחוברים עכשיו!'),
    acceptedNotification: name =>
      name ? `🎉 ההזמנה שלכם התקבלה! אתם מחוברים עכשיו עם ${name}.` : '🎉 ההזמנה שלכם התקבלה! אתם מחוברים עכשיו.',
  },
  ru: {
    errors: {
      INVITE_NOT_FOUND: '❌ Ссылка-приглашение недействительна.',
      INVITE_EXPIRED: '⌛ Срок действия приглашения истёк. Попросите прислать новое.',
      INVITE_ALREADY_USED: '⚠️ Этим приглашением уже воспользовались.',
      INVITE_REVOKED: '⚠️ Это приглашение отменили.',
      CANNOT_ACCEPT_OWN_INVITE: '🪞 Это ваше же приглашение, принять его не получится.',
      INVITER_ALREADY_PAIRED: '⚠️ Аккаунт отправителя уже связан с другим человеком.',
      INVITEE_ALREADY_PAIRED: '⚠️ Ваш аккаунт уже связан с кем-то. Чтобы связать его с другим человеком, сначала отмените текущую привязку.',
      ALREADY_PAIRED_TOGETHER: '🎉 Вы уже связаны друг с другом!',
      UNKNOWN_ERROR: '❌ Не получилось принять приглашение.',
    },
    accepted: name => (name ? `🎉 Готово! Вы и ${name} теперь связаны.` : '🎉 Готово! Теперь вы связаны.'),
    acceptedNotification: name =>
      name ? `🎉 Ваше приглашение приняли! Теперь вы и ${name} связаны.` : '🎉 Ваше приглашение приняли! Теперь вы связаны.',
  },
};

/** The recipient's copy: their User.language, English when it is unset or unknown. */
const pairCopy = (language: string | null | undefined): PairCopy => PAIR_COPY[normalizeLocale(language)];

/** Map a PairingError code to a user-facing message in the recipient's language. */
function pairingErrorMessage(code: PairingErrorCode, locale: string): string {
  const { errors } = pairCopy(locale);
  // NOT_PAIRED comes only from unlink, never from an accept.
  return code === 'NOT_PAIRED' ? errors.UNKNOWN_ERROR : errors[code];
}

/**
 * Notify the inviter that their invite was accepted. Best-effort — failures
 * are logged but never block the success message to the acceptor. Used by
 * the chat accept below and by POST /api/pair/accept. Written in the inviter's
 * language; an empty acceptorName gets a message without a name.
 *
 * A WhatsApp inviter gets the famcal_notify template instead: free-form text
 * outside their 24h window is rejected (131047), and only later, by a status
 * callback. Its button sends "settings", answered with the dashboard link,
 * where the pairing shows.
 */
export async function notifyInviterOfAccept(inviterUserId: number, acceptorName: string): Promise<void> {
  try {
    const inviter = await prisma.user.findUnique({
      where: { id: inviterUserId },
      select: { telegramId: true, whatsappPhone: true, whatsappBsuid: true, language: true, messagingPlatform: true },
    });
    if (!inviter) return;
    // WhatsApp when that is where they are: the saved choice narrowed to the channels they have (an inviter saved as
    // "telegram" who never linked Telegram, but has WhatsApp, is told there)
    const platform =
      deliveryPlatformFor(inviter) === 'whatsapp'
        ? MessagingPlatform.WHATSAPP
        : MessagingPlatform.TELEGRAM;
    const service = messagingFor(platform);
    const inviterChatId =
      platform === MessagingPlatform.TELEGRAM
        ? Number(inviter.telegramId)
        : inviter.whatsappPhone ?? inviter.whatsappBsuid ?? '';
    if (!inviterChatId) return;
    if (platform === MessagingPlatform.WHATSAPP) {
      const whatsappTemplate = buildWhatsAppTemplate(normalizeLocale(inviter.language), 'settings');
      await service.sendMessage(inviterChatId, '', { whatsappTemplate });
      return;
    }
    const message = pairCopy(inviter.language).acceptedNotification(escapeHtml(acceptorName));
    await service.sendMessage(inviterChatId, message, { format: MessageFormat.HTML });
  } catch (err) {
    captureError(err, 'pair-notify-inviter', undefined, 'warning');
  }
}

/** /start invite_<payload>, from the invite page's Telegram link: the payload is the token packed to fit Telegram's start parameter. */
export async function handlePairStart(
  chatId: number | string,
  acceptingUserId: number,
  payload: string,
  locale: string,
  platform: MessagingPlatform
): Promise<void> {
  await handlePairAccept(chatId, acceptingUserId, inviteTokenFromStart(payload), locale, platform);
}

/**
 * Handle invite acceptance by an authenticated user (either via /start deep
 * link or via free-text accept command). chatId is the conversation's chat
 * id on the platform. acceptingUserId is the DB User.id (already resolved
 * by the caller). locale is the acceptor's User.language.
 */
export async function handlePairAccept(
  chatId: number | string,
  acceptingUserId: number,
  token: string,
  locale: string,
  platform: MessagingPlatform
): Promise<void> {
  const service = messagingFor(platform);

  if (!token || token.length < 8) {
    await service.sendMessage(chatId, pairingErrorMessage('INVITE_NOT_FOUND', locale), { format: MessageFormat.HTML });
    return;
  }

  try {
    const result = await acceptInvite(token, acceptingUserId);

    // Pull names for both sides — the success messages are personalized.
    const [inviter, acceptor] = await Promise.all([
      prisma.user.findUnique({ where: { id: result.inviterUserId }, select: { name: true, englishName: true } }),
      prisma.user.findUnique({ where: { id: result.inviteeUserId }, select: { name: true, englishName: true } }),
    ]);

    const successMessage = pairCopy(locale).accepted(escapeHtml(inviter?.name));

    await service.sendMessage(chatId, successMessage, { format: MessageFormat.HTML });

    // Best-effort notification — does not block the success message above.
    notifyInviterOfAccept(result.inviterUserId, acceptor?.name ?? '').catch(() => {});
  } catch (err) {
    if (err instanceof PairingError) {
      await service.sendMessage(chatId, pairingErrorMessage(err.code, locale), { format: MessageFormat.HTML });
      return;
    }
    captureError(err, 'pair-accept-handler', { acceptingUserId });
    await service.sendMessage(chatId, pairingErrorMessage('UNKNOWN_ERROR', locale), { format: MessageFormat.HTML });
  }
}

/**
 * Detect a free-text "accept <token>" command from a chat message. Returns
 * the token if matched, null otherwise. Permissive: handles "/accept", "accept",
 * any case. Token must be ≥ 16 hex chars to avoid false positives on natural
 * language uses of the word.
 */
export function parseAcceptCommand(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^\/?accept\s+([a-fA-F0-9]{16,})\s*$/);
  if (!match) return null;
  return match[1];
}
