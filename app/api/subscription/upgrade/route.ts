/**
 * Subscription Upgrade API
 * POST: Trigger a Telegram Stars invoice for upgrading to a paid plan
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserByTelegramId } from '@/src/services/user-service';
import { sendSubscriptionInvoice } from '@/src/services/payment-handler';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { captureError } from '@/src/lib/error-capture';
import { PlanId, PLAN_CONFIGS } from '@/src/config/plans';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, plan, initData } = body;

    // Validate required fields
    if (!user_id || !plan) {
      return NextResponse.json(
        { error: 'user_id and plan are required' },
        { status: 400 }
      );
    }

    // Validate plan
    if (!['BASIC', 'PRO'].includes(plan)) {
      return NextResponse.json(
        { error: 'Invalid plan. Must be BASIC or PRO' },
        { status: 400 }
      );
    }

    // Verify plan has a price (not free)
    const planConfig = PLAN_CONFIGS[plan as PlanId];
    if (!planConfig || planConfig.priceStars === 0) {
      return NextResponse.json(
        { error: 'Cannot upgrade to free plan' },
        { status: 400 }
      );
    }

    // Get user by Telegram ID
    const user = await getUserByTelegramId(user_id);
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Verify Telegram authentication if initData is provided
    if (initData && !verifyUserAccess(initData, user_id)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Send invoice to user via Telegram (manual renewal model)
    // The chatId is the same as the telegramId for private chats
    if (!user.telegramId) {
      return NextResponse.json(
        { error: 'Subscription upgrades via Telegram Stars require a linked Telegram account' },
        { status: 400 }
      );
    }
    const chatId = Number(user.telegramId);
    await sendSubscriptionInvoice(chatId, user.id, plan as PlanId);

    return NextResponse.json({
      success: true,
      message: `Invoice sent for ${planConfig.name} plan`,
    });
  } catch (error) {
    captureError(error, 'subscription-upgrade-api', { api_route: '/api/subscription/upgrade' });
    console.error('[Subscription Upgrade] Error:', error);
    return NextResponse.json(
      { error: 'Failed to send invoice' },
      { status: 500 }
    );
  }
}
