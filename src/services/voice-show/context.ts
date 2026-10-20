/**
 * Builds the show writer's context from the user: who is listening, and the family
 * the hosts may mention, with genders where the calendars record them.
 */

import type { CalendarAssignment, UserConfig } from '../../types';
import type { ShowPerson, ShowPromptContext } from '../../prompts/voice-show/types';
import type { ShowKind } from './types';
import { captureError } from '../../lib/error-capture';

/**
 * @param calendars - The user's resolved calendars (resolveShowCalendars); without them, the
 *   Google choices on the user row.
 */
export function buildShowContext(
  summary: string,
  user: UserConfig,
  kind: ShowKind,
  isNextWeek = false,
  calendars: CalendarAssignment[] = user.calendarAssignments ?? [],
): ShowPromptContext {
  const spouse = calendars.find(cal => cal.labels.includes('spouse') && cal.personName?.trim());

  // A kid can have several calendars; name each kid once.
  const kids: ShowPerson[] = [];
  const seen = new Set<string>();
  for (const cal of calendars) {
    const name = cal.personName?.trim();
    if (!cal.labels.includes('kids') || !name || seen.has(name)) continue;
    seen.add(name);
    kids.push({ name, gender: cal.personGender });
  }

  return {
    kind,
    summary,
    locale: user.language || 'en',
    listener: { name: user.name, gender: user.gender === 'female' ? 'female' : 'male' },
    spouse: spouse ? { name: spouse.personName!.trim(), gender: spouse.personGender } : undefined,
    kids,
    hasKidsCalendars: calendars.some(cal => cal.labels.includes('kids')),
    culture: user.culture,
    globalRules: user.globalRules,
    isNextWeek: kind === 'weekly' ? isNextWeek : undefined,
  };
}

/**
 * The user's calendars, which name the partner and the kids: the union of FamCal and the Google
 * choices ("Google as a connection"), for everyone. Undefined when the lookup fails: the show
 * then goes on with the Google choices on the user row rather than not at all.
 */
export async function resolveShowCalendars(user: UserConfig): Promise<CalendarAssignment[] | undefined> {
  try {
    const { getCalendarAssignmentsForUser } = await import('../calendar-provider/user-calendars');
    return await getCalendarAssignmentsForUser(user);
  } catch (err) {
    console.warn(`[VoiceShow] Could not resolve calendars for user ${user.id}:`, err);
    captureError(err, 'voice-show-calendars', { user_id: user.id }, 'warning');
    return undefined;
  }
}
