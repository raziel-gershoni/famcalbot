/**
 * Cron job handler functions
 * Called both from the scheduler (node-cron) and from API routes
 */

import { prisma } from '../utils/prisma';
import { captureError } from '../lib/error-capture';

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
  const summaryResult = await sendDailySummaryToAll({ filterByHour: true });

  // Sync reminder cache from DB (piggyback on existing run)
  try {
    const { syncReminderCache, setGlobalRemindersEnabled } = await import('../services/reminder-cache');
    const { safeDecrypt } = await import('../utils/encryption');

    const users = await prisma.user.findMany({
      where: {
        remindersEnabled: true,
        googleRefreshToken: { not: '' },
        telegramId: { not: null },
      },
      select: {
        id: true,
        telegramId: true,
        googleRefreshToken: true,
        calendarAssignments: true,
        defaultReminderMinutes: true,
        pickupRemindersEnabled: true,
        language: true,
        name: true,
      }
    });

    const reminderUsers = users.map(u => ({
      id: u.id,
      telegramId: u.telegramId?.toString() ?? '',
      googleRefreshToken: safeDecrypt(u.googleRefreshToken),
      calendarAssignments: u.calendarAssignments,
      defaultReminderMinutes: u.defaultReminderMinutes,
      language: u.language,
      name: u.name,
      pickupRemindersEnabled: u.pickupRemindersEnabled ?? true,
    }));

    await syncReminderCache(reminderUsers);

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

  return {
    success: true,
    message: 'Daily summaries sent successfully',
    processed: summaryResult.processed,
    skippedHour: summaryResult.skippedHour,
    skippedDedup: summaryResult.skippedDedup,
  };
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

  let totalRemindersSent = 0;
  let usersProcessed = 0;
  const errors: string[] = [];

  for (const cachedUser of cachedUsers) {
    try {
      const user = {
        id: cachedUser.id,
        telegramId: parseInt(cachedUser.telegramId, 10),
        name: cachedUser.name,
        language: cachedUser.language,
        googleRefreshToken: cachedUser.googleRefreshToken,
        calendarAssignments: cachedUser.calendarAssignments,
        defaultReminderMinutes: cachedUser.defaultReminderMinutes ?? undefined,
        remindersEnabled: true,
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

/**
 * Setup reminders handler
 * Sends reminders to users who haven't completed their setup flow
 */
export async function handleSetupReminders(): Promise<CronResult> {
  const { buildUrl } = await import('../config/urls');
  const { Prisma } = await import('@prisma/client');
  const { redis } = await import('../utils/redis');
  const { REDIS_KEYS } = await import('../config/redis-keys');

  // Multi-attempt schedules: days after signup when each reminder is sent
  const OAUTH_SCHEDULE = [1, 3, 7, 14];    // 4 attempts
  const CALENDARS_SCHEDULE = [3, 6, 10];    // 3 attempts (only if OAuth done)
  const LOCATION_SCHEDULE = [5, 10];        // 2 attempts (only if calendars done)
  const MAX_DAYS = 14;                      // Stop looking after 14 days
  const REMINDER_TTL = 30 * 24 * 3600;     // 30-day TTL for Redis keys

  interface ReminderResult {
    type: 'oauth' | 'calendars' | 'location';
    userId: number;
    name: string;
    attempt: number;
    success: boolean;
    error?: string;
  }

  async function getSetupMessages(language: string) {
    const { default: messages } = await import(`@/messages/${language}.json`);
    return messages.bot.setupReminders;
  }

  // Pick the right message body based on attempt number
  function pickBody(messages: { body: string; bodyReminder?: string; bodyFinal?: string }, attempt: number, maxAttempts: number): string {
    if (attempt >= maxAttempts - 1 && messages.bodyFinal) return messages.bodyFinal;
    if (attempt > 0 && messages.bodyReminder) return messages.bodyReminder;
    return messages.body;
  }

  // Determine which attempt is due for a user given days since signup
  function getDueAttempt(daysSinceSignup: number, schedule: number[]): number | null {
    for (let i = schedule.length - 1; i >= 0; i--) {
      if (daysSinceSignup >= schedule[i]) return i;
    }
    return null;
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
    type: ReminderResult['type'], attempt: number
  ): Promise<void> {
    const message = `${title}\n\n${body}`;

    // Send to Telegram
    if (user.telegramId) {
      await tgService.sendMessage(Number(user.telegramId), message, {
        format: MessageFormat.HTML,
        replyMarkup: { inline_keyboard: [[{ text: buttonText, web_app: { url } }]] },
      });
    }

    // Send to WhatsApp (if WA-only)
    const waChatId = user.whatsappPhone || user.whatsappBsuid;
    if (waChatId && !user.telegramId) {
      const { generateMagicLink } = await import('../services/magic-link');
      const { buildWhatsAppTemplate } = await import('../services/messaging/whatsapp-template');
      const settingsUrl = await generateMagicLink(user.id, user.language || 'en');
      const template = buildWhatsAppTemplate(message, user.language || 'en', settingsUrl);
      const waService = getWhatsAppService();
      await waService.sendMessage(waChatId, message, {
        format: MessageFormat.HTML,
        whatsappTemplate: template,
      });
    }

    // Mark this attempt as sent in Redis
    await redis.set(REDIS_KEYS.setupReminder(user.id, type, attempt), '1', { ex: REMINDER_TTL });
    results.push({ type, userId: user.id, name: user.name, attempt, success: true });
  }

  const userSelect = {
    id: true, telegramId: true, whatsappPhone: true, whatsappBsuid: true, language: true, name: true,
  } as const;
  const dateSelect = { ...userSelect, createdAt: true, reminderStartAt: true } as const;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_DAYS);

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

  // 1. OAuth reminders — users within reminder window without Google connected
  const needsOAuthUsers = await prisma.user.findMany({
    where: {
      ...isWithinWindow,
      googleRefreshToken: '',
      ...hasMessagingPlatform,
    },
    select: dateSelect,
  });

  for (const user of needsOAuthUsers) {
    try {
      const daysSinceSignup = Math.floor((Date.now() - getReminderStart(user).getTime()) / (1000 * 60 * 60 * 24));
      const dueAttempt = getDueAttempt(daysSinceSignup, OAUTH_SCHEDULE);
      if (dueAttempt === null) continue;

      // Check if this attempt was already sent
      const alreadySent = await redis.get(REDIS_KEYS.setupReminder(user.id, 'oauth', dueAttempt));
      if (alreadySent) continue;

      const t = await getSetupMessages(user.language || 'en');
      const body = pickBody(t.oauth, dueAttempt, OAUTH_SCHEDULE.length);
      const dashboardUrl = buildUrl(`/${user.language || 'en'}/dashboard?user_id=${user.id}`);
      await sendSetupReminder(user, t.oauth.title, body, t.oauth.button, dashboardUrl, 'oauth', dueAttempt);
    } catch (error) {
      results.push({
        type: 'oauth', userId: user.id, name: user.name, attempt: -1,
        success: false, error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // 2. Calendars reminders — users with OAuth but no calendars selected
  const needsCalendarsUsers = await prisma.user.findMany({
    where: {
      ...isWithinWindow,
      googleRefreshToken: { not: '' },
      OR: [
        { calendarAssignments: { equals: Prisma.JsonNull } },
        { calendarAssignments: { equals: Prisma.DbNull } },
        { calendarAssignments: { equals: [] } },
      ],
      AND: hasMessagingPlatform,
    },
    select: dateSelect,
  });

  for (const user of needsCalendarsUsers) {
    try {
      const daysSinceSignup = Math.floor((Date.now() - getReminderStart(user).getTime()) / (1000 * 60 * 60 * 24));
      const dueAttempt = getDueAttempt(daysSinceSignup, CALENDARS_SCHEDULE);
      if (dueAttempt === null) continue;

      const alreadySent = await redis.get(REDIS_KEYS.setupReminder(user.id, 'calendars', dueAttempt));
      if (alreadySent) continue;

      const t = await getSetupMessages(user.language || 'en');
      const body = pickBody(t.calendars, dueAttempt, CALENDARS_SCHEDULE.length);
      const calendarsUrl = buildUrl(`/${user.language || 'en'}/select-calendars?user_id=${user.id}`);
      await sendSetupReminder(user, t.calendars.title, body, t.calendars.button, calendarsUrl, 'calendars', dueAttempt);
    } catch (error) {
      results.push({
        type: 'calendars', userId: user.id, name: user.name, attempt: -1,
        success: false, error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // 3. Location reminders — users with OAuth + calendars but no location
  const needsLocationUsers = await prisma.user.findMany({
    where: {
      ...isWithinWindow,
      googleRefreshToken: { not: '' },
      location: '',
      ...hasMessagingPlatform,
    },
    select: { ...dateSelect, calendarAssignments: true },
  });

  const locationUsersFiltered = needsLocationUsers.filter(u => {
    const assignments = u.calendarAssignments as unknown[];
    return Array.isArray(assignments) && assignments.length > 0;
  });

  for (const user of locationUsersFiltered) {
    try {
      const daysSinceSignup = Math.floor((Date.now() - getReminderStart(user).getTime()) / (1000 * 60 * 60 * 24));
      const dueAttempt = getDueAttempt(daysSinceSignup, LOCATION_SCHEDULE);
      if (dueAttempt === null) continue;

      const alreadySent = await redis.get(REDIS_KEYS.setupReminder(user.id, 'location', dueAttempt));
      if (alreadySent) continue;

      const t = await getSetupMessages(user.language || 'en');
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.id}`);
      await sendSetupReminder(user, t.location.title, t.location.body, t.location.button, settingsUrl, 'location', dueAttempt);
    } catch (error) {
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
        formatUserList('oauth'),
        formatUserList('calendars'),
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
      oauth: results.filter(r => r.type === 'oauth').length,
      calendars: results.filter(r => r.type === 'calendars').length,
      location: results.filter(r => r.type === 'location').length,
    },
  };
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
