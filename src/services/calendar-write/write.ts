// The calendar home's writes (home editing spec §3): create, edit and delete a FamCal
// event or reminder, for the three routes in app/api/calendar/items. A Google item (its
// key 'google|…', or a Google calendar id on a create) goes to google-item.ts (3b spec
// §3.3), which shares this file's rules and goes through the bot's provider. Every write goes
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
  NativeDestinationError,
  NativeFixedDaysError,
  NativeNotFoundError,
  NativePermissionDeniedError,
  NativeRecipientError,
  NativeHebrewKindError,
  NativeRuleError,
  NativeScopeError,
  createNativeEvent,
  decodeCalendarId,
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
import { classifyRule, type HebrewRule } from '../native-calendar/recurrence';
import { isForPartner, itemZone, loadItem, wallFor, type LoadedItem } from './item-info';
import { endFollows, isHebrewChoice, itemKeyOf, isTime, type CreateCommand, type DeleteCommand, type UpdateCommand } from './validate';
import { sourcesFor } from '../calendar-read/index';
import { defaultCalendarIdFor } from '../calendar-provider/user-calendars';
import { addDaysToDate, dayEnd, dayOfWall, dayStart, daysBetween, instantToWall, wallToInstant } from './walltime';

export type WriteResult =
  | { status: 'ok'; key?: string }
  | { status: 'invalid'; field: string }
  | { status: 'not_allowed' | 'not_found' | 'changed' }
  // 3b, Google: the connection needs the user (a dead token, or a write scope not granted),
  // or Google failed (a rate limit, a 5xx, a timeout, anything else; already logged).
  | { status: 'reconnect'; reason: 'token' | 'scopes' }
  | { status: 'failed' };

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
export function refusalOf(err: unknown): WriteResult | null {
  if (err instanceof NativePermissionDeniedError) return NOT_ALLOWED;
  if (err instanceof NativeNotFoundError) return NOT_FOUND;
  // A day move for more than this one of a rule with fixed days (the bot's BYDAY): the
  // editor offers only "Only this one" then (series.fixedDays).
  if (err instanceof NativeFixedDaysError) return { status: 'invalid', field: 'start' };
  // 3b's series-level fields (spec §3.1): a rule the store won't keep, a scope that can't
  // carry the change, a recipient who can't be pinged, a calendar it can't move to (never
  // not_found: the item is still there).
  // A Hebrew series switched to the other kind from an occurrence where that kind falls on
  // another day (hebrew-repeats spec §4): the editor says so, and retrying can't work.
  if (err instanceof NativeHebrewKindError) return { status: 'invalid', field: 'repeatKind' };
  if (err instanceof NativeRuleError) return { status: 'invalid', field: 'repeat' };
  if (err instanceof NativeScopeError) return { status: 'invalid', field: err.field };
  if (err instanceof NativeRecipientError) return { status: 'invalid', field: 'forPartner' };
  if (err instanceof NativeDestinationError) return { status: 'invalid', field: 'calendarId' };
  return null;
}

/**
 * Forget the recurrence rules kept for everyone who reads these calendars: the user, and
 * the partner when one of them is shared or the partner's, or the item is (or was) a
 * reminder for them. A calendar move passes both calendars, a recipient change both
 * recipients (3b spec §3.3).
 */
async function clearCaches(
  user: UserConfig,
  calendars: Array<Pick<NativeCalendar, 'ownerUserId' | 'privacy'>>,
  forUserIds: Array<number | null>
): Promise<void> {
  clearRecurrenceCacheForUser(user.id);
  const partnerId = await getPartnerUserId(user.id, user.pairingId ?? null);
  if (partnerId === null) return;
  if (calendars.some((c) => c.ownerUserId !== user.id || c.privacy !== 'PRIVATE') || forUserIds.includes(partnerId)) {
    clearRecurrenceCacheForUser(partnerId);
  }
}

/** The stored rule for a repeat choice, as the bot's provider stores it (no RRULE: prefix). */
export function ruleFor(repeat: CreateCommand['repeat']): string | null {
  if (repeat === 'none') return null;
  // The Hebrew kinds are a plain yearly rule plus the pair (hebrewKindFor).
  return buildRecurrenceRule({ frequency: isHebrewChoice(repeat) ? 'yearly' : repeat })[0].replace(/^RRULE:/, '');
}

/** The Hebrew kind a repeat choice stores next to its rule (hebrew-repeats spec §2), or null for a Gregorian one. */
export function hebrewKindFor(repeat: CreateCommand['repeat']): HebrewRule | null {
  return repeat === 'hebrew' ? 'anniversary' : repeat === 'yahrzeit' ? 'yahrzeit' : null;
}

/** A stored rule without its end and the parts that mean nothing for it (WKST, INTERVAL=1), to compare with a choice's. */
function withoutEnd(rule: string): string {
  return rule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter((p) => !/^(UNTIL|COUNT|WKST)=/i.test(p) && !/^INTERVAL=1$/i.test(p))
    .join(';')
    .toUpperCase();
}

/**
 * Whether picking `repeat` changes the stored rule (3b spec §2.1): another of the five, or
 * the same one for a rule that isn't the one that choice writes. A bot's "every Tuesday"
 * (BYDAY=TU) reads as 'weekly' but keeps its day; picked again, the rule follows the start.
 */
export function repeatChanges(repeat: CreateCommand['repeat'], rrule: string | null, current: string): boolean {
  if (repeat !== current) return true;
  return repeat !== 'none' && rrule !== null && withoutEnd(rrule) !== ruleFor(repeat);
}

/** The wall times of a create as instants: an all-day item from the start of its first day to 23:59 on its last. */
export function createTimes(cmd: CreateCommand, tz: string): { startsAt: Date; endsAt: Date } {
  if (cmd.allDay) return { startsAt: dayStart(cmd.start, tz), endsAt: dayEnd(cmd.end ?? cmd.start, tz) };
  const startsAt = wallToInstant(cmd.start, tz);
  return { startsAt, endsAt: cmd.end ? wallToInstant(cmd.end, tz) : new Date(startsAt.getTime() + HOUR_MS) };
}

export async function createItem(user: UserConfig, cmd: CreateCommand, tz: string): Promise<WriteResult> {
  // Per calendar (3b spec §3.3, "Google as a connection" §3): a Google id goes to Google;
  // an event with no id goes to the user's default calendar (defaultCalendarFor), a
  // reminder to the FamCal main calendar.
  const famcal = sourcesFor(user).includes('famcal');
  const placed = cmd.calendarId ?? (cmd.kind === 'event' ? await defaultCalendarIdFor(user) : null);
  if (placed && !placed.startsWith('native:')) {
    const { createGoogleItem } = await import('./google-item');
    return createGoogleItem(user, { ...cmd, calendarId: placed }, tz);
  }
  if (!famcal) return NOT_ALLOWED;
  try {
    const rrule = ruleFor(cmd.repeat);
    const hebrewRule = hebrewKindFor(cmd.repeat);
    const base = {
      creatorUserId: user.id,
      title: cmd.title,
      description: cmd.description || undefined,
      location: cmd.location || undefined,
      allDay: cmd.allDay,
      timeZone: tz,
      rrule,
      ...(hebrewRule ? { hebrewRule } : {}),
    };

    if (cmd.kind === 'event') {
      const calendarCuid = placed ? decodeCalendarId(placed) : (await getMainNativeCalendar(user.id)).id;
      if (!calendarCuid) return { status: 'invalid', field: 'calendarId' };
      const times = createTimes(cmd, tz);
      const event = await createNativeEvent({ ...base, ...times, calendarCuid });
      const calendar = await prisma.nativeCalendar.findUnique({ where: { id: event.calendarId } });
      if (calendar) await clearCaches(user, [calendar], [null]);
      trackActivityAsync(user.id, 'voice_event_created', { calendar_id: placed ?? `native:${calendarCuid}`, source: 'app' });
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
    if (calendar) await clearCaches(user, [calendar], [resolved.forUserId]);
    trackActivityAsync(user.id, 'voice_event_created', { calendar_id: resolved.calendarId, source: 'app' });
    trackActivityAsync(user.id, 'native_reminder_created', {
      for_partner: resolved.forUserId !== null,
      all_day: resolved.allDay,
      recurring: rrule !== null,
      source: 'app',
    });
    return { status: 'ok', key: itemKeyOf(reminder.id, rrule ? reminder.startsAt : undefined) };
  } catch (err) {
    const refused = refusalOf(err);
    if (refused) return refused;
    throw err;
  }
}

/**
 * The times an edit gives, in the wall form the editor speaks (3a's rules): what the body
 * leaves out stays, or follows. A moved start keeps the length, and a form change takes the
 * nearest sensible value. `occ` is the occurrence as it stands; all-day days are read in
 * `itemTz`, timed walls on the user's clock. The Google items share it (google-item.ts).
 */
export function resolveWallTimes(
  c: UpdateCommand['changes'],
  occ: { startsAt: Date; endsAt: Date; allDay: boolean },
  reminder: boolean,
  userTz: string,
  itemTz: string
): { ok: true; start: string; end: string; allDay: boolean; timeChanged: boolean } | { ok: false; field: 'start' | 'end' } {
  const was = wallFor(occ.startsAt, occ.endsAt, occ.allDay, userTz, itemTz);
  const wasEnd = reminder ? was.start : was.end;
  const allDay = c.allDay ?? occ.allDay;

  // The new times, in the form allDay says. What the body leaves out stays, or follows:
  // a moved start keeps the length, and a form change takes the nearest sensible value.
  let start: string;
  if (c.start !== undefined) {
    if (!isTime(c.start, allDay)) return { ok: false, field: 'start' };
    start = c.start;
  } else if (allDay === occ.allDay) {
    start = was.start;
  } else if (allDay) {
    start = dayOfWall(was.start);
  } else {
    return { ok: false, field: 'start' };
  }
  let end: string;
  if (reminder) {
    end = start;
  } else if (c.end !== undefined) {
    if (!isTime(c.end, allDay)) return { ok: false, field: 'end' };
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
  if (!reminder && !endFollows(start, end, allDay)) return { ok: false, field: 'end' };

  return { ok: true, start, end, allDay, timeChanged: allDay !== occ.allDay || start !== was.start || end !== wasEnd };
}

type Ok = Extract<LoadedItem, { status: 'ok' }>;

/** The scope the store is given: a one-off has only itself. */
const effectiveScope = (item: Ok, scope: UpdateCommand['scope']) => (item.series.rrule ? scope : 'single');

export async function updateItem(user: UserConfig, cmd: UpdateCommand, userTz: string): Promise<WriteResult> {
  if (cmd.key.source === 'google') {
    const { updateGoogleItem } = await import('./google-item');
    return updateGoogleItem(user, { ...cmd, key: cmd.key }, userTz);
  }
  const key = cmd.key;
  const item = await loadItem(user, key);
  if (item.status !== 'ok') return { status: item.status };
  if (!item.canEdit) return NOT_ALLOWED;
  const { series, occurrence: occ } = item;
  const reminder = series.kind === 'REMINDER';
  const itemTz = itemZone(series);
  const c = cmd.changes;
  const times = resolveWallTimes(c, occ, reminder, userTz, itemTz);
  if (!times.ok) return { status: 'invalid', field: times.field };
  const { start, end, allDay, timeChanged } = times;
  const text = {
    ...(c.title !== undefined && c.title !== occ.title ? { title: c.title } : {}),
    ...(c.location !== undefined && c.location !== (occ.location ?? '') ? { location: c.location } : {}),
    ...(c.description !== undefined && c.description !== (occ.description ?? '') ? { description: c.description } : {}),
  };

  // The series-level fields (3b spec §3.3), each only when it differs from what the item
  // has: a repeat other than the one the Repeat row shows, another calendar, the other
  // recipient (relative to the reminder's creator).
  const repeat = c.repeat !== undefined && repeatChanges(c.repeat, series.rrule, classifyRule(series.rrule, series.startsAt, itemTz, series).choice) ? c.repeat : undefined;
  const calendarCuid = c.calendarId !== undefined ? decodeCalendarId(c.calendarId) : null;
  const moveTo = calendarCuid !== null && calendarCuid !== series.calendarId ? calendarCuid : undefined;
  const forPartner = c.forPartner !== undefined && c.forPartner !== isForPartner(series, item.ctx) ? c.forPartner : undefined;
  if (forPartner !== undefined && (!reminder || (forPartner && !item.ctx.partner))) return { status: 'invalid', field: 'forPartner' };
  const forUserId = forPartner === undefined ? undefined : forPartner ? item.ctx.partner!.id : null;
  const seriesLevel = repeat !== undefined || moveTo !== undefined || forUserId !== undefined;
  const sameKey = itemKeyOf(series.id, key.slot);
  if (!timeChanged && Object.keys(text).length === 0 && !seriesLevel) return { status: 'ok', key: sameKey };

  // A repeat change applies from the opened occurrence on; a calendar or recipient change
  // needs a series scope, as an occurrence has neither of its own.
  let scope = effectiveScope(item, cmd.scope);
  if (series.rrule && repeat !== undefined) scope = 'following';
  else if (series.rrule && seriesLevel && scope === 'single') return { status: 'invalid', field: 'scope' };
  const stop = repeat === 'none' && Boolean(series.rrule);

  const startsAt = allDay ? dayStart(start, itemTz) : wallToInstant(start, userTz);
  const endsAt = reminder ? startsAt : allDay ? dayEnd(end, itemTz) : wallToInstant(end, userTz);
  const input: UpdateNativeEventInput = {
    seriesCuid: series.id,
    instanceStartsAt: series.rrule ? key.slot : undefined,
    scope,
    actingUserId: user.id,
    ...text,
    // The pair goes with the rule, null for a Gregorian choice (hebrew-repeats spec §2).
    ...(repeat !== undefined ? { rrule: ruleFor(repeat), hebrewRule: hebrewKindFor(repeat) } : {}),
    ...(moveTo !== undefined ? { calendarId: moveTo } : {}),
    ...(forUserId !== undefined ? { forUserId } : {}),
  };
  if (stop) {
    // The one-off is the opened occurrence as it stands with the form's edits on top: its
    // own times, never the series' (3b spec §3.1).
    Object.assign(input, {
      title: text.title ?? occ.title,
      location: text.location ?? occ.location ?? null,
      description: text.description ?? occ.description ?? null,
      startsAt,
      endsAt,
      allDay,
    });
  } else if (timeChanged) {
    if (scope === 'all' && series.rrule) {
      // The series moves as this occurrence did (by its days, to its new time of day): a rule
      // with no BYDAY (what the editor writes) follows its start, so the weekday moves with it;
      // the store refuses a day move on one with fixed days. Its own start is written only
      // when it moves, which carries what was skipped or renamed along; this occurrence is
      // then where its slot went (one moved on its own comes back to the rule's day).
      const moved = seriesTimesFor(series, occ.startsAt, { startsAt, endsAt, allDay });
      if (moved.startsAt.getTime() !== series.startsAt.getTime()) input.startsAt = moved.startsAt;
      input.endsAt = moved.endsAt;
    } else {
      input.startsAt = startsAt;
      input.endsAt = endsAt;
    }
    input.allDay = allDay;
  }

  try {
    const result = await updateNativeEvent(input);
    // Where the opened occurrence is now, as the store left it: a new part's, a one-off's
    // (no slot) or the same series' with its slot moved.
    const key = itemKeyOf(result.key.seriesId, result.key.slot ?? undefined);
    const { clearedPings, changedPings, reassignedPings } = result;
    if (clearedPings.length + changedPings.length + reassignedPings.length > 0) {
      // The pings still on screen say where the reminder went, that it changed, or who it is
      // for now (best-effort, as for the bot).
      const original = toUnifiedEvent(item.calendar, occ, series);
      const name = forUserId ? (item.ctx.partner?.name ?? '') : user.name;
      await stripMovedPings(
        clearedPings,
        original,
        { title: text.title, startTime: startsAt, endTime: endsAt, allDay },
        user,
        changedPings.length + reassignedPings.length > 0 ? { changed: changedPings, reassigned: { pings: reassignedPings, name } } : undefined
      );
    }
    const destination = moveTo !== undefined ? await prisma.nativeCalendar.findUnique({ where: { id: moveTo } }) : null;
    await clearCaches(user, destination ? [item.calendar, destination] : [item.calendar], [series.forUserId, ...(forUserId !== undefined ? [forUserId] : [])]);
    const changedFields = [
      ...(text.title !== undefined ? ['title'] : []),
      ...(text.location !== undefined ? ['location'] : []),
      ...(text.description !== undefined ? ['description'] : []),
      ...(timeChanged ? ['time'] : []),
      ...(repeat !== undefined ? ['repeat'] : []),
      ...(moveTo !== undefined ? ['calendar'] : []),
      ...(forUserId !== undefined ? ['recipient'] : []),
    ];
    trackActivityAsync(user.id, 'calendar_item_edited', { kind: reminder ? 'reminder' : 'event', scope, source: 'app', provider: 'famcal', changed_fields: changedFields });
    return { status: 'ok', key };
  } catch (err) {
    const refused = refusalOf(err);
    if (refused) return refused;
    throw err;
  }
}

export async function deleteItem(user: UserConfig, cmd: DeleteCommand): Promise<WriteResult> {
  if (cmd.key.source === 'google') {
    const { deleteGoogleItem } = await import('./google-item');
    return deleteGoogleItem(user, { ...cmd, key: cmd.key });
  }
  const key = cmd.key;
  const item = await loadItem(user, key);
  if (item.status !== 'ok') return { status: item.status };
  if (!item.canDelete) return NOT_ALLOWED;
  const scope = effectiveScope(item, cmd.scope);
  try {
    await deleteNativeEvent({
      seriesCuid: item.series.id,
      instanceStartsAt: item.series.rrule ? key.slot : undefined,
      scope,
      actingUserId: user.id,
    });
    await clearCaches(user, [item.calendar], [item.series.forUserId]);
    trackActivityAsync(user.id, 'calendar_item_deleted', { kind: item.series.kind === 'REMINDER' ? 'reminder' : 'event', scope, source: 'app', provider: 'famcal' });
    return { status: 'ok' };
  } catch (err) {
    const refused = refusalOf(err);
    if (refused) return refused;
    throw err;
  }
}
