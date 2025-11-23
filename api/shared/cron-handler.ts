import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Factory function to create cron endpoint handlers
 * Handles authentication, error handling, and response formatting consistently
 */
export function createCronHandler(
  summaryFunction: () => Promise<void>,
  successMessage: string
) {
  return async function handler(
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
      await summaryFunction();

      res.status(200).json({
        success: true,
        message: successMessage,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in cron handler:', error);

      // Notify admin of cron job failures
      try {
        const { notifyAdminError } = await import('../../src/utils/error-notifier');
        await notifyAdminError('Cron Job', error, `Job: ${successMessage}`);
      } catch (notifyError) {
        console.error('Failed to notify admin:', notifyError);
      }

      res.status(500).json({
        success: false,
        error: 'Failed to send summaries',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
}
