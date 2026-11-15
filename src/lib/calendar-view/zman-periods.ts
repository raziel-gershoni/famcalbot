// The home header's period lines (owner 2026-11-15, "the smarter version"): the halachic period the person is in, from
// the zmanim of the sun sheet's own lists (zmanim-list.ts), so the header and the sheet never disagree. A period is
// bounded by zman types: it may have several starts (Mincha: gedola, ketana and each plag of the set; Maariv: nightfall
// and the stricter nightfall) and several ends (Shema: the Magen Avraham's and the Gra's). The latest start that passed
// names Mincha. The header writes the period's name on line 1 and its ends still ahead on line 2 ("until 08:14 · 08:50"),
// short enough for the text column beside the buttons (owner 2026-11-15). The table is the owner's (2026-11-15); a zman
// the person's set does not have is skipped, and a period whose start or ends have no time that day is no period (the
// header then shows the last zman over the next, zmanWindowOf). Shabbat and Yom Tov have no periods of their own.
// Client-safe and pure: plain keys, no import from src/services/zmanim.

import type { ZmanAt, ZmanimListResponse } from './zmanim-list';

export const PERIOD_IDS = ['night', 'alot', 'shema', 'shacharit', 'shacharitLate', 'midday', 'mincha', 'beinHashmashot', 'arvit'] as const;
export type PeriodId = (typeof PERIOD_IDS)[number];

/**
 * A period of a civil day: its starts and ends are zman keys of that day's list, `prev` marks a start in the day
 * before's list (the night runs from the day before's midnight to this day's dawn), and 'shemaEnds' starts Shacharit where
 * the last end of Shema falls.
 */
interface PeriodDef {
  id: PeriodId;
  starts: readonly string[] | 'shemaEnds';
  prev?: true;
  ends: readonly string[];
}

const SHEMA_ENDS = ['SOF_SHMA_MGA', 'SOF_SHMA_GRA'] as const;

/** The owner's table, in the order of a day. */
const PERIODS: readonly PeriodDef[] = [
  { id: 'night', starts: ['CHATZOT_HALAYLA'], prev: true, ends: ['ALOT'] },
  { id: 'alot', starts: ['ALOT'], ends: ['MISHEYAKIR'] },
  { id: 'shema', starts: ['MISHEYAKIR'], ends: SHEMA_ENDS },
  { id: 'shacharit', starts: 'shemaEnds', ends: ['SOF_TFILA'] },
  { id: 'shacharitLate', starts: ['SOF_TFILA'], ends: ['CHATZOT'] },
  { id: 'midday', starts: ['CHATZOT'], ends: ['MINCHA_GEDOLA'] },
  { id: 'mincha', starts: ['MINCHA_GEDOLA', 'MINCHA_KETANA', 'PLAG_HALACHA_BERURA', 'PLAG_YALKUT_YOSEF', 'PLAG_GRA'], ends: ['SHKIA'] },
  { id: 'beinHashmashot', starts: ['SHKIA'], ends: ['TZEIT'] },
  { id: 'arvit', starts: ['TZEIT', 'TZEIT_LECHUMRA'], ends: ['CHATZOT_HALAYLA'] },
];

/** The period the person is in, as the header writes it. */
export interface ZmanPeriod {
  id: PeriodId;
  /** The latest start that has passed (Mincha is named by it). */
  start: ZmanAt;
  /** The earliest end still ahead. */
  end: ZmanAt;
  /** A second end still ahead (Shema's Gra end while the Magen Avraham's is ahead too). */
  otherEnd: ZmanAt | null;
}

type Lists = { yesterday?: ZmanimListResponse | null; today: ZmanimListResponse | null; tomorrow?: ZmanimListResponse | null };
type When = ZmanAt['when'];
type Timed = { zman: ZmanAt; ms: number };

const saved = (list: ZmanimListResponse | null | undefined): list is ZmanimListResponse => !!list && list.place?.source === 'saved';

/** A list's rows that have a time, by key (the first row of a key), tagged with the day the list is for. */
function byKey(list: ZmanimListResponse | null | undefined, when: When): Map<string, Timed> {
  const out = new Map<string, Timed>();
  if (!saved(list)) return out;
  for (const row of list.rows) {
    if (row.at === null || out.has(row.key)) continue;
    const ms = Date.parse(row.at);
    if (Number.isFinite(ms)) out.set(row.key, { zman: { row: { ...row, at: row.at }, tz: list.tz, when }, ms });
  }
  return out;
}

/** Every timed row of the lists, in time order (a tie keeps the lists' and the rows' order). */
function allTimed(lists: Lists): Timed[] {
  const out: Timed[] = [];
  for (const [list, when] of [[lists.yesterday, 'yesterday'], [lists.today, 'today'], [lists.tomorrow, 'tomorrow']] as const) {
    if (!saved(list)) continue;
    for (const row of list.rows) {
      const ms = row.at === null ? Number.NaN : Date.parse(row.at);
      if (row.at !== null && Number.isFinite(ms)) out.push({ zman: { row: { ...row, at: row.at }, tz: list.tz, when }, ms });
    }
  }
  return out.map((t, i) => ({ t, i })).sort((a, b) => a.t.ms - b.t.ms || a.i - b.i).map(({ t }) => t);
}

/** The instant the lines may change next: the earliest row of any list still ahead (null when none is known). */
export function nextZmanChange(lists: Lists, now: number): number | null {
  return allTimed(lists).find((t) => t.ms > now)?.ms ?? null;
}

/** The period of one civil day that holds `now`, or null: its rows in `cur`, the night's start in `prev`. */
function periodOfDay(prev: Map<string, Timed>, cur: Map<string, Timed>, now: number): ZmanPeriod | null {
  for (const def of PERIODS) {
    const ends = def.ends.map((key) => cur.get(key)).filter((t): t is Timed => t !== undefined);
    const shemaEnds = SHEMA_ENDS.map((key) => cur.get(key)).filter((t): t is Timed => t !== undefined);
    const starts =
      def.starts === 'shemaEnds'
        ? shemaEnds.length > 0 ? [shemaEnds.reduce((a, b) => (b.ms > a.ms ? b : a))] : []
        : def.starts.map((key) => (def.prev ? prev : cur).get(key)).filter((t): t is Timed => t !== undefined);
    if (starts.length === 0 || ends.length === 0) continue;
    const passed = starts.filter((t) => t.ms <= now);
    const ahead = ends.filter((t) => t.ms > now).sort((a, b) => a.ms - b.ms);
    if (passed.length === 0 || ahead.length === 0) continue;
    const start = passed.reduce((a, b) => (b.ms >= a.ms ? b : a));
    return { id: def.id, start: start.zman, end: ahead[0].zman, otherEnd: ahead[1]?.zman ?? null };
  }
  return null;
}

/**
 * The period the person is in at `now` (the lists as zmanWindowOf takes them: yesterday's comes before today's first
 * zman, tomorrow's after today's last), or null when none holds it (a list not here yet or failed, no saved place, a
 * zman with no time that day): the header then shows the last zman over the next. Yesterday's Maariv runs on past
 * midnight until its own midnight zman; tomorrow's night starts at today's midnight zman.
 */
export function zmanPeriodOf(lists: Lists, now: number): ZmanPeriod | null {
  if (!saved(lists.today)) return null;
  const yesterday = byKey(lists.yesterday, 'yesterday');
  const today = byKey(lists.today, 'today');
  const tomorrow = byKey(lists.tomorrow, 'tomorrow');
  return periodOfDay(new Map(), yesterday, now) ?? periodOfDay(yesterday, today, now) ?? periodOfDay(today, tomorrow, now);
}
