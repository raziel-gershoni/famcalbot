import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserByTelegramId, updateUser } from '../../src/services/user-service';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Auth check
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.admin_auth;
  if (token !== process.env.CRON_SECRET) {
    res.redirect(302, '/api/admin');
    return;
  }

  const userId = req.query.id ? parseInt(req.query.id as string) : null;
  if (!userId) {
    res.status(400).send('Missing user ID');
    return;
  }

  // Handle POST (update)
  if (req.method === 'POST') {
    try {
      await updateUser(userId, {
        name: req.body.name,
        hebrewName: req.body.hebrewName,
        location: req.body.location,
        whatsappPhone: req.body.whatsappPhone || null,
        messagingPlatform: req.body.messagingPlatform
      });
      res.redirect(302, '/api/admin');
    } catch (error) {
      res.status(500).send('Error updating user: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    return;
  }

  // Load user
  const user = await getUserByTelegramId(userId);
  if (!user) {
    res.status(404).send('User not found');
    return;
  }

  // Show edit form
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Edit User - ${user.name}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #f5f5f5;
            padding: 20px;
            margin: 0;
          }
          .container { max-width: 600px; margin: 0 auto; }
          .box {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          h2 { margin-top: 0; color: #333; }
          .form-group { margin-bottom: 20px; }
          label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: #555;
          }
          input, select {
            width: 100%;
            padding: 10px;
            border: 2px solid #ddd;
            border-radius: 5px;
            font-size: 16px;
            box-sizing: border-box;
          }
          .btn {
            padding: 12px 24px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 16px;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
          }
          .btn:hover { background: #5a67d8; }
          .btn-secondary {
            background: #6b7280;
            margin-left: 10px;
          }
          .btn-secondary:hover { background: #4b5563; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="box">
            <h2>✏️ Edit User: ${user.name}</h2>
            <form method="POST">
              <div class="form-group">
                <label>Name (English)</label>
                <input type="text" name="name" value="${user.name}" required>
              </div>

              <div class="form-group">
                <label>Name (Hebrew)</label>
                <input type="text" name="hebrewName" value="${user.hebrewName}" required>
              </div>

              <div class="form-group">
                <label>Location</label>
                <input type="text" name="location" value="${user.location}" required>
              </div>

              <div class="form-group">
                <label>WhatsApp Phone</label>
                <input type="tel" name="whatsappPhone" value="${user.whatsappPhone || ''}" placeholder="+972501234567">
              </div>

              <div class="form-group">
                <label>Messaging Platform</label>
                <select name="messagingPlatform">
                  <option value="telegram" ${user.messagingPlatform === 'telegram' ? 'selected' : ''}>Telegram</option>
                  <option value="whatsapp" ${user.messagingPlatform === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
                  <option value="all" ${user.messagingPlatform === 'all' ? 'selected' : ''}>Both</option>
                </select>
              </div>

              <button type="submit" class="btn">💾 Save Changes</button>
              <a href="/api/admin" class="btn btn-secondary">Cancel</a>
            </form>
          </div>
        </div>
      </body>
    </html>
  `);
}
