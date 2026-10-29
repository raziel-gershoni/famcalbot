/**
 * The admin's refund of one of a person's payments (the Refund row of each payment in the admin panel's Plan section).
 * The terms promise a refund of any payment on request within 14 days of it, through /paysupport (see
 * src/lib/refund-eligibility.ts); the request reaches the admins as feedback with the person's subscription facts, and an
 * admin refunds the payment here, by its own Payment row.
 *
 * In this order:
 *   1. There must be a payment of that person to refund, and a Telegram id to refund to. One the database already holds as
 *      refunded (a panel that was not reloaded) is done: nothing is asked of Telegram.
 *   2. Telegram is asked to refund the Stars (refundStarPayment, with the person's Telegram id and that payment's charge
 *      id). A refusal (too old) changes nothing here; "already refunded" goes on to step 3, so a refund that was never
 *      recorded (a lost answer, a failed step 3) is finished by tapping Refund again. A rate limit or a 5xx is a failure to
 *      retry.
 *   3. Only when Telegram has agreed, the refund is recorded (recordRefund, one transaction): the payment is marked
 *      refunded, and when it funds the current month the paid plan ends (FREE / EXPIRED); an earlier payment leaves the plan
 *      as it is. If this step fails the money is back with the person but nothing is recorded: logged and sent to Sentry
 *      loudly, so an admin can finish it (tapping Refund again does).
 *   4. The person is told in their language: back on the Free plan, or which earlier payment was refunded. A message that
 *      fails to send does not undo the refund.
 * Never logs the bot token: Telegram's errors can carry the request's URL, which holds it.
 */

import { prisma } from '../utils/prisma';
import { captureError } from '../lib/error-capture';
import { getBotMessages, getSubscriptionMessages } from '../lib/bot-messages';
import { paymentDay } from '../lib/plan-disclosure';
import { getBot, getMessagingService } from './telegram/bot';
import { recordRefund } from './subscription-service';
import { paymentZone } from './payment-handler';
import { getUserById } from './user-service';
import { TIMEZONE } from '../config/constants';

export type RefundOutcome =
  | { ok: true }
  | { ok: false; code: 'NO_PAYMENT' | 'REFUND_REFUSED' | 'REFUND_FAILED' | 'NOT_RECORDED' };

/** The person, as the route reads their row: the ids and the language. */
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

/**
 * Telegram answered and said no: node-telegram-bot-api's TelegramError (code ETELEGRAM), with the Bot API's description.
 * A rate limit or a Telegram server error is not a refusal (null: a failure to try again).
 */
function telegramRefusal(error: unknown): string | null {
  const e = error as { code?: unknown; response?: { statusCode?: unknown; body?: { description?: unknown } } };
  if (e?.code !== 'ETELEGRAM') return null;
  const status = typeof e.response?.statusCode === 'number' ? e.response.statusCode : 0;
  if (status === 429 || status >= 500) return null;
  const description = e.response?.body?.description;
  return typeof description === 'string' ? description : safeText(error);
}

/** Telegram's refusal for a charge it already refunded: the Stars are back, so the plan must end all the same. */
const alreadyRefunded = (refusal: string) => /CHARGE_ALREADY_REFUNDED/i.test(refusal);

/**
 * node-telegram-bot-api 0.66 has no method for refundStarPayment (Bot API 7.4): the generic request, as the streaming
 * draft's sendMessageDraft does.
 */
async function refundStarPayment(telegramId: number, chargeId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (getBot() as any)._request('refundStarPayment', { form: { user_id: telegramId, telegram_payment_charge_id: chargeId } });
}

export async function refundPayment(user: RefundTarget, paymentId: string, adminId: number): Promise<RefundOutcome> {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, userId: user.id } });
  if (!user.telegramId || !payment) {
    console.warn(`[admin-refund] Admin ${adminId}: user ${user.id} has no payment ${paymentId} to refund (Telegram id ${user.telegramId ? 'set' : 'missing'}, payment ${payment ? 'found' : 'not theirs or missing'})`);
    return { ok: false, code: 'NO_PAYMENT' };
  }
  if (payment.refundedAt) {
    console.warn(`[admin-refund] Admin ${adminId}: payment ${paymentId} of user ${user.id} was refunded on ${payment.refundedAt.toISOString()} already; nothing to do`);
    return { ok: true };
  }

  let refundedBefore = false;
  try {
    await refundStarPayment(Number(user.telegramId), payment.telegramPaymentChargeId);
  } catch (error) {
    const refusal = telegramRefusal(error);
    if (refusal !== null && alreadyRefunded(refusal)) {
      refundedBefore = true;
      // A refund that went through before but was never recorded (the answer was lost, or recording it failed): record it now
      console.warn(`[admin-refund] Admin ${adminId}: payment ${paymentId} of user ${user.id} was already refunded at Telegram; recording it`);
    } else if (refusal !== null) {
      console.warn(`[admin-refund] Admin ${adminId}: Telegram refused to refund payment ${paymentId} of user ${user.id}: ${refusal}`);
      return { ok: false, code: 'REFUND_REFUSED' };
    } else {
      console.error(`[admin-refund] Admin ${adminId}: asking Telegram to refund payment ${paymentId} of user ${user.id} failed: ${safeText(error)}`);
      captureError(new Error(safeText(error)), 'admin-refund', { user_id: user.id, admin_id: adminId, payment_id: paymentId });
      return { ok: false, code: 'REFUND_FAILED' };
    }
  }

  let recorded: Awaited<ReturnType<typeof recordRefund>>;
  try {
    recorded = await recordRefund(paymentId, adminId);
  } catch (error) {
    console.error(`[admin-refund] Admin ${adminId}: payment ${paymentId} of user ${user.id} was refunded at Telegram but the refund was not recorded (${safeText(error)}); tap Refund again, or end it by hand`);
    captureError(new Error(`Refunded at Telegram but not recorded: ${safeText(error)}`), 'admin-refund', { user_id: user.id, admin_id: adminId, payment_id: paymentId });
    return { ok: false, code: 'NOT_RECORDED' };
  }
  if (!recorded.ok) {
    // Another admin's refund of the same payment finished first (Telegram refunded once, and it is recorded)
    console.warn(`[admin-refund] Admin ${adminId}: payment ${paymentId} of user ${user.id} was refunded and recorded already${refundedBefore ? ' (Telegram said so too)' : ''}; nothing left to do`);
    return { ok: true };
  }

  try {
    const language = user.language || 'en';
    const t = await getBotMessages(language);
    let text = t.subscription.refunded as string;
    if (!recorded.endedPlan) {
      const plans = (await getSubscriptionMessages(language)).plans;
      // The zone as the confirmation counted it: the person's config (getUserById decrypts the Google token the zone
      // lookup may use; the route's raw row holds it sealed)
      const person = await getUserById(user.id);
      const zone = person ? await paymentZone(person) : TIMEZONE;
      text = String(t.subscription.refundedEarlier)
        .replace('{plan}', plans?.[recorded.plan.toLowerCase()]?.name || recorded.plan)
        .replace('{date}', paymentDay(recorded.paidAt, zone, language));
    }
    await getMessagingService().sendMessage(Number(user.telegramId), text);
  } catch (error) {
    console.error(`[admin-refund] User ${user.id} was refunded payment ${paymentId} but could not be told: ${safeText(error)}`);
    captureError(new Error(safeText(error)), 'admin-refund-notify', { user_id: user.id, payment_id: paymentId }, 'warning');
  }

  return { ok: true };
}
