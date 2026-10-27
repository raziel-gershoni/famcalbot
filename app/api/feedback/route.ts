/**
 * User Feedback API
 * POST: Submit feedback from dashboard
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { generalRateLimiter } from '@/src/lib/rate-limit';
import { notifyAdminFeedback } from '@/src/utils/error-notifier';
import { trackActivityAsync } from '@/src/services/analytics-service';
import { captureError } from '@/src/lib/error-capture';
import { FEEDBACK_LIMITS } from '@/src/lib/feedback-limits';

export const dynamic = 'force-dynamic';

const FEEDBACK_CONFIG = {
  minLength: FEEDBACK_LIMITS.minLength,
  maxLength: FEEDBACK_LIMITS.maxLength,
  rateLimitCount: FEEDBACK_LIMITS.perDay,
  rateLimitHours: 24,
} as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, initData, user_id } = body;

    // Telegram initData or the WhatsApp session cookie, matched against user_id
    const auth = await verifyUserAuth(
      request,
      user_id != null ? String(user_id) : null,
      initData,
      generalRateLimiter,
      'feedback'
    );
    if (!auth.success) {
      return auth.response;
    }
    const user = auth.user;

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
    const oneDayAgo = new Date(Date.now() - FEEDBACK_CONFIG.rateLimitHours * 60 * 60 * 1000);

    const recentFeedbackCount = await prisma.userFeedback.count({
      where: {
        userId: user.id,
        createdAt: { gte: oneDayAgo }
      }
    });

    if (recentFeedbackCount >= FEEDBACK_CONFIG.rateLimitCount) {
      return NextResponse.json(
        { success: false, error: 'rateLimit' },
        { status: 429 }
      );
    }

    // Store feedback in database
    await prisma.userFeedback.create({
      data: {
        userId: user.id,
        text: trimmedText,
        source: 'dashboard'
      }
    });

    // Notify admin via Telegram
    await notifyAdminFeedback(user.name, user.telegramId, trimmedText, 'dashboard');

    // Track activity
    trackActivityAsync(user.id, 'feedback_submitted', {
      source: 'dashboard',
      text_length: trimmedText.length
    });

    console.log(`[feedback] User ${user.id} submitted feedback via dashboard (${trimmedText.length} chars)`);

    return NextResponse.json({ success: true });
  } catch (error) {
    captureError(error, 'feedback-api', { api_route: '/api/feedback' });
    return NextResponse.json(
      { success: false, error: 'Failed to submit feedback' },
      { status: 500 }
    );
  }
}
