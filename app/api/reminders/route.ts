/**
 * Event Reminders Cron API
 * Triggered every 5 minutes to send event reminders to users
 */

import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { convertPrismaUserToConfig } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // 60 seconds max for reminder processing

export async function GET(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Event Reminders',
    handler: async (_request, searchParams) => {
      // Check global toggle first - skip all DB queries if disabled
      // Wrap in try-catch to handle case where AdminSettings table doesn't exist yet
      let remindersEnabled = false;
      try {
        const adminSettings = await withDbRetry(
          () => prisma.adminSettings.findUnique({
            where: { id: 'global' }
          }),
          'reminders.checkGlobalToggle'
        );
        remindersEnabled = adminSettings?.remindersEnabled ?? false;
      } catch {
        // Table doesn't exist yet - treat as disabled
        console.log('[Event Reminders] AdminSettings table not found, treating as disabled');
      }

      if (!remindersEnabled) {
        return {
          success: true,
          message: 'Reminders globally disabled',
          usersProcessed: 0,
          remindersSent: 0,
        };
      }

      const windowMinutes = parseInt(searchParams.get('window') || '5', 10);

      // Get all users with reminders enabled
      const users = await withDbRetry(
        () => prisma.user.findMany({
          where: {
            remindersEnabled: true,
            googleRefreshToken: { not: '' },
            telegramId: { not: null },
          },
        }),
        'reminders.getUsers'
      );

      if (users.length === 0) {
        return {
          success: true,
          message: 'No users with reminders enabled',
          usersProcessed: 0,
          remindersSent: 0,
        };
      }

      const { processUserReminders } = await import('@/src/services/reminders');

      let totalRemindersSent = 0;
      let usersProcessed = 0;
      const errors: string[] = [];

      // Process each user
      for (const prismaUser of users) {
        try {
          const user = convertPrismaUserToConfig(prismaUser);
          const sentCount = await processUserReminders(user, windowMinutes);
          totalRemindersSent += sentCount;
          usersProcessed++;
        } catch (error) {
          const errorMsg = `User ${prismaUser.telegramId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
