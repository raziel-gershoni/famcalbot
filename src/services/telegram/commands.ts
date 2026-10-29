/**
 * Telegram command handlers
 * Handles /start, /summary, /weather, /lookahead, /nextweek, /feedback
 */

import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getUserByIdentifier, getOrCreateUser, TelegramUserInfo } from '../user-service';
import { MessagingPlatform, MessageFormat, IMessagingService } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import type { StreamMessageHandle } from '../messaging/types';
import { buildUrl } from '../../config/urls';
import { SHARE_STORY_LABELS, getLabel } from '../../config/labels';
import { REDIS_KEYS } from '../../config/redis-keys';
import { executeCommand, startTypingInterval } from './command-pipeline';
import { VALID_LOCALES } from '../../utils/locale';
import { getBotMessages } from '../../lib/bot-messages';
import { policyLinks, withPolicy } from '../../lib/plan-disclosure';
import { trackActivityAsync, addBreadcrumb } from '../analytics-service';
import { incrementUsage } from '../subscription-service';
import { captureError } from '../../lib/error-capture';
import { prisma } from '../../utils/prisma';
import { getMessagingService } from './bot';
import { sendVoiceMessage, sendWeeklyVoiceMessage } from './voice';
import {
  sendDailySummaryToUser,
  sendTomorrowSummaryToUser,
  routeTextMessage,
} from './summary';
import { answerGoogleReadError } from './google-read-errors';
import { denyOverTextLimit } from './text-limit';

/**
 * One command_completed row for a bot command that ran to the end (a denial, an error reply
 * or an unknown user is not a completion). Metadata: the command name and the platform,
 * never the arguments. /start and /feedback have their own rows (bot_start, feedback_submitted).
 */
function trackCommandCompleted(userId: number, command: string, platform: MessagingPlatform): void {
  trackActivityAsync(userId, 'command_completed', { command, platform });
}

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
 * The setup nudge a command sends before it runs: only a missing location. Everyone has
 * FamCal, and connecting Google is optional ("Google as a connection"), so a command is
 * never held back to connect Google or choose calendars; the 07:00 nudges and the home's
 * banners ask for those.
 * Returns true if a nudge was sent (caller should return early), false otherwise.
 */
export async function sendSetupNudgeIfNeeded(
  user: { id: number; telegramId: number | bigint | null; location?: string; language?: string },
  chatId: number | string,
  messagingService: IMessagingService,
  platform: MessagingPlatform
): Promise<boolean> {
  if (user.location) return false;
  const userLanguage = user.language || 'en';
  const { generateMagicLink } = await import('../magic-link');
  const url = buildUrl(`/${userLanguage}/settings?user_id=${user.telegramId ?? user.id}`);
  const t = await getBotMessages(userLanguage);
  const nudge = t.setupNudge || {};
  // "Your calendar is ready, just tell me where you live": FamCal is ready for everyone.
  const message = nudge.noLocationNative || 'Your calendar is ready! Tell me where you live for weather + timezone.';
  const buttonText = nudge.noLocationButton || '📍 Set Location';
  const buttonUrl = platform === MessagingPlatform.WHATSAPP ? await generateMagicLink(user.id, userLanguage) : url;
  await messagingService.sendMessage(chatId, message, {
    format: MessageFormat.HTML,
    ...(platform === MessagingPlatform.TELEGRAM
      ? { replyMarkup: { inline_keyboard: [[{ text: buttonText, web_app: { url } }]] } }
      : { whatsappUrlButton: { text: buttonText, url: buttonUrl } }),
  });
  return true;
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

  // Every reply below ends with the Privacy Policy and the Terms (the notice that comes with the first request for data),
  // with no link preview (the preview would be the policy page's card): the plain welcome, and each deep link that can be
  // someone's first message (feedback, connect, a partner's invite). gc_ is answered above: it never creates an account.
  const links = policyLinks(t.policy, locale, 'html');

  // Handle deep link parameters (e.g., t.me/BotName?start=feedback)
  if (args === 'feedback') {
    const feedbackUrl = buildUrl(`/${locale}/feedback?user_id=${user.telegramId ?? user.id}`);
    const openFormMessage = t.feedback?.openForm || 'Click below to send feedback:';
    await service.sendMessage(chatId, `${openFormMessage}\n\n${links}`, {
      format: MessageFormat.HTML,
      disablePreview: true,
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
    await handleConnectCommand(Number(chatId), userIdNum, platform, true, links);
    return;
  }

  // Pairing invite deep link: t.me/<bot>?start=invite_<packed token> (src/lib/invite-link.ts)
  if (args && args.startsWith('invite_')) {
    const { handlePairStart } = await import('./pair-handler');
    await handlePairStart(chatId, user.id, args.slice('invite_'.length), locale, platform, links);
    return;
  }

  const dashboardUrl = buildUrl(`/${locale}/dashboard?user_id=${user.telegramId ?? user.id}`);
  const welcome = t.start.welcome.replace('{name}', name);

  if (user.isAdmin) {
    const adminUrl = buildUrl(`/${locale}/admin-panel?user_id=${user.telegramId ?? user.id}`);
    const message = `${welcome}\n\n${t.start.chooseBoard}\n\n${links}`;

    await service.sendMessage(chatId, message, {
      format: MessageFormat.HTML,
      disablePreview: true,
      replyMarkup: {
        inline_keyboard: [
          [{ text: t.start.userDashboard, web_app: { url: dashboardUrl } }],
          [{ text: t.start.adminPanel, web_app: { url: adminUrl } }]
        ]
      }
    });
    return;
  }

  // Everyone has FamCal, created at signup or lazily, and Google is optional ("Google as a
  // connection"), so the only setup that gates good summaries is a location: welcome the
  // user warmly and point at /settings.
  const needsLocationOnly = !user.location;

  if (needsLocationOnly) {
    const settingsUrl = buildUrl(`/${locale}/settings?user_id=${user.telegramId ?? user.id}`);
    const platformName = platform === MessagingPlatform.TELEGRAM ? 'Telegram' : 'WhatsApp';
    const nativeWelcome = t.onboarding.nativeWelcome
      .replace('{platform}', platformName)
      .replace('{name}', name);
    await service.sendMessage(chatId, `${nativeWelcome}\n\n${links}`, {
      format: MessageFormat.HTML,
      disablePreview: true,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.onboarding.nativeLocationButton, web_app: { url: settingsUrl } }
        ]]
      }
    });
    return;
  }

  // Returning user: simple dashboard button
  const message = `${welcome}\n\n${t.start.tapButton}\n\n${links}`;

  await service.sendMessage(chatId, message, {
    format: MessageFormat.HTML,
    disablePreview: true,
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
  const tomorrow = args?.toLowerCase().trim() === 'tmrw';
  const completed = tomorrow
    ? await sendTomorrowSummaryToUser(chatId, platform, streamHandle)
    : await sendDailySummaryToUser(chatId, platform, streamHandle);
  if (completed) trackCommandCompleted(user.id, tomorrow ? 'summary_tomorrow' : 'summary', platform);
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
  if (await sendSetupNudgeIfNeeded(user, chatId, messagingService, platform)) return;

  // Text summaries are metered: weather, /lookahead and /nextweek share the quota with the calendar summaries
  if (await denyOverTextLimit(user, chatId, messagingService, userLanguage)) return;

  const completed = await executeCommand({
    chatId,
    language: userLanguage,
    messagingService,
    errorKey: 'weatherFetch',
    userId: user.id,
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
  if (completed) trackCommandCompleted(user.id, 'weather', platform);
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

  if (await denyOverTextLimit(user, chatId, messagingService, userLanguage, streamHandle)) return;

  const completed = await executeCommand({
    chatId,
    language: userLanguage,
    messagingService,
    errorKey: 'lookaheadFetch',
    userId: user.id,
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
      const text = await generateWeekLookahead(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta, calendars);
      return { text, googleGap: lookahead.googleGap };
    },
    onSuccess: async ({ text: formattedLookahead, googleGap }) => {
      const deliveryPlatform = platform === MessagingPlatform.TELEGRAM ? 'telegram' : 'whatsapp';
      await routeTextMessage(chatId, formattedLookahead, user, deliveryPlatform as 'telegram' | 'whatsapp', false, undefined, streamHandle);
      // The week kept FamCal's events without Google's: say why, as a failed read would
      if (googleGap) {
        const { googleGapError } = await import('../calendar-read/digest');
        await answerGoogleReadError(googleGapError(googleGap), { chatId, user, userLanguage, messagingService });
      }

      // Generate voice message if enabled
      if (user.voiceSummaryEnabled) {
        sendWeeklyVoiceMessage(chatId, formattedLookahead, user, false, undefined, platform).catch(err =>
          console.error(`[Lookahead] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
    onError: (error) => answerGoogleReadError(error, { chatId, user, userLanguage, messagingService, streamHandle }),
  });
  if (completed) trackCommandCompleted(user.id, 'lookahead', platform);
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

  if (await denyOverTextLimit(user, chatId, messagingService, userLanguage, streamHandle)) return;

  const completed = await executeCommand({
    chatId,
    language: userLanguage,
    messagingService,
    errorKey: 'nextWeekFetch',
    userId: user.id,
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
      const text = await generateNextWeekSummary(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta, calendars);
      return { text, googleGap: lookahead.googleGap };
    },
    onSuccess: async ({ text: formattedSummary, googleGap }) => {
      const deliveryPlatform = platform === MessagingPlatform.TELEGRAM ? 'telegram' : 'whatsapp';
      await routeTextMessage(chatId, formattedSummary, user, deliveryPlatform as 'telegram' | 'whatsapp', false, undefined, streamHandle);
      // Next week kept FamCal's events without Google's: say why, as a failed read would
      if (googleGap) {
        const { googleGapError } = await import('../calendar-read/digest');
        await answerGoogleReadError(googleGapError(googleGap), { chatId, user, userLanguage, messagingService });
      }

      // Generate voice message if enabled
      if (user.voiceSummaryEnabled) {
        sendWeeklyVoiceMessage(chatId, formattedSummary, user, true, undefined, platform).catch(err =>
          console.error(`[NextWeek] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
    onError: (error) => answerGoogleReadError(error, { chatId, user, userLanguage, messagingService, streamHandle }),
  });
  if (completed) trackCommandCompleted(user.id, 'nextweek', platform);
}

/** Where a feedback message came from: its own column on UserFeedback, and the admin note's "Source". */
type FeedbackSource = 'telegram' | 'whatsapp' | 'paysupport';

/**
 * The subscription facts a payment question carries to the admins, so a refund can be made by hand: the person's
 * id, plan, status, the Telegram payment charge id and the period's start. A failed read is logged and told in the
 * note; it never stops the question from reaching the admins.
 */
async function paymentFacts(userId: number): Promise<Record<string, string>> {
  const facts: Record<string, string> = { 'User id': String(userId) };
  try {
    const subscription = await prisma.subscription.findUnique({ where: { userId } });
    if (!subscription) {
      facts.Subscription = 'none';
      return facts;
    }
    facts.Plan = subscription.plan;
    facts.Status = subscription.status;
    facts['Charge id'] = subscription.telegramPaymentChargeId ?? 'none';
    facts['Period start'] = subscription.currentPeriodStart?.toISOString() ?? 'none';
  } catch (error) {
    console.error(`[paysupport] could not read the subscription of user ${userId}:`, error);
    captureError(error, 'paysupport-subscription', { user_id: userId }, 'warning');
    facts.Subscription = 'lookup failed';
  }
  return facts;
}

/**
 * Handle /feedback command (and /paysupport with words, which is the same message under its own source)
 * Allows users to submit feedback via Telegram or WhatsApp
 * Usage: /feedback <text> (10-1000 characters)
 * Rate limited to 3 submissions per 24 hours, payment questions counted apart from feedback so one never blocks the other
 * `userId` is the Telegram id (a number) or the WhatsApp phone/BSUID (a string), as getUserByIdentifier reads it.
 */
export async function handleFeedbackCommand(
  chatId: number | string,
  userId: number | string,
  feedbackText: string | undefined,
  options: { platform?: MessagingPlatform; source?: FeedbackSource } = {}
): Promise<void> {
  const platform = options.platform ?? MessagingPlatform.TELEGRAM;
  const source: FeedbackSource = options.source ?? (platform === MessagingPlatform.WHATSAPP ? 'whatsapp' : 'telegram');

  const user = await getUserByIdentifier(userId);
  if (!user) {
    console.error(`[Feedback] User ${userId} (${platform}) not found`);
    return;
  }

  const messagingService = platform === MessagingPlatform.TELEGRAM ? getMessagingService() : getMessagingServiceByPlatform(platform);
  const userLanguage = user.language || 'en';
  const t = await getBotMessages(userLanguage);

  // The form is a Mini App button: only /feedback on Telegram offers it (a payment question with no words is answered before it gets here)
  if ((!feedbackText || feedbackText.trim().length === 0) && source === 'telegram') {
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

  const trimmedText = (feedbackText ?? '').trim();

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
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentFeedbackCount = await prisma.userFeedback.count({
      where: {
        userId: user.id,
        createdAt: { gte: oneDayAgo },
        source: source === 'paysupport' ? 'paysupport' : { not: 'paysupport' }
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
        source
      }
    });

    const { notifyAdminFeedback } = await import('../../utils/error-notifier');
    await notifyAdminFeedback(user.name, user.telegramId, trimmedText, source, source === 'paysupport' ? await paymentFacts(user.id) : undefined);

    trackActivityAsync(user.id, 'feedback_submitted', {
      source,
      text_length: trimmedText.length
    });

    const successMessage = source === 'paysupport' ? t.support.paySent : t.feedback?.success || 'Thank you for your feedback!';
    await messagingService.sendMessage(chatId, successMessage);

    console.log(`[Feedback] User ${user.id} submitted ${source} feedback (${trimmedText.length} chars)`);
  } catch (error) {
    console.error('[Feedback] Error handling feedback command:', error);
    captureError(error, 'feedback-command', { user_id: user.id, source });

    const errorMessage = t.feedback?.error || 'Failed to send feedback. Please try again.';
    await messagingService.sendMessage(chatId, errorMessage);
  }
}

/**
 * Handle /terms, /support and /paysupport (Telegram's rules for a bot that takes Stars payments: it must answer
 * /terms and /paysupport). Each answers a person the bot does not know yet too, in English. /terms and /paysupport carry
 * the ways to cancel within 14 days, and /terms the links to the Privacy Policy and the Terms (src/lib/plan-disclosure.ts),
 * in the person's language, with no link preview. /paysupport with words
 * is a payment question: it goes through handleFeedbackCommand under its own source, and needs a known person (the
 * admins answer in the chat), who is told to /start first when it is not.
 */
export async function handleSupportCommand(
  chatId: number,
  userId: number,
  command: 'terms' | 'support' | 'paysupport',
  args?: string
): Promise<void> {
  const user = await getUserByTelegramId(userId);
  const locale = user?.language || 'en';
  const t = await getBotMessages(locale);
  const messagingService = getMessagingService();
  const reply = (text: string) => messagingService.sendMessage(chatId, text, { format: MessageFormat.HTML, disablePreview: true });

  if (command === 'terms') {
    await reply(withPolicy(t.support.terms, t.policy, locale));
  } else if (command === 'support' || (command === 'paysupport' && !args)) {
    await reply(command === 'support' ? t.support.help : withPolicy(t.support.payPrompt, t.policy, locale));
  } else if (!user) {
    console.error(`[paysupport] unknown user: Telegram id ${userId} wrote a payment question before /start`);
    await reply(t.support.help);
  } else {
    await handleFeedbackCommand(chatId, userId, args, { source: 'paysupport' });
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
  fromDeepLink = false,
  /** /start connect's policy links (a first message): each reply ends with them, with no link preview. */
  footer?: string
): Promise<void> {
  if (platform !== MessagingPlatform.TELEGRAM) {
    return; // /connect only works from Telegram
  }

  const user = await getUserByTelegramId(userId);
  if (!user) return;

  const locale = user.language || 'en';
  const t = await getBotMessages(locale);
  const service = getMessagingService();
  const withFooter = (msg: string) => (footer ? `${msg}\n\n${footer}` : msg);
  const noPreview = footer ? { disablePreview: true } : {};

  // Check if already linked
  if (user.whatsappPhone) {
    const msg = (t.connect?.alreadyLinked || 'Your account is already linked to WhatsApp ({phone}).')
      .replace('{phone}', user.whatsappPhone);
    await service.sendMessage(chatId, withFooter(msg), { format: MessageFormat.HTML, ...noPreview });
    return;
  }

  const { generateLinkCode } = await import('../account-linking');
  const code = await generateLinkCode(userId);
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER;

  if (fromDeepLink && waNumber) {
    // Deep link flow: button that opens WA with pre-filled "link CODE"
    const waLink = `https://wa.me/${waNumber}?text=${encodeURIComponent(`link ${code}`)}`;
    const msg = t.connect?.deepLinkMsg || 'Tap below to link your WhatsApp account:';
    await service.sendMessage(chatId, withFooter(msg), {
      format: MessageFormat.HTML,
      ...noPreview,
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
    await service.sendMessage(chatId, withFooter(msg), { format: MessageFormat.HTML, ...noPreview });
  }
  trackCommandCompleted(user.id, 'connect', platform);
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
