/**
 * Data Migration Script: Convert legacy calendar fields to calendarAssignments
 *
 * This script migrates existing user calendar data from the legacy format:
 *   - calendars: string[]
 *   - primaryCalendar: string
 *   - ownCalendars: string[]
 *   - spouseCalendars: string[]
 *
 * To the new flexible calendarAssignments format:
 *   - calendarAssignments: CalendarAssignment[]
 *
 * Run this script ONCE after deploying the new code:
 *   npx ts-node prisma/migrations/migrate-calendar-data.ts
 */

import { PrismaClient } from '@prisma/client';
import { CalendarAssignment, CalendarLabel } from '../../src/types';
import { encrypt } from '../../src/utils/encryption';

const prisma = new PrismaClient();

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

async function migrateCalendarData() {
  console.log('🔄 Starting calendar data migration...\n');

  try {
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

    console.log(`📊 Found ${users.length} users in database\n`);

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        // Skip if already migrated
        if (user.calendarAssignments && Array.isArray(user.calendarAssignments) && user.calendarAssignments.length > 0) {
          console.log(`⏭️  Skipping user ${user.name} (ID: ${user.id}) - already migrated`);
          skippedCount++;
          continue;
        }

        // Skip if no legacy data exists
        if (!user.primaryCalendar && (!user.ownCalendars || user.ownCalendars.length === 0) && (!user.spouseCalendars || user.spouseCalendars.length === 0)) {
          console.log(`⏭️  Skipping user ${user.name} (ID: ${user.id}) - no calendar data`);
          skippedCount++;
          continue;
        }

        // Convert legacy data to assignments
        const calendarAssignments = convertLegacyToAssignments(
          user.primaryCalendar || '',
          user.ownCalendars || [],
          user.spouseCalendars || []
        );

        console.log(`✅ Migrating user ${user.name} (ID: ${user.id}):`);
        console.log(`   - Primary: ${user.primaryCalendar || 'none'}`);
        console.log(`   - Own: ${user.ownCalendars?.length || 0} calendars`);
        console.log(`   - Spouse: ${user.spouseCalendars?.length || 0} calendars`);
        console.log(`   → Created ${calendarAssignments.length} assignments`);

        // Update user with new calendarAssignments
        await prisma.user.update({
          where: { id: user.id },
          data: {
            calendarAssignments: calendarAssignments as any,
            googleRefreshToken: encrypt(user.googleRefreshToken) // Re-encrypt
          }
        });

        migratedCount++;
        console.log(`   ✓ Migration successful\n`);

      } catch (error) {
        errorCount++;
        console.error(`❌ Error migrating user ${user.name} (ID: ${user.id}):`, error);
        console.log('');
      }
    }

    console.log('\n📈 Migration Summary:');
    console.log(`   Total users: ${users.length}`);
    console.log(`   ✅ Migrated: ${migratedCount}`);
    console.log(`   ⏭️  Skipped: ${skippedCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log('\n✨ Migration completed!\n');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run migration
migrateCalendarData()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
