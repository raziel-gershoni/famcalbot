import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { updateUserCalendars, getUserByTelegramId } from '@/src/services/user-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, state_token, primary, own_calendars, spouse_calendars } = body;

    if (!user_id) {
      return NextResponse.json(
        { error: 'Missing user_id parameter' },
        { status: 400 }
      );
    }

    // Validate state token is still valid (if present)
    if (state_token) {
      const stateRecord = await prisma.oAuthState.findUnique({
        where: { token: state_token }
      });

      if (!stateRecord || stateRecord.expiresAt < new Date()) {
        return NextResponse.json(
          { error: 'Session expired. Please try again.' },
          { status: 400 }
        );
      }
    }

    // Parse calendar selections
    const ownCals = Array.isArray(own_calendars)
      ? own_calendars
      : own_calendars
      ? [own_calendars]
      : [];
    const spouseCals = spouse_calendars
      ? Array.isArray(spouse_calendars)
        ? spouse_calendars
        : [spouse_calendars]
      : [];
    const allCals = [...new Set([...ownCals, ...spouseCals])]; // Deduplicate

    // Save to database
    await updateUserCalendars(parseInt(user_id), {
      all: allCals,
      primary: primary,
      own: ownCals,
      spouse: spouseCals
    });

    // Get updated user for success response
    const user = await getUserByTelegramId(parseInt(user_id));
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      user: {
        name: user.name,
        calendars: user.calendars,
        primaryCalendar: user.primaryCalendar
      }
    });
  } catch (error) {
    console.error('Calendar submission error:', error);
    return NextResponse.json(
      {
        error: 'Failed to save calendars',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
