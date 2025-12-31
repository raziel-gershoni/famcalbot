/**
 * Voice Condenser Types
 * Context passed to voice condenser prompts for intelligent condensing
 */

export interface VoiceCondenserContext {
  /** The full summary text to condense */
  summary: string;

  /** Locale code: 'en' | 'he' | 'ru' */
  locale: string;

  // Family structure
  /** User's name for personalization */
  userName: string;

  /** Spouse's name (if has spouse calendar) */
  spouseName?: string;

  /** Whether user has kids calendars */
  hasKidsCalendars: boolean;

  // Preferences
  /** Culture setting: 'jewish' | 'default' */
  culture?: string;

  /** User's global rules for voice prioritization */
  globalRules?: string[];
}
