import { User as PrismaUser } from '@prisma/client';
import { safeDecrypt } from './utils/encryption';

// Calendar category labels
export type CalendarLabel = 'primary' | 'yours' | 'spouse' | 'kids' | 'birthdays';

// Single calendar assignment with metadata
export interface CalendarAssignment {
  calendarId: string;
  labels: CalendarLabel[];
  name: string;
  color: string;
}

// Prisma User type with BigInt converted to number for compatibility
export type UserConfig = Omit<PrismaUser, 'telegramId' | 'whatsappPhone' | 'gender' | 'spouseGender' | 'calendarAssignments'> & {
  telegramId: number;  // Convert BigInt to number
  whatsappPhone?: string | null;  // Make optional and allow null
  messagingPlatform?: 'telegram' | 'whatsapp' | 'all';
  language?: string;
  gender: 'male' | 'female';  // Narrow type for type safety
  spouseGender: 'male' | 'female';  // Narrow type for type safety
  calendarAssignments?: CalendarAssignment[];  // Parsed from JSON
};

// Helper to convert Prisma User to UserConfig (with decryption)
export function convertPrismaUserToConfig(user: PrismaUser): UserConfig {
  return {
    ...user,
    telegramId: Number(user.telegramId),
    whatsappPhone: user.whatsappPhone ?? undefined,
    messagingPlatform: user.messagingPlatform as 'telegram' | 'whatsapp' | 'all',
    language: user.language ?? undefined,
    gender: user.gender as 'male' | 'female',
    spouseGender: user.spouseGender as 'male' | 'female',
    googleRefreshToken: safeDecrypt(user.googleRefreshToken), // Decrypt OAuth token
    calendarAssignments: user.calendarAssignments
      ? (user.calendarAssignments as any as CalendarAssignment[])
      : undefined
  };
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  calendarName: string;
  calendarId: string;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface WeatherData {
  location: string;  // "Harish, Israel"
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    weatherCode: number;
    windSpeed: number;
    uvIndex: number;
  };
  today: {
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
    sunrise: string;
    sunset: string;
    uvIndexMax: number;
  };
  tomorrow?: {
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
    sunrise: string;
    sunset: string;
    uvIndexMax: number;
  };
  hourly?: {
    time: string[];
    temperature: number[];
    precipitation_probability: number[];
    precipitation: number[];
    weatherCode: number[];
    windSpeed: number[];
  };
  daily?: Array<{
    date: string;
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
    sunrise: string;
    sunset: string;
    uvIndexMax: number;
  }>;
  summary?: string;  // AI-generated summary
}
