/**
 * User Feedback API
 * POST: Submit feedback from dashboard
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { verifyUserAccess, extractUserId } from '@/src/lib/telegram-auth';
import { getUserByTelegramId } from '@/src/services/user-service';
import { notifyAdminFeedback } from '@/src/utils/error-notifier';
import { trackActivityAsync } from '@/src/services/analytics-service';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

const FEEDBACK_CONFIG = {
  minLength: 10,
  maxLength: 1000,
  rateLimitCount: 3,
  rateLimitHours: 24,
} as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, initData } = body;

    // Validate initData and extract user ID
    if (!initData) {
      return NextResponse.json(
        { success: false, error: 'Missing initData' },
        { status: 401 }
      );
    }

    const telegramUserId = extractUserId(initData);
    if (telegramUserId === null) {
      return NextResponse.json(
        { success: false, error: 'Invalid initData' },
        { status: 401 }
      );
    }

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
    if (trimmedText.length < FEEDBACK_CONFIG.minLength) {
      return NextResponse.json(
        { success: false, error: 'tooShort' },
        { status: 400 }
      );
    }

    if (trimmedText.length > FEEDBACK_CONFIG.maxLength) {
      return NextResponse.json(
        { success: false, error: 'tooLong' },
        { status: 400 }
      );
    }

    // Check rate limit
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - FEEDBACK_CONFIG.rateLimitHours);

    const recentFeedbackCount = await withDbRetry(
      () => prisma.userFeedback.count({
        where: {
          userId: user.id,
          createdAt: { gte: oneDayAgo }
        }
      }),
      'feedback.rate-limit-check'
    );

    if (recentFeedbackCount >= FEEDBACK_CONFIG.rateLimitCount) {
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
