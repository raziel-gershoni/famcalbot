import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prisma } from '../src/utils/prisma';
import { encrypt, isEncrypted } from '../src/utils/encryption';

/**
 * One-time endpoint to encrypt existing OAuth tokens
 *
 * Usage:
 *   POST https://your-domain.vercel.app/api/encrypt-tokens
 *   Authorization: Bearer <CRON_SECRET>
 *
 * After running successfully, DELETE this file!
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
    // Get all users
    const users = await prisma.user.findMany();
    const updates: string[] = [];

    for (const user of users) {
      // Skip if already encrypted
      if (isEncrypted(user.googleRefreshToken)) {
        updates.push(`User ${user.id} (${user.name}): already encrypted`);
        continue;
      }

      // Encrypt the token
      const encryptedToken = encrypt(user.googleRefreshToken);

      // Update in database
      await prisma.user.update({
        where: { id: user.id },
        data: { googleRefreshToken: encryptedToken }
      });

      updates.push(`User ${user.id} (${user.name}): encrypted successfully`);
    }

    res.status(200).json({
      success: true,
      message: 'All tokens encrypted successfully',
      updates,
      reminder: '🚨 DELETE api/encrypt-tokens.ts and redeploy immediately!'
    });
  } catch (error) {
    console.error('Encryption error:', error);
    res.status(500).json({
      error: 'Failed to encrypt tokens',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
