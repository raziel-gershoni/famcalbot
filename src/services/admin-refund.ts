/**
 * The admin's refund of a person's last payment (the "Refund last payment" action of the admin panel's Plan section). The
 * terms promise a refund on request within 14 days, through /paysupport (see src/lib/refund-eligibility.ts); the request
 * reaches the admins as feedback with the person's subscription facts, and an admin makes the refund here.
 *
 * In this order:
 *   1. There must be a real payment to refund: a charge id that no admin gave away, and a Telegram id to refund to.
 *   2. Telegram is asked to refund the Stars (refundStarPayment, with the person's Telegram id and the payment's charge
 *      id). A refusal (already refunded, too old) changes nothing here.
 *   3. Only when Telegram has agreed, the paid plan ends (refundSubscription: FREE / EXPIRED, charge id cleared, access
 *      cache dropped, activity row). If this step fails the money is back with the person but the plan is still paid:
 *      logged and sent to Sentry loudly, so an admin can finish it by hand.
 *   4. The person is told in their language. A message that fails to send does not undo the refund.
 * Never logs the bot token: Telegram's errors can carry the request's URL, which holds it.
 */

import { prisma } from '../utils/prisma';
import { captureError } from '../lib/error-capture';
import { getBotMessages } from '../lib/bot-messages';
import { getBot, getMessagingService } from './telegram/bot';
import { refundSubscription } from './subscription-service';

export type RefundOutcome =
  | { ok: true }
  | { ok: false; code: 'NO_PAYMENT' | 'REFUND_REFUSED' | 'REFUND_FAILED' | 'NOT_RECORDED' };

interface RefundTarget {
  id: number;
  telegramId: bigint | number | null;
  language: string | null;
}

/** What an error says, with the bot token (which a Telegram request's URL carries) taken out. */
function safeText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? text.split(token).join('[bot token]') : text;
}

/** Telegram answered and said no: node-telegram-bot-api's TelegramError (code ETELEGRAM), with the Bot API's description. */
function telegramRefusal(error: unknown): string | null {
  const e = error as { code?: unknown; response?: { body?: { description?: unknown } } };
  if (e?.code !== 'ETELEGRAM') return null;
  const description = e.response?.body?.description;
  return typeof description === 'string' ? description : safeText(error);
}

/**
 * node-telegram-bot-api 0.66 has no method for refundStarPayment (Bot API 7.4): the generic request, as the streaming
 * draft's sendMessageDraft does.
 */
async function refundStarPayment(telegramId: number, chargeId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (getBot() as any)._request('refundStarPayment', { form: { user_id: telegramId, telegram_payment_charge_id: chargeId } });
}

export async function refundLastPayment(user: RefundTarget, adminId: number): Promise<RefundOutcome> {
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  if (!user.telegramId || !sub?.telegramPaymentChargeId || sub.compedBy != null) {
    console.warn(`[admin-refund] Admin ${adminId}: user ${user.id} has no payment to refund (Telegram id ${user.telegramId ? 'set' : 'missing'}, charge id ${sub?.telegramPaymentChargeId ? 'set' : 'missing'}, free gift ${sub?.compedBy != null})`);
    return { ok: false, code: 'NO_PAYMENT' };
  }

  try {
    await refundStarPayment(Number(user.telegramId), sub.telegramPaymentChargeId);
  } catch (error) {
    const refusal = telegramRefusal(error);
    if (refusal !== null) {
      console.warn(`[admin-refund] Admin ${adminId}: Telegram refused to refund user ${user.id}: ${refusal}`);
      return { ok: false, code: 'REFUND_REFUSED' };
    }
    console.error(`[admin-refund] Admin ${adminId}: asking Telegram to refund user ${user.id} failed: ${safeText(error)}`);
    captureError(new Error(safeText(error)), 'admin-refund', { user_id: user.id, admin_id: adminId });
    return { ok: false, code: 'REFUND_FAILED' };
  }

  try {
    const ended = await refundSubscription(user.id, adminId);
    if (!ended.ok) throw new Error('the subscription no longer holds a payment');
  } catch (error) {
    console.error(`[admin-refund] Admin ${adminId}: user ${user.id} was refunded at Telegram but their plan was not ended (${safeText(error)}); end it by hand`);
    captureError(new Error(`Refunded at Telegram but the plan was not ended: ${safeText(error)}`), 'admin-refund', { user_id: user.id, admin_id: adminId });
    return { ok: false, code: 'NOT_RECORDED' };
  }

  try {
    const t = await getBotMessages(user.language || 'en');
    await getMessagingService().sendMessage(Number(user.telegramId), t.subscription.refunded);
  } catch (error) {
    console.error(`[admin-refund] User ${user.id} was refunded but could not be told: ${safeText(error)}`);
    captureError(new Error(safeText(error)), 'admin-refund-notify', { user_id: user.id }, 'warning');
  }

  return { ok: true };
}
