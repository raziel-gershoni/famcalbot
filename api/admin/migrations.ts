import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prisma } from '../../src/utils/prisma';

/**
 * Migration Management Endpoint
 * View and run database migrations
 */
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

  // Check current schema
  try {
    const tables = await prisma.$queryRaw`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    ` as Array<{ table_name: string }>;

    const userTable = await prisma.$queryRaw`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'User'
      ORDER BY ordinal_position;
    ` as Array<{ column_name: string; data_type: string; is_nullable: string }>;

    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Database Migrations</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: #f5f5f5;
              padding: 20px;
              margin: 0;
            }
            .container { max-width: 1000px; margin: 0 auto; }
            .box {
              background: white;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              margin-bottom: 20px;
            }
            h2 { margin-top: 0; color: #333; }
            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 15px;
            }
            th, td {
              padding: 10px;
              text-align: left;
              border-bottom: 1px solid #ddd;
            }
            th {
              background: #f9fafb;
              font-weight: bold;
              color: #555;
            }
            .btn {
              display: inline-block;
              padding: 10px 20px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 5px;
              margin-top: 10px;
            }
            .btn:hover { background: #5a67d8; }
            code {
              background: #f3f4f6;
              padding: 2px 6px;
              border-radius: 3px;
              font-family: monospace;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="box">
              <h2>📦 Database Schema</h2>
              <p><strong>Database Tables:</strong></p>
              <ul>
                ${tables.map(t => `<li><code>${t.table_name}</code></li>`).join('')}
              </ul>
            </div>

            <div class="box">
              <h2>👤 User Table Schema</h2>
              <table>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Nullable</th>
                  </tr>
                </thead>
                <tbody>
                  ${userTable.map(col => `
                    <tr>
                      <td><code>${col.column_name}</code></td>
                      <td>${col.data_type}</td>
                      <td>${col.is_nullable === 'YES' ? '✓' : '✗'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="box">
              <h2>ℹ️ Migration Notes</h2>
              <p>Future schema changes should be managed by creating new migration SQL files.</p>
              <p>To add new fields or modify the schema:</p>
              <ol>
                <li>Update <code>prisma/schema.prisma</code> locally</li>
                <li>Run <code>npx prisma migrate dev --name your_migration_name</code></li>
                <li>This creates a new migration file in <code>prisma/migrations/</code></li>
                <li>Commit the migration file to git</li>
                <li>Deploy - migrations will run automatically via build script</li>
              </ol>
              <a href="/api/admin" class="btn">← Back to Admin</a>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Error querying database: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
}
