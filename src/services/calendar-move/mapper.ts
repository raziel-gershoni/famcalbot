// The one native ↔ Google mapper ("Google as a connection" spec §5 "One mapper"): a FamCal
// series as the Google event that holds the same occurrences, and a Google series as the
// FamCal series that does. The cross-source move uses it now, and the FamCal-to-Google
// sync will (docs/superpowers/specs/2026-10-20-google-sync-design.md). Pure: no Google
// call, no database, no clock; what can't cross is answered as a reason, never thrown.
//
// The two calendars read a series differently, and the mapper is where they meet:
// - FamCal expands a rule on the series' wall clock (floating time), and reads an UNTIL
//   as wall time in the series' zone, a date-only UNTIL on a timed series as 23:59:59 that
//   day. Google expands in start.timeZone and wants a timed UNTIL in UTC (…Z).
// - FamCal stores an all-day item from 00:00 on its first day to 23:59 on its last; Google
//   ends it on the exclusive next date.
// - FamCal's exceptions are exdates and CANCELLED rows (by slot, the occurrence's original
//   start) and OVERRIDE rows; Google's are EXDATE lines and exception events (by
//   originalStartTime), cancelled or modified.
// - rrule.js yields only the dates that match a rule, where RFC 5545 (Google) counts the
//   start as the first occurrence whatever the rule says: a series whose start isn't one of
//   its own slots would gain or lose its first occurrence, so it can't cross.

import type { calendar_v3 } from '@googleapis/calendar';
import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { TIMEZONE } from '../../config/constants';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { htmlToText } from '../../utils/html';
import { assertStorableRule, expandSeries, yieldsSlots } from '../native-calendar/recurrence';

type GEvent = calendar_v3.Schema$Event;

/** Why an event can't move to the other kind of calendar (each has its own copy, calendarHome.editor.move.reasons). */
export type CrossRefusal = 'meet' | 'hebrew' | 'repeat';

/** The private extended property a moved copy carries: the FamCal series it came from. Never a sync mirror key. */
export const MOVED_FROM = 'famcalMovedFrom';

const DAY_MS = 86_400_000;
/** An all-day item's end as FamCal stores it: 23:59 on its last day. */
const dayEnd = (day: string, zone: string) => fromZonedTime(`${day}T23:59:00`, zone);
const compact = (day: string) => day.replace(/-/g, '');
const dayOfCompact = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
const wallStamp = (d: Date, zone: string) => formatInTimeZone(d, zone, "yyyyMMdd'T'HHmmss");
const utcStamp = (d: Date) => formatInTimeZone(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
const bare = (rule: string) => rule.replace(/^RRULE:/i, '');
const byTime = (a: Date, b: Date) => a.getTime() - b.getTime();

function uniqueSorted(dates: readonly Date[]): Date[] {
  const seen = new Set<number>();
  return dates.filter((d) => !seen.has(d.getTime()) && seen.add(d.getTime())).sort(byTime);
}

/** The fields the recurrence helpers read, as a NativeEvent (the rest are never looked at). */
type SeriesShape = Pick<NativeEvent, 'startsAt' | 'endsAt' | 'allDay' | 'timeZone' | 'rrule' | 'exdates'> & Partial<NativeEvent>;
function asSeries(s: SeriesShape): NativeEvent {
  return { id: s.id ?? 'mapper', calendarId: '', creatorUserId: 0, title: '', description: null, location: null, hebrewRule: null, hebrewAnchor: null, reminderMinutes: null, kind: 'EVENT', forUserId: null, armedAt: null, isDeleted: false, createdAt: new Date(0), updatedAt: new Date(0), ...s } as NativeEvent;
}

/** Whether the rule can be stored and its start is one of its own slots. */
function ruleCrosses(series: NativeEvent): boolean {
  if (!series.rrule) return true;
  try {
    assertStorableRule(series.rrule, null);
  } catch {
    return false;
  }
  return yieldsSlots(series, [series.startsAt]).has(series.startsAt.getTime());
}

// ---- FamCal → Google ----

/** An override row as the patch of its Google instance, found by its original start. */
export interface GoogleException {
  /** The FamCal slot (the occurrence's original start). */
  slot: Date;
  /** events.instances' originalStart: RFC 3339 for a timed series, the date for an all-day one. */
  originalStart: string;
  patch: GEvent;
}

export interface GoogleCopy {
  /** The body to insert (or, for a copy found again, to patch in full). */
  event: GEvent;
  exceptions: GoogleException[];
  zone: string;
  allDay: boolean;
}

/** An instant pair as Google's start and end in `zone`: all day, the dates with the exclusive next one. */
function googleTimes(startsAt: Date, endsAt: Date, allDay: boolean, zone: string): Pick<GEvent, 'start' | 'end'> {
  if (!allDay) return { start: { dateTime: startsAt.toISOString(), timeZone: zone }, end: { dateTime: endsAt.toISOString(), timeZone: zone } };
  const first = localDate(startsAt, zone);
  const last = localDate(endsAt, zone);
  return { start: { date: first, timeZone: zone }, end: { date: addDaysToDate(last > first ? last : first, 1), timeZone: zone } };
}

/**
 * A FamCal rule as Google's RRULE line. A timed series' UNTIL becomes UTC: a date-time one
 * (with a Z or without, FamCal reads both as wall time) at that wall time in `zone`, a
 * date-only one at 23:59:59 that day. An all-day series' UNTIL is a date: a date-time one
 * becomes its date. The other parts stay as they are, in place.
 */
export function googleRuleLine(rule: string, allDay: boolean, zone: string): string {
  const line = bare(rule).replace(/(^|;)UNTIL=(\d{8})(?:T(\d{6})Z?)?(?=;|$)/i, (_m, lead: string, day: string, time: string | undefined) => {
    if (allDay) return `${lead}UNTIL=${day}`;
    const wall = time ? `${dayOfCompact(day)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}` : `${dayOfCompact(day)}T23:59:59`;
    return `${lead}UNTIL=${utcStamp(fromZonedTime(wall, zone))}`;
  });
  return `RRULE:${line}`;
}

/** Why a FamCal event can't move to Google, or null: a Hebrew rule, or a repeat Google wouldn't yield the same way. */
export function famcalCrossRefusal(series: NativeEvent, overrides: readonly NativeEventInstance[]): CrossRefusal | null {
  if (series.hebrewRule) return 'hebrew';
  if (!series.rrule) return null;
  if (!ruleCrosses(series)) return 'repeat';
  const moved = overrides.filter((o) => o.status === 'OVERRIDE').map((o) => o.originalStartsAt);
  const yielded = yieldsSlots(series, moved);
  return moved.every((d) => yielded.has(d.getTime())) ? null : 'repeat';
}

/**
 * How the exceptions are written. The move patches a fresh copy, so an exception holds only
 * what its override changes ('changes'). The sync (google-sync spec §4) patches a copy that
 * may hold an earlier version of the occurrence, so every exception carries the whole
 * occurrence as it stands ('whole'): its title, notes and place (empty when it has none) and
 * its times, so nothing an earlier patch wrote survives.
 */
export interface GoogleCopyOptions {
  exceptions?: 'changes' | 'whole';
}

/** The OVERRIDE rows on these slots as the patches of their Google instances, in slot order. */
function exceptionsOf(series: NativeEvent, overrides: readonly NativeEventInstance[], keep: (slot: Date) => boolean, zone: string, allDay: boolean, whole: boolean): GoogleException[] {
  const out: GoogleException[] = [];
  for (const o of [...overrides].filter((r) => r.status === 'OVERRIDE').sort((a, b) => byTime(a.originalStartsAt, b.originalStartsAt))) {
    if (!keep(o.originalStartsAt)) continue;
    const occ = occurrenceOf(series, overrides, o.originalStartsAt);
    if (!occ) continue;
    const timed = o.startsAt !== null || o.endsAt !== null || o.allDay !== null;
    const patch: GEvent = whole
      ? {
          summary: o.title ?? series.title,
          description: o.description ?? series.description ?? '',
          location: o.location ?? series.location ?? '',
          ...googleTimes(occ.startsAt, occ.endsAt, occ.allDay, zone),
        }
      : {
          ...(o.title !== null ? { summary: o.title } : {}),
          ...(o.description !== null ? { description: o.description } : {}),
          ...(o.location !== null ? { location: o.location } : {}),
          ...(timed ? googleTimes(occ.startsAt, occ.endsAt, occ.allDay, zone) : {}),
        };
    out.push({ slot: o.originalStartsAt, originalStart: allDay ? localDate(o.originalStartsAt, zone) : o.originalStartsAt.toISOString(), patch });
  }
  return out;
}

/** A series' basics as a Google event, its first occurrence at `startsAt`–`endsAt`. */
function basicsOf(series: NativeEvent, startsAt: Date, endsAt: Date, zone: string): GEvent {
  return {
    summary: series.title,
    ...(series.description ? { description: series.description } : {}),
    ...(series.location ? { location: series.location } : {}),
    ...googleTimes(startsAt, endsAt, series.allDay, zone),
  };
}

/**
 * A FamCal series (its override rows beside it) as the Google event that holds the same
 * occurrences: the basics in the series' own zone, the rule with its UNTIL as Google reads
 * it, one EXDATE line for the exdates and CANCELLED rows (TZID wall times in the zone, or
 * VALUE=DATE all day), the marker, and each OVERRIDE row as the patch of its instance.
 * A cancellation on a slot the rule never yields cancels nothing and is left out.
 */
export function toGoogleEvent(series: NativeEvent, overrides: readonly NativeEventInstance[], options: GoogleCopyOptions = {}): { ok: true; copy: GoogleCopy } | { ok: false; reason: CrossRefusal } {
  const refusal = famcalCrossRefusal(series, overrides);
  if (refusal) return { ok: false, reason: refusal };
  const zone = series.timeZone || TIMEZONE;
  const allDay = series.allDay;
  const event = basicsOf(series, series.startsAt, series.endsAt, zone);
  let exceptions: GoogleException[] = [];
  if (series.rrule) {
    const cancelled = overrides.filter((o) => o.status === 'CANCELLED').map((o) => o.originalStartsAt);
    const candidates = uniqueSorted([...series.exdates, ...cancelled]);
    const yielded = yieldsSlots(series, candidates);
    const skipped = candidates.filter((d) => yielded.has(d.getTime()));
    const recurrence = [googleRuleLine(series.rrule, allDay, zone)];
    if (skipped.length > 0) {
      recurrence.push(allDay ? `EXDATE;VALUE=DATE:${skipped.map((d) => compact(localDate(d, zone))).join(',')}` : `EXDATE;TZID=${zone}:${skipped.map((d) => wallStamp(d, zone)).join(',')}`);
    }
    event.recurrence = recurrence;
    const skippedAt = new Set(skipped.map((d) => d.getTime()));
    exceptions = exceptionsOf(series, overrides, (slot) => !skippedAt.has(slot.getTime()), zone, allDay, options.exceptions === 'whole');
  }
  event.extendedProperties = { private: { [MOVED_FROM]: series.id } };
  return { ok: true, copy: { event, exceptions, zone, allDay } };
}

/**
 * A Hebrew-date series (hebrew-repeats spec) as a Google event of explicit dates
 * (google-sync spec §4 Hebrew series): Google has no Hebrew rule, so the copy starts on the
 * first of `slots` (the series' own slots the caller chose: the horizon, with the skipped
 * ones left out) and lists the rest as one RDATE line, TZID wall times in the zone, or
 * VALUE=DATE all day. Its RRULE (FREQ=YEARLY;COUNT=1) yields only the start, so the
 * recurrence is exactly the listed dates (RFC 5545: the union of RRULE and RDATE). The
 * OVERRIDE rows on those slots are the patches of their instances. The move never uses it:
 * a Hebrew series doesn't move to Google (famcalCrossRefusal).
 */
export function toGoogleHebrewEvent(series: NativeEvent, overrides: readonly NativeEventInstance[], slots: readonly Date[], options: GoogleCopyOptions = {}): { ok: true; copy: GoogleCopy } | { ok: false; reason: CrossRefusal } {
  const dates = uniqueSorted(slots);
  if (!series.hebrewRule || dates.length === 0) return { ok: false, reason: 'hebrew' };
  const zone = series.timeZone || TIMEZONE;
  const allDay = series.allDay;
  const first = occurrenceOf(series, [], dates[0]);
  if (!first) return { ok: false, reason: 'repeat' };
  const event = basicsOf(series, first.startsAt, first.endsAt, zone);
  const rest = dates.slice(1);
  event.recurrence = ['RRULE:FREQ=YEARLY;COUNT=1'];
  if (rest.length > 0) {
    event.recurrence.push(allDay ? `RDATE;VALUE=DATE:${rest.map((d) => compact(localDate(d, zone))).join(',')}` : `RDATE;TZID=${zone}:${rest.map((d) => wallStamp(d, zone)).join(',')}`);
  }
  const listed = new Set(dates.map((d) => d.getTime()));
  const exceptions = exceptionsOf(series, overrides, (slot) => listed.has(slot.getTime()), zone, allDay, options.exceptions === 'whole');
  event.extendedProperties = { private: { [MOVED_FROM]: series.id } };
  return { ok: true, copy: { event, exceptions, zone, allDay } };
}

/** One occurrence as it stands (its override applied), by its slot. */
function occurrenceOf(series: NativeEvent, overrides: readonly NativeEventInstance[], slot: Date) {
  const o = overrides.find((r) => r.originalStartsAt.getTime() === slot.getTime());
  const times = [slot, o?.startsAt, o?.endsAt].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  const length = Math.max(0, series.endsAt.getTime() - series.startsAt.getTime());
  const range = { from: new Date(Math.min(...times) - 2 * DAY_MS), to: new Date(Math.max(...times) + 2 * DAY_MS + length) };
  return expandSeries(series, range, [...overrides]).find((i) => i.instanceStartsAt.getTime() === slot.getTime());
}

/** The instance of a Google copy that is a FamCal slot: by its original start, compared as an instant (a date all day). */
export function isInstanceAt(instance: GEvent, slot: Date, allDay: boolean, zone: string): boolean {
  const o = instance.originalStartTime;
  if (allDay) return o?.date === localDate(slot, zone);
  return Boolean(o?.dateTime) && new Date(o!.dateTime!).getTime() === slot.getTime();
}

// ---- Google → FamCal ----

/** An OVERRIDE row to write: null fields follow the series. */
export interface NativeOverrideCopy {
  originalStartsAt: Date;
  title: string | null;
  description: string | null;
  location: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean | null;
}

/** A FamCal series to write (createNativeSeries): the series, its exdates and its overrides. */
export interface NativeSeriesCopy {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timeZone: string;
  rrule: string | null;
  exdates: Date[];
  overrides: NativeOverrideCopy[];
}

/** A Google event's times as FamCal's instants: all day, 00:00 on its first day to 23:59 on the day before Google's exclusive end. */
function nativeTimes(e: GEvent, zone: string): { startsAt: Date; endsAt: Date; allDay: boolean } {
  if (e.start?.date) {
    const first = e.start.date;
    const last = e.end?.date && e.end.date > first ? addDaysToDate(e.end.date, -1) : first;
    return { allDay: true, startsAt: startOfLocalDay(first, zone), endsAt: dayEnd(last, zone) };
  }
  const startsAt = new Date(e.start?.dateTime ?? NaN);
  return { allDay: false, startsAt, endsAt: e.end?.dateTime ? new Date(e.end.dateTime) : startsAt };
}

/** A Google exception's slot: its original start, an all-day one's 00:00 in `zone`. */
export function googleSlotOf(e: GEvent, zone: string): Date | null {
  const o = e.originalStartTime;
  if (o?.dateTime) return new Date(o.dateTime);
  if (o?.date) return startOfLocalDay(o.date, zone);
  return null;
}

type ExceptionValue = { date: string } | { instant: Date };

/** One EXDATE line's values, or null when anything in it can't be read (the move is then refused). */
function exdateValues(line: string, zone: string): ExceptionValue[] | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const params = line.slice(0, colon).split(';').slice(1);
  let tzid: string | undefined;
  let dateOnly = false;
  for (const p of params) {
    const [name, value] = p.split('=');
    if (/^TZID$/i.test(name) && value) tzid = value;
    else if (/^VALUE$/i.test(name) && /^DATE$/i.test(value ?? '')) dateOnly = true;
    else if (!(/^VALUE$/i.test(name) && /^DATE-TIME$/i.test(value ?? ''))) return null;
  }
  const out: ExceptionValue[] = [];
  for (const v of line.slice(colon + 1).split(',')) {
    if (/^\d{8}$/.test(v)) {
      out.push({ date: dayOfCompact(v) });
      continue;
    }
    const m = /^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
    if (!m || dateOnly) return null;
    const wall = `${dayOfCompact(m[1])}T${m[2]}:${m[3]}:${m[4]}`;
    let instant: Date;
    try {
      instant = m[5] ? new Date(`${wall}Z`) : fromZonedTime(wall, tzid ?? zone);
    } catch {
      return null;
    }
    if (Number.isNaN(instant.getTime())) return null;
    out.push({ instant });
  }
  return out;
}

/** Why a Google event can't move to FamCal, from the event alone (its master for a series), or null: a call or files, or a repeat FamCal can't hold. */
export function googleCrossRefusal(e: GEvent, zone?: string): CrossRefusal | null {
  if (e.conferenceData || (e.attachments?.length ?? 0) > 0) return 'meet';
  if (!e.recurrence?.length) return null;
  const read = readRecurrence(e, zone ?? e.start?.timeZone ?? TIMEZONE);
  return read.ok ? null : 'repeat';
}

/** A master's recurrence as a FamCal series' rule and exdates, or why not. */
function readRecurrence(master: GEvent, zone: string): { ok: true; series: NativeEvent } | { ok: false } {
  const times = nativeTimes(master, zone);
  const rules: string[] = [];
  const exLines: string[] = [];
  for (const line of master.recurrence ?? []) {
    if (/^RRULE:/i.test(line)) rules.push(line);
    else if (/^EXDATE[;:]/i.test(line)) exLines.push(line);
    else return { ok: false }; // RDATE, EXRULE or anything else FamCal can't hold
  }
  if (rules.length !== 1) return { ok: false };
  // A Z UNTIL becomes the wall time it is in the zone, as FamCal reads an UNTIL.
  const rule = bare(rules[0]).replace(/(^|;)UNTIL=(\d{8}T\d{6})Z(?=;|$)/i, (_m, lead: string, v: string) => `${lead}UNTIL=${wallStamp(new Date(`${dayOfCompact(v)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`), zone)}`);
  const series = asSeries({ ...times, timeZone: zone, rrule: rule, exdates: [] });
  if (!ruleCrosses(series)) return { ok: false };
  const values: ExceptionValue[] = [];
  for (const line of exLines) {
    const read = exdateValues(line, zone);
    if (!read) return { ok: false };
    values.push(...read);
  }
  // Each value as the slot FamCal yields: all day, 00:00 on its date; timed, the instant, or
  // a date's own slot that day. One the rule never yields excludes nothing, in either calendar.
  const slots = values.flatMap((v): Date[] => {
    if (times.allDay) return [startOfLocalDay('date' in v ? v.date : localDate(v.instant, zone), zone)];
    if ('instant' in v) return [v.instant];
    const from = startOfLocalDay(v.date, zone);
    return expandSeries(series, { from, to: startOfLocalDay(addDaysToDate(v.date, 1), zone) }).map((i) => i.instanceStartsAt).filter((d) => localDate(d, zone) === v.date);
  });
  const yielded = yieldsSlots(series, slots);
  return { ok: true, series: { ...series, exdates: uniqueSorted(slots.filter((d) => yielded.has(d.getTime()))) } };
}

/**
 * A Google event (a one-off, or a series' master with the items listed by its iCalUID) as
 * the FamCal series that holds the same occurrences. The zone is the master's
 * start.timeZone, else `calendarZone`. Of the listed items only the master's exceptions on
 * a slot its rule yields are read (strays, other masters and a cancelled master are
 * dropped): a cancelled one is an exdate, a modified one an OVERRIDE row holding only what
 * differs from the series. Notes become plain text.
 */
export function fromGoogleEvent(master: GEvent, listed: readonly GEvent[], calendarZone: string): { ok: true; series: NativeSeriesCopy } | { ok: false; reason: CrossRefusal } {
  const zone = master.start?.timeZone || calendarZone || TIMEZONE;
  if (googleCrossRefusal(master, zone) === 'meet') return { ok: false, reason: 'meet' };
  const times = nativeTimes(master, zone);
  const text = (e: GEvent) => htmlToText(e.description) || null;
  const base = {
    title: master.summary ?? '',
    description: text(master),
    location: master.location || null,
    ...times,
    timeZone: zone,
  };
  if (!master.recurrence?.length) return { ok: true, series: { ...base, rrule: null, exdates: [], overrides: [] } };
  const read = readRecurrence(master, zone);
  if (!read.ok) return { ok: false, reason: 'repeat' };
  const series = read.series;
  const exceptions = listed.filter((e) => e.recurringEventId === master.id && e.id !== master.id);
  if (exceptions.some((e) => googleCrossRefusal({ ...e, recurrence: undefined }) === 'meet')) return { ok: false, reason: 'meet' };
  const slotted = exceptions.flatMap((e) => {
    const slot = googleSlotOf(e, zone);
    return slot ? [{ e, slot }] : [];
  });
  const yielded = yieldsSlots(series, slotted.map((x) => x.slot));
  const exdates = [...series.exdates];
  const overrides: NativeOverrideCopy[] = [];
  const seen = new Set<number>();
  const spanDays = times.allDay ? Math.round((startOfLocalDay(localDate(times.endsAt, zone), zone).getTime() - times.startsAt.getTime()) / DAY_MS) : 0;
  for (const { e, slot } of slotted.sort((a, b) => byTime(a.slot, b.slot))) {
    if (!yielded.has(slot.getTime()) || seen.has(slot.getTime())) continue;
    seen.add(slot.getTime());
    if (e.status === 'cancelled') {
      exdates.push(slot);
      continue;
    }
    const own = nativeTimes(e, zone);
    const defaultEnd = times.allDay ? dayEnd(addDaysToDate(localDate(slot, zone), spanDays), zone) : new Date(slot.getTime() + (times.endsAt.getTime() - times.startsAt.getTime()));
    const moved = own.allDay !== times.allDay || own.startsAt.getTime() !== slot.getTime() || own.endsAt.getTime() !== defaultEnd.getTime();
    const differs = <T>(mine: T, theirs: T): T | null => (mine === theirs ? null : mine);
    overrides.push({
      originalStartsAt: slot,
      title: differs(e.summary ?? '', base.title),
      description: differs(text(e) ?? '', base.description ?? ''),
      location: differs(e.location ?? '', base.location ?? ''),
      startsAt: moved ? own.startsAt : null,
      endsAt: moved ? own.endsAt : null,
      allDay: moved ? own.allDay : null,
    });
  }
  return { ok: true, series: { ...base, rrule: series.rrule, exdates: uniqueSorted(exdates), overrides } };
}
