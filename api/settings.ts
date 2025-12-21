import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserByTelegramId, updateUser } from '../src/services/user-service';

/**
 * User Settings Management
 * Manage language, location, and platform preferences
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const { user_id } = req.query;

  if (!user_id) {
    res.status(400).send('Missing user_id parameter');
    return;
  }

  const userId = parseInt(user_id as string);
  const user = await getUserByTelegramId(userId);

  if (!user) {
    res.status(404).send('User not found');
    return;
  }

  // Handle settings update
  if (req.method === 'POST') {
    const { language, location, messagingPlatform } = req.body;

    try {
      await updateUser(userId, {
        language: language || user.language,
        location: location || user.location,
        messagingPlatform: messagingPlatform || user.messagingPlatform
      });

      // Show success page
      res.setHeader('Content-Type', 'text/html');
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Settings Saved</title>
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
              .success-box {
                background: white;
                padding: 40px;
                border-radius: 15px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                text-align: center;
                max-width: 400px;
              }
              .icon {
                font-size: 64px;
                margin-bottom: 20px;
              }
              h1 { color: #22c55e; margin: 0 0 10px 0; }
              p { color: #666; }
              .btn {
                margin-top: 20px;
                padding: 15px 30px;
                background: #667eea;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                width: 100%;
              }
              .btn:hover { background: #5a67d8; }
            </style>
          </head>
          <body>
            <div class="success-box">
              <div class="icon">✅</div>
              <h1>Settings Saved!</h1>
              <p>Your preferences have been updated successfully</p>
              <button onclick="goBack()" class="btn">← Back to Dashboard</button>
            </div>
            <script>
              const tg = window.Telegram.WebApp;
              tg.expand();
              tg.ready();

              function goBack() {
                window.location.href = '/api/dashboard?user_id=${userId}';
              }
            </script>
          </body>
        </html>
      `);
      return;
    } catch (error) {
      console.error('Error updating settings:', error);
      res.status(500).send('Error updating settings');
      return;
    }
  }

  // GET: Show settings form
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Settings</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 0;
            margin: 0;
          }

          .container {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            min-height: 100vh;
          }

          header {
            background: #667eea;
            color: white;
            padding: 20px;
          }

          header h1 {
            font-size: 24px;
            font-weight: 600;
          }

          .content {
            padding: 20px;
          }

          .form-group {
            margin-bottom: 24px;
          }

          label {
            display: block;
            font-weight: 600;
            color: #374151;
            margin-bottom: 8px;
            font-size: 14px;
          }

          input,
          select {
            width: 100%;
            padding: 12px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.2s;
          }

          input:focus,
          select:focus {
            outline: none;
            border-color: #667eea;
          }

          .help-text {
            font-size: 13px;
            color: #6b7280;
            margin-top: 4px;
          }

          .btn {
            width: 100%;
            padding: 15px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            margin-top: 8px;
          }

          .btn:hover {
            background: #5a67d8;
          }

          .btn-secondary {
            background: #f3f4f6;
            color: #374151;
          }

          .btn-secondary:hover {
            background: #e5e7eb;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <header>
            <h1>⚙️ Settings</h1>
          </header>

          <div class="content">
            <form method="POST" action="/api/settings?user_id=${userId}">
              <div class="form-group">
                <label for="language">Language</label>
                <select name="language" id="language">
                  <option value="Hebrew" ${user.language === 'Hebrew' ? 'selected' : ''}>עברית (Hebrew)</option>
                  <option value="English" ${user.language === 'English' ? 'selected' : ''}>English</option>
                </select>
                <p class="help-text">Language for summaries and messages</p>
              </div>

              <div class="form-group">
                <label for="location">Location</label>
                <input
                  type="text"
                  name="location"
                  id="location"
                  value="${user.location}"
                  placeholder="City, Country"
                >
                <p class="help-text">Used for weather forecasts</p>
              </div>

              <div class="form-group">
                <label for="messagingPlatform">Messaging Platform</label>
                <select name="messagingPlatform" id="messagingPlatform">
                  <option value="telegram" ${user.messagingPlatform === 'telegram' ? 'selected' : ''}>Telegram</option>
                  <option value="whatsapp" ${user.messagingPlatform === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
                  <option value="all" ${user.messagingPlatform === 'all' ? 'selected' : ''}>Both</option>
                </select>
                <p class="help-text">Where to receive messages</p>
              </div>

              <button type="submit" class="btn">Save Settings</button>
              <button type="button" class="btn btn-secondary" onclick="goBack()">Cancel</button>
            </form>
          </div>
        </div>

        <script>
          const tg = window.Telegram.WebApp;
          tg.expand();
          tg.ready();
          tg.setHeaderColor('#667eea');
          tg.setBackgroundColor('#ffffff');

          function goBack() {
            window.location.href = '/api/dashboard?user_id=${userId}';
          }
        </script>
      </body>
    </html>
  `);
}
