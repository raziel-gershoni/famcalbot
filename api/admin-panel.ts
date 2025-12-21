import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserByTelegramId } from '../src/services/user-service';
import prisma from '../src/lib/prisma';

/**
 * Admin Panel Webapp
 * Access restricted to users with isAdmin flag
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

  // Check admin access
  if (!user.isAdmin) {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Unauthorized</title>
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
            .error-box {
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
            h1 { color: #ef4444; margin: 0 0 10px 0; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="error-box">
            <div class="icon">🔒</div>
            <h1>Unauthorized</h1>
            <p>This area is restricted to administrators only.</p>
          </div>
          <script>
            const tg = window.Telegram.WebApp;
            tg.expand();
            tg.ready();
          </script>
        </body>
      </html>
    `);
    return;
  }

  // Get statistics
  const totalUsers = await prisma.user.count();
  const usersWithOAuth = await prisma.user.count({
    where: {
      NOT: {
        googleRefreshToken: ''
      }
    }
  });
  const usersWithCalendars = await prisma.user.count({
    where: {
      calendars: {
        isEmpty: false
      }
    }
  });

  // Get recent users
  const recentUsers = await prisma.user.findMany({
    orderBy: {
      createdAt: 'desc'
    },
    take: 5,
    select: {
      name: true,
      createdAt: true,
      language: true,
      messagingPlatform: true
    }
  });

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'family_calendar_telegram_bot';

  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Admin Panel</title>
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

          .admin-panel {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            min-height: 100vh;
          }

          header {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
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

          .admin-badge {
            background: rgba(255, 255, 255, 0.3);
            padding: 6px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 1px;
          }

          .admin-content {
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

          .stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 16px;
          }

          .stat-card {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
          }

          .stat-value {
            font-size: 32px;
            font-weight: 700;
            color: #667eea;
            margin-bottom: 4px;
          }

          .stat-label {
            font-size: 13px;
            color: #6b7280;
            font-weight: 500;
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
            padding: 16px;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 15px;
            font-weight: 500;
            color: #111827;
          }

          .action-button:hover {
            border-color: #ef4444;
            background: #fef2f2;
            transform: translateY(-2px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .health-list {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            overflow: hidden;
          }

          .health-item {
            padding: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #e5e7eb;
          }

          .health-item:last-child {
            border-bottom: none;
          }

          .health-label {
            font-size: 14px;
            color: #374151;
            font-weight: 500;
          }

          .status-icon {
            font-size: 20px;
          }

          .user-list {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            overflow: hidden;
          }

          .user-item {
            padding: 12px 16px;
            border-bottom: 1px solid #e5e7eb;
          }

          .user-item:last-child {
            border-bottom: none;
          }

          .user-name {
            font-size: 14px;
            font-weight: 600;
            color: #111827;
            margin-bottom: 4px;
          }

          .user-meta {
            font-size: 12px;
            color: #6b7280;
          }

          .dashboard-btn {
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
            margin-top: 16px;
          }

          .dashboard-btn:hover {
            background: #5a67d8;
          }

          @media (max-width: 400px) {
            .stats-grid,
            .button-group {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="admin-panel">
          <header>
            <h1>👑 Admin Panel</h1>
            <div class="admin-badge">ADMIN</div>
          </header>

          <div class="admin-content">
            <!-- AI Model Testing Section -->
            <div class="section">
              <h2 class="section-title">🤖 AI Model Testing</h2>
              <div class="button-group">
                <button class="action-button" onclick="testModel('today')">
                  Test Today
                </button>
                <button class="action-button" onclick="testModel('tmrw')">
                  Test Tomorrow
                </button>
              </div>
            </div>

            <!-- User Statistics Section -->
            <div class="section">
              <h2 class="section-title">👥 User Statistics</h2>
              <div class="stats-grid">
                <div class="stat-card">
                  <div class="stat-value">${totalUsers}</div>
                  <div class="stat-label">Total Users</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">${usersWithOAuth}</div>
                  <div class="stat-label">With OAuth</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">${usersWithCalendars}</div>
                  <div class="stat-label">With Calendars</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">${totalUsers - usersWithOAuth}</div>
                  <div class="stat-label">Need Setup</div>
                </div>
              </div>

              <h3 style="font-size: 14px; font-weight: 600; color: #6b7280; margin-bottom: 8px;">Recent Users</h3>
              <div class="user-list">
                ${recentUsers.map(u => `
                  <div class="user-item">
                    <div class="user-name">${u.name}</div>
                    <div class="user-meta">
                      ${new Date(u.createdAt).toLocaleDateString()} •
                      ${u.language} •
                      ${u.messagingPlatform}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- System Health Section -->
            <div class="section">
              <h2 class="section-title">🏥 System Health</h2>
              <div class="health-list">
                <div class="health-item">
                  <span class="health-label">Database Connection</span>
                  <span class="status-icon">✅</span>
                </div>
                <div class="health-item">
                  <span class="health-label">Total Users</span>
                  <span class="health-label">${totalUsers}</span>
                </div>
                <div class="health-item">
                  <span class="health-label">Setup Completion</span>
                  <span class="health-label">${Math.round((usersWithCalendars / totalUsers) * 100)}%</span>
                </div>
              </div>
            </div>

            <!-- User Dashboard Link -->
            <button class="dashboard-btn" onclick="openUserDashboard()">
              📱 Open User Dashboard
            </button>
          </div>
        </div>

        <script>
          const tg = window.Telegram.WebApp;
          tg.expand();
          tg.ready();
          tg.setHeaderColor('#ef4444');
          tg.setBackgroundColor('#ffffff');

          function testModel(timeframe) {
            const command = timeframe === 'today' ? '/testai' : '/testai tmrw';
            const deepLink = \`https://t.me/${botUsername}?text=\${encodeURIComponent(command)}\`;
            tg.openLink(deepLink);
            tg.close();
          }

          function openUserDashboard() {
            window.location.href = '/api/dashboard?user_id=${userId}';
          }
        </script>
      </body>
    </html>
  `);
}
