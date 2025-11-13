import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import { getBot } from '../src/services/telegram';

const ADMIN_USER_ID = 762715667; // Raziel's Telegram ID

/**
 * Health Check Endpoint
 * Tests Google Calendar token and alerts if broken
 * Run this daily via cron (e.g., 6 AM) to detect issues early
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

    // Test the Google Calendar token
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Try to fetch calendar list (lightweight test)
    await calendar.calendarList.list();

    // Token is valid!
    res.status(200).json({
      success: true,
      message: 'Health check passed - Google token is valid',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Health check failed:', error);

    // Alert admin
    try {
      const bot = getBot();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await bot.sendMessage(
        ADMIN_USER_ID,
        '🚨 <b>Health Check Failed!</b>\n\n' +
        'Google Calendar token test failed.\n\n' +
        `<b>Error:</b> ${errorMessage}\n\n` +
        '<b>Action needed:</b>\n' +
        '1. Run: <code>npm run get-google-token</code>\n' +
        '2. Update GOOGLE_REFRESH_TOKEN in .env and Vercel\n' +
        '3. Redeploy',
        { parse_mode: 'HTML' }
      );
    } catch (alertError) {
      console.error('Failed to send admin alert:', alertError);
    }

    res.status(500).json({
      success: false,
      error: 'Health check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
