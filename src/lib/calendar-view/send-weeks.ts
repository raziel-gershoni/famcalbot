// The Send sheet's week ranges (spec §7.2, Plan D Ruling 4): the days the bot's "This
// week" and "Next week" summaries cover, worked out on the client from the range
// response's weekStart, today, and the user's always-7-days setting. Client-safe and
// pure; the rules are src/utils/locale-rules.ts's nextWeekBoundary and nextWeekBoundaries
// (a smoke holds the two together), which can't be imported here because they pull in
// server modules.

import { addDaysToKey } from './store';
import type { DayKey, WeekStart } from './types';

export interface DaySpan {
  first: DayKey;
  last: DayKey;
}

/** Sunday 0 … Saturday 6, in UTC arithmetic on the key. */
function weekday(day: DayKey): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/**
 * This week: today through the day before the next week starts (today plus 7 with
 * "always 7 days"). Next week: the next week start after today (a week on when today is
 * one), through 6 days later. `always7` undefined means unknown: no range for this week.
 */
export function sendWeekRanges(today: DayKey, weekStart: WeekStart, always7: boolean | undefined): { thisWeek: DaySpan | null; nextWeek: DaySpan } {
  const next = addDaysToKey(today, ((weekStart - weekday(today) + 7) % 7) || 7);
  const untilBoundary = always7 ? 7 : (((weekStart + 6) % 7) - weekday(today) + 7) % 7;
  return {
    thisWeek: always7 === undefined ? null : { first: today, last: addDaysToKey(today, untilBoundary) },
    nextWeek: { first: next, last: addDaysToKey(next, 6) },
  };
}
