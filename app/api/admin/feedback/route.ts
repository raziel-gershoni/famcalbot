/**
 * Admin Feedback API
 * GET: Fetch all user feedback for admin panel
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

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
      prisma.userFeedback.findMany({
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
      prisma.userFeedback.count(),
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
