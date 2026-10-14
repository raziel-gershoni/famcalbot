/**
 * Builds the show writer's context from the user: who is listening, and the family
 * the hosts may mention, with genders where the calendars record them.
 */

import type { CalendarAssignment, UserConfig } from '../../types';
import type { ShowPerson, ShowPromptContext } from '../../prompts/voice-show/types';
import type { ShowKind } from './types';

/**
 * @param calendars - The user's resolved calendars (resolveShowCalendars); a Google
 *   user's are the ones on the user row.
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
 * A NATIVE user's calendars, which name the partner and the kids; they are not on the
 * user row. Undefined for a Google user, and when the lookup fails: the show then goes
 * on without the family's names rather than not at all.
 */
export async function resolveShowCalendars(user: UserConfig): Promise<CalendarAssignment[] | undefined> {
  if (user.calendarSource !== 'NATIVE') return undefined;
  try {
    const { getCalendarAssignmentsForUser } = await import('../calendar-provider/user-calendars');
    return await getCalendarAssignmentsForUser(user);
  } catch (err) {
    console.warn(`[VoiceShow] Could not resolve calendars for user ${user.id}:`, err);
    return undefined;
  }
}
