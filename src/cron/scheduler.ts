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

  // The reminder cache's boot step: the legacy plaintext key goes and v2 is built now, not
  // at the next hourly sync. Fire-and-forget; bootReminderCache never throws, so this catch
  // only covers loading the module.
  import('./handlers')
    .then(({ bootReminderCache }) => bootReminderCache())
    .catch(error => {
      console.error('[Scheduler] Reminder cache boot step failed:', error);
      captureError(error, 'boot-reminder-cache');
    });

  // Release only ("remind us both" deploy window): bring the ping rows up to date with what the
  // previous build wrote to the old columns while this one was building, now and three more
  // times. Remove with the step-2 SQL. Fire-and-forget; runCatchUp never throws.
  import('../services/native-reminders/deploy-compat')
    .then(({ scheduleCatchUps }) => scheduleCatchUps())
    .catch(error => {
      console.error('[Scheduler] Reminder catch-up failed to start:', error);
      captureError(error, 'boot-reminder-catchup');
    });

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

  // Native reminder pings — every minute. Separate from the event alerts above, which
  // return early when alerts are off; the pass reads the database only when its
  // in-process gate says something may be due, and handles its own errors.
  cron.schedule('* * * * *', async () => {
    try {
      const { handleNativeReminders } = await import('./handlers');
      await handleNativeReminders();
    } catch (error) {
      console.error('[Scheduler] Native reminders failed:', error);
      captureError(error, 'cron-native-reminders');
      notifyAdmin('Native Reminders', error);
    }
  });

  // Copy to Google — every minute. The pass reads the database only while the sync gate is
  // open (a FamCal write marked a copy, a retry is due, or the hour's ceiling), and handles
  // its own errors.
  cron.schedule('* * * * *', async () => {
    try {
      const { handleGoogleSync } = await import('./handlers');
      await handleGoogleSync();
    } catch (error) {
      console.error('[Scheduler] Google sync failed:', error);
      captureError(error, 'cron-google-sync');
      notifyAdmin('Google Sync', error);
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

  // Activity purge — daily at UTC 03:30 (Israel ~06:30): UserActivity rows older than 90 days
  cron.schedule('30 3 * * *', async () => {
    try {
      const { handleActivityPurge } = await import('./handlers');
      await handleActivityPurge();
    } catch (error) {
      console.error('[Scheduler] Activity purge failed:', error);
      captureError(error, 'cron-activity-purge');
      notifyAdmin('Activity Purge', error);
    }
  });

  // Key sweep — every 10 minutes. After an ENCRYPTION_KEY rotation it re-encrypts the stored
  // Google tokens under the new key and says SAFE once ENCRYPTION_KEY_PREVIOUS can go. Idle for
  // the first 10 minutes of uptime and once nothing is left to do (src/services/key-rotation.ts).
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { runKeySweep } = await import('../services/key-rotation');
      await runKeySweep();
    } catch (error) {
      console.error('[Scheduler] Key sweep failed:', error);
      captureError(error, 'cron-key-sweep');
      notifyAdmin('Key Sweep', error);
    }
  });

  console.log('[Scheduler] Cron jobs registered:');
  console.log('  */5 * * * *  Event reminders');
  console.log('  * * * * *    Native reminders (gated: reads the DB only when one may be due)');
  console.log('  * * * * *    Copy to Google (gated: reads the DB only while a copy may have work)');
  console.log('  0 * * * *    Daily summary (hourly, filters by user preferred hour)');
  console.log('  0 * * * *    Tomorrow summary (hourly, filters by user preferred hour)');
  console.log('  0 7 * * *    Setup reminders (UTC 7:00 = Israel ~10:00)');
  console.log('  0 3 * * *    Health check (UTC 3:00 = Israel ~6:00)');
  console.log('  30 3 * * *   Activity purge (UserActivity rows older than 90 days, in batches)');
  console.log('  */10 * * * * Key sweep (re-encrypts stored Google tokens after a key rotation; idle in the first 10 min)');
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
