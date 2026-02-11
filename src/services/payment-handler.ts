/**
 * Telegram Stars Payment Handler
 * Handles pre-checkout queries and successful payments for subscription upgrades
 */

import { getBot, getMessagingService } from './telegram';
import { getUserByTelegramId } from './user-service';
import { upgradeSubscription, renewSubscription, getSubscription } from './subscription-service';
import { prisma } from '../utils/prisma';
import { trackActivity, addBreadcrumb, setUserContext } from './analytics-service';
import { MessageFormat } from './messaging/types';
import { getSubscriptionMessages } from '../lib/bot-messages';
import { PlanId, PLAN_CONFIGS } from '../config/plans';
import { buildUrl } from '../config/urls';
import { captureError } from '../lib/error-capture';

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
 * Handle successful payment
 * Activate or renew subscription
 */
export async function handleSuccessfulPayment(
  chatId: number,
  userId: number,
  payment: SuccessfulPayment
): Promise<void> {
  const messagingService = getMessagingService();

  // Set user context and add breadcrumb
  setUserContext(userId);
  addBreadcrumb('payment_received', {
    user_id: userId,
    currency: payment.currency,
    amount: payment.total_amount,
    charge_id: payment.telegram_payment_charge_id,
  }, 'payment');

  try {
    // Parse payload
    const payload: PaymentPayload = JSON.parse(payment.invoice_payload);

    // Get user for language (userId param is Telegram ID from webhook)
    const user = await getUserByTelegramId(userId);
    if (!user) {
      throw new Error(`User not found for Telegram ID: ${userId}`);
    }
    const language = user.language || 'en';
    const t = await getSubscriptionMessages(language);

    // Activate subscription (use internal DB user.id, not Telegram userId)
    if (payload.action === 'renew') {
      await renewSubscription(user.id, payment.telegram_payment_charge_id);
    } else {
      await upgradeSubscription(user.id, payload.plan, payment.telegram_payment_charge_id);
    }

    // Add breadcrumb for subscription activation
    addBreadcrumb('subscription_activated', {
      user_id: user.id,
      plan: payload.plan,
      action: payload.action,
    }, 'payment');

    // Track payment (use internal DB user.id)
    await trackActivity(user.id, 'subscription_upgraded', {
      plan: payload.plan,
      to_plan: payload.plan,
    });

    // Get localized plan name and features
    const planKey = payload.plan.toLowerCase();
    const localizedPlanName = t.plans?.[planKey]?.name || payload.plan;
    const featuresList = t.features
      ? Object.values(t.features).join('\n• ')
      : '';

    // Send confirmation message
    const dashboardUrl = buildUrl(`/${language}/subscription?user_id=${userId}`);

    const successMessage = t.paymentSuccess
      ? t.paymentSuccess
          .replace('{plan}', localizedPlanName)
          .replace('{features}', featuresList)
      : `✅ <b>Payment successful!</b>\n\nYou're now on the <b>${localizedPlanName}</b> plan.\n\n<b>Features unlocked:</b>\n• ${featuresList}`;

    await messagingService.sendMessage(chatId, successMessage, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          {
            text: t.viewSubscription || 'View Subscription',
            web_app: { url: dashboardUrl },
          },
        ]],
      },
    });

    console.log(`[Payment] Subscription activated for user ${userId}, plan: ${payload.plan}`);
  } catch (error) {
    captureError(error, 'payment-successful', { user_id: userId });

    // Notify user of error
    const errorT = await getSubscriptionMessages('en');
    await messagingService.sendMessage(
      chatId,
      errorT.paymentError || '❌ There was an error activating your subscription. Please contact support.',
      { format: MessageFormat.HTML }
    );
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

  // Use localized plan name and features
  const planKey = plan.toLowerCase();
  const localizedPlanName = t.plans?.[planKey]?.name || planConfig.name;
  const localizedFeatures = t.features
    ? Object.values(t.features).join(', ')
    : planConfig.features.join(', ');

  const title = t.invoiceTitle
    ? t.invoiceTitle.replace('{plan}', localizedPlanName)
    : `FamCalBot ${localizedPlanName}`;
  const description = t.invoiceDescription
    ? t.invoiceDescription.replace('{features}', localizedFeatures)
    : localizedFeatures;
  const priceLabel = t.invoiceLabel
    ? t.invoiceLabel.replace('{plan}', localizedPlanName)
    : `${localizedPlanName} (1 month)`;

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
