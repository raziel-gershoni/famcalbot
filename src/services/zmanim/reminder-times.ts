/**
 * The heavy half of the zman clock (reminder-clock.ts is the light one): the person's place and the
 * calculator, behind one function per use. Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 3).
 *
 *   buildZmanClock    the clock the pass, the home and the digests read a reminder's due time from
 *   zmanEditorInfo    what the editor offers: the community's zmanim and today's time of each
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
import { zmanInstant, type Place } from './compute';
import { communityCounting, isZmanKey, zmanimSet, type ZmanimCommunity } from './sets';
import { asZmanSpec, communityOfUser, reminderZmanim } from './spec';
import type { ZmanClock, ZmanSpecValue, ZmanimInfo } from '../../lib/calendar-view/zman-spec';
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

/** The editor's zmanim block: the community's zmanim a reminder may be set to, and today's time of each. */
export async function zmanEditorInfo(user: ZmanUser, zone: string, today: string): Promise<ZmanimInfo> {
  const community = communityOfUser(user);
  const set = zmanimSet(community);
  // Not waited for: a person whose place is still to be looked up gets the zone's main city for this load (the next one has theirs).
  const found = await placeFor(user, zone, true);
  const at = (spec: ZmanSpecValue) => (found ? (instantAt(found.place, community, today, spec)?.toISOString() ?? null) : null);
  return {
    community,
    place: found ? found.source : 'none',
    day: today,
    zmanim: reminderZmanim(community).map((key) => ({ key, opinion: set.zmanim[key]?.opinion ?? null, at: at({ zman: key, offsetMin: 0 }) })),
    hours: Array.from({ length: 12 }, (_, i) => at({ halachicHours: i + 1, offsetMin: 0 })),
  };
}
