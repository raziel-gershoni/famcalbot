import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PrismaClient } from '@prisma/client';

/**
 * ONE-TIME ONLY: Reset database for fresh migration
 * DELETE THIS FILE AFTER USE
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Safety check - only allow with secret token
  const { token } = req.query;

  if (token !== process.env.ADMIN_SECRET_TOKEN) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }

  const prisma = new PrismaClient();

  try {
    // Drop all tables to allow fresh migration
    await prisma.$executeRawUnsafe('DROP SCHEMA public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
    await prisma.$executeRawUnsafe('GRANT ALL ON SCHEMA public TO PUBLIC');

    res.status(200).json({
      success: true,
      message: 'Database reset. Deploy now to run fresh migrations.'
    });
  } catch (error) {
    console.error('Reset failed:', error);
    res.status(500).json({ error: 'Reset failed', details: error });
  } finally {
    await prisma.$disconnect();
  }
}
