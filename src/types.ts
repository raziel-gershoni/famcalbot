import { User as PrismaUser } from '@prisma/client';
import { readStoredToken } from './utils/encryption';
import type { ZmanSpecValue } from './lib/calendar-view/zman-spec';
import { pushDeviceCountOf } from './services/web-push/reach';
import { voiceFormatOf, type ShowFormat } from './services/voice-show/types';

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
export type UserConfig = Omit<PrismaUser, 'telegramId' | 'whatsappPhone' | 'whatsappBsuid' | 'gender' | 'voiceFormat' | 'calendarAssignments' | 'defaultReminderMinutes'> & {
  telegramId: number | null;  // Convert BigInt to number (null for WhatsApp-only users)
  whatsappPhone?: string | null;
  whatsappBsuid?: string | null;  // Make optional and allow null
  messagingPlatform?: 'telegram' | 'whatsapp' | 'all';
  language?: string;
  gender: 'male' | 'female';  // Narrow type for type safety
  voiceFormat: ShowFormat;  // Narrowed by voiceFormatOf: anything but 'calm' is the show
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
  /**
   * Devices with browser notifications on (6c-2), set only when the row was read with PUSH_DEVICE_COUNT
   * (getUserById); undefined otherwise, which the reminder gates read as none.
   */
  pushDeviceCount?: number;
};

// Helper to convert Prisma User to UserConfig (with decryption)
export function convertPrismaUserToConfig(user: PrismaUser & { _count?: { pushDevices?: number } }): UserConfig {
  // A row read with PUSH_DEVICE_COUNT carries its devices' count; the config holds the number, never the _count object
  const { _count, ...row } = user;
  return {
    ...row,
    ...(_count !== undefined ? { pushDeviceCount: pushDeviceCountOf({ _count }) } : {}),
    telegramId: user.telegramId !== null ? Number(user.telegramId) : null,
    whatsappPhone: user.whatsappPhone ?? undefined,
    whatsappBsuid: user.whatsappBsuid ?? undefined,
    messagingPlatform: user.messagingPlatform as 'telegram' | 'whatsapp' | 'all',
    gender: user.gender as 'male' | 'female',
    voiceFormat: voiceFormatOf(user),
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

/** A stretch of a day when rain falls, read on the place's clock, and how much falls in it. */
export interface RainSpell {
  /** 'HH:mm': when the first wet step starts. */
  start: string;
  /** 'HH:mm': when the last wet step ends; '24:00' when it runs past the day's midnight. */
  end: string;
  /** Millimetres in the stretch, to one decimal. */
  mm: number;
}

/** What a forecast says of one day, as the place's clock divides the days. */
export interface WeatherDaySummary {
  tempMax: number;
  tempMin: number;
  /** Millimetres of rain (snow as its water) in the day, to one decimal. MET gives no rain chance outside the Nordics. */
  precipitation: number;
  rainHours: RainSpell[];
  weatherCode: number;
  /** 'yyyy-MM-ddTHH:mm' at the place; '' where the sun does not rise (or set) that day. */
  sunrise: string;
  sunset: string;
  /** The clear-sky UV index (MET's), so it reads high on cloudy days. */
  uvIndexMax: number;
}

/** One day of the forecast's list. */
export interface WeatherDay extends Omit<WeatherDaySummary, 'uvIndexMax'> {
  date: string;
  /** The clear-sky UV; null past MET's UV horizon (about 2.5 days ahead). */
  uvIndexMax: number | null;
  windSpeedMax: number;
  windDirection: number;
  humidity: number;
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
  today: WeatherDaySummary;
  tomorrow?: WeatherDaySummary;
  /** MET's steps: hourly for about 2.5 days, then 6-hourly; the times are 'yyyy-MM-ddTHH:mm' at the place. */
  hourly?: {
    time: string[];
    temperature: number[];
    /** Millimetres in the step. */
    precipitation: number[];
    weatherCode: number[];
    windSpeed: number[];
    humidity: number[];
    windDirection: number[];
  };
  /** Up to 9 days, today first. */
  daily?: WeatherDay[];
  summary?: string;  // AI-generated summary
}

/** Copernicus CAMS air quality at the place (air-quality.ts): hourly from today's 00:00 at the place, µg/m³. */
export interface AirQualityData {
  hourly: {
    /** 'yyyy-MM-ddTHH:mm' at the place. */
    time: string[];
    pm10: (number | null)[];
    dust: (number | null)[];
  };
}
