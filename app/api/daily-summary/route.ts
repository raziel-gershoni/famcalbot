import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Daily Summary',
    handler: async () => {
      const { handleDailySummary } = await import('@/src/cron/handlers');
      return handleDailySummary();
    }
  });
}
