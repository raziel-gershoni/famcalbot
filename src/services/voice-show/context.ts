/**
 * Builds the show writer's context from the user: who is listening, and the family
 * the hosts may mention, with genders where the calendars record them.
 */

import type { UserConfig } from '../../types';
import type { ShowPerson, ShowPromptContext } from '../../prompts/voice-show/types';
import type { ShowKind } from './types';

export function buildShowContext(summary: string, user: UserConfig, kind: ShowKind, isNextWeek = false): ShowPromptContext {
  const calendars = user.calendarAssignments ?? [];
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
