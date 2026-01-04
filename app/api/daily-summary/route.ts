import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';
import { prisma, withDbRetry } from '@/src/utils/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Daily Summary',
    handler: async () => {
      const { sendDailySummaryToAll } = await import('@/src/services/telegram');
      await sendDailySummaryToAll();

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
