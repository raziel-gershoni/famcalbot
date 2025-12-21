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
      'addressbook#contacts@group.v.calendar.google.com',
      'en.israeli#holiday@group.v.calendar.google.com',
      '24c3fdf74ea833f4a53e7f8f6f1e0a41ba44eeb6e27b03ccf74a5a62d39cdf72@group.calendar.google.com',
      '2fb0f07dce4bc0bdd61ff02b17f49f5ebac370b7c04a2cc93c6e3bf89edbe31e@group.calendar.google.com',
      'c_03c62c1ac1e2a9d5f4a2d00e2e77a5be7e8b85c3f1a45eb1bf0866a166e5b5d1@group.calendar.google.com',
      'c_0418edcf2ed3abd2a6fb0c9dad41d4e5ce8ffd026c78cdb3b80c13f6e7b71697@group.calendar.google.com'
    ];

    const RAZIEL_CALENDARS = ['zhendos13@gmail.com'];
    const YESHUA_CALENDARS = [
      '16c9d51d0c05e9b56240e0c08017c54a93873904a759f2121e4ec6d59a32f0dc@group.calendar.google.com'
    ];

    // User 1: Raziel
    const raziel = await prisma.user.create({
      data: {
        telegramId: BigInt(762715667),
        whatsappPhone: '+972526367600',
        name: 'Raziel',
        hebrewName: 'רזיאל',
        gender: 'male',
        spouseName: 'Yeshua',
        spouseHebrewName: 'יֵשׁוּעָ',
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
        telegramId: BigInt(1234567890), // TODO: Replace with actual Telegram ID
        whatsappPhone: null, // Will add WhatsApp later
        name: 'Yeshua',
        hebrewName: 'יֵשׁוּעָ',
        gender: 'female',
        spouseName: 'Raziel',
        spouseHebrewName: 'רזיאל',
        spouseGender: 'male',
        location: 'Harish, Israel',
        language: 'Hebrew',
        messagingPlatform: 'telegram',
        googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
        calendars: SHARED_CALENDARS,
        primaryCalendar: '16c9d51d0c05e9b56240e0c08017c54a93873904a759f2121e4ec6d59a32f0dc@group.calendar.google.com',
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
