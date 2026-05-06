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
import { expandSeries, truncateRruleBefore, VirtualInstance } from './recurrence';

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

// --- Events: read -----------------------------------------------------------

export interface FetchRange {
  from: Date;
  to: Date;
}

/**
 * Fetch all events (single + recurring expanded) across a set of calendars
 * within a date range. The caller is responsible for permission filtering
 * (typically by passing in calendars from listVisibleCalendars).
 */
export async function fetchEventsInCalendars(
  calendarCuids: string[],
  range: FetchRange
): Promise<Array<{ calendar: NativeCalendar; series: NativeEvent; instance: VirtualInstance }>> {
  if (calendarCuids.length === 0) return [];

  const calendars = await prisma.nativeCalendar.findMany({
    where: { id: { in: calendarCuids }, isDeleted: false },
  });
  const calendarsById = new Map(calendars.map((c) => [c.id, c]));

  // Pull all candidate series — recurring (rrule != null) get filtered later by
  // expansion; one-offs are filtered cheaply at the SQL level via startsAt range.
  const series = await prisma.nativeEvent.findMany({
    where: {
      calendarId: { in: calendarCuids },
      isDeleted: false,
      OR: [
        // single-event: must start in range
        { rrule: null, startsAt: { gte: range.from, lt: range.to } },
        // recurring: include all whose dtstart is before range.to and (no UNTIL
        // filter at SQL level — rrule expansion handles bounded series).
        { rrule: { not: null }, startsAt: { lt: range.to } },
      ],
    },
  });

  if (series.length === 0) return [];

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

  const out: Array<{ calendar: NativeCalendar; series: NativeEvent; instance: VirtualInstance }> = [];
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

  return prisma.nativeEvent.create({
    data: {
      calendarId: input.calendarCuid,
      creatorUserId: input.creatorUserId,
      title: input.title,
      description: input.description,
      location: input.location,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      timeZone: input.timeZone,
      rrule: input.rrule ?? null,
      reminderMinutes: input.reminderMinutes ?? null,
    },
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
}

/**
 * Update an event with scope semantics that mirror the GCal flow.
 * Returns the canonical id the caller should reference afterwards (the series
 * cuid for scope=all/following, or the instance composite id for scope=single).
 */
export async function updateNativeEvent(input: UpdateNativeEventInput): Promise<{ canonicalEventId: string }> {
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
  if (!canWriteAccess(access)) throw new NativePermissionDeniedError();

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
    return { canonicalEventId: encodeEventId(series.id, occ) };
  }

  // Single occurrence on a non-recurring event: act on the series itself.
  if (input.scope === 'single' && !series.rrule) {
    await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
    return { canonicalEventId: encodeEventId(series.id) };
  }

  // 'all': update the series. If startsAt changes we wipe orphan overrides
  // (matches GCal behavior; documented in the plan).
  if (input.scope === 'all') {
    await prisma.$transaction(async (tx) => {
      await tx.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      if (input.startsAt !== undefined) {
        await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id } });
      }
    });
    return { canonicalEventId: encodeEventId(series.id) };
  }

  // 'following': truncate the original series and create a new one starting
  // from the targeted instance.
  if (input.scope === 'following') {
    if (!series.rrule || !input.instanceStartsAt) {
      // Fallback: nothing to truncate; treat as 'all'
      await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      return { canonicalEventId: encodeEventId(series.id) };
    }
    const newSeriesId = await prisma.$transaction(async (tx) => {
      // 1. Truncate parent rrule
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, input.instanceStartsAt!) },
      });
      // 2. Insert new series starting from the instance, with overrides applied
      const newStarts = input.startsAt ?? input.instanceStartsAt!;
      const newEnds = input.endsAt ?? new Date(newStarts.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()));
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
        },
      });
      // 3. Migrate overrides at-or-after the cut point to the new series and
      //    rebase their originalStartsAt onto the new series' rrule cycle.
      //    Simplest correct behavior: drop those overrides — the new series
      //    already carries the new defaults from the cut point. (Edits to
      //    individual instances post-cut can be reapplied later.)
      await tx.nativeEventInstance.deleteMany({
        where: {
          seriesEventId: series.id,
          originalStartsAt: { gte: input.instanceStartsAt! },
        },
      });
      return newSeries.id;
    });
    return { canonicalEventId: encodeEventId(newSeriesId) };
  }

  return { canonicalEventId: encodeEventId(series.id) };
}

// --- Events: delete ---------------------------------------------------------

export interface DeleteNativeEventInput {
  seriesCuid: string;
  instanceStartsAt?: Date;
  scope: UpdateScope;
  actingUserId: number;
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
  if (!canWriteAccess(access)) throw new NativePermissionDeniedError();

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
        data: { rrule: truncateRruleBefore(series.rrule!, input.instanceStartsAt!) },
      });
      await tx.nativeEventInstance.deleteMany({
        where: { seriesEventId: series.id, originalStartsAt: { gte: input.instanceStartsAt! } },
      });
    });
  }
}
