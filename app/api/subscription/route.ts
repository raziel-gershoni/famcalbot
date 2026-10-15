import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { generalRateLimiter } from '@/src/lib/rate-limit';
import {
  getSubscriptionWithUsage,
  getTrialStatus,
  getAllPlanConfigs,
} from '@/src/services/subscription-service';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

/**
 * GET /api/subscription
 * Get current user's subscription status, usage, and trial info
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const initData = requestInitData(request);

    // Mandatory: Telegram initData or the WhatsApp session cookie (400 without user_id)
    const auth = await verifyUserAuth(request, userId, initData, generalRateLimiter, 'subscription');
    if (!auth.success) {
      return auth.response;
    }
    const dbUserId = auth.user.id;

    // Get subscription with usage
    const subWithUsage = await getSubscriptionWithUsage(dbUserId);

    if (!subWithUsage) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // Get trial status
    const trialStatus = await getTrialStatus(dbUserId);

    // Get all plan configs for comparison
    const plans = getAllPlanConfigs();

    return NextResponse.json({
      success: true,
      subscription: {
        plan: subWithUsage.subscription.plan,
        status: subWithUsage.subscription.status,
        effectivePlan: subWithUsage.effectivePlan,
        currentPeriodStart: subWithUsage.subscription.currentPeriodStart,
        currentPeriodEnd: subWithUsage.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subWithUsage.subscription.cancelAtPeriodEnd,
      },
      usage: {
        textSummaries: subWithUsage.usage.textSummariesUsed,
        voiceSummaries: subWithUsage.usage.voiceSummariesUsed,
        voiceEvents: subWithUsage.usage.voiceEventsCreated,
        reminders: subWithUsage.usage.remindersTriggered,
        cycleStartDate: subWithUsage.usage.cycleStartDate,
      },
      trial: trialStatus,
      plans,
    });
  } catch (error) {
    captureError(error, 'subscription-api', { api_route: '/api/subscription' });
    return NextResponse.json(
      { success: false, error: 'Failed to get subscription' },
      { status: 500 }
    );
  }
}
