// CRUD layer for the native calendar tables.
//
// All cross-user permission checks live here. The NativeCalendarProvider sits on
// top and translates between UnifiedEvent / UnifiedCalendar shapes and these
// internal entities. Voice CRUD never bypasses this module — that keeps the
// owner/partner edit rules in exactly one place.

import { Prisma } from '@prisma/client';
import type {
  NativeCalendar,
  NativeEvent,
  NativeEventInstance,
  NativeCalendarPrivacy,
  User,
} from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { captureError } from '../../lib/error-capture';
import { TIMEZONE } from '../../config/constants';
import { alertChoiceOf, alertColumns, type AlertChoice } from '../../lib/calendar-view/alert-leads';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { invalidateDueGate } from '../native-reminders/due-gate';
import { markSyncDirty, markedTransaction, type SyncSeries } from '../google-sync/marks';
import { effectiveOwnerId, getActivePartnerSummary } from '../native-reminders/ownership';
import { ensurePrimaryNativeCalendar } from './onboarding';
import {
  assertStorableRule,
  daysFromTo,
  endCarriedRule,
  endOfLocalDay,
  expandSeries,
  fixesDays,
  followingTimesFor,
  hebrewSeriesOf,
  hebrewSlotMap,
  type HebrewRule,
  NativeRuleError,
  seriesTimesFor,
  shiftOnWall,
  shiftUntil,
  slotsBefore,
  truncateRruleBefore,
  VirtualInstance,
  withCount,
  withUntilOnDayOf,
  yearlyOpenedSlot,
  yearlyRuleAfter,
  yearlySlotMap,
  type YearlyMove,
  yieldsSlots,
} from './recurrence';

export { NativeRuleError, seriesTimesFor, followingTimesFor };

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
    let expanded: VirtualInstance[];
    try {
      expanded = expandSeries(s, range, overrides);
    } catch (error) {
      // A stored rule that can't be read fails the same way every time: report it by id
      // (never its title) and read the rest, so one series can't blank everyone's view.
      captureError(error, 'native-calendar-series', { series_id: s.id });
      continue;
    }
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
  /**
   * A Hebrew-date repeat (hebrew-repeats spec §2): the kind, next to a FREQ=YEARLY `rrule`.
   * Its anchor is the start's date in `timeZone`; `hebrewAnchor`, when given, must be that.
   */
  hebrewRule?: HebrewRule | null;
  hebrewAnchor?: string | null;
  /** The event's alert (editor upgrades spec §2); omitted = the user's default. Not for a reminder. */
  alert?: AlertChoice;
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

/**
 * A day move for every occurrence, or this one and the ones after, of a rule with fixed
 * days (the bot's BYDAY): the rule keeps its days, so the series would start on a day it
 * doesn't fall on and its occurrences would scramble. Only one occurrence can move. Also a
 * Hebrew series' 'all' day move led by a rolled year (1 Kislev, no 30 Cheshvan that year):
 * that occurrence would stay on its day while the anchor moved.
 */
export class NativeFixedDaysError extends Error {
  constructor(message = 'A series with fixed days cannot move to another day') {
    super(message);
    this.name = 'NativeFixedDaysError';
  }
}

/**
 * A series-level change (a new rule, calendar or recipient) asked for a scope that can't
 * carry it (3b spec §3.1): 'single' on a series, a new rule for 'all', or a calendar move
 * of a reminder. `field` names what the home answers 400 for.
 */
export class NativeScopeError extends Error {
  constructor(
    public readonly field: 'scope' | 'calendarId' | 'alert',
    message = 'This change cannot apply to that scope'
  ) {
    super(message);
    this.name = 'NativeScopeError';
  }
}

/** A recipient other than the creator or their ACTIVE partner on the built-in calendar and Telegram. */
export class NativeRecipientError extends Error {
  constructor(message = 'This reminder cannot be for that person') {
    super(message);
    this.name = 'NativeRecipientError';
  }
}

/**
 * A calendar move to a calendar that is missing, deleted or not writable, or a partner's
 * event to the user's own private calendar. Never NativeNotFoundError: the item is still there.
 */
export class NativeDestinationError extends Error {
  constructor(message = 'The event cannot move to that calendar') {
    super(message);
    this.name = 'NativeDestinationError';
  }
}

/**
 * A series a write touched, for its Google copy's marks (google-sync spec §2): every calendar
 * it was in before the write or is in after it, so a move marks the copy it leaves too.
 */
const synced = (series: Pick<NativeEvent, 'id' | 'kind'>, ...calendarIds: Array<string | null | undefined>): SyncSeries => ({
  id: series.id,
  kind: series.kind,
  calendarIds,
});

/**
 * A write that ran on its own before the copy to Google: an event's now runs in a transaction
 * with its marks, so the mark commits with the write; a reminder's runs as it did, since
 * reminders are never copied.
 */
function eventWrite<T>(kind: string, write: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return kind === 'REMINDER' ? write(prisma) : markedTransaction(write);
}

export async function createNativeEvent(input: CreateNativeEventInput): Promise<NativeEvent> {
  // A rule every reader can expand, with its Hebrew kind if any, or nothing is written (3b spec
  // §3.1, hebrew-repeats §2).
  assertStorableRule(input.rrule || null, input.hebrewRule);
  const isReminder = input.kind === 'REMINDER';
  const times = isReminder
    ? normalizeReminderTimes(input.startsAt, input.allDay ?? false, input.timeZone)
    : { startsAt: input.startsAt, endsAt: input.endsAt };
  // The anchor is the start's date where the series lives.
  const hebrewAnchor = input.hebrewRule ? localDate(times.startsAt, input.timeZone || TIMEZONE) : null;
  if ((input.hebrewAnchor ?? null) !== null && input.hebrewAnchor !== hebrewAnchor) {
    throw new NativeRuleError('A Hebrew repeat is anchored on its start');
  }
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

  const event = await eventWrite(isReminder ? 'REMINDER' : 'EVENT', async (db) => {
    const created = await db.nativeEvent.create({
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
        hebrewRule: input.hebrewRule ?? null,
        hebrewAnchor,
        ...alertColumns(input.alert ?? 'default'),
        // armedAt bounds how far back the ping pass looks, so a reminder created for a
        // time long gone doesn't ping (spec §4.2).
        ...(isReminder
          ? { kind: 'REMINDER' as const, forUserId: input.forUserId ?? null, armedAt: new Date() }
          : {}),
      },
    });
    await markSyncDirty(db, { series: [synced(created, created.calendarId)] });
    return created;
  });
  if (isReminder) invalidateDueGate();
  return event;
}

/** An OVERRIDE row of a series written whole (createNativeSeries): null fields follow the series. */
export interface NativeSeriesOverrideInput {
  originalStartsAt: Date;
  title: string | null;
  description: string | null;
  location: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean | null;
}

/** An event written whole, with its exceptions ("Google as a connection" spec §5: a Google event moved to FamCal). */
export interface CreateNativeSeriesInput {
  calendarCuid: string;
  creatorUserId: number;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timeZone: string;
  rrule: string | null;
  exdates: Date[];
  overrides: NativeSeriesOverrideInput[];
}

/**
 * An event, a one-off or a series with its exdates and OVERRIDE rows, written in one
 * transaction: all of it or nothing. The creator must be able to write the calendar, and
 * the rule must be one every reader can expand (it is never a Hebrew one: Google holds
 * none). Exceptions need a rule.
 */
export async function createNativeSeries(input: CreateNativeSeriesInput): Promise<NativeEvent> {
  assertStorableRule(input.rrule, null);
  if (!input.rrule && (input.exdates.length > 0 || input.overrides.length > 0)) throw new NativeRuleError('Exceptions need a repeat rule');
  const calendar = await prisma.nativeCalendar.findUnique({
    where: { id: input.calendarCuid },
    select: { id: true, ownerUserId: true, privacy: true, isDeleted: true },
  });
  if (!calendar || calendar.isDeleted) throw new NativeNotFoundError('Calendar not found');
  const creator = await prisma.user.findUnique({ where: { id: input.creatorUserId }, select: { id: true, pairingId: true } });
  if (!creator) throw new NativeNotFoundError('Creator user not found');
  if (!canWriteAccess(await getCalendarAccess(creator, calendar))) throw new NativePermissionDeniedError();

  return markedTransaction(async (tx) => {
    const event = await tx.nativeEvent.create({
      data: {
        calendarId: input.calendarCuid,
        creatorUserId: input.creatorUserId,
        title: input.title,
        description: input.description,
        location: input.location,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        allDay: input.allDay,
        timeZone: input.timeZone,
        rrule: input.rrule,
        exdates: input.exdates,
      },
    });
    for (const o of input.overrides) {
      await tx.nativeEventInstance.create({
        data: {
          seriesEventId: event.id,
          originalStartsAt: o.originalStartsAt,
          status: 'OVERRIDE',
          title: o.title,
          description: o.description,
          location: o.location,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          allDay: o.allDay,
        },
      });
    }
    await markSyncDirty(tx, { series: [synced(event, event.calendarId)] });
    return event;
  });
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
   * With scope 'all': startsAt, endsAt and allDay say where the occurrence
   * instanceStartsAt goes, as the bot says an edit (of the occurrence it was told about).
   * The store turns them into the series' own (seriesTimesFor), so the series keeps its
   * place and its earlier occurrences. Without it they are the series' own times, which
   * the home works out. With 'following' they always say where the cut occurrence goes.
   */
  occurrenceTimes?: boolean;
  // Series-level changes (3b spec §3.1). Each is refused with 'single' on a series.
  /**
   * The new rule (bare, as stored), or null to stop repeating; omitted keeps it. On a series
   * only with 'following' (from the first occurrence that is the whole series), with the
   * old rule's end carried; a one-off takes it as itself. A stop's times are where the cut
   * occurrence goes, never converted.
   */
  rrule?: string | null;
  /**
   * The new rule's Hebrew kind (hebrew-repeats spec §2), sent with `rrule` as a pair: a rule
   * without it is a Gregorian one (null), and a kind without a rule keeps the stored rule
   * string. The store sets the anchor: copied to a tail, replaced only when the start moves
   * to another day.
   */
  hebrewRule?: HebrewRule | null;
  /** An event's new calendar (a native cuid). A reminder has none to change. */
  calendarId?: string;
  /** An event's new alert (editor upgrades spec §2): series-level, like the calendar. A reminder has none. */
  alert?: AlertChoice;
  /** A reminder's new recipient: the creator's ACTIVE partner, or null for the creator. Only the creator may change it. */
  forUserId?: number | null;
}

/** A ping message whose buttons a reminder's time change made stale. */
export interface ClearedPing {
  chatId: bigint;
  messageId: number;
}

/**
 * What an update did. `key` is where the opened occurrence is after it: the series and its
 * slot, or a null slot for a one-off. `clearedPings` are the live pings of occurrences whose
 * time moved ("moved"); `changedPings` those of occurrences that no longer exist ("changed");
 * `reassignedPings` those of open occurrences now for someone else ("now for").
 */
export interface UpdateNativeEventResult {
  canonicalEventId: string;
  key: { seriesId: string; slot: Date | null };
  clearedPings: ClearedPing[];
  changedPings: ClearedPing[];
  reassignedPings: ClearedPing[];
}

/** An update's result with no pings to strip. */
function resultOf(canonicalEventId: string, key: UpdateNativeEventResult['key'], pings: Partial<Pick<UpdateNativeEventResult, 'clearedPings' | 'changedPings' | 'reassignedPings'>> = {}): UpdateNativeEventResult {
  return { canonicalEventId, key, clearedPings: [], changedPings: [], reassignedPings: [], ...pings };
}

/**
 * Whether `cut` is the first occurrence a series shows: none of its rule's slots before it is
 * left once its exdates and cancellations apply, so the series cut there would have none
 * (3b spec §3.1). "This one and the ones after" from there is the whole series.
 */
export async function isFirstOccurrence(series: NativeEvent, cut: Date): Promise<boolean> {
  if (!series.rrule) return true;
  const slots = expandSeries(series, { from: series.startsAt, to: cut }, [])
    .map((i) => i.instanceStartsAt)
    .filter((d) => d < cut);
  if (slots.length === 0) return true;
  const cancelled = await prisma.nativeEventInstance.findMany({
    where: { seriesEventId: series.id, status: 'CANCELLED', originalStartsAt: { lt: cut } },
    select: { originalStartsAt: true },
  });
  const gone = new Set(cancelled.map((c) => c.originalStartsAt.getTime()));
  return slots.every((d) => gone.has(d.getTime()));
}

/**
 * The rule of the part "this one and the ones after" starts at `cut`, now at `newStart`.
 * With `newRule`, it is that rule with the old rule's end carried (endCarriedRule) and left
 * where it is, however the cut moved: the series still ends on the day the item info names
 * (3b spec §2.1). Only when the opened occurrence moved past that end does the end go to
 * its new day, so the new part never starts empty (the parent is already cut there); a rule
 * that still has no occurrence at its start is refused. Without, or with the stored rule
 * string (only switched between Gregorian and Hebrew, hebrew-repeats spec §4), it is the
 * series' own, its UNTIL moved as the cut moved (so it keeps its last occurrence) and a COUNT
 * cut to what is left after the slots before the cut (at least 1, the cut being a slot);
 * after such a switch, one that has no occurrence at its start is refused too.
 */
function tailRule(series: NativeEvent, cut: Date, newStart: Date, newRule: string | undefined, pair: HebrewPair): string {
  const endsAt = new Date(newStart.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()));
  const startsWith = (rule: string) => yieldsSlots({ ...series, ...pair, rrule: rule, startsAt: newStart, endsAt }, [newStart]).size > 0;
  const refuse = (): never => {
    throw new NativeRuleError('The new repeat has no occurrence at its start');
  };
  // The stored string switched between Gregorian and Hebrew keeps the series' own end: its COUNT, word for word, would start over in the tail.
  if (newRule !== undefined && newRule !== series.rrule) {
    const carried = endCarriedRule(newRule, series.rrule!, series, { cut, hebrewRule: pair.hebrewRule })!;
    assertStorableRule(carried, pair.hebrewRule);
    if (startsWith(carried)) return carried;
    const pushed = withUntilOnDayOf(carried, newStart, series.timeZone);
    if (startsWith(pushed)) return pushed;
    return refuse();
  }
  const shifted = shiftUntil(series.rrule!, cut, newStart, series.timeZone);
  const count = /(^|;)COUNT=(\d+)/i.exec(shifted);
  const rule = count ? withCount(shifted, Math.max(1, Number(count[2]) - slotsBefore({ ...series, rrule: series.rrule! }, cut))) : shifted;
  if (newRule !== undefined) {
    assertStorableRule(rule, pair.hebrewRule);
    if (!startsWith(rule)) return refuse();
  }
  return rule;
}

const DAY_MS = 86_400_000;

/** A series' Hebrew columns as the store writes them (hebrew-repeats spec §2): both null, or a kind and its anchor. */
interface HebrewPair {
  hebrewRule: HebrewRule | null;
  hebrewAnchor: string | null;
}

/** The kind a series has after an edit: the edit's when it sets a rule (the pair travels together), else its own. */
const hebrewRuleAfter = (series: NativeEvent, input: Pick<UpdateNativeEventInput, 'rrule' | 'hebrewRule'>): HebrewRule | null =>
  input.rrule !== undefined ? (input.hebrewRule ?? null) : ((series.hebrewRule as HebrewRule | null) ?? null);

/**
 * The pair of the part "this one and the ones after" starts at `newStart`, cut at `cut` (from
 * the first occurrence too, in place). A Hebrew series' anchor is copied, so a 30 Cheshvan
 * birthday cut on a year it fell on 1 Kislev stays one; only a start moved to another day,
 * or a rule that was not Hebrew before, takes the new start's date there.
 */
function tailPair(series: NativeEvent, input: Pick<UpdateNativeEventInput, 'rrule' | 'hebrewRule'>, cut: Date, newStart: Date): HebrewPair {
  const hebrewRule = hebrewRuleAfter(series, input);
  if (!hebrewRule) return { hebrewRule: null, hebrewAnchor: null };
  const tz = series.timeZone || TIMEZONE;
  const sameDay = localDate(newStart, tz) === localDate(cut, tz);
  return { hebrewRule, hebrewAnchor: series.hebrewRule && series.hebrewAnchor && sameDay ? series.hebrewAnchor : localDate(newStart, tz) };
}

/**
 * Where a series' slots go when it becomes `shape`, as `from` (a slot) went to `to`: shifted
 * on the wall clock, or, Hebrew both before and after, to the new series' slot in the same
 * Hebrew year (hebrewSlotMap). A rolled year (1 Kislev where there is no 30 Cheshvan) moves by
 * other days than the start did. Null: the new series has no slot for it.
 */
function slotMapFor(series: NativeEvent, shape: NativeEvent, from: Date, to: Date): (slot: Date) => Date | null {
  const shift = (slot: Date) => shiftOnWall(slot, from, to, series.timeZone);
  if (!series.rrule || !series.hebrewRule || !shape.rrule || !shape.hebrewRule) return shift;
  return hebrewSlotMap(hebrewSeriesOf(series), hebrewSeriesOf(shape), { from, to }) ?? shift;
}

/**
 * An edit as the store applies it, once ownTimes has read its occurrence times: `move` is the
 * yearly move they make (seriesTimesFor), null for none; `unmoves` is the opened occurrence's slot
 * when it was moved on its own and the edit gives it other times, so it comes back to the series
 * even where the series' own start stays (All back onto the series' own day). The bot resending the
 * times it already has gives none.
 */
type OwnTimes = UpdateNativeEventInput & { move?: YearlyMove | null; unmoves?: Date };

/**
 * The yearly move (editor upgrades spec §1) of an edit that takes every occurrence of a yearly
 * series (movesByYears) to another day: 'all', or 'following' with no occurrence given. It is
 * the one its occurrence times made (ownTimes), else as if the series' first occurrence went to
 * `start`. Undefined for any other edit, which moves by the days (shiftOnWall).
 */
function yearlyMoveOf(series: NativeEvent, input: OwnTimes, start = input.startsAt): YearlyMove | undefined {
  if (input.move !== undefined) return input.move ?? undefined;
  const whole = input.scope === 'all' || (input.scope === 'following' && !input.instanceStartsAt);
  if (!whole || start === undefined || !series.rrule) return undefined;
  const first = { slot: series.startsAt, start: series.startsAt };
  return seriesTimesFor(series, first, { startsAt: start, endsAt: start, allDay: input.allDay ?? series.allDay }).yearly;
}

/**
 * Whether an edit moves a Hebrew series to a Hebrew date its anchor's year doesn't have (30
 * Cheshvan in a short year, Adar I in a common one; yearlyMoveOf): the anchor can't carry it, so
 * the occurrences would not land on the day they were put on.
 */
function rollsHebrewDay(series: NativeEvent, input: OwnTimes): boolean {
  return Boolean(series.hebrewRule) && yearlyMoveOf(series, input)?.hebrewAnchor === null;
}

/**
 * Whether an edit's yearly move gives a Hebrew series another anchor (ownTimes' `move`): its
 * occurrences move even when its start stays, as for a tail that starts on a rolled day (1 Kislev,
 * no 30 Cheshvan that year) moved to 1 Kislev.
 */
function movesAnchor(series: NativeEvent, input: OwnTimes): boolean {
  const anchor = input.move?.hebrewAnchor;
  return Boolean(series.hebrewRule) && anchor !== undefined && anchor !== null && anchor !== series.hebrewAnchor;
}

/**
 * What moving a series' start to `times.startsAt` for every occurrence does ('all', 3b spec §3.1;
 * the anchor too for 'following' with nothing to cut): its rule with the end carried, its Hebrew
 * anchor, the series as it will be (`shape`), where each slot goes (`slotOf`), and where the opened
 * occurrence goes (`opened`; the series' first, when none was given). A yearly series moved to
 * another day goes by its years (yearlyMoveOf); any other is shifted on the wall clock as its start
 * moved, its UNTIL with it.
 */
function seriesMoved(series: NativeEvent, input: OwnTimes, times: { startsAt: Date; endsAt: Date; allDay: boolean }) {
  const start = times.startsAt;
  const move = yearlyMoveOf(series, input, start);
  const opened = input.instanceStartsAt;
  if (!move) {
    const rrule = shiftUntil(series.rrule!, series.startsAt, start, series.timeZone);
    const shape: NativeEvent = { ...series, ...times, rrule };
    const slotOf = slotMapFor(series, shape, series.startsAt, start);
    return { rrule, hebrewAnchor: series.hebrewAnchor, shape, slotOf, opened: opened ? shiftOnWall(opened, series.startsAt, start, series.timeZone) : start };
  }
  // A null anchor was refused before anything is written (rollsHebrewDay).
  const hebrewAnchor = series.hebrewRule ? (move.hebrewAnchor ?? series.hebrewAnchor) : null;
  const draft: NativeEvent = { ...series, ...times, hebrewAnchor };
  const rrule = yearlyRuleAfter({ ...series, rrule: series.rrule! }, draft, move);
  const shape: NativeEvent = { ...draft, rrule };
  const slotOf = yearlySlotMap(series, shape, move.years);
  return { rrule, hebrewAnchor, shape, slotOf, opened: opened ? yearlyOpenedSlot({ ...shape, rrule }, slotOf, opened) : start };
}

/** The pair a one-off takes when it starts repeating at `start`. */
function startingPair(input: Pick<UpdateNativeEventInput, 'hebrewRule'>, start: Date, timeZone: string): HebrewPair {
  return input.hebrewRule
    ? { hebrewRule: input.hebrewRule, hebrewAnchor: localDate(start, timeZone || TIMEZONE) }
    : { hebrewRule: null, hebrewAnchor: null };
}

/**
 * The times an edit gives, as the ones the store writes. A 'following' edit, and an 'all'
 * one with occurrenceTimes, says where the occurrence instanceStartsAt goes: the series
 * ('all') moves as that occurrence did (seriesTimesFor; `move` says how a yearly series went),
 * and the new series ('following') starts where followingTimesFor puts it. What the edit leaves
 * out stays: a start alone keeps the occurrence's length, an end alone keeps the start.
 */
/** The rule that places times after an edit: the new one when the edit sets one (null: none). */
const ruleAfter = (series: Pick<NativeEvent, 'rrule'>, input: Pick<UpdateNativeEventInput, 'rrule'>): string | null =>
  input.rrule !== undefined ? input.rrule : series.rrule;

async function ownTimes(series: NativeEvent, input: UpdateNativeEventInput): Promise<OwnTimes> {
  const slot = input.instanceStartsAt;
  const ofOccurrence = input.scope === 'following' || (input.scope === 'all' && input.occurrenceTimes);
  if (!ofOccurrence || !series.rrule || !slot) return input;
  if (input.startsAt === undefined && input.endsAt === undefined) return input;
  const override = await prisma.nativeEventInstance.findUnique({
    where: { seriesEventId_originalStartsAt: { seriesEventId: series.id, originalStartsAt: slot } },
  });
  const moved = override?.status === 'OVERRIDE' ? override : null;
  const from = moved?.startsAt ?? slot;
  const tz = series.timeZone || TIMEZONE;
  const base = input.scope === 'all' ? series.startsAt : slot;
  const allDay = input.allDay ?? moved?.allDay ?? series.allDay;
  if (input.startsAt === undefined) {
    const end = input.endsAt!;
    const endsAt = allDay
      ? endOfLocalDay(addDaysToDate(localDate(base, tz), daysFromTo(localDate(from, tz), localDate(end, tz))), tz)
      : new Date(base.getTime() + (end.getTime() - from.getTime()));
    return { ...input, endsAt };
  }
  const length = (moved?.endsAt ?? new Date(slot.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()))).getTime() - from.getTime();
  const to = { startsAt: input.startsAt, endsAt: input.endsAt ?? new Date(input.startsAt.getTime() + length), allDay };
  if (input.scope !== 'all') return { ...input, ...followingTimesFor({ rrule: ruleAfter(series, input), timeZone: series.timeZone }, slot, from, to) };
  const times = seriesTimesFor(series, { slot, start: from }, to);
  const own = moved !== null && (moved.startsAt !== null || moved.endsAt !== null || moved.allDay !== null);
  const retimed = to.startsAt.getTime() !== from.getTime() || to.endsAt.getTime() !== from.getTime() + length || to.allDay !== (moved?.allDay ?? series.allDay);
  return { ...input, startsAt: times.startsAt, endsAt: times.endsAt, move: times.yearly ?? null, ...(own && retimed ? { unmoves: slot } : {}) };
}

/**
 * Whether an edit moves a rule with fixed days to another day for more than one
 * occurrence: the series' own start ('all') or the new series' ('following') off its day.
 */
function movesFixedDays(series: NativeEvent, input: OwnTimes): boolean {
  if (rollsHebrewDay(series, input)) return true;
  if (input.startsAt === undefined || !fixesDays(ruleAfter(series, input))) return false;
  const tz = series.timeZone || TIMEZONE;
  if (input.scope === 'all') return localDate(input.startsAt, tz) !== localDate(series.startsAt, tz);
  if (input.scope === 'following' && input.instanceStartsAt) return localDate(input.startsAt, tz) !== localDate(input.instanceStartsAt, tz);
  return false;
}

/**
 * Whether `updateNativeEvent` would refuse this edit as a day move on a rule with fixed
 * days, asked without writing anything (the bot asks before its confirmation card). False
 * for anything it would refuse otherwise, or answer another way.
 */
export async function refusesFixedDays(given: UpdateNativeEventInput): Promise<boolean> {
  const series = await prisma.nativeEvent.findUnique({ where: { id: given.seriesCuid } });
  if (!series || series.isDeleted) return false;
  const input = changesOnly(series, given);
  if (!fixesDays(ruleAfter(series, input)) && !series.hebrewRule) return false;
  return movesFixedDays(series, input.rrule === null ? input : await ownTimes(series, input));
}

/**
 * A series' exdates (from `since`, if given) where its occurrences went (`slotOf`), kept
 * only where `shape` (the series as it will be) still has an occurrence.
 */
function carriedExdates(dates: readonly Date[], since: Date | undefined, slotOf: (slot: Date) => Date | null, shape: NativeEvent): Date[] {
  const moved = dates.filter((d) => !since || d.getTime() >= since.getTime()).map(slotOf).filter((d): d is Date => d !== null);
  const yields = yieldsSlots(shape, moved);
  return moved.filter((d) => yields.has(d.getTime()));
}

/**
 * Move a series' per-occurrence rows (from `since`, if given) onto `toSeries` where its
 * occurrences went (`slotOf`). A row whose new key `shape` (the series as it will be)
 * never yields goes, so none becomes an occurrence of its own. The order never puts two
 * on one key: the latest first when they move later. `clear` is what each loses (the
 * times a new time replaces, the fields the edit sets); with `dropOverrides` (a reminder
 * starts afresh) only the cancellations move.
 */
async function moveInstances(
  tx: Prisma.TransactionClient,
  o: {
    fromSeries: string;
    toSeries: string;
    since?: Date;
    slotOf: (slot: Date) => Date | null;
    shape: NativeEvent;
    dropOverrides: boolean;
    clear: Prisma.NativeEventInstanceUncheckedUpdateInput;
  }
): Promise<void> {
  const where = { seriesEventId: o.fromSeries, ...(o.since ? { originalStartsAt: { gte: o.since } } : {}) };
  if (o.dropOverrides) await tx.nativeEventInstance.deleteMany({ where: { ...where, status: 'OVERRIDE' } });
  const rows = (await tx.nativeEventInstance.findMany({ where })).map((r) => ({ r, to: o.slotOf(r.originalStartsAt) }));
  const yields = yieldsSlots(o.shape, rows.flatMap((m) => (m.to ? [m.to] : [])));
  const kept = rows.filter((m): m is { r: NativeEventInstance; to: Date } => m.to !== null && yields.has(m.to.getTime()));
  const gone = rows.filter((m) => !kept.includes(m as (typeof kept)[number])).map((m) => m.r);
  if (gone.length > 0) await tx.nativeEventInstance.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } });
  if (kept.length === 0) return;
  const later = kept[0].to.getTime() > kept[0].r.originalStartsAt.getTime();
  kept.sort((a, b) => (a.r.originalStartsAt.getTime() - b.r.originalStartsAt.getTime()) * (later ? -1 : 1));
  for (const { r, to } of kept) {
    await tx.nativeEventInstance.update({
      where: { id: r.id },
      data: { ...o.clear, seriesEventId: o.toSeries, originalStartsAt: to },
    });
  }
}

/** The edit without the series-level fields that equal what the series already has. */
function changesOnly(series: NativeEvent, input: UpdateNativeEventInput): UpdateNativeEventInput {
  const out = { ...input };
  // The rule is the pair (hebrew-repeats spec §2): a kind alone keeps the rule string, a rule
  // alone is Gregorian (no kind), and the same rule switched between Gregorian and Hebrew is a change.
  if (out.rrule === undefined && out.hebrewRule !== undefined) out.rrule = series.rrule;
  if (out.rrule !== undefined && (out.rrule ?? null) === (series.rrule ?? null) && (out.hebrewRule ?? null) === (series.hebrewRule ?? null)) {
    delete out.rrule;
    delete out.hebrewRule;
  }
  if (out.calendarId !== undefined && out.calendarId === series.calendarId) delete out.calendarId;
  if (out.alert !== undefined && out.alert === alertChoiceOf(series)) delete out.alert;
  if (out.forUserId !== undefined && (out.forUserId ?? null) === (series.forUserId ?? null)) delete out.forUserId;
  return out;
}

/**
 * Refuse a series-level change (a rule, a calendar, a recipient) the store can't make
 * (3b spec §3.1), before anything is written: the scope, the rule, the destination
 * calendar (write access there too, never the user's own private one for the partner's
 * event) and the recipient (only the creator changes it, to their partner who can be
 * pinged, or back to themselves).
 */
async function checkSeriesFields(
  series: NativeEvent,
  calendar: NativeCalendar,
  actor: Pick<User, 'id' | 'pairingId'>,
  input: UpdateNativeEventInput
): Promise<void> {
  const seriesLevel = input.rrule !== undefined || input.calendarId !== undefined || input.alert !== undefined || input.forUserId !== undefined;
  if (!seriesLevel) return;
  if (series.rrule) {
    // An occurrence has no rule, calendar, alert or recipient of its own.
    if (input.scope === 'single') throw new NativeScopeError('scope');
    // A rule changes from an occurrence on: the earlier ones keep theirs.
    if (input.rrule !== undefined && (input.scope !== 'following' || !input.instanceStartsAt)) throw new NativeScopeError('scope');
  }
  if (input.rrule !== undefined) assertStorableRule(input.rrule, input.hebrewRule);
  const isReminder = series.kind === 'REMINDER';
  // A reminder pings through its own pass: it has no alert of its own.
  if (input.alert !== undefined && isReminder) throw new NativeScopeError('alert');
  if (input.calendarId !== undefined) {
    // A reminder lives on its creator's main calendar.
    if (isReminder) throw new NativeScopeError('calendarId');
    const dest = await prisma.nativeCalendar.findUnique({ where: { id: input.calendarId } });
    if (!dest || dest.isDeleted) throw new NativeDestinationError('Destination calendar not found');
    if (!canWriteAccess(await getCalendarAccess(actor, dest))) throw new NativeDestinationError('Destination calendar not writable');
    // The partner's event would silently leave their view.
    if (calendar.ownerUserId !== actor.id && dest.ownerUserId === actor.id && dest.privacy === 'PRIVATE') {
      throw new NativeDestinationError('A partner\'s event cannot move to a private calendar');
    }
  }
  if (input.forUserId !== undefined) {
    if (!isReminder) throw new NativeRecipientError('Only a reminder has a recipient');
    if (series.creatorUserId !== actor.id) throw new NativePermissionDeniedError('Only the creator changes who a reminder is for');
    if (input.forUserId !== null) {
      // As resolve.ts targetFor: the ACTIVE partner, on Telegram.
      const partner = await getActivePartnerSummary(actor.id, actor.pairingId ?? null);
      if (!partner || partner.id !== input.forUserId || partner.telegramId === null) {
        throw new NativeRecipientError();
      }
    }
  }
}

/**
 * One occurrence of a series as it stands (its override applied), by its slot, or
 * undefined when the series has none there (cancelled, cut off, or never one). The window
 * reaches wherever an override moved it.
 */
export function occurrenceAt(series: NativeEvent, overrides: NativeEventInstance[], slot: Date): VirtualInstance | undefined {
  const override = overrides.find((o) => o.originalStartsAt.getTime() === slot.getTime());
  const length = Math.max(0, series.endsAt.getTime() - series.startsAt.getTime());
  const moved = [slot, override?.startsAt, override?.endsAt].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  const from = new Date(Math.min(...moved) - 2 * DAY_MS);
  const to = new Date(Math.max(...moved) + 2 * DAY_MS + length);
  return expandSeries(series, { from, to }, overrides).find((i) => i.instanceStartsAt.getTime() === slot.getTime());
}

/** Delete the state rows `where` matches, for occurrences that no longer exist; their live pings ("changed"). */
async function dropStates(tx: Prisma.TransactionClient, where: Prisma.NativeReminderStateWhereInput): Promise<ClearedPing[]> {
  const rows = await tx.nativeReminderState.findMany({ where, select: { pingChatId: true, pingMessageId: true } });
  if (rows.length === 0) return [];
  await tx.nativeReminderState.deleteMany({ where });
  return pingsOf(rows);
}

/**
 * Stop repeating (3b spec §3.1): from a later occurrence the series is cut there and the
 * opened occurrence becomes a one-off of its own; from the first, the series row itself
 * becomes that one-off (no rule, no skips, no rows). The one-off has the occurrence's own
 * values with the edit's on top, the series' creator and kind, and the edit's calendar and
 * recipient when it changes them. The later occurrences go. The opened one's reminder state
 * moves with it only when its time is unchanged (done and snooze kept); otherwise it goes,
 * as a time change re-arms.
 */
async function stopRepeating(series: NativeEvent, input: UpdateNativeEventInput, first: boolean): Promise<UpdateNativeEventResult> {
  const cut = input.instanceStartsAt!;
  const isReminder = series.kind === 'REMINDER';
  const tz = series.timeZone || TIMEZONE;
  const overrides = await prisma.nativeEventInstance.findMany({ where: { seriesEventId: series.id } });
  const occ = occurrenceAt(series, overrides, cut);
  if (!occ) throw new NativeNotFoundError('Occurrence not found');
  const allDay = input.allDay ?? occ.allDay;
  const start = input.startsAt ?? occ.startsAt;
  const end = input.endsAt ?? (input.startsAt ? new Date(start.getTime() + (occ.endsAt.getTime() - occ.startsAt.getTime())) : occ.endsAt);
  const times = isReminder ? normalizeReminderTimes(start, allDay, tz) : { startsAt: start, endsAt: end };
  const moved = times.startsAt.getTime() !== occ.startsAt.getTime() || allDay !== occ.allDay;
  const reassign = isReminder && input.forUserId !== undefined;
  // The alert the one-off ends up with: the edit's, else the series' own.
  const alertNow = input.alert !== undefined ? alertColumns(input.alert) : { ownAlerts: series.ownAlerts, alertMinutes: series.alertMinutes };
  const values = {
    ...alertNow,
    title: input.title ?? occ.title,
    description: input.description !== undefined ? input.description : (occ.description ?? null),
    location: input.location !== undefined ? input.location : (occ.location ?? null),
    ...times,
    allDay,
    calendarId: input.calendarId ?? series.calendarId,
    ...(isReminder
      ? { forUserId: reassign ? input.forUserId! : series.forUserId, armedAt: moved ? new Date() : series.armedAt }
      : {}),
  };
  const pings = { clearedPings: [] as ClearedPing[], changedPings: [] as ClearedPing[], reassignedPings: [] as ClearedPing[] };
  /** The opened occurrence's state row, once the one-off `to` is its home. */
  const settleOpened = async (tx: Prisma.TransactionClient, to: string) => {
    const row = await tx.nativeReminderState.findUnique({
      where: { seriesEventId_originalStartsAt: { seriesEventId: series.id, originalStartsAt: cut } },
      select: { id: true, doneAt: true, pingChatId: true, pingMessageId: true },
    });
    if (!row) return;
    const startsAfresh = reassign && row.doneAt === null;
    if (moved || startsAfresh) {
      await tx.nativeReminderState.deleteMany({ where: { id: row.id } });
      (startsAfresh ? pings.reassignedPings : pings.clearedPings).push(...pingsOf([row]));
      return;
    }
    await tx.nativeReminderState.update({ where: { id: row.id }, data: { seriesEventId: to, originalStartsAt: times.startsAt } });
  };
  const oneOffId = await markedTransaction(async (tx) => {
    if (first) {
      if (isReminder) {
        // The others go first, so the re-key can't land on one of their keys.
        pings.changedPings = await dropStates(tx, { seriesEventId: series.id, originalStartsAt: { not: cut } });
        await settleOpened(tx, series.id);
      }
      await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id } });
      await tx.nativeEvent.update({ where: { id: series.id }, data: { ...values, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [] } });
      await markSyncDirty(tx, { series: [synced(series, series.calendarId, values.calendarId)] });
      return series.id;
    }
    await tx.nativeEvent.update({ where: { id: series.id }, data: { rrule: truncateRruleBefore(series.rrule!, cut, series.timeZone) } });
    const oneOff = await tx.nativeEvent.create({
      data: {
        ...values,
        creatorUserId: series.creatorUserId,
        kind: series.kind,
        timeZone: series.timeZone,
        rrule: null,
        hebrewRule: null,
        hebrewAnchor: null,
      },
    });
    await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id, originalStartsAt: { gte: cut } } });
    if (isReminder) {
      pings.changedPings = await dropStates(tx, { seriesEventId: series.id, originalStartsAt: { gt: cut } });
      await settleOpened(tx, oneOff.id);
    }
    await markSyncDirty(tx, { series: [synced(series, series.calendarId), synced(oneOff, oneOff.calendarId)] });
    return oneOff.id;
  });
  return resultOf(encodeEventId(oneOffId), { seriesId: oneOffId, slot: null }, pings);
}

/**
 * Update an event with scope semantics that mirror the GCal flow.
 * Returns the canonical id the caller should reference afterwards (the series
 * cuid for scope=all/following, or the instance composite id for scope=single),
 * and, for a reminder whose time changed, the live pings to strip the buttons from.
 */
export async function updateNativeEvent(given: UpdateNativeEventInput): Promise<UpdateNativeEventResult> {
  let input: OwnTimes = given;
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
  input = changesOnly(series, input);
  await checkSeriesFields(series, calendar, actor, input);
  // A stop's times are where the cut occurrence goes, as they are (3b spec §3.1).
  const stop = input.rrule === null && !!series.rrule;
  if (!stop) input = await ownTimes(series, input);
  if (movesFixedDays(series, input)) throw new NativeFixedDaysError();
  // "This one and the ones after" from the first occurrence is the whole series, changed in
  // place: no empty series is left behind (3b spec §3.1).
  const first = input.scope === 'following' && !!series.rrule && !!input.instanceStartsAt && (await isFirstOccurrence(series, input.instanceStartsAt));
  if (stop) {
    const result = await stopRepeating(series, input, first);
    if (isReminder) invalidateDueGate();
    return result;
  }
  if (isReminder) {
    const result = await updateNativeReminder(series, input, first);
    invalidateDueGate();
    return result;
  }

  // Field update bag for series-level changes
  const seriesUpdate: Prisma.NativeEventUncheckedUpdateInput = {};
  if (input.title !== undefined) seriesUpdate.title = input.title;
  if (input.description !== undefined) seriesUpdate.description = input.description;
  if (input.location !== undefined) seriesUpdate.location = input.location;
  if (input.startsAt !== undefined) seriesUpdate.startsAt = input.startsAt;
  if (input.endsAt !== undefined) seriesUpdate.endsAt = input.endsAt;
  if (input.allDay !== undefined) seriesUpdate.allDay = input.allDay;
  if (input.calendarId !== undefined) seriesUpdate.calendarId = input.calendarId;
  if (input.alert !== undefined) Object.assign(seriesUpdate, alertColumns(input.alert));
  // A one-off that starts repeating keeps its row; its key gains its start.
  if (input.rrule && !series.rrule) {
    seriesUpdate.rrule = input.rrule;
    Object.assign(seriesUpdate, startingPair(input, input.startsAt ?? series.startsAt, series.timeZone));
  }
  const oneOffSlot = input.rrule && !series.rrule ? (input.startsAt ?? series.startsAt) : null;

  // Single occurrence (recurring): write/upsert NativeEventInstance OVERRIDE
  if (input.scope === 'single' && series.rrule && input.instanceStartsAt) {
    const occ = input.instanceStartsAt;
    await eventWrite(series.kind, async (db) => {
      await db.nativeEventInstance.upsert({
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
      await markSyncDirty(db, { series: [synced(series, series.calendarId)] });
    });
    return resultOf(encodeEventId(series.id, occ), { seriesId: series.id, slot: occ });
  }

  // Single occurrence on a non-recurring event: act on the series itself.
  if (input.scope === 'single' && !series.rrule) {
    await eventWrite(series.kind, async (db) => {
      await db.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      await markSyncDirty(db, { series: [synced(series, series.calendarId, input.calendarId)] });
    });
    return resultOf(encodeEventId(series.id), { seriesId: series.id, slot: oneOffSlot });
  }

  // 'all': update the series. New times reach every occurrence: the ones moved on their
  // own lose their own times and keep what else they carry (a title). A new start moves
  // what was done to the occurrences one by one with them (seriesMoved: shifted on the wall
  // clock as the start moved, or a yearly series by its years): the skipped stay skipped
  // (exdates, CANCELLED), the renamed renamed, wherever the rule still has an occurrence;
  // the UNTIL moves too.
  // A start that is the series' own moves nothing (the bot resends it with a new end, or
  // with nothing new at all), so what was done to the occurrences one by one stays.
  // A Hebrew series whose yearly move gives it another anchor moves though its start stays (movesAnchor).
  if (input.scope === 'all') {
    const start = input.startsAt && input.startsAt.getTime() === series.startsAt.getTime() && !movesAnchor(series, input) ? undefined : input.startsAt;
    const retimed =
      (input.endsAt !== undefined && input.endsAt.getTime() !== series.endsAt.getTime()) ||
      (input.allDay !== undefined && input.allDay !== series.allDay);
    const moved = start !== undefined && series.rrule
      ? seriesMoved(series, input, {
          startsAt: start,
          endsAt: input.endsAt ?? new Date(start.getTime() + (series.endsAt.getTime() - series.startsAt.getTime())),
          allDay: input.allDay ?? series.allDay,
        })
      : undefined;
    const updateAll = async (tx: Prisma.TransactionClient) => {
      if (moved) {
        await tx.nativeEvent.update({
          where: { id: series.id },
          data: { ...seriesUpdate, rrule: moved.rrule, hebrewAnchor: moved.hebrewAnchor, exdates: carriedExdates(series.exdates, undefined, moved.slotOf, moved.shape) },
        });
        await moveInstances(tx, {
          fromSeries: series.id, toSeries: series.id, slotOf: moved.slotOf, shape: moved.shape, dropOverrides: false,
          clear: { startsAt: null, endsAt: null, allDay: null },
        });
        return;
      }
      await tx.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      if (start !== undefined) {
        await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id } });
      } else if (retimed) {
        await tx.nativeEventInstance.updateMany({
          where: { seriesEventId: series.id, status: 'OVERRIDE' },
          data: { startsAt: null, endsAt: null, allDay: null },
        });
      } else if (input.unmoves && series.rrule) {
        // The series stays where it is, and the opened occurrence, moved on its own, comes back to it.
        await tx.nativeEventInstance.updateMany({
          where: { seriesEventId: series.id, originalStartsAt: input.unmoves, status: 'OVERRIDE' },
          data: { startsAt: null, endsAt: null, allDay: null },
        });
      }
    };
    // The mark goes last, as in every other writer: the event row is locked before the item
    // row, so two writers on one series never take the two locks in opposite orders.
    await markedTransaction(async (tx) => {
      await updateAll(tx);
      await markSyncDirty(tx, { series: [synced(series, series.calendarId, input.calendarId)] });
    });
    // The opened occurrence is where its slot went (the series' first, when none was given).
    const opened = input.instanceStartsAt ?? series.startsAt;
    const slot = !series.rrule ? oneOffSlot : moved ? moved.opened : opened;
    return resultOf(encodeEventId(series.id), { seriesId: series.id, slot });
  }

  // 'following': truncate the original series and create a new one starting
  // from the targeted instance.
  if (input.scope === 'following') {
    if (!series.rrule || !input.instanceStartsAt) {
      // Fallback: nothing to truncate; treat as 'all'. A Hebrew series' anchor moves with its start, by its years.
      const anchor = series.hebrewAnchor ? yearlyMoveOf(series, input)?.hebrewAnchor : undefined;
      if (anchor) seriesUpdate.hebrewAnchor = anchor;
      await eventWrite(series.kind, async (db) => {
        await db.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
        await markSyncDirty(db, { series: [synced(series, series.calendarId, input.calendarId)] });
      });
      return resultOf(encodeEventId(series.id), { seriesId: series.id, slot: series.rrule ? series.startsAt : oneOffSlot });
    }
    const cut = input.instanceStartsAt;
    // What was done to the occurrences from the cut one by one comes along: the skipped stay
    // skipped (exdates, CANCELLED) and the moved or renamed keep it, each keyed where the
    // new part puts it (its slot shifted on the wall clock as the cut occurrence moved),
    // wherever the rule still has an occurrence. A field this edit sets wins over an
    // occurrence's own.
    const newStarts = input.startsAt ?? cut;
    const newEnds = input.endsAt ?? new Date(newStarts.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()));
    const pair = tailPair(series, input, cut, newStarts);
    const rrule = tailRule(series, cut, newStarts, input.rrule ?? undefined, pair);
    const shape: NativeEvent = { ...series, ...pair, rrule, startsAt: newStarts, endsAt: newEnds, allDay: input.allDay ?? series.allDay };
    const slotOf = slotMapFor(series, shape, cut, newStarts);
    const retimed = input.startsAt !== undefined || input.endsAt !== undefined || input.allDay !== undefined;
    const clear: Prisma.NativeEventInstanceUncheckedUpdateInput = {
      ...(input.title !== undefined ? { title: null } : {}),
      ...(input.description !== undefined ? { description: null } : {}),
      ...(input.location !== undefined ? { location: null } : {}),
      ...(retimed ? { startsAt: null, endsAt: null, allDay: null } : {}),
    };
    if (first) {
      // The whole series becomes what the new part would have been, under its own id: its
      // start is the cut's new place and its rows are re-keyed in place.
      await markedTransaction(async (tx) => {
        await tx.nativeEvent.update({
          where: { id: series.id },
          data: {
            ...seriesUpdate,
            startsAt: newStarts,
            endsAt: newEnds,
            allDay: shape.allDay,
            rrule,
            ...pair,
            exdates: carriedExdates(series.exdates, undefined, slotOf, shape),
          },
        });
        await moveInstances(tx, { fromSeries: series.id, toSeries: series.id, slotOf, shape, dropOverrides: false, clear });
        await markSyncDirty(tx, { series: [synced(series, series.calendarId, input.calendarId)] });
      });
      return resultOf(encodeEventId(series.id), { seriesId: series.id, slot: newStarts });
    }
    const newSeriesId = await markedTransaction(async (tx) => {
      // 1. Truncate parent rrule
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, cut, series.timeZone) },
      });
      // 2. Insert new series starting from the instance, with overrides applied.
      const newSeries = await tx.nativeEvent.create({
        data: {
          calendarId: input.calendarId ?? series.calendarId,
          creatorUserId: input.actingUserId,
          title: input.title ?? series.title,
          description: input.description ?? series.description,
          location: input.location ?? series.location,
          startsAt: newStarts,
          endsAt: newEnds,
          allDay: shape.allDay,
          timeZone: series.timeZone,
          rrule,
          ...pair,
          // The tail gets the new alert; the head keeps its own.
          ...(input.alert !== undefined ? alertColumns(input.alert) : { ownAlerts: series.ownAlerts, alertMinutes: series.alertMinutes }),
          exdates: carriedExdates(series.exdates, cut, slotOf, shape),
        },
      });
      // 3. Move the overrides at-or-after the cut point to the new series.
      await moveInstances(tx, { fromSeries: series.id, toSeries: newSeries.id, since: cut, slotOf, shape, dropOverrides: false, clear });
      await markSyncDirty(tx, { series: [synced(series, series.calendarId), synced(newSeries, newSeries.calendarId)] });
      return newSeries.id;
    });
    return resultOf(encodeEventId(newSeriesId), { seriesId: newSeriesId, slot: newStarts });
  }

  return resultOf(encodeEventId(series.id), { seriesId: series.id, slot: input.instanceStartsAt ?? (series.rrule ? series.startsAt : null) });
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
  input: OwnTimes,
  first: boolean
): Promise<UpdateNativeEventResult> {
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
    return resultOf(encodeEventId(series.id, key.originalStartsAt), { seriesId: series.id, slot: key.originalStartsAt }, { clearedPings });
  }

  // 'following' from an occurrence: cut the series there and start a new one. The new
  // series stays the creator's reminder, for the same person unless the edit changes it,
  // whoever made the edit.
  const newRule = input.rrule ?? undefined;
  const reassign = input.forUserId !== undefined;
  const forUserId = reassign ? input.forUserId! : series.forUserId;
  if (input.scope === 'following' && series.rrule && input.instanceStartsAt) {
    const cut = input.instanceStartsAt;
    const edit = reminderTimeEdit({ startsAt: cut, allDay: series.allDay }, input, series.timeZone);
    const target = edit ?? { startsAt: cut, endsAt: cut, allDay: series.allDay, changed: false };
    const pair = tailPair(series, input, cut, target.startsAt);
    const rrule = tailRule(series, cut, target.startsAt, newRule, pair);
    const shape: NativeEvent = { ...series, ...pair, rrule, startsAt: target.startsAt, endsAt: target.endsAt, allDay: target.allDay };
    const slotOf = slotMapFor(series, shape, cut, target.startsAt);
    const cleared = {
      ...(input.title !== undefined ? { title: null } : {}),
      ...(input.description !== undefined ? { description: null } : {}),
      ...(input.location !== undefined ? { location: null } : {}),
    };
    // A new time starts the occurrences afresh; so does a new rule, which may make some in
    // the past: armed from now, those don't ping (3b spec §3.1, Re-arm).
    const armedAt = target.changed || newRule !== undefined ? new Date() : series.armedAt;
    const key = (seriesId: string) => ({ seriesId, slot: target.startsAt });
    /**
     * The state of the occurrences from the cut, once they belong to `seriesId`: all gone
     * when the time moved; else those the rule no longer yields gone; and with a new
     * recipient the open ones start afresh for them.
     */
    const settleStates = async (tx: Prisma.TransactionClient, seriesId: string, since?: Date) => {
      const where = { seriesEventId: series.id, ...(since ? { originalStartsAt: { gte: since } } : {}) };
      if (target.changed) return takeStates(tx, where, reassign, newRule !== undefined ? { slotOf, shape } : undefined);
      const changedPings = newRule !== undefined || seriesId === series.id
        ? await keepYieldedStates(tx, { fromSeries: series.id, toSeries: seriesId, since, shape })
        : (await tx.nativeReminderState.updateMany({ where, data: { seriesEventId: seriesId } }), []);
      const reassignedPings = reassign ? await reassignOpenStates(tx, { seriesEventId: seriesId, ...(since ? { originalStartsAt: { gte: since } } : {}) }) : [];
      return { changedPings, reassignedPings };
    };
    if (first) {
      // From the first occurrence it is the whole series, changed in place (3b spec §3.1):
      // its start goes where the cut goes and its rows are re-keyed and checked in place.
      const pings = await prisma.$transaction(async (tx) => {
        await tx.nativeEvent.update({
          where: { id: series.id },
          data: {
            ...text,
            startsAt: target.startsAt,
            endsAt: target.endsAt,
            allDay: target.allDay,
            rrule,
            ...pair,
            exdates: carriedExdates(series.exdates, undefined, slotOf, shape),
            armedAt,
            forUserId,
          },
        });
        await moveInstances(tx, { fromSeries: series.id, toSeries: series.id, slotOf, shape, dropOverrides: target.changed, clear: target.changed ? {} : cleared });
        return settleStates(tx, series.id);
      });
      return resultOf(encodeEventId(series.id), key(series.id), pings);
    }
    const { newSeriesId, pings } = await prisma.$transaction(async (tx) => {
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
          rrule,
          ...pair,
          ownAlerts: series.ownAlerts,
          alertMinutes: series.alertMinutes,
          kind: 'REMINDER',
          forUserId,
          armedAt,
          // The occurrences skipped after the cut stay skipped, keyed where they went.
          exdates: carriedExdates(series.exdates, cut, slotOf, shape),
        },
      });
      const fromCut = { seriesEventId: series.id, originalStartsAt: { gte: cut } };
      if (target.changed) {
        // Moved, the new series starts afresh: what was moved on its own goes; the
        // cancellations follow, keyed where the new series puts them.
        await moveInstances(tx, { fromSeries: series.id, toSeries: newSeries.id, since: cut, slotOf, shape, dropOverrides: true, clear: {} });
      } else if (newRule !== undefined) {
        // A new rule: the rows follow where it still has an occurrence, and the others go,
        // since an override the rule doesn't yield would show, and ping, on its own.
        await moveInstances(tx, { fromSeries: series.id, toSeries: newSeries.id, since: cut, slotOf, shape, dropOverrides: false, clear: cleared });
      } else {
        // Same keys under the new series, so skipped and moved occurrences follow it.
        // A field this edit sets wins over an older per-occurrence value.
        await tx.nativeEventInstance.updateMany({ where: fromCut, data: { seriesEventId: newSeries.id, ...cleared } });
      }
      // Unmoved, the new series' occurrences keep the same instants, so their done/snoozed
      // state follows them to it.
      return { newSeriesId: newSeries.id, pings: await settleStates(tx, newSeries.id, cut) };
    });
    return resultOf(encodeEventId(newSeriesId), key(newSeriesId), pings);
  }

  // The series itself: a one-off reminder, every occurrence ('all'), or 'following'
  // with nothing to cut. 'single' on a series with no occurrence given changes
  // nothing, as for an event.
  if (input.scope === 'single' && series.rrule) {
    return resultOf(encodeEventId(series.id), { seriesId: series.id, slot: series.startsAt });
  }
  const edit = reminderTimeEdit({ startsAt: series.startsAt, allDay: series.allDay }, input, series.timeZone);
  // A one-off that starts repeating keeps its row, and its state at its start.
  const startsRepeating = !!input.rrule && !series.rrule;
  // The occurrences move when the start does, or when a Hebrew series' anchor does with its start staying (movesAnchor).
  const changed = Boolean(edit?.changed) || movesAnchor(series, input);
  // Where every occurrence goes then (seriesMoved).
  const moved = edit && changed && series.rrule ? seriesMoved(series, input, edit) : undefined;
  const pings = await prisma.$transaction(async (tx) => {
    await tx.nativeEvent.update({
      where: { id: series.id },
      data: {
        ...text,
        ...(edit ? { startsAt: edit.startsAt, endsAt: edit.endsAt, allDay: edit.allDay } : {}),
        ...(changed ? { armedAt: new Date() } : {}),
        // A Hebrew series' anchor moves with its start, by its years ('all', or 'following' with nothing to cut).
        ...(moved && series.hebrewAnchor ? { hebrewAnchor: moved.hebrewAnchor } : {}),
        ...(startsRepeating ? { rrule: input.rrule, ...startingPair(input, edit?.startsAt ?? series.startsAt, series.timeZone) } : {}),
        ...(reassign ? { forUserId } : {}),
      },
    });
    if (!changed) {
      // Every occurrence at the series' time, which stays: the ones moved on their own come back to it.
      const clearedPings = edit && input.scope === 'all' && series.rrule ? await unmoveOccurrences(tx, series) : [];
      const reassignedPings = reassign ? await reassignOpenStates(tx, { seriesEventId: series.id }) : [];
      return { clearedPings, reassignedPings };
    }
    // Every occurrence moves and starts afresh: what was moved on its own goes, and what
    // was skipped stays skipped, keyed where it went.
    if (input.scope === 'all' && moved) {
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: moved.rrule, hebrewAnchor: moved.hebrewAnchor, exdates: carriedExdates(series.exdates, undefined, moved.slotOf, moved.shape) },
      });
      await moveInstances(tx, { fromSeries: series.id, toSeries: series.id, slotOf: moved.slotOf, shape: moved.shape, dropOverrides: true, clear: {} });
    }
    return takeStates(tx, { seriesEventId: series.id }, reassign);
  });
  // The opened occurrence is where its slot went (the series' first, when none was given).
  const opened = input.instanceStartsAt ?? series.startsAt;
  const start = edit?.startsAt ?? series.startsAt;
  const slot = startsRepeating ? start : !series.rrule ? null : moved ? moved.opened : opened;
  return resultOf(encodeEventId(series.id), { seriesId: series.id, slot }, pings);
}

/**
 * Delete the state rows `where` matches, as a time change does (each pings again at its new
 * time), and return their live pings: "moved", or, with `reassign` (a new recipient in the
 * same save), "now for" for the open ones. With a new rule (`rule`: where each slot goes and
 * the series as it will be), an occurrence the rule no longer yields didn't move, it is
 * gone: "changed".
 */
async function takeStates(
  tx: Prisma.TransactionClient,
  where: Prisma.NativeReminderStateWhereInput,
  reassign: boolean,
  rule?: { slotOf: (slot: Date) => Date | null; shape: NativeEvent }
): Promise<{ clearedPings: ClearedPing[]; reassignedPings: ClearedPing[]; changedPings: ClearedPing[] }> {
  const rows = await tx.nativeReminderState.findMany({ where, select: { originalStartsAt: true, doneAt: true, pingChatId: true, pingMessageId: true } });
  if (rows.length === 0) return { clearedPings: [], reassignedPings: [], changedPings: [] };
  await tx.nativeReminderState.deleteMany({ where });
  const to = (r: { originalStartsAt: Date }) => rule?.slotOf(r.originalStartsAt) ?? null;
  const yields = rule ? yieldsSlots(rule.shape, rows.flatMap((r) => to(r) ?? [])) : null;
  const gone = (r: { originalStartsAt: Date }) => yields !== null && !yields.has(to(r)?.getTime() ?? NaN);
  const open = (r: { doneAt: Date | null }) => reassign && r.doneAt === null;
  return {
    changedPings: pingsOf(rows.filter(gone)),
    reassignedPings: pingsOf(rows.filter((r) => !gone(r) && open(r))),
    clearedPings: pingsOf(rows.filter((r) => !gone(r) && !open(r))),
  };
}

/**
 * A new recipient (3b spec §3.1): the open (not done) state rows `where` matches are
 * deleted, so each occurrence starts afresh for them, and their live pings come back for
 * "now for". Done ones stay done.
 */
async function reassignOpenStates(tx: Prisma.TransactionClient, where: Prisma.NativeReminderStateWhereInput): Promise<ClearedPing[]> {
  const open = { ...where, doneAt: null };
  const rows = await tx.nativeReminderState.findMany({ where: open, select: { pingChatId: true, pingMessageId: true } });
  if (rows.length === 0) return [];
  await tx.nativeReminderState.deleteMany({ where: open });
  return pingsOf(rows);
}

/**
 * The state rows of a series' occurrences (from `since`, if given) where `shape`, the
 * series as it will be, still has an occurrence at their key: moved to `toSeries`, while
 * the rest are deleted, as their occurrences no longer exist. Returns those rows' live
 * pings ("changed").
 */
async function keepYieldedStates(
  tx: Prisma.TransactionClient,
  o: { fromSeries: string; toSeries: string; since?: Date; shape: NativeEvent }
): Promise<ClearedPing[]> {
  const rows = await tx.nativeReminderState.findMany({
    where: { seriesEventId: o.fromSeries, ...(o.since ? { originalStartsAt: { gte: o.since } } : {}) },
    select: { id: true, originalStartsAt: true, pingChatId: true, pingMessageId: true },
  });
  const yields = yieldsSlots(o.shape, rows.map((r) => r.originalStartsAt));
  const gone = rows.filter((r) => !yields.has(r.originalStartsAt.getTime()));
  const kept = rows.filter((r) => yields.has(r.originalStartsAt.getTime()));
  if (gone.length > 0) await tx.nativeReminderState.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } });
  if (kept.length > 0 && o.toSeries !== o.fromSeries) {
    await tx.nativeReminderState.updateMany({ where: { id: { in: kept.map((r) => r.id) } }, data: { seriesEventId: o.toSeries } });
  }
  return pingsOf(gone);
}

/** The live ping messages of some state rows. */
function pingsOf(rows: Array<{ pingChatId: bigint | null; pingMessageId: number | null }>): ClearedPing[] {
  return rows.flatMap((r) =>
    r.pingChatId !== null && r.pingMessageId !== null ? [{ chatId: r.pingChatId, messageId: r.pingMessageId }] : []
  );
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
    await markedTransaction(async (tx) => {
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
      await markSyncDirty(tx, { series: [synced(series, series.calendarId)] });
    });
    return;
  }

  // Single on non-recurring: soft-delete the row.
  if (input.scope === 'single' && !series.rrule) {
    await softDelete(series);
    return;
  }

  // 'all': soft-delete the series (and its overrides cascade via FK).
  if (input.scope === 'all') {
    await softDelete(series);
    return;
  }

  // 'following': truncate parent rrule before the instance so the series stops
  // before that date. Drop overrides at-or-after the cut. From the first occurrence it
  // is the whole series (3b spec §3.1), so no empty series is left behind.
  if (input.scope === 'following' && series.rrule && input.instanceStartsAt) {
    if (await isFirstOccurrence(series, input.instanceStartsAt)) {
      await softDelete(series);
      return;
    }
    await markedTransaction(async (tx) => {
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, input.instanceStartsAt!, series.timeZone) },
      });
      await tx.nativeEventInstance.deleteMany({
        where: { seriesEventId: series.id, originalStartsAt: { gte: input.instanceStartsAt! } },
      });
      await markSyncDirty(tx, { series: [synced(series, series.calendarId)] });
    });
    return;
  }

  // 'following' with nothing to truncate - a one-off event, or a series we were
  // given no occurrence for. Delete the event, matching the Google path, which
  // falls through to deleting the whole event in the same situation. Previously
  // this fell off the end having done nothing while the caller still reported
  // "Event deleted!" - and it is reachable, because the model is instructed to
  // emit scope 'following' for "from now on" even on a non-recurring event.
  await softDelete(series);
}

/** Soft-delete a series row, with its Google copy's mark. */
async function softDelete(series: NativeEvent): Promise<void> {
  await eventWrite(series.kind, async (db) => {
    await db.nativeEvent.update({ where: { id: series.id }, data: { isDeleted: true } });
    await markSyncDirty(db, { series: [synced(series, series.calendarId)] });
  });
}
