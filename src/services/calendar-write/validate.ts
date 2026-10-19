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
} from '../../lib/calendar-view/editor-types';
import { MAX_SPAN_DAYS, daysBetween, dayOfWall, isDay, isWall } from './walltime';

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const KINDS: readonly ItemKind[] = ['event', 'reminder'];
const SCOPES: readonly EditScope[] = ['single', 'following', 'all'];
const REPEATS: readonly RepeatChoice[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FAMCAL_KEY = 'famcal|';
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

/** A start or end in the form `allDay` says. */
export const isTime = (value: unknown, allDay: boolean): value is string => (allDay ? isDay(value) : isWall(value));

export interface CreateCommand {
  kind: ItemKind;
  title: string;
  location: string;
  description: string;
  allDay: boolean;
  start: string;
  /** Events only; undefined when the body gave none. */
  end?: string;
  repeat: RepeatChoice;
  calendarId?: string;
  forPartner: boolean;
}

export function parseCreate(raw: unknown): Parsed<CreateCommand> {
  if (!isObject(raw)) return fail('body');
  const bad = unknownKey(raw, ['kind', 'title', 'location', 'description', 'allDay', 'start', 'end', 'repeat', 'calendarId', 'forPartner']);
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
  if (!isTime(raw.start, allDay)) return fail('start');
  const start = raw.start;
  // A reminder has one time: an end sent with it is ignored, as the store ignores it.
  let end: string | undefined;
  if (kind === 'event' && raw.end !== undefined) {
    if (!isTime(raw.end, allDay) || !endFollows(start, raw.end, allDay)) return fail('end');
    end = raw.end;
  }
  if (raw.repeat !== undefined && (typeof raw.repeat !== 'string' || !(REPEATS as readonly string[]).includes(raw.repeat))) return fail('repeat');
  const repeat = (raw.repeat ?? 'none') as RepeatChoice;
  let calendarId: string | undefined;
  if (kind === 'event' && raw.calendarId !== undefined) {
    if (!isNativeCalendarIdOf(raw.calendarId)) return fail('calendarId');
    calendarId = raw.calendarId;
  }
  if (raw.forPartner !== undefined && typeof raw.forPartner !== 'boolean') return fail('forPartner');
  const forPartner = raw.forPartner === true;
  if (forPartner && kind !== 'reminder') return fail('forPartner');
  return { ok: true, value: { kind, title, location, description, allDay, start, ...(end !== undefined ? { end } : {}), repeat, ...(calendarId ? { calendarId } : {}), forPartner } };
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

export interface UpdateCommand {
  key: ItemKey;
  scope: EditScope;
  changes: {
    title?: string;
    location?: string;
    description?: string;
    allDay?: boolean;
    start?: string;
    end?: string;
    /** 3b: the repeat from the opened occurrence on. */
    repeat?: RepeatChoice;
    /** 3b: an event's calendar, 'native:<cuid>'. */
    calendarId?: string;
    /** 3b: a reminder for the partner (true) or its creator (false), relative to its creator. */
    forPartner?: boolean;
  };
}

/** A FamCal calendar id as the editor sends it, 'native:<cuid>'. */
const isNativeCalendarIdOf = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('native:') && ID.test(value.slice(7));

export function parseUpdate(raw: unknown): Parsed<UpdateCommand> {
  if (!isObject(raw)) return fail('body');
  const bad = unknownKey(raw, ['key', 'scope', 'changes']);
  if (bad) return fail(bad);
  const key = parseItemKey(raw.key);
  if (!key) return fail('key');
  if (typeof raw.scope !== 'string' || !(SCOPES as readonly string[]).includes(raw.scope)) return fail('scope');
  if (!isObject(raw.changes)) return fail('changes');
  const c = raw.changes;
  const unknown = Object.keys(c).find((k) => !['title', 'location', 'description', 'allDay', 'start', 'end', 'repeat', 'calendarId', 'forPartner'].includes(k));
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
    if (typeof c.repeat !== 'string' || !(REPEATS as readonly string[]).includes(c.repeat)) return fail('repeat');
    changes.repeat = c.repeat as RepeatChoice;
  }
  if (c.calendarId !== undefined) {
    if (!isNativeCalendarIdOf(c.calendarId)) return fail('calendarId');
    changes.calendarId = c.calendarId;
  }
  if (c.forPartner !== undefined) {
    if (typeof c.forPartner !== 'boolean') return fail('forPartner');
    changes.forPartner = c.forPartner;
  }
  return { ok: true, value: { key, scope: raw.scope as EditScope, changes } };
}

export interface DeleteCommand {
  key: ItemKey;
  scope: EditScope;
}

export function parseDelete(raw: unknown): Parsed<DeleteCommand> {
  if (!isObject(raw)) return fail('body');
  const bad = unknownKey(raw, ['key', 'scope']);
  if (bad) return fail(bad);
  const key = parseItemKey(raw.key);
  if (!key) return fail('key');
  if (typeof raw.scope !== 'string' || !(SCOPES as readonly string[]).includes(raw.scope)) return fail('scope');
  return { ok: true, value: { key, scope: raw.scope as EditScope } };
}
