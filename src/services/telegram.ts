import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getUserByIdentifier, getWhitelistedIds, getAllUsers } from './user-service';
import { fetchTodayEvents, fetchTomorrowEvents } from './calendar';
import { generateSummary } from './claude';
import { CalendarEvent, UserConfig } from '../types';
import { USER_MESSAGES } from '../config/messages';
import { ADMIN_USER_ID } from '../config/constants';
import { IMessagingService, getTelegramService, getMessagingService as getMessagingServiceByPlatform, MessagingPlatform, MessageFormat } from './messaging';

/**
 * Categorize events by ownership for a specific user
 */
function categorizeEvents(events: CalendarEvent[], user: UserConfig) {
  return {
    userEvents: events.filter(e => user.ownCalendars.includes(e.calendarId)),
    spouseEvents: events.filter(e => user.spouseCalendars.includes(e.calendarId)),
    otherEvents: events.filter(
      e => !user.ownCalendars.includes(e.calendarId) && !user.spouseCalendars.includes(e.calendarId)
    ),
  };
}

let bot: TelegramBot | null = null;
let messagingService: IMessagingService | null = null;

/**
 * Initialize the Telegram bot
 */
export function initBot(): TelegramBot {
  if (bot) {
    return bot;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  bot = new TelegramBot(token, { polling: true });

  setupHandlers(bot);

  return bot;
}

/**
 * Get or create bot instance (without polling for serverless)
 */
export function getBot(): TelegramBot {
  if (bot) {
    return bot;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  bot = new TelegramBot(token);
  return bot;
}

/**
 * Get or create messaging service instance
 */
export function getMessagingService(): IMessagingService {
  if (!messagingService) {
    const botInstance = getBot();
    messagingService = getTelegramService(botInstance);
  }
  return messagingService;
}

/**
 * Check if user is authorized (supports both Telegram ID and WhatsApp phone)
 */
export async function isUserAuthorized(userId: number | string): Promise<boolean> {
  const user = await getUserByIdentifier(userId);
  return user !== undefined;
}

/**
 * Handle /start command
 */
export async function handleStartCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM
): Promise<void> {
  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    await service.sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  const user = await getUserByIdentifier(userId);
  const name = user?.name || 'there';

  const service = platform === MessagingPlatform.TELEGRAM
    ? getMessagingService()
    : getMessagingServiceByPlatform(platform);
  await service.sendMessage(chatId, USER_MESSAGES.WELCOME(name));
}

/**
 * Handle /help command
 */
export async function handleHelpCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM
): Promise<void> {
  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    await service.sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  const service = platform === MessagingPlatform.TELEGRAM
    ? getMessagingService()
    : getMessagingServiceByPlatform(platform);
  await service.sendMessage(chatId, USER_MESSAGES.HELP);
}

/**
 * Handle /summary command
 * Supports: /summary (today), /summary tmrw
 */
export async function handleSummaryCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  args?: string
): Promise<void> {
  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    await service.sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  // For now, summary commands only work with Telegram ID
  // TODO: Update sendDailySummaryToUser to support platform parameter
  const user = await getUserByIdentifier(userId);
  if (!user) return;

  // Check if user wants tomorrow's summary
  if (args?.toLowerCase().trim() === 'tmrw') {
    await sendTomorrowSummaryToUser(user.telegramId);
  } else {
    await sendDailySummaryToUser(user.telegramId);
  }
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

  // Admin-only command
  if (userId !== ADMIN_USER_ID) {
    await getMessagingService().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  // Use Redis-based distributed lock to prevent duplicate executions
  const bot = getBot();
  const uniqueMarker = `[testrun-${updateId}]`;

  console.log(`Testmodels invoked with update_id: ${updateId}`);

  // Try to acquire lock
  const { acquireTestModelsLock, releaseTestModelsLock } = await import('../utils/redis-lock');
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

  console.log('User found, importing test modules...');
  const { testModels, getModelsToTest } = await import('./model-tester');

  try {
    console.log('Fetching calendar events...');
    // Fetch today and tomorrow events
    const todayEvents = await fetchTodayEvents(user.googleRefreshToken, user.calendars);
    console.log(`Fetched ${todayEvents.length} today events`);
    const tomorrowEvents = await fetchTomorrowEvents(user.googleRefreshToken, user.calendars);
    console.log(`Fetched ${tomorrowEvents.length} tomorrow events`);

    // Categorize events by ownership - separately for today and tomorrow
    const categorizedToday = categorizeEvents(todayEvents, user);
    const categorizedTomorrow = categorizeEvents(tomorrowEvents, user);

    // Get list of models to test
    const modelsToTest = getModelsToTest(args);
    console.log(`Will test ${modelsToTest.length} models: ${modelsToTest.join(', ')}`);

    // Run the tests
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
      user.hebrewName,
      user.gender,
      user.spouseName,
      user.spouseHebrewName,
      user.spouseGender,
      user.primaryCalendar,
      chatId,
      uniqueMarker
    );
    console.log('testModels execution completed successfully');
  } catch (error) {
    console.error('Error in testmodels command:', error);
    await getMessagingService().sendMessage(chatId, 'Sorry, there was an error running the model tests.');

    // Notify admin
    const { notifyAdminError } = await import('../utils/error-notifier');
    await notifyAdminError('TestModels Command', error, `Args: ${args || 'none'}`);
  } finally {
    // Always release lock when done (success or failure)
    console.log('Releasing lock...');
    await releaseTestModelsLock(userId);
    console.log('Lock released, testmodels handler complete');
  }
}

/**
 * Setup bot command handlers for polling mode
 */
function setupHandlers(bot: TelegramBot) {
  // /start command
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (userId) {
      await handleStartCommand(chatId, userId);
    }
  });

  // /help command
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (userId) {
      await handleHelpCommand(chatId, userId);
    }
  });

  // /summary command - supports /summary, /summary tmrw
  bot.onText(/\/summary(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const args = match?.[1]?.trim();
    if (userId) {
      await handleSummaryCommand(chatId, userId, MessagingPlatform.TELEGRAM, args);
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

  // /weather command - supports /weather, /weather std, /weather dtl
  bot.onText(/\/weather(?:\s+(std|dtl))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const args = match?.[1]?.trim();
    if (userId) {
      await handleWeatherCommand(chatId, userId, MessagingPlatform.TELEGRAM, args);
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
      const timeframe = parts[1] || 'today'; // Default to 'today' if not specified
      await handleTestAICallback(chatId, userId, modelId, query.id, timeframe);
    }

    // Handle weather format selection callbacks
    if (data.startsWith('weather:')) {
      const format = data.replace('weather:', '');
      await handleWeatherCallback(chatId, userId, format, query.id);
    }
  });
}

/**
 * Generic function to send summary to a specific user
 * @param userId - Telegram user ID
 * @param fetchFunction - Function to fetch calendar events (today or tomorrow)
 * @param summaryDate - Date for the summary (undefined for today, tomorrow's date for tomorrow)
 * @param fetchingMessage - Message to show while fetching
 * @param errorMessage - Message to show on error
 * @param modelId - Optional model ID to override default model
 */
async function sendSummaryToUser(
  userId: number,
  fetchFunction: (refreshToken: string, calendarIds: string[]) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined,
  fetchingMessage: string,
  errorMessage: string,
  modelId?: string
): Promise<void> {
  const user = await getUserByTelegramId(userId);
  if (!user) {
    console.error(`User with Telegram ID ${userId} not found`);
    return;
  }

  const messagingService = getMessagingService();
  const botInstance = getBot(); // Still needed for voice and callbacks

  try {
    await messagingService.sendMessage(userId, fetchingMessage);

    // Fetch calendar events
    const events = await fetchFunction(user.googleRefreshToken, user.calendars);

    // Categorize events by ownership
    const categorized = categorizeEvents(events, user);

    // Generate summary with AI (personalized for this user)
    // Include model info footer only for admin user
    const summary = await generateSummary(
      categorized.userEvents,
      categorized.spouseEvents,
      categorized.otherEvents,
      user.name,
      user.hebrewName,
      user.gender,
      user.spouseName,
      user.spouseHebrewName,
      user.spouseGender,
      user.primaryCalendar,
      summaryDate,
      userId === ADMIN_USER_ID,
      modelId,
      user.location,
      user.language
    );

    // Send personalized message (greeting is included in the summary)
    await messagingService.sendMessage(userId, summary, { format: MessageFormat.HTML });

    // Generate and send voice message for admin user only (for /summary command only)
    if (userId === ADMIN_USER_ID && summaryDate === undefined) {
      await sendVoiceMessage(userId, summary, modelId, user.language);
    }
  } catch (error) {
    console.error(`Error sending summary to user ${userId}:`, error);
    await messagingService.sendMessage(userId, errorMessage);

    // Notify admin of summary failures
    const { notifyAdminError } = await import('../utils/error-notifier');
    await notifyAdminError(
      'Summary Generation',
      error,
      `User: ${userId}, Date: ${summaryDate ? summaryDate.toISOString() : 'today'}`
    );
  }
}

/**
 * Generic function to send summary to all users
 * @param fetchFunction - Function to fetch calendar events (today or tomorrow)
 * @param summaryDate - Date for the summary (undefined for today, tomorrow's date for tomorrow)
 */
async function sendSummaryToAll(
  fetchFunction: (refreshToken: string, calendarIds: string[]) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined
): Promise<void> {
  const messagingService = getMessagingService();
  const botInstance = getBot(); // Still needed for voice and callbacks

  try {
    // Get all users from database (single query instead of multiple)
    const users = await getAllUsers();
    if (users.length === 0) {
      console.error('No users configured');
      return;
    }

    // Get the first user to fetch calendars (they all share the same calendars)
    const firstUser = users[0];

    // Fetch calendar events once (shared by all users)
    const events = await fetchFunction(firstUser.googleRefreshToken, firstUser.calendars);

    // Send to each user with personalized summary
    for (const user of users) {
      try {

        // Categorize events by ownership for this user
        const categorized = categorizeEvents(events, user);

        // Generate personalized summary for this specific user
        // Include model info footer only for admin user
        const summary = await generateSummary(
          categorized.userEvents,
          categorized.spouseEvents,
          categorized.otherEvents,
          user.name,
          user.hebrewName,
          user.gender,
          user.spouseName,
          user.spouseHebrewName,
          user.spouseGender,
          user.primaryCalendar,
          summaryDate,
          user.telegramId === ADMIN_USER_ID,
          undefined,
          user.location,
          user.language
        );
        // Route message based on user's messaging platform preference
        const platform = user.messagingPlatform || 'telegram'; // Default to telegram

        switch (platform) {
          case 'telegram':
            // Send to Telegram only
            await messagingService.sendMessage(user.telegramId, summary, { format: MessageFormat.HTML });
            if (summaryDate === undefined) {
              await sendVoiceMessage(user.telegramId, summary, undefined, user.language);
            }
            break;

          case 'whatsapp':
            // Send to WhatsApp only
            if (user.whatsappPhone) {
              const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
              await whatsappService.sendMessage(user.whatsappPhone, summary, { format: MessageFormat.HTML });
              if (summaryDate === undefined) {
                // TODO: Implement voice message for WhatsApp
                // await whatsappService.sendVoice(user.whatsappPhone, voiceFile);
              }
            }
            break;

          case 'all':
            // Send to both platforms
            await messagingService.sendMessage(user.telegramId, summary, { format: MessageFormat.HTML });
            if (summaryDate === undefined) {
              await sendVoiceMessage(user.telegramId, summary, undefined, user.language);
            }
            if (user.whatsappPhone) {
              const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
              await whatsappService.sendMessage(user.whatsappPhone, summary, { format: MessageFormat.HTML });
              if (summaryDate === undefined) {
                // TODO: Implement voice message for WhatsApp
                // await whatsappService.sendVoice(user.whatsappPhone, voiceFile);
              }
            }
            break;
        }
      } catch (error) {
        console.error(`Failed to send summary to user ${user.telegramId}:`, error);
        // Individual user failures in batch - log but don't spam admin
        // Will be caught by outer try-catch if entire batch fails
      }
    }
  } catch (error) {
    console.error('Failed to generate summary for all users:', error);

    // Notify admin of batch failure
    const { notifyAdminError } = await import('../utils/error-notifier');
    await notifyAdminError(
      'Batch Summary Generation',
      error,
      `Date: ${summaryDate ? summaryDate.toISOString() : 'today'}`
    );
  }
}

/**
 * Send daily summary to a specific user
 */
export async function sendDailySummaryToUser(userId: number): Promise<void> {
  await sendSummaryToUser(
    userId,
    fetchTodayEvents,
    undefined,
    USER_MESSAGES.FETCHING_CALENDAR,
    USER_MESSAGES.ERROR_GENERIC
  );
}

/**
 * Send daily summary to all users
 * Generates personalized summary for each user based on their primary calendar
 */
export async function sendDailySummaryToAll(): Promise<void> {
  await sendSummaryToAll(fetchTodayEvents, undefined);
}

/**
 * Send tomorrow's summary to a specific user
 */
export async function sendTomorrowSummaryToUser(userId: number): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  await sendSummaryToUser(
    userId,
    fetchTomorrowEvents,
    tomorrow,
    USER_MESSAGES.FETCHING_TOMORROW,
    USER_MESSAGES.ERROR_TOMORROW
  );
}

/**
 * Send tomorrow's summary to all users
 * Generates personalized summary for each user based on their primary calendar
 */
export async function sendTomorrowSummaryToAll(): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  await sendSummaryToAll(fetchTomorrowEvents, tomorrow);
}

/**
 * Generate and send voice version of summary
 * Non-blocking - errors logged but don't affect text summary delivery
 * Admin-only feature for testing
 * @param modelId - Optional model ID to use for condensing (same as text summary)
 * @param language - Optional language for voice (defaults to English if not provided)
 */
async function sendVoiceMessage(userId: number, summary: string, modelId?: string, language?: string): Promise<void> {
  let voiceFilePath: string | null = null;

  try {
    const { generateVoiceMessage, cleanupVoiceFile } = await import('./voice-generator');
    const { buildVoiceCondenserPrompt } = await import('../prompts/voice-condenser');
    const { generateAICompletion } = await import('./ai-provider');

    console.log(`Generating voice message for user ${userId}...`);

    // Step 1: Condense summary for voice (ultra-brief, 30-45 seconds)
    const targetLanguage = language || 'English';
    const condenserPrompt = buildVoiceCondenserPrompt(summary, targetLanguage);
    const condensedResult = await generateAICompletion(condenserPrompt, modelId);
    const condensedSummary = condensedResult.text;

    console.log(`Voice summary condensed: ${summary.length} → ${condensedSummary.length} chars`);

    // Step 2: Generate voice file from condensed summary
    voiceFilePath = await generateVoiceMessage(condensedSummary, targetLanguage);

    // Send as voice message to Telegram
    const messagingService = getMessagingService();
    const botInstance = getBot(); // Still needed for voice and callbacks
    await botInstance.sendVoice(userId, voiceFilePath, {}, {
      contentType: 'audio/ogg'
    });

    console.log(`Voice message sent successfully to user ${userId}`);
  } catch (error) {
    console.error(`Voice generation failed for user ${userId}:`, error);

    // Notify admin but don't interrupt user experience
    const { notifyAdminWarning } = await import('../utils/error-notifier');
    await notifyAdminWarning(
      'Voice Generation',
      `Failed to generate voice message:\n${error instanceof Error ? error.message : 'Unknown error'}\n\nText summary was delivered successfully.`
    );
  } finally {
    // Always attempt cleanup
    if (voiceFilePath) {
      const { cleanupVoiceFile } = await import('./voice-generator');
      await cleanupVoiceFile(voiceFilePath).catch(err =>
        console.warn('Voice file cleanup failed:', err)
      );
    }
  }
}

/**
 * Handle /testai command - show model selection buttons
 * Supports: /testai (today) or /testai tmrw (tomorrow)
 */
export async function handleTestAICommand(chatId: number, userId: number, args?: string): Promise<void> {
  // Admin-only command
  if (userId !== ADMIN_USER_ID) {
    await getMessagingService().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  const { getAvailableModels, getModelConfig } = await import('../config/ai-models');
  const messagingService = getMessagingService();
  const botInstance = getBot(); // Still needed for voice and callbacks

  // Determine timeframe based on args
  const timeframe = args?.toLowerCase().includes('tmrw') || args?.toLowerCase().includes('tomorrow') ? 'tmrw' : 'today';
  const timeLabel = timeframe === 'tmrw' ? 'tomorrow' : 'today';

  try {
    const models = getAvailableModels();

    // Create inline keyboard buttons (2 per row)
    const keyboard: any[][] = [];
    for (let i = 0; i < models.length; i += 2) {
      const row = [];

      // First button in row
      const modelId1 = models[i];
      const config1 = getModelConfig(modelId1);
      if (config1) {
        row.push({
          text: config1.displayName,
          callback_data: `testai:${modelId1}:${timeframe}`
        });
      }

      // Second button in row (if exists)
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

    const { notifyAdminError } = await import('../utils/error-notifier');
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
  // Admin-only
  if (userId !== ADMIN_USER_ID) {
    await getBot().answerCallbackQuery(queryId, { text: 'Unauthorized' });
    return;
  }

  const messagingService = getMessagingService();
  const botInstance = getBot(); // Still needed for voice and callbacks
  const { getModelConfig } = await import('../config/ai-models');

  try {
    const config = getModelConfig(modelId);
    if (!config) {
      await botInstance.answerCallbackQuery(queryId, { text: 'Invalid model' });
      return;
    }

    // Determine fetch function and date based on timeframe
    const isTomorrow = timeframe === 'tmrw';
    const fetchFunction = isTomorrow ? fetchTomorrowEvents : fetchTodayEvents;
    const summaryDate = isTomorrow ? (() => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow;
    })() : undefined;
    const timeLabel = isTomorrow ? 'tomorrow' : 'today';

    // Answer the callback to remove loading state
    await botInstance.answerCallbackQuery(queryId, {
      text: `Generating ${timeLabel}'s summary with ${config.displayName}...`
    });

    // Send summary with the selected model
    await sendSummaryToUser(
      userId,
      fetchFunction,
      summaryDate,
      `🤖 Generating <b>${timeLabel}'s</b> summary with <b>${config.displayName}</b>...`,
      'Sorry, there was an error generating the summary.',
      modelId
    );
  } catch (error) {
    console.error('Error in testai callback:', error);
    await messagingService.sendMessage(chatId, 'Sorry, there was an error generating the summary.');

    const { notifyAdminError } = await import('../utils/error-notifier');
    await notifyAdminError('TestAI Callback', error);
  }
}

/**
 * Handle /weather command
 * Supports: /weather, /weather std, /weather dtl
 */
export async function handleWeatherCommand(
  chatId: number | string,
  userId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  args?: string
): Promise<void> {
  if (!(await isUserAuthorized(userId))) {
    const service = platform === MessagingPlatform.TELEGRAM
      ? getMessagingService()
      : getMessagingServiceByPlatform(platform);
    await service.sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
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

  // If no args provided
  if (!args) {
    // WhatsApp doesn't support inline keyboards
    if (platform === MessagingPlatform.WHATSAPP) {
      await messagingService.sendMessage(
        chatId,
        '🌤️ Please specify format:\n• "weather std" for standard\n• "weather dtl" for detailed'
      );
      return;
    }

    // Telegram: show inline keyboard
    const botInstance = getBot();
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📊 Standard', callback_data: 'weather:std' },
          { text: '📈 Detailed', callback_data: 'weather:dtl' }
        ]
      ]
    };

    await messagingService.sendMessage(
      chatId,
      '🌤️ Choose weather report format:',
      { replyMarkup: keyboard }
    );
    return;
  }

  // Handle format selection (called from callback or legacy command with args)
  try {
    const format = args.toLowerCase() === 'dtl' ? 'dtl' : 'std';

    await messagingService.sendMessage(chatId, '🌤️ Fetching weather data...');

    // Fetch weather data
    const { fetchWeather } = await import('./weather/open-meteo');
    const weatherData = await fetchWeather(user.location);

    // Format weather based on requested format (translate only if user has language set)
    const { formatWeatherStandard, formatWeatherDetailed } = await import('./weather/formatter');
    const formattedWeather = format === 'dtl'
      ? await formatWeatherDetailed(weatherData, user.language)
      : await formatWeatherStandard(weatherData, user.language);

    // Send formatted weather
    await messagingService.sendMessage(chatId, formattedWeather, { format: MessageFormat.MARKDOWN });
  } catch (error) {
    console.error(`Error fetching weather for user ${userId}:`, error);
    await messagingService.sendMessage(
      chatId,
      '❌ Sorry, there was an error fetching weather data. Please try again later.'
    );

    // Notify admin of weather failures
    const { notifyAdminError } = await import('../utils/error-notifier');
    await notifyAdminError(
      'Weather Command',
      error,
      `User: ${userId}, Location: ${user.location}`
    );
  }
}

/**
 * Handle weather format selection callback
 */
export async function handleWeatherCallback(chatId: number, userId: number, format: string, queryId: string): Promise<void> {
  const botInstance = getBot();

  // Answer the callback query to remove the loading state
  await botInstance.answerCallbackQuery(queryId);

  // Call handleWeatherCommand with the selected format
  await handleWeatherCommand(chatId, userId, MessagingPlatform.TELEGRAM, format);
}
