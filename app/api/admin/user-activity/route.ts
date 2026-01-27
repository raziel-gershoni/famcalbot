/**
 * Admin User Activity API
 * GET: Fetch user activity timeline for admin panel
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { getUserByTelegramId } from '@/src/services/user-service';
import { captureError } from '@/src/lib/error-capture';

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
    console.warn(`[user-activity] Unauthorized access attempt for user ${userId}`);
    return { authorized: false, error: 'Unauthorized' };
  }

  // Check if user is admin
  const user = await getUserByTelegramId(userId);
  if (!user?.isAdmin) {
    console.warn(`[user-activity] Non-admin user ${userId} attempted to access activity`);
    return { authorized: false, error: 'Admin access required' };
  }

  return { authorized: true, adminId: user.id };
}

// GET: Fetch user activity timeline
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const initData = searchParams.get('initData');
    const targetUserId = searchParams.get('user_id');
    const action = searchParams.get('action');
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');

    // Verify admin access
    const auth = await verifyAdminAccess(initData || undefined);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (targetUserId) {
      const userId = parseInt(targetUserId, 10);
      if (isNaN(userId)) {
        return NextResponse.json(
          { error: 'Invalid user_id' },
          { status: 400 }
        );
      }
      where.userId = userId;
    }

    if (action) {
      where.action = action;
    }

    // Fetch activities
    const [activities, total] = await Promise.all([
      withDbRetry(
        () => prisma.userActivity.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          include: {
            user: {
              select: {
                id: true,
                telegramId: true,
                name: true,
              },
            },
          },
        }),
        'user-activity.list'
      ),
      withDbRetry(
        () => prisma.userActivity.count({ where }),
        'user-activity.count'
      ),
    ]);

    // Get list of unique actions for filtering
    const actionStats = await withDbRetry(
      () => prisma.userActivity.groupBy({
        by: ['action'],
        _count: { action: true },
        orderBy: { _count: { action: 'desc' } },
      }),
      'user-activity.action-stats'
    );

    return NextResponse.json({
      success: true,
      activities: activities.map(activity => ({
        id: activity.id,
        userId: activity.userId,
        userName: activity.user.name,
        userTelegramId: activity.user.telegramId ? Number(activity.user.telegramId) : null,
        action: activity.action,
        metadata: activity.metadata,
        createdAt: activity.createdAt.toISOString(),
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
      actionStats: actionStats.map(stat => ({
        action: stat.action,
        count: stat._count.action,
      })),
    });
  } catch (error) {
    captureError(error, 'user-activity-get', { api_route: '/api/admin/user-activity' });
    return NextResponse.json(
      { error: 'Failed to fetch user activity' },
      { status: 500 }
    );
  }
}
