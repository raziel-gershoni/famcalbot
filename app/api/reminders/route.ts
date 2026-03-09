import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Event Reminders',
    handler: async (_request, searchParams) => {
      const windowMinutes = parseInt(searchParams.get('window') || '5', 10);
      const { handleReminders } = await import('@/src/cron/handlers');
      return handleReminders(windowMinutes);
    }
  });
}
