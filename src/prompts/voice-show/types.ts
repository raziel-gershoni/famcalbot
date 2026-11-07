/**
 * Context for the voice-note writer prompts: the two-host show and the calm single voice.
 */

import type { ShowFormat, ShowKind } from '../../services/voice-show/types';

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
  /** Which voice note: absent or 'show' is the two-host show, 'calm' one presenter (buildShowContext, from User.voiceFormat). */
  format?: ShowFormat;
  /** Calm only: the presenter's gender (CALM_VOICES in voice-generator.ts), which sets how they speak of themself in he and ru. */
  presenterGender?: 'male' | 'female';
}
