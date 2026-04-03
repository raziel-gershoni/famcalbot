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
  // NEW: For spouse calendar only
  personName?: string;        // Spouse name in user's language
  personEnglishName?: string; // Spouse English name (optional)
  personGender?: 'male' | 'female';
  // NEW: Rules for any calendar (max 1 per calendar)
  rules?: string[];
}

// Prisma User type with BigInt converted to number for compatibility
export type UserConfig = Omit<PrismaUser, 'telegramId' | 'whatsappPhone' | 'whatsappBsuid' | 'gender' | 'calendarAssignments' | 'defaultReminderMinutes'> & {
  telegramId: number | null;  // Convert BigInt to number (null for WhatsApp-only users)
  whatsappPhone?: string | null;
  whatsappBsuid?: string | null;  // Make optional and allow null
  messagingPlatform?: 'telegram' | 'whatsapp' | 'all';
  language?: string;
  gender: 'male' | 'female';  // Narrow type for type safety
  calendarAssignments?: CalendarAssignment[];  // Parsed from JSON
  culture?: string;
  locationForced?: boolean;
  globalRules?: string[];
  textSummaryEnabled?: boolean;
  voiceSummaryEnabled?: boolean;
  voiceInputEnabled?: boolean;
  voicePreference?: string;
  weatherEnabled?: boolean;
  includeWeeklyInLookahead?: boolean;
  includeLookaheadInTomorrow?: boolean;
  lookaheadAlways7Days?: boolean;
  remindersEnabled?: boolean;
  defaultReminderMinutes?: number;
  pickupRemindersEnabled?: boolean;
  reminderStartAt?: Date | null;
};

// Helper to convert Prisma User to UserConfig (with decryption)
export function convertPrismaUserToConfig(user: PrismaUser): UserConfig {
  return {
    ...user,
    telegramId: user.telegramId !== null ? Number(user.telegramId) : null,
    whatsappPhone: user.whatsappPhone ?? undefined,
    whatsappBsuid: user.whatsappBsuid ?? undefined,
    messagingPlatform: user.messagingPlatform as 'telegram' | 'whatsapp' | 'all',
    gender: user.gender as 'male' | 'female',
    googleRefreshToken: safeDecrypt(user.googleRefreshToken), // Decrypt OAuth token
    calendarAssignments: user.calendarAssignments
      ? (user.calendarAssignments as unknown as CalendarAssignment[])
      : undefined,
    culture: user.culture,
    locationForced: user.locationForced,
    globalRules: user.globalRules,
    textSummaryEnabled: user.textSummaryEnabled,
    voiceSummaryEnabled: user.voiceSummaryEnabled,
    voiceInputEnabled: user.voiceInputEnabled,
    voicePreference: user.voicePreference,
    weatherEnabled: user.weatherEnabled,
    includeWeeklyInLookahead: user.includeWeeklyInLookahead,
    includeLookaheadInTomorrow: user.includeLookaheadInTomorrow,
    lookaheadAlways7Days: user.lookaheadAlways7Days,
    remindersEnabled: user.remindersEnabled,
    defaultReminderMinutes: user.defaultReminderMinutes !== null ? user.defaultReminderMinutes : undefined,
    pickupRemindersEnabled: user.pickupRemindersEnabled,
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
  // For recurrence detection
  eventType?: string;         // 'default' | 'birthday' | etc
  recurringEventId?: string;  // ID of master event if this is a recurring instance
  // For reminders
  eventId?: string;           // Unique event ID for tracking reminders
  reminders?: {
    useDefault: boolean;
    overrides?: Array<{ method: string; minutes: number }>;
  };
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
    windDirection: number;
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
    humidity: number[];
    windDirection: number[];
    visibility?: number[];
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
    windSpeedMax: number;
    windDirection: number;
    humidity: number;
  }>;
  summary?: string;  // AI-generated summary
}

export interface AirQualityData {
  hourly: {
    time: string[];
    pm10: (number | null)[];
    pm2_5: (number | null)[];
    dust: (number | null)[];
  };
}
