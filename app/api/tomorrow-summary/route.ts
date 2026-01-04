import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Tomorrow Summary',
    handler: async () => {
      const { sendTomorrowSummaryToAll } = await import('@/src/services/telegram');
      await sendTomorrowSummaryToAll();
      return { success: true, message: "Tomorrow's summaries sent successfully" };
    }
  });
}
