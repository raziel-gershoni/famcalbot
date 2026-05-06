// Shared pair-acceptance flow used by both:
//   - Telegram /start invite_<token> (deep link)
//   - Free-text "accept <token>" on Telegram and WhatsApp
//
// All routing converges here so the validation, error mapping, and inviter
// notification live in one place. The HTTP route at /api/pair/accept uses
// the same underlying pairing-service.acceptInvite — this file is the
// chat-side adapter.

import { acceptInvite, PairingError } from '../pairing-service';
import { prisma } from '../../utils/prisma';
import { getMessagingService as getMessagingServiceByPlatform, MessagingPlatform, MessageFormat } from '../messaging';
import { getBotMessages } from '../../lib/bot-messages';
import { captureError } from '../../lib/error-capture';

/**
 * Map a PairingError code to a user-facing message in the recipient's language.
 * Errors are intentionally specific so users can self-correct (expired vs already
 * paired vs invalid token).
 */
function pairingErrorMessage(
  code: PairingError['code'],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any
): string {
  const p = t.pair || {};
  switch (code) {
    case 'INVITE_NOT_FOUND':
      return p.errorInviteNotFound || '❌ Invite link is invalid.';
    case 'INVITE_EXPIRED':
      return p.errorInviteExpired || '⌛ This invite link has expired. Ask for a new one.';
    case 'INVITE_ALREADY_USED':
      return p.errorInviteUsed || '⚠️ This invite has already been used.';
    case 'INVITE_REVOKED':
      return p.errorInviteRevoked || '⚠️ This invite was revoked.';
    case 'CANNOT_ACCEPT_OWN_INVITE':
      return p.errorOwnInvite || '🪞 You cannot accept your own invite.';
    case 'INVITER_NOT_NATIVE':
      return p.errorInviterNotNative || '❌ The inviter is using Google Calendar, not the in-bot calendar — pairing is not available.';
    case 'INVITEE_NOT_NATIVE':
      return p.errorInviteeNotNative || '❌ Pairing requires the in-bot calendar. You are currently using Google Calendar.';
    case 'INVITER_ALREADY_PAIRED':
      return p.errorInviterPaired || '⚠️ The inviter is already paired with someone else.';
    case 'INVITEE_ALREADY_PAIRED':
      return p.errorInviteePaired || '⚠️ You are already paired with someone. Unlink first to switch.';
    default:
      return p.errorUnknown || '❌ Could not accept the invite.';
  }
}

/**
 * Notify the inviter that their invite was accepted. Best-effort — failures
 * are logged but never block the success message to the acceptor.
 */
async function notifyInviterOfAccept(inviterUserId: number, acceptorName: string): Promise<void> {
  try {
    const inviter = await prisma.user.findUnique({
      where: { id: inviterUserId },
      select: { telegramId: true, whatsappPhone: true, whatsappBsuid: true, language: true, messagingPlatform: true },
    });
    if (!inviter) return;
    const t = await getBotMessages(inviter.language || 'en');
    const message = (t.pair?.acceptedNotification || '🎉 {name} accepted your invite. You are now paired.').replace('{name}', acceptorName);
    const platform =
      inviter.messagingPlatform === 'whatsapp' && (inviter.whatsappPhone || inviter.whatsappBsuid)
        ? MessagingPlatform.WHATSAPP
        : MessagingPlatform.TELEGRAM;
    const service = getMessagingServiceByPlatform(platform);
    const inviterChatId =
      platform === MessagingPlatform.TELEGRAM
        ? Number(inviter.telegramId)
        : inviter.whatsappPhone ?? inviter.whatsappBsuid ?? '';
    if (!inviterChatId) return;
    await service.sendMessage(inviterChatId, message, { format: MessageFormat.HTML });
  } catch (err) {
    captureError(err, 'pair-notify-inviter', undefined, 'warning');
  }
}

/**
 * Handle invite acceptance by an authenticated user (either via /start deep
 * link or via free-text accept command). chatId is the conversation's chat
 * id on the platform. acceptingUserId is the DB User.id (already resolved
 * by the caller).
 */
export async function handlePairAccept(
  chatId: number | string,
  acceptingUserId: number,
  token: string,
  locale: string,
  platform: MessagingPlatform
): Promise<void> {
  const t = await getBotMessages(locale);
  const service = getMessagingServiceByPlatform(platform);

  if (!token || token.length < 8) {
    await service.sendMessage(chatId, pairingErrorMessage('INVITE_NOT_FOUND', t), { format: MessageFormat.HTML });
    return;
  }

  try {
    const result = await acceptInvite(token, acceptingUserId);

    // Pull names for both sides — the success messages are personalized.
    const [inviter, acceptor] = await Promise.all([
      prisma.user.findUnique({ where: { id: result.inviterUserId }, select: { name: true, englishName: true } }),
      prisma.user.findUnique({ where: { id: result.inviteeUserId }, select: { name: true, englishName: true } }),
    ]);

    const inviterName = inviter?.name || 'your partner';
    const acceptorName = acceptor?.name || 'partner';
    const successMessage = (t.pair?.acceptedSuccess || '🎉 You are now paired with {name}!').replace('{name}', inviterName);

    await service.sendMessage(chatId, successMessage, { format: MessageFormat.HTML });

    // Best-effort notification — does not block the success message above.
    notifyInviterOfAccept(result.inviterUserId, acceptorName).catch(() => {});
  } catch (err) {
    if (err instanceof PairingError) {
      await service.sendMessage(chatId, pairingErrorMessage(err.code, t), { format: MessageFormat.HTML });
      return;
    }
    captureError(err, 'pair-accept-handler', { acceptingUserId });
    await service.sendMessage(chatId, pairingErrorMessage('UNKNOWN_ERROR', t), { format: MessageFormat.HTML });
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
