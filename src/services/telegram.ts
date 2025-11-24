import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getWhitelistedIds } from '../config/users';
import { fetchTodayEvents, fetchTomorrowEvents } from './calendar';
import { generateSummary } from './claude';
import { CalendarEvent, UserConfig } from '../types';
import { USER_MESSAGES } from '../config/messages';
import { ADMIN_USER_ID } from '../config/constants';

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
 * Check if user is authorized
 */
export function isUserAuthorized(userId: number): boolean {
  return getWhitelistedIds().includes(userId);
}

/**
 * Handle /start command
 */
export async function handleStartCommand(chatId: number, userId: number): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  const user = getUserByTelegramId(userId);
  const name = user?.name || 'there';

  await getBot().sendMessage(chatId, USER_MESSAGES.WELCOME(name));
}

/**
 * Handle /help command
 */
export async function handleHelpCommand(chatId: number, userId: number): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  await getBot().sendMessage(chatId, USER_MESSAGES.HELP);
}

/**
 * Handle /summary command
 */
export async function handleSummaryCommand(chatId: number, userId: number): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  await sendDailySummaryToUser(userId);
}

/**
 * Handle /tomorrow command
 */
export async function handleTomorrowCommand(chatId: number, userId: number): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  await sendTomorrowSummaryToUser(userId);
}

/**
 * Handle /testmodels command (admin only)
 */
export async function handleTestModelsCommand(chatId: number, userId: number, updateId: number, args?: string): Promise<void> {
  // Check if disabled via env var (emergency kill switch)
  if (process.env.DISABLE_TESTMODELS === 'true') {
    await getBot().sendMessage(
      chatId,
      '⚠️ <b>testmodels is currently disabled</b>\n\nContact admin to re-enable.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Admin-only command
  if (userId !== ADMIN_USER_ID) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
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
  const user = getUserByTelegramId(userId);
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
      user.spouseName,
      user.spouseHebrewName,
      user.primaryCalendar,
      chatId,
      uniqueMarker
    );
    console.log('testModels execution completed successfully');
  } catch (error) {
    console.error('Error in testmodels command:', error);
    await getBot().sendMessage(chatId, 'Sorry, there was an error running the model tests.');

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

  // /summary command
  bot.onText(/\/summary/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (userId) {
      await handleSummaryCommand(chatId, userId);
    }
  });

  // /tomorrow command
  bot.onText(/\/tomorrow/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (userId) {
      await handleTomorrowCommand(chatId, userId);
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

  // /testvoices command (admin only)
  bot.onText(/\/testvoices/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (userId) {
      await handleTestVoicesCommand(chatId, userId);
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
 */
async function sendSummaryToUser(
  userId: number,
  fetchFunction: (refreshToken: string, calendarIds: string[]) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined,
  fetchingMessage: string,
  errorMessage: string
): Promise<void> {
  const user = getUserByTelegramId(userId);
  if (!user) {
    console.error(`User with Telegram ID ${userId} not found`);
    return;
  }

  const botInstance = getBot();

  try {
    await botInstance.sendMessage(userId, fetchingMessage);

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
      user.spouseName,
      user.spouseHebrewName,
      user.primaryCalendar,
      summaryDate,
      userId === ADMIN_USER_ID
    );

    // Send personalized message (greeting is included in the summary)
    await botInstance.sendMessage(userId, summary, { parse_mode: 'HTML' });

    // Generate and send voice message for admin user only (for /summary command only)
    if (userId === ADMIN_USER_ID && summaryDate === undefined) {
      await sendVoiceMessage(userId, summary);
    }
  } catch (error) {
    console.error(`Error sending summary to user ${userId}:`, error);
    await botInstance.sendMessage(userId, errorMessage);

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
  const whitelistedIds = getWhitelistedIds();
  const botInstance = getBot();

  try {
    // Get the first user to fetch calendars (they all share the same calendars)
    const firstUser = getUserByTelegramId(whitelistedIds[0]);
    if (!firstUser) {
      console.error('No users configured');
      return;
    }

    // Fetch calendar events once (shared by all users)
    const events = await fetchFunction(firstUser.googleRefreshToken, firstUser.calendars);

    // Send to each user with personalized summary
    for (const userId of whitelistedIds) {
      try {
        const user = getUserByTelegramId(userId);
        if (!user) continue;

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
          user.spouseName,
          user.spouseHebrewName,
          user.primaryCalendar,
          summaryDate,
          userId === ADMIN_USER_ID
        );
        await botInstance.sendMessage(userId, summary, { parse_mode: 'HTML' });
      } catch (error) {
        console.error(`Failed to send summary to user ${userId}:`, error);
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
 */
async function sendVoiceMessage(userId: number, summary: string): Promise<void> {
  let voiceFilePath: string | null = null;

  try {
    const { generateVoiceMessage, cleanupVoiceFile } = await import('./voice-generator');

    console.log(`Generating voice message for user ${userId}...`);

    // Generate voice file with default settings (nova voice, 1.0 speed)
    voiceFilePath = await generateVoiceMessage(summary);

    // Send as voice message to Telegram
    const botInstance = getBot();
    await botInstance.sendVoice(userId, voiceFilePath);

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
 * Handle /testvoices command (admin only)
 * Tests all 6 OpenAI voices with a sample Hebrew text
 */
export async function handleTestVoicesCommand(chatId: number, userId: number): Promise<void> {
  // Admin-only command
  if (userId !== ADMIN_USER_ID) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  const botInstance = getBot();
  const voices: Array<'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'> = [
    'alloy',
    'echo',
    'fable',
    'onyx',
    'nova',
    'shimmer'
  ];

  const testText = `שלום! זהו טסט של קול עברי. אני אומר את המספרים: אחת, שתיים, שלוש. ואת הזמן: שמונה אפס אפס. תודה!`;

  try {
    await botInstance.sendMessage(
      chatId,
      `🎤 <b>Testing ${voices.length} OpenAI Voices</b>\n\nGenerating voice samples for each voice...\n\n<i>Test text: "${testText}"</i>`,
      { parse_mode: 'HTML' }
    );

    const { generateVoiceMessage, cleanupVoiceFile } = await import('./voice-generator');

    // Test each voice
    for (const voice of voices) {
      let voiceFilePath: string | null = null;

      try {
        console.log(`Testing voice: ${voice}`);

        // Generate voice sample
        voiceFilePath = await generateVoiceMessage(testText, { voice, speed: 1.0 });

        // Send voice message with caption
        await botInstance.sendVoice(chatId, voiceFilePath, {
          caption: `🎤 Voice: <b>${voice}</b>`,
          parse_mode: 'HTML'
        });

        console.log(`Voice ${voice} sent successfully`);
      } catch (error) {
        console.error(`Failed to test voice ${voice}:`, error);
        await botInstance.sendMessage(
          chatId,
          `❌ Voice <b>${voice}</b> failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { parse_mode: 'HTML' }
        );
      } finally {
        if (voiceFilePath) {
          await cleanupVoiceFile(voiceFilePath).catch(err =>
            console.warn(`Cleanup failed for ${voice}:`, err)
          );
        }
      }

      // Small delay between voices to avoid rate limits
      if (voice !== voices[voices.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    await botInstance.sendMessage(
      chatId,
      `✅ <b>Voice Testing Complete!</b>\n\nTested ${voices.length} voices. Listen and compare to choose your favorite!`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Error in testvoices command:', error);
    await botInstance.sendMessage(chatId, 'Sorry, there was an error running voice tests.');

    const { notifyAdminError } = await import('../utils/error-notifier');
    await notifyAdminError('TestVoices Command', error);
  }
}
