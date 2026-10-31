import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Manual trigger for the 5-minute event alerts pass: opens the event alerts gate, then runs the
// same pass the scheduler runs, so this run reads FamCal too. The gate is shared with the
// scheduler (globalThis), as app/api/native-reminders does with the due gate.
export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Event Reminders',
    handler: async (_request, searchParams) => {
      const windowMinutes = parseInt(searchParams.get('window') || '5', 10);
      const { openEventAlertsGate } = await import('@/src/services/event-alerts-gate');
      const { handleReminders } = await import('@/src/cron/handlers');
      openEventAlertsGate();
      return handleReminders(windowMinutes);
    }
  });
}
