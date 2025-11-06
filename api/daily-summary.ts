import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendDailySummaryToAll } from '../src/services/telegram';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET requests
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Verify the secret token
  const providedSecret = req.query.secret || req.headers['x-cron-secret'];
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.error('CRON_SECRET is not configured');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  if (providedSecret !== expectedSecret) {
    console.error('Invalid secret token provided');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // Load environment variables for serverless
    await import('dotenv/config');

    // Send daily summaries to all users
    await sendDailySummaryToAll();

    res.status(200).json({
      success: true,
      message: 'Daily summaries sent successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in daily-summary endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send daily summaries',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
