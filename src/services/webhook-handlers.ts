/**
 * Platform-specific webhook handlers
 * Handles incoming messages from Telegram and WhatsApp
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  handleStartCommand,
  handleHelpCommand,
  handleSummaryCommand,
  handleTestAICommand,
  handleTestAICallback,
  handleWeatherCommand,
  handleWeatherCallback,
  getBot
} from './telegram';
import { getUserByWhatsAppPhone } from '../config/users';
import { MessagingPlatform } from './messaging';

/**
 * Handle Telegram webhook updates
 */
export async function handleTelegramWebhook(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const update = req.body;

  // Handle callback queries (inline keyboard button clicks)
  if (update.callback_query) {
    const callbackQuery = update.callback_query;
    const chatId = callbackQuery.message?.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const queryId = callbackQuery.id;

    if (chatId && data) {
      if (data.startsWith('testai:')) {
        const modelId = data.replace('testai:', '');
        await handleTestAICallback(chatId, userId, modelId, queryId);
      } else if (data.startsWith('weather:')) {
        const format = data.replace('weather:', '');
        await handleWeatherCallback(chatId, userId, format, queryId);
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  if (!update.message || !update.message.text) {
    // Not a text message, ignore
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = update.message.chat.id;
  const userId = update.message.from.id;
  const text = update.message.text;

  // For /testmodels, process THEN respond (Redis lock prevents duplicates from retries)
  if (text.startsWith('/testmodels')) {
    const args = text.replace('/testmodels', '').trim();
    const updateId = update.update_id;

    const { handleTestModelsCommand } = await import('./telegram');
    await handleTestModelsCommand(chatId, userId, updateId, args || undefined);

    res.status(200).json({ ok: true });
    return;
  }

  // Route to appropriate command handler
  if (text === '/start') {
    await handleStartCommand(chatId, userId, MessagingPlatform.TELEGRAM);
  } else if (text === '/help') {
    await handleHelpCommand(chatId, userId, MessagingPlatform.TELEGRAM);
  } else if (text.startsWith('/summary')) {
    const args = text.replace('/summary', '').trim();
    await handleSummaryCommand(chatId, userId, MessagingPlatform.TELEGRAM, args || undefined);
  } else if (text === '/testai') {
    await handleTestAICommand(chatId, userId);
  } else if (text.startsWith('/weather')) {
    const args = text.replace('/weather', '').trim();
    await handleWeatherCommand(chatId, userId, MessagingPlatform.TELEGRAM, args || undefined);
  }

  res.status(200).json({ ok: true });
}

/**
 * Handle WhatsApp webhook updates
 */
export async function handleWhatsAppWebhook(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const body = req.body;

  // Parse WhatsApp webhook structure
  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messages = value?.messages;

  if (!messages || messages.length === 0) {
    // No messages to process
    res.status(200).json({ ok: true });
    return;
  }

  const message = messages[0];
  const rawPhone = message.from; // Phone number from WhatsApp (without + prefix)
  const text = message.text?.body;

  if (!rawPhone || !text) {
    res.status(200).json({ ok: true });
    return;
  }

  // Normalize phone number to E.164 format (add + prefix if missing)
  const from = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;

  // Get user by WhatsApp phone number
  const user = getUserByWhatsAppPhone(from);
  if (!user) {
    console.log(`[WhatsApp] Unauthorized user: ${from}`);
    res.status(200).json({ ok: true });
    return;
  }

  // Parse command (WhatsApp uses keywords, not slash commands)
  const lowerText = text.toLowerCase().trim();

  // Handle commands
  if (lowerText === 'start') {
    await handleStartCommand(from, user.telegramId, MessagingPlatform.WHATSAPP);
    await notifyTelegramAboutWhatsApp(user.telegramId, 'start');
  } else if (lowerText === 'help') {
    await handleHelpCommand(from, user.telegramId, MessagingPlatform.WHATSAPP);
    await notifyTelegramAboutWhatsApp(user.telegramId, 'help');
  } else if (lowerText.startsWith('summary')) {
    const args = lowerText.replace('summary', '').trim();
    await handleSummaryCommand(from, user.telegramId, MessagingPlatform.WHATSAPP, args || undefined);
    await notifyTelegramAboutWhatsApp(user.telegramId, 'summary');
  } else if (lowerText.startsWith('weather')) {
    const args = lowerText.replace('weather', '').trim();
    await handleWeatherCommand(from, user.telegramId, MessagingPlatform.WHATSAPP, args || undefined);
    await notifyTelegramAboutWhatsApp(user.telegramId, 'weather');
  }

  res.status(200).json({ ok: true });
}

/**
 * Send notification to Telegram when command comes from WhatsApp
 */
async function notifyTelegramAboutWhatsApp(telegramId: number, command: string): Promise<void> {
  try {
    const bot = getBot();
    await bot.sendMessage(
      telegramId,
      `📱 <b>WhatsApp Command:</b> /${command}\n<i>Response sent to WhatsApp</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('[WhatsApp] Failed to notify Telegram:', error);
  }
}
