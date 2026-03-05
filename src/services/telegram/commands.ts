/**
 * Telegram command handlers
 * Handles /start, /summary, /weather, /lookahead, /nextweek, /testmodels, /testai, /feedback
 */

import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getUserByIdentifier, getOrCreateUser, TelegramUserInfo } from '../user-service';
import { fetchTodayEvents, fetchTomorrowEvents } from '../calendar';
import { MessagingPlatform, MessageFormat } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import { buildUrl } from '../../config/urls';
import { executeCommand } from './command-pipeline';
import { VALID_LOCALES } from '../../utils/locale';
import { getBotMessages, getBotMessage } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb } from '../analytics-service';
import { checkFeatureAccess, incrementUsage } from '../subscription-service';
import { captureError } from '../../lib/error-capture';
import { prisma, withDbRetry } from '../../utils/prisma';
import { getPrimaryCalendar, getSpouseInfo } from '../../utils/calendar-helpers';
import { getBot, getMessagingService } from './bot';
import { sendVoiceMessage, sendWeeklyVoiceMessage } from './voice';
import {
  categorizeEvents,
  sendDailySummaryToUser,
  sendTomorrowSummaryToUser,
  sendSummaryToUser,
} from './summary';

/**
 * Check if user is authorized (supports both Telegram ID and WhatsApp phone)
 */
export async function isUserAuthorized(userId: number | string): Promise<boolean> {
  const user = await getUserByIdentifier(userId);
  return user !== undefined;
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

  // Set per-user menu button with localized text
  const { setUserMenuButton } = await import('./bot');
  await setUserMenuButton(user.telegramId, locale);

  // Handle deep link parameters (e.g., t.me/BotName?start=feedback)
  if (args === 'feedback') {
    const feedbackUrl = buildUrl(`/${locale}/feedback?user_id=${user.telegramId}`);
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

  const dashboardUrl = buildUrl(`/${locale}/dashboard?user_id=${user.telegramId}`);
  const welcome = t.start.welcome.replace('{name}', name);

  if (user.isAdmin) {
    const adminUrl = buildUrl(`/${locale}/admin-panel?user_id=${user.telegramId}`);
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
  existingProgressMessageId?: number
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
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId}`);
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

  if (args?.toLowerCase().trim() === 'tmrw') {
    await sendTomorrowSummaryToUser(user.telegramId, existingProgressMessageId);
  } else {
    await sendDailySummaryToUser(user.telegramId, existingProgressMessageId);
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
  existingProgressMessageId?: number
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
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId}`);
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

  // Check feature access for text summaries (weather shares quota with calendar summaries)
  const userLanguage = user.language || 'en';
  const weatherAccess = await checkFeatureAccess(user.id, 'text_summary');
  if (!weatherAccess.allowed) {
    const t = await getBotMessages(userLanguage);
    const upgradeUrl = buildUrl(`/${userLanguage}/subscription?user_id=${user.telegramId}`);
    const limitMessage = t.subscription?.textLimitReached
      || '📊 You\'ve reached your monthly text summary limit. Upgrade to continue!';
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
    progressType: 'weather',
    language: userLanguage,
    existingProgressMessageId,
    messagingService,
    errorKey: 'weatherFetch',
    commandName: 'Weather Command',
    context: `User: ${userId}, Location: ${user.location}`,
    operation: async () => {
      const { fetchWeather } = await import('../weather/open-meteo');
      const weatherData = await fetchWeather(user.location);

      const { TIMEZONE } = await import('../../config/constants');
      let timezone = TIMEZONE;
      try {
        const { getTimezone } = await import('../weather/geocoding');
        timezone = await getTimezone(user.location);
      } catch {
        // Fall back to default timezone
      }

      const { formatWeatherAI } = await import('../weather/formatter');
      return formatWeatherAI(weatherData, user.language, user.name, timezone, user.culture, user.isAdmin);
    },
    onSuccess: async (result, messageId) => {
      await messagingService.updateMessage(chatId, messageId, result.brief, { format: MessageFormat.HTML });

      // Send voice message with detailed version if enabled
      if (user.voiceSummaryEnabled && platform === MessagingPlatform.TELEGRAM) {
        try {
          await sendVoiceMessage(Number(userId), result.detailed, user, messagingService);
        } catch (err) {
          console.error(`Weather voice failed for user ${userId}:`, err);
        }
      }

      incrementUsage(user.id, 'textSummaries').catch(err =>
        console.error('[Subscription] Failed to increment weather usage:', err)
      );
    },
  });
}

/**
 * Handle /lookahead command
 * Displays notable upcoming events for the week
 */
export async function handleLookaheadCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  existingProgressMessageId?: number
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
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId}`);
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

  await executeCommand({
    chatId,
    progressType: 'lookahead',
    language: userLanguage,
    existingProgressMessageId,
    messagingService,
    errorKey: 'lookaheadFetch',
    commandName: 'Lookahead Command',
    context: `User: ${userId}`,
    operation: async () => {
      const { getWeekLookahead } = await import('../week-lookahead');
      const lookahead = await getWeekLookahead(user, user.calendarAssignments || []);

      const { generateWeekLookahead } = await import('../claude');
      return generateWeekLookahead(lookahead, user, userLanguage);
    },
    onSuccess: async (formattedLookahead, messageId) => {
      await messagingService.updateMessage(chatId, messageId, formattedLookahead, { format: MessageFormat.HTML });

      // Send voice message if enabled
      if (user.voiceSummaryEnabled && platform === MessagingPlatform.TELEGRAM) {
        try {
          await sendWeeklyVoiceMessage(Number(userId), formattedLookahead, user, false, messagingService);
        } catch (err) {
          console.error(`Weekly voice failed for user ${userId}:`, err);
        }
      }
    },
  });
}

/**
 * Handle /nextweek command - shows next week's events
 */
export async function handleNextWeekCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  existingProgressMessageId?: number
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
    const settingsUrl = buildUrl(`/en/settings?user_id=${user.telegramId}`);
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

  await executeCommand({
    chatId,
    progressType: 'nextweek',
    language: userLanguage,
    existingProgressMessageId,
    messagingService,
    errorKey: 'nextWeekFetch',
    commandName: 'Next Week Command',
    context: `User: ${userId}`,
    operation: async () => {
      const { getNextWeekLookahead } = await import('../week-lookahead');
      const lookahead = await getNextWeekLookahead(user, user.calendarAssignments || []);

      const { generateNextWeekSummary } = await import('../claude');
      return generateNextWeekSummary(lookahead, user, userLanguage);
    },
    onSuccess: async (formattedSummary, messageId) => {
      await messagingService.updateMessage(chatId, messageId, formattedSummary, { format: MessageFormat.HTML });

      // Send voice message if enabled
      if (user.voiceSummaryEnabled && platform === MessagingPlatform.TELEGRAM) {
        try {
          await sendWeeklyVoiceMessage(Number(userId), formattedSummary, user, true, messagingService);
        } catch (err) {
          console.error(`Next week voice failed for user ${userId}:`, err);
        }
      }
    },
  });
}

/**
 * Handle /testmodels command (admin only)
 */
export async function handleTestModelsCommand(chatId: number, userId: number, updateId: number, args?: string): Promise<void> {
  // Check if disabled via env var (emergency kill switch)
  if (process.env.DISABLE_TESTMODELS === 'true') {
    await getMessagingService().sendMessage(
      chatId,
      '⚠️ <b>testmodels is currently disabled</b>\n\nContact admin to re-enable.',
      { format: MessageFormat.HTML }
    );
    return;
  }

  const bot = getBot();
  const uniqueMarker = `[testrun-${updateId}]`;

  console.log(`Testmodels invoked with update_id: ${updateId}`);

  const { acquireTestModelsLock, releaseTestModelsLock } = await import('../../utils/redis-lock');
  const lockAcquired = await acquireTestModelsLock(userId, updateId);

  if (!lockAcquired) {
    console.log(`Lock not acquired - test already running or duplicate retry for user ${userId}`);
    return;
  }

  console.log('Lock acquired, getting user config...');
  const user = await getUserByTelegramId(userId);
  if (!user) {
    console.error(`User with Telegram ID ${userId} not found`);
    await releaseTestModelsLock(userId);
    return;
  }

  if (!user.isAdmin) {
    const t = await getBotMessages('en');
    await getMessagingService().sendMessage(chatId, t.errors.unauthorized);
    await releaseTestModelsLock(userId);
    return;
  }

  console.log('User found, importing test modules...');
  const { testModels, getModelsToTest } = await import('../model-tester');

  try {
    console.log('Fetching calendar events...');
    const allCalendarIds = user.calendarAssignments?.map(a => a.calendarId) || [];

    const todayEvents = await fetchTodayEvents(user.googleRefreshToken, allCalendarIds);
    console.log(`Fetched ${todayEvents.length} today events`);
    const tomorrowEvents = await fetchTomorrowEvents(user.googleRefreshToken, allCalendarIds);
    console.log(`Fetched ${tomorrowEvents.length} tomorrow events`);

    const categorizedToday = categorizeEvents(todayEvents, user);
    const categorizedTomorrow = categorizeEvents(tomorrowEvents, user);

    const modelsToTest = getModelsToTest(args);
    console.log(`Will test ${modelsToTest.length} models: ${modelsToTest.join(', ')}`);

    const primaryCalendar = user.calendarAssignments
      ? getPrimaryCalendar(user.calendarAssignments) || ''
      : '';

    const spouseInfo = getSpouseInfo(user);

    console.log('Starting testModels execution...');
    await testModels(
      modelsToTest,
      todayEvents,
      tomorrowEvents,
      categorizedToday.userEvents,
      categorizedToday.spouseEvents,
      categorizedToday.otherEvents,
      categorizedTomorrow.userEvents,
      categorizedTomorrow.spouseEvents,
      categorizedTomorrow.otherEvents,
      user.name,
      user.englishName,
      user.gender,
      spouseInfo?.name,
      spouseInfo?.englishName,
      spouseInfo?.gender,
      primaryCalendar,
      chatId,
      uniqueMarker
    );
    console.log('testModels execution completed successfully');
  } catch (error) {
    console.error('Error in testmodels command:', error);
    await getMessagingService().sendMessage(chatId, 'Sorry, there was an error running the model tests.');

    const { notifyAdminError } = await import('../../utils/error-notifier');
    await notifyAdminError('TestModels Command', error, `Args: ${args || 'none'}`);
  } finally {
    console.log('Releasing lock...');
    await releaseTestModelsLock(userId);
    console.log('Lock released, testmodels handler complete');
  }
}

/**
 * Handle /testai command - show model selection buttons
 * Supports: /testai (today) or /testai tmrw (tomorrow)
 */
export async function handleTestAICommand(chatId: number, userId: number, args?: string): Promise<void> {
  const user = await getUserByTelegramId(userId);
  if (!user?.isAdmin) {
    const errorMsg = await getBotMessage(user?.language || 'en', 'errors.unauthorized');
    await getMessagingService().sendMessage(chatId, errorMsg);
    return;
  }

  const { getAvailableModels, getModelConfig } = await import('../../config/ai-models');
  const messagingService = getMessagingService();

  const timeframe = args?.toLowerCase().includes('tmrw') || args?.toLowerCase().includes('tomorrow') ? 'tmrw' : 'today';
  const timeLabel = timeframe === 'tmrw' ? 'tomorrow' : 'today';

  try {
    const models = getAvailableModels();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keyboard: any[][] = [];
    for (let i = 0; i < models.length; i += 2) {
      const row = [];

      const modelId1 = models[i];
      const config1 = getModelConfig(modelId1);
      if (config1) {
        row.push({
          text: config1.displayName,
          callback_data: `testai:${modelId1}:${timeframe}`
        });
      }

      if (i + 1 < models.length) {
        const modelId2 = models[i + 1];
        const config2 = getModelConfig(modelId2);
        if (config2) {
          row.push({
            text: config2.displayName,
            callback_data: `testai:${modelId2}:${timeframe}`
          });
        }
      }

      keyboard.push(row);
    }

    await messagingService.sendMessage(
      chatId,
      `🤖 <b>Test AI Models</b>\n\nSelect a model to generate <b>${timeLabel}'s</b> summary with voice:\n\n<i>Each model will generate both text and voice summary.</i>`,
      {
        format: MessageFormat.HTML,
        replyMarkup: {
          inline_keyboard: keyboard
        }
      }
    );
  } catch (error) {
    console.error('Error in testai command:', error);
    await messagingService.sendMessage(chatId, 'Sorry, there was an error showing model options.');

    const { notifyAdminError } = await import('../../utils/error-notifier');
    await notifyAdminError('TestAI Command', error);
  }
}

/**
 * Handle callback when user clicks a model button
 */
export async function handleTestAICallback(
  chatId: number,
  userId: number,
  modelId: string,
  queryId: string,
  timeframe: string = 'today'
): Promise<void> {
  const user = await getUserByTelegramId(userId);
  if (!user?.isAdmin) {
    await getBot().answerCallbackQuery(queryId, { text: 'Unauthorized' });
    return;
  }

  const messagingService = getMessagingService();
  const botInstance = getBot();
  const { getModelConfig } = await import('../../config/ai-models');

  try {
    const config = getModelConfig(modelId);
    if (!config) {
      await botInstance.answerCallbackQuery(queryId, { text: 'Invalid model' });
      return;
    }

    const isTomorrow = timeframe === 'tmrw';
    const fetchFunction = isTomorrow ? fetchTomorrowEvents : fetchTodayEvents;
    const summaryDate = isTomorrow ? (() => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow;
    })() : undefined;
    const timeLabel = isTomorrow ? 'tomorrow' : 'today';

    await botInstance.answerCallbackQuery(queryId, {
      text: `Generating ${timeLabel}'s summary with ${config.displayName}...`
    });

    await sendSummaryToUser(
      userId,
      fetchFunction,
      summaryDate,
      'Sorry, there was an error generating the summary.',
      modelId
    );
  } catch (error) {
    console.error('Error in testai callback:', error);
    await messagingService.sendMessage(chatId, 'Sorry, there was an error generating the summary.');

    const { notifyAdminError } = await import('../../utils/error-notifier');
    await notifyAdminError('TestAI Callback', error);
  }
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
    const feedbackUrl = buildUrl(`/${userLanguage}/feedback?user_id=${user.telegramId}`);
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

    const recentFeedbackCount = await withDbRetry(
      () => prisma.userFeedback.count({
        where: {
          userId: user.id,
          createdAt: { gte: oneDayAgo }
        }
      }),
      'feedback.rate-limit-check'
    );

    if (recentFeedbackCount >= 3) {
      const rateLimitMessage = t.feedback?.rateLimit || "You've reached the daily feedback limit. Please try again tomorrow.";
      await messagingService.sendMessage(chatId, rateLimitMessage);
      return;
    }

    await withDbRetry(
      () => prisma.userFeedback.create({
        data: {
          userId: user.id,
          text: trimmedText,
          source: 'telegram'
        }
      }),
      'feedback.create'
    );

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

  // /testmodels command (admin only)
  bot.onText(/\/testmodels(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const args = match?.[1]?.trim();
    // In polling mode, use message_id as updateId since we don't have update_id
    const updateId = msg.message_id;
    if (userId) {
      await handleTestModelsCommand(chatId, userId, updateId, args);
    }
  });

  // /testai command - show model selection buttons (admin only), supports /testai or /testai tmrw
  bot.onText(/\/testai(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const args = match?.[1]?.trim();
    if (userId) {
      await handleTestAICommand(chatId, userId, args);
    }
  });

  // Handle callback queries from inline keyboard buttons
  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (!chatId || !data) return;

    // Handle model selection callbacks
    if (data.startsWith('testai:')) {
      const parts = data.replace('testai:', '').split(':');
      const modelId = parts[0];
      const timeframe = parts[1] || 'today';
      await handleTestAICallback(chatId, userId, modelId, query.id, timeframe);
    }
  });
}
