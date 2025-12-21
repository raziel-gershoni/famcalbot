import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllUsers, getUserByTelegramId, updateUser, updateGoogleRefreshToken } from '../src/services/user-service';
import { prisma } from '../src/utils/prisma';

/**
 * Consolidated Admin Endpoint
 * Handles all admin routes in one serverless function
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const path = req.url?.split('?')[0] || '';

  // Auth check (except for POST login)
  const authHeader = req.headers.authorization;
  const authCookie = req.cookies?.admin_auth;
  const token = authHeader?.replace('Bearer ', '') || authCookie;

  // Handle POST login
  if (req.method === 'POST' && path === '/api/admin') {
    const password = req.body?.password;
    if (password === process.env.CRON_SECRET) {
      res.setHeader('Set-Cookie', `admin_auth=${password}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
      res.redirect(302, '/api/admin');
    } else {
      res.redirect(302, '/api/admin');
    }
    return;
  }

  // Logout
  if (path.includes('/logout')) {
    res.setHeader('Set-Cookie', 'admin_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.redirect(302, '/api/admin');
    return;
  }

  // Require auth for all other routes
  if (token !== process.env.CRON_SECRET) {
    // Show login
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

  // OAuth callback
  if (path.includes('/oauth-refresh')) {
    const { code, state } = req.query;

    if (!code || typeof code !== 'string') {
      res.status(400).send('Missing authorization code');
      return;
    }

    const telegramId = state ? parseInt(state as string) : null;
    if (!telegramId) {
      res.status(400).send('Missing user ID');
      return;
    }

    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `https://${req.headers.host}/api/admin/oauth-refresh`,
          grant_type: 'authorization_code'
        })
      });

      const tokens = await tokenResponse.json();

      if (!tokens.refresh_token) {
        res.send('<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h2>❌ No Refresh Token</h2><p>Revoke access first at <a href="https://myaccount.google.com/permissions">Google Permissions</a></p><p><a href="/api/admin">← Back</a></p></body></html>');
        return;
      }

      await updateGoogleRefreshToken(telegramId, tokens.refresh_token);

      const user = await getUserByTelegramId(telegramId);
      res.send(`<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h2>✅ Success!</h2><p><strong>${user?.name}</strong><br>Token refreshed</p><p><a href="/api/admin">← Back to Admin</a></p></body></html>`);
    } catch (error) {
      res.status(500).send('Error: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    return;
  }

  // Edit user page
  if (path.includes('/edit-user')) {
    const userId = req.query.id ? parseInt(req.query.id as string) : null;
    if (!userId) {
      res.status(400).send('Missing user ID');
      return;
    }

    if (req.method === 'POST') {
      await updateUser(userId, {
        name: req.body.name,
        hebrewName: req.body.hebrewName,
        location: req.body.location,
        whatsappPhone: req.body.whatsappPhone || null,
        messagingPlatform: req.body.messagingPlatform
      });
      res.redirect(302, '/api/admin');
      return;
    }

    const user = await getUserByTelegramId(userId);
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><title>Edit ${user.name}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:Arial;padding:20px;background:#f5f5f5}.box{background:white;padding:30px;max-width:600px;margin:0 auto;border-radius:10px}input,select{width:100%;padding:10px;margin:5px 0 15px;border:2px solid #ddd;border-radius:5px;box-sizing:border-box}.btn{padding:12px 24px;background:#667eea;color:white;border:none;border-radius:5px;cursor:pointer}</style></head><body><div class="box"><h2>Edit ${user.name}</h2><form method="POST"><label>Name</label><input name="name" value="${user.name}" required><label>Hebrew Name</label><input name="hebrewName" value="${user.hebrewName}" required><label>Location</label><input name="location" value="${user.location}" required><label>WhatsApp</label><input name="whatsappPhone" value="${user.whatsappPhone || ''}" placeholder="+972..."><label>Platform</label><select name="messagingPlatform"><option value="telegram" ${user.messagingPlatform === 'telegram' ? 'selected' : ''}>Telegram</option><option value="whatsapp" ${user.messagingPlatform === 'whatsapp' ? 'selected' : ''}>WhatsApp</option><option value="all" ${user.messagingPlatform === 'all' ? 'selected' : ''}>Both</option></select><button class="btn">Save</button></form></div></body></html>`);
    return;
  }

  // Migrations page
  if (path.includes('/migrations')) {
    const tables = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;` as Array<{table_name: string}>;
    const userTable = await prisma.$queryRaw`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'User' ORDER BY ordinal_position;` as Array<{column_name: string; data_type: string; is_nullable: string}>;

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><title>Migrations</title><style>body{font-family:Arial;padding:20px;background:#f5f5f5}.box{background:white;padding:30px;max-width:1000px;margin:0 auto 20px;border-radius:10px}table{width:100%;border-collapse:collapse;margin-top:15px}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd}th{background:#f9fafb}</style></head><body><div class="box"><h2>📦 Database Schema</h2><p><strong>Tables:</strong> ${tables.map(t => t.table_name).join(', ')}</p></div><div class="box"><h2>User Table</h2><table><tr><th>Column</th><th>Type</th><th>Nullable</th></tr>${userTable.map(c => `<tr><td>${c.column_name}</td><td>${c.data_type}</td><td>${c.is_nullable === 'YES' ? '✓' : '✗'}</td></tr>`).join('')}</table></div><div class="box"><p><a href="/api/admin">← Back to Admin</a></p></div></body></html>`);
    return;
  }

  // Main dashboard
  const users = await getAllUsers();
  const oauthUrl = (telegramId: number) => {
    const baseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      redirect_uri: `https://${req.headers.host}/api/admin/oauth-refresh`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: telegramId.toString()
    });
    return `${baseUrl}?${params.toString()}`;
  };

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><title>Admin Dashboard</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{font-family:Arial;background:#f5f5f5;margin:0;padding:20px}.container{max-width:1200px;margin:0 auto}header{background:white;padding:20px;border-radius:10px;margin-bottom:20px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}h1{margin:0;color:#333}.section{background:white;padding:20px;border-radius:10px;margin-bottom:20px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}.user-card{border:1px solid #ddd;padding:15px;border-radius:5px;margin-bottom:10px}.user-card h3{margin:0 0 10px 0}.user-info{display:grid;grid-template-columns:150px 1fr;gap:10px;margin-bottom:15px}.user-info label{font-weight:bold;color:#666}.btn{display:inline-block;padding:10px 20px;background:#667eea;color:white;text-decoration:none;border-radius:5px;margin-right:10px;font-size:14px}.btn:hover{background:#5a67d8}.btn-success{background:#22c55e}.btn-success:hover{background:#16a34a}.logout{float:right;background:#ef4444}.logout:hover{background:#dc2626}</style></head><body><div class="container"><header><h1>🎛️ FamCalBot Admin</h1><a href="/api/admin/logout" class="btn logout">Logout</a></header><div class="section"><h2>👥 User Management</h2>${users.map(u => `<div class="user-card"><h3>${u.name} (${u.hebrewName})</h3><div class="user-info"><label>Telegram ID:</label><span>${u.telegramId}</span><label>WhatsApp:</label><span>${u.whatsappPhone || 'Not set'}</span><label>Platform:</label><span>${u.messagingPlatform}</span><label>Location:</label><span>${u.location}</span></div><a href="${oauthUrl(u.telegramId)}" class="btn btn-success">🔄 Refresh Google Token</a><a href="/api/admin/edit-user?id=${u.telegramId}" class="btn">✏️ Edit User</a></div>`).join('')}</div><div class="section"><h2>🔧 System Tools</h2><a href="/api/admin/migrations" class="btn">📦 View Database Schema</a></div></div></body></html>`);
}
