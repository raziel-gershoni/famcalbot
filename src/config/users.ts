import dotenv from 'dotenv';
import { UserConfig } from '../types';

// Load environment variables first
dotenv.config();

// Shared calendar IDs for both users
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

// Shared Google refresh token (since all calendars are from one account)
const SHARED_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';

// All configured users
const allUsers: UserConfig[] = [
  {
    telegramId: 762715667,
    name: 'Raziel',
    hebrewName: 'רזיאל',
    gender: 'male' as const,
    spouseName: 'Yeshua',
    spouseHebrewName: 'ישועה',
    spouseGender: 'female' as const,
    location: process.env.WEATHER_LOCATION || 'Harish, Israel',
    calendars: SHARED_CALENDARS,
    googleRefreshToken: SHARED_REFRESH_TOKEN,
    primaryCalendar: 'zhendos13@gmail.com',  // Main personal calendar
    ownCalendars: [
      'zhendos13@gmail.com',      // Personal calendar
      'raziel@internety.co.il'     // Work calendar
    ],
    spouseCalendars: ['yeshua7733@gmail.com'],
  },
  {
    telegramId: 721483494,
    name: 'Yeshua',
    hebrewName: 'ישועה',
    gender: 'female' as const,
    spouseName: 'Raziel',
    spouseHebrewName: 'רזיאל',
    spouseGender: 'male' as const,
    location: process.env.WEATHER_LOCATION || 'Harish, Israel',
    calendars: SHARED_CALENDARS,
    googleRefreshToken: SHARED_REFRESH_TOKEN,
    primaryCalendar: 'yeshua7733@gmail.com',
    ownCalendars: ['yeshua7733@gmail.com'],
    spouseCalendars: [
      'zhendos13@gmail.com',      // Raziel's personal
      'raziel@internety.co.il'     // Raziel's work
    ],
  },
];

/**
 * Get active users based on NODE_ENV
 * In development mode, only returns the first user (for debugging)
 * In production, returns all users
 */
export const users: UserConfig[] =
  process.env.NODE_ENV === 'development'
    ? [allUsers[0]]  // Only Raziel in development
    : allUsers;      // All users in production

// Helper to get user by Telegram ID
export function getUserByTelegramId(telegramId: number): UserConfig | undefined {
  return allUsers.find(user => user.telegramId === telegramId);
}

// Get all whitelisted Telegram IDs (always includes all users for security)
export function getWhitelistedIds(): number[] {
  return allUsers.map(user => user.telegramId);
}
