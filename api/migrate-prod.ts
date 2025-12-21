import type { VercelRequest, VercelResponse } from '@vercel/node';
import { execSync } from 'child_process';

/**
 * One-time production database migration endpoint
 *
 * Usage:
 *   POST https://your-domain.vercel.app/api/migrate-prod
 *   Authorization: Bearer <CRON_SECRET>
 *
 * After running successfully, DELETE this file and redeploy!
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Verify CRON_SECRET authorization
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    console.log('Running database migrations...');

    // Run migrations
    const output = execSync('npx prisma migrate deploy', {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: process.env.DIRECT_URL || process.env.DATABASE_URL
      }
    });

    console.log('Migration output:', output);

    res.status(200).json({
      success: true,
      message: 'Database migrations completed successfully',
      output: output,
      reminder: '🚨 DELETE api/migrate-prod.ts and redeploy immediately!'
    });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({
      error: 'Failed to run migrations',
      details: error instanceof Error ? error.message : 'Unknown error',
      stderr: (error as any).stderr?.toString()
    });
  }
}
