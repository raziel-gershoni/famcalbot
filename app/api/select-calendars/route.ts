import { NextRequest, NextResponse } from 'next/server';
import { getUserByTelegramId } from '@/src/services/user-service';
import { validateCalendarAssignments } from '@/src/utils/calendar-helpers';
import { CalendarAssignment } from '@/src/types';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { encrypt } from '@/src/utils/encryption';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { updateUserInCache } from '@/src/services/reminder-cache';

/**
 * Sync spouse metadata across all spouse calendars
 * Merges any partial metadata and applies to all spouse calendars
 */
function syncSpouseMetadata(assignments: CalendarAssignment[]): CalendarAssignment[] {
  // Merge all spouse metadata from any spouse calendar
  const spouseCalendars = assignments.filter(a => a.labels.includes('spouse'));

  if (spouseCalendars.length === 0) {
    return assignments;
  }

  // Merge metadata from all spouse calendars (first non-empty value wins)
  const mergedInfo = spouseCalendars.reduce((acc, a) => ({
    personName: acc.personName || a.personName,
    personEnglishName: acc.personEnglishName || a.personEnglishName,
    personGender: acc.personGender || a.personGender,
  }), {} as { personName?: string; personEnglishName?: string; personGender?: 'male' | 'female' });

  // If no metadata at all, return unchanged
  if (!mergedInfo.personName && !mergedInfo.personEnglishName && !mergedInfo.personGender) {
    return assignments;
  }

  // Apply merged info to all spouse calendars
  return assignments.map(a => {
    if (a.labels.includes('spouse')) {
      return {
        ...a,
        personName: mergedInfo.personName,
        personEnglishName: mergedInfo.personEnglishName,
        personGender: mergedInfo.personGender,
      };
    }
    return a;
  });
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json();
    const { calendarAssignments, globalRules, initData } = body as {
      calendarAssignments: CalendarAssignment[];
      globalRules?: string[];
      initData?: string;
    };

    // Authentication and rate limiting
    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'select-calendars');
    if (!auth.success) {
      return auth.response;
    }

    // Validate the calendar assignments
    const validation = validateCalendarAssignments(calendarAssignments);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.errors[0] },
        { status: 400 }
      );
    }

    // Sync spouse metadata across all spouse calendars
    const syncedAssignments = syncSpouseMetadata(calendarAssignments);

    // Get current user to preserve encrypted refresh token
    const currentUser = await getUserByTelegramId(auth.userId);
    if (!currentUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Update user with new calendarAssignments and globalRules
    const updatedUser = await withDbRetry(
      () => prisma.user.update({
        where: { telegramId: BigInt(auth.userId) },
        data: {
          calendarAssignments: syncedAssignments as any,
          ...(globalRules !== undefined && { globalRules }),
          googleRefreshToken: encrypt(currentUser.googleRefreshToken) // Re-encrypt
        }
      }),
      'select-calendars.update'
    );

    // Update reminder cache if user has reminders enabled (no extra DB query)
    if (currentUser.remindersEnabled && currentUser.googleRefreshToken) {
      await updateUserInCache({
        id: updatedUser.id,
        telegramId: updatedUser.telegramId?.toString() ?? '',
        googleRefreshToken: currentUser.googleRefreshToken, // Use existing decrypted token
        calendarAssignments: syncedAssignments,
        defaultReminderMinutes: currentUser.defaultReminderMinutes ?? null,
        language: currentUser.language,
        name: currentUser.name,
        pickupRemindersEnabled: currentUser.pickupRemindersEnabled ?? true,
      });
    }

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
