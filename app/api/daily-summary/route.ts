import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { syncReminderCache, setGlobalRemindersEnabled, CachedReminderUser } from '@/src/services/reminder-cache';
import { safeDecrypt } from '@/src/utils/encryption';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Daily Summary',
    handler: async () => {
      const { sendDailySummaryToAll } = await import('@/src/services/telegram');
      await sendDailySummaryToAll();

      // Sync reminder cache from DB (piggyback on existing DB connection)
      try {
        // Fetch users with reminders enabled
        const users = await withDbRetry(
          () => prisma.user.findMany({
            where: {
              remindersEnabled: true,
              googleRefreshToken: { not: '' },
              telegramId: { not: null },
            },
            select: {
              id: true,
              telegramId: true,
              googleRefreshToken: true,
              calendarAssignments: true,
              defaultReminderMinutes: true,
              language: true,
              name: true,
            }
          }),
          'daily-summary.fetchReminderUsers'
        );

        // Build cache with decrypted tokens
        const reminderUsers: CachedReminderUser[] = users.map(u => ({
          id: u.id,
          telegramId: u.telegramId?.toString() ?? '',
          googleRefreshToken: safeDecrypt(u.googleRefreshToken),
          calendarAssignments: u.calendarAssignments,
          defaultReminderMinutes: u.defaultReminderMinutes,
          language: u.language,
          name: u.name,
        }));

        await syncReminderCache(reminderUsers);

        // Also sync global reminders toggle
        const adminSettings = await withDbRetry(
          () => prisma.adminSettings.findUnique({
            where: { id: 'global' }
          }),
          'daily-summary.fetchAdminSettings'
        ).catch(() => null);

        await setGlobalRemindersEnabled(adminSettings?.remindersEnabled ?? false);
      } catch (syncError) {
        console.error('[Daily Summary] Failed to sync reminder cache:', syncError);
        // Don't fail the cron job if cache sync fails
      }

      // Clean up expired OAuth state tokens
      try {
        const deleted = await withDbRetry(
          () => prisma.oAuthState.deleteMany({
            where: {
              expiresAt: {
                lt: new Date()
              }
            }
          }),
          'daily-summary.cleanupOAuth'
        );
        console.log(`[Daily Summary] Cleaned up ${deleted.count} expired OAuth state tokens`);
      } catch (cleanupError) {
        console.error('[Daily Summary] Failed to clean up OAuth state tokens:', cleanupError);
        // Don't fail the cron job if cleanup fails
      }

      return { success: true, message: 'Daily summaries sent successfully' };
    }
  });
}
