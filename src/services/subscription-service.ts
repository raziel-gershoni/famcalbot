/**
 * Subscription Service
 * Manages user subscriptions, trials, and feature access
 */

import { Subscription, SubscriptionPlan, SubscriptionStatus, UsageCounter } from '@prisma/client';
import { prisma, withDbRetry } from '../utils/prisma';
import { PlanId, getPlanLimits, TRIAL_DURATION_DAYS, PLAN_CONFIGS } from '../config/plans';
import { trackActivity } from './analytics-service';

// ============================================
// TYPES
// ============================================

export type FeatureType = 'text_summary' | 'voice_summary' | 'reminders' | 'voice_events' | 'calendars';

export interface FeatureAccessResult {
  allowed: boolean;
  reason?: 'limit_reached' | 'upgrade_required' | 'trial_expired';
  remaining?: number;
  limit?: number;
  currentUsage?: number;
}

export interface SubscriptionWithUsage {
  subscription: Subscription;
  usage: UsageCounter;
  effectivePlan: PlanId;  // The plan that determines current limits (PRO during trial)
}

// ============================================
// SUBSCRIPTION MANAGEMENT
// ============================================

/**
 * Get or create subscription for a user
 * New users automatically start with a 14-day trial
 */
export async function getOrCreateSubscription(userId: number): Promise<Subscription> {
  // Try to find existing
  const existing = await withDbRetry(
    () => prisma.subscription.findUnique({
      where: { userId },
    }),
    'getOrCreateSubscription.find'
  );

  if (existing) {
    return existing;
  }

  // Create new subscription with trial
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

  const subscription = await withDbRetry(
    () => prisma.subscription.create({
      data: {
        userId,
        plan: 'FREE',
        status: 'TRIALING',
        trialStartedAt: now,
        trialEndsAt,
      },
    }),
    'getOrCreateSubscription.create'
  );

  // Track trial start
  await trackActivity(userId, 'subscription_started', {
    plan: 'FREE',
    is_trial: true,
  });

  console.log(`[Subscription] Created trial subscription for user ${userId}, ends ${trialEndsAt.toISOString()}`);

  return subscription;
}

/**
 * Get subscription by user ID
 */
export async function getSubscription(userId: number): Promise<Subscription | null> {
  return withDbRetry(
    () => prisma.subscription.findUnique({
      where: { userId },
    }),
    'getSubscription'
  );
}

/**
 * Get subscription with usage data
 */
export async function getSubscriptionWithUsage(userId: number): Promise<SubscriptionWithUsage | null> {
  const [subscription, usage] = await Promise.all([
    getOrCreateSubscription(userId),
    getOrCreateUsageCounter(userId),
  ]);

  // Determine effective plan based on trial status
  let effectivePlan: PlanId = subscription.plan as PlanId;

  if (subscription.status === 'TRIALING' && new Date() < subscription.trialEndsAt) {
    // During trial, users get PRO access
    effectivePlan = 'PRO';
  } else if (subscription.status === 'TRIALING' && new Date() >= subscription.trialEndsAt) {
    // Trial expired - update status
    await expireTrialSubscription(userId);
    effectivePlan = 'FREE';
  } else if (subscription.status === 'EXPIRED') {
    effectivePlan = 'FREE';
  }

  return {
    subscription,
    usage,
    effectivePlan,
  };
}

/**
 * Upgrade subscription to a new plan
 */
export async function upgradeSubscription(
  userId: number,
  newPlan: PlanId,
  telegramPaymentChargeId?: string
): Promise<Subscription> {
  const existing = await getOrCreateSubscription(userId);
  const fromPlan = existing.plan;

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const updated = await withDbRetry(
    () => prisma.subscription.update({
      where: { userId },
      data: {
        plan: newPlan,
        status: 'ACTIVE',
        telegramPaymentChargeId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
    }),
    'upgradeSubscription'
  );

  // Track upgrade
  await trackActivity(userId, 'subscription_upgraded', {
    from_plan: fromPlan,
    to_plan: newPlan,
  });

  console.log(`[Subscription] User ${userId} upgraded from ${fromPlan} to ${newPlan}`);

  return updated;
}

/**
 * Cancel subscription (will expire at period end)
 */
export async function cancelSubscription(userId: number): Promise<Subscription> {
  const existing = await getSubscription(userId);
  if (!existing) {
    throw new Error('No subscription found');
  }

  const updated = await withDbRetry(
    () => prisma.subscription.update({
      where: { userId },
      data: {
        status: 'CANCELED',
        cancelAtPeriodEnd: true,
      },
    }),
    'cancelSubscription'
  );

  // Calculate days active
  const daysActive = Math.floor(
    (Date.now() - existing.createdAt.getTime()) / (24 * 60 * 60 * 1000)
  );

  // Track cancellation
  await trackActivity(userId, 'subscription_canceled', {
    plan: existing.plan,
    days_active: daysActive,
  });

  console.log(`[Subscription] User ${userId} canceled subscription, expires at period end`);

  return updated;
}

/**
 * Expire a trial subscription (called when trial ends)
 */
async function expireTrialSubscription(userId: number): Promise<Subscription> {
  const updated = await withDbRetry(
    () => prisma.subscription.update({
      where: { userId },
      data: {
        status: 'EXPIRED',
        plan: 'FREE',
      },
    }),
    'expireTrialSubscription'
  );

  await trackActivity(userId, 'subscription_expired', {
    plan: 'FREE',
    is_trial: true,
  });

  console.log(`[Subscription] Trial expired for user ${userId}`);

  return updated;
}

/**
 * Renew subscription (called on successful recurring payment)
 */
export async function renewSubscription(
  userId: number,
  telegramPaymentChargeId: string
): Promise<Subscription> {
  const existing = await getSubscription(userId);
  if (!existing) {
    throw new Error('No subscription found');
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const updated = await withDbRetry(
    () => prisma.subscription.update({
      where: { userId },
      data: {
        status: 'ACTIVE',
        telegramPaymentChargeId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
    }),
    'renewSubscription'
  );

  await trackActivity(userId, 'subscription_renewed', {
    plan: existing.plan,
  });

  console.log(`[Subscription] Subscription renewed for user ${userId}`);

  return updated;
}

// ============================================
// USAGE TRACKING
// ============================================

/**
 * Get or create usage counter for a user
 */
export async function getOrCreateUsageCounter(userId: number): Promise<UsageCounter> {
  const existing = await withDbRetry(
    () => prisma.usageCounter.findUnique({
      where: { userId },
    }),
    'getOrCreateUsageCounter.find'
  );

  if (existing) {
    // Check if we need to reset the cycle (monthly)
    const cycleStart = existing.cycleStartDate;
    const now = new Date();
    const monthsSinceCycleStart =
      (now.getFullYear() - cycleStart.getFullYear()) * 12 +
      (now.getMonth() - cycleStart.getMonth());

    if (monthsSinceCycleStart >= 1) {
      // Reset usage for new month
      return withDbRetry(
        () => prisma.usageCounter.update({
          where: { userId },
          data: {
            textSummariesUsed: 0,
            voiceSummariesUsed: 0,
            voiceEventsCreated: 0,
            remindersTriggered: 0,
            cycleStartDate: new Date(now.getFullYear(), now.getMonth(), 1),
          },
        }),
        'getOrCreateUsageCounter.reset'
      );
    }

    return existing;
  }

  // Create new counter
  return withDbRetry(
    () => prisma.usageCounter.create({
      data: {
        userId,
        cycleStartDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      },
    }),
    'getOrCreateUsageCounter.create'
  );
}

/**
 * Increment usage counter for a specific feature
 */
export async function incrementUsage(
  userId: number,
  feature: 'textSummaries' | 'voiceSummaries' | 'voiceEvents' | 'reminders'
): Promise<UsageCounter> {
  // Ensure counter exists
  await getOrCreateUsageCounter(userId);

  const fieldMap = {
    textSummaries: 'textSummariesUsed',
    voiceSummaries: 'voiceSummariesUsed',
    voiceEvents: 'voiceEventsCreated',
    reminders: 'remindersTriggered',
  } as const;

  const field = fieldMap[feature];

  return withDbRetry(
    () => prisma.usageCounter.update({
      where: { userId },
      data: {
        [field]: { increment: 1 },
      },
    }),
    'incrementUsage'
  );
}

// ============================================
// FEATURE ACCESS CHECKS
// ============================================

/**
 * Check if a user has access to a specific feature
 */
export async function checkFeatureAccess(
  userId: number,
  feature: FeatureType
): Promise<FeatureAccessResult> {
  const subWithUsage = await getSubscriptionWithUsage(userId);
  if (!subWithUsage) {
    return { allowed: false, reason: 'upgrade_required' };
  }

  const { subscription, usage, effectivePlan } = subWithUsage;
  const limits = getPlanLimits(effectivePlan);

  // Trial users get Pro access
  if (subscription.status === 'TRIALING' && new Date() < subscription.trialEndsAt) {
    return { allowed: true };
  }

  // Check feature-specific limits
  switch (feature) {
    case 'text_summary': {
      if (limits.textSummaries === Infinity) {
        return { allowed: true };
      }
      if (usage.textSummariesUsed >= limits.textSummaries) {
        // Track blocked feature
        await trackActivity(userId, 'feature_blocked', {
          feature: 'text_summary',
          current_usage: usage.textSummariesUsed,
          limit: limits.textSummaries,
        });
        return {
          allowed: false,
          reason: 'limit_reached',
          remaining: 0,
          limit: limits.textSummaries,
          currentUsage: usage.textSummariesUsed,
        };
      }
      return {
        allowed: true,
        remaining: limits.textSummaries - usage.textSummariesUsed,
        limit: limits.textSummaries,
        currentUsage: usage.textSummariesUsed,
      };
    }

    case 'voice_summary': {
      if (limits.voiceSummaries === Infinity) {
        return { allowed: true };
      }
      if (usage.voiceSummariesUsed >= limits.voiceSummaries) {
        await trackActivity(userId, 'feature_blocked', {
          feature: 'voice_summary',
          current_usage: usage.voiceSummariesUsed,
          limit: limits.voiceSummaries,
        });
        return {
          allowed: false,
          reason: 'limit_reached',
          remaining: 0,
          limit: limits.voiceSummaries,
          currentUsage: usage.voiceSummariesUsed,
        };
      }
      return {
        allowed: true,
        remaining: limits.voiceSummaries - usage.voiceSummariesUsed,
        limit: limits.voiceSummaries,
        currentUsage: usage.voiceSummariesUsed,
      };
    }

    case 'reminders': {
      if (!limits.reminders) {
        await trackActivity(userId, 'feature_blocked', {
          feature: 'reminders',
        });
        return { allowed: false, reason: 'upgrade_required' };
      }
      return { allowed: true };
    }

    case 'voice_events': {
      if (!limits.voiceEvents) {
        await trackActivity(userId, 'feature_blocked', {
          feature: 'voice_events',
        });
        return { allowed: false, reason: 'upgrade_required' };
      }
      return { allowed: true };
    }

    case 'calendars': {
      // This is checked differently - by calendar count
      return { allowed: true };
    }

    default:
      return { allowed: true };
  }
}

/**
 * Check if user can add more calendars
 */
export async function checkCalendarLimit(
  userId: number,
  currentCalendarCount: number
): Promise<FeatureAccessResult> {
  const subWithUsage = await getSubscriptionWithUsage(userId);
  if (!subWithUsage) {
    return { allowed: false, reason: 'upgrade_required' };
  }

  const { effectivePlan } = subWithUsage;
  const limits = getPlanLimits(effectivePlan);

  if (limits.calendars === Infinity) {
    return { allowed: true };
  }

  if (currentCalendarCount >= limits.calendars) {
    await trackActivity(userId, 'feature_blocked', {
      feature: 'calendars',
      current_usage: currentCalendarCount,
      limit: limits.calendars,
    });
    return {
      allowed: false,
      reason: 'limit_reached',
      remaining: 0,
      limit: limits.calendars,
      currentUsage: currentCalendarCount,
    };
  }

  return {
    allowed: true,
    remaining: limits.calendars - currentCalendarCount,
    limit: limits.calendars,
    currentUsage: currentCalendarCount,
  };
}

/**
 * Get trial status for display
 */
export async function getTrialStatus(userId: number): Promise<{
  isTrialing: boolean;
  daysRemaining: number;
  trialEndsAt: Date | null;
}> {
  const subscription = await getOrCreateSubscription(userId);

  if (subscription.status !== 'TRIALING') {
    return { isTrialing: false, daysRemaining: 0, trialEndsAt: null };
  }

  const now = new Date();
  if (now >= subscription.trialEndsAt) {
    return { isTrialing: false, daysRemaining: 0, trialEndsAt: null };
  }

  const daysRemaining = Math.ceil(
    (subscription.trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
  );

  return {
    isTrialing: true,
    daysRemaining,
    trialEndsAt: subscription.trialEndsAt,
  };
}

// ============================================
// PLAN INFO HELPERS
// ============================================

/**
 * Get available upgrade options for current plan
 */
export function getUpgradeOptions(currentPlan: PlanId): PlanId[] {
  const order: PlanId[] = ['FREE', 'BASIC', 'PRO'];
  const currentIndex = order.indexOf(currentPlan);
  return order.slice(currentIndex + 1);
}

/**
 * Get all plan configs for display
 */
export function getAllPlanConfigs() {
  return PLAN_CONFIGS;
}
