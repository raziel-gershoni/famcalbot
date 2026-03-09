/**
 * Cron job handler functions
 * Called both from the scheduler (node-cron) and from API routes
 */

import { prisma } from '../utils/prisma';

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

  const OAUTH_REMINDER_DAY = 2;
  const CALENDARS_REMINDER_DAY = 5;
  const LOCATION_REMINDER_DAY = 8;

  interface ReminderResult {
    type: 'oauth' | 'calendars' | 'location';
    userId: number;
    telegramId: bigint;
    name: string;
    success: boolean;
    error?: string;
  }

  async function getBotMessages(language: string) {
    const { default: messages } = await import(`@/messages/${language}.json`);
    return messages.bot.setupReminders;
  }

  function getDateRangeForDay(daysAgo: number): { start: Date; end: Date } {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - daysAgo);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  const results: ReminderResult[] = [];
  const { getMessagingService } = await import('../services/telegram');
  const { MessageFormat } = await import('../services/messaging/types');
  const messagingService = getMessagingService();

  // 1. OAuth reminders
  const oauthWindow = getDateRangeForDay(OAUTH_REMINDER_DAY);
  const needsOAuthUsers = await prisma.user.findMany({
    where: {
      createdAt: { gte: oauthWindow.start, lte: oauthWindow.end },
      googleRefreshToken: '',
      telegramId: { not: null },
    },
    select: { id: true, telegramId: true, language: true, name: true },
  });

  for (const user of needsOAuthUsers) {
    try {
      const t = await getBotMessages(user.language || 'en');
      const dashboardUrl = buildUrl(`/${user.language || 'en'}/dashboard?user_id=${user.telegramId}`);
      await messagingService.sendMessage(Number(user.telegramId),
        `${t.oauth.title}\n\n${t.oauth.body}`,
        {
          format: MessageFormat.HTML,
          replyMarkup: {
            inline_keyboard: [[
              { text: t.oauth.button, web_app: { url: dashboardUrl } }
            ]]
          }
        }
      );
      results.push({ type: 'oauth', userId: user.id, telegramId: user.telegramId!, name: user.name, success: true });
    } catch (error) {
      results.push({
        type: 'oauth', userId: user.id, telegramId: user.telegramId!, name: user.name,
        success: false, error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // 2. Calendars reminders
  const calendarsWindow = getDateRangeForDay(CALENDARS_REMINDER_DAY);
  const needsCalendarsUsers = await prisma.user.findMany({
    where: {
      createdAt: { gte: calendarsWindow.start, lte: calendarsWindow.end },
      googleRefreshToken: { not: '' },
      OR: [
        { calendarAssignments: { equals: Prisma.JsonNull } },
        { calendarAssignments: { equals: Prisma.DbNull } },
        { calendarAssignments: { equals: [] } },
      ],
      telegramId: { not: null },
    },
    select: { id: true, telegramId: true, language: true, name: true },
  });

  for (const user of needsCalendarsUsers) {
    try {
      const t = await getBotMessages(user.language || 'en');
      const calendarsUrl = buildUrl(`/${user.language || 'en'}/select-calendars?user_id=${user.telegramId}`);
      await messagingService.sendMessage(Number(user.telegramId),
        `${t.calendars.title}\n\n${t.calendars.body}`,
        {
          format: MessageFormat.HTML,
          replyMarkup: {
            inline_keyboard: [[
              { text: t.calendars.button, web_app: { url: calendarsUrl } }
            ]]
          }
        }
      );
      results.push({ type: 'calendars', userId: user.id, telegramId: user.telegramId!, name: user.name, success: true });
    } catch (error) {
      results.push({
        type: 'calendars', userId: user.id, telegramId: user.telegramId!, name: user.name,
        success: false, error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // 3. Location reminders
  const locationWindow = getDateRangeForDay(LOCATION_REMINDER_DAY);
  const needsLocationUsers = await prisma.user.findMany({
    where: {
      createdAt: { gte: locationWindow.start, lte: locationWindow.end },
      googleRefreshToken: { not: '' },
      location: '',
      telegramId: { not: null },
    },
    select: { id: true, telegramId: true, language: true, name: true, calendarAssignments: true },
  });

  const locationUsersFiltered = needsLocationUsers.filter(u => {
    const assignments = u.calendarAssignments as unknown[];
    return Array.isArray(assignments) && assignments.length > 0;
  });

  for (const user of locationUsersFiltered) {
    try {
      const t = await getBotMessages(user.language || 'en');
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.telegramId}`);
      await messagingService.sendMessage(Number(user.telegramId),
        `${t.location.title}\n\n${t.location.body}`,
        {
          format: MessageFormat.HTML,
          replyMarkup: {
            inline_keyboard: [[
              { text: t.location.button, web_app: { url: settingsUrl } }
            ]]
          }
        }
      );
      results.push({ type: 'location', userId: user.id, telegramId: user.telegramId!, name: user.name, success: true });
    } catch (error) {
      results.push({
        type: 'location', userId: user.id, telegramId: user.telegramId!, name: user.name,
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
        const userNames = users.map(r => `• ${r.name}`).join('\n');
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
  processSubscriptionReminders().catch(err =>
    console.error('[Health] Subscription reminder error:', err)
  );

  return {
    success: healthy,
    message: healthy ? 'healthy' : 'unhealthy',
    status: healthy ? 'healthy' : 'unhealthy',
    checks,
  };
}
