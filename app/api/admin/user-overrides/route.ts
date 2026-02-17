/**
 * Admin User Overrides API
 * GET: List users with overrides, or get specific user's override
 * POST: Create/update override for a user
 * DELETE: Remove override (reverts to subscription-based access)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { getSubscriptionWithUsage, invalidateFeatureAccessCache } from '@/src/services/subscription-service';
import { getPlanLimits } from '@/src/config/plans';

export const dynamic = 'force-dynamic';

/**
 * Check which features are legitimately paid (cannot be disabled by admin)
 */
async function getPaidFeatures(userId: number): Promise<{
  unlimitedSummaries: boolean;
  remindersEnabled: boolean;
  voiceEventsEnabled: boolean;
  unlimitedCalendars: boolean;
}> {
  const subWithUsage = await getSubscriptionWithUsage(userId);
  if (!subWithUsage) {
    return {
      unlimitedSummaries: false,
      remindersEnabled: false,
      voiceEventsEnabled: false,
      unlimitedCalendars: false,
    };
  }

  const { subscription, effectivePlan } = subWithUsage;

  // During active trial, consider features as not "paid" (can be removed after trial)
  if (subscription.status === 'TRIALING') {
    return {
      unlimitedSummaries: false,
      remindersEnabled: false,
      voiceEventsEnabled: false,
      unlimitedCalendars: false,
    };
  }

  // Only ACTIVE paid subscriptions are protected
  if (subscription.status !== 'ACTIVE') {
    return {
      unlimitedSummaries: false,
      remindersEnabled: false,
      voiceEventsEnabled: false,
      unlimitedCalendars: false,
    };
  }

  const limits = getPlanLimits(effectivePlan);

  return {
    unlimitedSummaries: limits.textSummaries === Infinity,
    remindersEnabled: limits.reminders,
    voiceEventsEnabled: limits.voiceEvents,
    unlimitedCalendars: limits.calendars === Infinity,
  };
}

/**
 * Calculate remaining trial days from a trial end date
 */
function calculateTrialDaysRemaining(trialEndsAt: Date): number | null {
  const now = new Date();
  if (now >= trialEndsAt) return null;
  return Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Map a user record (with subscription, override, usage) to a response object
 */
function mapUserToResponse(user: {
  id: number;
  telegramId: bigint | null;
  name: string;
  subscription: { plan: string; status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null } | null;
  featureOverride: { earlyAdopter: boolean } | null;
  usageCounter: { textSummariesUsed: number; voiceSummariesUsed: number; voiceEventsCreated: number } | null;
  calendarAssignments: unknown;
}) {
  const trialDaysRemaining = user.subscription?.status === 'TRIALING' && user.subscription?.trialEndsAt
    ? calculateTrialDaysRemaining(user.subscription.trialEndsAt)
    : null;
  const calendarAssignments = user.calendarAssignments as Array<{ calendarId: string }> | null;
  const calendarsCount = calendarAssignments?.length ?? 0;

  return {
    id: user.id,
    telegramId: user.telegramId ? Number(user.telegramId) : null,
    name: user.name,
    subscription: user.subscription ? {
      plan: user.subscription.plan,
      status: user.subscription.status,
      trialEndsAt: user.subscription.trialEndsAt,
      trialDaysRemaining,
      currentPeriodEnd: user.subscription.currentPeriodEnd,
    } : null,
    usage: user.usageCounter ? {
      textSummariesUsed: user.usageCounter.textSummariesUsed,
      voiceSummariesUsed: user.usageCounter.voiceSummariesUsed,
      voiceEventsCreated: user.usageCounter.voiceEventsCreated,
    } : null,
    calendarsCount,
    hasOverride: !!user.featureOverride,
    earlyAdopter: user.featureOverride?.earlyAdopter === true,
  };
}

// GET: List users with overrides, or get specific user's override
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const initData = searchParams.get('initData');
    const targetUserId = searchParams.get('user_id');
    const searchQuery = searchParams.get('search');

    // Verify admin access
    const auth = await verifyAdminAccess(initData || undefined);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    // If specific user requested
    if (targetUserId) {
      const userId = parseInt(targetUserId, 10);
      if (isNaN(userId)) {
        return NextResponse.json(
          { error: 'Invalid user_id' },
          { status: 400 }
        );
      }

      // Get user info with usage
      const user = await withDbRetry(
        () => prisma.user.findUnique({
          where: { id: userId },
          include: {
            subscription: true,
            featureOverride: true,
            usageCounter: true,
          },
        }),
        'user-overrides.get-user'
      );

      if (!user) {
        return NextResponse.json(
          { error: 'User not found' },
          { status: 404 }
        );
      }

      // Get paid features (protected from being disabled)
      const paidFeatures = await getPaidFeatures(userId);

      // Calculate trial days remaining
      const trialDaysRemaining = user.subscription?.status === 'TRIALING' && user.subscription?.trialEndsAt
        ? calculateTrialDaysRemaining(user.subscription.trialEndsAt)
        : null;

      // Get plan limits for usage display
      const effectivePlan = user.subscription?.status === 'TRIALING' && trialDaysRemaining ? 'PRO' : (user.subscription?.plan || 'FREE');
      const limits = getPlanLimits(effectivePlan as 'FREE' | 'BASIC' | 'PRO');

      // Count calendars from calendarAssignments JSON
      const calendarAssignments = user.calendarAssignments as Array<{ calendarId: string }> | null;
      const calendarsCount = calendarAssignments?.length ?? 0;

      // Calculate registration status
      const hasOAuth = user.googleRefreshToken !== '';
      const hasCalendars = calendarsCount > 0;
      const hasLocation = user.location !== '';

      // Determine applicable reminder (first incomplete step in registration flow)
      let applicableReminder: 'oauth' | 'calendars' | 'location' | null = null;
      if (!hasOAuth) {
        applicableReminder = 'oauth';
      } else if (!hasCalendars) {
        applicableReminder = 'calendars';
      } else if (!hasLocation) {
        applicableReminder = 'location';
      }

      return NextResponse.json({
        success: true,
        user: {
          id: user.id,
          telegramId: user.telegramId ? Number(user.telegramId) : null,
          name: user.name,
          subscription: user.subscription ? {
            plan: user.subscription.plan,
            status: user.subscription.status,
            trialEndsAt: user.subscription.trialEndsAt,
            trialDaysRemaining,
            currentPeriodEnd: user.subscription.currentPeriodEnd,
          } : null,
          usage: user.usageCounter ? {
            textSummariesUsed: user.usageCounter.textSummariesUsed,
            voiceSummariesUsed: user.usageCounter.voiceSummariesUsed,
            voiceEventsCreated: user.usageCounter.voiceEventsCreated,
          } : {
            textSummariesUsed: 0,
            voiceSummariesUsed: 0,
            voiceEventsCreated: 0,
          },
          limits: {
            textSummaries: limits.textSummaries,
            voiceSummaries: limits.voiceSummaries,
            calendars: limits.calendars,
          },
          calendarsCount,
          override: user.featureOverride,
          paidFeatures,
          registrationStatus: {
            hasOAuth,
            hasCalendars,
            hasLocation,
            applicableReminder,
          },
        },
      });
    }

    // List all users (for admin user list view)
    const listAll = searchParams.get('list');
    if (listAll === 'all') {
      const users = await withDbRetry(
        () => prisma.user.findMany({
          include: {
            subscription: true,
            featureOverride: true,
            usageCounter: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        'user-overrides.list-all'
      );

      return NextResponse.json({
        success: true,
        users: users.map(mapUserToResponse),
      });
    }

    // Search for users by telegram ID or name
    if (searchQuery) {
      const telegramId = parseInt(searchQuery, 10);
      const isNumber = !isNaN(telegramId);

      const users = await withDbRetry(
        () => prisma.user.findMany({
          where: {
            OR: [
              ...(isNumber ? [{ telegramId: BigInt(telegramId) }] : []),
              { name: { contains: searchQuery, mode: 'insensitive' as const } },
            ],
          },
          include: {
            subscription: true,
            featureOverride: true,
          },
          take: 10,
        }),
        'user-overrides.search'
      );

      return NextResponse.json({
        success: true,
        users: users.map(user => ({
          id: user.id,
          telegramId: user.telegramId ? Number(user.telegramId) : null,
          name: user.name,
          subscription: user.subscription ? {
            plan: user.subscription.plan,
            status: user.subscription.status,
          } : null,
          hasOverride: !!user.featureOverride,
        })),
      });
    }

    // List all users with overrides
    const overrides = await withDbRetry(
      () => prisma.userFeatureOverride.findMany({
        include: {
          user: {
            select: {
              id: true,
              telegramId: true,
              name: true,
              subscription: {
                select: {
                  plan: true,
                  status: true,
                },
              },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      'user-overrides.list'
    );

    return NextResponse.json({
      success: true,
      overrides: overrides.map(override => ({
        id: override.id,
        userId: override.userId,
        user: {
          id: override.user.id,
          telegramId: override.user.telegramId ? Number(override.user.telegramId) : null,
          name: override.user.name,
          subscription: override.user.subscription,
        },
        unlimitedSummaries: override.unlimitedSummaries,
        remindersEnabled: override.remindersEnabled,
        voiceEventsEnabled: override.voiceEventsEnabled,
        unlimitedCalendars: override.unlimitedCalendars,
        reason: override.reason,
        grantedAt: override.grantedAt,
        grantedBy: override.grantedBy,
      })),
    });
  } catch (error) {
    captureError(error, 'user-overrides-get', { api_route: '/api/admin/user-overrides' });
    return NextResponse.json(
      { error: 'Failed to fetch user overrides' },
      { status: 500 }
    );
  }
}

// POST: Create/update override for a user
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      initData,
      user_id,
      unlimitedSummaries,
      remindersEnabled,
      voiceEventsEnabled,
      unlimitedCalendars,
      earlyAdopter,
      reason,
    } = body;

    // Verify admin access
    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    // Validate user_id
    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json(
        { error: 'user_id is required and must be a number' },
        { status: 400 }
      );
    }

    // Check if user exists
    const user = await withDbRetry(
      () => prisma.user.findUnique({
        where: { id: user_id },
      }),
      'user-overrides.check-user'
    );

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Check which features are all false/null (no override needed)
    const hasAnyOverride =
      unlimitedSummaries === true ||
      remindersEnabled === true ||
      voiceEventsEnabled === true ||
      unlimitedCalendars === true ||
      earlyAdopter === true;

    if (!hasAnyOverride) {
      // If no overrides, delete existing override instead
      await withDbRetry(
        () => prisma.userFeatureOverride.deleteMany({
          where: { userId: user_id },
        }),
        'user-overrides.delete-empty'
      );

      console.log(`[user-overrides] Admin ${auth.adminId} removed override for user ${user_id}`);

      return NextResponse.json({
        success: true,
        message: 'Override removed (no features enabled)',
        override: null,
      });
    }

    // Upsert the override
    const override = await withDbRetry(
      () => prisma.userFeatureOverride.upsert({
        where: { userId: user_id },
        update: {
          unlimitedSummaries: unlimitedSummaries ?? null,
          remindersEnabled: remindersEnabled ?? null,
          voiceEventsEnabled: voiceEventsEnabled ?? null,
          unlimitedCalendars: unlimitedCalendars ?? null,
          earlyAdopter: earlyAdopter === true,
          reason: reason ?? null,
          grantedBy: auth.adminId,
          grantedAt: new Date(),
        },
        create: {
          userId: user_id,
          unlimitedSummaries: unlimitedSummaries ?? null,
          remindersEnabled: remindersEnabled ?? null,
          voiceEventsEnabled: voiceEventsEnabled ?? null,
          unlimitedCalendars: unlimitedCalendars ?? null,
          earlyAdopter: earlyAdopter === true,
          reason: reason ?? null,
          grantedBy: auth.adminId,
          grantedAt: new Date(),
        },
      }),
      'user-overrides.upsert'
    );

    // Invalidate feature access cache for the user
    await invalidateFeatureAccessCache(user_id);

    console.log(`[user-overrides] Admin ${auth.adminId} updated override for user ${user_id}:`, {
      unlimitedSummaries,
      remindersEnabled,
      voiceEventsEnabled,
      unlimitedCalendars,
      earlyAdopter,
      reason,
    });

    return NextResponse.json({
      success: true,
      override,
    });
  } catch (error) {
    captureError(error, 'user-overrides-post', { api_route: '/api/admin/user-overrides' });
    return NextResponse.json(
      { error: 'Failed to update user override' },
      { status: 500 }
    );
  }
}

// DELETE: Remove override for a user
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const initData = searchParams.get('initData');
    const targetUserId = searchParams.get('user_id');

    // Verify admin access
    const auth = await verifyAdminAccess(initData || undefined);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    // Validate user_id
    if (!targetUserId) {
      return NextResponse.json(
        { error: 'user_id is required' },
        { status: 400 }
      );
    }

    const userId = parseInt(targetUserId, 10);
    if (isNaN(userId)) {
      return NextResponse.json(
        { error: 'Invalid user_id' },
        { status: 400 }
      );
    }

    // Delete the override
    const result = await withDbRetry(
      () => prisma.userFeatureOverride.deleteMany({
        where: { userId },
      }),
      'user-overrides.delete'
    );

    if (result.count === 0) {
      return NextResponse.json(
        { error: 'No override found for this user' },
        { status: 404 }
      );
    }

    console.log(`[user-overrides] Admin ${auth.adminId} deleted override for user ${userId}`);

    return NextResponse.json({
      success: true,
      message: 'Override deleted successfully',
    });
  } catch (error) {
    captureError(error, 'user-overrides-delete', { api_route: '/api/admin/user-overrides' });
    return NextResponse.json(
      { error: 'Failed to delete user override' },
      { status: 500 }
    );
  }
}
