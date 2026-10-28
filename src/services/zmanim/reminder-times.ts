/**
 * The heavy half of the zman clock (reminder-clock.ts is the light one): the person's place and the
 * calculator, behind one function per use. Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 3).
 *
 *   buildZmanClock    the clock the pass, the home and the digests read a reminder's due time from
 *   zmanEditorInfo    what the editor offers: the community's zmanim and today's time of each
 *   candleLightingDays  the days a person lights candles, from the pause's own windows
 *   zmanDayList       the home's sun sheet: a day's zmanim at the person's place, the candle lighting and the end of
 *                     Shabbat or Yom Tov the day earns (the pause's windows), and the length of the halachic hour
 *
 * The one function that turns a zman rule into an instant is compute.ts zmanInstant; everything here only finds the
 * place to count it at: the person's own (saved coordinates, filled once from a place name), else their zone's main
 * city (the pause's fallback, pause-windows.ts), logged once a day per person. A zone with no main city has no place:
 * no clock.
 *
 * A reminder is written under its writer's community but read under each recipient's, and the sets do not hold the same
 * zmanim: a zman the recipient's own set lacks is counted by the nearest set that has it (sets.ts communityCounting) at the
 * recipient's own place and named with that set's opinion, so it is never silent for them.
 *
 * An answer is remembered for the process (on globalThis: Next 16 gives the scheduler and the routes separate
 * module instances), keyed by the place, the community, the day and the rule, so a pass that ticks every minute does
 * not count the same zman again, and a zman that does not exist that day is logged once, not once a tick.
 */

import { ensureUserCoordinates, placeWithHeightRetry, type PlaceUser } from './place';
import { mainCityPlace } from './pause-windows';
import { halachicHourMs, isYomTovAt, shabbatYomTovWindows, zmanInstant, type Place } from './compute';
import { ZMAN_KEYS, communityCounting, isZmanKey, zmanimOfSet, zmanimSet, type ZmanKey, type ZmanimCommunity } from './sets';
import { asZmanSpec, communityOfUser, reminderZmanim } from './spec';
import type { ZmanClock, ZmanSpecValue, ZmanimInfo } from '../../lib/calendar-view/zman-spec';
import type { ZmanimListResponse, ZmanimListRow } from '../../lib/calendar-view/zmanim-list';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import type { ZmanUser } from './reminder-clock';
import { warnOnceADay } from './once';

/** The answers kept; past this the memory starts over (a few thousand small entries, never a leak). */
const MAX_ANSWERS = 5000;

const shared = globalThis as { __zmanReminderAnswers?: Map<string, number | null> };
const answers: Map<string, number | null> = (shared.__zmanReminderAnswers ??= new Map());

/** Smoke scripts only: back to a fresh process. */
export function __resetZmanClockForTests(): void {
  answers.clear();
}

function placeUserOf(user: ZmanUser): PlaceUser {
  return {
    id: user.id,
    location: user.location ?? '',
    latitude: user.latitude ?? null,
    longitude: user.longitude ?? null,
    elevationM: user.elevationM ?? null,
    googleRefreshToken: user.googleRefreshToken,
  };
}

/**
 * Where to count the person's zmanim, and whether that is their own place; null where there is no place at all.
 * `background`: a place name with no coordinates is looked up without being waited for, and the zone's main city
 * stands in for this one call (the editor's info, which must not be held up by it).
 */
async function placeFor(user: ZmanUser, zone: string, background = false): Promise<{ place: Place; source: 'saved' | 'zone' } | null> {
  const placeUser = placeUserOf(user);
  const coordinates = await ensureUserCoordinates(placeUser, { background });
  const own = coordinates ? placeWithHeightRetry(placeUser, coordinates, zone) : null;
  if (own) return { place: own, source: 'saved' };
  const city = mainCityPlace(zone);
  if (!city) {
    warnOnceADay(`${user.id}|nocity`, `[zmanim] user ${user.id} has no usable location and ${zone} has no main city to count zmanim from: reminders by zman are skipped`);
    return null;
  }
  warnOnceADay(`${user.id}|city`, `[zmanim] user ${user.id} has no usable location: counting zmanim by the main city of ${zone}`);
  return { place: city, source: 'zone' };
}

function instantAt(place: Place, community: ZmanimCommunity, day: string, spec: ZmanSpecValue): Date | null {
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
  const key = [place.latitude, place.longitude, place.elevationM ?? '', place.timeZone, counting, day, JSON.stringify(valid)].join('|');
  if (answers.has(key)) {
    const known = answers.get(key) ?? null;
    return known === null ? null : new Date(known);
  }
  const at = zmanInstant(day, valid, place, counting);
  if (answers.size >= MAX_ANSWERS) answers.clear();
  answers.set(key, at ? at.getTime() : null);
  return at;
}

/** The person's zman clock for `zone`, or null where there is no place to count from. */
export async function buildZmanClock(user: ZmanUser, zone: string): Promise<ZmanClock | null> {
  const found = await placeFor(user, zone);
  if (!found) return null;
  const community = communityOfUser(user);
  return {
    source: found.source,
    instant: (day, spec) => instantAt(found.place, community, day, spec),
    // The opinion of the set that counts it for this reader (their own, else the nearest that has it).
    opinion: (zman) => {
      const counting = isZmanKey(zman) ? communityCounting(zman, community) : null;
      return isZmanKey(zman) && counting ? (zmanimSet(counting).zmanim[zman]?.opinion ?? null) : null;
    },
  };
}

/**
 * The zmanim of a community's set on a day, as a list reads them: each key, the opinion the set names it with, and its
 * instant as an ISO string (null where the sun does not make it that day, or where there is no place). The editor's
 * block and the sun sheet both read this one list, so the instants come from instantAt and nothing else.
 */
function zmanRows(place: Place | null, community: ZmanimCommunity, day: string, keys: readonly ZmanKey[]): ZmanimListRow[] {
  const set = zmanimSet(community);
  return keys.map((key) => ({
    key,
    opinion: set.zmanim[key]?.opinion ?? null,
    at: place ? (instantAt(place, community, day, { zman: key, offsetMin: 0 })?.toISOString() ?? null) : null,
  }));
}

/**
 * The civil days (yyyy-MM-dd in `zone`) from `fromDay` for `spanDays` days on which the person lights candles: the day a
 * Shabbat or Yom Tov window begins and, inside a longer window, each Friday (the Shabbat's candles). The windows are the
 * pause's own (shabbatYomTovWindows) and the rule for a day is the sun sheet's (zmanDayList), so a reminder "at candle
 * lighting" made with no day said lands on a day that has candles. Empty where there is no place at all.
 */
export async function candleLightingDays(user: ZmanUser, zone: string, fromDay: string, spanDays: number): Promise<string[]> {
  const found = await placeFor(user, zone);
  if (!found) return [];
  const community = communityOfUser(user);
  const end = addDaysToDate(fromDay, spanDays);
  const windows = shabbatYomTovWindows({ from: startOfLocalDay(fromDay, zone), to: startOfLocalDay(end, zone) }, found.place, community);
  const days: string[] = [];
  for (let day = fromDay; day < end; day = addDaysToDate(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const lit = windows.some(([start, stop]) => {
      const eve = localDate(start, zone);
      return eve === day || (eve < day && day < localDate(stop, zone) && weekday === 5);
    });
    if (lit) days.push(day);
  }
  return days;
}

/** The editor's zmanim block: the community's zmanim a reminder may be set to, and today's time of each. */
export async function zmanEditorInfo(user: ZmanUser, zone: string, today: string): Promise<ZmanimInfo> {
  const community = communityOfUser(user);
  // Not waited for: a person whose place is still to be looked up gets the zone's main city for this load (the next one has theirs).
  const found = await placeFor(user, zone, true);
  const at = (spec: ZmanSpecValue) => (found ? (instantAt(found.place, community, today, spec)?.toISOString() ?? null) : null);
  return {
    community,
    place: found ? found.source : 'none',
    day: today,
    zmanim: zmanRows(found?.place ?? null, community, today, reminderZmanim(community)),
    hours: Array.from({ length: 12 }, (_, i) => at({ halachicHours: i + 1, offsetMin: 0 })),
  };
}

/** The zmanim a day's list does not take from the set's own order: the Shabbat and Yom Tov windows give them (zmanDayList). */
const FROM_WINDOWS: readonly ZmanKey[] = ['CANDLE_LIGHTING', 'SHABBAT_ENDS'];

/** The window rows that stand where a set zman does in the order of the day: every kind of end, and the candles "not before", stand where the end of Shabbat does. */
const STANDS_AT: Record<string, ZmanKey> = { YOM_TOV_ENDS: 'SHABBAT_ENDS', SHABBAT_YOM_TOV_ENDS: 'SHABBAT_ENDS', CANDLE_LIGHTING_NOT_BEFORE: 'SHABBAT_ENDS' };

/** Where a row stands in the day: its key's place in the order of the day. */
const orderOf = (key: string): number => ZMAN_KEYS.indexOf((STANDS_AT[key] ?? key) as ZmanKey);

/**
 * The home's sun sheet: `day` (a civil date in `zone`) at the person's place under their community's set.
 *   rows   the set's zmanim in the order of the day, and among them the rows of the Shabbat and Yom Tov windows
 *          (shabbatYomTovWindows, the pause's own, says on which day each falls; WINDOW_ROW_KEYS names them). The pause
 *          begins at the eve's sunset, the set's plain sunset row (SHKIA), and ends at the end row; the candle lighting is
 *          not the window's edge, it is the day's own time, 20 minutes before that sunset:
 *          - the candle lighting on the day a window begins (the eve) and on every Friday, a Friday inside a longer
 *            window (a Yom Tov on Friday) too: that day's own time, the Shabbat's candles;
 *          - on any other rest day inside a window and before its last (the Saturday before a Yom Tov on Sunday, the
 *            first day of a two-day Yom Tov) the candle lighting "not before" that day's own end;
 *          - on the day a window ends, its end: of Shabbat (a Saturday), of Shabbat and Yom Tov together (a Saturday that
 *            is also a Yom Tov) or of Yom Tov (any other day).
 *   hours  the halachic hour: the GRA's and the Magen Avraham's, or the Baal HaTanya's for Chabad.
 * The place is the editor info's (placeFor in the background): the sheet never waits on a lookup. A person with no place
 * at all (a zone with no main city and no saved location) gets `place: null` and no rows. Server only; the client words it.
 */
export async function zmanDayList(user: ZmanUser, zone: string, day: string): Promise<ZmanimListResponse> {
  const community = communityOfUser(user);
  const found = await placeFor(user, zone, true);
  if (!found) return { day, tz: zone, community, place: null, rows: [], hours: [] };
  const { place } = found;
  const set = zmanimSet(community);

  const rows = zmanRows(place, community, day, zmanimOfSet(community).filter((key) => !FROM_WINDOWS.includes(key)));
  const windows = shabbatYomTovWindows({ from: startOfLocalDay(day, zone), to: startOfLocalDay(addDaysToDate(day, 1), zone) }, place, community);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  /** The day's own instant of a zman, as a row carries it (the set's rows come from the same instantAt). */
  const ownAt = (zman: ZmanKey): string | null => instantAt(place, community, day, { zman, offsetMin: 0 })?.toISOString() ?? null;
  for (const [start, end] of windows) {
    const eve = localDate(start, zone);
    const last = localDate(end, zone);
    // The window begins at the eve's sunset (a row of the set, in the rows above): the candle lighting is the eve's own time, not the start.
    if (eve === day) rows.push({ key: 'CANDLE_LIGHTING', opinion: null, at: ownAt('CANDLE_LIGHTING') });
    else if (eve < day && day < last) {
      // A rest day inside the window that is not its last: the Shabbat's candles on a Friday, else the second night's, after the day's own end.
      rows.push(weekday === 5 ? { key: 'CANDLE_LIGHTING', opinion: null, at: ownAt('CANDLE_LIGHTING') } : { key: 'CANDLE_LIGHTING_NOT_BEFORE', opinion: null, at: ownAt('SHABBAT_ENDS') });
    }
    if (last === day) {
      const key = weekday !== 6 ? 'YOM_TOV_ENDS' : isYomTovAt(day, place) ? 'SHABBAT_YOM_TOV_ENDS' : 'SHABBAT_ENDS';
      rows.push({ key, opinion: null, at: end.toISOString() });
    }
  }
  rows.sort((a, b) => orderOf(a.key) - orderOf(b.key));

  const hour = halachicHourMs(day, place, community);
  const hours: ZmanimListResponse['hours'] = [{ opinion: set.zmanim.SOF_SHMA_GRA?.opinion ?? 'gra', ms: hour.day }];
  if (set.mgaDay) hours.push({ opinion: 'mga', ms: hour.mga });

  return {
    community,
    day,
    tz: zone,
    place: found.source === 'saved' ? { source: 'saved', name: (user.location ?? '').trim() } : { source: 'zone' },
    rows,
    hours,
  };
}
