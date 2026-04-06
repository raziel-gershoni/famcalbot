/**
 * Telegram summary generation and delivery functions
 */

import { getUserByTelegramId, getUserByIdentifier, getAllUsers, getWhatsAppChatId } from '../user-service';
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
import { sendSetupNudgeIfNeeded } from './commands';

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
      captureError(error, 'summary-week-lookahead', { user_id: user.id }, 'warning');
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
 * Supports both Telegram (progress messages, inline keyboards) and WhatsApp (simple text)
 */
export async function sendSummaryToUser(
  chatId: number | string,
  fetchFunction: (refreshToken: string, calendarIds: string[], timezone?: string) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined,
  errorKey: string,
  modelId?: string,
  existingProgressMessageId?: number,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM
): Promise<void> {
  // Platform-agnostic user lookup
  const user = await getUserByIdentifier(chatId);
  if (!user) {
    console.error(`User not found for ${chatId}`);
    return;
  }

  // Get the correct messaging service for this platform
  const messagingService = platform === MessagingPlatform.TELEGRAM
    ? getMessagingService()
    : getMessagingServiceByPlatform(platform);

  const userLanguage = user.language || 'en';

  // Check if user has completed setup — nudge them if not
  if (await sendSetupNudgeIfNeeded(user, chatId, messagingService, platform)) return;

  const progressType: ProgressType = summaryDate ? 'summaryTomorrow' : 'summary';

  trackActivityAsync(user.id, 'text_summary_requested', {
    summary_type: summaryDate ? 'tomorrow' : 'today',
    language: userLanguage,
    calendar_count: user.calendarAssignments?.length || 0,
  });

  // Check feature access for text summaries
  const textAccess = await checkFeatureAccess(user.id, 'text_summary');
  if (!textAccess.allowed) {
    const t = await getBotMessages(userLanguage);
    const limitMessage = t.subscription?.textLimitReached
      || 'You\'ve reached your monthly text summary limit.';

    await messagingService.sendMessage(chatId, limitMessage, {
      format: MessageFormat.HTML,
    });
    return;
  }

  await executeCommand({
    chatId,
    progressType,
    language: userLanguage,
    existingProgressMessageId,
    messagingService,
    errorKey,
    commandName: 'Summary Generation',
    context: `User: ${chatId}, Date: ${summaryDate ? summaryDate.toISOString() : 'today'}`,
    operation: async () => {
      return prepareSummaryForUser(user, fetchFunction, summaryDate, modelId);
    },
    onSuccess: async (result, messageId) => {
      await deliverSummary({
        userId: chatId,
        summary: result.summary,
        user,
        progressMessageId: messageId,
        platform: platform === MessagingPlatform.TELEGRAM ? 'telegram' : 'whatsapp',
        dateHeader: result.dateHeader,
      });
    },
    onError: async (error, messageId) => {
      if (error.message === 'GOOGLE_INSUFFICIENT_SCOPES') {
        const t = await getBotMessages(userLanguage);
        const scopesMessage = `${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`;
        await messagingService.updateMessage(chatId, messageId, scopesMessage, {
          format: MessageFormat.HTML
        });

        if (user.telegramId) {
          const { clearGoogleRefreshToken } = await import('../user-service');
          await clearGoogleRefreshToken(BigInt(user.telegramId));
        }

        const { notifyAdminWarning } = await import('../../utils/error-notifier');
        await notifyAdminWarning(
          'Insufficient Scopes',
          `User ${user.id} has a token with insufficient scopes. Token cleared, awaiting re-authorization.`
        );
        return true;
      }

      if (error.message === 'GOOGLE_TOKEN_EXPIRED') {
        const t = await getBotMessages(userLanguage);
        const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;
        await messagingService.updateMessage(chatId, messageId, expiredMessage, {
          format: MessageFormat.HTML
        });

        const { notifyAdminWarning } = await import('../../utils/error-notifier');
        await notifyAdminWarning(
          'Token Expired',
          `User ${user.id} needs to refresh their Google Calendar token`
        );
        return true;
      }

      return false;
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

      // Diagnostic: log WA delivery details for dual-platform users
      if (platform === 'whatsapp' || platform === 'all') {
        console.log(`[Summary] User ${user.id}: platform=${platform} waPhone=${user.whatsappPhone || 'null'} waBsuid=${user.whatsappBsuid || 'null'} waChatId=${getWhatsAppChatId(user) || 'null'}`);
      }

      const hasToken = !!user.googleRefreshToken;
      const hasCalendars = user.calendarAssignments && user.calendarAssignments.length > 0;
      const hasLocation = !!user.location;

      if (!hasToken) {
        console.log(`[Summary] Skipping user ${user.id}: No Google token`);
        continue;
      }

      if (!hasCalendars && !hasLocation) {
        console.log(`[Summary] Skipping user ${user.id}: No calendars or location`);
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
          captureError(error, 'summary-weather-only', { user_id: user.id }, 'warning');
        }
        continue;
      }

      if (!hasCalendars) {
        console.log(`[Summary] Skipping user ${user.id}: No calendars, weather disabled`);
        continue;
      }

      try {
        const tUser = Date.now();
        const { summary, dateHeader } = await prepareSummaryForUser(user, fetchFunction, summaryDate);

        // Use telegramId for TG delivery, whatsappPhone for WA, or user.id as fallback
        const deliveryUserId = user.telegramId ?? getWhatsAppChatId(user) ?? user.id;
        await deliverSummary({
          userId: deliveryUserId,
          summary,
          user,
          platform,
          dateHeader,
          waButtonPayload: summaryDate ? 'summary tmrw' : 'summary',
        });

        console.log(`[Batch Summary] user=${user.id} platform=${platform} total=${Date.now() - tUser}ms`);
        result.processed++;

        // Mark as sent for dedup
        if (options?.filterByHour) {
          const { markSummarySent } = await import('../../lib/summary-scheduling');
          const { resolveUserTimezone } = await import('../../lib/timezone');
          const tz = await resolveUserTimezone(user);
          await markSummarySent(user.id, summaryDate ? 'tomorrow' : 'daily', tz);
        }
      } catch (error) {
        console.error(`Failed to send summary to user ${user.id}:`, error);
        captureError(error, 'summary-batch-user', { user_id: user.id });

        if (error instanceof Error && error.message === 'GOOGLE_TOKEN_EXPIRED') {
          const t = await getBotMessages(user.language || 'en');
          const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId ?? user.id}`);
          const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;

          try {
            if ((platform === 'telegram' || platform === 'all') && user.telegramId) {
              await messagingService.sendMessage(user.telegramId, expiredMessage, {
                format: MessageFormat.HTML,
                replyMarkup: {
                  inline_keyboard: [[
                    { text: t.buttons.refreshGoogle, web_app: { url: refreshUrl } }
                  ]]
                }
              });
            }
            if ((platform === 'whatsapp' || platform === 'all') && getWhatsAppChatId(user)) {
              const waChatId = getWhatsAppChatId(user)!;
              const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
              const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
              const template = buildWhatsAppTemplate(user.language || 'en');
              await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
            }
          } catch (msgError) {
            console.error(`Failed to send token expired message to user ${user.id}:`, msgError);
            captureError(msgError, 'summary-token-expired-notify', { user_id: user.id }, 'warning');
          }

          const { notifyAdminWarning } = await import('../../utils/error-notifier');
          await notifyAdminWarning(
            'Token Expired',
            `User ${user.id} (${user.name}) needs to refresh their Google Calendar token`
          );
        }
      }
    }
  } catch (error) {
    console.error('Failed to generate summary for all users:', error);
    captureError(error, 'summary-batch-all');

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
export async function sendDailySummaryToUser(
  chatId: number | string,
  existingProgressMessageId?: number,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM
): Promise<void> {
  await sendSummaryToUser(
    chatId,
    fetchTodayEvents,
    undefined,
    'calendarFetch',
    undefined,
    existingProgressMessageId,
    platform
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
  const { fetchAirQuality } = await import('../weather/air-quality');
  const { detectDustStorm } = await import('../weather/dust-storm');

  const timezone = await getTimezone(user.location);
  const [weatherData, airQualityData] = await Promise.all([
    fetchWeather(user.location, timezone),
    fetchAirQuality(user.location, timezone).catch(() => null),
  ]);

  const t = await getBotMessages(user.language || 'en');

  const dateStr = targetDate.toLocaleDateString(user.language === 'he' ? 'he-IL' : user.language === 'ru' ? 'ru-RU' : 'en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  });

  // Wind line when significant
  const windLine = weatherData.current.windSpeed > 20
    ? `\n💨 ${getWindDirectionLabel(weatherData.current.windDirection, user.language)} ${weatherData.current.windSpeed} ${t.weatherOnly?.windSpeed || 'km/h'}`
    : '';

  // Sharav warning for today/tomorrow
  const sharavDays = detectSharav(weatherData);
  const nearSharav = sharavDays.filter(s => s.dayIndex <= 1);
  let sharavLine = '';
  if (nearSharav.length > 0) {
    const severityKeys: Record<string, string> = {
      mild: t.weatherOnly?.severityMild || 'mild',
      moderate: t.weatherOnly?.severityModerate || 'moderate',
      severe: t.weatherOnly?.severitySevere || 'severe',
    };
    const warnings = nearSharav.map(s => {
      const dayLabel = s.dayIndex === 0
        ? (t.weatherOnly?.today || 'Today')
        : (t.weatherOnly?.tomorrow || 'Tomorrow');
      return `${dayLabel}: ${severityKeys[s.severity]} (${s.tempMax}°C)`;
    }).join(', ');
    sharavLine = `\n\n⚠️ <b>${t.weatherOnly?.sharav || 'Sharav'}:</b> ${warnings}`;
  }

  // Dust storm warning for today/tomorrow
  const dustDays = detectDustStorm(airQualityData, weatherData);
  const nearDust = dustDays.filter(d => d.dayIndex <= 1);
  let dustLine = '';
  if (nearDust.length > 0) {
    const severityKeys: Record<string, string> = {
      mild: t.weatherOnly?.severityMild || 'mild',
      moderate: t.weatherOnly?.severityModerate || 'moderate',
      severe: t.weatherOnly?.severitySevere || 'severe',
    };
    const warnings = nearDust.map(d => {
      const dayLabel = d.dayIndex === 0
        ? (t.weatherOnly?.today || 'Today')
        : (t.weatherOnly?.tomorrow || 'Tomorrow');
      return `${dayLabel}: ${severityKeys[d.severity]}`;
    }).join(', ');
    dustLine = `\n\n🌫️ <b>${t.weatherOnly?.dustStorm || 'Dust Storm'}:</b> ${warnings}`;
  }

  const weatherMessage = `🌤️ <b>${t.weatherOnly?.title || 'Weather'} - ${dateStr}</b>

<b>${t.weatherOnly?.current || 'Current'}:</b> ${weatherData.current.temperature}°C (${t.weatherOnly?.feelsLike || 'feels like'} ${weatherData.current.feelsLike}°C), ${getWeatherDescription(weatherData.current.weatherCode)}${windLine}

<b>${t.weatherOnly?.today || 'Today'}:</b> ${t.weatherOnly?.high || 'High'} ${weatherData.today.tempMax}°C, ${t.weatherOnly?.low || 'Low'} ${weatherData.today.tempMin}°C, ${weatherData.today.precipitationProbability}% ${t.weatherOnly?.rain || 'rain'}
${weatherData.tomorrow ? `<b>${t.weatherOnly?.tomorrow || 'Tomorrow'}:</b> ${t.weatherOnly?.high || 'High'} ${weatherData.tomorrow.tempMax}°C, ${t.weatherOnly?.low || 'Low'} ${weatherData.tomorrow.tempMin}°C, ${weatherData.tomorrow.precipitationProbability}% ${t.weatherOnly?.rain || 'rain'}` : ''}${sharavLine}${dustLine}`;

  if ((platform === 'telegram' || platform === 'all') && user.telegramId) {
    await messagingService.sendMessage(user.telegramId, weatherMessage, {
      format: MessageFormat.HTML
    });
  }

  if ((platform === 'whatsapp' || platform === 'all') && !getWhatsAppChatId(user)) {
    console.warn(`[Delivery] WA weather skipped for user ${user.id}: no WhatsApp phone/BSUID`);
  }
  if ((platform === 'whatsapp' || platform === 'all') && getWhatsAppChatId(user)) {
    const waChatId = getWhatsAppChatId(user)!;
    const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
    const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
    const template = buildWhatsAppTemplate(user.language || 'en', 'weather');
    await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
  }

  console.log(`[Summary] Sent weather-only to user ${user.id}`);
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
export async function sendTomorrowSummaryToUser(
  chatId: number | string,
  existingProgressMessageId?: number,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM
): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  await sendSummaryToUser(
    chatId,
    fetchTomorrowEvents,
    tomorrow,
    'tomorrowFetch',
    undefined,
    existingProgressMessageId,
    platform
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
  userId: number | string,
  text: string,
  user: UserConfig,
  platform?: DeliveryPlatform,
  isProactive = false,
  waButtonPayload?: string
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

  if ((targetPlatform === 'telegram' || targetPlatform === 'all') && user.telegramId) {
    try {
      await msgService.sendMessage(user.telegramId, text, { format: MessageFormat.HTML });
    } catch (e) {
      console.error(`[Delivery] TG text failed for user ${user.id}:`, e);
      captureError(e, 'telegram-delivery', { user_id: userId, service: 'sendMessage' });
    }
  }

  if ((targetPlatform === 'whatsapp' || targetPlatform === 'all') && !getWhatsAppChatId(user)) {
    console.warn(`[Delivery] WA text skipped for user ${user.id}: no WhatsApp phone/BSUID (platform=${targetPlatform})`);
  }

  if ((targetPlatform === 'whatsapp' || targetPlatform === 'all') && getWhatsAppChatId(user)) {
    try {
      const waChatId = getWhatsAppChatId(user)!;
      const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);

      if (isProactive) {
        // Send template with quick reply button — user taps to get content
        const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
        const template = buildWhatsAppTemplate(user.language || 'en', waButtonPayload);
        console.log(`[Delivery] Sending WA template to user ${user.id} (${waChatId}) tpl=${template.name} payload=${waButtonPayload || 'none'}`);
        const tplId = await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
        console.log(`[Delivery] WA template sent (msgId=${tplId})`);
      } else {
        console.log(`[Delivery] Sending WA text to user ${user.id} (${waChatId})`);
        const ctaLabels: Record<string, string> = { he: 'פתח בטלגרם', ru: 'Открыть в Telegram', en: 'Open in Telegram' };
        const telegramCta = ctaLabels[user.language || 'en'] || ctaLabels.en;
        await whatsappService.sendMessage(waChatId, text, { format: MessageFormat.HTML, telegramCta });
      }
    } catch (e) {
      console.error(`[Delivery] WA text failed for user ${user.id} (${getWhatsAppChatId(user)}):`, e);
      captureError(e, 'whatsapp-delivery', { user_id: userId, service: 'sendMessage' });
    }
  }
}

/**
 * Delivery options for unified summary delivery
 */
interface DeliveryOptions {
  userId: number | string;
  summary: string;
  user: UserConfig;
  progressMessageId?: number | string;
  platform?: DeliveryPlatform;
  dateHeader?: string;
  waButtonPayload?: string;
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
    dateHeader,
    waButtonPayload
  } = options;

  // Use correct messaging service based on delivery platform
  const targetPlatform = platform || user.messagingPlatform || 'telegram';
  const msgService = (targetPlatform === 'whatsapp' && getWhatsAppChatId(user))
    ? getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP)
    : getMessagingService();

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
      await routeTextMessage(userId, summaryWithWarning, user, platform, !!waButtonPayload, waButtonPayload);
    }

    trackActivityAsync(user.id, 'text_summary_generated', {
      word_count: summary.split(/\s+/).length,
    });
    incrementUsage(user.id, 'textSummaries').catch(err => {
      console.error('[Subscription] Failed to increment text usage:', err);
      captureError(err, 'summary-increment-text-usage', { user_id: user.id }, 'warning');
    });
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
        await routeTextMessage(userId, dateHeader, user, platform, !!waButtonPayload);
      }
    } else if (!sendText && progressMessageId) {
      await msgService.deleteMessage(userId, progressMessageId);
    }

    const tVoice = Date.now();
    // Send voice to Telegram if applicable
    if ((targetPlatform === 'telegram' || targetPlatform === 'all') && user.telegramId) {
      sendVoiceMessage(user.telegramId, summary, user, undefined, true, MessagingPlatform.TELEGRAM).catch(err => {
        console.error(`[Delivery] Voice generation failed for TG user ${user.id}:`, err);
        captureError(err, 'summary-voice-telegram', { user_id: user.id }, 'warning');
      });
    }
    // Voice is Telegram-only (WA requires 24h window; voice sent after user taps template button via command handler)
    voiceDispatchMs = Date.now() - tVoice;
  }

  console.log(`[Delivery Timing] user=${userId} total=${Date.now() - t0}ms featureCheck=${featureCheckMs}ms textDelivery=${textDeliveryMs}ms voiceDispatch=${voiceDispatchMs}ms`);
}
