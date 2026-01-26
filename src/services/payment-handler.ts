/**
 * Telegram Stars Payment Handler
 * Handles pre-checkout queries and successful payments for subscription upgrades
 */

import { getBot, getMessagingService } from './telegram';
import { getUserByTelegramId } from './user-service';
import { upgradeSubscription, renewSubscription, getSubscription } from './subscription-service';
import { prisma } from '../utils/prisma';
import { trackActivity } from './analytics-service';
import { MessageFormat } from './messaging/types';
import { getBotMessages } from '../lib/bot-messages';
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
    const user = await getUserByTelegramId(payload.userId);
    if (!user) {
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'User not found',
      });
      return;
    }

    // Approve the checkout
    await bot.answerPreCheckoutQuery(query.id, true);
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

  try {
    // Parse payload
    const payload: PaymentPayload = JSON.parse(payment.invoice_payload);

    // Get user for language
    const user = await getUserByTelegramId(userId);
    const language = user?.language || 'en';
    const t = await getBotMessages(language);

    // Activate subscription
    if (payload.action === 'renew') {
      await renewSubscription(userId, payment.telegram_payment_charge_id);
    } else {
      await upgradeSubscription(userId, payload.plan, payment.telegram_payment_charge_id);
    }

    // Track payment
    await trackActivity(userId, 'subscription_upgraded', {
      plan: payload.plan,
      to_plan: payload.plan,
    });

    // Get plan config for message
    const planConfig = PLAN_CONFIGS[payload.plan];

    // Send confirmation message
    const dashboardUrl = buildUrl(`/${language}/subscription?user_id=${userId}`);

    const successMessage = t.subscription?.paymentSuccess
      ? t.subscription.paymentSuccess
          .replace('{plan}', planConfig.name)
          .replace('{features}', planConfig.features.join('\n• '))
      : `✅ <b>Payment successful!</b>\n\nYou're now on the <b>${planConfig.name}</b> plan.\n\n<b>Features unlocked:</b>\n• ${planConfig.features.join('\n• ')}`;

    await messagingService.sendMessage(chatId, successMessage, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          {
            text: t.subscription?.viewSubscription || 'View Subscription',
            web_app: { url: dashboardUrl },
          },
        ]],
      },
    });

    console.log(`[Payment] Subscription activated for user ${userId}, plan: ${payload.plan}`);
  } catch (error) {
    captureError(error, 'payment-successful', { user_id: userId });

    // Notify user of error
    const t = await getBotMessages('en');
    await messagingService.sendMessage(
      chatId,
      t.subscription?.paymentError || '❌ There was an error activating your subscription. Please contact support.',
      { format: MessageFormat.HTML }
    );
  }
}

/**
 * Send subscription invoice to user
 * Called when user clicks upgrade button
 * @param recurring - If true, uses Telegram's subscription feature (requires BotFather config)
 */
export async function sendSubscriptionInvoice(
  chatId: number,
  userId: number,  // Internal DB user ID
  plan: PlanId,
  recurring: boolean = false
): Promise<void> {
  const bot = getBot();
  // Get user by internal DB ID (not Telegram ID)
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const language = user?.language || 'en';
  const t = await getBotMessages(language);

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

  const title = t.subscription?.invoiceTitle?.replace('{plan}', planConfig.name)
    || `FamCalBot ${planConfig.name}`;
  const description = t.subscription?.invoiceDescription
    ? t.subscription.invoiceDescription.replace('{features}', planConfig.features.join(', '))
    : `${planConfig.features.join(', ')}`;

  if (recurring) {
    // Recurring subscription (requires subscription export URL in BotFather)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bot as any).sendInvoice(chatId, title, description, JSON.stringify(payload), '', 'XTR', [
      { label: `${planConfig.name} Plan (Monthly)`, amount: planConfig.priceStars },
    ], {
      subscription_period: 2592000, // 30 days in seconds
    });
    console.log(`[Payment] Recurring invoice sent to user ${userId} for plan ${plan}`);
  } else {
    // One-time payment
    await bot.sendInvoice(chatId, title, description, JSON.stringify(payload), '', 'XTR', [
      { label: `${planConfig.name} Plan (1 Month)`, amount: planConfig.priceStars },
    ]);
    console.log(`[Payment] One-time invoice sent to user ${userId} for plan ${plan}`);
  }
}
