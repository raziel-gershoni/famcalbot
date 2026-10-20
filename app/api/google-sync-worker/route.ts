import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Manual trigger for the copy-to-Google worker (google-sync spec §4): opens the sync gate,
// then runs one tick. The tick logs under [GoogleSync] / [google-sync] and handles its own
// errors. The running flag and the gate are shared with the scheduler (globalThis), so if a
// scheduled pass is mid-run this tick skips, and the opened gate makes the next scheduled
// tick read.
export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Google Sync',
    handler: async () => {
      const { openSyncGate } = await import('@/src/services/google-sync/gate');
      const { handleGoogleSync } = await import('@/src/cron/handlers');
      openSyncGate();
      await handleGoogleSync();
      return { success: true, message: 'Google sync pass ran' };
    },
  });
}
