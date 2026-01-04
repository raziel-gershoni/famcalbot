/**
 * Setup Reminders Cron API
 * Sends reminders to users who haven't completed their setup flow
 *
 * Uses account age windows to ensure each reminder is sent only once:
 * - Day 2: OAuth reminder (if still needs Google connection)
 * - Day 5: Calendars reminder (if has OAuth but no calendars)
 * - Day 8: Location reminder (if has calendars but no location for weather)
 */

import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { Prisma } from '@prisma/client';
import { buildUrl } from '@/src/config/urls';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Reminder windows (in days since account creation)
const OAUTH_REMINDER_DAY = 2;
const CALENDARS_REMINDER_DAY = 5;
const LOCATION_REMINDER_DAY = 8;

interface ReminderResult {
  type: 'oauth' | 'calendars' | 'location';
  userId: number;
  telegramId: bigint;
  success: boolean;
  error?: string;
}

async function getBotMessages(language: string) {
  const { default: messages } = await import(`@/messages/${language}.json`);
  return messages.bot.setupReminders;
}

function getDateRangeForDay(daysAgo: number): { start: Date; end: Date } {
  const now = new Date();

  // Start of the target day (daysAgo days back, at 00:00:00)
  const start = new Date(now);
  start.setDate(start.getDate() - daysAgo);
  start.setHours(0, 0, 0, 0);

  // End of the target day (daysAgo days back, at 23:59:59)
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

export async function GET(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Setup Reminders',
    handler: async () => {
      const results: ReminderResult[] = [];

      const { getMessagingService } = await import('@/src/services/telegram');
      const { MessageFormat } = await import('@/src/services/messaging/types');
      const messagingService = getMessagingService();

      // 1. OAuth reminders - accounts created exactly OAUTH_REMINDER_DAY days ago, still need OAuth
      const oauthWindow = getDateRangeForDay(OAUTH_REMINDER_DAY);
      const needsOAuthUsers = await withDbRetry(
        () => prisma.user.findMany({
          where: {
            createdAt: { gte: oauthWindow.start, lte: oauthWindow.end },
            googleRefreshToken: '',
            telegramId: { not: null },
          },
          select: { id: true, telegramId: true, language: true },
        }),
        'setupReminders.needsOAuth'
      );

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

          results.push({ type: 'oauth', userId: user.id, telegramId: user.telegramId!, success: true });
        } catch (error) {
          results.push({
            type: 'oauth',
            userId: user.id,
            telegramId: user.telegramId!,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // 2. Calendars reminders - accounts created exactly CALENDARS_REMINDER_DAY days ago, have OAuth but no calendars
      const calendarsWindow = getDateRangeForDay(CALENDARS_REMINDER_DAY);
      const needsCalendarsUsers = await withDbRetry(
        () => prisma.user.findMany({
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
          select: { id: true, telegramId: true, language: true },
        }),
        'setupReminders.needsCalendars'
      );

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

          results.push({ type: 'calendars', userId: user.id, telegramId: user.telegramId!, success: true });
        } catch (error) {
          results.push({
            type: 'calendars',
            userId: user.id,
            telegramId: user.telegramId!,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // 3. Location reminders - accounts created exactly LOCATION_REMINDER_DAY days ago, have calendars but no location
      const locationWindow = getDateRangeForDay(LOCATION_REMINDER_DAY);
      const needsLocationUsers = await withDbRetry(
        () => prisma.user.findMany({
          where: {
            createdAt: { gte: locationWindow.start, lte: locationWindow.end },
            googleRefreshToken: { not: '' },
            location: '',
            telegramId: { not: null },
          },
          select: { id: true, telegramId: true, language: true, calendarAssignments: true },
        }),
        'setupReminders.needsLocation'
      );

      // Filter to users who have non-empty calendar assignments (checking in code since Prisma JSON queries are tricky)
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

          results.push({ type: 'location', userId: user.id, telegramId: user.telegramId!, success: true });
        } catch (error) {
          results.push({
            type: 'location',
            userId: user.id,
            telegramId: user.telegramId!,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      console.log(`[Setup Reminders] Sent ${successCount} reminders (${failCount} failed)`);

      // Notify admin about sent reminders
      if (successCount > 0) {
        try {
          const { notifyAdminWarning } = await import('@/src/utils/error-notifier');
          const oauthCount = results.filter(r => r.type === 'oauth' && r.success).length;
          const calendarsCount = results.filter(r => r.type === 'calendars' && r.success).length;
          const locationCount = results.filter(r => r.type === 'location' && r.success).length;

          const details = [
            oauthCount > 0 ? `OAuth: ${oauthCount}` : null,
            calendarsCount > 0 ? `Calendars: ${calendarsCount}` : null,
            locationCount > 0 ? `Location: ${locationCount}` : null,
          ].filter(Boolean).join(', ');

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
  });
}
