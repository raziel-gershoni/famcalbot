// The calendar home's writes (home editing spec §3): create, edit and delete a FamCal
// event or reminder, for the three routes in app/api/calendar/items. Every write goes
// through the same store functions the bot's confirmations call, so access, the main
// calendar, forUserId, armedAt and the due gate are the bot's. Validation of the body is
// validate.ts; what this file adds is the wall times in the user's zone, the diff against
// the item as it stands (only what changed is written, so a one-field edit pins nothing
// into an override), the scope arithmetic the store leaves to its caller, the caches, and
// the analytics of a write that took.
//
// No title reaches a log, an error context or analytics: a failure is reported by its
// class and code.

import type { NativeCalendar } from '@prisma/client';
import type { UserConfig } from '../../types';
import { prisma } from '../../utils/prisma';
import { buildRecurrenceRule } from '../calendar';
import { trackActivityAsync } from '../analytics-service';
import { clearRecurrenceCacheForUser } from '../recurrence-cache';
import { toUnifiedEvent } from '../calendar-provider/native-provider';
import {
  NativeFixedDaysError,
  NativeNotFoundError,
  NativePermissionDeniedError,
  createNativeEvent,
  decodeCalendarId,
  decodeEventId,
  deleteNativeEvent,
  getMainNativeCalendar,
  getPartnerUserId,
  seriesTimesFor,
  updateNativeEvent,
  type UpdateNativeEventInput,
} from '../native-calendar/event-store';
import { stripMovedPings } from '../native-reminders/moved-pings';
import { resolveReminderForCreate } from '../native-reminders/resolve';
import { getReminderSupport } from '../native-reminders/support';
import type { ParsedEvent } from '../event-parser';
import { shiftOnWall } from '../native-calendar/recurrence';
import { itemZone, loadItem, wallFor, type LoadedItem } from './item-info';
import { endFollows, itemKeyOf, isTime, type CreateCommand, type DeleteCommand, type UpdateCommand } from './validate';
import { addDaysToDate, dayEnd, dayOfWall, dayStart, daysBetween, instantToWall, wallToInstant } from './walltime';

export type WriteResult =
  | { status: 'ok'; key?: string }
  | { status: 'invalid'; field: string }
  | { status: 'not_allowed' | 'not_found' | 'changed' };

const HOUR_MS = 3_600_000;
const NOT_ALLOWED: WriteResult = { status: 'not_allowed' };
const NOT_FOUND: WriteResult = { status: 'not_found' };

/**
 * An error to report without what it carries: a Prisma error's message quotes the data
 * it was given, titles included. Its class and code say what went wrong.
 */
export function scrubbed(err: unknown): Error {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return new Error(`${name}${typeof code === 'string' ? ` ${code}` : ''}`);
}

/** The store's refusals as results; anything else is for the route to report. */
function refusal(err: unknown): WriteResult | null {
  if (err instanceof NativePermissionDeniedError) return NOT_ALLOWED;
  if (err instanceof NativeNotFoundError) return NOT_FOUND;
  // A day move for more than this one of a rule with fixed days (the bot's BYDAY): the
  // editor offers only "Only this one" then (series.fixedDays).
  if (err instanceof NativeFixedDaysError) return { status: 'invalid', field: 'start' };
  return null;
}

/**
 * Forget the recurrence rules kept for everyone who reads this calendar: the user, and
 * the partner when the calendar is shared, is the partner's, or the item is a reminder
 * for them.
 */
async function clearCaches(
  user: UserConfig,
  calendar: Pick<NativeCalendar, 'ownerUserId' | 'privacy'>,
  forUserId: number | null
): Promise<void> {
  clearRecurrenceCacheForUser(user.id);
  const partnerId = await getPartnerUserId(user.id, user.pairingId ?? null);
  if (partnerId === null) return;
  if (calendar.ownerUserId !== user.id || calendar.privacy !== 'PRIVATE' || forUserId === partnerId) {
    clearRecurrenceCacheForUser(partnerId);
  }
}

/** The stored rule for a repeat choice, as the bot's provider stores it (no RRULE: prefix). */
function ruleFor(repeat: CreateCommand['repeat']): string | null {
  if (repeat === 'none') return null;
  return buildRecurrenceRule({ frequency: repeat })[0].replace(/^RRULE:/, '');
}

/** The wall times of a create as instants: an all-day item from the start of its first day to 23:59 on its last. */
function createTimes(cmd: CreateCommand, tz: string): { startsAt: Date; endsAt: Date } {
  if (cmd.allDay) return { startsAt: dayStart(cmd.start, tz), endsAt: dayEnd(cmd.end ?? cmd.start, tz) };
  const startsAt = wallToInstant(cmd.start, tz);
  return { startsAt, endsAt: cmd.end ? wallToInstant(cmd.end, tz) : new Date(startsAt.getTime() + HOUR_MS) };
}

export async function createItem(user: UserConfig, cmd: CreateCommand, tz: string): Promise<WriteResult> {
  if (user.calendarSource !== 'NATIVE') return NOT_ALLOWED;
  try {
    const rrule = ruleFor(cmd.repeat);
    const base = {
      creatorUserId: user.id,
      title: cmd.title,
      description: cmd.description || undefined,
      location: cmd.location || undefined,
      allDay: cmd.allDay,
      timeZone: tz,
      rrule,
    };

    if (cmd.kind === 'event') {
      const calendarCuid = cmd.calendarId ? decodeCalendarId(cmd.calendarId) : (await getMainNativeCalendar(user.id)).id;
      if (!calendarCuid) return { status: 'invalid', field: 'calendarId' };
      const times = createTimes(cmd, tz);
      const event = await createNativeEvent({ ...base, ...times, calendarCuid });
      const calendar = await prisma.nativeCalendar.findUnique({ where: { id: event.calendarId } });
      if (calendar) await clearCaches(user, calendar, null);
      trackActivityAsync(user.id, 'voice_event_created', { calendar_id: cmd.calendarId ?? `native:${calendarCuid}`, source: 'app' });
      return { status: 'ok', key: itemKeyOf(event.id, rrule ? event.startsAt : undefined) };
    }

    // A reminder takes the bot's path (resolve.ts): its creator's main calendar, forUserId
    // only for a partner who can be pinged, and a date-only one at the start of its day.
    // The bot's gate is the one the home's "+" hint mirrors.
    if (!(await getReminderSupport(user)).supported) return NOT_ALLOWED;
    const startTime = cmd.allDay ? dayStart(cmd.start, tz) : wallToInstant(cmd.start, tz);
    const parsed: ParsedEvent = {
      title: cmd.title,
      startTime,
      endTime: startTime,
      allDay: cmd.allDay,
      confidence: 'high',
      kind: 'reminder',
      forPerson: cmd.forPartner ? 'partner' : 'self',
    };
    const resolved = await resolveReminderForCreate(user, parsed, tz);
    if (!resolved.ok) throw new Error(`reminder not resolved: ${resolved.error}`);
    if (cmd.forPartner && resolved.forUserId === null) return { status: 'invalid', field: 'forPartner' };
    const calendarCuid = decodeCalendarId(resolved.calendarId);
    if (!calendarCuid) throw new Error('reminder resolved to a calendar that is not a native one');
    const reminder = await createNativeEvent({
      ...base,
      calendarCuid,
      startsAt: resolved.startTime,
      endsAt: resolved.endTime,
      allDay: resolved.allDay,
      kind: 'REMINDER',
      forUserId: resolved.forUserId,
    });
    const calendar = await prisma.nativeCalendar.findUnique({ where: { id: reminder.calendarId } });
    if (calendar) await clearCaches(user, calendar, resolved.forUserId);
    trackActivityAsync(user.id, 'voice_event_created', { calendar_id: resolved.calendarId, source: 'app' });
    trackActivityAsync(user.id, 'native_reminder_created', {
      for_partner: resolved.forUserId !== null,
      all_day: resolved.allDay,
      recurring: rrule !== null,
      source: 'app',
    });
    return { status: 'ok', key: itemKeyOf(reminder.id, rrule ? reminder.startsAt : undefined) };
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }
}

type Ok = Extract<LoadedItem, { status: 'ok' }>;

/** The scope the store is given: a one-off has only itself. */
const effectiveScope = (item: Ok, scope: UpdateCommand['scope']) => (item.series.rrule ? scope : 'single');

export async function updateItem(user: UserConfig, cmd: UpdateCommand, userTz: string): Promise<WriteResult> {
  const item = await loadItem(user, cmd.key);
  if (item.status !== 'ok') return { status: item.status };
  if (!item.canEdit) return NOT_ALLOWED;
  const { series, occurrence: occ } = item;
  const reminder = series.kind === 'REMINDER';
  const itemTz = itemZone(series);
  const c = cmd.changes;
  const was = wallFor(occ.startsAt, occ.endsAt, occ.allDay, userTz, itemTz);
  const wasEnd = reminder ? was.start : was.end;
  const allDay = c.allDay ?? occ.allDay;

  // The new times, in the form allDay says. What the body leaves out stays, or follows:
  // a moved start keeps the length, and a form change takes the nearest sensible value.
  let start: string;
  if (c.start !== undefined) {
    if (!isTime(c.start, allDay)) return { status: 'invalid', field: 'start' };
    start = c.start;
  } else if (allDay === occ.allDay) {
    start = was.start;
  } else if (allDay) {
    start = dayOfWall(was.start);
  } else {
    return { status: 'invalid', field: 'start' };
  }
  let end: string;
  if (reminder) {
    end = start;
  } else if (c.end !== undefined) {
    if (!isTime(c.end, allDay)) return { status: 'invalid', field: 'end' };
    end = c.end;
  } else if (allDay !== occ.allDay) {
    end = allDay ? start : instantToWall(new Date(wallToInstant(start, userTz).getTime() + HOUR_MS), userTz);
  } else if (start === was.start) {
    end = wasEnd;
  } else if (allDay) {
    end = addDaysToDate(start, daysBetween(was.start, was.end));
  } else {
    end = instantToWall(new Date(wallToInstant(start, userTz).getTime() + (occ.endsAt.getTime() - occ.startsAt.getTime())), userTz);
  }
  if (!reminder && !endFollows(start, end, allDay)) return { status: 'invalid', field: 'end' };

  const timeChanged = allDay !== occ.allDay || start !== was.start || end !== wasEnd;
  const text = {
    ...(c.title !== undefined && c.title !== occ.title ? { title: c.title } : {}),
    ...(c.location !== undefined && c.location !== (occ.location ?? '') ? { location: c.location } : {}),
    ...(c.description !== undefined && c.description !== (occ.description ?? '') ? { description: c.description } : {}),
  };
  const sameKey = itemKeyOf(series.id, cmd.key.slot);
  if (!timeChanged && Object.keys(text).length === 0) return { status: 'ok', key: sameKey };

  const scope = effectiveScope(item, cmd.scope);
  const startsAt = allDay ? dayStart(start, itemTz) : wallToInstant(start, userTz);
  const endsAt = reminder ? startsAt : allDay ? dayEnd(end, itemTz) : wallToInstant(end, userTz);
  const input: UpdateNativeEventInput = { seriesCuid: series.id, instanceStartsAt: series.rrule ? cmd.key.slot : undefined, scope, actingUserId: user.id, ...text };
  let key = sameKey;
  if (timeChanged) {
    if (scope === 'all' && series.rrule) {
      // The series moves as this occurrence did (by its days, to its new time of day): a rule
      // with no BYDAY (what the editor writes) follows its start, so the weekday moves with it;
      // the store refuses a day move on one with fixed days. Its own start is written only
      // when it moves, which carries what was skipped or renamed along; this occurrence is
      // then where its slot went (one moved on its own comes back to the rule's day).
      const moved = seriesTimesFor(series, occ.startsAt, { startsAt, endsAt, allDay });
      if (moved.startsAt.getTime() !== series.startsAt.getTime()) {
        input.startsAt = moved.startsAt;
        key = itemKeyOf(series.id, shiftOnWall(cmd.key.slot!, series.startsAt, moved.startsAt, itemTz));
      }
      input.endsAt = moved.endsAt;
    } else {
      input.startsAt = startsAt;
      input.endsAt = endsAt;
    }
    input.allDay = allDay;
  }

  try {
    const result = await updateNativeEvent(input);
    if (scope === 'following' && series.rrule) {
      // The cut starts a new series at this occurrence: where the store anchors it, its slot
      // moved as the occurrence was (one moved on its own to another day keeps the rule's).
      const anchor = timeChanged ? seriesTimesFor({ startsAt: cmd.key.slot!, timeZone: series.timeZone }, occ.startsAt, { startsAt, endsAt, allDay }).startsAt : cmd.key.slot;
      key = itemKeyOf(decodeEventId(result.canonicalEventId).seriesCuid, anchor);
    }
    if (result.clearedPings.length > 0) {
      // The pings still on screen say where the reminder went (best-effort, as for the bot).
      const original = toUnifiedEvent(item.calendar, occ, series);
      await stripMovedPings(result.clearedPings, original, { title: text.title, startTime: startsAt, endTime: endsAt, allDay }, user);
    }
    await clearCaches(user, item.calendar, series.forUserId);
    trackActivityAsync(user.id, 'calendar_item_edited', { kind: reminder ? 'reminder' : 'event', scope, source: 'app' });
    return { status: 'ok', key };
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }
}

export async function deleteItem(user: UserConfig, cmd: DeleteCommand): Promise<WriteResult> {
  const item = await loadItem(user, cmd.key);
  if (item.status !== 'ok') return { status: item.status };
  if (!item.canDelete) return NOT_ALLOWED;
  const scope = effectiveScope(item, cmd.scope);
  try {
    await deleteNativeEvent({
      seriesCuid: item.series.id,
      instanceStartsAt: item.series.rrule ? cmd.key.slot : undefined,
      scope,
      actingUserId: user.id,
    });
    await clearCaches(user, item.calendar, item.series.forUserId);
    trackActivityAsync(user.id, 'calendar_item_deleted', { kind: item.series.kind === 'REMINDER' ? 'reminder' : 'event', scope, source: 'app' });
    return { status: 'ok' };
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }
}
