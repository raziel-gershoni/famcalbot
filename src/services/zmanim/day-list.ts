/**
 * A day's zmanim list at a place, with no person in it: the home's sun sheet (reminder-times.ts zmanDayList, at the
 * person's place) and the public zmanim pages (at a listed city) both read this one function, so for the same place,
 * height, community and day they show the same rows. Spec: docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1.
 *
 *   zmanDayForPlace   the rows and the halachic hours of a civil day at a place
 *   instantAt         a reminder's rule as an instant at a place on a day, through the memo (the one way a list reads a zman)
 *   zmanRows          a set's zmanim on a day as list rows, each from instantAt
 *   lightsCandles     whether a day lights candles by the rest-day blocks (the eve of one, or a Friday inside one)
 *
 * An answer is remembered (keyed by the place, the community that counts it, the day and the rule) in a memo: the
 * process's own by default (on globalThis: Next 16 gives the scheduler and the routes separate module instances), so a
 * pass that ticks every minute does not count the same zman again; a caller that must not touch it (a public page,
 * which a crawler could open by the thousand) passes its own.
 *
 * Pure: no database, Redis, network or React (smoke-zmanim pins its imports). Server only, as compute.ts is.
 */

import { halachicHourMs, isYomTovAt, restDayBlocks, zmanInstant, type Place, type RestDayBlock } from './compute';
import { ZMAN_KEYS, communityCounting, zmanimOfSet, zmanimSet, type ZmanKey, type ZmanimCommunity } from './sets';
import { asZmanSpec } from './spec';
import type { ZmanSpecValue } from '../../lib/calendar-view/zman-spec';
import type { ZmanimListResponse, ZmanimListRow } from '../../lib/calendar-view/zmanim-list';
import { addDaysToDate, startOfLocalDay } from '../../utils/day-events';

/** Answers by key: epoch ms, or null where the zman does not exist that day. */
export type ZmanMemo = Map<string, number | null>;

/** A day's list without the person's place label (zmanDayList adds it for the sun sheet). */
export type ZmanDayList = Omit<ZmanimListResponse, 'place'>;

/** `memo`: where answers are kept (the process's by default). `quiet`: no log for a zman the sun does not make (compute.ts ZmanOptions). */
export type ZmanListOptions = { memo?: ZmanMemo; quiet?: boolean };

/** The answers kept in a memo; past this it starts over (a few thousand small entries, never a leak). */
const MAX_ANSWERS = 5000;

const shared = globalThis as { __zmanReminderAnswers?: ZmanMemo };
const answers: ZmanMemo = (shared.__zmanReminderAnswers ??= new Map());

/** Smoke scripts only: back to a fresh process. */
export function __resetZmanClockForTests(): void {
  answers.clear();
}

/** A reminder's rule as an instant at the place on `day`, counted by the reader's community (or the nearest set that has the zman). */
export function instantAt(place: Place, community: ZmanimCommunity, day: string, spec: ZmanSpecValue, options: ZmanListOptions = {}): Date | null {
  const valid = asZmanSpec(spec);
  if (!valid) {
    console.warn(`[zmanim] a reminder's rule is not one this build knows (${JSON.stringify(spec)}): no time`);
    return null;
  }
  // A zman the reader's own set lacks is counted by the nearest set that has it (sets.ts communityCounting).
  const counting = 'zman' in valid ? communityCounting(valid.zman, community) : community;
  if (!counting) {
    console.warn(`[zmanim] no set has ${'zman' in valid ? valid.zman : 'this rule'}: no time`);
    return null;
  }
  const memo = options.memo ?? answers;
  const key = [place.latitude, place.longitude, place.elevationM ?? '', place.timeZone, counting, day, JSON.stringify(valid)].join('|');
  if (memo.has(key)) {
    const known = memo.get(key) ?? null;
    return known === null ? null : new Date(known);
  }
  const at = zmanInstant(day, valid, place, counting, { quiet: options.quiet });
  if (memo.size >= MAX_ANSWERS) memo.clear();
  memo.set(key, at ? at.getTime() : null);
  return at;
}

/**
 * The zmanim of a community's set on a day, as a list reads them: each key, the opinion the set names it with, and its
 * instant as an ISO string (null where the sun does not make it that day, or where there is no place). The editor's
 * block and the day list both read this one list, so the instants come from instantAt and nothing else.
 */
export function zmanRows(place: Place | null, community: ZmanimCommunity, day: string, keys: readonly ZmanKey[], options: ZmanListOptions = {}): ZmanimListRow[] {
  const set = zmanimSet(community);
  return keys.map((key) => ({
    key,
    opinion: set.zmanim[key]?.opinion ?? null,
    at: place ? (instantAt(place, community, day, { zman: key, offsetMin: 0 }, options)?.toISOString() ?? null) : null,
  }));
}

/** The weekday of a civil date (0 = Sunday), the same on a server in any zone. */
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * Whether `day` lights candles by the rest-day blocks: the eve of a block, or a Friday inside a longer one (a Yom Tov on a
 * Friday: the Shabbat's candles). By the calendar alone, so an eve whose block the sun gives no end (the far north in
 * summer) still lights them. The day list's candle row and the reminder's "candle lighting" day (reminder-times.ts
 * candleLightingDays) both ask it.
 */
export function lightsCandles(blocks: readonly RestDayBlock[], day: string): boolean {
  const friday = weekdayOf(day) === 5;
  return blocks.some((block) => block.eve === day || (friday && block.eve < day && day < block.last));
}

/** The zmanim a day's list does not take from the set's own order: the rest-day blocks give them. */
const FROM_WINDOWS: readonly ZmanKey[] = ['CANDLE_LIGHTING', 'SHABBAT_ENDS'];

/** The window rows that stand where a set zman does in the order of the day: every kind of end, and the candles "not before", stand where the end of Shabbat does. */
const STANDS_AT: Record<string, ZmanKey> = { YOM_TOV_ENDS: 'SHABBAT_ENDS', SHABBAT_YOM_TOV_ENDS: 'SHABBAT_ENDS', CANDLE_LIGHTING_NOT_BEFORE: 'SHABBAT_ENDS' };

/** Where a row stands in the day: its key's place in the order of the day. */
const orderOf = (key: string): number => ZMAN_KEYS.indexOf((STANDS_AT[key] ?? key) as ZmanKey);

/**
 * `day` (a civil date in the place's zone) at the place under the community's set.
 *   rows   the set's zmanim in the order of the day, and among them the rows of the Shabbat and Yom Tov blocks
 *          (restDayBlocks says on which day each falls; the pause's windows are the complete ones; WINDOW_ROW_KEYS names
 *          them). The pause begins at the eve's sunset, the set's plain sunset row (SHKIA), and ends at the end row; the
 *          candle lighting is not the window's edge, it is the day's own time, 20 minutes before that sunset:
 *          - the candle lighting on the day a block begins (the eve) and on every Friday inside one (lightsCandles):
 *            that day's own time, the Shabbat's candles;
 *          - on any other rest day inside a block and before its last (the Saturday before a Yom Tov on Sunday, the
 *            first day of a two-day Yom Tov) the candle lighting "not before" that day's own end;
 *          - on the day a block ends, its end: of Shabbat (a Saturday), of Shabbat and Yom Tov together (a Saturday that
 *            is also a Yom Tov) or of Yom Tov (any other day); null (a dash) where the sun makes no end that night.
 *          The days come from the calendar and only the times from the sun, so where the sun makes no end (the far
 *          north in summer) the eve still has its candle lighting and the last day its end row, with no time.
 *   hours  the halachic hour: the GRA's and the Magen Avraham's, or the Baal HaTanya's for Chabad.
 */
export function zmanDayForPlace(place: Place, community: ZmanimCommunity, day: string, options: ZmanListOptions = {}): ZmanDayList {
  const zone = place.timeZone;
  const set = zmanimSet(community);

  const rows = zmanRows(place, community, day, zmanimOfSet(community).filter((key) => !FROM_WINDOWS.includes(key)), options);
  const blocks = restDayBlocks({ from: startOfLocalDay(day, zone), to: startOfLocalDay(addDaysToDate(day, 1), zone) }, place, community);
  const weekday = weekdayOf(day);
  /** The day's own instant of a zman, as a row carries it (the set's rows come from the same instantAt). */
  const ownAt = (zman: ZmanKey): string | null => instantAt(place, community, day, { zman, offsetMin: 0 }, options)?.toISOString() ?? null;
  // The block begins at the eve's sunset (a row of the set, in the rows above): the candle lighting is the eve's own time, not the start.
  if (lightsCandles(blocks, day)) rows.push({ key: 'CANDLE_LIGHTING', opinion: null, at: ownAt('CANDLE_LIGHTING') });
  // A rest day inside a block that is not its last nor a Friday: the second night's candles, after the day's own end.
  else if (blocks.some((block) => block.eve < day && day < block.last)) rows.push({ key: 'CANDLE_LIGHTING_NOT_BEFORE', opinion: null, at: ownAt('SHABBAT_ENDS') });
  const ending = blocks.find((block) => block.last === day);
  if (ending) {
    const key = weekday !== 6 ? 'YOM_TOV_ENDS' : isYomTovAt(day, place) ? 'SHABBAT_YOM_TOV_ENDS' : 'SHABBAT_ENDS';
    rows.push({ key, opinion: null, at: ending.end?.toISOString() ?? null });
  }
  rows.sort((a, b) => orderOf(a.key) - orderOf(b.key));

  const hour = halachicHourMs(day, place, community);
  const hours: ZmanDayList['hours'] = [{ opinion: set.zmanim.SOF_SHMA_GRA?.opinion ?? 'gra', ms: hour.day }];
  if (set.mgaDay) hours.push({ opinion: 'mga', ms: hour.mga });

  return { community, day, tz: zone, rows, hours };
}
