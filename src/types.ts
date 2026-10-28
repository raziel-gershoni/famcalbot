import { User as PrismaUser } from '@prisma/client';
import { readStoredToken } from './utils/encryption';
import type { ZmanSpecValue } from './lib/calendar-view/zman-spec';

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
  globalRules?: string[];
  textSummaryEnabled?: boolean;
  voiceSummaryEnabled?: boolean;
  voiceInputEnabled?: boolean;
  weatherEnabled?: boolean;
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
    // Decrypt OAuth token. Never throws: a token neither key opens reads as '' (not
    // connected) and is reported once, so one bad row can't fail getAllUsers or a lookup.
    googleRefreshToken: readStoredToken(user.googleRefreshToken, { userId: user.id, column: 'googleRefreshToken' }),
    calendarAssignments: user.calendarAssignments
      ? (user.calendarAssignments as unknown as CalendarAssignment[])
      : undefined,
    culture: user.culture,
    globalRules: user.globalRules,
    textSummaryEnabled: user.textSummaryEnabled,
    voiceSummaryEnabled: user.voiceSummaryEnabled,
    voiceInputEnabled: user.voiceInputEnabled,
    weatherEnabled: user.weatherEnabled,
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
  eventType?: string;         // 'default' | 'birthday' | 'reminder' (native) | etc
  recurringEventId?: string;  // ID of master event if this is a recurring instance
  // For reminders
  eventId?: string;           // Unique event ID for tracking reminders
  reminders?: {
    useDefault: boolean;
    overrides?: Array<{ method: string; minutes: number }>;
  };
  // A built-in calendar event's own alert (editor upgrades spec §2): its leads in minutes before
  // the start, [] for "None". Present only when the event has one of its own; absent = the user's default.
  alertLeads?: number[];
  // How the event sits on the summary day when it is not wholly inside it. Set by
  // shapeEventsForDay (src/utils/day-events.ts); unset means within the day.
  daySpan?: DaySpan;
  // A built-in calendar reminder as the viewer sees it. Present iff eventType === 'reminder'.
  reminder?: ReminderInfo;
  // A built-in calendar occurrence of a Hebrew yearly series: how many Hebrew years it is after
  // the original one (src/lib/hebrew-anniversary.ts). Absent for the first occurrence and for every other event.
  anniversary?: number;
}

/**
 * A reminder (a NativeEvent of kind REMINDER) from the viewer's side. The owner is the
 * person it is for, worked out on every read (see src/services/native-reminders/ownership.ts).
 */
export interface ReminderInfo {
  ownerIsViewer: boolean;   // the reminder is for the viewer (one of the people it is for)
  creatorIsViewer: boolean; // the viewer created it
  ownerName?: string;       // effective owner's display name, set when the owner is not the viewer
  creatorName?: string;     // creator's display name, set when the creator is not the viewer
  forBoth?: boolean;        // for both partners (the viewer and their partner)
  done?: boolean;           // this occurrence is done for the viewer: the shared doneAt, or (eachMarksDone) their own
  eachMarksDone?: boolean;  // each partner marks their own Done (only while the viewer still has a partner on it)
  partnerDone?: boolean | null; // eachMarksDone: whether the partner has marked theirs; null when the switch is off or there is no partner
  partnerName?: string;     // eachMarksDone: the partner's display name, for "Dana is done"
  snoozed?: boolean;        // this occurrence has snoozedUntil in the future
  open?: boolean;           // set by the summary: due earlier on the summary day, still undone
  openSince?: string;       // 'yyyy-MM-dd' in the viewer's tz, set only on carried-over items
  zmanSpec?: ZmanSpecValue; // a reminder by zman: its rule (the series'); its time is worked out for the viewer's place (reminderDueAt)
  zmanAt?: string;          // the digest: that rule's time today at the viewer's place, an ISO instant, set by shapeDayReminders
}

/**
 * - endsLater: starts on the day, ends after it (22:00 to 02:00 next day)
 * - continues: started before the day, ends on it (a sleepover until 10:00)
 * - spansDay: started before the day and ends after it (day two of a conference)
 */
export type DaySpan = 'endsLater' | 'continues' | 'spansDay';

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
