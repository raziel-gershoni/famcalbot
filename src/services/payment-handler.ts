/**
 * Telegram Stars Payment Handler
 * Handles pre-checkout queries and successful payments for subscription upgrades
 */

import { getBot, getMessagingService } from './telegram';
import { getUserByTelegramId } from './user-service';
import { creditPayment, getSubscription } from './subscription-service';
import { prisma } from '../utils/prisma';
import { trackActivity, addBreadcrumb, setUserContext } from './analytics-service';
import { MessageFormat } from './messaging/types';
import { getBotMessages, getSubscriptionMessages } from '../lib/bot-messages';
import { PlanId, PLAN_CONFIGS } from '../config/plans';
import { TIMEZONE } from '../config/constants';
import { buildUrl } from '../config/urls';
import { captureError } from '../lib/error-capture';
import { invoiceDescription, paymentConfirmation, paymentFallback } from '../lib/plan-disclosure';
import { timezoneWithin, TZ_LOOKUP_MS, type TimezoneUser } from '../lib/timezone';

interface PreCheckoutQuery {
  id: string;
  from: { id: number };
  currency: string;
  total_amount: number;
  invoice_payload: string;
}

interface SuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id: string;
}

interface PaymentPayload {
  plan: PlanId;
  userId: number;
  action: 'upgrade' | 'renew';
}

/**
 * Handle pre-checkout query
 * Validate payment before processing
 */
export async function handlePreCheckoutQuery(query: PreCheckoutQuery): Promise<void> {
  const bot = getBot();

  // Set user context and add breadcrumb
  setUserContext(query.from.id);
  addBreadcrumb('pre_checkout_received', {
    query_id: query.id,
    currency: query.currency,
    amount: query.total_amount,
  }, 'payment');

  try {
    // Parse payload
    let payload: PaymentPayload;
    try {
      payload = JSON.parse(query.invoice_payload);
    } catch {
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'Invalid payment data',
      });
      return;
    }

    // Validate currency is Telegram Stars
    if (query.currency !== 'XTR') {
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'Invalid currency',
      });
      return;
    }

    // Validate plan and amount
    const planConfig = PLAN_CONFIGS[payload.plan];
    if (!planConfig || query.total_amount !== planConfig.priceStars) {
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'Invalid amount',
      });
      return;
    }

    // Validate user
    const user = await getUserByTelegramId(query.from.id);
    if (!user) {
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'User not found',
      });
      return;
    }

    // Approve the checkout
    await bot.answerPreCheckoutQuery(query.id, true);

    // Add breadcrumb for approval
    addBreadcrumb('pre_checkout_approved', {
      user_id: payload.userId,
      plan: payload.plan,
      action: payload.action,
    }, 'payment');

    console.log(`[Payment] Pre-checkout approved for user ${payload.userId}, plan: ${payload.plan}`);
  } catch (error) {
    captureError(error, 'payment-pre-checkout', { query_id: query.id });
    await bot.answerPreCheckoutQuery(query.id, false, {
      error_message: 'Payment processing error',
    });
  }
}

/**
 * The person's zone for the paid month's end and its confirmation, as the lookup gives it within TZ_LOOKUP_MS (the
 * screens' own wait): the webhook answers Telegram only when this handler returns, so a cold cache and a slow place
 * search must not hold it. Past that wait the lookup carries on and caches its answer for next time, and the month is
 * counted in Israel's zone (TIMEZONE); a lookup that fails does the same. Either is logged. The refund's message to the
 * person names the payment's day in the same zone (admin-refund.ts).
 */
export async function paymentZone(user: TimezoneUser): Promise<string> {
  try {
    const zone = await timezoneWithin(user, TZ_LOOKUP_MS);
    if (zone) return zone;
    console.warn(`[Payment] The timezone of user ${user.id} took over ${TZ_LOOKUP_MS} ms; the payment's dates use ${TIMEZONE}`);
    return TIMEZONE;
  } catch (error) {
    console.error(`[Payment] Could not read the timezone of user ${user.id}; the payment's dates use ${TIMEZONE}:`, error);
    captureError(error, 'payment-confirmation-timezone', { user_id: user.id }, 'warning');
    return TIMEZONE;
  }
}

/** The invoice's payload, when it names a paid plan; null when it can't be read. */
function readPayload(raw: string): PaymentPayload | null {
  try {
    const payload = JSON.parse(raw) as PaymentPayload;
    return payload && PLAN_CONFIGS[payload.plan] && PLAN_CONFIGS[payload.plan].priceStars > 0 ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Handle successful payment (the webhook's successful_payment), once per charge: Telegram delivers the update again
 * when the webhook's answer fails or is late, and a charge already recorded credits nothing and sends nothing.
 *
 *   1. Who paid (the internal user.id from the payer's Telegram id) and for what (the invoice's payload). A payer the
 *      bot doesn't know, or a payload that names no paid plan, can't be credited by any delivery: logged, captured, the
 *      person told activation failed (in their language when known), and answered.
 *   2. The credit (creditPayment): the payment's row, the plan and the month, in one transaction. A failure there (the
 *      database) leaves nothing written: it is logged and thrown, so the webhook answers 500 and Telegram delivers the
 *      update again, which credits it then.
 *   3. The one confirmation (src/lib/plan-disclosure.ts): the plan, the price, when the month ends in the person's zone,
 *      that it never renews, the seller and the ways to cancel within 14 days. The plan is active by now, so a failure
 *      here never says activation failed: it is logged and captured, and the short plain-text fallback is sent instead.
 */
export async function handleSuccessfulPayment(
  chatId: number,
  userId: number,
  payment: SuccessfulPayment
): Promise<void> {
  const messagingService = getMessagingService();
  const chargeId = payment.telegram_payment_charge_id;

  // Set user context and add breadcrumb
  setUserContext(userId);
  addBreadcrumb('payment_received', {
    user_id: userId,
    currency: payment.currency,
    amount: payment.total_amount,
    charge_id: chargeId,
  }, 'payment');

  // 1. Who paid and for what (userId is the payer's Telegram id; a lookup that throws goes to the route: 500, delivered again)
  const user = await getUserByTelegramId(userId);
  const payload = readPayload(payment.invoice_payload);
  if (!user || !payload) {
    const why = !user ? `no user has Telegram id ${userId}` : `its payload names no paid plan: ${payment.invoice_payload}`;
    console.error(`[Payment] Charge ${chargeId} can't be credited: ${why}`);
    captureError(new Error(`A paid charge can't be credited: ${why}`), 'payment-successful', { telegram_id: userId, charge_id: chargeId });
    const errorT = await getSubscriptionMessages(user?.language || 'en');
    await messagingService.sendMessage(chatId, errorT.paymentError, { format: MessageFormat.HTML });
    return;
  }
  const language = user.language || 'en';

  // 2. The credit, all or nothing (use internal DB user.id, not Telegram userId), the month on the person's clock
  const timeZone = await paymentZone(user);
  let credit: Awaited<ReturnType<typeof creditPayment>>;
  try {
    credit = await creditPayment(user.id, { chargeId, plan: payload.plan, amount: payment.total_amount, currency: payment.currency }, timeZone, payload.action);
  } catch (error) {
    console.error(`[Payment] Crediting charge ${chargeId} to user ${user.id} failed before it committed, so nothing was written; the webhook answers 500 so Telegram delivers it again:`, error);
    throw error;
  }
  if (!credit.credited) {
    console.log(`[Payment] Charge ${chargeId} for user ${user.id} was already credited: a repeated update, so no second confirmation`);
    return;
  }

  // 3. The one confirmation, in the person's language and zone; its plain fallback if it can't be sent. The plan is active
  // now, so nothing below may throw out of the handler (a 500 would bring a delivery that credits nothing and confirms nothing).
  const localizedName = (names: Record<string, { name?: string }> | undefined) => names?.[payload.plan.toLowerCase()]?.name || payload.plan;
  try {
    addBreadcrumb('subscription_activated', { user_id: user.id, plan: payload.plan, action: payload.action }, 'payment');
    // Track payment (use internal DB user.id)
    await trackActivity(user.id, 'subscription_upgraded', { plan: payload.plan, to_plan: payload.plan });
    const [t, botMessages] = await Promise.all([getSubscriptionMessages(language), getBotMessages(language)]);
    const dashboardUrl = buildUrl(`/${language}/subscription?user_id=${userId}`);
    const successMessage = paymentConfirmation({
      template: t.paymentSuccess,
      words: botMessages.policy,
      locale: language,
      planName: localizedName(t.plans),
      price: payment.total_amount,
      periodEnd: credit.payment.periodEnd,
      timeZone,
    });
    await messagingService.sendMessage(chatId, successMessage, {
      format: MessageFormat.HTML,
      disablePreview: true,
      replyMarkup: {
        inline_keyboard: [[
          {
            text: t.viewSubscription,
            web_app: { url: dashboardUrl },
          },
        ]],
      },
    });
    console.log(`[Payment] Subscription activated for user ${user.id}, plan: ${payload.plan}`);
  } catch (error) {
    console.error(`[Payment] The confirmation of charge ${chargeId} to user ${user.id} failed (the plan is active); sending its short fallback:`, error);
    captureError(error, 'payment-confirmation', { user_id: user.id, charge_id: chargeId });
    try {
      const t = await getSubscriptionMessages(language);
      await messagingService.sendMessage(chatId, paymentFallback({ template: t.paymentFallback, locale: language, planName: localizedName(t.plans), periodEnd: credit.payment.periodEnd, timeZone }));
    } catch (fallbackError) {
      console.error(`[Payment] The fallback confirmation of charge ${chargeId} to user ${user.id} failed too:`, fallbackError);
      captureError(fallbackError, 'payment-confirmation-fallback', { user_id: user.id, charge_id: chargeId });
    }
  }
}

/**
 * Send subscription invoice to user
 * Called when user clicks upgrade button
 * Uses manual renewal model - subscriptions run until end of month
 */
export async function sendSubscriptionInvoice(
  chatId: number,
  userId: number,  // Internal DB user ID
  plan: PlanId
): Promise<void> {
  const bot = getBot();
  // Get user by internal DB ID (not Telegram ID)
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const language = user?.language || 'en';
  const t = await getSubscriptionMessages(language);

  const planConfig = PLAN_CONFIGS[plan];
  if (!planConfig || planConfig.priceStars === 0) {
    throw new Error('Invalid plan or free plan');
  }

  // Determine if this is an upgrade or renewal
  const subscription = await getSubscription(userId);
  const action = subscription?.status === 'ACTIVE' && subscription.plan === plan
    ? 'renew'
    : 'upgrade';

  const payload: PaymentPayload = {
    plan,
    userId,
    action,
  };

  // The plan's name in the person's language, and the disclosure Telegram shows before paying (src/lib/plan-disclosure.ts)
  const planKey = plan.toLowerCase();
  const localizedPlanName = t.plans?.[planKey]?.name || planConfig.name;

  const title = String(t.invoiceTitle).replace('{plan}', localizedPlanName);
  const description = invoiceDescription(t.invoiceDescription, language, localizedPlanName);
  const priceLabel = String(t.invoiceLabel).replace('{plan}', localizedPlanName);

  // Add breadcrumb for invoice sent
  addBreadcrumb('invoice_sending', {
    user_id: userId,
    plan,
    action,
    amount: planConfig.priceStars,
  }, 'payment');

  // One-time payment (manual renewal model - no recurring subscriptions)
  await bot.sendInvoice(chatId, title, description, JSON.stringify(payload), '', 'XTR', [
    { label: priceLabel, amount: planConfig.priceStars },
  ]);
  addBreadcrumb('invoice_sent', { recurring: false }, 'payment');
  console.log(`[Payment] Invoice sent to user ${userId} for plan ${plan}`);
}
