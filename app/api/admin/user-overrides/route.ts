/**
 * Admin User Overrides API
 * GET: List users with overrides, or get specific user's override
 * POST: Create/update override for a user
 * DELETE: Remove override (reverts to subscription-based access)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { getUserByTelegramId } from '@/src/services/user-service';
import { captureError } from '@/src/lib/error-capture';
import { getSubscriptionWithUsage } from '@/src/services/subscription-service';
import { getPlanLimits } from '@/src/config/plans';

export const dynamic = 'force-dynamic';

/**
 * Helper to verify admin access from initData
 */
async function verifyAdminAccess(initData: string | undefined): Promise<{ authorized: boolean; adminId?: number; error?: string }> {
  if (!initData) {
    return { authorized: false, error: 'Missing initData' };
  }

  // Parse initData to get user_id
  const params = new URLSearchParams(initData);
  const userJson = params.get('user');
  if (!userJson) {
    return { authorized: false, error: 'Invalid initData' };
  }

  const userData = JSON.parse(userJson);
  const userId = userData.id;

  // Verify Telegram authentication
  if (!verifyUserAccess(initData, userId)) {
    console.warn(`[user-overrides] Unauthorized access attempt for user ${userId}`);
    return { authorized: false, error: 'Unauthorized' };
  }

  // Check if user is admin
  const user = await getUserByTelegramId(userId);
  if (!user?.isAdmin) {
    console.warn(`[user-overrides] Non-admin user ${userId} attempted to access overrides`);
    return { authorized: false, error: 'Admin access required' };
  }

  return { authorized: true, adminId: user.id };
}

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

      // Get user info
      const user = await withDbRetry(
        () => prisma.user.findUnique({
          where: { id: userId },
          include: {
            subscription: true,
            featureOverride: true,
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
            currentPeriodEnd: user.subscription.currentPeriodEnd,
          } : null,
          override: user.featureOverride,
          paidFeatures,
        },
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
      unlimitedCalendars === true;

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
          reason: reason ?? null,
          grantedBy: auth.adminId,
          grantedAt: new Date(),
        },
      }),
      'user-overrides.upsert'
    );

    console.log(`[user-overrides] Admin ${auth.adminId} updated override for user ${user_id}:`, {
      unlimitedSummaries,
      remindersEnabled,
      voiceEventsEnabled,
      unlimitedCalendars,
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
