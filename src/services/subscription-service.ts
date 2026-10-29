/**
 * Subscription Service
 * Manages user subscriptions, trials, and feature access
 */

import { Prisma, Subscription, SubscriptionPlan, SubscriptionStatus, UsageCounter, UserFeatureOverride } from '@prisma/client';
import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { PlanId, getPlanLimits, TRIAL_DURATION_DAYS, PLAN_CONFIGS } from '../config/plans';
import { trackActivity } from './analytics-service';
import { getEarlyAdoptionMode } from './reminder-cache';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';
import { liveGoogleChoices } from '../lib/google-state';
import { isPaused } from './zmanim/pause';
import { holdsPaidPlan } from '../lib/comp-eligibility';
import { TIMEZONE } from '../config/constants';
import { instantToWallTime, instantToWallTimeMs, wallTimeToInstant } from '../utils/wall-time';

// ============================================
// REDIS CACHE FOR FEATURE ACCESS
// ============================================

const FEATURE_ACCESS_CACHE_TTL = 86400; // 24 hours (invalidated on subscription change)

// ============================================
// TYPES
// ============================================

export type FeatureType = 'text_summary' | 'voice_summary' | 'reminders' | 'voice_events' | 'calendars' | 'google_sync';

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
 * When a month that starts at `from` ends: one calendar month later at the same wall time on `timeZone`'s clock (the
 * person's zone for a paid month). The day is kept, or is the next month's last when that month is shorter (31 October
 * → 30 November, 31 January → 28 or 29 February). The wall time becomes an instant only through wallTimeToInstant
 * (CLAUDE.md), so a time the clocks skip that day moves forward by the jump, and the server's own zone changes nothing.
 */
export function getSubscriptionEndDate(from: Date, timeZone: string): Date {
  const wall = instantToWallTimeMs(from, timeZone); // yyyy-MM-ddTHH:mm:ss.SSS
  const [year, month, day] = [Number(wall.slice(0, 4)), Number(wall.slice(5, 7)), Number(wall.slice(8, 10))];
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  // Day 0 of the month after next, in UTC: the next month's last day (a calendar count, no clock involved)
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return wallTimeToInstant(`${pad(nextYear, 4)}-${pad(nextMonth)}-${pad(Math.min(day, lastDay))}T${wall.slice(11)}`, timeZone);
}

/**
 * The usage counters' months (getOrCreateUsageCounter) are counted on Israel's clock: a counter is read on every feature
 * check, which looks up no one's zone. A paid month (upgrade, renew) is counted on the person's own.
 */
const USAGE_ZONE = TIMEZONE;

/** What a payment did: the subscription after it, and whether this call credited it (false: that charge was already). */
export interface PaymentCredit {
  subscription: Subscription;
  credited: boolean;
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
  const existing = await prisma.subscription.findUnique({
    where: { userId },
  });

  if (existing) {
    return existing;
  }

  // Create new subscription with trial
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

  try {
    const subscription = await prisma.subscription.create({
      data: {
        userId,
        plan: 'FREE',
        status: 'TRIALING',
        trialStartedAt: now,
        trialEndsAt,
      },
    });

    // Track trial start
    await trackActivity(userId, 'subscription_started', {
      plan: 'FREE',
      is_trial: true,
    });

    console.log(`[Subscription] Created trial subscription for user ${userId}, ends ${trialEndsAt.toISOString()}`);

    return subscription;
  } catch (error) {
    // Race condition: another concurrent request created the subscription first
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.subscription.findUnique({ where: { userId } });
      if (existing) return existing;
    }
    throw error;
  }
}

/**
 * Get subscription by user ID
 */
export async function getSubscription(userId: number): Promise<Subscription | null> {
  return prisma.subscription.findUnique({
    where: { userId },
  });
}

/**
 * Get subscription with usage data
 */
export async function getSubscriptionWithUsage(userId: number, isEarlyAdopter?: boolean): Promise<SubscriptionWithUsage | null> {
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

  // Early adopters get PRO access (use pre-computed value if available)
  const earlyAdopter = isEarlyAdopter ?? await checkEarlyAdopterAccess(userId);
  if (earlyAdopter) {
    effectivePlan = 'PRO';
  }

  return {
    subscription,
    usage,
    effectivePlan,
  };
}

/**
 * Writes a payment's month to the subscription once per charge: the row is updated only while it doesn't hold
 * `chargeId` yet, in one statement. Postgres reads that condition again under the row's lock, so two deliveries of the
 * same charge (Telegram sending the update again, even at the same time) can't both match. False when the charge was
 * already credited; throws when the row is missing.
 */
async function creditCharge(userId: number, chargeId: string, data: Prisma.SubscriptionUpdateManyMutationInput): Promise<boolean> {
  const { count } = await prisma.subscription.updateMany({
    where: { userId, OR: [{ telegramPaymentChargeId: null }, { telegramPaymentChargeId: { not: chargeId } }] },
    data: { ...data, telegramPaymentChargeId: chargeId },
  });
  if (count > 0) return true;
  const current = await prisma.subscription.findUnique({ where: { userId } });
  if (current?.telegramPaymentChargeId === chargeId) {
    console.log(`[Subscription] Charge ${chargeId} was already credited to user ${userId}: nothing changes`);
    return false;
  }
  throw new Error(`The subscription of user ${userId} did not take charge ${chargeId}`);
}

/** A paid month's fields: from now to one calendar month on, on the person's clock (getSubscriptionEndDate). */
function paidMonth(now: Date, timeZone: string) {
  return {
    status: 'ACTIVE' as const,
    currentPeriodStart: now,
    currentPeriodEnd: getSubscriptionEndDate(now, timeZone),
    cancelAtPeriodEnd: false,
    // A payment ends a comp. Leaving these set would make the paid period
    // invisible to expireSubscriptions() (which skips compedBy != null) and
    // would let the admin Revoke button downgrade a genuinely paying customer.
    compedBy: null,
    compedAt: null,
    compReason: null,
  };
}

/** A new paid month resets the usage counters. */
async function resetUsage(userId: number, now: Date): Promise<void> {
  await prisma.usageCounter.upsert({
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
  });
}

/**
 * Upgrade subscription to a new plan, once per charge (a repeated delivery credits nothing). The month runs until the
 * same wall time one calendar month later in `timeZone`, the person's zone.
 */
export async function upgradeSubscription(
  userId: number,
  newPlan: PlanId,
  telegramPaymentChargeId: string,
  timeZone: string
): Promise<PaymentCredit> {
  const existing = await getOrCreateSubscription(userId);
  const fromPlan = existing.plan;

  const now = new Date();
  const month = paidMonth(now, timeZone);
  if (!(await creditCharge(userId, telegramPaymentChargeId, { plan: newPlan, ...month }))) {
    return { subscription: await prisma.subscription.findUniqueOrThrow({ where: { userId } }), credited: false };
  }

  await resetUsage(userId, now);

  // Track upgrade
  await trackActivity(userId, 'subscription_upgraded', {
    from_plan: fromPlan,
    to_plan: newPlan,
  });

  // Invalidate feature access cache so new limits take effect immediately
  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] User ${userId} upgraded from ${fromPlan} to ${newPlan}, valid until ${month.currentPeriodEnd.toISOString()} (${timeZone})`);

  return { subscription: await prisma.subscription.findUniqueOrThrow({ where: { userId } }), credited: true };
}

// ============================================
// ADMIN-GRANTED ("COMPED") SUBSCRIPTIONS
// ============================================

export type CompGrantResult =
  | { ok: true; subscription: Subscription }
  | { ok: false; code: 'ALREADY_COMPED' }
  | { ok: false; code: 'ALREADY_ACTIVE'; plan: string; status: string };

export type CompRevokeResult =
  | { ok: true }
  | { ok: false; code: 'NOT_COMPED' };

/**
 * Give a user PRO at no charge.
 *
 * Refused for a paid plan, or a cancelled one that still runs (holdsPaidPlan: they paid for that
 * time). A free trial is not paid: the gift replaces it. The row becomes PRO / ACTIVE and the
 * trial's own dates stay, so that stopping the gift can give back the trial days that are left.
 * The gift is silent, and so is stopping it.
 *
 * Deliberately does NOT reuse upgradeSubscription(): that stamps a one-month
 * currentPeriodEnd and is the payment path. A comp has no period end at all,
 * which is what keeps expireSubscriptions() away from it even if the explicit
 * compedBy guard is ever removed.
 */
export async function grantCompedSubscription(
  userId: number,
  adminId: number,
  reason?: string
): Promise<CompGrantResult> {
  const now = new Date();

  // Read directly rather than through getOrCreateSubscription(), which would
  // write a 14-day TRIALING row for a brand-new user that this grant replaces
  // at once (and that revoke would then give back as trial days).
  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (existing?.compedBy != null) {
    return { ok: false, code: 'ALREADY_COMPED' };
  }
  if (existing && holdsPaidPlan(existing, now)) {
    return { ok: false, code: 'ALREADY_ACTIVE', plan: existing.plan, status: existing.status };
  }

  const compFields = {
    plan: 'PRO' as SubscriptionPlan,
    status: 'ACTIVE' as SubscriptionStatus,
    currentPeriodStart: now,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    compedBy: adminId,
    compedAt: now,
    compReason: reason ?? null,
  };

  const subscription = existing
    ? await prisma.subscription.update({ where: { userId }, data: compFields })
    : await prisma.subscription.create({
        // trialEndsAt has no default in the schema and must be supplied. There is
        // no trial to give - this user is going straight to PRO.
        data: { userId, trialStartedAt: now, trialEndsAt: now, ...compFields },
      });

  // Match upgradeSubscription: a new period starts with a clean slate.
  await prisma.usageCounter.upsert({
    where: { userId },
    update: {
      textSummariesUsed: 0,
      voiceSummariesUsed: 0,
      voiceEventsCreated: 0,
      remindersTriggered: 0,
      cycleStartDate: now,
    },
    create: { userId, cycleStartDate: now },
  });

  await trackActivity(userId, 'admin_granted_premium', {
    admin_id: adminId,
    reason: reason ?? null,
    to_plan: 'PRO',
  });

  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] Admin ${adminId} comped PRO for user ${userId}${reason ? ` (${reason})` : ''}`);

  return { ok: true, subscription };
}

/**
 * Take a comped PRO back.
 *
 * Refuses anything that is not a comp, so a real paying customer can never be
 * downgraded through this path. A person whose trial the gift replaced gets the trial days that
 * are left back (TRIALING, trialEndsAt ahead); otherwise FREE / EXPIRED. A gift made from no row
 * or over an expired person has a trial end at or before the grant (the create sets it to the
 * moment of the grant), so it ends as EXPIRED.
 */
export async function revokeCompedSubscription(
  userId: number,
  adminId: number
): Promise<CompRevokeResult> {
  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (!existing || existing.compedBy == null) {
    return { ok: false, code: 'NOT_COMPED' };
  }

  const now = new Date();
  const trialDaysLeft = existing.trialEndsAt > now;

  await prisma.subscription.update({
    where: { userId },
    data: {
      plan: 'FREE',
      status: trialDaysLeft ? 'TRIALING' : 'EXPIRED',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      compedBy: null,
      compedAt: null,
      compReason: null,
    },
  });

  // Usage counters are deliberately left alone. They were zeroed at grant time,
  // and zeroing them again would hand a revoked user a fresh free quota.

  await trackActivity(userId, 'admin_revoked_premium', { admin_id: adminId });

  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] Admin ${adminId} revoked comped PRO for user ${userId}`);

  return { ok: true };
}

export type RefundSubscriptionResult = { ok: true; plan: string } | { ok: false; code: 'NO_PAYMENT' };

/**
 * End a person's paid plan after an admin refunded their last payment at Telegram (admin-refund.ts calls this only once
 * Telegram has agreed). Their access ends the way a stopped gift's does, but always FREE / EXPIRED: the message they are
 * sent says they are back on the Free plan, so a trial the payment replaced is not given back (a gift was never paid for,
 * which is why stopping one does give the trial days back). The payment's charge id is cleared with the period, in one
 * transaction with the check that there is a real payment to end: a free gift (compedBy) is never touched here, as a
 * real payment is never touched by the comp code. Then the feature access cache is dropped and an activity row is written.
 * Usage counters are left alone, as when a gift is stopped.
 */
export async function refundSubscription(userId: number, adminId: number): Promise<RefundSubscriptionResult> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.subscription.findUnique({ where: { userId } });
    if (!existing || !existing.telegramPaymentChargeId || existing.compedBy != null) return null;
    await tx.subscription.update({
      where: { userId },
      data: {
        plan: 'FREE',
        status: 'EXPIRED',
        telegramPaymentChargeId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });
    return existing.plan;
  });
  if (result === null) return { ok: false, code: 'NO_PAYMENT' };

  await invalidateFeatureAccessCache(userId);
  await trackActivity(userId, 'subscription_refunded', { admin_id: adminId, plan: result });

  console.log(`[Subscription] Admin ${adminId} refunded the last payment of user ${userId} (${result}); they are on the Free plan`);

  return { ok: true, plan: result };
}

/**
 * Cancel subscription (will expire at period end)
 */
export async function cancelSubscription(userId: number): Promise<Subscription> {
  const existing = await getSubscription(userId);
  if (!existing) {
    throw new Error('No subscription found');
  }

  const updated = await prisma.subscription.update({
    where: { userId },
    data: {
      status: 'CANCELED',
      cancelAtPeriodEnd: true,
    },
  });

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
  const updated = await prisma.subscription.update({
    where: { userId },
    data: {
      status: 'EXPIRED',
      plan: 'FREE',
    },
  });

  await trackActivity(userId, 'subscription_expired', {
    plan: 'FREE',
    is_trial: true,
  });

  // Invalidate feature access cache
  await invalidateFeatureAccessCache(userId);

  // Send trial expired notification to user (non-blocking, skip for early adopters)
  if (!await checkEarlyAdopterAccess(userId)) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          telegramId: true, language: true,
          // The Shabbat and Yom Tov pause (isPaused): the switch, and the place and community its windows are counted at
          location: true, pauseOnShabbat: true, zmanimCommunity: true, latitude: true, longitude: true, elevationM: true,
        },
      });
      // Shabbat and Yom Tov (the pause): the trial ends all the same, but the notice is not sent (it is sent once, by
      // whichever plan check first finds the trial over, so no later check would tell the person).
      if (user && user.telegramId && !(await isPaused({ ...user, id: userId }, new Date(), 'trial-expired notice'))) {
        const { sendTrialExpiredNotification } = await import('./telegram');
        await sendTrialExpiredNotification(Number(user.telegramId), user.language || 'en');
      }
    } catch (error) {
      console.error(`[Subscription] Failed to send trial expired notification for user ${userId}:`, error);
      captureError(error, 'subscription-trial-expired-notify', { user_id: userId }, 'warning');
    }
  }

  console.log(`[Subscription] Trial expired for user ${userId}`);

  return updated;
}

/**
 * Renew subscription (called on successful manual payment), once per charge (a repeated delivery credits nothing). The
 * month runs until the same wall time one calendar month later in `timeZone`, the person's zone.
 */
export async function renewSubscription(
  userId: number,
  telegramPaymentChargeId: string,
  timeZone: string
): Promise<PaymentCredit> {
  const existing = await getSubscription(userId);
  if (!existing) {
    throw new Error('No subscription found');
  }

  const now = new Date();
  const month = paidMonth(now, timeZone);
  if (!(await creditCharge(userId, telegramPaymentChargeId, month))) {
    return { subscription: await prisma.subscription.findUniqueOrThrow({ where: { userId } }), credited: false };
  }

  await resetUsage(userId, now);

  await trackActivity(userId, 'subscription_renewed', {
    plan: existing.plan,
  });

  // Invalidate feature access cache
  await invalidateFeatureAccessCache(userId);

  console.log(`[Subscription] Subscription renewed for user ${userId}, valid until ${month.currentPeriodEnd.toISOString()} (${timeZone})`);

  return { subscription: await prisma.subscription.findUniqueOrThrow({ where: { userId } }), credited: true };
}

// ============================================
// USAGE TRACKING
// ============================================

/**
 * Get or create usage counter for a user
 */
export async function getOrCreateUsageCounter(userId: number): Promise<UsageCounter> {
  const existing = await prisma.usageCounter.findUnique({
    where: { userId },
  });

  if (existing) {
    const cycleStart = existing.cycleStartDate;
    const now = new Date();
    const cycleEnd = getSubscriptionEndDate(cycleStart, USAGE_ZONE);

    if (now >= cycleEnd) {
      // Walk forward to find the latest valid cycle start
      let newCycleStart = cycleEnd;
      while (getSubscriptionEndDate(newCycleStart, USAGE_ZONE) <= now) {
        newCycleStart = getSubscriptionEndDate(newCycleStart, USAGE_ZONE);
      }

      return prisma.usageCounter.update({
        where: { userId },
        data: {
          textSummariesUsed: 0,
          voiceSummariesUsed: 0,
          voiceEventsCreated: 0,
          remindersTriggered: 0,
          cycleStartDate: newCycleStart,
        },
      });
    }

    return existing;
  }

  // Create new counter: its first month starts on the 1st of this month at 00:00 on Israel's clock
  const thisMonth = instantToWallTime(new Date(), USAGE_ZONE).slice(0, 7);
  return prisma.usageCounter.create({
    data: {
      userId,
      cycleStartDate: wallTimeToInstant(`${thisMonth}-01T00:00`, USAGE_ZONE),
    },
  });
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

  return prisma.usageCounter.update({
    where: { userId },
    data: {
      [field]: { increment: 1 },
    },
  });
}

// ============================================
// FEATURE OVERRIDE CHECKS
// ============================================

/**
 * Get feature override for a user (admin-granted access)
 */
export async function getFeatureOverride(userId: number): Promise<UserFeatureOverride | null> {
  return prisma.userFeatureOverride.findUnique({
    where: { userId },
  });
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
    // The copy to Google is on the plans reminders are on (google-sync spec §1), so the
    // admin's reminders grant gives it too.
    case 'google_sync':
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
  const features: FeatureType[] = ['text_summary', 'voice_summary', 'reminders', 'voice_events', 'calendars', 'google_sync'];
  try {
    await Promise.all([
      ...features.map(f => redis.del(REDIS_KEYS.featureAccess(userId, f))),
      redis.del(REDIS_KEYS.reminderDowngradeNotified(userId)),
    ]);
    console.log(`[Feature Access] Cache invalidated for user ${userId}`);
  } catch (error) {
    console.error('[Feature Access] Cache invalidation error:', error);
    captureError(error, 'subscription-cache-invalidate', { user_id: userId }, 'warning');
  }
}

/**
 * Invalidate all feature access caches (for global toggle changes)
 * Uses Redis SCAN to find and delete all feature:access:* and reminder:downgrade_notified:* keys
 */
export async function invalidateAllFeatureAccessCaches(): Promise<void> {
  try {
    const patterns = [`${REDIS_KEYS.FEATURE_ACCESS_PREFIX}*`, `${REDIS_KEYS.REMINDER_PREFIX}downgrade_notified:*`];
    for (const pattern of patterns) {
      let cursor = 0;
      do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
        cursor = typeof nextCursor === 'string' ? parseInt(nextCursor, 10) : nextCursor;
        if (keys.length > 0) {
          await Promise.all(keys.map(key => redis.del(key as string)));
        }
      } while (cursor !== 0);
    }
    console.log('[Feature Access] All caches invalidated');
  } catch (error) {
    console.error('[Feature Access] Bulk cache invalidation error:', error);
    captureError(error, 'subscription-cache-invalidate-all', undefined, 'warning');
  }
}

/**
 * Check if user has early adopter access (global mode or per-user flag)
 */
export async function checkEarlyAdopterAccess(userId: number): Promise<boolean> {
  const globalMode = await getEarlyAdoptionMode();
  if (globalMode) return true;
  const override = await getFeatureOverride(userId);
  return override?.earlyAdopter === true;
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
  return readFeatureAccess(userId, feature, true);
}

/**
 * The same answer as checkFeatureAccess, for a caller that only shows a hint: a miss
 * that finds the plan lacking the feature does not log feature_blocked (nothing was
 * blocked). Same cache key and value, so the two share the 24h cache.
 */
export async function peekFeatureAccess(
  userId: number,
  feature: FeatureType
): Promise<FeatureAccessResult> {
  return readFeatureAccess(userId, feature, false);
}

async function readFeatureAccess(
  userId: number,
  feature: FeatureType,
  track: boolean
): Promise<FeatureAccessResult> {
  const cacheKey = REDIS_KEYS.featureAccess(userId, feature);

  // 1. Check Redis cache first
  try {
    const cached = await redis.get<FeatureAccessResult>(cacheKey);
    if (cached !== null) {
      return cached;
    }
  } catch (error) {
    // Cache miss or error - continue to compute
    console.error('[Feature Access] Cache read error:', error);
    captureError(error, 'subscription-cache-read', { user_id: userId, feature }, 'warning');
  }

  // 2. Compute feature access (existing logic)
  const result = await computeFeatureAccess(userId, feature, track);

  // 3. Cache the result (fire and forget). A quiet read leaves the cache alone: a cached
  // answer is never logged, so a hint cached here would hide the next real block's
  // feature_blocked for a day.
  if (!track) return result;
  redis.set(cacheKey, result, { ex: FEATURE_ACCESS_CACHE_TTL }).catch(error => {
    console.error('[Feature Access] Cache write error:', error);
    captureError(error, 'subscription-cache-write', { user_id: userId, feature }, 'warning');
  });

  return result;
}

/**
 * Internal function to compute feature access without caching
 * Checks admin overrides FIRST (highest priority), then subscription
 */
async function computeFeatureAccess(
  userId: number,
  feature: FeatureType,
  track = true
): Promise<FeatureAccessResult> {
  // 0. Check early adopter access (global mode or per-user flag)
  const isEarlyAdopter = await checkEarlyAdopterAccess(userId);
  if (isEarlyAdopter) return { allowed: true };

  // 1. Check admin override FIRST (can only GRANT access, never deny)
  const override = await getFeatureOverride(userId);
  if (override) {
    const granted = checkOverrideGrant(override, feature);
    if (granted) {
      return { allowed: true }; // Admin granted access
    }
  }

  // 2. Check subscription (pass pre-computed early-adopter to avoid redundant lookup)
  const subWithUsage = await getSubscriptionWithUsage(userId, isEarlyAdopter);
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
        if (track) {
          await trackActivity(userId, 'feature_blocked', {
            feature: 'text_summary',
            current_usage: usage.textSummariesUsed,
            limit: limits.textSummaries,
          });
        }
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
        if (track) {
          await trackActivity(userId, 'feature_blocked', {
            feature: 'voice_summary',
            current_usage: usage.voiceSummariesUsed,
            limit: limits.voiceSummaries,
          });
        }
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
        if (track) {
          await trackActivity(userId, 'feature_blocked', {
            feature: 'reminders',
          });
        }
        return { allowed: false, reason: 'upgrade_required' };
      }
      return { allowed: true };
    }

    case 'google_sync': {
      if (!limits.googleSync) {
        if (track) {
          await trackActivity(userId, 'feature_blocked', {
            feature: 'google_sync',
          });
        }
        return { allowed: false, reason: 'upgrade_required' };
      }
      return { allowed: true };
    }

    case 'voice_events': {
      if (!limits.voiceEvents) {
        if (track) {
          await trackActivity(userId, 'feature_blocked', {
            feature: 'voice_events',
          });
        }
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
 * The shared calendar total ("Google as a connection" spec §4): the user's own FamCal
 * calendars plus their Google choices, the FamCal main not counted once Google calendars
 * are chosen (it is made for everyone, lazily).
 */
export function calendarTotal(ownFamcal: number, google: number): number {
  return ownFamcal + google - (google > 0 && ownFamcal > 0 ? 1 : 0);
}

/** The user's own live FamCal calendars and Google choices that count (liveGoogleChoices), as stored now. */
export async function countCalendars(userId: number): Promise<{ famcal: number; google: number }> {
  const [famcal, user] = await Promise.all([
    prisma.nativeCalendar.count({ where: { ownerUserId: userId, isDeleted: false } }),
    prisma.user.findUnique({ where: { id: userId }, select: { googleRefreshToken: true, calendarSource: true, calendarAssignments: true } }),
  ]);
  const google = user ? liveGoogleChoices(user).length : 0;
  return { famcal, google };
}

/**
 * Whether a save may leave the user with `afterSaveTotal` calendars (calendarTotal after
 * the save). Admin overrides first, then the subscription. Blocked only when the total
 * is above the plan's limit AND the save raises the user's current total, so a setup
 * already over the limit (made before the shared total, or before a downgrade) keeps
 * working: renames, label toggles and removals always save.
 */
export async function checkCalendarLimit(
  userId: number,
  afterSaveTotal: number
): Promise<FeatureAccessResult> {
  // 0. Check early adopter access (global mode or per-user flag)
  if (await checkEarlyAdopterAccess(userId)) return { allowed: true };

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

  const counts = await countCalendars(userId);
  const currentTotal = calendarTotal(counts.famcal, counts.google);
  if (afterSaveTotal > limits.calendars && afterSaveTotal > currentTotal) {
    await trackActivity(userId, 'feature_blocked', {
      feature: 'calendars',
      current_usage: afterSaveTotal,
      limit: limits.calendars,
    });
    return {
      allowed: false,
      reason: 'limit_reached',
      remaining: 0,
      limit: limits.calendars,
      currentUsage: currentTotal,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, limits.calendars - afterSaveTotal),
    limit: limits.calendars,
    currentUsage: afterSaveTotal,
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
