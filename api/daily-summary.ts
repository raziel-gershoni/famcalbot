import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendDailySummaryToAll } from '../src/services/telegram';
import { prisma } from '../src/utils/prisma';

/**
 * Daily Summary Cron Endpoint
 * Sends today's calendar summary to all users
 * Triggered by cron job at 7 AM daily
 */
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

    // Execute the summary function
    await sendDailySummaryToAll();

    // Clean up expired OAuth state tokens
    try {
      const deleted = await prisma.oAuthState.deleteMany({
        where: {
          expiresAt: {
            lt: new Date()
          }
        }
      });
      console.log(`Cleaned up ${deleted.count} expired OAuth state tokens`);
    } catch (cleanupError) {
      console.error('Failed to clean up OAuth state tokens:', cleanupError);
      // Don't fail the cron job if cleanup fails
    }

    res.status(200).json({
      success: true,
      message: 'Daily summaries sent successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in cron handler:', error);

    // Notify admin of cron job failures
    try {
      const { notifyAdminError } = await import('../src/utils/error-notifier');
      await notifyAdminError('Cron Job', error, 'Job: Daily summaries sent successfully');
    } catch (notifyError) {
      console.error('Failed to notify admin:', notifyError);
    }

    res.status(500).json({
      success: false,
      error: 'Failed to send summaries',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
