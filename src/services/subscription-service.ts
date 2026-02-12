/**
 * Subscription Service
 * Manages user subscriptions, trials, and feature access
 */

import { Subscription, SubscriptionPlan, SubscriptionStatus, UsageCounter, UserFeatureOverride } from '@prisma/client';
import { Redis } from '@upstash/redis';
import { prisma, withDbRetry } from '../utils/prisma';
import { PlanId, getPlanLimits, TRIAL_DURATION_DAYS, PLAN_CONFIGS } from '../config/plans';
import { trackActivity } from './analytics-service';

// ============================================
// REDIS CACHE FOR FEATURE ACCESS
// ============================================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const FEATURE_ACCESS_CACHE_PREFIX = 'feature:access:';
const FEATURE_ACCESS_CACHE_TTL = 86400; // 24 hours (invalidated on subscription change)

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
// BILLING HELPERS
// ============================================

/**
 * Calculate subscription end date (same day next month)
 * Handles month-length differences: Jan 31 → Feb 28, etc.
 * JS Date constructor handles year rollover (month 12 → Jan next year)
 */
export function getSubscriptionEndDate(fromDate: Date = new Date()): Date {
  const day = fromDate.getDate();
  const targetMonth = fromDate.getMonth() + 1;
  const targetYear = fromDate.getFullYear();
  // Last day of target month (handles Feb, 30-day months, year rollover)
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const resultDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(targetYear, targetMonth, resultDay);
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
 * Subscription runs until the same day next month
 */
export async function upgradeSubscription(
  userId: number,
  newPlan: PlanId,
  telegramPaymentChargeId?: string
): Promise<Subscription> {
  const existing = await getOrCreateSubscription(userId);
  const fromPlan = existing.plan;

  const now = new Date();
  const periodEnd = getSubscriptionEndDate(now);

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

  // Reset usage counters for the new billing period
  await withDbRetry(
    () => prisma.usageCounter.upsert({
      where: { userId },
      update: {
        textSummariesUsed: 0,
        voiceSummariesUsed: 0,
        voiceEventsCreated: 0,
        remindersTriggered: 0,
        cycleStartDate: now,
      },
      create: {
        userId,
        cycleStartDate: now,
      },
    }),
    'resetUsageOnUpgrade'
  );

  // Track upgrade
  await trackActivity(userId, 'subscription_upgraded', {
    from_plan: fromPlan,
    to_plan: newPlan,
  });

  // Invalidate feature access cache so new limits take effect immediately
  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] User ${userId} upgraded from ${fromPlan} to ${newPlan}, valid until ${periodEnd.toISOString()}`);

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

  // Invalidate feature access cache
  await invalidateFeatureAccessCache(userId);

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

  // Invalidate feature access cache
  await invalidateFeatureAccessCache(userId);

  // Send trial expired notification to user (non-blocking)
  try {
    const user = await withDbRetry(
      () => prisma.user.findUnique({
        where: { id: userId },
        select: { telegramId: true, language: true },
      }),
      'expireTrialSubscription.getUser'
    );
    if (user) {
      const { sendTrialExpiredNotification } = await import('./telegram');
      await sendTrialExpiredNotification(Number(user.telegramId), user.language || 'en');
    }
  } catch (error) {
    console.error(`[Subscription] Failed to send trial expired notification for user ${userId}:`, error);
  }

  console.log(`[Subscription] Trial expired for user ${userId}`);

  return updated;
}

/**
 * Renew subscription (called on successful manual payment)
 * Subscription runs until the same day next month
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
  const periodEnd = getSubscriptionEndDate(now);

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

  // Reset usage counters for the new billing period
  await withDbRetry(
    () => prisma.usageCounter.upsert({
      where: { userId },
      update: {
        textSummariesUsed: 0,
        voiceSummariesUsed: 0,
        voiceEventsCreated: 0,
        remindersTriggered: 0,
        cycleStartDate: now,
      },
      create: {
        userId,
        cycleStartDate: now,
      },
    }),
    'resetUsageOnRenewal'
  );

  await trackActivity(userId, 'subscription_renewed', {
    plan: existing.plan,
  });

  // Invalidate feature access cache
  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] Subscription renewed for user ${userId}, valid until ${periodEnd.toISOString()}`);

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
    const cycleStart = existing.cycleStartDate;
    const now = new Date();
    const cycleEnd = getSubscriptionEndDate(cycleStart);

    if (now >= cycleEnd) {
      // Walk forward to find the latest valid cycle start
      let newCycleStart = cycleEnd;
      while (getSubscriptionEndDate(newCycleStart) <= now) {
        newCycleStart = getSubscriptionEndDate(newCycleStart);
      }

      return withDbRetry(
        () => prisma.usageCounter.update({
          where: { userId },
          data: {
            textSummariesUsed: 0,
            voiceSummariesUsed: 0,
            voiceEventsCreated: 0,
            remindersTriggered: 0,
            cycleStartDate: newCycleStart,
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
// FEATURE OVERRIDE CHECKS
// ============================================

/**
 * Get feature override for a user (admin-granted access)
 */
export async function getFeatureOverride(userId: number): Promise<UserFeatureOverride | null> {
  return withDbRetry(
    () => prisma.userFeatureOverride.findUnique({
      where: { userId },
    }),
    'getFeatureOverride'
  );
}

/**
 * Check if an override grants access to a specific feature
 * Returns true if override grants access, false if no override or not granted
 */
function checkOverrideGrant(override: UserFeatureOverride, feature: FeatureType): boolean {
  switch (feature) {
    case 'text_summary':
    case 'voice_summary':
      return override.unlimitedSummaries === true;
    case 'reminders':
      return override.remindersEnabled === true;
    case 'voice_events':
      return override.voiceEventsEnabled === true;
    case 'calendars':
      return override.unlimitedCalendars === true;
    default:
      return false;
  }
}

// ============================================
// FEATURE ACCESS CACHE
// ============================================

/**
 * Invalidate feature access cache for a user
 * Call this when subscription status changes
 */
export async function invalidateFeatureAccessCache(userId: number): Promise<void> {
  const features: FeatureType[] = ['text_summary', 'voice_summary', 'reminders', 'voice_events', 'calendars'];
  try {
    await Promise.all([
      ...features.map(f => redis.del(`${FEATURE_ACCESS_CACHE_PREFIX}${userId}:${f}`)),
      redis.del(`reminder:downgrade_notified:${userId}`),
    ]);
    console.log(`[Feature Access] Cache invalidated for user ${userId}`);
  } catch (error) {
    console.error('[Feature Access] Cache invalidation error:', error);
  }
}

// ============================================
// FEATURE ACCESS CHECKS
// ============================================

/**
 * Check if a user has access to a specific feature
 * Uses Redis cache to avoid repeated DB queries
 * Checks admin overrides FIRST (highest priority), then subscription
 */
export async function checkFeatureAccess(
  userId: number,
  feature: FeatureType
): Promise<FeatureAccessResult> {
  const cacheKey = `${FEATURE_ACCESS_CACHE_PREFIX}${userId}:${feature}`;

  // 1. Check Redis cache first
  try {
    const cached = await redis.get<FeatureAccessResult>(cacheKey);
    if (cached !== null) {
      return cached;
    }
  } catch (error) {
    // Cache miss or error - continue to compute
    console.error('[Feature Access] Cache read error:', error);
  }

  // 2. Compute feature access (existing logic)
  const result = await computeFeatureAccess(userId, feature);

  // 3. Cache the result (fire and forget)
  redis.set(cacheKey, result, { ex: FEATURE_ACCESS_CACHE_TTL }).catch(error => {
    console.error('[Feature Access] Cache write error:', error);
  });

  return result;
}

/**
 * Internal function to compute feature access without caching
 * Checks admin overrides FIRST (highest priority), then subscription
 */
async function computeFeatureAccess(
  userId: number,
  feature: FeatureType
): Promise<FeatureAccessResult> {
  // 1. Check admin override FIRST (can only GRANT access, never deny)
  const override = await getFeatureOverride(userId);
  if (override) {
    const granted = checkOverrideGrant(override, feature);
    if (granted) {
      return { allowed: true }; // Admin granted access
    }
  }

  // 2. Check subscription (existing logic)
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
 * Checks admin overrides FIRST (highest priority), then subscription
 */
export async function checkCalendarLimit(
  userId: number,
  currentCalendarCount: number
): Promise<FeatureAccessResult> {
  // 1. Check admin override FIRST
  const override = await getFeatureOverride(userId);
  if (override?.unlimitedCalendars === true) {
    return { allowed: true }; // Admin granted unlimited calendars
  }

  // 2. Check subscription
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
