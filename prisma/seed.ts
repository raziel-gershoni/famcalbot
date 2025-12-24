import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

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

  // User 1: Raziel
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
      googleRefreshToken: SHARED_REFRESH_TOKEN,
      calendarAssignments: [
        {
          calendarId: 'zhendos13@gmail.com',
          labels: ['primary', 'yours'],
          name: 'Primary Calendar',
          color: '#4285f4'
        },
        {
          calendarId: 'raziel@internety.co.il',
          labels: ['yours'],
          name: 'Work Calendar',
          color: '#8b5cf6'
        },
        {
          calendarId: 'yeshua7733@gmail.com',
          labels: ['spouse'],
          name: 'Spouse Calendar',
          color: '#ec4899'
        }
      ]
    }
  });

  console.log('✅ Created user: Raziel (ID:', raziel.id, ')');

  // User 2: Yeshua
  const yeshua = await prisma.user.upsert({
    where: { telegramId: BigInt(721483494) },
    update: {},
    create: {
      telegramId: BigInt(721483494),
      whatsappPhone: null,  // Telegram only for now
      messagingPlatform: 'telegram',
      name: 'Yeshua',
      hebrewName: 'ישועה',
      gender: 'female',
      spouseName: 'Raziel',
      spouseHebrewName: 'רזיאל',
      spouseGender: 'male',
      location: 'Harish, Israel',
      language: 'Hebrew',
      googleRefreshToken: SHARED_REFRESH_TOKEN,
      calendarAssignments: [
        {
          calendarId: 'yeshua7733@gmail.com',
          labels: ['primary', 'yours'],
          name: 'Primary Calendar',
          color: '#4285f4'
        },
        {
          calendarId: 'zhendos13@gmail.com',
          labels: ['spouse'],
          name: 'Spouse Calendar',
          color: '#ec4899'
        },
        {
          calendarId: 'raziel@internety.co.il',
          labels: ['spouse'],
          name: 'Spouse Work',
          color: '#ec4899'
        }
      ]
    }
  });

  console.log('✅ Created user: Yeshua (ID:', yeshua.id, ')');

  console.log('🎉 Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
