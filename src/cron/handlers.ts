/**
 * Cron job handler functions
 * Called both from the scheduler (node-cron) and from API routes
 */

import { prisma } from '../utils/prisma';
import { captureError } from '../lib/error-capture';
import type { SetupTrack } from '../services/setup-tracks';

export interface CronResult {
  success: boolean;
  message: string;
  [key: string]: unknown;
}

/**
 * Daily summary handler
 * Sends daily summaries, syncs reminder cache, and cleans up expired OAuth tokens
 */
export async function handleDailySummary(): Promise<CronResult> {
  const { sendDailySummaryToAll } = await import('../services/telegram');
  // The reminder-cache sync and the OAuth clean-up run beside the summaries, not after
  // them: a scheduled batch can wait about 30 s and then retry the users whose Google read
  // failed (calendar home spec §3.1 step 6), and the alert pass must not wait for that.
  const housekeeping = syncRemindersAndCleanUp();
  const summaryResult = await sendDailySummaryToAll({ filterByHour: true });
  await housekeeping;

  return {
    success: true,
    message: 'Daily summaries sent successfully',
    processed: summaryResult.processed,
    skippedHour: summaryResult.skippedHour,
    skippedDay: summaryResult.skippedDay,
    skippedDedup: summaryResult.skippedDedup,
  };
}

/**
 * Rebuilds the reminder cache (reminders:users:v2) from the database: every user the
 * 5-minute run alerts. Each Google token is copied as stored and sealed (toEntry), never
 * decrypted here, so a row that no key opens can't stop the sync; the run opens each token
 * per user. Used by the hourly run, the boot step and the key sweep. A database failure
 * throws to the caller; a Redis write failure is logged and captured by syncReminderCache.
 * Returns the number of users synced.
 */
export async function rebuildReminderCache(): Promise<number> {
  const { syncReminderCache, toEntry } = await import('../services/reminder-cache');

  const users = await prisma.user.findMany({
    where: {
      remindersEnabled: true,
      // Everyone has FamCal ("Google as a connection"), so a missing Google token
      // keeps nobody out: their FamCal events alert too.
      telegramId: { not: null },
      suspendedAt: null,
      // Telegram refuses delivery to these chats; reminders would 403 every 5 minutes.
      unreachableSince: null,
    },
    select: {
      id: true,
      telegramId: true,
      googleRefreshToken: true,
      calendarAssignments: true,
      calendarSource: true,
      pairingId: true,
      defaultReminderMinutes: true,
      pickupRemindersEnabled: true,
      language: true,
      name: true,
      location: true,
    }
  });

  const entries = users.map(u => toEntry({
    id: u.id,
    telegramId: u.telegramId?.toString() ?? '',
    googleRefreshToken: u.googleRefreshToken, // As stored; toEntry seals it
    calendarAssignments: u.calendarAssignments,
    calendarSource: u.calendarSource,
    pairingId: u.pairingId,
    defaultReminderMinutes: u.defaultReminderMinutes,
    language: u.language,
    name: u.name,
    pickupRemindersEnabled: u.pickupRemindersEnabled ?? true,
    location: u.location,
  }));

  await syncReminderCache(entries);
  return entries.length;
}

/**
 * The reminder cache's boot step (startScheduler): the legacy plaintext key goes, then v2
 * is built at once. An empty v2 reads as "No cached users" to the 5-minute run, so without
 * this, reminders would wait up to an hour after a deploy. One DB query per deploy. Never
 * throws: a failure is logged and captured, and the hourly sync tries again.
 */
export async function bootReminderCache(): Promise<void> {
  try {
    const { purgeLegacyReminderCache } = await import('../services/reminder-cache');
    await purgeLegacyReminderCache();
    const synced = await rebuildReminderCache();
    console.log(`[Reminder Cache] Rebuilt at boot: ${synced} users`);
  } catch (error) {
    console.error('[Reminder Cache] Boot rebuild failed:', error);
    captureError(error, 'boot-reminder-cache');
  }
}

/**
 * The daily run's housekeeping: the reminder-cache sync and, at 04:00 UTC, the clean-up of
 * expired OAuth state tokens. Each step catches its own failure, so this never rejects.
 */
async function syncRemindersAndCleanUp(): Promise<void> {
  // Sync reminder cache from DB (piggyback on existing run), and drop the legacy plaintext key
  try {
    const { setGlobalRemindersEnabled, purgeLegacyReminderCache } = await import('../services/reminder-cache');

    await rebuildReminderCache();
    await purgeLegacyReminderCache();

    const adminSettings = await prisma.adminSettings.findUnique({
      where: { id: 'global' }
    }).catch(() => null);

    await setGlobalRemindersEnabled(adminSettings?.remindersEnabled ?? false);
  } catch (syncError) {
    console.error('[Daily Summary] Failed to sync reminder cache:', syncError);
    captureError(syncError, 'cron-daily-summary-cache-sync', undefined, 'warning');
  }

  // Clean up expired OAuth state tokens — only at UTC hour 4
  const utcHour = new Date().getUTCHours();
  if (utcHour === 4) {
    try {
      const deleted = await prisma.oAuthState.deleteMany({
        where: { expiresAt: { lt: new Date() } }
      });
      console.log(`[Daily Summary] Cleaned up ${deleted.count} expired OAuth state tokens`);
    } catch (cleanupError) {
      console.error('[Daily Summary] Failed to clean up OAuth state tokens:', cleanupError);
      captureError(cleanupError, 'cron-daily-summary-oauth-cleanup', undefined, 'warning');
    }
  }
}

/**
 * Tomorrow summary handler
 */
export async function handleTomorrowSummary(): Promise<CronResult> {
  const { sendTomorrowSummaryToAll } = await import('../services/telegram');
  const summaryResult = await sendTomorrowSummaryToAll({ filterByHour: true });
  return {
    success: true,
    message: "Tomorrow's summaries sent successfully",
    processed: summaryResult.processed,
    skippedHour: summaryResult.skippedHour,
    skippedDay: summaryResult.skippedDay,
    skippedDedup: summaryResult.skippedDedup,
  };
}

/**
 * Event reminders handler
 * Reads from Redis cache (zero DB queries), processes reminders for each user
 */
export async function handleReminders(windowMinutes: number = 5): Promise<CronResult> {
  const { getCachedReminderUsers, getGlobalRemindersEnabled } = await import('../services/reminder-cache');

  const remindersEnabled = await getGlobalRemindersEnabled();
  if (!remindersEnabled) {
    return {
      success: true,
      message: 'Reminders globally disabled',
      usersProcessed: 0,
      remindersSent: 0,
    };
  }

  const cachedUsers = await getCachedReminderUsers();
  if (!cachedUsers || cachedUsers.length === 0) {
    return {
      success: true,
      message: 'No cached users - waiting for daily sync',
      usersProcessed: 0,
      remindersSent: 0,
    };
  }

  const { processUserReminders } = await import('../services/reminders');
  const { openSecret, reportUndecryptable, UndecryptableError, keyFingerprint } = await import('../utils/encryption');

  let totalRemindersSent = 0;
  let usersProcessed = 0;
  const errors: string[] = [];
  const openCachedToken = (cachedUser: { id: number; googleToken: string }): string => {
    try {
      return openSecret(cachedUser.googleToken);
    } catch (error) {
      // An unusable current key is a configuration fault, not a bad entry: degrade the same way
      if (!(error instanceof UndecryptableError) && keyFingerprint('current') !== null) throw error;
      reportUndecryptable(error, { userId: cachedUser.id, column: 'reminders-cache' });
      return '';
    }
  };

  for (const cachedUser of cachedUsers) {
    try {
      const user = {
        id: cachedUser.id,
        telegramId: parseInt(cachedUser.telegramId, 10),
        name: cachedUser.name,
        language: cachedUser.language,
        // Sealed in the cache (toEntry) and opened here. An entry that no key opens, or a
        // missing or invalid ENCRYPTION_KEY (named at startup), counts as "not connected":
        // the user keeps every FamCal reminder, has no Google events, and is
        // reported once per process. Any other error fails this user ('cron-reminders-process-user').
        googleRefreshToken: openCachedToken(cachedUser),
        calendarAssignments: cachedUser.calendarAssignments,
        // Legacy: the providers are chosen by calendar id ("Google as a connection"); read only
        // as liveGoogleChoices' marker for the stored Google choices of a user with no token.
        calendarSource: cachedUser.calendarSource ?? 'GOOGLE',
        pairingId: cachedUser.pairingId ?? null,
        defaultReminderMinutes: cachedUser.defaultReminderMinutes ?? undefined,
        // Without it a user who turned pickup reminders off still got them.
        pickupRemindersEnabled: cachedUser.pickupRemindersEnabled,
        // resolveUserTimezone geocodes this before falling back to Israel.
        location: cachedUser.location ?? '',
        remindersEnabled: true,
        // No messagingPlatform on purpose: reminders go to Telegram only.
      } as import('../types').UserConfig;
      const sentCount = await processUserReminders(user, windowMinutes);
      totalRemindersSent += sentCount;
      usersProcessed++;
    } catch (error) {
      const errorMsg = `User ${cachedUser.telegramId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`[Event Reminders] Error processing user:`, errorMsg);
      captureError(error, 'cron-reminders-process-user', { telegramId: cachedUser.telegramId });
      errors.push(errorMsg);
    }
  }

  console.log(`[Event Reminders] Processed ${usersProcessed} users, sent ${totalRemindersSent} reminders (window: ${windowMinutes}min)`);

  return {
    success: true,
    message: 'Reminders processed',
    usersProcessed,
    remindersSent: totalRemindersSent,
    windowMinutes,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// The native reminder pass ticks every minute, so a tick that finds the last one still
// running skips, and a failing pass tells the admin at most once an hour. Both live on
// globalThis, like the due gate's memo: the scheduler (instrumentation.ts) and the
// manual route (app/api/native-reminders) load this file in separate bundles, and a
// module-level flag would let a manual run overlap a scheduled one.
const NATIVE_REMINDERS_ALERT_INTERVAL_MS = 60 * 60 * 1000;
// A pass still running after this is taken for dead. node-telegram-bot-api sets no
// request timeout, so one hung send would otherwise hold every ping until TCP gives up.
const NATIVE_REMINDERS_STUCK_MS = 5 * 60 * 1000;
type NativeRemindersCronState = { running: boolean; startedAt: number; alertedAt: number };
const nativeRemindersCron = ((globalThis as { __nativeRemindersCron?: NativeRemindersCronState }).__nativeRemindersCron ??= {
  running: false,
  startedAt: 0,
  alertedAt: 0,
});

/**
 * Native reminders handler (built-in calendar reminders, not event alerts)
 * Pings the reminder occurrences due now. The database is read only when the in-process
 * due gate says something may be due; a pass that fails leaves the gate open, so the
 * next tick tries again.
 */
export async function handleNativeReminders(): Promise<void> {
  const now = new Date();
  // The running flag first: shouldRunPass marks the start of a pass (due-gate.ts).
  if (nativeRemindersCron.running) {
    if (now.getTime() - nativeRemindersCron.startedAt <= NATIVE_REMINDERS_STUCK_MS) return;
    captureError(new Error('native reminders pass stuck >5m'), 'native-reminders-stuck', {}, 'warning');
    nativeRemindersCron.running = false;
  }
  const startedAt = now.getTime();
  nativeRemindersCron.running = true;
  nativeRemindersCron.startedAt = startedAt;
  try {
    const { shouldRunPass, setNextDue } = await import('../services/native-reminders/due-gate');
    if (!shouldRunPass(now)) return;
    const { runNativeReminderPass } = await import('../services/native-reminders/pass');
    const result = await runNativeReminderPass(now);
    // Only after a pass that succeeded, and not from one taken for dead: its view is older than its replacement's
    if (nativeRemindersCron.startedAt === startedAt) setNextDue(result.nextDue, now);
    if (result.sent || result.skipped || result.failed) {
      console.log(`[NativeReminders] Sent ${result.sent}, skipped ${result.skipped}, failed ${result.failed}`);
    }
  } catch (error) {
    captureError(error, 'cron-native-reminders');
    if (now.getTime() - nativeRemindersCron.alertedAt >= NATIVE_REMINDERS_ALERT_INTERVAL_MS) {
      nativeRemindersCron.alertedAt = now.getTime();
      try {
        const { notifyAdminError } = await import('../utils/error-notifier');
        await notifyAdminError('Cron Job', error, 'Job: Native Reminders');
      } catch (notifyError) {
        captureError(notifyError, 'cron-admin-notify', { job: 'Native Reminders' }, 'warning');
      }
    }
  } finally {
    // A pass taken for dead may still finish: it leaves the flag of the pass that replaced it
    if (nativeRemindersCron.startedAt === startedAt) nativeRemindersCron.running = false;
  }
}

// The copy-to-Google worker (google-sync spec §4) ticks every minute too, with the same
// guards as the native reminder pass, on its own globalThis state: a tick that finds the last
// pass still running skips (one taken for dead after GOOGLE_SYNC_STUCK_MS is replaced; the
// per-user Redis locks keep two passes off one user), and a failing pass tells the admin at
// most once an hour.
const GOOGLE_SYNC_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const GOOGLE_SYNC_STUCK_MS = 15 * 60 * 1000;
const googleSyncCron = ((globalThis as { __googleSyncCron?: NativeRemindersCronState }).__googleSyncCron ??= {
  running: false,
  startedAt: 0,
  alertedAt: 0,
});

/**
 * Copy-to-Google handler: one worker pass, run only while the sync gate is open (a FamCal
 * write marked something, an earlier pass left a retry due, or the hour's ceiling came). A
 * pass that fails leaves the gate open, so the next tick tries again.
 */
export async function handleGoogleSync(): Promise<void> {
  const now = new Date();
  if (googleSyncCron.running) {
    if (now.getTime() - googleSyncCron.startedAt <= GOOGLE_SYNC_STUCK_MS) return;
    captureError(new Error('google sync pass stuck >15m'), 'google-sync-stuck', {}, 'warning');
    googleSyncCron.running = false;
  }
  const startedAt = now.getTime();
  googleSyncCron.running = true;
  googleSyncCron.startedAt = startedAt;
  try {
    const { shouldRunSync, setNextSync } = await import('../services/google-sync/gate');
    if (!shouldRunSync(now)) return;
    const { runGoogleSyncPass } = await import('../services/google-sync/worker');
    const result = await runGoogleSyncPass(now);
    if (googleSyncCron.startedAt === startedAt) setNextSync(result.next, now);
    if (result.users || result.pushed || result.failed) {
      console.log(`[GoogleSync] ${result.users} users, ${result.pushed} pushed, ${result.failed} failed`);
    }
  } catch (error) {
    captureError(error, 'cron-google-sync');
    if (now.getTime() - googleSyncCron.alertedAt >= GOOGLE_SYNC_ALERT_INTERVAL_MS) {
      googleSyncCron.alertedAt = now.getTime();
      try {
        const { notifyAdminError } = await import('../utils/error-notifier');
        await notifyAdminError('Cron Job', error, 'Job: Google Sync');
      } catch (notifyError) {
        captureError(notifyError, 'cron-admin-notify', { job: 'Google Sync' }, 'warning');
      }
    }
  } finally {
    if (googleSyncCron.startedAt === startedAt) googleSyncCron.running = false;
  }
}

/**
 * Setup reminders handler ("Google as a connection" spec §2): the location nudge for
 * anyone without one (from signup), and the Google nudges by the user's Google state at
 * any account age (choose calendars; reconnect a cleared token). Connecting Google is
 * optional, so nobody is asked to. Days and starts come from setup-tracks.ts.
 */
export async function handleSetupReminders(): Promise<CronResult> {
  const { buildUrl } = await import('../config/urls');
  const { redis } = await import('../utils/redis');
  const { REDIS_KEYS } = await import('../config/redis-keys');
  const { googleStateOf } = await import('../lib/google-state');
  const tracks = await import('../services/setup-tracks');
  const { SETUP_SCHEDULES } = tracks;

  const MAX_DAYS = 14;                      // The location track looks this far back from signup

  interface ReminderResult {
    type: SetupTrack;
    userId: number;
    name: string;
    attempt: number;
    success: boolean;
    error?: string;
  }

  async function getBotCopy(language: string) {
    const { default: messages } = await import(`@/messages/${language}.json`);
    return messages.bot;
  }

  // Pick the right message body based on attempt number
  function pickBody(messages: { body: string; bodyReminder?: string; bodyFinal?: string }, attempt: number, maxAttempts: number): string {
    if (attempt >= maxAttempts - 1 && messages.bodyFinal) return messages.bodyFinal;
    if (attempt > 0 && messages.bodyReminder) return messages.bodyReminder;
    return messages.body;
  }

  const results: ReminderResult[] = [];
  const { getMessagingService } = await import('../services/telegram');
  const { getWhatsAppService } = await import('../services/messaging/factory');
  const { MessageFormat } = await import('../services/messaging/types');
  const tgService = getMessagingService();

  // Helper: send setup reminder to correct platform
  async function sendSetupReminder(
    user: { id: number; telegramId: bigint | null; whatsappPhone: string | null; whatsappBsuid: string | null; language: string; name: string },
    title: string, body: string, buttonText: string, url: string,
    type: ReminderResult['type'], attempt: number, ttlSeconds: number
  ): Promise<void> {
    const message = `${title}\n\n${body}`;

    // Send to Telegram
    if (user.telegramId) {
      await tgService.sendMessage(Number(user.telegramId), message, {
        format: MessageFormat.HTML,
        replyMarkup: { inline_keyboard: [[{ text: buttonText, web_app: { url } }]] },
      });
    }

    // WA-only users: send template notification only (no free-form — reminders are TG-focused)
    const waChatId = user.whatsappPhone || user.whatsappBsuid;
    if (waChatId && !user.telegramId) {
      const { buildWhatsAppTemplate } = await import('../services/messaging/whatsapp-template');
      const template = buildWhatsAppTemplate(user.language || 'en', 'settings');
      const waService = getWhatsAppService();
      await waService.sendMessage(waChatId, '', { whatsappTemplate: template });
    }

    // Mark this attempt as sent in Redis
    await redis.set(REDIS_KEYS.setupReminder(user.id, type, attempt), '1', { ex: ttlSeconds });
    results.push({ type, userId: user.id, name: user.name, attempt, success: true });
  }

  const userSelect = {
    id: true, telegramId: true, whatsappPhone: true, whatsappBsuid: true, language: true, name: true,
  } as const;
  const dateSelect = { ...userSelect, createdAt: true, reminderStartAt: true } as const;

  const cutoffDate = new Date(Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000);

  const hasMessagingPlatform = {
    OR: [{ telegramId: { not: null } }, { whatsappPhone: { not: null } }, { whatsappBsuid: { not: null } }],
  };

  // Use reminderStartAt if set (admin reset), otherwise createdAt
  const isWithinWindow = {
    OR: [
      { reminderStartAt: { gte: cutoffDate } },
      { reminderStartAt: null, createdAt: { gte: cutoffDate } },
    ],
  };

  function getReminderStart(user: { reminderStartAt: Date | null; createdAt: Date }): Date {
    return user.reminderStartAt ?? user.createdAt;
  }

  // 1. The Google tracks, at any account age: a token with no chosen calendars (choose
  // calendars), or a legacy Google user with no token while calendars are stored (reconnect;
  // a FamCal user's stale choices with no token are none, liveGoogleChoices). Their days count
  // from the day this run first sees the state. The token is read only for being set.
  // Like the summary and reminder runs, skip a user who blocked the bot: a failed send records
  // no attempt, so it would be tried (and fail) again every day.
  const googleTrackUsers = await prisma.user.findMany({
    where: {
      suspendedAt: null,
      unreachableSince: null,
      AND: [hasMessagingPlatform, { OR: tracks.GOOGLE_NUDGE_WHERE }],
    },
    select: { ...userSelect, googleRefreshToken: true, calendarSource: true, calendarAssignments: true },
  });

  for (const user of googleTrackUsers) {
    const track = tracks.googleTrackOf(googleStateOf(user));
    if (!track) continue;
    try {
      const start = await tracks.googleTrackStart(user.id, track);
      const attempt = tracks.dueAttempt(tracks.daysSince(start), SETUP_SCHEDULES[track]);
      if (attempt === null) continue;

      const alreadySent = await redis.get(REDIS_KEYS.setupReminder(user.id, track, attempt));
      if (alreadySent) continue;

      const t = await getBotCopy(user.language || 'en');
      const userParam = `user_id=${user.telegramId ?? user.id}`;
      if (track === 'calendars') {
        const copy = t.setupReminders.calendars;
        const body = pickBody(copy, attempt, SETUP_SCHEDULES.calendars.length);
        const calendarsUrl = buildUrl(`/${user.language || 'en'}/select-calendars?${userParam}`);
        await sendSetupReminder(user, copy.title, body, copy.button, calendarsUrl, track, attempt, tracks.GOOGLE_TRACK_TTL_SECONDS);
      } else {
        // The summary's token copy and refresh button: /refresh-token picks the language itself
        const refreshUrl = buildUrl(`/refresh-token?${userParam}`);
        await sendSetupReminder(user, t.tokenExpired.title, t.tokenExpired.message, t.buttons.refreshGoogle, refreshUrl, track, attempt, tracks.GOOGLE_TRACK_TTL_SECONDS);
      }
    } catch (error) {
      captureError(error, 'cron-setup-reminders', { user_id: user.id, track }, 'warning');
      results.push({
        type: track, userId: user.id, name: user.name, attempt: -1,
        success: false, error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // 2. Location reminders, from signup, for everyone without one (FamCal is everyone's).
  const needsLocationUsers = await prisma.user.findMany({
    where: {
      ...isWithinWindow,
      location: '',
      suspendedAt: null,
      unreachableSince: null,
      AND: hasMessagingPlatform,
    },
    select: dateSelect,
  });

  for (const user of needsLocationUsers) {
    try {
      const daysSinceSignup = tracks.daysSince(getReminderStart(user));
      const attempt = tracks.dueAttempt(daysSinceSignup, SETUP_SCHEDULES.location);
      if (attempt === null) continue;

      const alreadySent = await redis.get(REDIS_KEYS.setupReminder(user.id, 'location', attempt));
      if (alreadySent) continue;

      const t = (await getBotCopy(user.language || 'en')).setupReminders;
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.telegramId ?? user.id}`);
      await sendSetupReminder(user, t.location.title, t.location.body, t.location.button, settingsUrl, 'location', attempt, tracks.LOCATION_ATTEMPT_TTL_SECONDS);
    } catch (error) {
      captureError(error, 'cron-setup-reminders', { user_id: user.id, track: 'location' }, 'warning');
      results.push({
        type: 'location', userId: user.id, name: user.name, attempt: -1,
        success: false, error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  console.log(`[Setup Reminders] Sent ${successCount} reminders (${failCount} failed)`);

  if (successCount > 0) {
    try {
      const { notifyAdminWarning } = await import('../utils/error-notifier');
      const formatUserList = (type: ReminderResult['type']) => {
        const users = results.filter(r => r.type === type && r.success);
        if (users.length === 0) return null;
        const userNames = users.map(r => `• ${r.name} (attempt ${r.attempt + 1})`).join('\n');
        return `${type.charAt(0).toUpperCase() + type.slice(1)} (${users.length}):\n${userNames}`;
      };
      const details = [
        formatUserList('calendars'),
        formatUserList('reconnect'),
        formatUserList('location'),
      ].filter(Boolean).join('\n\n');
      await notifyAdminWarning(
        'Setup Reminders Sent',
        `Sent ${successCount} setup reminder(s) to incomplete users.\n\n${details}`
      );
    } catch (notifyError) {
      console.error('[Setup Reminders] Failed to notify admin:', notifyError);
      captureError(notifyError, 'cron-setup-reminders-notify', undefined, 'warning');
    }
  }

  return {
    success: true,
    message: `Sent ${successCount} setup reminders`,
    remindersSent: successCount,
    remindersFailed: failCount,
    details: {
      calendars: results.filter(r => r.type === 'calendars').length,
      reconnect: results.filter(r => r.type === 'reconnect').length,
      location: results.filter(r => r.type === 'location').length,
    },
  };
}

/**
 * Daily purge of UserActivity rows older than the retention (90 days). Logs how many it deleted.
 */
export async function handleActivityPurge(): Promise<CronResult> {
  const { purgeOldActivity, ACTIVITY_RETENTION_DAYS } = await import('../services/analytics-service');
  const deleted = await purgeOldActivity();
  console.log(`[ActivityPurge] Deleted ${deleted} activity rows older than ${ACTIVITY_RETENTION_DAYS} days`);
  return { success: true, message: `deleted ${deleted}`, deleted };
}

/**
 * Health check handler
 * Checks database connection and processes subscription reminders
 */
export async function handleHealth(): Promise<CronResult> {
  const checks: Record<string, 'ok' | 'error'> = {};
  let healthy = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
    healthy = false;
  }

  const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'DATABASE_URL',
  ];

  const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingEnvVars.length > 0) {
    checks.environment = 'error';
    healthy = false;
  } else {
    checks.environment = 'ok';
  }

  // Process subscription reminders
  const { processSubscriptionReminders } = await import('../services/subscription-reminders');
  processSubscriptionReminders().catch(err => {
    console.error('[Health] Subscription reminder error:', err);
    captureError(err, 'cron-health-subscription-reminders', undefined, 'warning');
  });

  return {
    success: healthy,
    message: healthy ? 'healthy' : 'unhealthy',
    status: healthy ? 'healthy' : 'unhealthy',
    checks,
  };
}
