import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Manual trigger for the native reminder pass: opens the due gate, then runs one tick.
// The tick logs what it sent under [NativeReminders] and handles its own errors. The
// running flag and the gate are shared with the scheduler (globalThis), so if a
// scheduled pass is mid-run this tick skips, and the opened gate makes the next
// scheduled tick read.
export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Native Reminders',
    handler: async () => {
      const { invalidateDueGate } = await import('@/src/services/native-reminders/due-gate');
      const { handleNativeReminders } = await import('@/src/cron/handlers');
      invalidateDueGate();
      await handleNativeReminders();
      return { success: true, message: 'Native reminders pass ran' };
    },
  });
}
