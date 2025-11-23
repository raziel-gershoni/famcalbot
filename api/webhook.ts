import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleStartCommand, handleHelpCommand, handleSummaryCommand, handleTomorrowCommand } from '../src/services/telegram';

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

    // Telegram sends updates in this format:
    // { update_id: number, message: { chat: { id: number }, from: { id: number }, text: string } }

    if (!update.message || !update.message.text) {
      // Not a text message, ignore
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const text = update.message.text;

    // For /testmodels, respond immediately to prevent Telegram retries on long execution
    if (text.startsWith('/testmodels')) {
      res.status(200).json({ ok: true });
      const args = text.replace('/testmodels', '').trim();
      const { handleTestModelsCommand } = await import('../src/services/telegram');
      await handleTestModelsCommand(chatId, userId, args || undefined);
      return;
    }

    // Route to appropriate command handler (process BEFORE responding)
    if (text === '/start') {
      await handleStartCommand(chatId, userId);
    } else if (text === '/help') {
      await handleHelpCommand(chatId, userId);
    } else if (text === '/summary') {
      await handleSummaryCommand(chatId, userId);
    } else if (text === '/tomorrow') {
      await handleTomorrowCommand(chatId, userId);
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
