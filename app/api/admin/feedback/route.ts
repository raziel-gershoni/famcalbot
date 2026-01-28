/**
 * Admin Feedback API
 * GET: Fetch all user feedback for admin panel
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
    console.warn(`[admin-feedback] Unauthorized access attempt for user ${userId}`);
    return { authorized: false, error: 'Unauthorized' };
  }

  // Check if user is admin
  const user = await getUserByTelegramId(userId);
  if (!user?.isAdmin) {
    console.warn(`[admin-feedback] Non-admin user ${userId} attempted to access feedback`);
    return { authorized: false, error: 'Admin access required' };
  }

  return { authorized: true, adminId: user.id };
}

// GET: Fetch all feedback entries
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const initData = searchParams.get('initData');
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

    // Fetch feedback entries
    const [feedbacks, total] = await Promise.all([
      withDbRetry(
        () => prisma.userFeedback.findMany({
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
        'admin-feedback.list'
      ),
      withDbRetry(
        () => prisma.userFeedback.count(),
        'admin-feedback.count'
      ),
    ]);

    return NextResponse.json({
      success: true,
      feedbacks: feedbacks.map(feedback => ({
        id: feedback.id,
        userId: feedback.userId,
        userName: feedback.user.name,
        userTelegramId: feedback.user.telegramId ? Number(feedback.user.telegramId) : null,
        text: feedback.text,
        source: feedback.source,
        createdAt: feedback.createdAt.toISOString(),
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    captureError(error, 'admin-feedback-get', { api_route: '/api/admin/feedback' });
    return NextResponse.json(
      { error: 'Failed to fetch feedback' },
      { status: 500 }
    );
  }
}
