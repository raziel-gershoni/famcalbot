/**
 * Shared types for Calendar Summary Prompts
 */

export interface SummaryPromptData {
  userName: string;
  userEnglishName: string;
  userGender: 'male' | 'female';
  hasSpouseCalendar: boolean; // True if spouse calendar exists (has events)
  spouseName?: string;        // Optional - use "Spouse" fallback if missing
  spouseEnglishName?: string; // Optional
  spouseGender?: 'male' | 'female'; // Optional
  currentGregorianDate: string;
  summaryGregorianDate: string;
  summaryHebrewDate: string;
  holidays?: string[];
  greeting: string;
  userEventsText: string;
  spouseEventsText: string;
  otherEventsText: string;
  weatherSummary?: string;  // AI-generated weather summary with tips
  weekLookahead?: string;   // Pre-formatted week lookahead text (for tomorrow summaries)
  language?: string;  // Target language code (e.g., "he", "en", "ru")
  // Fields for public release
  culture?: string;  // 'jewish' | 'default'
  globalRules?: string[];  // User's global rules (max 3)
  calendarRules?: { calendarName: string; rule: string }[];  // Per-calendar rules
  hasKidsCalendars?: boolean;  // Whether user has kids calendars configured
}
