import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PrismaClient } from '@prisma/client';

/**
 * ONE-TIME ONLY: Seed initial users after fresh migration
 * DELETE THIS FILE AFTER USE
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Safety check - only allow with secret token
  const { token } = req.query;

  if (token !== process.env.CRON_SECRET) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }

  const prisma = new PrismaClient();

  try {
    // Shared calendars
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

    const SHARED_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

    if (!SHARED_REFRESH_TOKEN) {
      throw new Error('GOOGLE_REFRESH_TOKEN not set in environment');
    }

    // User 1: Raziel (Admin)
    const raziel = await prisma.user.upsert({
      where: { telegramId: BigInt(762715667) },
      update: {},
      create: {
        telegramId: BigInt(762715667),
        whatsappPhone: '+972526367600',
        messagingPlatform: 'telegram',
        name: 'Raziel',
        hebrewName: 'רזיאל',
        gender: 'male',
        spouseName: 'Yeshua',
        spouseHebrewName: 'ישועה',
        spouseGender: 'female',
        location: 'Harish, Israel',
        language: 'Hebrew',
        calendars: SHARED_CALENDARS,
        googleRefreshToken: SHARED_REFRESH_TOKEN,
        primaryCalendar: 'zhendos13@gmail.com',
        ownCalendars: [
          'zhendos13@gmail.com',
          'raziel@internety.co.il'
        ],
        spouseCalendars: ['yeshua7733@gmail.com'],
        isAdmin: true  // Raziel is admin
      }
    });

    // User 2: Yeshua
    const yeshua = await prisma.user.upsert({
      where: { telegramId: BigInt(721483494) },
      update: {},
      create: {
        telegramId: BigInt(721483494),
        whatsappPhone: null,
        messagingPlatform: 'telegram',
        name: 'Yeshua',
        hebrewName: 'ישועה',
        gender: 'female',
        spouseName: 'Raziel',
        spouseHebrewName: 'רזיאל',
        spouseGender: 'male',
        location: 'Harish, Israel',
        language: 'Hebrew',
        calendars: SHARED_CALENDARS,
        googleRefreshToken: SHARED_REFRESH_TOKEN,
        primaryCalendar: 'yeshua7733@gmail.com',
        ownCalendars: ['yeshua7733@gmail.com'],
        spouseCalendars: [
          'zhendos13@gmail.com',
          'raziel@internety.co.il'
        ],
        isAdmin: false
      }
    });

    res.status(200).json({
      success: true,
      message: 'Users seeded successfully',
      users: [
        { id: raziel.id, name: raziel.name, isAdmin: raziel.isAdmin },
        { id: yeshua.id, name: yeshua.name, isAdmin: yeshua.isAdmin }
      ]
    });
  } catch (error) {
    console.error('Seeding failed:', error);
    res.status(500).json({ error: 'Seeding failed', details: error });
  } finally {
    await prisma.$disconnect();
  }
}
