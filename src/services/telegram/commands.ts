/**
 * Telegram command handlers
 * Handles /start, /summary, /weather, /lookahead, /nextweek, /feedback
 */

import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getUserByIdentifier, getOrCreateUser, clearGoogleRefreshToken, TelegramUserInfo } from '../user-service';
import { MessagingPlatform, MessageFormat, IMessagingService } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import type { StreamMessageHandle } from '../messaging/types';
import type { UserConfig } from '../../types';
import { buildUrl } from '../../config/urls';
import { SHARE_STORY_LABELS, getLabel } from '../../config/labels';
import { REDIS_KEYS } from '../../config/redis-keys';
import { executeCommand, startTypingInterval } from './command-pipeline';
import { VALID_LOCALES } from '../../utils/locale';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb } from '../analytics-service';
import { checkFeatureAccess, incrementUsage } from '../subscription-service';
import { captureError } from '../../lib/error-capture';
import { prisma } from '../../utils/prisma';
import { getMessagingService } from './bot';
import { sendVoiceMessage, sendWeeklyVoiceMessage } from './voice';
import {
  sendDailySummaryToUser,
  sendTomorrowSummaryToUser,
  routeTextMessage,
} from './summary';

/**
 * Check if user is authorized (supports both Telegram ID and WhatsApp phone).
 * Suspended users are treated as unauthorized so their commands silently no-op.
 */
export async function isUserAuthorized(userId: number | string): Promise<boolean> {
  const user = await getUserByIdentifier(userId);
  if (!user) return false;
  if (user.suspendedAt) return false;
  return true;
}

/**
 * Send a setup nudge to a user who hasn't completed onboarding.
 * Returns true if a nudge was sent (caller should return early), false if setup is complete.
 */
export async function sendSetupNudgeIfNeeded(
  user: { id: number; telegramId: number | bigint | null; googleRefreshToken: string; calendarAssignments?: unknown[] | null; location?: string; language?: string; calendarSource?: 'GOOGLE' | 'NATIVE' },
  chatId: number | string,
  messagingService: IMessagingService,
  platform: MessagingPlatform,
  checks: ('oauth' | 'calendars' | 'location')[] = ['oauth', 'calendars']
): Promise<boolean> {
  const userLanguage = user.language || 'en';
  const isNative = user.calendarSource === 'NATIVE';
  const { generateMagicLink } = await import('../magic-link');

  async function sendNudge(message: string, buttonText: string, route: string) {
    const url = buildUrl(`/${userLanguage}/${route}?user_id=${user.telegramId ?? user.id}`);
    const buttonUrl = platform === MessagingPlatform.WHATSAPP
      ? await generateMagicLink(user.id, userLanguage)
      : url;
    await messagingService.sendMessage(chatId, message, {
      format: MessageFormat.HTML,
      ...(platform === MessagingPlatform.TELEGRAM
        ? { replyMarkup: { inline_keyboard: [[{ text: buttonText, web_app: { url } }]] } }
        : { whatsappUrlButton: { text: buttonText, url: buttonUrl } }),
    });
  }

  // OAuth and per-calendar selection only matter for GOOGLE users. NATIVE
  // users have an auto-bootstrapped primary calendar at signup, so they skip
  // both checks and only need a location.
  if (!isNative && checks.includes('oauth') && !user.googleRefreshToken) {
    const t = await getBotMessages(userLanguage);
    const nudge = t.setupNudge || {};
    await sendNudge(nudge.noOAuth || 'Please connect your Google Calendar first.', nudge.noOAuthButton || '🚀 Connect Calendar', 'dashboard');
    return true;
  }

  if (!isNative && checks.includes('calendars') && (!user.calendarAssignments || user.calendarAssignments.length === 0)) {
    const t = await getBotMessages(userLanguage);
    const nudge = t.setupNudge || {};
    await sendNudge(nudge.noCalendars || 'Please select your calendars first.', nudge.noCalendarsButton || '📆 Select Calendars', 'select-calendars');
    return true;
  }

  if (checks.includes('location') && !user.location) {
    const t = await getBotMessages(userLanguage);
    const nudge = t.setupNudge || {};
    // Native-flavored prompt sounds like "your calendar is ready, just tell me
    // where you live" rather than the GOOGLE setup chain.
    const message = isNative
      ? (nudge.noLocationNative || 'Your calendar is ready! Tell me where you live for weather + timezone.')
      : (nudge.noLocation || 'Please set your location first.');
    await sendNudge(message, nudge.noLocationButton || '📍 Set Location', 'settings');
    return true;
  }

  return false;
}

/**
 * Handle /start command
 * Auto-registers new users and opens unified dashboard webapp
 */
export async function handleStartCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  telegramUser?: TelegramUserInfo,
  args?: string
): Promise<void> {
  // Google connect claim: t.me/<bot>?start=gc_<pendingId> from the OAuth finish page.
  // Both the webhook and polling /start land here. It runs before auto-registration, so a
  // stranger tapping someone else's link gets no account, and before the breadcrumb,
  // which would record the id.
  if (args?.startsWith('gc_') && platform === MessagingPlatform.TELEGRAM) {
    const { handleGoogleConnectTelegram } = await import('../google-connect');
    await handleGoogleConnectTelegram(chatId, Number(userId), args.slice('gc_'.length), telegramUser?.language_code);
    return;
  }

  addBreadcrumb('command_started', {
    command: '/start',
    user_id: userId,
    platform,
    args,
  }, 'command');

  const userIdNum = typeof userId === 'number' ? userId : parseInt(String(userId));
  const user = await getOrCreateUser(userIdNum, telegramUser);

  trackActivityAsync(user.id, 'bot_start', {
    language: user.language,
    platform: platform,
  });

  const name = user.name || 'there';
  const locale = user.language || 'en';
  const service = getMessagingService();

  const t = await getBotMessages(locale);

  // Set per-user menu button with localized text (Telegram-only)
  if (user.telegramId) {
    const { setUserMenuButton } = await import('./bot');
    await setUserMenuButton(user.telegramId, locale);
  }

  // Handle deep link parameters (e.g., t.me/BotName?start=feedback)
  if (args === 'feedback') {
    const feedbackUrl = buildUrl(`/${locale}/feedback?user_id=${user.telegramId ?? user.id}`);
    const openFormMessage = t.feedback?.openForm || 'Click below to send feedback:';
    await service.sendMessage(chatId, openFormMessage, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.feedback?.openButton || 'Send Feedback', web_app: { url: feedbackUrl } }
        ]]
      }
    });
    return;
  }

  // ?start=connect is on the WhatsApp summary button and the dashboard banner, which linked
  // accounts see too. Linked already (by phone or BSUID): the usual reply below, with the
  // dashboard button. The polling /start lands here as well.
  if (args === 'connect' && !user.whatsappPhone && !user.whatsappBsuid) {
    await handleConnectCommand(Number(chatId), userIdNum, platform, true);
    return;
  }

  // Pairing invite deep link: t.me/<bot>?start=invite_<token>
  if (args && args.startsWith('invite_')) {
    const token = args.slice('invite_'.length);
    const { handlePairAccept } = await import('./pair-handler');
    await handlePairAccept(chatId, user.id, token, locale, platform);
    return;
  }

  const dashboardUrl = buildUrl(`/${locale}/dashboard?user_id=${user.telegramId ?? user.id}`);
  const welcome = t.start.welcome.replace('{name}', name);

  if (user.isAdmin) {
    const adminUrl = buildUrl(`/${locale}/admin-panel?user_id=${user.telegramId ?? user.id}`);
    const message = `${welcome}\n\n${t.start.chooseBoard}`;

    await service.sendMessage(chatId, message, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [
          [{ text: t.start.userDashboard, web_app: { url: dashboardUrl } }],
          [{ text: t.start.adminPanel, web_app: { url: adminUrl } }]
        ]
      }
    });
    return;
  }

  // New-user setup branches differ by calendar source (A1 model):
  // - GOOGLE legacy users without OAuth → existing "connect Google" funnel.
  // - NATIVE users (the new default) → calendar is auto-bootstrapped at signup,
  //   so the only thing that gates good summaries is location. Welcome them
  //   warmly and point at /settings instead of /dashboard.
  const isNative = user.calendarSource === 'NATIVE';
  const needsGoogleSetup = !isNative && !user.googleRefreshToken;
  const needsLocationOnly = isNative && !user.location;

  if (needsGoogleSetup) {
    const platformName = platform === MessagingPlatform.TELEGRAM ? 'Telegram' : 'WhatsApp';
    const valueProp = (t.start.valueProp || '').replace('{platform}', platformName);
    const featureList = t.start.featureList || '';

    // Message 1: Welcome + value prop + feature list
    const msg1 = `${welcome}\n\n${valueProp}\n\n${featureList}`;
    await service.sendMessage(chatId, msg1, { format: MessageFormat.HTML });

    // Message 2: Sample summary + CTA button
    const sampleIntro = t.start.sampleIntro || '';
    const sampleSummary = t.start.sampleSummary || '';
    const ctaSetup = t.start.ctaSetup || '';
    const msg2 = `${sampleIntro}\n\n━━━━━━━━━━━━━━━━━━\n${sampleSummary}\n━━━━━━━━━━━━━━━━━━\n\n${ctaSetup}`;
    await service.sendMessage(chatId, msg2, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.start.ctaButton || '🚀 Set Up FamCal', web_app: { url: dashboardUrl } }
        ]]
      }
    });
    return;
  }

  if (needsLocationOnly) {
    const settingsUrl = buildUrl(`/${locale}/settings?user_id=${user.telegramId ?? user.id}`);
    const platformName = platform === MessagingPlatform.TELEGRAM ? 'Telegram' : 'WhatsApp';
    const nativeWelcome = (t.start.nativeWelcome
      || `${welcome}\n\n👋 Your calendar is ready in {platform}. Tell me where you live so weather and timezones work right.`)
      .replace('{platform}', platformName)
      .replace('{name}', name);
    await service.sendMessage(chatId, nativeWelcome, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.start.nativeLocationButton || '📍 Set my location', web_app: { url: settingsUrl } }
        ]]
      }
    });
    return;
  }

  // Returning user: simple dashboard button
  const message = `${welcome}\n\n${t.start.tapButton}`;

  await service.sendMessage(chatId, message, {
    format: MessageFormat.HTML,
    replyMarkup: {
      inline_keyboard: [[
        { text: t.start.dashboard, web_app: { url: dashboardUrl } }
      ]]
    }
  });
}

/**
 * Handle /summary command
 * Supports: /summary (today), /summary tmrw
 */
export async function handleSummaryCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  args?: string,
  streamHandle?: StreamMessageHandle,
): Promise<void> {
  addBreadcrumb('command_started', {
    command: '/summary',
    user_id: userId,
    platform,
    args,
  }, 'command');

  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    const t = await getBotMessages('en');
    await service.sendMessage(chatId, t.errors.unauthorized);
    return;
  }

  const user = await getUserByIdentifier(userId);
  if (!user) return;

  // Check if user has invalid/legacy language setting
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!user.language || !VALID_LOCALES.includes(user.language as any)) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId ?? user.id}`);
    const t = await getBotMessages('en');
    await service.sendMessage(
      chatId,
      t.errors.updateLanguage,
      {
        replyMarkup: {
          inline_keyboard: [[
            { text: t.buttons.openSettings, web_app: { url: settingsUrl } }
          ]]
        }
      }
    );
    return;
  }

  // Use the original chatId (telegramId for TG, phone string for WA)
  if (args?.toLowerCase().trim() === 'tmrw') {
    await sendTomorrowSummaryToUser(chatId, platform, streamHandle);
  } else {
    await sendDailySummaryToUser(chatId, platform, streamHandle);
  }
}

/**
 * Handle /weather command
 * Generates AI-powered weather forecast
 */
export async function handleWeatherCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  args?: string,
): Promise<void> {
  addBreadcrumb('command_started', {
    command: '/weather',
    user_id: userId,
    platform,
    args,
  }, 'command');

  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    const t = await getBotMessages('en');
    await service.sendMessage(chatId, t.errors.unauthorized);
    return;
  }

  const user = await getUserByIdentifier(userId);
  if (!user) {
    console.error(`User with ID ${userId} not found`);
    return;
  }

  const messagingService = platform === MessagingPlatform.TELEGRAM
    ? getMessagingService()
    : getMessagingServiceByPlatform(platform);

  // Check if user has invalid/legacy language setting
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!user.language || !VALID_LOCALES.includes(user.language as any)) {
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId ?? user.id}`);
    const t = await getBotMessages('en');
    await messagingService.sendMessage(
      chatId,
      t.errors.updateLanguage,
      {
        replyMarkup: {
          inline_keyboard: [[
            { text: t.buttons.openSettings, web_app: { url: settingsUrl } }
          ]]
        }
      }
    );
    return;
  }

  const userLanguage = user.language || 'en';

  // Check if user has completed setup — nudge for missing location
  if (await sendSetupNudgeIfNeeded(user, chatId, messagingService, platform, ['location'])) return;

  // Check feature access for text summaries (weather shares quota with calendar summaries)
  const weatherAccess = await checkFeatureAccess(user.id, 'text_summary');
  if (!weatherAccess.allowed) {
    const t = await getBotMessages(userLanguage);
    const upgradeUrl = buildUrl(`/${userLanguage}/subscription?user_id=${user.telegramId ?? user.id}`);
    const limitMessage = t.subscription?.textLimitReached
      || 'You\'ve reached your monthly text summary limit. Upgrade to continue!';
    await messagingService.sendMessage(chatId, limitMessage, {
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
    chatId,
    language: userLanguage,
    messagingService,
    errorKey: 'weatherFetch',
    commandName: 'Weather Command',
    context: `User: ${userId}, Location: ${user.location}`,
    typingType: 'photo',
    operation: async () => {
      const { fetchWeather } = await import('../weather/open-meteo');
      const { fetchAirQuality } = await import('../weather/air-quality');

      const { TIMEZONE } = await import('../../config/constants');
      let timezone = TIMEZONE;
      try {
        const { getTimezone } = await import('../weather/geocoding');
        timezone = await getTimezone(user.location);
      } catch {
        // Fall back to default timezone
      }

      const [weatherData, airQualityData] = await Promise.all([
        fetchWeather(user.location),
        fetchAirQuality(user.location, timezone).catch(() => null),
      ]);

      // The photo is drawn from the weather data alone. The AI forecast (20-30s at MEDIUM
      // thinking) is needed only for the voice note, or as the reply when the photo
      // fails, so the photo never waits for it.
      const { buildInfographicConfig, formatWeatherAI } = await import('../weather/formatter');
      const makeForecast = () => formatWeatherAI(weatherData, user.language, user.name, timezone, user.culture, user.isAdmin, false, airQualityData);
      const voiceForecast = user.voiceSummaryEnabled ? makeForecast() : null;
      // Awaited later, if at all; this keeps an early rejection from going unhandled.
      voiceForecast?.catch(() => {});

      // Generate infographic while typing indicator is still running
      let imageBuffer: Buffer | null = null;
      try {
        const { generateWeatherInfographic } = await import('../weather/infographic');
        imageBuffer = await generateWeatherInfographic(buildInfographicConfig(weatherData, user.language, timezone, user.culture, airQualityData));
      } catch (err) {
        console.error(`[Weather] Infographic generation failed for user ${userId}:`, err);
      }

      // Without a photo the forecast is the reply, so it stays inside the time budget.
      const brief = imageBuffer ? null : (await (voiceForecast ?? makeForecast())).brief;
      // Nothing to send: fail, so the user gets the error reply rather than silence.
      if (!imageBuffer && !brief) throw new Error('No weather photo and an empty forecast');
      return { imageBuffer, brief, voiceForecast };
    },
    onSuccess: async (result) => {
      if (result.imageBuffer) {
        // Cache image in Redis for inline story sharing (30 min TTL)
        import('../../utils/redis').then(({ redis }) =>
          redis.set(REDIS_KEYS.storyImage(user.id), Buffer.from(result.imageBuffer!).toString('base64'), { ex: 1800 })
        ).catch(() => {});

        const shareStoryUrl = buildUrl(`/${user.language || 'en'}/share-story?user_id=${user.id}&source=cached`);
        const shareLabel = getLabel(SHARE_STORY_LABELS, user.language || 'en');
        await messagingService.sendPhoto(chatId, result.imageBuffer, {
          replyMarkup: platform === MessagingPlatform.TELEGRAM ? {
            inline_keyboard: [[
              { text: shareLabel, web_app: { url: shareStoryUrl } }
            ]]
          } : undefined,
        });
      } else if (result.brief) {
        await messagingService.sendMessage(chatId, result.brief, { format: MessageFormat.HTML });
      }

      // Voice with typing indicator. On Telegram, "recording" shows while the forecast is
      // still being written; sendVoiceMessage keeps it up from there.
      if (result.voiceForecast) {
        const stopRecording = platform === MessagingPlatform.TELEGRAM
          ? startTypingInterval(chatId, messagingService, 'audio')
          : () => {};
        result.voiceForecast
          .then(forecast => {
            stopRecording();
            return sendVoiceMessage(chatId, forecast.detailed, user, undefined, true, platform, undefined, 'weather');
          })
          .catch(err => {
            stopRecording();
            console.error(`[Weather] Voice generation failed for user ${userId}:`, err);
          });
      }

      incrementUsage(user.id, 'textSummaries').catch(err =>
        console.error('[Subscription] Failed to increment weather usage:', err)
      );
    },
  });
}

/**
 * /week's and /nextweek's answers to Google's failures (spec §3.1 step 5, Ruling R14).
 * With the calendar home on, the week reads through the shared reader, which throws them:
 * - a dead token or missing permissions get the on-demand daily summary's answers, and
 *   missing permissions clear the token, as there;
 * - an outage, after the reader's quick retry, gets "couldn't reach Google Calendar",
 *   with no admin notice.
 * Anything else falls through to the pipeline's error text and admin notice. Today's read
 * (switch off) never throws these: it skips a calendar that fails.
 */
async function answerWeekError(
  error: Error,
  ctx: {
    chatId: number | string;
    user: UserConfig;
    userLanguage: string;
    messagingService: IMessagingService;
    streamHandle?: StreamMessageHandle;
  }
): Promise<boolean> {
  const { chatId, user, userLanguage, messagingService, streamHandle } = ctx;

  if (error.message === 'GOOGLE_INSUFFICIENT_SCOPES') {
    const t = await getBotMessages(userLanguage);
    const scopesMessage = `${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`;
    await messagingService.sendMessage(chatId, scopesMessage, {
      format: MessageFormat.HTML
    });

    if (user.telegramId) {
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
    await messagingService.sendMessage(chatId, expiredMessage, {
      format: MessageFormat.HTML
    });

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Token Expired',
      `User ${user.id} needs to refresh their Google Calendar token`
    );
    return true;
  }

  if (error.message === 'GOOGLE_FETCH_FAILED') {
    const t = await getBotMessages(userLanguage);
    const unreachable: string = t.errors.googleUnreachable;
    // An open draft collapses into the answer, as the pipeline's own error texts do. HTML,
    // as the daily summary sends this text and as the answers above are sent.
    if (streamHandle) {
      await streamHandle.cancel(unreachable, { format: MessageFormat.HTML });
    } else {
      await messagingService.sendMessage(chatId, unreachable, { format: MessageFormat.HTML });
    }
    return true;
  }

  return false;
}

/**
 * Handle /lookahead command
 * Displays notable upcoming events for the week
 */
export async function handleLookaheadCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  streamHandle?: StreamMessageHandle,
): Promise<void> {
  addBreadcrumb('command_started', {
    command: '/lookahead',
    user_id: userId,
    platform,
  }, 'command');

  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    const t = await getBotMessages('en');
    await service.sendMessage(chatId, t.errors.unauthorized);
    return;
  }

  const user = await getUserByIdentifier(userId);
  if (!user) {
    console.error(`User with ID ${userId} not found`);
    return;
  }

  const messagingService = platform === MessagingPlatform.TELEGRAM
    ? getMessagingService()
    : getMessagingServiceByPlatform(platform);

  // Check if user has invalid/legacy language setting
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!user.language || !VALID_LOCALES.includes(user.language as any)) {
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId ?? user.id}`);
    const t = await getBotMessages('en');
    await messagingService.sendMessage(
      chatId,
      t.errors.updateLanguage,
      {
        replyMarkup: {
          inline_keyboard: [[
            { text: t.buttons.openSettings, web_app: { url: settingsUrl } }
          ]]
        }
      }
    );
    return;
  }

  const userLanguage = user.language || 'en';

  // Check if user has completed setup — nudge them if not
  if (await sendSetupNudgeIfNeeded(user, chatId, messagingService, platform)) return;

  await executeCommand({
    chatId,
    language: userLanguage,
    messagingService,
    errorKey: 'lookaheadFetch',
    commandName: 'Lookahead Command',
    context: `User: ${userId}`,
    streamHandle,
    operation: async () => {
      const stageMessages = streamHandle ? await getBotMessages(userLanguage) : null;
      const pushStage = (key: 'lookingAhead' | 'composing') => {
        if (!streamHandle || !stageMessages) return;
        const text = stageMessages.streaming?.[key];
        if (text) streamHandle.pushStage(text);
      };

      pushStage('lookingAhead');
      const { getWeekLookahead } = await import('../week-lookahead');
      const { getCalendarAssignmentsForUser } = await import('../calendar-provider');
      const calendars = await getCalendarAssignmentsForUser(user);
      const lookahead = await getWeekLookahead(user, calendars);

      pushStage('composing');
      const { generateWeekLookahead } = await import('../claude');
      const onTextDelta = streamHandle
        ? (_delta: string, accumulated: string) => streamHandle.pushDelta(accumulated)
        : undefined;
      return generateWeekLookahead(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta, calendars);
    },
    onSuccess: async (formattedLookahead) => {
      const deliveryPlatform = platform === MessagingPlatform.TELEGRAM ? 'telegram' : 'whatsapp';
      await routeTextMessage(chatId, formattedLookahead, user, deliveryPlatform as 'telegram' | 'whatsapp', false, undefined, streamHandle);

      // Generate voice message if enabled
      if (user.voiceSummaryEnabled) {
        sendWeeklyVoiceMessage(chatId, formattedLookahead, user, false, undefined, platform).catch(err =>
          console.error(`[Lookahead] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
    onError: (error) => answerWeekError(error, { chatId, user, userLanguage, messagingService, streamHandle }),
  });
}

/**
 * Handle /nextweek command - shows next week's events
 */
export async function handleNextWeekCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  streamHandle?: StreamMessageHandle,
): Promise<void> {
  addBreadcrumb('command_started', {
    command: '/nextweek',
    user_id: userId,
    platform,
  }, 'command');

  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    const t = await getBotMessages('en');
    await service.sendMessage(chatId, t.errors.unauthorized);
    return;
  }

  const user = await getUserByIdentifier(userId);
  if (!user) {
    console.error(`User with ID ${userId} not found`);
    return;
  }

  const messagingService = platform === MessagingPlatform.TELEGRAM
    ? getMessagingService()
    : getMessagingServiceByPlatform(platform);

  // Check if user has invalid/legacy language setting
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!user.language || !VALID_LOCALES.includes(user.language as any)) {
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId ?? user.id}`);
    const t = await getBotMessages('en');
    await messagingService.sendMessage(
      chatId,
      t.errors.updateLanguage,
      {
        replyMarkup: {
          inline_keyboard: [[
            { text: t.buttons.openSettings, web_app: { url: settingsUrl } }
          ]]
        }
      }
    );
    return;
  }

  const userLanguage = user.language || 'en';

  // Check if user has completed setup — nudge them if not
  if (await sendSetupNudgeIfNeeded(user, chatId, messagingService, platform)) return;

  await executeCommand({
    chatId,
    language: userLanguage,
    messagingService,
    errorKey: 'nextWeekFetch',
    commandName: 'Next Week Command',
    context: `User: ${userId}`,
    streamHandle,
    operation: async () => {
      const stageMessages = streamHandle ? await getBotMessages(userLanguage) : null;
      const pushStage = (key: 'lookingAhead' | 'composing') => {
        if (!streamHandle || !stageMessages) return;
        const text = stageMessages.streaming?.[key];
        if (text) streamHandle.pushStage(text);
      };

      pushStage('lookingAhead');
      const { getNextWeekLookahead } = await import('../week-lookahead');
      const { getCalendarAssignmentsForUser } = await import('../calendar-provider');
      const calendars = await getCalendarAssignmentsForUser(user);
      const lookahead = await getNextWeekLookahead(user, calendars);

      pushStage('composing');
      const { generateNextWeekSummary } = await import('../claude');
      const onTextDelta = streamHandle
        ? (_delta: string, accumulated: string) => streamHandle.pushDelta(accumulated)
        : undefined;
      return generateNextWeekSummary(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta, calendars);
    },
    onSuccess: async (formattedSummary) => {
      const deliveryPlatform = platform === MessagingPlatform.TELEGRAM ? 'telegram' : 'whatsapp';
      await routeTextMessage(chatId, formattedSummary, user, deliveryPlatform as 'telegram' | 'whatsapp', false, undefined, streamHandle);

      // Generate voice message if enabled
      if (user.voiceSummaryEnabled) {
        sendWeeklyVoiceMessage(chatId, formattedSummary, user, true, undefined, platform).catch(err =>
          console.error(`[NextWeek] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
    onError: (error) => answerWeekError(error, { chatId, user, userLanguage, messagingService, streamHandle }),
  });
}

/**
 * Handle /feedback command
 * Allows users to submit feedback via Telegram
 * Usage: /feedback <text> (10-1000 characters)
 * Rate limited to 3 submissions per 24 hours
 */
export async function handleFeedbackCommand(
  chatId: number,
  userId: number,
  feedbackText: string | undefined
): Promise<void> {
  const user = await getUserByTelegramId(userId);
  if (!user) {
    console.error(`[Feedback] User with Telegram ID ${userId} not found`);
    return;
  }

  const messagingService = getMessagingService();
  const userLanguage = user.language || 'en';
  const t = await getBotMessages(userLanguage);

  if (!feedbackText || feedbackText.trim().length === 0) {
    const feedbackUrl = buildUrl(`/${userLanguage}/feedback?user_id=${user.telegramId ?? user.id}`);
    const openFormMessage = t.feedback?.openForm || 'Click below to send feedback:';
    await messagingService.sendMessage(chatId, openFormMessage, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.feedback?.openButton || 'Send Feedback', web_app: { url: feedbackUrl } }
        ]]
      }
    });
    return;
  }

  const trimmedText = feedbackText.trim();

  if (trimmedText.length < 10) {
    const tooShortMessage = t.feedback?.tooShort || 'Feedback must be at least 10 characters.';
    await messagingService.sendMessage(chatId, tooShortMessage);
    return;
  }

  if (trimmedText.length > 1000) {
    const tooLongMessage = t.feedback?.tooLong || 'Feedback must be less than 1000 characters.';
    await messagingService.sendMessage(chatId, tooLongMessage);
    return;
  }

  try {
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);

    const recentFeedbackCount = await prisma.userFeedback.count({
      where: {
        userId: user.id,
        createdAt: { gte: oneDayAgo }
      }
    });

    if (recentFeedbackCount >= 3) {
      const rateLimitMessage = t.feedback?.rateLimit || "You've reached the daily feedback limit. Please try again tomorrow.";
      await messagingService.sendMessage(chatId, rateLimitMessage);
      return;
    }

    await prisma.userFeedback.create({
      data: {
        userId: user.id,
        text: trimmedText,
        source: 'telegram'
      }
    });

    const { notifyAdminFeedback } = await import('../../utils/error-notifier');
    await notifyAdminFeedback(user.name, user.telegramId, trimmedText, 'telegram');

    trackActivityAsync(user.id, 'feedback_submitted', {
      source: 'telegram',
      text_length: trimmedText.length
    });

    const successMessage = t.feedback?.success || 'Thank you for your feedback!';
    await messagingService.sendMessage(chatId, successMessage);

    console.log(`[Feedback] User ${userId} submitted feedback (${trimmedText.length} chars)`);
  } catch (error) {
    console.error('[Feedback] Error handling feedback command:', error);
    captureError(error, 'feedback-command', { user_id: userId });

    const errorMessage = t.feedback?.error || 'Failed to send feedback. Please try again.';
    await messagingService.sendMessage(chatId, errorMessage);
  }
}

/**
 * Handle /connect command
 * Generates a link code for connecting WhatsApp to this Telegram account
 */
export async function handleConnectCommand(
  chatId: number,
  userId: number,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  fromDeepLink = false
): Promise<void> {
  if (platform !== MessagingPlatform.TELEGRAM) {
    return; // /connect only works from Telegram
  }

  const user = await getUserByTelegramId(userId);
  if (!user) return;

  const locale = user.language || 'en';
  const t = await getBotMessages(locale);
  const service = getMessagingService();

  // Check if already linked
  if (user.whatsappPhone) {
    const msg = (t.connect?.alreadyLinked || 'Your account is already linked to WhatsApp ({phone}).')
      .replace('{phone}', user.whatsappPhone);
    await service.sendMessage(chatId, msg, { format: MessageFormat.HTML });
    return;
  }

  const { generateLinkCode } = await import('../account-linking');
  const code = await generateLinkCode(userId);
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER;

  if (fromDeepLink && waNumber) {
    // Deep link flow: button that opens WA with pre-filled "link CODE"
    const waLink = `https://wa.me/${waNumber}?text=${encodeURIComponent(`link ${code}`)}`;
    const msg = t.connect?.deepLinkMsg || 'Tap below to link your WhatsApp account:';
    await service.sendMessage(chatId, msg, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.connect?.sendToWhatsApp || 'Send to WhatsApp', url: waLink }
        ]]
      }
    });
  } else {
    // Manual flow: show code
    const msg = (t.connect?.code || 'Your link code: <b>{code}</b>\n\nSend this on WhatsApp:\n<code>link {code}</code>\n\nThis code expires in 5 minutes.')
      .replace(/\{code\}/g, code);
    await service.sendMessage(chatId, msg, { format: MessageFormat.HTML });
  }
}

/**
 * Setup bot command handlers for polling mode
 */
export function setupHandlers(bot: TelegramBot) {
  // /start command - auto-registers new users
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const args = match?.[1]?.trim();
    if (userId) {
      await handleStartCommand(chatId, userId, MessagingPlatform.TELEGRAM, msg.from, args);
    }
  });

  // /connect command - link WhatsApp account
  bot.onText(/\/connect/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (userId) {
      await handleConnectCommand(chatId, userId, MessagingPlatform.TELEGRAM);
    }
  });

}
