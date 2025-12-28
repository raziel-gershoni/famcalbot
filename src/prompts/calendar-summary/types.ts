/**
 * Shared types for Calendar Summary Prompts
 */

export interface SummaryPromptData {
  userName: string;
  userEnglishName: string;
  userGender: 'male' | 'female';
  spouseName?: string;        // Optional - only if spouse calendar exists
  spouseEnglishName?: string; // Optional - only if spouse calendar exists
  spouseGender?: 'male' | 'female'; // Optional - only if spouse calendar exists
  currentGregorianDate: string;
  summaryGregorianDate: string;
  summaryHebrewDate: string;
  isRoshChodesh: boolean;
  greeting: string;
  userEventsText: string;
  spouseEventsText: string;
  otherEventsText: string;
  weatherSummary?: string;  // AI-generated weather summary with tips
  language?: string;  // Target language code (e.g., "he", "en", "ru")
  // Fields for public release
  culture?: string;  // 'jewish' | 'default'
  globalRules?: string[];  // User's global rules (max 3)
  calendarRules?: { calendarName: string; rule: string }[];  // Per-calendar rules
  hasKidsCalendars?: boolean;  // Whether user has kids calendars configured
}
