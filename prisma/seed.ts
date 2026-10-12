import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

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
      englishName: 'Raziel',
      gender: 'male',
      culture: 'jewish',
      location: 'Harish, Israel',
      language: 'he',
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
          color: '#ec4899',
          // Spouse metadata stored in calendar assignment
          personName: 'Yeshua',
          personEnglishName: 'Yeshua',
          personGender: 'female'
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
      englishName: 'Yeshua',
      gender: 'female',
      culture: 'jewish',
      location: 'Harish, Israel',
      language: 'he',
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
          color: '#ec4899',
          // Spouse metadata stored in calendar assignment
          personName: 'Raziel',
          personEnglishName: 'Raziel',
          personGender: 'male'
        },
        {
          calendarId: 'raziel@internety.co.il',
          labels: ['spouse'],
          name: 'Spouse Work',
          color: '#ec4899'
          // Note: spouse metadata only needed on one calendar
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
