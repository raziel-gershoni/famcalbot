import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PrismaClient } from '@prisma/client';

/**
 * One-time production database migration endpoint
 * Runs SQL migrations directly without using Prisma CLI
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

  const prisma = new PrismaClient();

  try {
    console.log('Checking if User table exists...');

    // Check if table already exists
    const tableCheck = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'User'
      );
    ` as Array<{ exists: boolean }>;

    if (tableCheck[0]?.exists) {
      await prisma.$disconnect();
      res.status(200).json({
        success: true,
        message: 'Database already migrated (User table exists)',
        alreadyMigrated: true
      });
      return;
    }

    console.log('Running migrations...');

    // Create User table
    await prisma.$executeRaw`
      CREATE TABLE "User" (
        "id" SERIAL NOT NULL,
        "telegramId" BIGINT,
        "whatsappPhone" TEXT,
        "name" TEXT NOT NULL,
        "hebrewName" TEXT NOT NULL,
        "gender" TEXT NOT NULL,
        "spouseName" TEXT NOT NULL,
        "spouseHebrewName" TEXT NOT NULL,
        "spouseGender" TEXT NOT NULL,
        "location" TEXT NOT NULL DEFAULT 'Harish, Israel',
        "language" TEXT NOT NULL DEFAULT 'Hebrew',
        "messagingPlatform" TEXT NOT NULL DEFAULT 'telegram',
        "googleRefreshToken" TEXT NOT NULL,
        "calendars" TEXT[],
        "primaryCalendar" TEXT NOT NULL,
        "ownCalendars" TEXT[],
        "spouseCalendars" TEXT[],
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "User_pkey" PRIMARY KEY ("id")
      );
    `;

    console.log('Creating indexes...');

    // Create indexes
    await prisma.$executeRaw`CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");`;
    await prisma.$executeRaw`CREATE UNIQUE INDEX "User_whatsappPhone_key" ON "User"("whatsappPhone");`;
    await prisma.$executeRaw`CREATE INDEX "User_telegramId_idx" ON "User"("telegramId");`;
    await prisma.$executeRaw`CREATE INDEX "User_whatsappPhone_idx" ON "User"("whatsappPhone");`;

    console.log('Migrations completed successfully');

    await prisma.$disconnect();

    res.status(200).json({
      success: true,
      message: 'Database migrations completed successfully',
      reminder: '🚨 DELETE api/migrate-prod.ts and redeploy immediately!'
    });
  } catch (error) {
    await prisma.$disconnect();
    console.error('Migration error:', error);
    res.status(500).json({
      error: 'Failed to run migrations',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
