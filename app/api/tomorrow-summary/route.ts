import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Tomorrow Summary',
    handler: async () => {
      const { sendTomorrowSummaryToAll } = await import('@/src/services/telegram');
      const summaryResult = await sendTomorrowSummaryToAll({ filterByHour: true });
      return {
        success: true,
        message: "Tomorrow's summaries sent successfully",
        processed: summaryResult.processed,
        skippedHour: summaryResult.skippedHour,
        skippedDedup: summaryResult.skippedDedup,
      };
    }
  });
}
