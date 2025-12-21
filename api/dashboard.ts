import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserByTelegramId } from '../src/services/user-service';

/**
 * Main Dashboard Webapp
 * Unified interface for all bot features
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

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'family_calendar_telegram_bot';

  // Check setup status
  const needsOAuth = !user.googleRefreshToken;
  const needsCalendars = user.calendars.length === 0;

  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>FamCalBot Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 0;
            margin: 0;
          }

          .dashboard {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            min-height: 100vh;
          }

          header {
            background: #667eea;
            color: white;
            padding: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          header h1 {
            font-size: 24px;
            font-weight: 600;
          }

          .user-info {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 16px;
          }

          .settings-icon {
            background: rgba(255, 255, 255, 0.2);
            border: none;
            color: white;
            font-size: 24px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
          }

          .settings-icon:hover {
            background: rgba(255, 255, 255, 0.3);
          }

          .dashboard-content {
            padding: 20px;
          }

          .section {
            margin-bottom: 30px;
          }

          .section-title {
            font-size: 18px;
            font-weight: 600;
            color: #111827;
            margin-bottom: 12px;
          }

          .section-subtitle {
            font-size: 14px;
            color: #6b7280;
            margin-bottom: 12px;
          }

          .button-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }

          .action-button {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            font-size: 16px;
            font-weight: 500;
            color: #111827;
          }

          .action-button:hover {
            border-color: #667eea;
            background: #f9fafb;
            transform: translateY(-2px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .action-button .icon {
            font-size: 32px;
          }

          .settings-card {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .settings-card:hover {
            border-color: #667eea;
            background: #f9fafb;
            transform: translateY(-2px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .card-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .card-content p {
            color: #6b7280;
            font-size: 14px;
          }

          .arrow {
            font-size: 20px;
            color: #9ca3af;
          }

          .setup-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .setup-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.3);
          }

          .setup-card h3 {
            font-size: 20px;
            margin-bottom: 8px;
          }

          .setup-card p {
            font-size: 14px;
            opacity: 0.9;
          }

          @media (max-width: 400px) {
            .button-group {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="dashboard">
          <header>
            <h1>FamCalBot</h1>
            <div class="user-info">
              ${user.name}
              <button class="settings-icon" onclick="openUserSettings()">⚙️</button>
            </div>
          </header>

          <div class="dashboard-content">
            ${needsOAuth ? `
              <div class="setup-card" onclick="connectGoogle()">
                <h3>🔐 Connect Google Calendar</h3>
                <p>Link your Google account to get started with calendar summaries</p>
              </div>
            ` : needsCalendars ? `
              <div class="setup-card" onclick="selectCalendars()">
                <h3>📅 Select Your Calendars</h3>
                <p>Choose which calendars to sync with your bot</p>
              </div>
            ` : `
              <!-- Summary Section -->
              <div class="section">
                <h2 class="section-title">📅 Calendar Summary</h2>
                <div class="button-group">
                  <button class="action-button" onclick="getSummary('today')">
                    <span class="icon">☀️</span>
                    <span>Today</span>
                  </button>
                  <button class="action-button" onclick="getSummary('tmrw')">
                    <span class="icon">🌙</span>
                    <span>Tomorrow</span>
                  </button>
                </div>
              </div>

              <!-- Weather Section -->
              <div class="section">
                <h2 class="section-title">🌤️ Weather Forecast</h2>
                <p class="section-subtitle">${user.location}</p>
                <div class="button-group">
                  <button class="action-button" onclick="getWeather('std')">
                    <span class="icon">📊</span>
                    <span>Standard</span>
                  </button>
                  <button class="action-button" onclick="getWeather('dtl')">
                    <span class="icon">📋</span>
                    <span>Detailed</span>
                  </button>
                </div>
              </div>

              <!-- Calendar Settings Card -->
              <div class="section">
                <h2 class="section-title">📋 Calendar Settings</h2>
                <div class="settings-card" onclick="openCalendarSettings()">
                  <div class="card-content">
                    <p>${user.calendars.length} calendars synced</p>
                    <span class="arrow">→</span>
                  </div>
                </div>
              </div>
            `}
          </div>
        </div>

        <script>
          const tg = window.Telegram.WebApp;
          tg.expand();
          tg.ready();
          tg.setHeaderColor('#667eea');
          tg.setBackgroundColor('#ffffff');

          function getSummary(timeframe) {
            const command = timeframe === 'today' ? '/summary' : '/summary tmrw';
            const deepLink = \`https://t.me/${botUsername}?text=\${encodeURIComponent(command)}\`;
            tg.openLink(deepLink);
            tg.close();
          }

          function getWeather(format) {
            const command = \`/weather \${format}\`;
            const deepLink = \`https://t.me/${botUsername}?text=\${encodeURIComponent(command)}\`;
            tg.openLink(deepLink);
            tg.close();
          }

          function openCalendarSettings() {
            window.location.href = '/api/select-calendars?user_id=${userId}';
          }

          function openUserSettings() {
            window.location.href = '/api/settings?user_id=${userId}';
          }

          function connectGoogle() {
            window.location.href = '/api/refresh-token?user_id=${userId}';
          }

          function selectCalendars() {
            window.location.href = '/api/select-calendars?user_id=${userId}';
          }
        </script>
      </body>
    </html>
  `);
}
