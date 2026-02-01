/**
 * Event Reminders Cron API
 * Triggered every 5 minutes to send event reminders to users
 *
 * OPTIMIZED: Reads only from Redis cache (zero DB queries)
 * Cache is populated by daily-summary cron and updated on user changes
 */

import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';
import { getCachedReminderUsers, getGlobalRemindersEnabled } from '@/src/services/reminder-cache';
import { UserConfig, CalendarAssignment } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // 60 seconds max for reminder processing

export async function GET(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Event Reminders',
    handler: async (_request, searchParams) => {
      // Check global toggle from Redis (no DB query)
      const remindersEnabled = await getGlobalRemindersEnabled();

      if (!remindersEnabled) {
        return {
          success: true,
          message: 'Reminders globally disabled',
          usersProcessed: 0,
          remindersSent: 0,
        };
      }

      const windowMinutes = parseInt(searchParams.get('window') || '5', 10);

      // Get users from Redis cache (no DB query)
      const cachedUsers = await getCachedReminderUsers();

      if (!cachedUsers || cachedUsers.length === 0) {
        return {
          success: true,
          message: 'No cached users - waiting for daily sync',
          usersProcessed: 0,
          remindersSent: 0,
        };
      }

      const { processUserReminders } = await import('@/src/services/reminders');

      let totalRemindersSent = 0;
      let usersProcessed = 0;
      const errors: string[] = [];

      // Process each cached user
      for (const cachedUser of cachedUsers) {
        try {
          // Convert cached user to UserConfig format (partial - only fields used by processUserReminders)
          const user = {
            id: cachedUser.id,
            telegramId: parseInt(cachedUser.telegramId, 10),
            name: cachedUser.name,
            language: cachedUser.language,
            googleRefreshToken: cachedUser.googleRefreshToken,
            calendarAssignments: cachedUser.calendarAssignments as CalendarAssignment[],
            defaultReminderMinutes: cachedUser.defaultReminderMinutes ?? undefined,
            remindersEnabled: true, // Only cached if enabled
          } as UserConfig;
          const sentCount = await processUserReminders(user, windowMinutes);
          totalRemindersSent += sentCount;
          usersProcessed++;
        } catch (error) {
          const errorMsg = `User ${cachedUser.telegramId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error(`[Event Reminders] Error processing user:`, errorMsg);
          errors.push(errorMsg);
        }
      }

      console.log(`[Event Reminders] Processed ${usersProcessed} users, sent ${totalRemindersSent} reminders (window: ${windowMinutes}min)`);

      return {
        success: true,
        message: 'Reminders processed',
        usersProcessed,
        remindersSent: totalRemindersSent,
        windowMinutes,
        errors: errors.length > 0 ? errors : undefined,
      };
    }
  });
}
