import TelegramBot from 'node-telegram-bot-api';
import { getUserByTelegramId, getWhitelistedIds } from '../config/users';
import { fetchTodayEvents } from './calendar';
import { generateSummary } from './claude';

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
    `Hello ${name}! I'm your family calendar bot. I'll send you daily summaries at 7 AM.\n\nCommands:\n/summary - Get today's calendar summary\n/help - Show this help message`
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
    `Available commands:\n/start - Welcome message\n/summary - Get today's calendar summary\n/help - Show this help`
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

    // Generate summary with Claude
    const summary = await generateSummary(events, user.name);

    // Send personalized message
    const message = `${user.greeting}\n\n${summary}`;
    await botInstance.sendMessage(userId, message);
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
 * Generates summary once and sends to all users with personalized greetings
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

    // Generate summary once (not user-specific, just the schedule)
    const summary = await generateSummary(events, 'Family');

    // Send to each user with their personalized greeting
    for (const userId of whitelistedIds) {
      try {
        const user = getUserByTelegramId(userId);
        if (!user) continue;

        const message = `${user.greeting}\n\n${summary}`;
        await botInstance.sendMessage(userId, message);
      } catch (error) {
        console.error(`Failed to send summary to user ${userId}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to generate summary for all users:', error);
  }
}
