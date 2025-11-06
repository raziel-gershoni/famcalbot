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
 * Setup bot command handlers
 */
function setupHandlers(bot: TelegramBot) {
  const whitelistedIds = getWhitelistedIds();

  // Middleware to check if user is whitelisted
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !whitelistedIds.includes(userId)) {
      await bot.sendMessage(chatId, 'Sorry, you are not authorized to use this bot.');
      return;
    }
  });

  // /start command
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !whitelistedIds.includes(userId)) {
      return;
    }

    const user = getUserByTelegramId(userId);
    const name = user?.name || 'there';

    await bot.sendMessage(
      chatId,
      `Hello ${name}! I'm your family calendar bot. I'll send you daily summaries at 7 AM.\n\nCommands:\n/summary - Get today's calendar summary\n/help - Show this help message`
    );
  });

  // /help command
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !whitelistedIds.includes(userId)) {
      return;
    }

    await bot.sendMessage(
      chatId,
      `Available commands:\n/start - Welcome message\n/summary - Get today's calendar summary\n/help - Show this help`
    );
  });

  // /summary command
  bot.onText(/\/summary/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !whitelistedIds.includes(userId)) {
      return;
    }

    await sendDailySummaryToUser(userId);
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
