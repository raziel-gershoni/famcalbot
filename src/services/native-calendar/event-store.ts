// CRUD layer for the native calendar tables.
//
// All cross-user permission checks live here. The NativeCalendarProvider sits on
// top and translates between UnifiedEvent / UnifiedCalendar shapes and these
// internal entities. Voice CRUD never bypasses this module — that keeps the
// owner/partner edit rules in exactly one place.

import { Prisma } from '@prisma/client';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type {
  NativeCalendar,
  NativeEvent,
  NativeEventInstance,
  NativeCalendarPrivacy,
  User,
} from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { TIMEZONE } from '../../config/constants';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { invalidateDueGate } from '../native-reminders/due-gate';
import { effectiveOwnerId, getActivePartnerSummary } from '../native-reminders/ownership';
import { ensurePrimaryNativeCalendar } from './onboarding';
import { expandSeries, shiftOnWall, truncateRruleBefore, VirtualInstance } from './recurrence';

export const NATIVE_CALENDAR_ID_PREFIX = 'native:';
export const NATIVE_EVENT_INSTANCE_SEP = '#';

/**
 * Encode a native calendar's database id as the prefixed form used in
 * UnifiedCalendar / UnifiedEvent / voice prompt assignments.
 */
export function encodeCalendarId(cuid: string): string {
  return `${NATIVE_CALENDAR_ID_PREFIX}${cuid}`;
}

export function decodeCalendarId(prefixed: string): string | null {
  if (!prefixed.startsWith(NATIVE_CALENDAR_ID_PREFIX)) return null;
  return prefixed.slice(NATIVE_CALENDAR_ID_PREFIX.length);
}

export function isNativeCalendarId(prefixed: string): boolean {
  return prefixed.startsWith(NATIVE_CALENDAR_ID_PREFIX);
}

/**
 * Encode a native event id. For a single (non-recurring) event the id is just
 * the NativeEvent.id cuid; for a specific occurrence of a recurring series it
 * is `<seriesCuid>#<originalStartsAt.toISOString()>`. The series id alone is
 * also accepted (used as recurringEventId on UnifiedEvent).
 */
export function encodeEventId(seriesCuid: string, instanceStartsAt?: Date): string {
  if (!instanceStartsAt) return seriesCuid;
  return `${seriesCuid}${NATIVE_EVENT_INSTANCE_SEP}${instanceStartsAt.toISOString()}`;
}

export function decodeEventId(id: string): { seriesCuid: string; instanceStartsAt?: Date } {
  const idx = id.indexOf(NATIVE_EVENT_INSTANCE_SEP);
  if (idx === -1) return { seriesCuid: id };
  return {
    seriesCuid: id.slice(0, idx),
    instanceStartsAt: new Date(id.slice(idx + 1)),
  };
}

// --- Pairing / permission helpers ------------------------------------------

/**
 * Resolve the partner of a user given their pairingId, or null if not paired.
 * Returns the OTHER member of an ACTIVE pairing.
 */
export async function getPartnerUserId(userId: number, pairingId: string | null): Promise<number | null> {
  if (!pairingId) return null;
  const pair = await prisma.pairing.findUnique({
    where: { id: pairingId },
    select: { id: true, status: true, inviterUserId: true, inviteeUserId: true },
  });
  if (!pair || pair.status !== 'ACTIVE') return null;
  return pair.inviterUserId === userId ? pair.inviteeUserId : pair.inviterUserId;
}

/**
 * Permission level a user has on a given native calendar.
 * - 'owner'  : full read/write/delete + privacy management
 * - 'editor' : read + write (partner with SHARED_EDITOR access)
 * - 'viewer' : read only (partner with SHARED_VIEWER access)
 * - 'none'   : no access (private calendar of someone else, or unrelated user)
 */
export type NativeAccess = 'owner' | 'editor' | 'viewer' | 'none';

export async function getCalendarAccess(
  user: Pick<User, 'id' | 'pairingId'>,
  calendar: Pick<NativeCalendar, 'ownerUserId' | 'privacy' | 'isDeleted'>
): Promise<NativeAccess> {
  if (calendar.isDeleted) return 'none';
  if (calendar.ownerUserId === user.id) return 'owner';
  const partnerId = await getPartnerUserId(user.id, user.pairingId ?? null);
  if (partnerId !== calendar.ownerUserId) return 'none';
  if (calendar.privacy === 'SHARED_EDITOR') return 'editor';
  if (calendar.privacy === 'SHARED_VIEWER') return 'viewer';
  return 'none'; // PRIVATE
}

export function canWriteAccess(access: NativeAccess): boolean {
  return access === 'owner' || access === 'editor';
}

// --- Calendar listing -------------------------------------------------------

/**
 * List calendars visible to the user: own (any privacy) + paired-partner's
 * SHARED_VIEWER / SHARED_EDITOR calendars. Excludes soft-deleted rows.
 */
export async function listVisibleCalendars(userId: number, pairingId: string | null): Promise<NativeCalendar[]> {
  const partnerId = await getPartnerUserId(userId, pairingId);
  const where: Prisma.NativeCalendarWhereInput = {
    isDeleted: false,
    OR: [
      { ownerUserId: userId },
      ...(partnerId
        ? [{ ownerUserId: partnerId, privacy: { in: ['SHARED_VIEWER', 'SHARED_EDITOR'] as NativeCalendarPrivacy[] } }]
        : []),
    ],
  };
  return prisma.nativeCalendar.findMany({ where, orderBy: [{ createdAt: 'asc' }] });
}

/**
 * The calendar a user's reminders go on: their own calendar labelled primary, else
 * their oldest own calendar, else the one onboarding creates. Never the partner's:
 * a partner's calendar keeps its owner's 'primary' label and listVisibleCalendars
 * orders both partners' calendars together, so neither can tell them apart.
 */
export async function getMainNativeCalendar(userId: number): Promise<NativeCalendar> {
  const findOwn = async () => {
    const own = await prisma.nativeCalendar.findMany({
      where: { ownerUserId: userId, isDeleted: false },
      orderBy: [{ createdAt: 'asc' }],
    });
    return own.find((c) => c.labels.includes('primary')) ?? own[0];
  };
  const existing = await findOwn();
  if (existing) return existing;
  await ensurePrimaryNativeCalendar(userId);
  const created = await findOwn();
  if (!created) throw new NativeNotFoundError('User has no native calendar');
  return created;
}

// --- Events: read -----------------------------------------------------------

export interface FetchRange {
  from: Date;
  to: Date;
}

/** One occurrence as the store reads it: its calendar, its series row and the expanded instance. */
export interface NativeEventRow {
  calendar: NativeCalendar;
  series: NativeEvent;
  instance: VirtualInstance;
}

/**
 * The SQL candidate filter for a range. Recurring series (rrule != null) get
 * filtered later by expansion; one-offs are filtered cheaply at the SQL level
 * by overlap, with the same rule expandSeries applies.
 */
function rangeCandidates(range: FetchRange): Prisma.NativeEventWhereInput[] {
  return [
    // single-event: overlaps the range - starts before it ends and is still
    // running when it opens. One starting inside the range always counts,
    // whatever its end says.
    {
      rrule: null,
      startsAt: { lt: range.to },
      OR: [{ startsAt: { gte: range.from } }, { endsAt: { gt: range.from } }],
    },
    // recurring: every series that has begun by range.to, and any with an
    // occurrence moved to before it - a first occurrence moved earlier than the
    // series start would otherwise never load. No UNTIL filter at SQL level:
    // expandSeries handles bounded series and puts a moved occurrence where it
    // landed.
    {
      rrule: { not: null },
      OR: [
        { startsAt: { lt: range.to } },
        { instances: { some: { status: 'OVERRIDE', startsAt: { lt: range.to } } } },
      ],
    },
  ];
}

/**
 * Expand candidate series over a range with their overrides, keeping those whose
 * calendar is in `calendarsById` (the non-deleted ones), sorted by start.
 */
async function expandCandidates(
  series: NativeEvent[],
  calendarsById: Map<string, NativeCalendar>,
  range: FetchRange
): Promise<NativeEventRow[]> {
  const seriesIds = series.map((s) => s.id);
  const instances = await prisma.nativeEventInstance.findMany({
    where: { seriesEventId: { in: seriesIds } },
  });
  const instancesBySeries = new Map<string, NativeEventInstance[]>();
  for (const inst of instances) {
    const arr = instancesBySeries.get(inst.seriesEventId) ?? [];
    arr.push(inst);
    instancesBySeries.set(inst.seriesEventId, arr);
  }

  const out: NativeEventRow[] = [];
  for (const s of series) {
    const calendar = calendarsById.get(s.calendarId);
    if (!calendar) continue;
    const overrides = instancesBySeries.get(s.id) ?? [];
    const expanded = expandSeries(s, range, overrides);
    for (const inst of expanded) {
      out.push({ calendar, series: s, instance: inst });
    }
  }

  out.sort((a, b) => a.instance.startsAt.getTime() - b.instance.startsAt.getTime());
  return out;
}

/**
 * Fetch all events (single + recurring expanded) across a set of calendars
 * that overlap a date range, the way Google's events.list returns them: a
 * Monday 22:00 to Tuesday 02:00 event comes back for both days, and the summary
 * shaping (src/utils/day-events.ts) decides how each day shows it. The caller
 * is responsible for permission filtering (typically by passing in calendars
 * from listVisibleCalendars).
 */
export async function fetchEventsInCalendars(calendarCuids: string[], range: FetchRange): Promise<NativeEventRow[]> {
  if (calendarCuids.length === 0) return [];

  const calendars = await prisma.nativeCalendar.findMany({
    where: { id: { in: calendarCuids }, isDeleted: false },
  });
  const calendarsById = new Map(calendars.map((c) => [c.id, c]));

  const series = await prisma.nativeEvent.findMany({
    where: { calendarId: { in: calendarCuids }, isDeleted: false, OR: rangeCandidates(range) },
  });

  if (series.length === 0) return [];
  return expandCandidates(series, calendarsById, range);
}

/**
 * The reminders `creatorUserId` set for `forUserId` that occur in a range, on any
 * non-deleted calendar whatever its privacy: the person a reminder is for sees it on
 * its day even when it sits on the creator's PRIVATE calendar (spec §2). Same candidate
 * filter and row shape as fetchEventsInCalendars. Like it, no permission check: the
 * caller passes an active pair.
 */
export async function fetchRemindersForUserInRange(
  forUserId: number,
  creatorUserId: number,
  range: FetchRange
): Promise<NativeEventRow[]> {
  const series = await prisma.nativeEvent.findMany({
    where: { kind: 'REMINDER', forUserId, creatorUserId, isDeleted: false, OR: rangeCandidates(range) },
  });
  if (series.length === 0) return [];

  const calendars = await prisma.nativeCalendar.findMany({
    where: { id: { in: [...new Set(series.map((s) => s.calendarId))] }, isDeleted: false },
  });
  return expandCandidates(series, new Map(calendars.map((c) => [c.id, c])), range);
}

/** What the readers need of a reminder occurrence's NativeReminderState row. */
export interface ReminderStateRow {
  seriesEventId: string;
  originalStartsAt: Date;
  doneAt: Date | null;
  snoozedUntil: Date | null;
}

/**
 * The state rows of these reminder occurrences, in one query. An occurrence without
 * a row is still pending. A few extra rows can come back (another series' occurrence
 * at one of the same times), so callers look rows up by their exact key.
 */
export async function fetchReminderStates(
  occurrences: Array<{ seriesEventId: string; originalStartsAt: Date }>
): Promise<ReminderStateRow[]> {
  if (occurrences.length === 0) return [];
  return prisma.nativeReminderState.findMany({
    where: {
      seriesEventId: { in: [...new Set(occurrences.map((o) => o.seriesEventId))] },
      originalStartsAt: { in: occurrences.map((o) => o.originalStartsAt) },
    },
    select: { seriesEventId: true, originalStartsAt: true, doneAt: true, snoozedUntil: true },
  });
}

// --- Events: create ---------------------------------------------------------

export interface CreateNativeEventInput {
  calendarCuid: string;
  creatorUserId: number;
  title: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  timeZone: string;
  rrule?: string | null;
  reminderMinutes?: number | null;
  // A reminder is an event with no length (spec §1). forUserId is the partner it
  // is for; null means the creator. Ignored for an EVENT.
  kind?: 'EVENT' | 'REMINDER';
  forUserId?: number | null;
}

/**
 * A reminder starts and ends at the same instant. A date-only one sits at the start
 * of its local day in the event's timezone, so it stays on that day whatever the
 * caller sent as its end (the bot saves an all-day event until 23:59).
 */
export function normalizeReminderTimes(
  startsAt: Date,
  allDay: boolean,
  timeZone: string
): { startsAt: Date; endsAt: Date } {
  if (!allDay) return { startsAt, endsAt: new Date(startsAt.getTime()) };
  const tz = timeZone || TIMEZONE;
  const dayStart = startOfLocalDay(localDate(startsAt, tz), tz);
  return { startsAt: dayStart, endsAt: new Date(dayStart.getTime()) };
}

export class NativePermissionDeniedError extends Error {
  constructor(message = 'Permission denied for native calendar operation') {
    super(message);
    this.name = 'NativePermissionDeniedError';
  }
}

export class NativeNotFoundError extends Error {
  constructor(message = 'Native calendar event not found') {
    super(message);
    this.name = 'NativeNotFoundError';
  }
}

export async function createNativeEvent(input: CreateNativeEventInput): Promise<NativeEvent> {
  const calendar = await prisma.nativeCalendar.findUnique({
    where: { id: input.calendarCuid },
    select: { id: true, ownerUserId: true, privacy: true, isDeleted: true },
  });
  if (!calendar || calendar.isDeleted) throw new NativeNotFoundError('Calendar not found');

  const creator = await prisma.user.findUnique({
    where: { id: input.creatorUserId },
    select: { id: true, pairingId: true },
  });
  if (!creator) throw new NativeNotFoundError('Creator user not found');

  const access = await getCalendarAccess(creator, calendar);
  if (!canWriteAccess(access)) throw new NativePermissionDeniedError();

  const isReminder = input.kind === 'REMINDER';
  const times = isReminder
    ? normalizeReminderTimes(input.startsAt, input.allDay ?? false, input.timeZone)
    : { startsAt: input.startsAt, endsAt: input.endsAt };
  const event = await prisma.nativeEvent.create({
    data: {
      calendarId: input.calendarCuid,
      creatorUserId: input.creatorUserId,
      title: input.title,
      description: input.description,
      location: input.location,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      allDay: input.allDay ?? false,
      timeZone: input.timeZone,
      rrule: input.rrule ?? null,
      reminderMinutes: input.reminderMinutes ?? null,
      // armedAt bounds how far back the ping pass looks, so a reminder created for a
      // time long gone doesn't ping (spec §4.2).
      ...(isReminder
        ? { kind: 'REMINDER' as const, forUserId: input.forUserId ?? null, armedAt: new Date() }
        : {}),
    },
  });
  if (isReminder) invalidateDueGate();
  return event;
}

// --- Events: update ---------------------------------------------------------

export type UpdateScope = 'single' | 'all' | 'following';

export interface UpdateNativeEventInput {
  // Identity
  seriesCuid: string;
  instanceStartsAt?: Date; // required for scope=single/following on a recurring series
  scope: UpdateScope;
  // Permission context
  actingUserId: number;
  // Field changes (only set fields are updated)
  title?: string;
  description?: string | null;
  location?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  allDay?: boolean;
  /**
   * startsAt, endsAt and allDay say where the occurrence instanceStartsAt goes, as the bot
   * says an edit (of the occurrence it was told about). For scope 'all' the store turns them
   * into the series' own (seriesTimesFor), so the series keeps its place and its earlier
   * occurrences. Without it they are the series' own times, which the home works out.
   */
  occurrenceTimes?: boolean;
}

/** A ping message whose buttons a reminder's time change made stale. */
export interface ClearedPing {
  chatId: bigint;
  messageId: number;
}

const DAY_MS = 86_400_000;
const daysFromTo = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** An all-day item's end as the bot stores it: 23:59 on its last day. */
const endOfLocalDay = (day: string, tz: string) => fromZonedTime(`${day}T23:59:00`, tz);

/**
 * Where a series goes when one of its occurrences moves to `to` and every occurrence
 * follows: by the days that occurrence moved, at its new time of day, so the series keeps
 * its place in the rule and its first occurrences. Timed, it takes the occurrence's new
 * length; all day, its new span in days. `occurrenceStart` is where the occurrence is now
 * (its override's start, when it was moved on its own).
 */
export function seriesTimesFor(
  series: Pick<NativeEvent, 'startsAt' | 'timeZone'>,
  occurrenceStart: Date,
  to: { startsAt: Date; endsAt: Date; allDay: boolean }
): { startsAt: Date; endsAt: Date } {
  const tz = series.timeZone || TIMEZONE;
  const day = addDaysToDate(localDate(series.startsAt, tz), daysFromTo(localDate(occurrenceStart, tz), localDate(to.startsAt, tz)));
  if (to.allDay) {
    const span = daysFromTo(localDate(to.startsAt, tz), localDate(to.endsAt, tz));
    return { startsAt: startOfLocalDay(day, tz), endsAt: endOfLocalDay(addDaysToDate(day, Math.max(0, span)), tz) };
  }
  const startsAt = fromZonedTime(`${day}T${formatInTimeZone(to.startsAt, tz, 'HH:mm')}:00`, tz);
  return { startsAt, endsAt: new Date(startsAt.getTime() + (to.endsAt.getTime() - to.startsAt.getTime())) };
}

/**
 * An 'all' edit said of one occurrence (occurrenceTimes), as the series' own times. What
 * the edit leaves out stays: a start alone keeps the occurrence's length, an end alone
 * keeps the series' start.
 */
async function withSeriesTimes(series: NativeEvent, input: UpdateNativeEventInput): Promise<UpdateNativeEventInput> {
  const slot = input.instanceStartsAt;
  if (!input.occurrenceTimes || input.scope !== 'all' || !series.rrule || !slot) return input;
  if (input.startsAt === undefined && input.endsAt === undefined) return input;
  const override = await prisma.nativeEventInstance.findUnique({
    where: { seriesEventId_originalStartsAt: { seriesEventId: series.id, originalStartsAt: slot } },
  });
  const moved = override?.status === 'OVERRIDE' ? override : null;
  const from = moved?.startsAt ?? slot;
  const length = (moved?.endsAt ?? new Date(slot.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()))).getTime() - from.getTime();
  const allDay = input.allDay ?? moved?.allDay ?? series.allDay;
  const startsAt = input.startsAt ?? from;
  const times = seriesTimesFor(series, from, { startsAt, endsAt: input.endsAt ?? new Date(startsAt.getTime() + length), allDay });
  return input.startsAt === undefined ? { ...input, endsAt: times.endsAt } : { ...input, ...times };
}

/**
 * Move a series' per-occurrence rows to where its occurrences went (`slotOf`), in an
 * order that never puts two on one key: the latest first when they move later. The
 * series' times are every occurrence's again, so an override keeps only what else it
 * carries; with `dropOverrides` (a reminder starts afresh) only the cancellations stay.
 */
async function rekeyInstances(
  tx: Prisma.TransactionClient,
  seriesId: string,
  slotOf: (slot: Date) => Date,
  dropOverrides: boolean
): Promise<void> {
  if (dropOverrides) await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: seriesId, status: 'OVERRIDE' } });
  const rows = await tx.nativeEventInstance.findMany({ where: { seriesEventId: seriesId } });
  if (rows.length === 0) return;
  const later = slotOf(rows[0].originalStartsAt).getTime() > rows[0].originalStartsAt.getTime();
  rows.sort((a, b) => (a.originalStartsAt.getTime() - b.originalStartsAt.getTime()) * (later ? -1 : 1));
  for (const o of rows) {
    await tx.nativeEventInstance.update({
      where: { id: o.id },
      data: { originalStartsAt: slotOf(o.originalStartsAt), startsAt: null, endsAt: null, allDay: null },
    });
  }
}

/**
 * Update an event with scope semantics that mirror the GCal flow.
 * Returns the canonical id the caller should reference afterwards (the series
 * cuid for scope=all/following, or the instance composite id for scope=single),
 * and, for a reminder whose time changed, the live pings to strip the buttons from.
 */
export async function updateNativeEvent(
  given: UpdateNativeEventInput
): Promise<{ canonicalEventId: string; clearedPings: ClearedPing[] }> {
  let input = given;
  const series = await prisma.nativeEvent.findUnique({ where: { id: input.seriesCuid } });
  if (!series || series.isDeleted) throw new NativeNotFoundError();

  const calendar = await prisma.nativeCalendar.findUnique({ where: { id: series.calendarId } });
  if (!calendar || calendar.isDeleted) throw new NativeNotFoundError('Calendar not found');

  const actor = await prisma.user.findUnique({
    where: { id: input.actingUserId },
    select: { id: true, pairingId: true },
  });
  if (!actor) throw new NativeNotFoundError('Actor user not found');

  const access = await getCalendarAccess(actor, calendar);
  // A reminder's creator may always change it, even on a calendar they can only view.
  const isReminder = series.kind === 'REMINDER';
  if (!canWriteAccess(access) && !(isReminder && series.creatorUserId === actor.id)) {
    throw new NativePermissionDeniedError();
  }
  input = await withSeriesTimes(series, input);
  if (isReminder) {
    const result = await updateNativeReminder(series, input);
    invalidateDueGate();
    return result;
  }

  // Field update bag for series-level changes
  const seriesUpdate: Prisma.NativeEventUpdateInput = {};
  if (input.title !== undefined) seriesUpdate.title = input.title;
  if (input.description !== undefined) seriesUpdate.description = input.description;
  if (input.location !== undefined) seriesUpdate.location = input.location;
  if (input.startsAt !== undefined) seriesUpdate.startsAt = input.startsAt;
  if (input.endsAt !== undefined) seriesUpdate.endsAt = input.endsAt;
  if (input.allDay !== undefined) seriesUpdate.allDay = input.allDay;

  // Single occurrence (recurring): write/upsert NativeEventInstance OVERRIDE
  if (input.scope === 'single' && series.rrule && input.instanceStartsAt) {
    const occ = input.instanceStartsAt;
    await prisma.nativeEventInstance.upsert({
      where: {
        seriesEventId_originalStartsAt: { seriesEventId: series.id, originalStartsAt: occ },
      },
      create: {
        seriesEventId: series.id,
        originalStartsAt: occ,
        status: 'OVERRIDE',
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        allDay: input.allDay ?? null,
      },
      update: {
        status: 'OVERRIDE',
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      },
    });
    return { canonicalEventId: encodeEventId(series.id, occ), clearedPings: [] };
  }

  // Single occurrence on a non-recurring event: act on the series itself.
  if (input.scope === 'single' && !series.rrule) {
    await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
    return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
  }

  // 'all': update the series. New times reach every occurrence: the ones moved on their
  // own lose their own times and keep what else they carry (a title). A new start moves
  // what was done to the occurrences one by one with them, shifted on the wall clock as
  // the start moved: the skipped stay skipped (exdates, CANCELLED), the renamed renamed.
  if (input.scope === 'all') {
    const start = input.startsAt;
    await prisma.$transaction(async (tx) => {
      if (start !== undefined && series.rrule) {
        const slotOf = (slot: Date) => shiftOnWall(slot, series.startsAt, start, series.timeZone);
        await tx.nativeEvent.update({ where: { id: series.id }, data: { ...seriesUpdate, exdates: series.exdates.map(slotOf) } });
        await rekeyInstances(tx, series.id, slotOf, false);
        return;
      }
      await tx.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      if (start !== undefined) {
        await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id } });
      } else if (input.endsAt !== undefined || input.allDay !== undefined) {
        await tx.nativeEventInstance.updateMany({
          where: { seriesEventId: series.id, status: 'OVERRIDE' },
          data: { startsAt: null, endsAt: null, allDay: null },
        });
      }
    });
    return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
  }

  // 'following': truncate the original series and create a new one starting
  // from the targeted instance.
  if (input.scope === 'following') {
    if (!series.rrule || !input.instanceStartsAt) {
      // Fallback: nothing to truncate; treat as 'all'
      await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
    }
    const cut = input.instanceStartsAt;
    const newSeriesId = await prisma.$transaction(async (tx) => {
      // 1. Truncate parent rrule
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, cut, series.timeZone) },
      });
      // 2. Insert new series starting from the instance, with overrides applied.
      //    What was done to the occurrences from the cut one by one comes along: the
      //    skipped stay skipped (exdates, CANCELLED) and the moved or renamed keep it,
      //    each keyed where the new series puts it (its slot shifted on the wall clock as
      //    the cut occurrence moved). A field this edit sets wins over an occurrence's own.
      const newStarts = input.startsAt ?? cut;
      const newEnds = input.endsAt ?? new Date(newStarts.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()));
      const slotOf = (d: Date) => shiftOnWall(d, cut, newStarts, series.timeZone);
      const newSeries = await tx.nativeEvent.create({
        data: {
          calendarId: series.calendarId,
          creatorUserId: input.actingUserId,
          title: input.title ?? series.title,
          description: input.description ?? series.description,
          location: input.location ?? series.location,
          startsAt: newStarts,
          endsAt: newEnds,
          allDay: input.allDay ?? series.allDay,
          timeZone: series.timeZone,
          rrule: series.rrule,
          reminderMinutes: series.reminderMinutes,
          exdates: series.exdates.filter((d) => d.getTime() >= cut.getTime()).map(slotOf),
        },
      });
      // 3. Move the overrides at-or-after the cut point to the new series.
      const retimed = input.startsAt !== undefined || input.endsAt !== undefined || input.allDay !== undefined;
      const fromCut = await tx.nativeEventInstance.findMany({
        where: { seriesEventId: series.id, originalStartsAt: { gte: cut } },
      });
      for (const o of fromCut) {
        await tx.nativeEventInstance.update({
          where: { id: o.id },
          data: {
            seriesEventId: newSeries.id,
            originalStartsAt: slotOf(o.originalStartsAt),
            ...(input.title !== undefined ? { title: null } : {}),
            ...(input.description !== undefined ? { description: null } : {}),
            ...(input.location !== undefined ? { location: null } : {}),
            ...(retimed ? { startsAt: null, endsAt: null, allDay: null } : {}),
          },
        });
      }
      return newSeries.id;
    });
    return { canonicalEventId: encodeEventId(newSeriesId), clearedPings: [] };
  }

  return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
}

/**
 * Where a reminder occurrence lands after an edit, zero-length, or null when the edit
 * leaves its time alone. Any end the caller computed is ignored (the edit path adds an
 * hour to a timed event and stretches an all-day one to 23:59). `changed` is whether
 * the start or allDay actually moved, which is what re-arms the reminder.
 */
function reminderTimeEdit(
  current: { startsAt: Date; allDay: boolean },
  input: Pick<UpdateNativeEventInput, 'startsAt' | 'allDay'>,
  timeZone: string
): { startsAt: Date; endsAt: Date; allDay: boolean; changed: boolean } | null {
  if (input.startsAt === undefined && input.allDay === undefined) return null;
  const allDay = input.allDay ?? current.allDay;
  const times = normalizeReminderTimes(input.startsAt ?? current.startsAt, allDay, timeZone);
  const changed = times.startsAt.getTime() !== current.startsAt.getTime() || allDay !== current.allDay;
  return { ...times, allDay, changed };
}

/**
 * Delete the state rows (done, snoozed, last ping) of the occurrences a time change
 * moved, so each pings again at its new time. Returns their live ping messages, whose
 * buttons now point at nothing.
 */
async function clearReminderStates(
  tx: Prisma.TransactionClient,
  where: Prisma.NativeReminderStateWhereInput
): Promise<ClearedPing[]> {
  const rows = await tx.nativeReminderState.findMany({
    where,
    select: { pingChatId: true, pingMessageId: true },
  });
  if (rows.length === 0) return [];
  await tx.nativeReminderState.deleteMany({ where });
  return rows.flatMap((r) =>
    r.pingChatId !== null && r.pingMessageId !== null ? [{ chatId: r.pingChatId, messageId: r.pingMessageId }] : []
  );
}

/**
 * updateNativeEvent for a REMINDER, with the same scopes. Every write keeps it
 * zero-length, and a change of time or allDay re-arms it in the same transaction
 * (spec §7): the moved occurrences lose their state rows and the series' armedAt is
 * reset. A title or location change keeps the state.
 */
async function updateNativeReminder(
  series: NativeEvent,
  input: UpdateNativeEventInput
): Promise<{ canonicalEventId: string; clearedPings: ClearedPing[] }> {
  const text = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
  };

  // One occurrence of a repeating reminder: an OVERRIDE row. armedAt stays on the
  // series; the pass arms a moved occurrence from the override's updatedAt.
  if (input.scope === 'single' && series.rrule && input.instanceStartsAt) {
    const key = { seriesEventId: series.id, originalStartsAt: input.instanceStartsAt };
    const clearedPings = await prisma.$transaction(async (tx) => {
      const existing = await tx.nativeEventInstance.findUnique({ where: { seriesEventId_originalStartsAt: key } });
      const edit = reminderTimeEdit(
        { startsAt: existing?.startsAt ?? key.originalStartsAt, allDay: existing?.allDay ?? series.allDay },
        input,
        series.timeZone
      );
      const times = edit ? { startsAt: edit.startsAt, endsAt: edit.endsAt, allDay: edit.allDay } : {};
      await tx.nativeEventInstance.upsert({
        where: { seriesEventId_originalStartsAt: key },
        create: {
          ...key,
          status: 'OVERRIDE',
          title: input.title,
          description: input.description ?? null,
          location: input.location ?? null,
          ...times,
        },
        update: { status: 'OVERRIDE', ...text, ...times },
      });
      return edit?.changed ? clearReminderStates(tx, key) : [];
    });
    return { canonicalEventId: encodeEventId(series.id, key.originalStartsAt), clearedPings };
  }

  // 'following' from an occurrence: cut the series there and start a new one. The new
  // series stays the creator's reminder for the same person, whoever made the edit.
  if (input.scope === 'following' && series.rrule && input.instanceStartsAt) {
    const cut = input.instanceStartsAt;
    const edit = reminderTimeEdit({ startsAt: cut, allDay: series.allDay }, input, series.timeZone);
    const target = edit ?? { startsAt: cut, endsAt: cut, allDay: series.allDay, changed: false };
    const slotOf = (slot: Date) => shiftOnWall(slot, cut, target.startsAt, series.timeZone);
    const { newSeriesId, clearedPings } = await prisma.$transaction(async (tx) => {
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, cut, series.timeZone) },
      });
      const newSeries = await tx.nativeEvent.create({
        data: {
          calendarId: series.calendarId,
          creatorUserId: series.creatorUserId,
          title: input.title ?? series.title,
          description: input.description ?? series.description,
          location: input.location ?? series.location,
          startsAt: target.startsAt,
          endsAt: target.endsAt,
          allDay: target.allDay,
          timeZone: series.timeZone,
          rrule: series.rrule,
          reminderMinutes: series.reminderMinutes,
          kind: 'REMINDER',
          forUserId: series.forUserId,
          armedAt: target.changed ? new Date() : series.armedAt,
          // The occurrences skipped after the cut stay skipped, keyed where they went.
          exdates: series.exdates.filter((d) => d.getTime() >= cut.getTime()).map(slotOf),
        },
      });
      const fromCut = { seriesEventId: series.id, originalStartsAt: { gte: cut } };
      if (target.changed) {
        // Moved, the new series starts afresh: what was moved on its own goes; the
        // cancellations follow, keyed where the new series puts them.
        await tx.nativeEventInstance.deleteMany({ where: { ...fromCut, status: 'OVERRIDE' } });
        const skipped = await tx.nativeEventInstance.findMany({ where: fromCut });
        for (const o of skipped) {
          await tx.nativeEventInstance.update({
            where: { id: o.id },
            data: { seriesEventId: newSeries.id, originalStartsAt: slotOf(o.originalStartsAt) },
          });
        }
      } else {
        // Same keys under the new series, so skipped and moved occurrences follow it.
        // A field this edit sets wins over an older per-occurrence value.
        await tx.nativeEventInstance.updateMany({
          where: fromCut,
          data: {
            seriesEventId: newSeries.id,
            ...(input.title !== undefined ? { title: null } : {}),
            ...(input.description !== undefined ? { description: null } : {}),
            ...(input.location !== undefined ? { location: null } : {}),
          },
        });
      }
      if (target.changed) {
        return { newSeriesId: newSeries.id, clearedPings: await clearReminderStates(tx, fromCut) };
      }
      // Unmoved, the new series' occurrences keep the same instants, so their
      // done/snoozed state follows them to it.
      await tx.nativeReminderState.updateMany({ where: fromCut, data: { seriesEventId: newSeries.id } });
      return { newSeriesId: newSeries.id, clearedPings: [] };
    });
    return { canonicalEventId: encodeEventId(newSeriesId), clearedPings };
  }

  // The series itself: a one-off reminder, every occurrence ('all'), or 'following'
  // with nothing to cut. 'single' on a series with no occurrence given changes
  // nothing, as for an event.
  if (input.scope === 'single' && series.rrule) {
    return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
  }
  const edit = reminderTimeEdit({ startsAt: series.startsAt, allDay: series.allDay }, input, series.timeZone);
  const clearedPings = await prisma.$transaction(async (tx) => {
    await tx.nativeEvent.update({
      where: { id: series.id },
      data: {
        ...text,
        ...(edit ? { startsAt: edit.startsAt, endsAt: edit.endsAt, allDay: edit.allDay } : {}),
        ...(edit?.changed ? { armedAt: new Date() } : {}),
      },
    });
    // Every occurrence at the series' time, which stays: the ones moved on their own come back to it.
    if (!edit?.changed) return edit && input.scope === 'all' ? unmoveOccurrences(tx, series) : [];
    // Every occurrence moves and starts afresh: what was moved on its own goes, and what
    // was skipped stays skipped, keyed where it went.
    if (input.scope === 'all' && series.rrule) {
      const slotOf = (slot: Date) => shiftOnWall(slot, series.startsAt, edit.startsAt, series.timeZone);
      await tx.nativeEvent.update({ where: { id: series.id }, data: { exdates: series.exdates.map(slotOf) } });
      await rekeyInstances(tx, series.id, slotOf, true);
    }
    return clearReminderStates(tx, { seriesEventId: series.id });
  });
  return { canonicalEventId: encodeEventId(series.id), clearedPings };
}

/**
 * The occurrences of a reminder that were moved on their own go back to the series' time:
 * their overrides lose their times (a title stays), and each moved one loses its state, so
 * it pings again there, armed from now. Returns their live pings.
 */
async function unmoveOccurrences(tx: Prisma.TransactionClient, series: NativeEvent): Promise<ClearedPing[]> {
  const overrides = await tx.nativeEventInstance.findMany({ where: { seriesEventId: series.id, status: 'OVERRIDE' } });
  const timed = overrides.filter((o) => o.startsAt !== null || o.endsAt !== null || o.allDay !== null);
  if (timed.length === 0) return [];
  await tx.nativeEventInstance.updateMany({
    where: { id: { in: timed.map((o) => o.id) } },
    data: { startsAt: null, endsAt: null, allDay: null },
  });
  const moved = timed.filter(
    (o) => (o.startsAt !== null && o.startsAt.getTime() !== o.originalStartsAt.getTime()) || (o.allDay !== null && o.allDay !== series.allDay)
  );
  if (moved.length === 0) return [];
  await tx.nativeEvent.update({ where: { id: series.id }, data: { armedAt: new Date() } });
  return clearReminderStates(tx, { seriesEventId: series.id, originalStartsAt: { in: moved.map((o) => o.originalStartsAt) } });
}

// --- Events: delete ---------------------------------------------------------

export interface DeleteNativeEventInput {
  seriesCuid: string;
  instanceStartsAt?: Date;
  scope: UpdateScope;
  actingUserId: number;
}

/**
 * Read a native series' RRULE. Used by the week lookahead to classify how often
 * a recurring occurrence repeats, the same way it reads Google's master event.
 * Returns null for a one-off event or an unknown id.
 */
export async function getNativeSeriesRrule(seriesCuid: string): Promise<string | null> {
  const series = await prisma.nativeEvent.findUnique({
    where: { id: seriesCuid },
    select: { rrule: true },
  });
  return series?.rrule ?? null;
}

export async function deleteNativeEvent(input: DeleteNativeEventInput): Promise<void> {
  const series = await prisma.nativeEvent.findUnique({ where: { id: input.seriesCuid } });
  if (!series || series.isDeleted) throw new NativeNotFoundError();

  const calendar = await prisma.nativeCalendar.findUnique({ where: { id: series.calendarId } });
  if (!calendar || calendar.isDeleted) throw new NativeNotFoundError('Calendar not found');

  const actor = await prisma.user.findUnique({
    where: { id: input.actingUserId },
    select: { id: true, pairingId: true },
  });
  if (!actor) throw new NativeNotFoundError('Actor user not found');

  const access = await getCalendarAccess(actor, calendar);
  if (!canWriteAccess(access) && !(await mayDeleteReminder(series, actor.id))) {
    throw new NativePermissionDeniedError();
  }

  await deleteOccurrences(series, input);
  if (series.kind === 'REMINDER') invalidateDueGate();
}

/**
 * Whether someone without write access to the calendar may still delete a reminder:
 * its creator, or the person it is for ("stop reminding me"). That person is worked out
 * on every read (spec R2), so an ex-partner or a partner now on Google can't.
 */
export async function mayDeleteReminder(series: NativeEvent, actorId: number): Promise<boolean> {
  if (series.kind !== 'REMINDER') return false;
  if (series.creatorUserId === actorId) return true;
  if (series.forUserId !== actorId) return false;
  const creator = await prisma.user.findUnique({
    where: { id: series.creatorUserId },
    select: { pairingId: true },
  });
  if (!creator) return false;
  const creatorPartner = await getActivePartnerSummary(series.creatorUserId, creator.pairingId);
  return effectiveOwnerId(series, creatorPartner) === actorId;
}

/** The write half of deleteNativeEvent, once the actor may delete. */
async function deleteOccurrences(series: NativeEvent, input: DeleteNativeEventInput): Promise<void> {
  // Single occurrence on recurring: prefer EXDATE (cheap), but if there's an
  // existing OVERRIDE row for this date, mark it CANCELLED so it stops rendering.
  if (input.scope === 'single' && series.rrule && input.instanceStartsAt) {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.nativeEventInstance.findUnique({
        where: {
          seriesEventId_originalStartsAt: { seriesEventId: series.id, originalStartsAt: input.instanceStartsAt! },
        },
      });
      if (existing) {
        await tx.nativeEventInstance.update({
          where: { id: existing.id },
          data: { status: 'CANCELLED' },
        });
      } else {
        await tx.nativeEvent.update({
          where: { id: series.id },
          data: { exdates: { push: input.instanceStartsAt! } },
        });
      }
    });
    return;
  }

  // Single on non-recurring: soft-delete the row.
  if (input.scope === 'single' && !series.rrule) {
    await prisma.nativeEvent.update({ where: { id: series.id }, data: { isDeleted: true } });
    return;
  }

  // 'all': soft-delete the series (and its overrides cascade via FK).
  if (input.scope === 'all') {
    await prisma.nativeEvent.update({ where: { id: series.id }, data: { isDeleted: true } });
    return;
  }

  // 'following': truncate parent rrule before the instance so the series stops
  // before that date. Drop overrides at-or-after the cut.
  if (input.scope === 'following' && series.rrule && input.instanceStartsAt) {
    await prisma.$transaction(async (tx) => {
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, input.instanceStartsAt!, series.timeZone) },
      });
      await tx.nativeEventInstance.deleteMany({
        where: { seriesEventId: series.id, originalStartsAt: { gte: input.instanceStartsAt! } },
      });
    });
    return;
  }

  // 'following' with nothing to truncate - a one-off event, or a series we were
  // given no occurrence for. Delete the event, matching the Google path, which
  // falls through to deleting the whole event in the same situation. Previously
  // this fell off the end having done nothing while the caller still reported
  // "Event deleted!" - and it is reachable, because the model is instructed to
  // emit scope 'following' for "from now on" even on a non-recurring event.
  await prisma.nativeEvent.update({ where: { id: series.id }, data: { isDeleted: true } });
}
