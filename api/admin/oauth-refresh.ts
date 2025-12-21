import type { VercelRequest, VercelResponse } from '@vercel/node';
import { updateGoogleRefreshToken } from '../../src/services/user-service';

/**
 * Google OAuth Callback Handler
 * Receives OAuth code and exchanges it for refresh token
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const { code, state } = req.query;

  if (!code || typeof code !== 'string') {
    res.status(400).send('Missing authorization code');
    return;
  }

  // State should be telegramId
  const telegramId = state ? parseInt(state as string) : null;
  if (!telegramId) {
    res.status(400).send('Missing user ID');
    return;
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.VERCEL_URL || 'http://localhost:3000'}/api/admin/oauth-refresh`,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenResponse.json();

    if (!tokens.refresh_token) {
      res.status(400).send(`
        <html>
          <body style="font-family: Arial; padding: 40px; text-align: center;">
            <h2>❌ No Refresh Token</h2>
            <p>Google didn't return a refresh token. This usually means:</p>
            <ul style="text-align: left; max-width: 500px; margin: 0 auto;">
              <li>You've already authorized this app before</li>
              <li>You need to revoke access first at:
                <a href="https://myaccount.google.com/permissions">Google Permissions</a>
              </li>
              <li>Then try again</li>
            </ul>
            <p><a href="/api/admin">← Back</a></p>
          </body>
        </html>
      `);
      return;
    }

    // Save to database
    await updateGoogleRefreshToken(telegramId, tokens.refresh_token);

    res.send(`
      <html>
        <head>
          <style>
            body { font-family: Arial; padding: 40px; text-align: center; }
            .success { color: #22c55e; font-size: 48px; }
            .box { max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="box">
            <div class="success">✅</div>
            <h2>Token Refreshed Successfully!</h2>
            <p>Your Google Calendar refresh token has been updated in the database.</p>
            <p><strong>User ID:</strong> ${telegramId}</p>
            <p style="margin-top: 30px;">
              <a href="/api/admin">← Back to Admin</a>
            </p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h2>❌ Error</h2>
          <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
          <p><a href="/api/admin">← Back</a></p>
        </body>
      </html>
    `);
  }
}
