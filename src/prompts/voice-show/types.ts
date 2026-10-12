/**
 * Context for the two-host show writer prompts.
 */

import type { ShowKind } from '../../services/voice-show/types';

export interface ShowPerson {
  name: string;
  /** Unknown gender means: name plus neutral phrasing. */
  gender?: 'male' | 'female';
}

export interface ShowPromptContext {
  kind: ShowKind;
  /** The text summary exactly as the user received it (Telegram HTML). */
  summary: string;
  /** Locale code: 'he', 'en' or 'ru'. */
  locale: string;
  listener: { name: string; gender: 'male' | 'female' };
  spouse?: ShowPerson;
  /** Kids with a name on their calendar. */
  kids: ShowPerson[];
  /** Kids calendars exist, named or not. */
  hasKidsCalendars: boolean;
  /** 'jewish' | 'default' */
  culture?: string;
  globalRules?: string[];
  /** Weekly only: next week rather than this one. */
  isNextWeek?: boolean;
}
