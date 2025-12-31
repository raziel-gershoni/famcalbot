/**
 * Shared types for Week Lookahead Prompts
 */

export interface LookaheadEventData {
  time: string;             // "14:30" or "All day"
  summary: string;
  calendarName: string;
  calendarLabel: 'yours' | 'spouse' | 'kids';
  isRecurring: boolean;
  recurrenceType?: 'weekly' | 'monthly' | 'yearly';
}

export interface LookaheadDayData {
  dayLabel: string;           // "Thursday, Jan 2" or "יום ה׳, 2 בינואר"
  hebrewDate?: string;        // Optional Hebrew date for this day
  daysFromNow: number;
  relativeLabel: string;      // "Today", "Tomorrow", "In 3 days"
  events: LookaheadEventData[];
}

export interface WeekLookaheadPromptData {
  userName: string;
  userEnglishName?: string;
  userGender?: 'male' | 'female';
  hasSpouseCalendar: boolean;
  spouseName?: string;
  culture?: string;  // 'jewish' | 'default'
  language: string;  // 'en' | 'he' | 'ru'

  // Date context
  todayGregorian: string;     // "Wednesday, January 1, 2026"
  todayHebrew?: string;       // "כ״ח בכסלו תשפ״ה"
  weekEndGregorian: string;   // "Sunday, January 5, 2026"
  weekEndHebrew?: string;

  // Events grouped by day
  eventsByDay: LookaheadDayData[];

  // User context
  globalRules?: string[];
  hasKidsCalendars: boolean;

  // Totals for quick reference
  totalEvents: number;
  totalDays: number;
}
