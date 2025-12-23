import { NextRequest, NextResponse } from 'next/server';
import { getUserByTelegramId, updateUserCalendars } from '@/src/services/user-service';

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
    const { primary, own_calendars, spouse_calendars } = body;

    const ownCals = Array.isArray(own_calendars) ? own_calendars : (own_calendars ? [own_calendars] : []);
    const spouseCals = spouse_calendars ? (Array.isArray(spouse_calendars) ? spouse_calendars : [spouse_calendars]) : [];
    const allCals = [...new Set([...ownCals, ...spouseCals])];

    await updateUserCalendars(parseInt(userId), {
      all: allCals,
      primary: primary,
      own: ownCals,
      spouse: spouseCals
    });

    // Get updated user for response
    const updatedUser = await getUserByTelegramId(parseInt(userId));

    return NextResponse.json({
      success: true,
      user: {
        name: updatedUser?.name,
        calendarsCount: allCals.length
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
