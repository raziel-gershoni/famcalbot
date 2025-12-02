import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleStartCommand, handleHelpCommand, handleSummaryCommand, handleTestVoicesCommand, handleTestAICommand, handleTestAICallback, handleWeatherCommand, handleWeatherCallback } from '../src/services/telegram';

/**
 * Telegram Webhook Handler
 * Receives updates from Telegram and routes to appropriate command handlers
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Load environment variables for serverless
    await import('dotenv/config');

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

    // Telegram sends message updates in this format:
    // { update_id: number, message: { chat: { id: number }, from: { id: number }, text: string } }

    if (!update.message || !update.message.text) {
      // Not a text message, ignore
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const text = update.message.text;

    // For /testmodels, process THEN respond (Redis lock prevents duplicates from retries)
    // Telegram will retry after ~60s if no response, but Redis lock will reject duplicates
    if (text.startsWith('/testmodels')) {
      const args = text.replace('/testmodels', '').trim();
      const updateId = update.update_id;

      const { handleTestModelsCommand } = await import('../src/services/telegram');
      await handleTestModelsCommand(chatId, userId, updateId, args || undefined);

      res.status(200).json({ ok: true });
      return;
    }

    // Route to appropriate command handler (process BEFORE responding)
    if (text === '/start') {
      await handleStartCommand(chatId, userId);
    } else if (text === '/help') {
      await handleHelpCommand(chatId, userId);
    } else if (text.startsWith('/summary')) {
      // Handle /summary, /summary tmrw
      const args = text.replace('/summary', '').trim();
      await handleSummaryCommand(chatId, userId, args || undefined);
    } else if (text === '/testvoices') {
      await handleTestVoicesCommand(chatId, userId);
    } else if (text === '/testai') {
      await handleTestAICommand(chatId, userId);
    } else if (text.startsWith('/weather')) {
      // Handle /weather, /weather std, /weather dtl
      const args = text.replace('/weather', '').trim();
      await handleWeatherCommand(chatId, userId, args || undefined);
    }

    // Respond after processing (prevents function shutdown issues)
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error in webhook handler:', error);
    // Notify admin of webhook errors
    try {
      const { notifyAdminError } = await import('../src/utils/error-notifier');
      await notifyAdminError('Webhook Handler', error, `Update: ${JSON.stringify(req.body)}`);
    } catch (notifyError) {
      console.error('Failed to notify admin:', notifyError);
    }
  }
}
