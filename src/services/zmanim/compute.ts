/**
 * Zmanim (halachic times) on @hebcal/core: the one place a zman becomes an instant, and the
 * Shabbat and Yom Tov windows. The sets (what each zman is, and how it rounds) are data in
 * sets.ts. Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md.
 *
 *   zmanimForDay    every zman of a community's set on a civil day, rounded to the minute as the set says
 *   zmanInstant     a reminder's zman plus an offset (or N halachic hours after sunrise) as one instant
 *   shabbatYomTovWindows   when Shabbat and Yom Tov hold, from candle lighting to the end of the day
 *
 * Pure: no database, Redis or network. Server only: @hebcal/core must never reach the Mini App
 * bundle (the client gets computed times in the DTO).
 *
 * A day is a civil date, 'yyyy-MM-dd', in the person's own zone. hebcal reads a plain Date by its
 * LOCAL fields, so it is never given one: it is given an HDate built from the date's day number,
 * which reads the same on a server in any zone (CLAUDE.md, wall-time rule). An instant is always
 * a UTC epoch value, and a civil day of an instant is read with the resolver's `localDate`.
 */

import { GeoLocation, HDate, HebrewCalendar, Zmanim, flags } from '@hebcal/core';
import { addDaysToDate, localDate } from '../../utils/day-events';
import { ISRAEL_ZONES } from '../../utils/locale-rules';
import { zmanimOfSet, zmanimSet, type Frame, type Round, type Rule, type ZmanKey, type ZmanimCommunity, type ZmanimSet } from './sets';

/** Where a person is. `elevationM` null = not known: read as sea level. `timeZone` is their IANA zone. */
export interface Place {
  latitude: number;
  longitude: number;
  elevationM: number | null;
  timeZone: string;
}

/** A reminder's time: a zman and a clock-minute offset, or N halachic hours after the sunrise. */
export type ZmanSpec = { zman: ZmanKey; offsetMin: number } | { halachicHours: number; offsetMin: number };

/** A zman on a day: null where it does not exist (the sun never reaches that angle, or never rises or sets). */
export type ZmanimDay = Partial<Record<ZmanKey, Date | null>>;

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Rata Die (hebcal's absolute day number) of 1970-01-01. */
const RD_OF_UNIX_EPOCH = 719_163;

/** Whether the person is in Israel: the same zone list the week start and Hebrew dates use. */
export function inIsrael(timeZone: string): boolean {
  return ISRAEL_ZONES.has(timeZone);
}

/** hebcal's day for a civil date, built from its day number so no local-field Date is involved. */
function hdateOf(day: string): HDate {
  const m = DAY_KEY.exec(day);
  if (!m) throw new TypeError(`[zmanim] not a civil date (yyyy-MM-dd): ${day}`);
  const utc = new Date(0);
  utc.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  utc.setUTCHours(0, 0, 0, 0);
  // Date rolls 2026-13-45 over into 2027: a day that is not a real one is refused, not moved.
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== day) throw new TypeError(`[zmanim] not a civil date (yyyy-MM-dd): ${day}`);
  return new HDate(Math.floor(utc.getTime() / 86_400_000) + RD_OF_UNIX_EPOCH);
}

/** A hebcal result as epoch milliseconds, or null where hebcal found no such time (an Invalid Date). */
function msOf(date: Date): number | null {
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Whole seconds, as hebcal returns them. */
function toSecond(ms: number): Date {
  return new Date(Math.floor(ms / SECOND_MS) * SECOND_MS);
}

/** `exact` to the minute in the direction the set says: earlier floors it, later ceils it. */
function roundToMinute(exact: Date, round: Round): Date {
  const minutes = exact.getTime() / MINUTE_MS;
  return new Date((round === 'earlier' ? Math.floor(minutes) : Math.ceil(minutes)) * MINUTE_MS);
}

/** Where the zman could not be found: one log line a call, never one per zman. */
function logMissing(day: string, place: Place, keys: string[]): void {
  if (keys.length === 0) return;
  console.warn(`[zmanim] no ${keys.join(', ')} on ${day} at ${place.latitude.toFixed(3)},${place.longitude.toFixed(3)} (the sun does not reach it that day): skipped`);
}

/**
 * One civil day at one place under one set: the frame's sunrise and sunset, the hour, and each
 * rule's value, found once. Rules count from each other's uncut values and a zman is cut to whole
 * seconds (as hebcal returns them) only when it is read, so a zman that counts from another is
 * within a second of what hebcal's own methods give.
 */
class Day {
  private readonly frameSun: Zmanim;
  private readonly seaSun: Zmanim;
  private readonly memo = new Map<ZmanKey | 'sunrise' | 'sunset', number | null>();
  private nextMorning: number | null | undefined;

  constructor(
    readonly day: string,
    readonly place: Place,
    readonly set: ZmanimSet,
  ) {
    const hdate = hdateOf(day);
    const useElevation = set.frame.kind === 'horizon' && set.frame.elevation === 'israel' && inIsrael(place.timeZone);
    // hebcal refuses a negative elevation (the Dead Sea); below sea level the horizon is sea level's.
    const elevation = useElevation ? Math.max(0, place.elevationM ?? 0) : 0;
    const location = new GeoLocation(null, place.latitude, place.longitude, elevation, place.timeZone);
    this.frameSun = new Zmanim(location, hdate, useElevation);
    this.seaSun = useElevation ? new Zmanim(location, hdate, false) : this.frameSun;
  }

  private frameTime(frame: Frame, rising: boolean): number | null {
    if (frame.kind === 'angle') return msOf(this.frameSun.timeAtAngle(frame.degrees, rising));
    return msOf(rising ? this.frameSun.sunrise() : this.frameSun.sunset());
  }

  /** The set's sunrise: what the day's hours are counted from. */
  get sunrise(): number | null {
    if (!this.memo.has('sunrise')) this.memo.set('sunrise', this.frameTime(this.set.frame, true));
    return this.memo.get('sunrise') ?? null;
  }

  /** The set's sunset: where the day's hours end. */
  get sunset(): number | null {
    if (!this.memo.has('sunset')) this.memo.set('sunset', this.frameTime(this.set.frame, false));
    return this.memo.get('sunset') ?? null;
  }

  /** The next morning's sunrise (the night's end), from the next civil day's own calculation. */
  get nextSunrise(): number | null {
    if (this.nextMorning === undefined) {
      this.nextMorning = new Day(addDaysToDate(this.day, 1), this.place, this.set).sunrise;
    }
    return this.nextMorning;
  }

  /** One halachic hour: a twelfth of the day, in milliseconds. */
  get hour(): number | null {
    const { sunrise, sunset } = this;
    return sunrise === null || sunset === null ? null : (sunset - sunrise) / 12;
  }

  /** A rule's value in epoch milliseconds, or null where it does not exist that day. */
  private evaluate(rule: Rule): number | null {
    const { sunrise, sunset, hour } = this;
    switch (rule.op) {
      case 'seaLevelSunrise':
        return msOf(this.seaSun.seaLevelSunrise());
      case 'seaLevelSunset':
        return msOf(this.seaSun.seaLevelSunset());
      case 'frameSunset':
        return sunset;
      case 'angle':
        return msOf(this.seaSun.timeAtAngle(rule.degrees, rule.rising));
      case 'hoursFromSunrise':
        return sunrise === null || hour === null ? null : sunrise + Math.round(hour * rule.hours);
      case 'hoursFromSunset':
        return sunset === null || hour === null ? null : sunset + Math.round(hour * rule.hours);
      case 'zmFromSunrise':
        return sunrise === null || hour === null ? null : sunrise + Math.round((hour / 60) * rule.zm);
      case 'zmFromSunset':
        return sunset === null || hour === null ? null : sunset + Math.round((hour / 60) * rule.zm);
      case 'clockFromSunset': {
        const from = rule.from === 'frameSunset' ? sunset : msOf(this.seaSun.seaLevelSunset());
        return from === null ? null : from + rule.minutes * MINUTE_MS;
      }
      case 'hoursFromZman': {
        const base = this.raw(rule.zman);
        return base === null || hour === null ? null : base + Math.round(hour * rule.hours);
      }
      case 'midday':
        return sunrise === null || sunset === null ? null : (sunrise + sunset) / 2;
      case 'afterMidday': {
        const midday = this.evaluate({ op: 'midday' });
        return midday === null || hour === null ? null : midday + Math.max(rule.minutes * MINUTE_MS, hour * rule.hours);
      }
      case 'midnight': {
        const morning = this.nextSunrise;
        return sunset === null || morning === null ? null : (sunset + morning) / 2;
      }
      case 'mgaHours': {
        const mga = this.mgaDay();
        return mga === null ? null : mga.begin + Math.floor(mga.hour * rule.hours);
      }
      case 'byPlace':
        return this.evaluate(inIsrael(this.place.timeZone) ? rule.israel : rule.abroad);
    }
  }

  /** The Magen Avraham's day: where it begins and how long one of its twelfths is. */
  mgaDay(): { begin: number; hour: number } | null {
    const mga = this.set.mgaDay;
    if (!mga) return null;
    const begin = this.evaluate(mga.begin);
    const end = this.evaluate(mga.end);
    return begin === null || end === null ? null : { begin, hour: (end - begin) / 12 };
  }

  /** A zman's value before it is cut to whole seconds, in epoch milliseconds: what other rules count from. */
  private raw(zman: ZmanKey): number | null {
    if (this.memo.has(zman)) return this.memo.get(zman) ?? null;
    const entry = this.set.zmanim[zman];
    const value = entry ? this.evaluate(entry.rule) : null;
    this.memo.set(zman, value);
    return value;
  }

  /** A zman's exact value in epoch milliseconds (whole seconds), or null where it does not exist or the set has none. */
  exact(zman: ZmanKey): number | null {
    const raw = this.raw(zman);
    return raw === null ? null : toSecond(raw).getTime();
  }

  /** A zman as shown: rounded to the minute the way the set rounds it. */
  shown(zman: ZmanKey): Date | null {
    const exact = this.exact(zman);
    const entry = this.set.zmanim[zman];
    return exact === null || !entry ? null : roundToMinute(new Date(exact), entry.round);
  }
}

function dayOf(date: string, place: Place, community: ZmanimCommunity): Day {
  return new Day(date, place, zmanimSet(community));
}

/** Every zman of the set on `date`, exact to the second and not rounded. A zman that does not exist is null. */
export function exactZmanimForDay(date: string, place: Place, community: ZmanimCommunity): ZmanimDay {
  const day = dayOf(date, place, community);
  const out: ZmanimDay = {};
  const missing: string[] = [];
  for (const key of zmanimOfSet(community)) {
    const ms = day.exact(key);
    out[key] = ms === null ? null : new Date(ms);
    if (ms === null) missing.push(key);
  }
  logMissing(date, place, missing);
  return out;
}

/**
 * Every zman of the community's set on `date` (a civil date, 'yyyy-MM-dd', in the person's zone),
 * rounded to the minute in the direction the set gives that zman. A zman that does not exist that
 * day (the sun never reaches that angle at a polar place) is null, and the call logs it once.
 */
export function zmanimForDay(date: string, place: Place, community: ZmanimCommunity): ZmanimDay {
  const day = dayOf(date, place, community);
  const out: ZmanimDay = {};
  const missing: string[] = [];
  for (const key of zmanimOfSet(community)) {
    const shown = day.shown(key);
    out[key] = shown;
    if (shown === null) missing.push(key);
  }
  logMissing(date, place, missing);
  return out;
}

/**
 * The length of the day's halachic hour in milliseconds: `day` is the set's own (the GRA's for
 * the Sephardi and Ashkenazi sets, the Baal HaTanya's for Chabad), `mga` is the Magen Avraham's
 * where the set has one. Null where the day has no sunrise or sunset.
 */
export function halachicHourMs(date: string, place: Place, community: ZmanimCommunity): { day: number | null; mga: number | null } {
  const day = dayOf(date, place, community);
  const hour = day.hour;
  const mga = day.mgaDay();
  return { day: hour === null ? null : Math.round(hour), mga: mga === null ? null : Math.round(mga.hour) };
}

/**
 * A reminder's time on `date`: the zman as shown (rounded the set's way) plus the offset in clock
 * minutes, or the sunrise plus N halachic hours (rounded earlier, as a deadline is) plus the
 * offset. Null, and logged, where the zman does not exist that day, the set has no such zman, or
 * the spec is not one.
 */
export function zmanInstant(date: string, spec: ZmanSpec, place: Place, community: ZmanimCommunity): Date | null {
  if (!Number.isFinite(spec.offsetMin)) {
    console.warn(`[zmanim] zmanInstant: the offset ${String(spec.offsetMin)} is not a number of minutes: skipped`);
    return null;
  }
  const day = dayOf(date, place, community);
  let base: Date | null;
  if ('zman' in spec) {
    if (!zmanimSet(community).zmanim[spec.zman]) {
      console.warn(`[zmanim] zmanInstant: the ${community} set has no ${spec.zman}: skipped`);
      return null;
    }
    base = day.shown(spec.zman);
    if (base === null) logMissing(date, place, [spec.zman]);
  } else {
    if (!Number.isFinite(spec.halachicHours) || spec.halachicHours < 0 || spec.halachicHours > 12) {
      console.warn(`[zmanim] zmanInstant: ${String(spec.halachicHours)} halachic hours is not between 0 and 12: skipped`);
      return null;
    }
    const { sunrise, hour } = day;
    base = sunrise === null || hour === null ? null : roundToMinute(toSecond(sunrise + Math.round(hour * spec.halachicHours)), 'earlier');
    if (base === null) logMissing(date, place, [`${spec.halachicHours} halachic hours after sunrise`]);
  }
  return base === null ? null : new Date(base.getTime() + spec.offsetMin * MINUTE_MS);
}

/** A day on which work is forbidden: Shabbat, or a Yom Tov by the Israel or the diaspora schedule. */
function isRestDay(day: string, il: boolean): boolean {
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 6) return true;
  const events = HebrewCalendar.getHolidaysOnDate(hdateOf(day), il) ?? [];
  return events.some(event => (event.getFlags() & flags.CHAG) !== 0);
}

/**
 * When Shabbat and Yom Tov hold at the place, for the days that touch `range`: each window runs
 * from candle lighting on the evening before the first rest day to the end of the last one (the
 * set's end of Shabbat, rounded later), and rest days next to each other make one window (Yom Tov
 * on a Friday into Shabbat, Shabbat into a Yom Tov on Sunday, the two days of Rosh Hashana).
 * Yom Tov follows the Israel schedule in Israel and the diaspora's elsewhere. A window is the
 * half-open [start, end): at its start the pause holds, at its end it no longer does. A window
 * whose candle lighting or end does not exist (polar) is left out and logged.
 *
 * `range` is two instants; the windows returned are those that overlap it.
 */
export function shabbatYomTovWindows(range: { from: Date; to: Date }, place: Place, community: ZmanimCommunity): Array<[Date, Date]> {
  const il = inIsrael(place.timeZone);
  const fromDay = localDate(range.from, place.timeZone);
  const toDay = localDate(range.to, place.timeZone);
  // A window is at most three rest days (Thursday and Friday Yom Tov with Shabbat), and one
  // starting on the evening of `toDay` has its first rest day the day after.
  const first = addDaysToDate(fromDay, -3);
  const last = addDaysToDate(toDay, 4);

  const windows: Array<[Date, Date]> = [];
  for (let day = first; day <= last; ) {
    if (!isRestDay(day, il)) {
      day = addDaysToDate(day, 1);
      continue;
    }
    // A block of rest days, day to blockEnd.
    let blockEnd = day;
    while (blockEnd < last && isRestDay(addDaysToDate(blockEnd, 1), il)) blockEnd = addDaysToDate(blockEnd, 1);
    const eve = addDaysToDate(day, -1);
    const start = dayOf(eve, place, community).shown('CANDLE_LIGHTING');
    const end = dayOf(blockEnd, place, community).shown('SHABBAT_ENDS');
    if (start && end) {
      if (start.getTime() <= range.to.getTime() && end.getTime() > range.from.getTime()) windows.push([start, end]);
    } else {
      console.warn(`[zmanim] no ${start ? 'end of Shabbat' : 'candle lighting'} for the rest days ${day} to ${blockEnd}: that window is left out`);
    }
    day = addDaysToDate(blockEnd, 1);
  }
  return windows;
}
