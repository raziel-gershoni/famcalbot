/**
 * Telegram command handlers
 * Handles /start, /summary, /weather, /lookahead, /nextweek, /feedback
 */

import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getUserByIdentifier, getOrCreateUser, TelegramUserInfo } from '../user-service';
import { MessagingPlatform, MessageFormat } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import { buildUrl } from '../../config/urls';
import { executeCommand } from './command-pipeline';
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
      return formatWeatherAI(weatherData, user.language, user.name, timezone, user.culture, user.isAdmin, true);
    },
    onSuccess: async (result, messageId) => {
      // Try to generate and send infographic if prompt is available
      let infographicSent = false;
      let messageDeleted = false;
      if (result.infographicConfig) {
        try {
          const { generateWeatherInfographic } = await import('../weather/infographic');
          const imageBuffer = await generateWeatherInfographic(result.infographicConfig);
          if (imageBuffer) {
            // Delete progress message and send photo instead
            await messagingService.deleteMessage(chatId, messageId);
            messageDeleted = true;
            await messagingService.sendPhoto(chatId, imageBuffer, {});
            infographicSent = true;
          }
        } catch (err) {
          console.error(`[Weather] Infographic generation failed for user ${userId}:`, err);
        }
      }

      // Fall back to text message if infographic wasn't sent
      if (!infographicSent) {
        if (messageDeleted) {
          await messagingService.sendMessage(chatId, result.brief, { format: MessageFormat.HTML });
        } else {
          await messagingService.updateMessage(chatId, messageId, result.brief, { format: MessageFormat.HTML });
        }
      }

      // Generate voice message with detailed version if enabled
      if (user.voiceSummaryEnabled && platform === MessagingPlatform.TELEGRAM) {
        sendVoiceMessage(Number(userId), result.detailed, user).catch(err =>
          console.error(`[Weather] Voice generation failed for user ${userId}:`, err)
        );
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
      return generateWeekLookahead(lookahead, user, userLanguage, undefined, user.isAdmin);
    },
    onSuccess: async (formattedLookahead, messageId) => {
      await messagingService.updateMessage(chatId, messageId, formattedLookahead, { format: MessageFormat.HTML });

      // Generate voice message if enabled
      if (user.voiceSummaryEnabled && platform === MessagingPlatform.TELEGRAM) {
        sendWeeklyVoiceMessage(Number(userId), formattedLookahead, user, false).catch(err =>
          console.error(`[Lookahead] Voice generation failed for user ${userId}:`, err)
        );
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
      return generateNextWeekSummary(lookahead, user, userLanguage, undefined, user.isAdmin);
    },
    onSuccess: async (formattedSummary, messageId) => {
      await messagingService.updateMessage(chatId, messageId, formattedSummary, { format: MessageFormat.HTML });

      // Generate voice message if enabled
      if (user.voiceSummaryEnabled && platform === MessagingPlatform.TELEGRAM) {
        sendWeeklyVoiceMessage(Number(userId), formattedSummary, user, true).catch(err =>
          console.error(`[NextWeek] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
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

}
