// The read side of the calendar home's editing (home editing spec §3): what the "+" needs
// (editorInfo), and one FamCal item read live from the store with what the home's DTO
// lacks, the series and the permissions (loadItem, itemEditInfo). The write routes load
// the item the same way, so what the editor showed and what a write acts on agree.

import type { NativeCalendar, NativeEvent, NativeEventInstance } from '@prisma/client';
import { RRule } from 'rrule';
import type {
  EditorCalendar,
  EditorInfoResponse,
  ItemEditInfoResponse,
  RepeatInfo,
} from '../../lib/calendar-view/editor-types';
import type { UserConfig } from '../../types';
import { TIMEZONE } from '../../config/constants';
import { prisma } from '../../utils/prisma';
import {
  canWriteAccess,
  encodeCalendarId,
  getCalendarAccess,
  listVisibleCalendars,
  mayDeleteReminder,
  type NativeAccess,
} from '../native-calendar/event-store';
import { expandSeries, fixesDays, type VirtualInstance } from '../native-calendar/recurrence';
import { effectiveOwnerForViewer, loadViewerContext, type ViewerContext } from '../native-reminders/ownership';
import { getReminderSupport } from '../native-reminders/support';
import type { ItemKey } from './validate';
import { instantToWall, lastDayOf, localDate } from './walltime';

const DAY_MS = 86_400_000;

/** The viewer's calendars they may add events to (own, and the partner's SHARED_EDITOR), the viewer's first. */
export async function writableCalendars(user: UserConfig): Promise<EditorCalendar[]> {
  const [visible, ctx] = await Promise.all([
    listVisibleCalendars(user.id, user.pairingId ?? null),
    loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }),
  ]);
  const own = visible.filter((c) => c.ownerUserId === user.id);
  // The main one, as getMainNativeCalendar picks it, without its write when there is none.
  const main = own.find((c) => c.labels.includes('primary')) ?? own[0];
  const out: EditorCalendar[] = [];
  for (const c of visible) {
    const access = await getCalendarAccess(user, c);
    if (!canWriteAccess(access)) continue;
    const mine = c.ownerUserId === user.id;
    out.push({
      id: encodeCalendarId(c.id),
      name: c.name,
      color: c.color,
      main: main?.id === c.id,
      mine,
      ...(!mine && ctx.partner ? { ownerName: ctx.partner.name } : {}),
    });
  }
  return out.sort((a, b) => Number(b.mine) - Number(a.mine));
}

/** GET /api/calendar/editor: what the user can add, to which calendars, and for whom. */
export async function editorInfo(user: UserConfig, tz: string): Promise<EditorInfoResponse> {
  const native = user.calendarSource === 'NATIVE';
  const [calendars, reminders, ctx] = await Promise.all([
    native ? writableCalendars(user) : Promise.resolve([]),
    // quiet: a hint, not a gate, so a plan without reminders logs nothing
    getReminderSupport(user, { quiet: true }),
    loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }),
  ]);
  const partner = native && ctx.partner
    ? { name: ctx.partner.name, canRemind: ctx.partner.calendarSource === 'NATIVE' && ctx.partner.telegramId !== null }
    : null;
  return {
    kinds: { event: native && calendars.length > 0, reminder: reminders.supported },
    calendars,
    partner,
    tz,
  };
}

/** The result of looking an item up: it, or why not. 'changed' is an occurrence that is gone from a series that is not. */
export type LoadedItem =
  | {
      status: 'ok';
      series: NativeEvent;
      calendar: NativeCalendar;
      access: NativeAccess;
      ctx: ViewerContext;
      /** The occurrence as it stands (overrides applied). */
      occurrence: VirtualInstance;
      /** The series' override rows for this occurrence's slot, if any. */
      override: NativeEventInstance | undefined;
      /** A reminder the partner set for the viewer on a calendar the viewer can't see. */
      masked: boolean;
      canEdit: boolean;
      canDelete: boolean;
    }
  | { status: 'not_found' | 'changed' };

/**
 * One FamCal occurrence, read live. not_found: not on the built-in calendar, no such
 * series, or not one the viewer can see (the partner's private calendar, unless it is a
 * reminder the partner set for them). changed: the series is there but the occurrence is
 * not (cancelled, cut off by "this one and the ones after", or it never was one).
 */
export async function loadItem(user: UserConfig, key: ItemKey): Promise<LoadedItem> {
  if (user.calendarSource !== 'NATIVE') return { status: 'not_found' };
  const series = await prisma.nativeEvent.findUnique({ where: { id: key.seriesCuid } });
  if (!series || series.isDeleted) return { status: 'not_found' };
  const calendar = await prisma.nativeCalendar.findUnique({ where: { id: series.calendarId } });
  if (!calendar || calendar.isDeleted) return { status: 'not_found' };
  const [access, ctx] = await Promise.all([
    getCalendarAccess(user, calendar),
    loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }),
  ]);
  const isReminder = series.kind === 'REMINDER';
  const masked =
    access === 'none' &&
    isReminder &&
    series.forUserId === user.id &&
    ctx.partner?.id === series.creatorUserId &&
    effectiveOwnerForViewer(series, ctx) === user.id;
  if (access === 'none' && !masked) return { status: 'not_found' };
  // A repeating series is addressed by an occurrence, a one-off by itself.
  if (Boolean(series.rrule) !== Boolean(key.slot)) return { status: 'not_found' };

  const overrides = await prisma.nativeEventInstance.findMany({ where: { seriesEventId: series.id } });
  const slot = key.slot ?? series.startsAt;
  const override = key.slot ? overrides.find((o) => o.originalStartsAt.getTime() === slot.getTime()) : undefined;
  const length = Math.max(0, series.endsAt.getTime() - series.startsAt.getTime());
  const moved = [slot, override?.startsAt, override?.endsAt].filter((d): d is Date => d instanceof Date);
  const from = new Date(Math.min(...moved.map((d) => d.getTime())) - 2 * DAY_MS);
  const to = new Date(Math.max(...moved.map((d) => d.getTime())) + 2 * DAY_MS + length);
  const occurrence = expandSeries(series, { from, to }, overrides).find((i) => i.instanceStartsAt.getTime() === slot.getTime());
  if (!occurrence) return { status: 'changed' };

  const canEdit = canWriteAccess(access) || (isReminder && series.creatorUserId === user.id);
  const canDelete = canWriteAccess(access) || (await mayDeleteReminder(series, user.id));
  return { status: 'ok', series, calendar, access, ctx, occurrence, override, masked, canEdit, canDelete };
}

/** A time in the wall form the editor speaks. All-day: the day in the item's own zone; timed: the user's clock. */
export function wallFor(startsAt: Date, endsAt: Date, allDay: boolean, userTz: string, itemTz: string): { start: string; end: string } {
  if (allDay) return { start: localDate(startsAt, itemTz), end: lastDayOf(startsAt, endsAt, itemTz) };
  return { start: instantToWall(startsAt, userTz), end: instantToWall(endsAt, userTz) };
}

/** The item's zone: the one its all-day dates and its repeats are read in. */
export const itemZone = (series: Pick<NativeEvent, 'timeZone'>): string => series.timeZone || TIMEZONE;

const FREQS: Record<number, RepeatInfo['freq']> = {
  [RRule.DAILY]: 'daily',
  [RRule.WEEKLY]: 'weekly',
  [RRule.MONTHLY]: 'monthly',
  [RRule.YEARLY]: 'yearly',
};
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** How a stored rule repeats, or null for none (or a frequency the app has no words for). */
export function repeatInfo(rrule: string | null): RepeatInfo | null {
  if (!rrule) return null;
  try {
    const opts = RRule.parseString(rrule.startsWith('RRULE:') ? rrule.slice(6) : rrule);
    const freq = opts.freq === undefined ? undefined : FREQS[opts.freq];
    if (!freq) return null;
    const byDay = ([] as unknown[]).concat(opts.byweekday ?? []).flatMap((d) => {
      const n = typeof d === 'number' ? d : (d as { weekday?: number }).weekday;
      return typeof n === 'number' && WEEKDAYS[n] ? [WEEKDAYS[n]] : [];
    });
    return { freq, interval: opts.interval ?? 1, byDay, ends: opts.until != null || opts.count != null };
  } catch {
    return null;
  }
}

/** GET /api/calendar/item: the edit info of a loaded item. */
export function itemEditInfo(item: Extract<LoadedItem, { status: 'ok' }>, userTz: string): ItemEditInfoResponse {
  const { series, calendar, ctx, occurrence, masked } = item;
  const itemTz = itemZone(series);
  const isReminder = series.kind === 'REMINDER';
  const at = wallFor(occurrence.startsAt, occurrence.endsAt, occurrence.allDay, userTz, itemTz);
  const first = wallFor(series.startsAt, series.endsAt, series.allDay, userTz, itemTz);
  const ownerIsPartner = isReminder && ctx.partner !== null && effectiveOwnerForViewer(series, ctx) === ctx.partner.id;
  return {
    kind: isReminder ? 'reminder' : 'event',
    canEdit: item.canEdit,
    canDelete: item.canDelete,
    occurrence: {
      start: at.start,
      // A reminder has one time.
      end: isReminder ? at.start : at.end,
      allDay: occurrence.allDay,
      title: occurrence.title,
      location: occurrence.location ?? '',
      description: occurrence.description ?? '',
    },
    series: { recurring: Boolean(series.rrule), start: first.start, repeat: repeatInfo(series.rrule), fixedDays: fixesDays(series.rrule), zone: itemTz },
    tz: userTz,
    calendar: masked
      ? { id: null, name: ctx.partner?.name ?? '', color: null }
      : { id: encodeCalendarId(calendar.id), name: calendar.name, color: calendar.color },
    forName: ownerIsPartner && ctx.partner ? ctx.partner.name : null,
    scopes: series.rrule ? ['single', 'following', 'all'] : ['single'],
  };
}
