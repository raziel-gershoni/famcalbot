// The Shabbat and Yom Tov blocks of a span of days, as the zmanim city pages' "ahead" section and the Jewish times API's
// /api/v1/shabbat both list them (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.3): one function, so the
// page and the API cannot drift.
//
// - The blocks are restDayBlocks' (compute.ts): the one under way on `first` (its last day is that day or later, or its
//   end is still after the day's start: a Shabbat that ends at 00:21 on the Sunday in the far north in summer has its last
//   day on the Saturday), and every one whose eve is `until` or before.
// - Each day of a block carries only its window rows (WINDOW_ROW_KEYS), as zmanDayForPlace gives them with the caller's
//   memo and quiet: the candle lighting, the second night's "candle lighting after", the ends.
// - A block is named by its Yom Tov days (holidaysInRange in `lang`, on the Israel schedule when `il`), or, with none, by its
//   chol hamoed or special Shabbat; the parasha is its weekly portion or null.
// - `start` is the eve's sunset and `end` the last day's end, as UTC ISO strings, null where the sun makes none.
//
// Server only (hebcal through compute.ts and the holidays). Pure: no database, Redis, network or clock.

import { WINDOW_ROW_KEYS, type ZmanimListRow } from '../../lib/calendar-view/zmanim-list';
import { holidaysInRange, type Holiday } from '../hebrew-holidays';
import { addDaysToDate, startOfLocalDay } from '../../utils/day-events';
import { restDayBlocks, type Place } from './compute';
import { zmanDayForPlace, type ZmanMemo } from './day-list';
import type { ZmanimCommunity } from './sets';

/** The most rest days in a row (a Yom Tov on Thursday and Friday, then Shabbat): how far a block reaches past its eve. */
export const LONGEST_BLOCK = 3;

/** One day of a block: only its window rows (WINDOW_ROW_KEYS), as the day list gives them. */
export type RestBlockDay = { day: string; rows: ZmanimListRow[] };

export type RestBlockView = {
  /** The day whose sunset begins it (yyyy-MM-dd in the place's zone). */
  eve: string;
  /** Its last rest day. */
  last: string;
  /** The eve's sunset, the block's start (UTC ISO), null where the sun makes none. */
  start: string | null;
  /** The last day's end (UTC ISO), null where the sun makes none. */
  end: string | null;
  /** Its Yom Tov days' names, or, with none, its chol hamoed or special Shabbat's. */
  holidays: Holiday[];
  parasha: Holiday | null;
  days: RestBlockDay[];
  /** The sun does not make its end (the far north in summer): the end row is a dash. */
  endMissing: boolean;
};

/** The days from `first` to `last`, both included. */
export function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let day = first; day <= last; day = addDaysToDate(day, 1)) out.push(day);
  return out;
}

function uniqueByTitle(holidays: Holiday[]): Holiday[] {
  const seen = new Set<string>();
  return holidays.filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)));
}

/** The blocks under way on `first` or beginning by `until` (both yyyy-MM-dd in the place's zone), in order. */
export function restBlocksBetween(place: Place, community: ZmanimCommunity, first: string, until: string, lang: string, il: boolean, memo: ZmanMemo): RestBlockView[] {
  const zone = place.timeZone;
  const windowRows = (day: string): ZmanimListRow[] => zmanDayForPlace(place, community, day, { memo, quiet: true }).rows.filter((row) => WINDOW_ROW_KEYS.includes(row.key));
  const firstStart = startOfLocalDay(first, zone);
  const blocks = restDayBlocks(
    { from: startOfLocalDay(addDaysToDate(first, -LONGEST_BLOCK), zone), to: startOfLocalDay(addDaysToDate(until, LONGEST_BLOCK + 1), zone) },
    place,
    community,
  )
    .filter((block) => (block.last >= first || (block.end !== null && block.end.getTime() > firstStart.getTime())) && block.eve <= until)
    .sort((a, b) => (a.eve < b.eve ? -1 : a.eve > b.eve ? 1 : 0));
  if (blocks.length === 0) return [];
  const holidays = holidaysInRange(blocks[0].eve, blocks[blocks.length - 1].last, lang, { il });
  return blocks.map((block) => {
    const found = daysFrom(addDaysToDate(block.eve, 1), block.last).flatMap((d) => holidays[d] ?? []);
    const chag = found.filter((h) => h.chag);
    return {
      eve: block.eve,
      last: block.last,
      start: block.start?.toISOString() ?? null,
      end: block.end?.toISOString() ?? null,
      holidays: uniqueByTitle(chag.length > 0 ? chag : found.filter((h) => h.kind === 'cholHamoed' || h.kind === 'specialShabbat')),
      parasha: found.find((h) => h.kind === 'parasha') ?? null,
      days: daysFrom(block.eve, block.last).map((d) => ({ day: d, rows: windowRows(d) })),
      endMissing: block.end === null,
    };
  });
}
