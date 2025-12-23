import { NextRequest, NextResponse } from 'next/server';
import { getUserByTelegramId } from '@/src/services/user-service';
import { validateCalendarAssignments } from '@/src/utils/calendar-helpers';
import { CalendarAssignment } from '@/src/types';
import { prisma } from '@/src/utils/prisma';
import { encrypt } from '@/src/utils/encryption';

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
    const { calendarAssignments } = body as { calendarAssignments: CalendarAssignment[] };

    // Validate the calendar assignments
    const validation = validateCalendarAssignments(calendarAssignments);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.errors[0] },
        { status: 400 }
      );
    }

    // Extract data for dual-write to legacy fields
    const allCalendarIds = [...new Set(calendarAssignments.map(a => a.calendarId))];
    const primaryCalendar = calendarAssignments.find(a => a.labels.includes('primary'))?.calendarId || '';
    const ownCalendars = calendarAssignments
      .filter(a => a.labels.includes('yours'))
      .map(a => a.calendarId);
    const spouseCalendars = calendarAssignments
      .filter(a => a.labels.includes('spouse'))
      .map(a => a.calendarId);

    // Get current user to preserve encrypted refresh token
    const currentUser = await getUserByTelegramId(parseInt(userId));
    if (!currentUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Update user with new calendarAssignments + dual-write to legacy fields
    await prisma.user.update({
      where: { telegramId: BigInt(userId) },
      data: {
        calendarAssignments: calendarAssignments as any,
        calendars: allCalendarIds,
        primaryCalendar: primaryCalendar,
        ownCalendars: ownCalendars,
        spouseCalendars: spouseCalendars,
        googleRefreshToken: encrypt(currentUser.googleRefreshToken) // Re-encrypt
      }
    });

    return NextResponse.json({
      success: true,
      user: {
        name: currentUser.name,
        calendarsCount: allCalendarIds.length
      }
    });
  } catch (error) {
    console.error('Error updating calendars:', error);
    return NextResponse.json(
      { error: 'Failed to update calendars' },
      { status: 500 }
    );
  }
}
