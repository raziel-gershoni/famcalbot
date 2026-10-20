// The cross-source move ("Google as a connection" spec §5): an event picked onto a calendar
// of the other kind in the editor's Calendar row moves there. A copy is made there, whole,
// and only then is the original deleted. Within one kind the 3b moves stay (the store's
// calendar change, Google's events.move); this file is only the crossing.
//
// - Saved alone: a move carries no other change (the editor says so before it sends).
// - A series moves whole ('all'); a one-off is 'single'.
// - Eligibility is the mapper's (meet, hebrew, repeat) plus who may move it: a Google event
//   must pass 3b's editable test (a series: its master and every exception too, since the
//   master's delete takes them all), a FamCal one must be the user's own event on their own
//   calendar (a partner's never leaves the partner's view).
// - One move per source series at a time: a fail-closed Redis NX lock with its own prefix,
//   held for the whole run and released in finally. A Redis error refuses the move.
// - Failure order: a copy that fails part-way is deleted and the original is untouched; a
//   part-way copy that can't be deleted is reported with both ids, and the user is asked
//   to try again (the retry replaces it).
//   When the original's delete fails it is read again: gone, the move is done; present,
//   the copy is taken back ("Couldn't move"); unreadable, or a take-back that fails, both
//   are left and reported with both ids ("Moved, but the old one is still in …").
// - A retry into Google first looks for an earlier copy in the destination only (by the
//   famcalMovedFrom private property) and repairs it in full before the original goes: the
//   earlier copy is taken back and a whole new one made, so nothing the FamCal series no
//   longer has (notes, a place, an override, its repeat) stays behind.
//
// Logs carry ids and classes, never a title.

import type { calendar_v3 } from '@googleapis/calendar';
import type { NativeCalendar } from '@prisma/client';
import type { UserConfig } from '../../types';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { liveGoogleChoices } from '../../lib/google-state';
import { localDate } from '../../utils/day-events';
import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { trackActivityAsync } from '../analytics-service';
import { getCalendarClient, scrubbedGoogleError } from '../calendar';
import { googleCalendarRef, stampGoogleCache } from '../calendar-read/google';
import { classifyGoogleError } from '../calendar-read/google-map';
import { editableInHome, failureOutcome, googleEditorCalendars, loadGoogleItem } from '../calendar-write/google-item';
import { loadItem, writableCalendarRows } from '../calendar-write/item-info';
import { googleKeyOf, itemKeyOf, type GoogleItemKey, type ItemKey, type UpdateCommand } from '../calendar-write/validate';
import { clearCaches, scrubbed, type WriteResult } from '../calendar-write/write';
import {
  NativeDestinationError,
  NativeNotFoundError,
  NativePermissionDeniedError,
  NativeRuleError,
  canWriteAccess,
  createNativeSeries,
  deleteNativeEvent,
} from '../native-calendar/event-store';
import { MOVED_FROM, fromGoogleEvent, googleCrossRefusal, googleSlotOf, isInstanceAt, toGoogleEvent, type CrossRefusal } from './mapper';

type GClient = calendar_v3.Calendar;
type Scope = UpdateCommand['scope'];

/** Longer than the slowest move (a patch per override); a crashed run frees it by then. */
const LOCK_TTL_S = 300;
const DAY_MS = 86_400_000;
const NOT_ALLOWED: WriteResult = { status: 'not_allowed' };
const MOVE_FAILED: WriteResult = { status: 'move_failed' };
const BAD_CALENDAR: WriteResult = { status: 'invalid', field: 'calendarId' };
const REFUSAL_FIELD: Record<CrossRefusal, string> = { meet: 'moveMeet', hebrew: 'moveHebrew', repeat: 'moveRepeat' };
const refused = (reason: CrossRefusal): WriteResult => ({ status: 'invalid', field: REFUSAL_FIELD[reason] });

/** A mapped override whose instance Google doesn't produce: the repeat can't cross after all. */
class InstanceMissingError extends Error {
  constructor() {
    super('Google has no instance at an override slot');
    this.name = 'InstanceMissingError';
  }
}

/** The series a Google key's event belongs to, for the lock: an instance id is '<master>_<stamp>'. */
const seriesBase = (eventId: string) => eventId.split('_')[0];

async function takeLock(key: string, userId: number): Promise<'taken' | 'busy' | 'error'> {
  try {
    return (await redis.set(key, String(Date.now()), { nx: true, ex: LOCK_TTL_S })) === 'OK' ? 'taken' : 'busy';
  } catch (error) {
    // Fail closed: two moves at once could each copy the event and each delete the original.
    captureError(error, 'calendar-move-lock', { user_id: userId, step: 'take' });
    return 'error';
  }
}

async function releaseLock(key: string, userId: number): Promise<void> {
  try {
    await redis.del(key);
  } catch (error) {
    // The TTL frees it; the move itself already has its outcome.
    captureError(error, 'calendar-move-lock', { user_id: userId, step: 'release' }, 'warning');
  }
}

/** A Google failure as the move's outcome, logged by class and ids. */
function googleFailure(error: unknown, context: string, extra: Record<string, unknown>): WriteResult {
  const cls = classifyGoogleError(error);
  captureError(scrubbedGoogleError(error, cls), context, extra, cls === 'transient' || cls === 'gone' ? 'warning' : 'error');
  return failureOutcome(cls);
}

/** PATCH /api/calendar/items with a calendar of the other kind: the cross-source move. */
export async function moveAcrossKinds(user: UserConfig, cmd: UpdateCommand, userTz: string): Promise<WriteResult> {
  const { calendarId: to, ...others } = cmd.changes;
  if (to === undefined) return BAD_CALENDAR;
  // Saved alone (spec §5): the editor says "Save the move on its own first" before it sends.
  if (Object.keys(others).length > 0) return { status: 'invalid', field: 'moveAlone' };
  const key = cmd.key;
  const lockKey = key.source === 'famcal' ? REDIS_KEYS.calendarMoveLock('famcal', key.seriesCuid) : REDIS_KEYS.calendarMoveLock('google', `${key.calendarId}|${seriesBase(key.eventId)}`);
  const lock = await takeLock(lockKey, user.id);
  if (lock === 'busy') {
    console.log(`[Move] user ${user.id}: another move of this series is running`);
    return { status: 'busy' };
  }
  if (lock === 'error') return { status: 'failed' };
  const run = { touchedGoogle: false };
  try {
    return key.source === 'famcal'
      ? await famcalToGoogle(user, key, cmd.scope, to, run)
      : await googleToFamcal(user, key, cmd.scope, to, userTz, run);
  } finally {
    // As every Google write does (writeThenStamp): the home's next read is not a stale one.
    if (run.touchedGoogle) await stampGoogleCache(user.id);
    await releaseLock(lockKey, user.id);
  }
}

// ---- FamCal → Google ----

/** An earlier attempt's copy in `calendarId` (never another calendar), by its private marker. */
async function findMovedCopy(client: GClient, calendarId: string, seriesId: string): Promise<string | null> {
  const res = await client.events.list({ calendarId, privateExtendedProperty: [`${MOVED_FROM}=${seriesId}`], showDeleted: false, singleEvents: false, maxResults: 10 });
  const found = (res.data.items ?? []).find((e) => e.id && e.status !== 'cancelled' && !e.recurringEventId);
  return found?.id ?? null;
}

/**
 * The instance of `eventId` at a FamCal slot, by events.instances({ originalStart }) and
 * matched as an instant (a date all day). Google documents originalStart for timed
 * instances; for an all-day one (the date) it isn't, so a miss asks the days around the slot.
 */
async function instanceAt(client: GClient, calendarId: string, eventId: string, slot: Date, originalStart: string, allDay: boolean, zone: string): Promise<string | null> {
  const asked = await client.events.instances({ calendarId, eventId, originalStart, maxResults: 5 });
  const hit = (asked.data.items ?? []).find((i) => isInstanceAt(i, slot, allDay, zone));
  if (hit?.id) return hit.id;
  const around = await client.events.instances({
    calendarId,
    eventId,
    timeMin: new Date(slot.getTime() - 2 * DAY_MS).toISOString(),
    timeMax: new Date(slot.getTime() + 3 * DAY_MS).toISOString(),
    maxResults: 50,
  });
  return (around.data.items ?? []).find((i) => isInstanceAt(i, slot, allDay, zone))?.id ?? null;
}

/** Deletes a Google copy this move made. True when it is gone. */
async function takeBackGoogleCopy(client: GClient, calendarId: string, copyId: string, extra: Record<string, unknown>): Promise<boolean> {
  try {
    await client.events.delete({ calendarId, eventId: copyId });
    return true;
  } catch (error) {
    const cls = classifyGoogleError(error);
    if (cls === 'gone') return true;
    captureError(scrubbedGoogleError(error, cls), 'calendar-move-take-back', { ...extra, copy_id: copyId });
    return false;
  }
}

/** A FamCal series read again after its delete failed: gone, present, or unreadable. */
async function famcalStillThere(seriesId: string, extra: Record<string, unknown>): Promise<'gone' | 'present' | 'unknown'> {
  try {
    const row = await prisma.nativeEvent.findUnique({ where: { id: seriesId }, select: { isDeleted: true } });
    return !row || row.isDeleted ? 'gone' : 'present';
  } catch (error) {
    captureError(scrubbed(error), 'calendar-move-reread', extra);
    return 'unknown';
  }
}

/** Both are left: the copy and the original. Reported with both ids; the user is told where the old one is. */
function leftBehind(extra: Record<string, unknown>, key: string | undefined, calendarName: string): WriteResult {
  captureError(new Error('A moved event was copied but its original is still there'), 'calendar-move-left', extra);
  return { status: 'ok', ...(key ? { key } : {}), leftIn: calendarName };
}

/**
 * A copy that failed part-way and couldn't be taken back: both are left. Reported with both
 * ids; the user is asked to try again ("Couldn't move"), and the retry finds this copy by
 * its marker and replaces it.
 */
function partCopyLeft(extra: Record<string, unknown>): WriteResult {
  captureError(new Error('A part-way copy could not be taken back; its original is still there'), 'calendar-move-left', extra);
  return MOVE_FAILED;
}

async function famcalToGoogle(user: UserConfig, key: ItemKey, scope: Scope, to: string, run: { touchedGoogle: boolean }): Promise<WriteResult> {
  const item = await loadItem(user, key);
  if (item.status !== 'ok') return { status: item.status };
  const { series, calendar, overrides } = item;
  if (!canWriteAccess(item.access)) return NOT_ALLOWED;
  // A reminder has no Calendar row; a partner's event never leaves the partner's view.
  if (series.kind === 'REMINDER' || calendar.ownerUserId !== user.id) return BAD_CALENDAR;
  if (!user.googleRefreshToken) {
    // A legacy Google user's chosen calendar with the token gone: reconnect (as createGoogleItem).
    return liveGoogleChoices(user).some((a) => a.calendarId === to) ? { status: 'reconnect', reason: 'token' } : BAD_CALENDAR;
  }
  const { calendars, failure } = await googleEditorCalendars(user);
  if (failure) return failureOutcome(failure);
  if (!calendars.some((c) => c.id === to)) return BAD_CALENDAR;
  if (series.rrule && scope !== 'all') return { status: 'invalid', field: 'scope' };
  const mapped = toGoogleEvent(series, overrides);
  if (!mapped.ok) return refused(mapped.reason);
  const { copy } = mapped;

  const client = getCalendarClient(user.googleRefreshToken);
  const ids: Record<string, unknown> = { user_id: user.id, series_id: series.id, from_calendar_id: `native:${calendar.id}`, to_calendar_id: to };
  run.touchedGoogle = true;

  // 1. The copy, new and whole. An earlier attempt's copy in the destination is taken back
  //    first (a patch can't clear what the FamCal series lost since: notes, a place, an
  //    override, its repeat), so there is never a second one beside it.
  let copyId: string;
  let replaced: string | undefined;
  try {
    const found = await findMovedCopy(client, to, series.id);
    if (found) {
      try {
        await client.events.delete({ calendarId: to, eventId: found });
      } catch (error) {
        if (classifyGoogleError(error) !== 'gone') throw error;
      }
      replaced = found;
    }
    const made = await client.events.insert({ calendarId: to, requestBody: copy.event });
    if (!made.data.id) throw new Error('Google answered an insert with no id');
    copyId = made.data.id;
  } catch (error) {
    // An insert that failed made nothing to take back; a copy it made after all carries the marker for the retry.
    return googleFailure(error, 'calendar-move-copy', { ...ids, ...(replaced ? { replaced_copy_id: replaced } : {}) });
  }
  Object.assign(ids, { copy_id: copyId, ...(replaced ? { replaced_copy_id: replaced } : {}) });

  // 2. Every override on its instance; the copy is whole before the original goes.
  try {
    for (const x of copy.exceptions) {
      const instance = await instanceAt(client, to, copyId, x.slot, x.originalStart, copy.allDay, copy.zone);
      if (!instance) throw new InstanceMissingError();
      await client.events.patch({ calendarId: to, eventId: instance, requestBody: x.patch });
    }
  } catch (error) {
    const takenBack = await takeBackGoogleCopy(client, to, copyId, ids);
    let outcome: WriteResult;
    if (error instanceof InstanceMissingError) {
      captureError(error, 'calendar-move-copy', ids, 'warning');
      outcome = refused('repeat');
    } else {
      outcome = googleFailure(error, 'calendar-move-copy', ids);
    }
    // The refusal is final only when the copy is gone; a copy left behind asks for a retry, which replaces it.
    return takenBack ? outcome : partCopyLeft(ids);
  }

  // The opened occurrence's key on the copy (only a key: a miss closes the sheet, it fails nothing).
  let newKey: string | undefined = googleKeyOf(to, copyId);
  if (series.rrule && key.slot) {
    try {
      const instance = await instanceAt(client, to, copyId, key.slot, copy.allDay ? localDate(key.slot, copy.zone) : key.slot.toISOString(), copy.allDay, copy.zone);
      newKey = instance ? googleKeyOf(to, instance) : undefined;
    } catch (error) {
      captureError(scrubbedGoogleError(error, classifyGoogleError(error)), 'calendar-move-key', ids, 'warning');
      newKey = undefined;
    }
  }

  // 3. The original goes.
  try {
    await deleteNativeEvent({ seriesCuid: series.id, scope: series.rrule ? 'all' : 'single', actingUserId: user.id });
  } catch (error) {
    captureError(scrubbed(error), 'calendar-move-delete-original', ids);
    const state = await famcalStillThere(series.id, ids);
    if (state === 'present') {
      if (await takeBackGoogleCopy(client, to, copyId, ids)) return { status: 'move_failed' };
      return leftBehind(ids, newKey, calendar.name);
    }
    if (state === 'unknown') return leftBehind(ids, newKey, calendar.name);
  }
  await clearCaches(user, [calendar], [null]);
  moved(user, ids, 'famcal', 'google', Boolean(series.rrule));
  return { status: 'ok', ...(newKey ? { key: newKey } : {}) };
}

// ---- Google → FamCal ----

/** Every item sharing the master's iCalUID: the master, its exceptions, and anything else the filter drops. */
async function listByICalUID(client: GClient, calendarId: string, iCalUID: string): Promise<calendar_v3.Schema$Event[]> {
  const items: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.events.list({ calendarId, iCalUID, singleEvents: false, showDeleted: true, maxResults: 2500, ...(pageToken ? { pageToken } : {}) });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return items;
}

/** A Google original read again after its delete failed: gone (404, 410, cancelled), present, or unreadable. */
async function googleStillThere(client: GClient, calendarId: string, eventId: string, extra: Record<string, unknown>): Promise<'gone' | 'present' | 'unknown'> {
  try {
    const res = await client.events.get({ calendarId, eventId });
    return res.data.status === 'cancelled' ? 'gone' : 'present';
  } catch (error) {
    const cls = classifyGoogleError(error);
    if (cls === 'gone') return 'gone';
    captureError(scrubbedGoogleError(error, cls), 'calendar-move-reread', extra);
    return 'unknown';
  }
}

/** Deletes the FamCal copy this move made. True when it is gone. */
async function takeBackNativeCopy(seriesId: string, userId: number, extra: Record<string, unknown>): Promise<boolean> {
  try {
    await deleteNativeEvent({ seriesCuid: seriesId, scope: 'all', actingUserId: userId });
    return true;
  } catch (error) {
    captureError(scrubbed(error), 'calendar-move-take-back', extra);
    return false;
  }
}

async function googleToFamcal(user: UserConfig, key: GoogleItemKey, scope: Scope, to: string, userTz: string, run: { touchedGoogle: boolean }): Promise<WriteResult> {
  const loaded = await loadGoogleItem(user, key, userTz);
  if (loaded.status === 'not_found') return { status: 'not_found' };
  if (loaded.status === 'error') return loaded.result;
  // 3b's editable test: no other guests, the organizer, a default event, not locked, writable.
  // For a series the master's too (below, with every exception): its delete takes them all.
  if (!loaded.editable || !user.googleRefreshToken) return NOT_ALLOWED;
  const { read, assignment } = loaded;
  const masterId = read.master?.id ?? key.eventId;
  const target = (await writableCalendarRows(user)).find((r) => r.entry.id === to);
  if (!target) return BAD_CALENDAR;
  if (read.master && scope !== 'all') return { status: 'invalid', field: 'scope' };
  if (googleCrossRefusal({ ...read.event, recurrence: undefined }) === 'meet') return refused('meet');

  const client = getCalendarClient(user.googleRefreshToken);
  const ids: Record<string, unknown> = { user_id: user.id, event_id: masterId, from_calendar_id: key.calendarId, to_calendar_id: to };
  const master = read.master ?? read.event;
  let listed: calendar_v3.Schema$Event[] = [];
  if (read.master) {
    if (!editableInHome(master)) return NOT_ALLOWED;
    if (master.iCalUID) {
      try {
        listed = await listByICalUID(client, key.calendarId, master.iCalUID);
      } catch (error) {
        return googleFailure(error, 'calendar-move-read', ids);
      }
    } else {
      captureError(new Error('A Google series with no iCalUID: its exceptions cannot be listed'), 'calendar-move-read', ids, 'warning');
    }
    // An occurrence with its own guests (one invited to it alone, or left out) would lose
    // them: the copy has no guests, and the master's delete cancels their invitation.
    const guarded = listed.filter((e) => e.recurringEventId === master.id && e.id !== master.id && e.status !== 'cancelled');
    if (guarded.some((e) => !editableInHome(e))) {
      console.log(`[Move] user ${user.id}: an occurrence of ${masterId} has guests or isn't editable; not moved`);
      return NOT_ALLOWED;
    }
  }
  const mapped = fromGoogleEvent(master, listed, read.calendarTimeZone ?? userTz);
  if (!mapped.ok) return refused(mapped.reason);
  const copy = mapped.series;

  // 1. The copy, whole, in one transaction.
  let made: { id: string };
  try {
    made = await createNativeSeries({ calendarCuid: target.calendar.id, creatorUserId: user.id, ...copy });
  } catch (error) {
    if (error instanceof NativeRuleError) return refused('repeat');
    if (error instanceof NativePermissionDeniedError) return NOT_ALLOWED;
    if (error instanceof NativeNotFoundError || error instanceof NativeDestinationError) return BAD_CALENDAR;
    captureError(scrubbed(error), 'calendar-move-copy', ids);
    return { status: 'failed' };
  }
  Object.assign(ids, { copy_id: made.id });
  const slot = read.master ? googleSlotOf(read.event, copy.timeZone) : null;
  const newKey = itemKeyOf(made.id, slot ?? undefined);

  // 2. The original goes: the master takes every occurrence and exception with it.
  run.touchedGoogle = true;
  try {
    await client.events.delete({ calendarId: key.calendarId, eventId: masterId });
  } catch (error) {
    const cls = classifyGoogleError(error);
    if (cls !== 'gone') {
      captureError(scrubbedGoogleError(error, cls), 'calendar-move-delete-original', ids);
      const state = await googleStillThere(client, key.calendarId, masterId, ids);
      const name = googleCalendarRef(assignment, []).name;
      if (state === 'present') {
        if (await takeBackNativeCopy(made.id, user.id, ids)) return { status: 'move_failed' };
        return leftBehind(ids, newKey, name);
      }
      if (state === 'unknown') return leftBehind(ids, newKey, name);
    }
  }
  await clearCaches(user, [target.calendar as Pick<NativeCalendar, 'ownerUserId' | 'privacy'>], [null]);
  moved(user, ids, 'google', 'famcal', Boolean(read.master));
  return { status: 'ok', key: newKey };
}

/** A move that took: its log line (ids only) and its analytics. */
function moved(user: UserConfig, ids: Record<string, unknown>, from: 'famcal' | 'google', to: 'famcal' | 'google', recurring: boolean): void {
  console.log(`[Move] user ${user.id} moved ${from} ${String(ids.series_id ?? ids.event_id)} to ${to} ${String(ids.copy_id)}${ids.replaced_copy_id ? ` (replacing an earlier copy ${String(ids.replaced_copy_id)})` : ''}`);
  trackActivityAsync(user.id, 'calendar_item_moved', { from, to, recurring, source: 'app' });
}
