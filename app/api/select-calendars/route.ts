import { NextRequest, NextResponse } from 'next/server';
import { getUserByTelegramId } from '@/src/services/user-service';
import { validateCalendarAssignments } from '@/src/utils/calendar-helpers';
import { CalendarAssignment } from '@/src/types';
import { prisma } from '@/src/utils/prisma';
import { encrypt } from '@/src/utils/encryption';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { checkRateLimit, settingsRateLimiter, getRateLimitHeaders } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');

    if (!userId) {
      return NextResponse.json(
        { error: 'Missing user_id parameter' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { calendarAssignments, initData } = body as { calendarAssignments: CalendarAssignment[]; initData?: string };

    // Authentication: Verify Telegram initData
    if (!verifyUserAccess(initData || null, parseInt(userId))) {
      console.warn(`[select-calendars] Unauthorized access attempt for user ${userId}`);
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Rate limiting
    const rateLimitResult = await checkRateLimit(settingsRateLimiter, userId);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a minute.' },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      );
    }

    // Validate the calendar assignments
    const validation = validateCalendarAssignments(calendarAssignments);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.errors[0] },
        { status: 400 }
      );
    }

    // Get current user to preserve encrypted refresh token
    const currentUser = await getUserByTelegramId(parseInt(userId));
    if (!currentUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Update user with new calendarAssignments
    await prisma.user.update({
      where: { telegramId: BigInt(userId) },
      data: {
        calendarAssignments: calendarAssignments as any,
        googleRefreshToken: encrypt(currentUser.googleRefreshToken) // Re-encrypt
      }
    });

    return NextResponse.json({
      success: true,
      user: {
        name: currentUser.name,
        calendarsCount: calendarAssignments.length
      }
    });
  } catch (error) {
    captureError(error, 'select-calendars', { api_route: '/api/select-calendars' });
    return NextResponse.json(
      { error: 'Failed to update calendars' },
      { status: 500 }
    );
  }
}
