/**
 * The heavy half of the zman clock (reminder-clock.ts is the light one): the person's place and the
 * calculator, behind one function per use. Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 3).
 *
 *   buildZmanClock    the clock the pass, the home and the digests read a reminder's due time from
 *   zmanEditorInfo    what the editor offers: the community's zmanim and today's time of each
 *   candleLightingDays  the days a person lights candles, from the rest-day blocks (day-list.ts lightsCandles)
 *   zmanDayList       the home's sun sheet: day-list.ts zmanDayForPlace at the person's place, with the place's label
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
 * An answer is remembered for the process (day-list.ts instantAt, on globalThis: Next 16 gives the scheduler and the
 * routes separate module instances), keyed by the place, the community, the day and the rule, so a pass that ticks every
 * minute does not count the same zman again, and a zman that does not exist that day is logged once, not once a tick.
 */

import { ensureUserCoordinates, placeWithHeightRetry, type PlaceUser } from './place';
import { mainCityPlace } from './pause-windows';
import { restDayBlocks, type Place } from './compute';
import { communityCounting, isZmanKey, zmanimSet } from './sets';
import { communityOfUser, reminderZmanim } from './spec';
import { instantAt, lightsCandles, zmanDayForPlace, zmanRows } from './day-list';
import type { ZmanClock, ZmanSpecValue, ZmanimInfo } from '../../lib/calendar-view/zman-spec';
import type { ZmanimListResponse } from '../../lib/calendar-view/zmanim-list';
import { addDaysToDate, startOfLocalDay } from '../../utils/day-events';
import type { ZmanUser } from './reminder-clock';
import { warnOnceADay } from './once';

// Smoke scripts reset the process memo through here, as they did before it moved to day-list.ts.
export { __resetZmanClockForTests } from './day-list';

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
 * The civil days (yyyy-MM-dd in `zone`) from `fromDay` for `spanDays` days on which the person lights candles: the day a
 * Shabbat or Yom Tov block begins and, inside a longer block, each Friday (the Shabbat's candles). The blocks are the
 * pause's own (restDayBlocks; the pause's windows are the complete ones) and the rule for a day is the sun sheet's
 * (day-list.ts lightsCandles), so a reminder "at candle lighting" made with no day said lands on a day that has candles,
 * in the far north too. Empty where there is no place at all.
 */
export async function candleLightingDays(user: ZmanUser, zone: string, fromDay: string, spanDays: number): Promise<string[]> {
  const found = await placeFor(user, zone);
  if (!found) return [];
  const community = communityOfUser(user);
  const end = addDaysToDate(fromDay, spanDays);
  const blocks = restDayBlocks({ from: startOfLocalDay(fromDay, zone), to: startOfLocalDay(end, zone) }, found.place, community);
  const days: string[] = [];
  for (let day = fromDay; day < end; day = addDaysToDate(day, 1)) {
    if (lightsCandles(blocks, day)) days.push(day);
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

/**
 * The home's sun sheet: `day` (a civil date in `zone`) at the person's place under their community's set, as
 * day-list.ts zmanDayForPlace lists it (the rows, among them the Shabbat and Yom Tov rows the rest-day blocks give, and
 * the halachic hours), with where the times are counted. The place is the editor info's (placeFor in the background):
 * the sheet never waits on a lookup. A person with no place at all (a zone with no main city and no saved location) gets
 * `place: null` and no rows. Server only; the client words it.
 */
export async function zmanDayList(user: ZmanUser, zone: string, day: string): Promise<ZmanimListResponse> {
  const community = communityOfUser(user);
  const found = await placeFor(user, zone, true);
  if (!found) return { day, tz: zone, community, place: null, rows: [], hours: [] };
  const list = zmanDayForPlace(found.place, community, day);
  return {
    community: list.community,
    day: list.day,
    tz: list.tz,
    place: found.source === 'saved' ? { source: 'saved', name: (user.location ?? '').trim() } : { source: 'zone' },
    rows: list.rows,
    hours: list.hours,
  };
}
