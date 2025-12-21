import type { VercelRequest, VercelResponse } from '@vercel/node';
import { updateGoogleRefreshToken, getUserByTelegramId } from '../src/services/user-service';

/**
 * User-Facing Google Token Refresh
 * Opens in Telegram web view when user's token expires
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const { code, state } = req.query;

  // If no code, show the authorization page
  if (!code) {
    const userId = req.query.user_id;
    if (!userId) {
      res.status(400).send('Missing user_id parameter');
      return;
    }

    // Generate OAuth URL
    const baseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    const redirectUri = `https://${req.headers.host}/api/refresh-token`;
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      access_type: 'offline',
      prompt: 'consent', // Force consent to get refresh token
      state: userId.toString()
    });

    const oauthUrl = `${baseUrl}?${params.toString()}`;

    // Show authorization page
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Refresh Calendar Access</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.3);
              max-width: 400px;
              text-align: center;
            }
            .icon { font-size: 64px; margin-bottom: 20px; }
            h2 { margin: 0 0 20px 0; color: #333; }
            p { color: #666; line-height: 1.6; margin-bottom: 30px; }
            .btn {
              display: inline-block;
              padding: 15px 30px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 600;
              transition: background 0.3s;
            }
            .btn:hover { background: #5a67d8; }
            .steps {
              text-align: left;
              background: #f9fafb;
              padding: 20px;
              border-radius: 8px;
              margin-bottom: 30px;
            }
            .steps ol { margin: 0; padding-left: 20px; }
            .steps li { margin-bottom: 10px; color: #555; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">🔄</div>
            <h2>Refresh Calendar Access</h2>
            <p>Your Google Calendar access has expired. Let's refresh it!</p>

            <div class="steps">
              <strong>What will happen:</strong>
              <ol>
                <li>You'll log in to Google</li>
                <li>Grant calendar access</li>
                <li>Your bot will work again!</li>
              </ol>
            </div>

            <a href="${oauthUrl}" class="btn">
              🔐 Connect Google Calendar
            </a>
          </div>

          <script>
            // If running in Telegram Web App
            if (window.Telegram && window.Telegram.WebApp) {
              const tg = window.Telegram.WebApp;
              tg.expand();
              tg.MainButton.setText('Connect Google Calendar');
              tg.MainButton.onClick(() => {
                window.location.href = '${oauthUrl}';
              });
              tg.MainButton.show();
            }
          </script>
        </body>
      </html>
    `);
    return;
  }

  // Handle OAuth callback
  const telegramId = state ? parseInt(state as string) : null;
  if (!telegramId) {
    res.status(400).send('Missing user ID in state');
    return;
  }

  try {
    // Exchange code for tokens
    const redirectUri = `https://${req.headers.host}/api/refresh-token`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenResponse.json();

    if (!tokens.refresh_token) {
      // No refresh token - need to revoke and retry
      res.setHeader('Content-Type', 'text/html');
      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script src="https://telegram.org/js/telegram-web-app.js"></script>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0;
                padding: 20px;
              }
              .container {
                background: white;
                padding: 40px;
                border-radius: 15px;
                max-width: 400px;
                text-align: center;
              }
              .icon { font-size: 64px; margin-bottom: 20px; }
              h2 { margin: 0 0 20px 0; color: #333; }
              p { color: #666; line-height: 1.6; }
              a { color: #667eea; text-decoration: none; font-weight: 600; }
              .btn {
                display: inline-block;
                margin-top: 20px;
                padding: 15px 30px;
                background: #667eea;
                color: white;
                text-decoration: none;
                border-radius: 8px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="icon">⚠️</div>
              <h2>One More Step</h2>
              <p>Google didn't provide a new refresh token because you've authorized before.</p>
              <p><strong>Please revoke access first:</strong></p>
              <p>1. Go to <a href="https://myaccount.google.com/permissions" target="_blank">Google Permissions</a></p>
              <p>2. Remove "FamCalBot"</p>
              <p>3. Come back and try again</p>
              <a href="/api/refresh-token?user_id=${telegramId}" class="btn">Try Again</a>
            </div>
          </body>
        </html>
      `);
      return;
    }

    // Get user to verify
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    // Save new refresh token
    await updateGoogleRefreshToken(telegramId, tokens.refresh_token);

    // Success page
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.3);
              max-width: 400px;
              text-align: center;
            }
            .icon { font-size: 64px; margin-bottom: 20px; animation: bounce 1s; }
            @keyframes bounce {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-20px); }
            }
            h2 { margin: 0 0 20px 0; color: #333; }
            p { color: #666; line-height: 1.6; margin-bottom: 30px; }
            .user-info {
              background: #f9fafb;
              padding: 15px;
              border-radius: 8px;
              margin-bottom: 30px;
            }
            .close-btn {
              padding: 15px 30px;
              background: #667eea;
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              cursor: pointer;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">✅</div>
            <h2>All Set!</h2>
            <div class="user-info">
              <strong>${user.name}</strong><br>
              Calendar access refreshed successfully
            </div>
            <p>You can now use all calendar commands again!</p>
            <button class="close-btn" onclick="closeWindow()">Close</button>
          </div>

          <script>
            function closeWindow() {
              if (window.Telegram && window.Telegram.WebApp) {
                window.Telegram.WebApp.close();
              } else {
                window.close();
              }
            }

            // Auto-close after 3 seconds
            setTimeout(closeWindow, 3000);
          </script>
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
          <p><a href="/api/refresh-token?user_id=${telegramId}">Try Again</a></p>
        </body>
      </html>
    `);
  }
}
