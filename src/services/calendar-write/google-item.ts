// The calendar home's Google items (3b spec §2.4, §3.3): the editor's Google calendars,
// one item's edit info read live, and its create, edit and delete. Every write goes
// through the bot's provider (calendar-provider/google-provider.ts → calendar.ts), so the
// scope arithmetic, the zone, the errors and the cache stamp are the bot's; this file adds
// what the home needs on top: the user's own calendars (ids never come from the client),
// who may change an item, the diff against it (only what changed is written; notes only
// when changed, since Google keeps HTML), the scope rules, the order of a move and a patch,
// and the outcome of each failure.
//
// No title reaches a log, an error context or analytics.

import type { calendar_v3 } from '@googleapis/calendar';
import type { CalendarAssignment, UserConfig } from '../../types';
import type { EditorCalendar, ItemEditInfoResponse } from '../../lib/calendar-view/editor-types';
import { captureError } from '../../lib/error-capture';
import { trackActivityAsync } from '../analytics-service';
import { htmlToText } from '../../utils/html';
import { googleProvider } from '../calendar-provider/google-provider';
import type { ProviderErrorCode, UpdateEventInput } from '../calendar-provider/types';
import { nativeRuleOf, readEventForEdit, ruleOf, type GoogleItemRead } from '../calendar';
import { googleCalendarRef, googleCalendarSet } from '../calendar-read/google';
import { sourcesFor } from '../calendar-read/index';
import { resolveUserTimezone } from '../../lib/timezone';
import { classifyGoogleError, type GoogleErrorClass } from '../calendar-read/google-map';
import { classifyRule, fixesDays } from '../native-calendar/recurrence';
import { repeatInfo, wallFor, writableCalendarRows } from './item-info';
import { getPartnerUserId } from '../native-calendar/event-store';
import { googleCrossRefusal, type CrossRefusal } from '../calendar-move/mapper';
import { googleKeyOf, isHebrewChoice, parseGoogleKey, type CreateCommand, type DeleteCommand, type GoogleItemKey, type UpdateCommand } from './validate';
import { dayEnd, dayStart, localDate, wallToInstant } from './walltime';
import { createTimes, repeatChanges, resolveWallTimes, ruleFor, type WriteResult } from './write';
import { liveGoogleChoices } from '../../lib/google-state';
import { minYearFor } from '../../lib/calendar-view/year-limits';

export { parseGoogleKey };

type GEvent = calendar_v3.Schema$Event;

const WRITABLE_ROLES = new Set(['owner', 'writer']);
const NOT_ALLOWED: WriteResult = { status: 'not_allowed' };
const NOT_FOUND: WriteResult = { status: 'not_found' };

/** Whether the user reads Google: a token (sourcesFor), and so their chosen calendars. */
const readsGoogle = (user: UserConfig) => sourcesFor(user).includes('google') && Boolean(user.googleRefreshToken);

/** The user's chosen Google calendar a key names, or undefined: ids never come from the client. */
function assignmentOf(user: UserConfig, calendarId: string): CalendarAssignment | undefined {
  return readsGoogle(user) ? googleCalendarSet(user, [calendarId])[0] : undefined;
}

/** The editor's Google calendars, or, when the live list couldn't be read, none and the failure's class. */
export type GoogleEditorCalendars = { calendars: EditorCalendar[]; failure?: GoogleErrorClass };

/**
 * A calendar list's failure by Google's own error: the list's reader rewrites a token or
 * scope failure to the bot's message and keeps Google's error as the cause.
 */
function listFailureClass(error: unknown): GoogleErrorClass {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined) return classifyGoogleError(cause);
  if (error instanceof Error && error.message === 'GOOGLE_TOKEN_EXPIRED') return 'token';
  if (error instanceof Error && error.message === 'GOOGLE_INSUFFICIENT_SCOPES') return 'scopes';
  return classifyGoogleError(error);
}

/**
 * The Google calendars the editor offers (3b spec §2.4): the user's chosen ones they can
 * write, by the live role (one calendarList.list), in the order chosen. main is the
 * primary. A list that can't be read gives none (no "+") with its failure's class, and is
 * logged once here (the list's reader captures nothing); a write that needs the list answers by that class (failureOutcome).
 */
export async function googleEditorCalendars(user: UserConfig): Promise<GoogleEditorCalendars> {
  const chosen = readsGoogle(user) ? googleCalendarSet(user) : [];
  if (chosen.length === 0) return { calendars: [] };
  let live: Awaited<ReturnType<typeof googleProvider.listCalendars>>;
  try {
    live = await googleProvider.listCalendars(user);
  } catch (error) {
    const failure = listFailureClass(error);
    // As the reader reports (calendar-read/google.ts): a failure the user or Google fixes (a
    // dead token or missing scopes, which the reconnect banner already shows, Google down)
    // is a warning; an OAuth client Google rejects, or an error no table knows, is ours.
    captureError(new Error(`Google ${failure} reading the calendar list`), 'calendar-editor-google', { user_id: user.id }, failure === 'config' || failure === 'unknown' ? 'error' : 'warning');
    return { calendars: [], failure };
  }
  const byId = new Map(live.map((c) => [c.id, c]));
  const calendars = chosen.flatMap((a) => {
    const c = byId.get(a.calendarId);
    if (!c || !WRITABLE_ROLES.has(c.accessRole)) return [];
    const ref = googleCalendarRef(a, [], { [a.calendarId]: c.backgroundColor });
    return [{ id: a.calendarId, name: ref.name, color: ref.color, main: c.primary, mine: ref.mine, ...(ref.ownerName ? { ownerName: ref.ownerName } : {}) }];
  });
  return { calendars };
}

/**
 * Whether the home may change a Google event (3b spec §2.4), read on the instance (which
 * carries its master's organizer and guests): a default event (no type, or 'default'), not
 * locked, no other guest (a room counts; guests Google left out count as unknown), and the
 * calendar it sits on organizes it, or it has no guests at all. The calendar's role is
 * checked apart.
 */
export function editableInHome(e: GEvent): boolean {
  if (e.eventType && e.eventType !== 'default') return false;
  if (e.locked) return false;
  if (e.attendeesOmitted) return false;
  const attendees = e.attendees ?? [];
  if (attendees.some((a) => !a.self)) return false;
  return Boolean(e.organizer?.self) || attendees.length === 0;
}

export type Loaded =
  | { status: 'ok'; key: GoogleItemKey; read: GoogleItemRead; assignment: CalendarAssignment; writable: boolean; editable: boolean }
  | { status: 'not_found' }
  | { status: 'error'; result: WriteResult };

/** A failed Google read's class as a write's outcome (3b spec §2.6): token or scopes reconnect, refused notAllowed, anything else failed. */
export function failureOutcome(cls: GoogleErrorClass): WriteResult {
  if (cls === 'token') return { status: 'reconnect', reason: 'token' };
  if (cls === 'scopes') return { status: 'reconnect', reason: 'scopes' };
  if (cls === 'forbidden') return NOT_ALLOWED;
  return { status: 'failed' };
}

/** A Google read's failure as a write's outcome (and logged, by class and ids). */
function readFailure(error: unknown, user: UserConfig, key: GoogleItemKey): Loaded {
  const cls = classifyGoogleError(error);
  if (cls === 'gone') return { status: 'not_found' };
  captureError(new Error(`Google ${cls} reading an item`), 'calendar-google-item', { user_id: user.id, calendar_id: key.calendarId, event_id: key.eventId }, cls === 'transient' ? 'warning' : 'error');
  return { status: 'error', result: failureOutcome(cls) };
}

/** One Google item, read live: the key's calendar must be one the user chose. */
export async function loadGoogleItem(user: UserConfig, key: GoogleItemKey, userTz: string): Promise<Loaded> {
  const assignment = assignmentOf(user, key.calendarId);
  if (!assignment || !user.googleRefreshToken) return { status: 'not_found' };
  let read: GoogleItemRead;
  try {
    read = await readEventForEdit(user.googleRefreshToken, key.calendarId, key.eventId, userTz);
  } catch (error) {
    return readFailure(error, user, key);
  }
  if (read.event.status === 'cancelled') return { status: 'not_found' };
  const writable = WRITABLE_ROLES.has(read.accessRole);
  return { status: 'ok', key, read, assignment, writable, editable: writable && editableInHome(read.event) };
}

/** An event's times as the editor's instants: timed as they are; all-day from 00:00 on its first day to 23:59 on its last, on the user's clock. */
function occurrenceOf(e: GEvent, userTz: string): { startsAt: Date; endsAt: Date; allDay: boolean } {
  if (e.start?.date) {
    const last = e.end?.date && e.end.date > e.start.date ? addDays(e.end.date, -1) : e.start.date;
    return { allDay: true, startsAt: dayStart(e.start.date, userTz), endsAt: dayEnd(last, userTz) };
  }
  const startsAt = new Date(e.start?.dateTime ?? NaN);
  return { allDay: false, startsAt, endsAt: e.end?.dateTime ? new Date(e.end.dateTime) : startsAt };
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The zone the item's repeat is read in: its own, else its calendar's, else the user's. */
const zoneOf = (read: GoogleItemRead, userTz: string) => read.zone ?? userTz;

/** The series' rule (bare, Google's form) and how the Repeat row names it (3b spec §2.1). */
function ruleInfo(read: GoogleItemRead, userTz: string): { rule: string | null; choice: ReturnType<typeof classifyRule>['choice']; until?: string } {
  const rule = ruleOf(read.master?.recurrence ?? read.event.recurrence);
  if (!rule) return { rule: null, choice: 'none' };
  const zone = zoneOf(read, userTz);
  const series = read.master ?? read.event;
  const start = series.start?.date ? dayStart(series.start.date, zone) : new Date(series.start?.dateTime ?? NaN);
  const classified = classifyRule(nativeRuleOf(rule, zone), start, zone);
  const allDay = Boolean(series.start?.date);
  return {
    rule,
    choice: classified.choice,
    ...(classified.until ? { until: allDay ? localDate(classified.until, zone) : localDate(classified.until, userTz) } : {}),
  };
}

/** GET /api/calendar/item for a 'google|…' key: the 3a shape, read live, with 3b's additions (spec §3.3). */
export async function googleEditInfo(user: UserConfig, key: GoogleItemKey, userTz: string): Promise<ItemEditInfoResponse | 'not_found'> {
  const loaded = await loadGoogleItem(user, key, userTz);
  if (loaded.status !== 'ok') {
    // A failure other than gone is logged by the load; the sheet then has no pencil.
    if (loaded.status === 'error') throw new Error('The Google item could not be read');
    return 'not_found';
  }
  const { read, assignment, writable, editable } = loaded;
  const recurring = Boolean(read.master);
  const occ = occurrenceOf(read.event, userTz);
  const at = wallFor(occ.startsAt, occ.endsAt, occ.allDay, userTz, userTz);
  const series = occurrenceOf(read.master ?? read.event, userTz);
  const first = wallFor(series.startsAt, series.endsAt, series.allDay, userTz, userTz);
  const rule = ruleInfo(read, userTz);
  // A list that can't be read (logged) leaves the sheet with no move.
  const calendars = editable ? (await googleEditorCalendars(user)).calendars : [];
  const googleTargets = calendars.some((c) => c.id === key.calendarId) ? calendars.map((c) => c.id) : [];
  const cross = googleTargets.length > 0 ? await famcalTargetsOf(user, read, userTz) : { ids: [], shared: [] };
  const moveTargets = [...googleTargets, ...cross.ids];
  const live = calendars.find((c) => c.id === key.calendarId);
  const ref = googleCalendarRef(assignment, []);
  return {
    kind: 'event',
    canEdit: editable,
    canDelete: editable,
    occurrence: {
      start: at.start,
      end: at.end,
      allDay: occ.allDay,
      title: read.event.summary ?? '',
      location: read.event.location ?? '',
      description: htmlToText(read.event.description) ?? '',
    },
    series: {
      recurring,
      start: first.start,
      repeat: repeatInfo(rule.rule),
      fixedDays: fixesDays(rule.rule),
      zone: zoneOf(read, userTz),
      rule: { choice: rule.choice, ...(rule.until ? { until: rule.until } : {}) },
      first: read.first,
    },
    tz: userTz,
    calendar: { id: key.calendarId, name: live?.name ?? ref.name, color: live?.color ?? ref.color },
    forName: null,
    scopes: recurring ? ['single', 'following', 'all'] : ['single'],
    canMoveCalendar: moveTargets.length > 1,
    moveTargets,
    canChangeRecipient: false,
    forPartner: false,
    editableInGoogleOnly: writable && !editable,
    source: 'google',
    ...(cross.reason ? { moveReason: cross.reason } : {}),
    ...(cross.shared.length > 0 ? { sharedTargets: cross.shared } : {}),
  };
}

/**
 * The FamCal calendars an editable Google event may move to ("Google as a connection" §5):
 * every FamCal calendar the user can write, and which of them the partner sees (shared, or
 * the partner's own) while there is one; or, when it can't cross (a video call or files, a
 * repeat FamCal can't hold), none and why. A series whose master has other guests offers
 * none (the move would cancel their invitation). Read from the event and its master: the
 * other exceptions are listed only by the move, which refuses then what this can't see.
 */
async function famcalTargetsOf(user: UserConfig, read: GoogleItemRead, userTz: string): Promise<{ ids: string[]; shared: string[]; reason?: CrossRefusal }> {
  if (read.master && !editableInHome(read.master)) return { ids: [], shared: [] };
  const reason = googleCrossRefusal({ ...read.event, recurrence: undefined }) ?? googleCrossRefusal(read.master ?? read.event, zoneOf(read, userTz));
  if (reason) return { ids: [], shared: [], reason };
  const [rows, partnerId] = await Promise.all([writableCalendarRows(user), getPartnerUserId(user.id, user.pairingId ?? null)]);
  return {
    ids: rows.map((r) => r.entry.id),
    shared: partnerId === null ? [] : rows.filter((r) => r.calendar.ownerUserId !== user.id || r.calendar.privacy !== 'PRIVATE').map((r) => r.entry.id),
  };
}

/** A provider failure as the home's outcome (3b spec §2.6). */
function outcomeOf(error: ProviderErrorCode | undefined): WriteResult {
  switch (error) {
    case 'TOKEN_EXPIRED':
    case 'NOT_CONNECTED':
      return { status: 'reconnect', reason: 'token' };
    case 'PERMISSION_DENIED':
      return { status: 'reconnect', reason: 'scopes' };
    case 'FORBIDDEN':
      return NOT_ALLOWED;
    case 'NOT_FOUND':
      return { status: 'changed' };
    case 'FIXED_DAYS':
      return { status: 'invalid', field: 'start' };
    default:
      return { status: 'failed' };
  }
}

/** A rule for a repeat choice as Google takes it, or null for none. */
const googleRuleFor = (repeat: CreateCommand['repeat']): string | null => {
  // Never a Hebrew rule as a Gregorian yearly one (hebrew-repeats spec §4); the writes above refuse it first.
  if (isHebrewChoice(repeat)) throw new Error('A Hebrew-date repeat cannot be written to Google');
  const rule = ruleFor(repeat);
  return rule ? `RRULE:${rule}` : null;
};

/**
 * POST /api/calendar/items for a Google calendar: checked against the editor's writable
 * list, created in the user's zone. A Google user with no token, or a list that can't be
 * read, answers by the failure (reconnect or failed), not as a bad calendar.
 */
export async function createGoogleItem(user: UserConfig, cmd: CreateCommand, tz: string): Promise<WriteResult> {
  if (cmd.kind !== 'event') return NOT_ALLOWED; // reminders always live in FamCal
  // Google can't hold a Hebrew-date rule (hebrew-repeats spec §4): never sent as a Gregorian yearly one.
  if (isHebrewChoice(cmd.repeat)) return { status: 'invalid', field: 'repeat' };
  // A legacy Google user's chosen calendar, with the token gone (scope errors used to clear it): reconnect.
  // A FamCal user's stale choices with no token are none (liveGoogleChoices): a bad calendar.
  if (!user.googleRefreshToken && liveGoogleChoices(user).some((a) => a.calendarId === cmd.calendarId)) {
    captureError(new Error('Google create with no refresh token'), 'calendar-google-item', { user_id: user.id }, 'warning');
    return { status: 'reconnect', reason: 'token' };
  }
  const { calendars, failure } = await googleEditorCalendars(user);
  if (failure) return failureOutcome(failure);
  if (calendars.length === 0) return cmd.calendarId ? { status: 'invalid', field: 'calendarId' } : NOT_ALLOWED;
  const target = cmd.calendarId ?? (calendars.find((c) => c.main) ?? calendars[0]).id;
  if (!calendars.some((c) => c.id === target)) return { status: 'invalid', field: 'calendarId' };
  const times = createTimes(cmd, tz);
  const rule = googleRuleFor(cmd.repeat);
  const result = await googleProvider.createEvent(user, target, {
    title: cmd.title,
    startTime: times.startsAt,
    endTime: times.endsAt,
    description: cmd.description || undefined,
    location: cmd.location || undefined,
    allDay: cmd.allDay,
    ...(rule ? { recurrence: [rule] } : {}),
  });
  if (!result.success || !result.eventId) return outcomeOf(result.error);
  trackActivityAsync(user.id, 'voice_event_created', { calendar_id: target, source: 'app', provider: 'google' });
  return { status: 'ok', key: googleKeyOf(target, result.instanceId ?? result.eventId) };
}

/**
 * PATCH /api/calendar/items for a Google key. Only what differs from the item as Google has
 * it is written. A repeat change on a series applies from the occurrence on ('following'); a
 * calendar change needs a series scope. A calendar change on 'all' (or a one-off) is
 * Google's move, first: when it fails nothing else is written; when the patch after it
 * fails, that is logged and the item is where it moved to. 'following' puts the new part
 * on the destination.
 */
export async function updateGoogleItem(user: UserConfig, cmd: UpdateCommand & { key: { source: 'google' } & GoogleItemKey }, userTz: string): Promise<WriteResult> {
  const key = cmd.key;
  if (isHebrewChoice(cmd.changes.repeat)) return { status: 'invalid', field: 'repeat' };
  const loaded = await loadGoogleItem(user, key, userTz);
  if (loaded.status === 'not_found') return NOT_FOUND;
  if (loaded.status === 'error') return loaded.result;
  if (!loaded.editable) return NOT_ALLOWED;
  const { read } = loaded;
  const c = cmd.changes;
  const master = read.master;
  const masterId = master?.id ?? undefined;

  const occ = occurrenceOf(read.event, userTz);
  // One rule with FamCal's items (year-limits.ts), by the repeat the item will have: the one picked, else the series' own as the Repeat row names it.
  // The editor's floor comes from that same classified choice, so client and server agree.
  const rule = ruleInfo(read, userTz);
  const times = resolveWallTimes(c, occ, false, userTz, userTz, minYearFor(c.repeat ?? rule.choice));
  if (!times.ok) return { status: 'invalid', field: times.field };
  const { start, end, allDay, timeChanged } = times;
  const text = {
    ...(c.title !== undefined && c.title !== (read.event.summary ?? '') ? { title: c.title } : {}),
    ...(c.location !== undefined && c.location !== (read.event.location ?? '') ? { location: c.location } : {}),
    // Google keeps HTML notes and the form shows them as text: written only when the text changed.
    ...(c.description !== undefined && c.description !== (htmlToText(read.event.description) ?? '') ? { description: c.description } : {}),
  };
  const repeat = c.repeat !== undefined && repeatChanges(c.repeat, rule.rule, rule.choice) ? c.repeat : undefined;
  if (c.forPartner === true) return { status: 'invalid', field: 'forPartner' };
  const moveTo = c.calendarId !== undefined && c.calendarId !== key.calendarId ? c.calendarId : undefined;
  if (moveTo !== undefined) {
    const { calendars, failure } = await googleEditorCalendars(user);
    if (failure) return failureOutcome(failure);
    if (!calendars.some((cal) => cal.id === moveTo)) return { status: 'invalid', field: 'calendarId' };
  }
  const sameKey = googleKeyOf(key.calendarId, key.eventId);
  const fieldsChange = timeChanged || Object.keys(text).length > 0 || repeat !== undefined;
  if (!fieldsChange && moveTo === undefined) return { status: 'ok', key: sameKey };

  let scope = masterId ? cmd.scope : 'single';
  if (masterId && repeat !== undefined) scope = 'following';
  else if (masterId && moveTo !== undefined && scope === 'single') return { status: 'invalid', field: 'scope' };

  const data: UpdateEventInput = {
    ...text,
    ...(timeChanged
      ? { startTime: allDay ? dayStart(start, userTz) : wallToInstant(start, userTz), endTime: allDay ? dayEnd(end, userTz) : wallToInstant(end, userTz), allDay }
      : {}),
    scope,
    ...(masterId ? { recurringEventId: masterId } : {}),
    ...(repeat !== undefined ? { rrule: googleRuleFor(repeat) } : {}),
  };
  const changedFields = [
    ...(text.title !== undefined ? ['title'] : []),
    ...(text.location !== undefined ? ['location'] : []),
    ...(text.description !== undefined ? ['description'] : []),
    ...(timeChanged ? ['time'] : []),
    ...(repeat !== undefined ? ['repeat'] : []),
    ...(moveTo !== undefined ? ['calendar'] : []),
  ];
  const tracked = () => trackActivityAsync(user.id, 'calendar_item_edited', { kind: 'event', scope, source: 'app', provider: 'google', changed_fields: changedFields });

  if (moveTo !== undefined && scope !== 'following') {
    // The whole series (its master) or the one-off moves; its occurrences keep their ids.
    const moved = await googleProvider.moveEvent(user, { eventId: masterId ?? key.eventId, fromCalendarId: key.calendarId, toCalendarId: moveTo });
    if (!moved.success) return outcomeOf(moved.error);
    let movedKey = googleKeyOf(moveTo, key.eventId);
    if (fieldsChange) {
      const patched = await googleProvider.updateEvent(user, moveTo, key.eventId, data);
      if (!patched.success) {
        captureError(new Error(`The patch after a move failed: ${patched.error}`), 'calendar-google-item-patch-after-move', {
          user_id: user.id, calendar_id: moveTo, event_id: key.eventId,
        });
      } else {
        movedKey = googleKeyOf(patched.calendarId ?? moveTo, patched.instanceId ?? key.eventId);
      }
    }
    tracked();
    return { status: 'ok', key: movedKey };
  }

  const result = await googleProvider.updateEvent(user, key.calendarId, key.eventId, { ...data, ...(moveTo !== undefined ? { toCalendarId: moveTo } : {}) });
  if (!result.success) return outcomeOf(result.error);
  tracked();
  return { status: 'ok', key: googleKeyOf(result.calendarId ?? key.calendarId, result.instanceId ?? result.eventId ?? key.eventId) };
}

/** DELETE /api/calendar/items for a Google key, for its scope (a one-off has only itself). */
export async function deleteGoogleItem(user: UserConfig, cmd: DeleteCommand & { key: { source: 'google' } & GoogleItemKey }): Promise<WriteResult> {
  const key = cmd.key;
  // The user's zone only places an all-day slot whose event and calendar give none.
  const loaded = await loadGoogleItem(user, key, await resolveUserTimezone(user));
  if (loaded.status === 'not_found') return NOT_FOUND;
  if (loaded.status === 'error') return loaded.result;
  if (!loaded.editable) return NOT_ALLOWED;
  const masterId = loaded.read.master?.id ?? undefined;
  const scope = masterId ? cmd.scope : 'single';
  const result = await googleProvider.deleteEvent(user, key.calendarId, key.eventId, { scope, ...(masterId ? { recurringEventId: masterId } : {}) });
  if (!result.success) return outcomeOf(result.error);
  trackActivityAsync(user.id, 'calendar_item_deleted', { kind: 'event', scope, source: 'app', provider: 'google' });
  return { status: 'ok' };
}
