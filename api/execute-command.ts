import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserByTelegramId } from '../src/services/user-service';
import {
  handleTestAICommand,
  handleSummaryCommand,
  handleWeatherCommand
} from '../src/services/telegram';
import { MessagingPlatform } from '../src/services/messaging';

/**
 * Execute Command API Endpoint
 * Allows webapps to trigger bot commands directly without deep links
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const { user_id, command, args, secret } = req.body;

  // Validate required parameters
  if (!user_id || !command || !secret) {
    res.status(400).json({
      success: false,
      error: 'Missing required parameters: user_id, command, secret'
    });
    return;
  }

  // Validate secret
  if (secret !== process.env.CRON_SECRET) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  // Get user from database
  const user = await getUserByTelegramId(user_id);
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  // Check admin access for testai command
  if (command === 'testai' && !user.isAdmin) {
    res.status(403).json({
      success: false,
      error: 'Admin access required for testai command'
    });
    return;
  }

  try {
    // Execute command (chatId = userId for Telegram)
    switch (command) {
      case 'testai':
        await handleTestAICommand(user_id, user_id, args);
        break;
      case 'summary':
        await handleSummaryCommand(
          user_id,
          user_id,
          MessagingPlatform.TELEGRAM,
          args
        );
        break;
      case 'weather':
        await handleWeatherCommand(
          user_id,
          user_id,
          MessagingPlatform.TELEGRAM,
          args
        );
        break;
      default:
        res.status(400).json({
          success: false,
          error: `Unknown command: ${command}`
        });
        return;
    }

    res.status(200).json({
      success: true,
      message: 'Command executed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Command execution error:', error);
    res.status(500).json({
      success: false,
      error: 'Command execution failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
