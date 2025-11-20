import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getWhitelistedIds } from '../config/users';
import { fetchTodayEvents, fetchTomorrowEvents } from './calendar';
import { generateSummary } from './claude';
import { CalendarEvent, UserConfig } from '../types';

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
    await getBot().sendMessage(chatId, 'Sorry, you are not authorized to use this bot.');
    return;
  }

  const user = getUserByTelegramId(userId);
  const name = user?.name || 'there';

  await getBot().sendMessage(
    chatId,
    `Hello ${name}! 👋\n\nI'm your family calendar bot. I'll send you personalized daily summaries automatically:\n• Morning at 7 AM (today's schedule)\n• Evening (tomorrow's schedule)\n\nYou can also request summaries anytime with /summary or /tomorrow.\n\nNeed help? Use /help to see all commands.`
  );
}

/**
 * Handle /help command
 */
export async function handleHelpCommand(chatId: number, userId: number): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, 'Sorry, you are not authorized to use this bot.');
    return;
  }

  await getBot().sendMessage(
    chatId,
    `📋 Available Commands:\n\n/summary - Get today's calendar summary\n/tomorrow - Get tomorrow's calendar summary\n/help - Show this help message\n/start - About this bot\n\nYou'll also receive automatic summaries:\n• Morning at 7 AM (today)\n• Evening (tomorrow)`
  );
}

/**
 * Handle /summary command
 */
export async function handleSummaryCommand(chatId: number, userId: number): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, 'Sorry, you are not authorized to use this bot.');
    return;
  }

  await sendDailySummaryToUser(userId);
}

/**
 * Handle /tomorrow command
 */
export async function handleTomorrowCommand(chatId: number, userId: number): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, 'Sorry, you are not authorized to use this bot.');
    return;
  }

  await sendTomorrowSummaryToUser(userId);
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
}

/**
 * Send daily summary to a specific user
 */
export async function sendDailySummaryToUser(userId: number): Promise<void> {
  const user = getUserByTelegramId(userId);
  if (!user) {
    console.error(`User with Telegram ID ${userId} not found`);
    return;
  }

  const botInstance = getBot();

  try {
    await botInstance.sendMessage(userId, 'Fetching your calendar...');

    // Fetch calendar events
    const events = await fetchTodayEvents(user.googleRefreshToken, user.calendars);

    // Categorize events by ownership
    const categorized = categorizeEvents(events, user);

    // Generate summary with Claude (personalized for this user)
    const summary = await generateSummary(categorized.userEvents, categorized.spouseEvents, categorized.otherEvents, user.name, user.spouseName, user.primaryCalendar);

    // Send personalized message (greeting is included in the summary)
    await botInstance.sendMessage(userId, summary, { parse_mode: 'HTML' });
  } catch (error) {
    console.error(`Error sending summary to user ${userId}:`, error);
    await botInstance.sendMessage(
      userId,
      'Sorry, there was an error fetching your calendar. Please try again later.'
    );
  }
}

/**
 * Send daily summary to all users
 * Generates personalized summary for each user based on their primary calendar
 */
export async function sendDailySummaryToAll(): Promise<void> {
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
    const events = await fetchTodayEvents(firstUser.googleRefreshToken, firstUser.calendars);

    // Send to each user with personalized summary
    for (const userId of whitelistedIds) {
      try {
        const user = getUserByTelegramId(userId);
        if (!user) continue;

        // Categorize events by ownership for this user
        const categorized = categorizeEvents(events, user);

        // Generate personalized summary for this specific user (greeting is included in the summary)
        const summary = await generateSummary(categorized.userEvents, categorized.spouseEvents, categorized.otherEvents, user.name, user.spouseName, user.primaryCalendar);
        await botInstance.sendMessage(userId, summary, { parse_mode: 'HTML' });
      } catch (error) {
        console.error(`Failed to send summary to user ${userId}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to generate summary for all users:', error);
  }
}

/**
 * Send tomorrow's summary to a specific user
 */
export async function sendTomorrowSummaryToUser(userId: number): Promise<void> {
  const user = getUserByTelegramId(userId);
  if (!user) {
    console.error(`User with Telegram ID ${userId} not found`);
    return;
  }

  const botInstance = getBot();

  try {
    await botInstance.sendMessage(userId, 'Fetching tomorrow\'s calendar...');

    // Fetch calendar events for tomorrow
    const events = await fetchTomorrowEvents(user.googleRefreshToken, user.calendars);

    // Categorize events by ownership
    const categorized = categorizeEvents(events, user);

    // Calculate tomorrow's date
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Generate summary with Claude (personalized for this user, with tomorrow's date)
    const summary = await generateSummary(categorized.userEvents, categorized.spouseEvents, categorized.otherEvents, user.name, user.spouseName, user.primaryCalendar, tomorrow);

    // Send personalized message (greeting is included in the summary)
    await botInstance.sendMessage(userId, summary, { parse_mode: 'HTML' });
  } catch (error) {
    console.error(`Error sending tomorrow's summary to user ${userId}:`, error);
    await botInstance.sendMessage(
      userId,
      'Sorry, there was an error fetching tomorrow\'s calendar. Please try again later.'
    );
  }
}

/**
 * Send tomorrow's summary to all users
 * Generates personalized summary for each user based on their primary calendar
 */
export async function sendTomorrowSummaryToAll(): Promise<void> {
  const whitelistedIds = getWhitelistedIds();
  const botInstance = getBot();

  try {
    // Get the first user to fetch calendars (they all share the same calendars)
    const firstUser = getUserByTelegramId(whitelistedIds[0]);
    if (!firstUser) {
      console.error('No users configured');
      return;
    }

    // Fetch calendar events for tomorrow once (shared by all users)
    const events = await fetchTomorrowEvents(firstUser.googleRefreshToken, firstUser.calendars);

    // Calculate tomorrow's date
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Send to each user with personalized summary
    for (const userId of whitelistedIds) {
      try {
        const user = getUserByTelegramId(userId);
        if (!user) continue;

        // Categorize events by ownership for this user
        const categorized = categorizeEvents(events, user);

        // Generate personalized summary for this specific user (with tomorrow's date, greeting included in summary)
        const summary = await generateSummary(categorized.userEvents, categorized.spouseEvents, categorized.otherEvents, user.name, user.spouseName, user.primaryCalendar, tomorrow);
        await botInstance.sendMessage(userId, summary, { parse_mode: 'HTML' });
      } catch (error) {
        console.error(`Failed to send tomorrow's summary to user ${userId}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to generate tomorrow\'s summary for all users:', error);
  }
}
