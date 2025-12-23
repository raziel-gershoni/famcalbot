import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { CalendarAssignment, CalendarLabel } from '@/src/types';
import { encrypt } from '@/src/utils/encryption';

interface LegacyUserData {
  id: number;
  telegramId: bigint;
  name: string;
  calendars: string[];
  primaryCalendar: string;
  ownCalendars: string[];
  spouseCalendars: string[];
  googleRefreshToken: string;
  calendarAssignments: any;
}

/**
 * Convert legacy calendar fields to CalendarAssignment array
 */
function convertLegacyToAssignments(
  primaryCalendar: string,
  ownCalendars: string[],
  spouseCalendars: string[]
): CalendarAssignment[] {
  const assignments: CalendarAssignment[] = [];
  const processedIds = new Set<string>();

  // Add primary calendar (must be in 'yours' too)
  if (primaryCalendar) {
    assignments.push({
      calendarId: primaryCalendar,
      labels: ['primary', 'yours'],
      name: 'Primary Calendar',
      color: '#4285f4'
    });
    processedIds.add(primaryCalendar);
  }

  // Add own calendars (skip if already added as primary)
  for (const calId of ownCalendars) {
    if (!processedIds.has(calId)) {
      assignments.push({
        calendarId: calId,
        labels: ['yours'],
        name: 'Your Calendar',
        color: '#8b5cf6'
      });
      processedIds.add(calId);
    }
  }

  // Add spouse calendars
  for (const calId of spouseCalendars) {
    assignments.push({
      calendarId: calId,
      labels: ['spouse'],
      name: 'Spouse Calendar',
      color: '#ec4899'
    });
    processedIds.add(calId);
  }

  return assignments;
}

/**
 * Protected migration endpoint
 * Call with: /api/migrate-calendar-data?secret=YOUR_CRON_SECRET
 */
export async function GET(request: NextRequest) {
  try {
    // Authentication check
    const { searchParams } = new URL(request.url);
    const secret = searchParams.get('secret');

    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.log('🔄 Starting calendar data migration...');

    // Fetch all users
    const users = await prisma.user.findMany({
      select: {
        id: true,
        telegramId: true,
        name: true,
        calendars: true,
        primaryCalendar: true,
        ownCalendars: true,
        spouseCalendars: true,
        googleRefreshToken: true,
        calendarAssignments: true
      }
    }) as LegacyUserData[];

    console.log(`📊 Found ${users.length} users in database`);

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const logs: string[] = [];

    for (const user of users) {
      try {
        // Skip if already migrated
        if (user.calendarAssignments && Array.isArray(user.calendarAssignments) && user.calendarAssignments.length > 0) {
          logs.push(`⏭️  Skipped user ${user.name} (ID: ${user.id}) - already migrated`);
          skippedCount++;
          continue;
        }

        // Skip if no legacy data exists
        if (!user.primaryCalendar && (!user.ownCalendars || user.ownCalendars.length === 0) && (!user.spouseCalendars || user.spouseCalendars.length === 0)) {
          logs.push(`⏭️  Skipped user ${user.name} (ID: ${user.id}) - no calendar data`);
          skippedCount++;
          continue;
        }

        // Convert legacy data to assignments
        const calendarAssignments = convertLegacyToAssignments(
          user.primaryCalendar || '',
          user.ownCalendars || [],
          user.spouseCalendars || []
        );

        logs.push(`✅ Migrating user ${user.name} (ID: ${user.id}):`);
        logs.push(`   - Primary: ${user.primaryCalendar || 'none'}`);
        logs.push(`   - Own: ${user.ownCalendars?.length || 0} calendars`);
        logs.push(`   - Spouse: ${user.spouseCalendars?.length || 0} calendars`);
        logs.push(`   → Created ${calendarAssignments.length} assignments`);

        // Update user with new calendarAssignments
        await prisma.user.update({
          where: { id: user.id },
          data: {
            calendarAssignments: calendarAssignments as any,
            googleRefreshToken: encrypt(user.googleRefreshToken) // Re-encrypt
          }
        });

        migratedCount++;
        logs.push(`   ✓ Migration successful`);

      } catch (error) {
        errorCount++;
        logs.push(`❌ Error migrating user ${user.name} (ID: ${user.id}): ${error}`);
      }
    }

    const summary = {
      totalUsers: users.length,
      migrated: migratedCount,
      skipped: skippedCount,
      errors: errorCount,
      logs: logs
    };

    console.log('📈 Migration Summary:', summary);

    return NextResponse.json({
      success: true,
      message: '✨ Migration completed!',
      summary
    });

  } catch (error) {
    console.error('❌ Migration failed:', error);
    return NextResponse.json(
      {
        error: 'Migration failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
