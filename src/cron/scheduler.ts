/**
 * In-process cron scheduler using node-cron
 * Replaces QStash HTTP-based scheduling with direct function calls
 *
 * All times are UTC. Israel is UTC+2 (winter) / UTC+3 (summer).
 */

import cron from 'node-cron';
import { captureError } from '../lib/error-capture';

export function startScheduler(): void {
  console.log('[Scheduler] Starting in-process cron scheduler...');

  // Event reminders — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { handleReminders } = await import('./handlers');
      const result = await handleReminders(5);
      console.log(`[Scheduler] Reminders: ${result.message} (${result.remindersSent} sent)`);
    } catch (error) {
      console.error('[Scheduler] Reminders failed:', error);
      captureError(error, 'cron-reminders');
      notifyAdmin('Event Reminders', error);
    }
  });

  // Daily summary — every hour (filters by user preferred hour)
  cron.schedule('0 * * * *', async () => {
    try {
      const { handleDailySummary } = await import('./handlers');
      const result = await handleDailySummary();
      console.log(`[Scheduler] Daily summary: ${result.processed} processed, ${result.skippedHour} skipped (hour), ${result.skippedDay} skipped (day), ${result.skippedDedup} skipped (dedup)`);
    } catch (error) {
      console.error('[Scheduler] Daily summary failed:', error);
      captureError(error, 'cron-daily-summary');
      notifyAdmin('Daily Summary', error);
    }
  });

  // Tomorrow summary — every hour (filters by user preferred hour)
  cron.schedule('0 * * * *', async () => {
    try {
      const { handleTomorrowSummary } = await import('./handlers');
      const result = await handleTomorrowSummary();
      console.log(`[Scheduler] Tomorrow summary: ${result.processed} processed, ${result.skippedHour} skipped (hour), ${result.skippedDay} skipped (day), ${result.skippedDedup} skipped (dedup)`);
    } catch (error) {
      console.error('[Scheduler] Tomorrow summary failed:', error);
      captureError(error, 'cron-tomorrow-summary');
      notifyAdmin('Tomorrow Summary', error);
    }
  });

  // Setup reminders — daily at UTC 07:00 (Israel ~10:00)
  cron.schedule('0 7 * * *', async () => {
    try {
      const { handleSetupReminders } = await import('./handlers');
      const result = await handleSetupReminders();
      console.log(`[Scheduler] Setup reminders: ${result.message}`);
    } catch (error) {
      console.error('[Scheduler] Setup reminders failed:', error);
      captureError(error, 'cron-setup-reminders');
      notifyAdmin('Setup Reminders', error);
    }
  });

  // Health check + subscription reminders — daily at UTC 03:00 (Israel ~06:00)
  cron.schedule('0 3 * * *', async () => {
    try {
      const { handleHealth } = await import('./handlers');
      const result = await handleHealth();
      console.log(`[Scheduler] Health: ${result.status}`);
    } catch (error) {
      console.error('[Scheduler] Health check failed:', error);
      captureError(error, 'cron-health-check');
      notifyAdmin('Health Check', error);
    }
  });

  console.log('[Scheduler] Cron jobs registered:');
  console.log('  */5 * * * *  Event reminders');
  console.log('  0 * * * *    Daily summary (hourly, filters by user preferred hour)');
  console.log('  0 * * * *    Tomorrow summary (hourly, filters by user preferred hour)');
  console.log('  0 7 * * *    Setup reminders (UTC 7:00 = Israel ~10:00)');
  console.log('  0 3 * * *    Health check (UTC 3:00 = Israel ~6:00)');
}

/**
 * Notify admin of cron job failures (fire and forget)
 */
function notifyAdmin(jobName: string, error: unknown): void {
  import('../utils/error-notifier').then(({ notifyAdminError }) =>
    notifyAdminError('Cron Job', error, `Job: ${jobName}`)
  ).catch(notifyError =>
    { console.error(`[Scheduler] Failed to notify admin about ${jobName}:`, notifyError); captureError(notifyError, 'cron-admin-notify', { job: jobName }, 'warning'); }
  );
}
