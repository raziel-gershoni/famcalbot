/**
 * Platform-specific webhook handlers
 * Handles incoming messages from Telegram and WhatsApp
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  handleStartCommand,
  handleSummaryCommand,
  handleTestAICommand,
  handleTestAICallback,
  handleWeatherCommand,
  handleFeedbackCommand,
  getBot
} from './telegram';
import { getUserByWhatsAppPhone } from './user-service';
import { MessagingPlatform } from './messaging';
import { handleVoiceMessage, handleEventCallback, handleEditCallback, handleDeleteCallback } from './voice';
import { handlePreCheckoutQuery, handleSuccessfulPayment } from './payment-handler';
import { setUserContext, addBreadcrumb } from './analytics-service';

/**
 * Handle Telegram webhook updates
 */
export async function handleTelegramWebhook(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const update = req.body;

  // Extract user ID from various update types and set Sentry context
  const userId = update.message?.from?.id
    || update.callback_query?.from?.id
    || update.pre_checkout_query?.from?.id;
  const userName = update.message?.from?.first_name
    || update.callback_query?.from?.first_name
    || update.pre_checkout_query?.from?.first_name;

  if (userId) {
    setUserContext(userId, userName);
  }

  // Add breadcrumb for webhook type
  const webhookType = update.pre_checkout_query ? 'pre_checkout'
    : update.message?.successful_payment ? 'successful_payment'
    : update.callback_query ? 'callback_query'
    : update.message?.voice ? 'voice_message'
    : update.message?.text ? 'text_message'
    : 'unknown';

  addBreadcrumb('webhook_received', {
    type: webhookType,
    update_id: update.update_id,
    user_id: userId,
  }, 'webhook');

  // Handle pre-checkout query (Telegram Stars payment validation)
  if (update.pre_checkout_query) {
    await handlePreCheckoutQuery(update.pre_checkout_query);
    res.status(200).json({ ok: true });
    return;
  }

  // Handle successful payment (Telegram Stars)
  if (update.message?.successful_payment) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    await handleSuccessfulPayment(chatId, userId, update.message.successful_payment);
    res.status(200).json({ ok: true });
    return;
  }

  // Handle callback queries (inline keyboard button clicks)
  if (update.callback_query) {
    const callbackQuery = update.callback_query;
    const chatId = callbackQuery.message?.chat.id;
    const callbackUserId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const queryId = callbackQuery.id;

    // Add breadcrumb for callback action
    addBreadcrumb('callback_received', {
      callback_data: data,
      user_id: callbackUserId,
    }, 'user_action');

    if (chatId && data) {
      if (data.startsWith('testai:')) {
        const parts = data.replace('testai:', '').split(':');
        const modelId = parts[0];
        const timeframe = parts[1] || 'today'; // Default to 'today' if not specified
        await handleTestAICallback(chatId, callbackUserId, modelId, queryId, timeframe);
      } else if (data.startsWith('event_create:') || data.startsWith('event_cancel:')) {
        // Handle event creation callbacks
        const [action, pendingId] = data.split(':').slice(0, 2);
        const actionType = action.replace('event_', '');
        const fullPendingId = data.substring(action.length + 1); // Get everything after "event_create:" or "event_cancel:"
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          await handleEventCallback(chatId, messageId, queryId, actionType, fullPendingId);
        }
      } else if (data.startsWith('edit_confirm:') || data.startsWith('edit_cancel:')) {
        // Handle event edit callbacks
        const [action] = data.split(':').slice(0, 1);
        const actionType = action.replace('edit_', '');
        const fullPendingId = data.substring(action.length + 1);
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          await handleEditCallback(chatId, messageId, queryId, actionType, fullPendingId);
        }
      } else if (data.startsWith('delete_confirm:') || data.startsWith('delete_cancel:')) {
        // Handle event delete callbacks
        const [action] = data.split(':').slice(0, 1);
        const actionType = action.replace('delete_', '');
        const fullPendingId = data.substring(action.length + 1);
        const messageId = callbackQuery.message?.message_id;
        if (messageId) {
          await handleDeleteCallback(chatId, messageId, queryId, actionType, fullPendingId);
        }
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  // Handle voice messages for event creation
  if (update.message?.voice) {
    const chatId = update.message.chat.id;
    const voiceUserId = update.message.from.id;
    const voice = update.message.voice;
    const from = update.message.from;
    const fileUniqueId = voice.file_unique_id;

    // Add breadcrumb for voice message
    addBreadcrumb('voice_message_received', {
      user_id: voiceUserId,
      duration: voice.duration,
      file_size: voice.file_size,
    }, 'user_action');

    console.log(`[Webhook] Voice message received from user ${voiceUserId}, file_unique_id: ${fileUniqueId}, duration: ${voice.duration}s`);

    // Use Redis lock to prevent duplicate processing on webhook retries
    const { acquireVoiceLock, releaseVoiceLock } = await import('../utils/redis-lock');
    const lockAcquired = await acquireVoiceLock(fileUniqueId);

    if (!lockAcquired) {
      console.log(`[Webhook] Voice message ${fileUniqueId} already being processed - skipping duplicate`);
      res.status(200).json({ ok: true });
      return;
    }

    // Process voice message (await to prevent Vercel from killing the function)
    try {
      await handleVoiceMessage(chatId, voiceUserId, voice, from);
    } catch (error) {
      console.error('[Webhook] Error in voice handler:', error);
    } finally {
      await releaseVoiceLock(fileUniqueId);
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
  const textUserId = update.message.from.id;
  const text = update.message.text;

  // Add breadcrumb for text command
  addBreadcrumb('text_message_received', {
    user_id: textUserId,
    command: text.startsWith('/') ? text.split(' ')[0] : undefined,
    is_command: text.startsWith('/'),
  }, 'user_action');

  // For /testmodels, process THEN respond (Redis lock prevents duplicates from retries)
  if (text.startsWith('/testmodels')) {
    const args = text.replace('/testmodels', '').trim();
    const updateId = update.update_id;

    const { handleTestModelsCommand } = await import('./telegram');
    await handleTestModelsCommand(chatId, textUserId, updateId, args || undefined);

    res.status(200).json({ ok: true });
    return;
  }

  // Route to appropriate command handler
  if (text.startsWith('/start')) {
    // Pass Telegram user info for auto-registration
    // Extract args for deep links (e.g., /start feedback from t.me/BotName?start=feedback)
    const args = text.replace('/start', '').trim();
    await handleStartCommand(chatId, textUserId, MessagingPlatform.TELEGRAM, update.message.from, args || undefined);
  } else if (text.startsWith('/summary')) {
    const args = text.replace('/summary', '').trim();
    await handleSummaryCommand(chatId, textUserId, MessagingPlatform.TELEGRAM, args || undefined);
  } else if (text.startsWith('/testai')) {
    const args = text.replace('/testai', '').trim();
    await handleTestAICommand(chatId, textUserId, args || undefined);
  } else if (text.startsWith('/weather')) {
    const args = text.replace('/weather', '').trim();
    await handleWeatherCommand(chatId, textUserId, MessagingPlatform.TELEGRAM, args || undefined);
  } else if (text.startsWith('/feedback')) {
    const args = text.replace('/feedback', '').trim();
    await handleFeedbackCommand(chatId, textUserId, args || undefined);
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
  const user = await getUserByWhatsAppPhone(from);
  if (!user) {
    console.log(`[WhatsApp] Unauthorized user: ${from}`);
    res.status(200).json({ ok: true });
    return;
  }

  // Parse command (WhatsApp uses keywords, not slash commands)
  const lowerText = text.toLowerCase().trim();

  console.log(`[WhatsApp] Processing command from ${from}: "${text}"`);

  try {
    // Handle commands
    if (lowerText === 'start') {
      console.log(`[WhatsApp] Handling start command`);
      await handleStartCommand(from, user.telegramId, MessagingPlatform.WHATSAPP);
      await notifyTelegramAboutWhatsApp(user.telegramId, 'start');
    } else if (lowerText.startsWith('summary')) {
      console.log(`[WhatsApp] Handling summary command`);
      const args = lowerText.replace('summary', '').trim();
      await handleSummaryCommand(from, user.telegramId, MessagingPlatform.WHATSAPP, args || undefined);
      await notifyTelegramAboutWhatsApp(user.telegramId, 'summary');
    } else if (lowerText.startsWith('weather')) {
      console.log(`[WhatsApp] Handling weather command`);
      const args = lowerText.replace('weather', '').trim();
      await handleWeatherCommand(from, user.telegramId, MessagingPlatform.WHATSAPP, args || undefined);
      await notifyTelegramAboutWhatsApp(user.telegramId, 'weather');
    } else {
      console.log(`[WhatsApp] Unknown command: ${text}`);
    }
  } catch (error) {
    console.error('[WhatsApp] Error handling command:', error);
    // Still return 200 to WhatsApp to avoid retries
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
