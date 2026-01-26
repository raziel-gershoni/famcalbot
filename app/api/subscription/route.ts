import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
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
    const initData = searchParams.get('initData');

    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Missing user_id' },
        { status: 400 }
      );
    }

    const userIdNum = parseInt(userId);

    // Verify user access via Telegram initData
    if (initData && !verifyUserAccess(initData, userIdNum)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get subscription with usage
    const subWithUsage = await getSubscriptionWithUsage(userIdNum);

    if (!subWithUsage) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // Get trial status
    const trialStatus = await getTrialStatus(userIdNum);

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
