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

    // Route to appropriate command handler
    if (text === '/start') {
      await handleStartCommand(chatId, userId);
    } else if (text === '/help') {
      await handleHelpCommand(chatId, userId);
    } else if (text === '/summary') {
      await handleSummaryCommand(chatId, userId);
    } else if (text === '/tomorrow') {
      await handleTomorrowCommand(chatId, userId);
    }
    // Ignore other messages

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error in webhook handler:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
