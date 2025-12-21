import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PrismaClient } from '@prisma/client';

/**
 * One-time production database seeding endpoint
 *
 * Usage:
 *   POST https://your-domain.vercel.app/api/seed-prod
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
    // Safety check: Only run if database is empty
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      res.status(400).json({
        error: 'Database already has users. Seed can only run on empty database.',
        existingUsers: userCount
      });
      return;
    }

    // Shared calendar IDs
    const SHARED_CALENDARS = [
      'zhendos13@gmail.com',
      '16c9d51d0c05e9b56240e0c08017c54a93873904a759f2121e4ec6d59a32f0dc@group.calendar.google.com',
      '9d55e08b104e434dee3ac8722e651da0dce13cd4a676caa2fe4a45b05b8700db@group.calendar.google.com',
      'b70cd372f1b57dcbc093b36509bb66d6c827a8fd7eb79e8d432fde3d3ff97eca@group.calendar.google.com',
      '43e09cf368ffed0d61bf8fa3af38f929caab0e9f2b733f097373a828d46864f4@group.calendar.google.com',
      '670983d1e4006e027ba2685297fd48514979f438a18458a5acf0d6e90c2146ba@group.calendar.google.com',
      'yeshua7733@gmail.com',
      'raziel@internety.co.il'
    ];

    const RAZIEL_CALENDARS = [
      'zhendos13@gmail.com',
      'raziel@internety.co.il'
    ];
    const YESHUA_CALENDARS = ['yeshua7733@gmail.com'];

    // User 1: Raziel
    const raziel = await prisma.user.create({
      data: {
        telegramId: BigInt(762715667),
        whatsappPhone: '+972526367600',
        name: 'Raziel',
        hebrewName: 'רזיאל',
        gender: 'male',
        spouseName: 'Yeshua',
        spouseHebrewName: 'ישועה',
        spouseGender: 'female',
        location: 'Harish, Israel',
        language: 'Hebrew',
        messagingPlatform: 'telegram',
        googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
        calendars: SHARED_CALENDARS,
        primaryCalendar: 'zhendos13@gmail.com',
        ownCalendars: RAZIEL_CALENDARS,
        spouseCalendars: YESHUA_CALENDARS
      }
    });

    // User 2: Yeshua
    const yeshua = await prisma.user.create({
      data: {
        telegramId: BigInt(721483494),
        whatsappPhone: null, // Will add WhatsApp later
        name: 'Yeshua',
        hebrewName: 'ישועה',
        gender: 'female',
        spouseName: 'Raziel',
        spouseHebrewName: 'רזיאל',
        spouseGender: 'male',
        location: 'Harish, Israel',
        language: 'Hebrew',
        messagingPlatform: 'telegram',
        googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
        calendars: SHARED_CALENDARS,
        primaryCalendar: 'yeshua7733@gmail.com',
        ownCalendars: YESHUA_CALENDARS,
        spouseCalendars: RAZIEL_CALENDARS
      }
    });

    await prisma.$disconnect();

    res.status(200).json({
      success: true,
      message: 'Production database seeded successfully',
      users: [
        { id: raziel.id, name: raziel.name, telegramId: raziel.telegramId.toString() },
        { id: yeshua.id, name: yeshua.name, telegramId: yeshua.telegramId.toString() }
      ],
      reminder: '🚨 DELETE api/seed-prod.ts and redeploy immediately!'
    });
  } catch (error) {
    await prisma.$disconnect();
    console.error('Seed error:', error);
    res.status(500).json({
      error: 'Failed to seed database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
