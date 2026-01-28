/**
 * User Feedback API
 * POST: Submit feedback from dashboard
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { getUserByTelegramId } from '@/src/services/user-service';
import { notifyAdminFeedback } from '@/src/utils/error-notifier';
import { trackActivityAsync } from '@/src/services/analytics-service';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, initData } = body;

    // Validate initData presence
    if (!initData) {
      return NextResponse.json(
        { success: false, error: 'Missing initData' },
        { status: 401 }
      );
    }

    // Parse initData to get user_id
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    if (!userJson) {
      return NextResponse.json(
        { success: false, error: 'Invalid initData' },
        { status: 401 }
      );
    }

    const userData = JSON.parse(userJson);
    const telegramUserId = userData.id;

    // Verify Telegram authentication
    if (!verifyUserAccess(initData, telegramUserId)) {
      console.warn(`[feedback] Unauthorized access attempt for user ${telegramUserId}`);
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get user from database
    const user = await getUserByTelegramId(telegramUserId);
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // Validate feedback text
    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Feedback text is required' },
        { status: 400 }
      );
    }

    const trimmedText = text.trim();

    // Check length constraints
    if (trimmedText.length < 10) {
      return NextResponse.json(
        { success: false, error: 'tooShort' },
        { status: 400 }
      );
    }

    if (trimmedText.length > 1000) {
      return NextResponse.json(
        { success: false, error: 'tooLong' },
        { status: 400 }
      );
    }

    // Check rate limit - max 3 feedback submissions per 24 hours
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);

    const recentFeedbackCount = await withDbRetry(
      () => prisma.userFeedback.count({
        where: {
          userId: user.id,
          createdAt: { gte: oneDayAgo }
        }
      }),
      'feedback.rate-limit-check'
    );

    if (recentFeedbackCount >= 3) {
      return NextResponse.json(
        { success: false, error: 'rateLimit' },
        { status: 429 }
      );
    }

    // Store feedback in database
    await withDbRetry(
      () => prisma.userFeedback.create({
        data: {
          userId: user.id,
          text: trimmedText,
          source: 'dashboard'
        }
      }),
      'feedback.create'
    );

    // Notify admin via Telegram
    await notifyAdminFeedback(user.name, user.telegramId, trimmedText, 'dashboard');

    // Track activity
    trackActivityAsync(user.id, 'feedback_submitted', {
      source: 'dashboard',
      text_length: trimmedText.length
    });

    console.log(`[feedback] User ${telegramUserId} submitted feedback via dashboard (${trimmedText.length} chars)`);

    return NextResponse.json({ success: true });
  } catch (error) {
    captureError(error, 'feedback-api', { api_route: '/api/feedback' });
    return NextResponse.json(
      { success: false, error: 'Failed to submit feedback' },
      { status: 500 }
    );
  }
}
