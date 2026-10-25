// What the calendar home's write routes accept (home editing spec §3): strict, and the
// same for the bot's limits and the editor's. A body that fails names the field, never
// the value (the client shows its own copy; the server logs no titles). Pure.

import {
  LOCATION_MAX,
  NOTES_MAX,
  TITLE_MAX,
  type EditScope,
  type ItemKind,
  type RepeatChoice,
  type RepeatInput,
  type RepeatSpec,
  REPEAT_COUNT_MAX,
  REPEAT_INTERVAL_MAX,
  WEEKDAY_CODES,
} from '../../lib/calendar-view/editor-types';
import { minYearFor } from '../../lib/calendar-view/year-limits';
import { parseAlertChoice, type AlertChoice } from '../../lib/calendar-view/alert-leads';
import { MAX_SPAN_DAYS, daysBetween, dayOfWall, isDay, isWall } from './walltime';

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const KINDS: readonly ItemKind[] = ['event', 'reminder'];
const SCOPES: readonly EditScope[] = ['single', 'following', 'all'];
const REPEATS: readonly RepeatChoice[] = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'hebrew'];
/** The repeat a Google calendar can't hold (hebrew-repeats spec §4): the Google writes refuse it with 400 repeat. A choice or a spec. */
export const isHebrewChoice = (repeat: RepeatInput | undefined): boolean => (typeof repeat === 'object' ? repeat.freq === 'hebrew' : repeat === 'hebrew');
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FAMCAL_KEY = 'famcal|';
const GOOGLE_KEY = 'google|';
/** A Google event or instance id ('<id>' or '<id>_<YYYYMMDDTHHMMSSZ>'): base32hex, '_' and the stamp. */
const GOOGLE_EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const AUTH_KEYS = ['user_id', 'initData'];

type Obj = Record<string, unknown>;

const isObject = (raw: unknown): raw is Obj => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const fail = (field: string): { ok: false; field: string } => ({ ok: false, field });
/** Characters, not UTF-16 units: an emoji is one. */
const length = (text: string) => Array.from(text).length;

/** The first key of `body` that is not in `allowed`, or undefined. */
function unknownKey(body: Obj, allowed: readonly string[]): string | undefined {
  return Object.keys(body).find((k) => !allowed.includes(k) && !AUTH_KEYS.includes(k));
}

/** A required title: trimmed, 1 to TITLE_MAX characters. */
function titleOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return length(title) >= 1 && length(title) <= TITLE_MAX ? title : null;
}

/** An optional text: trimmed, at most `max` characters; '' is allowed (nothing, or clear it). */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return length(text) <= max ? text : null;
}

/** Whether `end` may follow `start` (both in the form allDay says): a timed end is after, an all-day end on or after, within a year. */
export function endFollows(start: string, end: string, allDay: boolean): boolean {
  if (allDay) {
    const span = daysBetween(start, end);
    return span >= 0 && span < MAX_SPAN_DAYS;
  }
  return end > start && daysBetween(dayOfWall(start), dayOfWall(end)) <= MAX_SPAN_DAYS;
}

const SPEC_KEYS = ['freq', 'interval', 'byDay', 'monthly', 'until', 'count'];
const SPEC_FREQS: readonly RepeatSpec['freq'][] = ['daily', 'weekly', 'monthly', 'yearly', 'hebrew'];
const MONTHLIES: readonly NonNullable<RepeatSpec['monthly']>[] = ['day', 'weekday', 'last'];
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Whether `spec` is within the limits of a RepeatSpec (richer repeats ruling 3), whatever the item's
 * start: a known freq, an interval of 1..99, byDay a non-empty set of weekday codes and only for
 * weekly, monthly only for monthly, an until that is a real day (floor and MAX_YEAR) or a count of
 * 1..999, never both. That the until is not before the start is the rule builder's (it knows the start).
 */
export function specWithinLimits(spec: unknown): spec is RepeatSpec {
  if (!isObject(spec) || Object.keys(spec).some((k) => !SPEC_KEYS.includes(k))) return false;
  const { freq, interval, byDay, monthly, until, count } = spec;
  if (typeof freq !== 'string' || !(SPEC_FREQS as readonly string[]).includes(freq)) return false;
  if (!whole(interval, 1, REPEAT_INTERVAL_MAX)) return false;
  if (byDay !== undefined) {
    if (freq !== 'weekly' || !Array.isArray(byDay) || byDay.length === 0) return false;
    if (!byDay.every((d) => typeof d === 'string' && (WEEKDAY_CODES as readonly string[]).includes(d)) || new Set(byDay).size !== byDay.length) return false;
  }
  if (monthly !== undefined && (freq !== 'monthly' || typeof monthly !== 'string' || !(MONTHLIES as readonly string[]).includes(monthly))) return false;
  if (until !== undefined && count !== undefined) return false;
  if (until !== undefined && !isDay(until, minYearFor(freq as RepeatSpec['freq']))) return false;
  if (count !== undefined && !whole(count, 1, REPEAT_COUNT_MAX)) return false;
  return true;
}

/** A body's `repeat`: a RepeatChoice string or a RepeatSpec within its limits; undefined (and the field) otherwise. */
export function parseRepeat(value: unknown): RepeatInput | undefined {
  if (typeof value === 'string') return (REPEATS as readonly string[]).includes(value) ? (value as RepeatChoice) : undefined;
  return specWithinLimits(value) ? value : undefined;
}

/** A start or end in the form `allDay` says; `minYear` is the item's floor (year-limits.ts minYearFor). */
export const isTime = (value: unknown, allDay: boolean, minYear?: number): value is string => (allDay ? isDay(value, minYear) : isWall(value, minYear));

export interface CreateCommand {
  kind: ItemKind;
  title: string;
  location: string;
  description: string;
  allDay: boolean;
  start: string;
  /** Events only; undefined when the body gave none. */
  end?: string;
  repeat: RepeatInput;
  calendarId?: string;
  forPartner: boolean;
  /** Events only; undefined when the body gave none (the default). */
  alert?: AlertChoice;
}

export function parseCreate(raw: unknown): Parsed<CreateCommand> {
  if (!isObject(raw)) return fail('body');
  const bad = unknownKey(raw, ['kind', 'title', 'location', 'description', 'allDay', 'start', 'end', 'repeat', 'calendarId', 'forPartner', 'alert']);
  if (bad) return fail(bad);
  if (typeof raw.kind !== 'string' || !(KINDS as readonly string[]).includes(raw.kind)) return fail('kind');
  const kind = raw.kind as ItemKind;
  const title = titleOf(raw.title);
  if (title === null) return fail('title');
  const location = raw.location === undefined ? '' : textOf(raw.location, LOCATION_MAX);
  if (location === null) return fail('location');
  const description = raw.description === undefined ? '' : textOf(raw.description, NOTES_MAX);
  if (description === null) return fail('description');
  if (typeof raw.allDay !== 'boolean') return fail('allDay');
  const allDay = raw.allDay;
  const parsedRepeat = raw.repeat === undefined ? 'none' : parseRepeat(raw.repeat);
  if (parsedRepeat === undefined) return fail('repeat');
  const repeat: RepeatInput = parsedRepeat;
  // The earliest year depends on the repeat: 1900 for a one-off or a yearly item, 2000 for the rest.
  const minYear = minYearFor(repeat);
  if (!isTime(raw.start, allDay, minYear)) return fail('start');
  const start = raw.start;
  // A reminder has one time: an end sent with it is ignored, as the store ignores it.
  let end: string | undefined;
  if (kind === 'event' && raw.end !== undefined) {
    if (!isTime(raw.end, allDay, minYear) || !endFollows(start, raw.end, allDay)) return fail('end');
    end = raw.end;
  }
  let calendarId: string | undefined;
  if (kind === 'event' && raw.calendarId !== undefined) {
    // A FamCal calendar ('native:<cuid>') or a Google one (3b spec §3.3), checked against
    // the user's writable calendars once the write knows the user.
    if (!isNativeCalendarIdOf(raw.calendarId) && !isGoogleCalendarId(raw.calendarId)) return fail('calendarId');
    calendarId = raw.calendarId;
  }
  if (raw.forPartner !== undefined && typeof raw.forPartner !== 'boolean') return fail('forPartner');
  const forPartner = raw.forPartner === true;
  if (forPartner && kind !== 'reminder') return fail('forPartner');
  // An event's alert (editor upgrades spec §2): a listed value. A reminder has none; whether the
  // calendar takes one (a Google one doesn't) is for the write, which knows the calendar.
  let alert: AlertChoice | undefined;
  if (raw.alert !== undefined) {
    const parsed = parseAlertChoice(raw.alert);
    if (kind !== 'event' || parsed === null) return fail('alert');
    alert = parsed;
  }
  return { ok: true, value: { kind, title, location, description, allDay, start, ...(end !== undefined ? { end } : {}), repeat, ...(calendarId ? { calendarId } : {}), forPartner, ...(alert !== undefined ? { alert } : {}) } };
}

/** A FamCal item's key: the series, and the occurrence's original start for a repeating one. */
export interface ItemKey {
  seriesCuid: string;
  /** Set for a repeating series' occurrence. */
  slot?: Date;
}

/** 'famcal|<cuid>' or 'famcal|<cuid>#<ISO instant>' (the home's keys), or null. */
export function parseItemKey(value: unknown): ItemKey | null {
  if (typeof value !== 'string' || !value.startsWith(FAMCAL_KEY)) return null;
  const id = value.slice(FAMCAL_KEY.length);
  const hash = id.indexOf('#');
  const seriesCuid = hash === -1 ? id : id.slice(0, hash);
  if (!ID.test(seriesCuid)) return null;
  if (hash === -1) return { seriesCuid };
  const iso = id.slice(hash + 1);
  const slot = new Date(iso);
  return !Number.isNaN(slot.getTime()) && slot.toISOString() === iso ? { seriesCuid, slot } : null;
}

export const itemKeyOf = (seriesCuid: string, slot?: Date): string => `${FAMCAL_KEY}${seriesCuid}${slot ? `#${slot.toISOString()}` : ''}`;

/** A Google item's key: its calendar and its event (an occurrence's instance id, or a one-off's id). */
export interface GoogleItemKey {
  calendarId: string;
  eventId: string;
}

/**
 * A Google calendar id as a key or a body carries it: an email-like id, not a FamCal one,
 * with no '|' (the key's separator) and no whitespace or control character.
 */
export const isGoogleCalendarId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.startsWith('native:') && !/[|\s\u0000-\u001f]/.test(value);

/** 'google|<calendarId>|<eventId>' (the home's keys), or null. The calendar is checked against the user's own choices on use. */
export function parseGoogleKey(value: unknown): GoogleItemKey | null {
  if (typeof value !== 'string' || !value.startsWith(GOOGLE_KEY)) return null;
  const rest = value.slice(GOOGLE_KEY.length);
  const bar = rest.lastIndexOf('|');
  if (bar === -1) return null;
  const calendarId = rest.slice(0, bar);
  const eventId = rest.slice(bar + 1);
  return isGoogleCalendarId(calendarId) && GOOGLE_EVENT_ID.test(eventId) ? { calendarId, eventId } : null;
}

export const googleKeyOf = (calendarId: string, eventId: string): string => `${GOOGLE_KEY}${calendarId}|${eventId}`;

/** Any item key, by its source (3b: the writes and the item info dispatch on it). */
export type AnyItemKey = ({ source: 'famcal' } & ItemKey) | ({ source: 'google' } & GoogleItemKey);

export function parseAnyItemKey(value: unknown): AnyItemKey | null {
  const famcal = parseItemKey(value);
  if (famcal) return { source: 'famcal', ...famcal };
  const google = parseGoogleKey(value);
  return google ? { source: 'google', ...google } : null;
}

export interface UpdateCommand {
  key: AnyItemKey;
  scope: EditScope;
  changes: {
    title?: string;
    location?: string;
    description?: string;
    allDay?: boolean;
    start?: string;
    end?: string;
    /** 3b: the repeat from the opened occurrence on. */
    repeat?: RepeatInput;
    /** 3b: an event's calendar, 'native:<cuid>' or a Google id; the other kind's is the cross-source move. */
    calendarId?: string;
    /** 3b: a reminder for the partner (true) or its creator (false), relative to its creator. */
    forPartner?: boolean;
    /** An event's alert, from the opened occurrence on (series-level); a FamCal event only. */
    alert?: AlertChoice;
  };
}

/** A FamCal calendar id as the editor sends it, 'native:<cuid>'. */
const isNativeCalendarIdOf = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('native:') && ID.test(value.slice(7));

export function parseUpdate(raw: unknown): Parsed<UpdateCommand> {
  if (!isObject(raw)) return fail('body');
  const bad = unknownKey(raw, ['key', 'scope', 'changes']);
  if (bad) return fail(bad);
  const key = parseAnyItemKey(raw.key);
  if (!key) return fail('key');
  if (typeof raw.scope !== 'string' || !(SCOPES as readonly string[]).includes(raw.scope)) return fail('scope');
  if (!isObject(raw.changes)) return fail('changes');
  const c = raw.changes;
  const unknown = Object.keys(c).find((k) => !['title', 'location', 'description', 'allDay', 'start', 'end', 'repeat', 'calendarId', 'forPartner', 'alert'].includes(k));
  if (unknown) return fail(`changes.${unknown}`);
  if (Object.keys(c).length === 0) return fail('changes');
  const changes: UpdateCommand['changes'] = {};
  if (c.title !== undefined) {
    const title = titleOf(c.title);
    if (title === null) return fail('title');
    changes.title = title;
  }
  if (c.location !== undefined) {
    const location = textOf(c.location, LOCATION_MAX);
    if (location === null) return fail('location');
    changes.location = location;
  }
  if (c.description !== undefined) {
    const description = textOf(c.description, NOTES_MAX);
    if (description === null) return fail('description');
    changes.description = description;
  }
  if (c.allDay !== undefined) {
    if (typeof c.allDay !== 'boolean') return fail('allDay');
    changes.allDay = c.allDay;
  }
  // Start and end are checked against the item once it is read: their form follows allDay.
  if (c.start !== undefined) {
    if (typeof c.start !== 'string') return fail('start');
    changes.start = c.start;
  }
  if (c.end !== undefined) {
    if (typeof c.end !== 'string') return fail('end');
    changes.end = c.end;
  }
  if (c.repeat !== undefined) {
    const repeat = parseRepeat(c.repeat);
    if (repeat === undefined) return fail('repeat');
    changes.repeat = repeat;
  }
  if (c.calendarId !== undefined) {
    // Either kind: one of the other kind is the cross-source move ("Google as a connection" §5).
    if (!isNativeCalendarIdOf(c.calendarId) && !isGoogleCalendarId(c.calendarId)) return fail('calendarId');
    changes.calendarId = c.calendarId as string;
  }
  if (c.forPartner !== undefined) {
    if (typeof c.forPartner !== 'boolean') return fail('forPartner');
    changes.forPartner = c.forPartner;
  }
  if (c.alert !== undefined) {
    const alert = parseAlertChoice(c.alert);
    if (alert === null) return fail('alert');
    changes.alert = alert;
  }
  return { ok: true, value: { key, scope: raw.scope as EditScope, changes } };
}

export interface DeleteCommand {
  key: AnyItemKey;
  scope: EditScope;
}

export function parseDelete(raw: unknown): Parsed<DeleteCommand> {
  if (!isObject(raw)) return fail('body');
  const bad = unknownKey(raw, ['key', 'scope']);
  if (bad) return fail(bad);
  const key = parseAnyItemKey(raw.key);
  if (!key) return fail('key');
  if (typeof raw.scope !== 'string' || !(SCOPES as readonly string[]).includes(raw.scope)) return fail('scope');
  return { ok: true, value: { key, scope: raw.scope as EditScope } };
}
