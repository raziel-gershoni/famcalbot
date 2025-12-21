import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllUsers } from '../../src/services/user-service';

/**
 * Admin Dashboard
 * Simple webapp for user management and Google OAuth refresh
 *
 * Protected by CRON_SECRET as password
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Check for auth cookie or header
  const authHeader = req.headers.authorization;
  const authCookie = req.cookies?.admin_auth;
  const token = authHeader?.replace('Bearer ', '') || authCookie;

  // Simple password check
  if (token !== process.env.CRON_SECRET) {
    // Show login form
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Admin Login</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0;
            }
            .login-box {
              background: white;
              padding: 40px;
              border-radius: 10px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.2);
              max-width: 400px;
              width: 100%;
            }
            h2 { margin-top: 0; color: #333; }
            input[type="password"] {
              width: 100%;
              padding: 12px;
              border: 2px solid #ddd;
              border-radius: 5px;
              font-size: 16px;
              box-sizing: border-box;
            }
            button {
              width: 100%;
              padding: 12px;
              background: #667eea;
              color: white;
              border: none;
              border-radius: 5px;
              font-size: 16px;
              cursor: pointer;
              margin-top: 10px;
            }
            button:hover { background: #5a67d8; }
          </style>
        </head>
        <body>
          <div class="login-box">
            <h2>🔐 Admin Login</h2>
            <form method="POST" action="/api/admin">
              <input type="password" name="password" placeholder="Enter admin password" required autofocus>
              <button type="submit">Login</button>
            </form>
          </div>
        </body>
      </html>
    `);
    return;
  }

  // Handle POST (login)
  if (req.method === 'POST') {
    const password = req.body?.password;
    if (password === process.env.CRON_SECRET) {
      res.setHeader('Set-Cookie', `admin_auth=${password}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
      res.redirect(302, '/api/admin');
    } else {
      res.redirect(302, '/api/admin');
    }
    return;
  }

  // Load users
  const users = await getAllUsers();

  // Generate OAuth URL for each user
  const oauthUrl = (telegramId: number) => {
    const baseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      redirect_uri: `${req.headers.host}/api/admin/oauth-refresh`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: telegramId.toString()
    });
    return `${baseUrl}?${params.toString()}`;
  };

  // Show admin dashboard
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Admin Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #f5f5f5;
            margin: 0;
            padding: 20px;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          header {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          h1 { margin: 0; color: #333; }
          .section {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .section h2 { margin-top: 0; color: #555; }
          .user-card {
            border: 1px solid #ddd;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 10px;
          }
          .user-card h3 { margin: 0 0 10px 0; color: #333; }
          .user-info { display: grid; grid-template-columns: 150px 1fr; gap: 10px; margin-bottom: 15px; }
          .user-info label { font-weight: bold; color: #666; }
          .btn {
            display: inline-block;
            padding: 10px 20px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            margin-right: 10px;
            font-size: 14px;
          }
          .btn:hover { background: #5a67d8; }
          .btn-success { background: #22c55e; }
          .btn-success:hover { background: #16a34a; }
          .btn-danger { background: #ef4444; }
          .btn-danger:hover { background: #dc2626; }
          .logout {
            float: right;
            background: #ef4444;
          }
          .logout:hover { background: #dc2626; }
        </style>
      </head>
      <body>
        <div class="container">
          <header>
            <h1>🎛️ FamCalBot Admin</h1>
            <a href="/api/admin/logout" class="btn logout">Logout</a>
          </header>

          <div class="section">
            <h2>👥 User Management</h2>
            ${users.map(user => `
              <div class="user-card">
                <h3>${user.name} (${user.hebrewName})</h3>
                <div class="user-info">
                  <label>Telegram ID:</label>
                  <span>${user.telegramId}</span>

                  <label>WhatsApp:</label>
                  <span>${user.whatsappPhone || 'Not set'}</span>

                  <label>Platform:</label>
                  <span>${user.messagingPlatform}</span>

                  <label>Location:</label>
                  <span>${user.location}</span>

                  <label>Language:</label>
                  <span>${user.language}</span>
                </div>
                <a href="${oauthUrl(user.telegramId)}" class="btn btn-success">🔄 Refresh Google Token</a>
                <a href="/api/admin/edit-user?id=${user.telegramId}" class="btn">✏️ Edit User</a>
              </div>
            `).join('')}
          </div>

          <div class="section">
            <h2>🔧 System Tools</h2>
            <a href="/api/admin/migrations" class="btn">📦 Run Migrations</a>
            <a href="/api/encrypt-tokens" class="btn btn-success" onclick="return confirm('Encrypt all OAuth tokens in database?')">🔐 Encrypt Tokens</a>
          </div>
        </div>
      </body>
    </html>
  `);
}
