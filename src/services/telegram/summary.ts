/**
 * Telegram summary generation and delivery functions
 */

import { getUserByTelegramId, getAllUsers } from '../user-service';
import { fetchTodayEvents, fetchTomorrowEvents } from '../calendar';
import { generateSummary, SummaryUserContext, formatDateHeader } from '../claude';
import { CalendarEvent, UserConfig } from '../../types';
import { IMessagingService, getMessagingService as getMessagingServiceByPlatform, MessagingPlatform, MessageFormat } from '../messaging';
import { getCalendarsByLabel, getPrimaryCalendar, getSpouseInfo } from '../../utils/calendar-helpers';
import { ProgressType } from '../progress-message';
import { buildUrl } from '../../config/urls';
import { executeCommand } from './command-pipeline';
import { getBotMessages, getBotMessage } from '../../lib/bot-messages';
import { trackActivityAsync } from '../analytics-service';
import { checkFeatureAccess, incrementUsage } from '../subscription-service';
import { captureError } from '../../lib/error-capture';
import { getBot, getMessagingService } from './bot';
import { sendVoiceMessage } from './voice';

/**
 * Categorize events by ownership for a specific user
 */
export function categorizeEvents(events: CalendarEvent[], user: UserConfig) {
  const ownCalendars = user.calendarAssignments
    ? getCalendarsByLabel(user.calendarAssignments, 'yours')
    : [];
  const spouseCalendars = user.calendarAssignments
    ? getCalendarsByLabel(user.calendarAssignments, 'spouse')
    : [];

  return {
    userEvents: events.filter(e => ownCalendars.includes(e.calendarId)),
    spouseEvents: events.filter(e => spouseCalendars.includes(e.calendarId)),
    otherEvents: events.filter(
      e => !ownCalendars.includes(e.calendarId) && !spouseCalendars.includes(e.calendarId)
    ),
  };
}

/**
 * Shared summary preparation logic - used by both user-invoked and scheduled flows
 */
interface PreparedSummary {
  summary: string;
  dateHeader: string;
}

async function prepareSummaryForUser(
  user: UserConfig,
  fetchFunction: (refreshToken: string, calendarIds: string[], timezone?: string) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined,
  modelId?: string
): Promise<PreparedSummary> {
  const t0 = Date.now();

  // Resolve user's timezone early for consistent use throughout
  const tTimezone = Date.now();
  const { resolveUserTimezone } = await import('../../lib/timezone');
  const userTimezone = await resolveUserTimezone(user);
  const timezoneMs = Date.now() - tTimezone;

  // Extract all calendar IDs from assignments
  const allCalendarIds = user.calendarAssignments?.map(a => a.calendarId) || [];

  // Fetch calendar events with user's timezone
  const tCalendar = Date.now();
  const events = await fetchFunction(user.googleRefreshToken, allCalendarIds, userTimezone);
  const calendarMs = Date.now() - tCalendar;

  // Categorize events by ownership
  const tCategorize = Date.now();
  const categorized = categorizeEvents(events, user);
  const categorizeMs = Date.now() - tCategorize;

  // Extract primary calendar ID
  const primaryCalendar = user.calendarAssignments
    ? getPrimaryCalendar(user.calendarAssignments) || ''
    : '';

  // Get spouse info from calendar assignment or legacy fields
  const spouseInfo = getSpouseInfo(user);

  // Build user context for summary generation
  const userContext: SummaryUserContext = {
    culture: user.culture,
    globalRules: user.globalRules,
    calendarAssignments: user.calendarAssignments,
  };

  // Fetch week lookahead if enabled for tomorrow summary
  let weekLookaheadText: string | undefined;
  let lookaheadMs = 0;
  if (summaryDate && user.includeLookaheadInTomorrow) {
    const tLookahead = Date.now();
    try {
      const { getWeekLookahead } = await import('../week-lookahead');
      const lookahead = await getWeekLookahead(user, user.calendarAssignments || [], summaryDate);

      if (lookahead.events.length > 0) {
        weekLookaheadText = lookahead.events
          .filter(e => e.daysFromNow > 1)
          .map(e => {
            const dayName = e.start.toLocaleDateString('en-US', { weekday: 'long', timeZone: userTimezone });
            const time = e.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: userTimezone });
            return `${dayName}: ${e.summary} at ${time} (${e.calendarName})`;
          })
          .join('\n');
      }
    } catch (error) {
      console.error('Failed to fetch week lookahead:', error);
    }
    lookaheadMs = Date.now() - tLookahead;
  }

  // Generate summary with AI
  const tAI = Date.now();
  const summary = await generateSummary(
    categorized.userEvents,
    categorized.spouseEvents,
    categorized.otherEvents,
    user.name,
    user.englishName,
    user.gender,
    spouseInfo?.name,
    spouseInfo?.englishName,
    spouseInfo?.gender,
    primaryCalendar,
    summaryDate,
    user.isAdmin,
    modelId,
    user.location,
    user.language,
    userContext,
    user.weatherEnabled,
    weekLookaheadText,
    userTimezone
  );
  const aiMs = Date.now() - tAI;

  // Generate date header for voice-only delivery
  const dateHeader = formatDateHeader(
    summaryDate || new Date(),
    user.language,
    user.culture,
    userTimezone
  );

  const totalMs = Date.now() - t0;
  console.log(`[Summary Timing] user=${user.telegramId} type=${summaryDate ? 'tomorrow' : 'today'} total=${totalMs}ms timezone=${timezoneMs}ms calendar=${calendarMs}ms categorize=${categorizeMs}ms lookahead=${lookaheadMs}ms ai=${aiMs}ms`);

  return { summary, dateHeader };
}

/**
 * Generic function to send summary to a specific user
 */
export async function sendSummaryToUser(
  userId: number,
  fetchFunction: (refreshToken: string, calendarIds: string[], timezone?: string) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined,
  errorKey: string,
  modelId?: string,
  existingProgressMessageId?: number
): Promise<void> {
  const user = await getUserByTelegramId(userId);
  if (!user) {
    console.error(`User with Telegram ID ${userId} not found`);
    return;
  }

  const messagingService = getMessagingService();

  // Determine progress type based on date
  const progressType: ProgressType = summaryDate ? 'summaryTomorrow' : 'summary';
  const userLanguage = user.language || 'en';

  // Track summary request
  trackActivityAsync(user.id, 'text_summary_requested', {
    summary_type: summaryDate ? 'tomorrow' : 'today',
    language: userLanguage,
    calendar_count: user.calendarAssignments?.length || 0,
  });

  // Check feature access for text summaries
  const textAccess = await checkFeatureAccess(user.id, 'text_summary');
  if (!textAccess.allowed) {
    const t = await getBotMessages(userLanguage);
    const upgradeUrl = buildUrl(`/${userLanguage}/subscription?user_id=${userId}`);
    const limitMessage = t.subscription?.textLimitReached
      || '📊 You\'ve reached your monthly text summary limit. Upgrade to continue!';

    await messagingService.sendMessage(userId, limitMessage, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.subscription?.upgradeButton || '⭐ Upgrade Plan', web_app: { url: upgradeUrl } },
        ]],
      },
    });
    return;
  }

  await executeCommand({
    chatId: userId,
    progressType,
    language: userLanguage,
    existingProgressMessageId,
    messagingService,
    errorKey,
    commandName: 'Summary Generation',
    context: `User: ${userId}, Date: ${summaryDate ? summaryDate.toISOString() : 'today'}`,
    operation: async () => {
      return prepareSummaryForUser(user, fetchFunction, summaryDate, modelId);
    },
    onSuccess: async (result, messageId) => {
      await deliverSummary({
        userId,
        summary: result.summary,
        user,
        progressMessageId: messageId,
        dateHeader: result.dateHeader,
      });
    },
    onError: async (error, messageId) => {
      // Handle Google-specific errors that need special UI treatment
      if (error.message === 'GOOGLE_INSUFFICIENT_SCOPES') {
        const t = await getBotMessages(userLanguage);
        const refreshUrl = buildUrl(`/refresh-token?user_id=${userId}`);
        const scopesMessage = `${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`;
        await messagingService.updateMessage(userId, messageId, scopesMessage, {
          format: MessageFormat.HTML
        });
        await messagingService.sendMessage(userId, t.insufficientScopes.tapToRefresh, {
          replyMarkup: {
            inline_keyboard: [[
              { text: t.buttons.refreshGoogle, web_app: { url: refreshUrl } }
            ]]
          }
        });

        const { clearGoogleRefreshToken } = await import('../user-service');
        await clearGoogleRefreshToken(BigInt(userId));

        const { notifyAdminWarning } = await import('../../utils/error-notifier');
        await notifyAdminWarning(
          'Insufficient Scopes',
          `User ${userId} has a token with insufficient scopes. Token cleared, awaiting re-authorization.`
        );
        return true; // handled
      }

      if (error.message === 'GOOGLE_TOKEN_EXPIRED') {
        const t = await getBotMessages(userLanguage);
        const refreshUrl = buildUrl(`/refresh-token?user_id=${userId}`);
        const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;
        await messagingService.updateMessage(userId, messageId, expiredMessage, {
          format: MessageFormat.HTML
        });
        await messagingService.sendMessage(userId, t.tokenExpired.tapToRefresh, {
          replyMarkup: {
            inline_keyboard: [[
              { text: t.buttons.refreshGoogle, web_app: { url: refreshUrl } }
            ]]
          }
        });

        const { notifyAdminWarning } = await import('../../utils/error-notifier');
        await notifyAdminWarning(
          'Token Expired',
          `User ${userId} needs to refresh their Google Calendar token`
        );
        return true; // handled
      }

      return false; // not handled, let pipeline show default error
    },
  });
}

/** Result counts from batch summary delivery */
export interface SummaryBatchResult {
  processed: number;
  skippedHour: number;
  skippedDedup: number;
}

/**
 * Generic function to send summary to all users
 */
async function sendSummaryToAll(
  fetchFunction: (refreshToken: string, calendarIds: string[], timezone?: string) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined,
  options?: { filterByHour?: boolean }
): Promise<SummaryBatchResult> {
  const messagingService = getMessagingService();
  const result: SummaryBatchResult = { processed: 0, skippedHour: 0, skippedDedup: 0 };

  try {
    const allUsers = await getAllUsers();
    if (allUsers.length === 0) {
      console.error('No users configured');
      return result;
    }

    // Filter by preferred hour if requested (hourly cron mode)
    let users = allUsers;
    if (options?.filterByHour) {
      const { filterUsersForSummary } = await import('../../lib/summary-scheduling');
      const summaryType = summaryDate ? 'tomorrow' : 'daily';
      const filtered = await filterUsersForSummary(allUsers, summaryType);
      users = filtered.eligible;
      result.skippedHour = filtered.skippedHour;
      result.skippedDedup = filtered.skippedDedup;

      console.log(`[Summary] Hourly filter: ${users.length} eligible, ${filtered.skippedHour} skipped (hour), ${filtered.skippedDedup} skipped (dedup)`);
    }

    for (const user of users) {
      const platform = user.messagingPlatform || 'telegram';

      const hasToken = !!user.googleRefreshToken;
      const hasCalendars = user.calendarAssignments && user.calendarAssignments.length > 0;
      const hasLocation = !!user.location;

      if (!hasToken) {
        console.log(`[Summary] Skipping user ${user.telegramId}: No Google token`);
        continue;
      }

      if (!hasCalendars && !hasLocation) {
        console.log(`[Summary] Skipping user ${user.telegramId}: No calendars or location`);
        continue;
      }

      if (!hasCalendars && hasLocation && user.weatherEnabled) {
        try {
          await sendWeatherOnlyToUser(user, summaryDate, platform);
          result.processed++;
          if (options?.filterByHour) {
            const { markSummarySent } = await import('../../lib/summary-scheduling');
            const { resolveUserTimezone } = await import('../../lib/timezone');
            const tz = await resolveUserTimezone(user);
            await markSummarySent(user.id, summaryDate ? 'tomorrow' : 'daily', tz);
          }
        } catch (error) {
          console.error(`[Summary] Failed to send weather-only to user ${user.telegramId}:`, error);
        }
        continue;
      }

      if (!hasCalendars) {
        console.log(`[Summary] Skipping user ${user.telegramId}: No calendars, weather disabled`);
        continue;
      }

      try {
        const tUser = Date.now();
        const { summary, dateHeader } = await prepareSummaryForUser(user, fetchFunction, summaryDate);

        await deliverSummary({
          userId: user.telegramId,
          summary,
          user,
          platform,
          dateHeader
        });

        console.log(`[Batch Summary] user=${user.telegramId} total=${Date.now() - tUser}ms`);
        result.processed++;

        // Mark as sent for dedup
        if (options?.filterByHour) {
          const { markSummarySent } = await import('../../lib/summary-scheduling');
          const { resolveUserTimezone } = await import('../../lib/timezone');
          const tz = await resolveUserTimezone(user);
          await markSummarySent(user.id, summaryDate ? 'tomorrow' : 'daily', tz);
        }
      } catch (error) {
        console.error(`Failed to send summary to user ${user.telegramId}:`, error);

        if (error instanceof Error && error.message === 'GOOGLE_TOKEN_EXPIRED') {
          const t = await getBotMessages(user.language || 'en');
          const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}`);
          const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;

          try {
            if (platform === 'telegram' || platform === 'all') {
              await messagingService.sendMessage(user.telegramId, expiredMessage, {
                format: MessageFormat.HTML,
                replyMarkup: {
                  inline_keyboard: [[
                    { text: t.buttons.refreshGoogle, web_app: { url: refreshUrl } }
                  ]]
                }
              });
            }
            if ((platform === 'whatsapp' || platform === 'all') && user.whatsappPhone) {
              const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
              await whatsappService.sendMessage(user.whatsappPhone, expiredMessage, { format: MessageFormat.HTML });
            }
          } catch (msgError) {
            console.error(`Failed to send token expired message to user ${user.telegramId}:`, msgError);
          }

          const { notifyAdminWarning } = await import('../../utils/error-notifier');
          await notifyAdminWarning(
            'Token Expired',
            `User ${user.telegramId} (${user.name}) needs to refresh their Google Calendar token`
          );
        }
      }
    }
  } catch (error) {
    console.error('Failed to generate summary for all users:', error);

    const { notifyAdminError } = await import('../../utils/error-notifier');
    await notifyAdminError(
      'Batch Summary Generation',
      error,
      `Date: ${summaryDate ? summaryDate.toISOString() : 'today'}`
    );
  }

  return result;
}

/**
 * Send daily summary to a specific user
 */
export async function sendDailySummaryToUser(userId: number, existingProgressMessageId?: number): Promise<void> {
  await sendSummaryToUser(
    userId,
    fetchTodayEvents,
    undefined,
    'calendarFetch',
    undefined,
    existingProgressMessageId
  );
}

/**
 * Send weather-only message to a user
 * Used when user has location set but no calendars configured
 */
async function sendWeatherOnlyToUser(
  user: UserConfig,
  summaryDate: Date | undefined,
  platform: string
): Promise<void> {
  const messagingService = getMessagingService();
  const targetDate = summaryDate || new Date();

  const { getTimezone } = await import('../weather/geocoding');
  const { fetchWeather, getWeatherDescription, getWindDirectionLabel } = await import('../weather/open-meteo');
  const { detectSharav } = await import('../weather/sharav');

  const timezone = await getTimezone(user.location);
  const weatherData = await fetchWeather(user.location, timezone);

  const t = await getBotMessages(user.language || 'en');

  const dateStr = targetDate.toLocaleDateString(user.language === 'he' ? 'he-IL' : user.language === 'ru' ? 'ru-RU' : 'en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  });

  // Wind line when significant
  const windLine = weatherData.current.windSpeed > 20
    ? `\n💨 ${getWindDirectionLabel(weatherData.current.windDirection, user.language)} ${weatherData.current.windSpeed} km/h`
    : '';

  // Sharav warning for today/tomorrow
  const sharavDays = detectSharav(weatherData);
  const nearSharav = sharavDays.filter(s => s.dayIndex <= 1);
  let sharavLine = '';
  if (nearSharav.length > 0) {
    const sharavLabel = user.language === 'he' ? 'שרב' : user.language === 'ru' ? 'Хамсин' : 'Sharav';
    const severityLabels: Record<string, Record<string, string>> = {
      en: { mild: 'mild', moderate: 'moderate', severe: 'severe' },
      he: { mild: 'קל', moderate: 'בינוני', severe: 'חמור' },
      ru: { mild: 'слабый', moderate: 'умеренный', severe: 'сильный' },
    };
    const labels = severityLabels[user.language || 'en'] || severityLabels.en;
    const warnings = nearSharav.map(s => {
      const dayLabel = s.dayIndex === 0
        ? (t.weatherOnly?.today || 'Today')
        : (t.weatherOnly?.tomorrow || 'Tomorrow');
      return `${dayLabel}: ${labels[s.severity]} (${s.tempMax}°C)`;
    }).join(', ');
    sharavLine = `\n\n⚠️ <b>${sharavLabel}:</b> ${warnings}`;
  }

  const weatherMessage = `🌤️ <b>${t.weatherOnly?.title || 'Weather'} - ${dateStr}</b>

<b>${t.weatherOnly?.current || 'Current'}:</b> ${weatherData.current.temperature}°C (${t.weatherOnly?.feelsLike || 'feels like'} ${weatherData.current.feelsLike}°C), ${getWeatherDescription(weatherData.current.weatherCode)}${windLine}

<b>${t.weatherOnly?.today || 'Today'}:</b> ${t.weatherOnly?.high || 'High'} ${weatherData.today.tempMax}°C, ${t.weatherOnly?.low || 'Low'} ${weatherData.today.tempMin}°C, ${weatherData.today.precipitationProbability}% ${t.weatherOnly?.rain || 'rain'}
${weatherData.tomorrow ? `<b>${t.weatherOnly?.tomorrow || 'Tomorrow'}:</b> ${t.weatherOnly?.high || 'High'} ${weatherData.tomorrow.tempMax}°C, ${t.weatherOnly?.low || 'Low'} ${weatherData.tomorrow.tempMin}°C, ${weatherData.tomorrow.precipitationProbability}% ${t.weatherOnly?.rain || 'rain'}` : ''}${sharavLine}`;

  if (platform === 'telegram' || platform === 'all') {
    await messagingService.sendMessage(user.telegramId, weatherMessage, {
      format: MessageFormat.HTML
    });
  }

  console.log(`[Summary] Sent weather-only to user ${user.telegramId}`);
}

/**
 * Send daily summary to all users
 */
export async function sendDailySummaryToAll(options?: { filterByHour?: boolean }): Promise<SummaryBatchResult> {
  return sendSummaryToAll(fetchTodayEvents, undefined, options);
}

/**
 * Send tomorrow's summary to a specific user
 */
export async function sendTomorrowSummaryToUser(userId: number, existingProgressMessageId?: number): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  await sendSummaryToUser(
    userId,
    fetchTomorrowEvents,
    tomorrow,
    'tomorrowFetch',
    undefined,
    existingProgressMessageId
  );
}

/**
 * Send tomorrow's summary to all users
 */
export async function sendTomorrowSummaryToAll(options?: { filterByHour?: boolean }): Promise<SummaryBatchResult> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return sendSummaryToAll(fetchTomorrowEvents, tomorrow, options);
}

/** Platform options for message delivery */
type DeliveryPlatform = 'telegram' | 'whatsapp' | 'all';

/**
 * Route text message to appropriate platform(s)
 */
async function routeTextMessage(
  userId: number,
  text: string,
  user: UserConfig,
  platform?: DeliveryPlatform
): Promise<void> {
  if (!text || text.trim() === '') {
    captureError(
      new Error('Attempted to send empty message'),
      'telegram-delivery',
      { user_id: userId, service: 'routeTextMessage' }
    );
    return;
  }

  const targetPlatform = platform || user.messagingPlatform || 'telegram';
  const msgService = getMessagingService();

  if (targetPlatform === 'telegram' || targetPlatform === 'all') {
    try {
      await msgService.sendMessage(userId, text, { format: MessageFormat.HTML });
    } catch (e) {
      captureError(e, 'telegram-delivery', { user_id: userId, service: 'sendMessage' });
    }
  }

  if ((targetPlatform === 'whatsapp' || targetPlatform === 'all') && user.whatsappPhone) {
    try {
      const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
      await whatsappService.sendMessage(user.whatsappPhone, text, { format: MessageFormat.HTML });
    } catch (e) {
      captureError(e, 'whatsapp-delivery', { user_id: userId, service: 'sendMessage' });
    }
  }
}

/**
 * Delivery options for unified summary delivery
 */
interface DeliveryOptions {
  userId: number;
  summary: string;
  user: UserConfig;
  progressMessageId?: number | string;
  platform?: DeliveryPlatform;
  dateHeader?: string;
}

/**
 * Unified summary delivery pipeline
 * Handles both user-invoked and scheduled summary delivery
 * Respects user text/voice preferences
 */
async function deliverSummary(options: DeliveryOptions): Promise<void> {
  const t0 = Date.now();
  const {
    userId,
    summary,
    user,
    progressMessageId,
    platform,
    dateHeader
  } = options;

  const msgService = getMessagingService();

  // Check for empty summary
  if (!summary || summary.trim() === '') {
    captureError(
      new Error('AI returned empty summary'),
      'summary-generation',
      { user_id: userId, service: 'deliverSummary' }
    );
    if (progressMessageId) {
      await msgService.deleteMessage(userId, progressMessageId);
    }
    const t = await getBotMessages(user.language || 'en');
    await msgService.sendMessage(userId, t.errors?.summaryGenerationFailed || 'Sorry, could not generate summary. Please try again.', { format: MessageFormat.HTML });
    return;
  }

  const sendText = user.textSummaryEnabled !== false;
  const sendVoiceEnabled = user.voiceSummaryEnabled !== false;

  if (!sendText && !sendVoiceEnabled) {
    if (progressMessageId) {
      await msgService.deleteMessage(userId, progressMessageId);
    }
    return;
  }

  // Check near-limit warning for text summaries
  const tFeatureCheck = Date.now();
  let summaryWithWarning = summary;
  try {
    const textAccess = await checkFeatureAccess(user.id, 'text_summary');
    if (textAccess.limit && textAccess.limit !== Infinity && textAccess.currentUsage !== undefined) {
      const usageRatio = textAccess.currentUsage / textAccess.limit;
      if (usageRatio >= 0.7 && textAccess.remaining !== undefined && textAccess.remaining > 0) {
        const t = await getBotMessages(user.language || 'en');
        const warningText = (t.subscription?.nearLimit?.text || '({remaining} of {limit} summaries remaining this month)')
          .replace('{remaining}', String(textAccess.remaining))
          .replace('{limit}', String(textAccess.limit));
        summaryWithWarning = `${summary}\n\n<i>${warningText}</i>`;
      }
    }
  } catch {
    // Non-critical, continue without warning
  }
  const featureCheckMs = Date.now() - tFeatureCheck;

  // Handle text delivery
  const tTextDelivery = Date.now();
  if (sendText) {
    if (progressMessageId) {
      await msgService.updateMessage(userId, progressMessageId, summaryWithWarning, { format: MessageFormat.HTML });
    } else {
      await routeTextMessage(userId, summaryWithWarning, user, platform);
    }

    trackActivityAsync(user.id, 'text_summary_generated', {
      word_count: summary.split(/\s+/).length,
    });
    incrementUsage(user.id, 'textSummaries').catch(err =>
      console.error('[Subscription] Failed to increment text usage:', err)
    );
  } else if (progressMessageId && !(sendVoiceEnabled && dateHeader)) {
    await msgService.deleteMessage(userId, progressMessageId);
  }
  const textDeliveryMs = Date.now() - tTextDelivery;

  // Handle voice delivery
  let voiceDispatchMs = 0;
  if (sendVoiceEnabled) {
    const voiceAccess = await checkFeatureAccess(user.id, 'voice_summary');
    if (!voiceAccess.allowed) {
      console.log(`[Delivery Timing] user=${userId} total=${Date.now() - t0}ms featureCheck=${featureCheckMs}ms textDelivery=${textDeliveryMs}ms voiceDispatch=0ms`);
      return;
    }

    trackActivityAsync(user.id, 'voice_summary_requested', {
      language: user.language,
    });

    if (!sendText && dateHeader) {
      if (progressMessageId) {
        await msgService.updateMessage(userId, progressMessageId, dateHeader, { format: MessageFormat.HTML });
      } else {
        await routeTextMessage(userId, dateHeader, user, platform);
      }
    } else if (!sendText && progressMessageId) {
      await msgService.deleteMessage(userId, progressMessageId);
    }

    const tVoice = Date.now();
    // Call voice generation inline (no QStash dispatch)
    sendVoiceMessage(userId, summary, user).catch(err =>
      console.error(`[Delivery] Voice generation failed for user ${userId}:`, err)
    );
    voiceDispatchMs = Date.now() - tVoice;
  }

  console.log(`[Delivery Timing] user=${userId} total=${Date.now() - t0}ms featureCheck=${featureCheckMs}ms textDelivery=${textDeliveryMs}ms voiceDispatch=${voiceDispatchMs}ms`);
}
