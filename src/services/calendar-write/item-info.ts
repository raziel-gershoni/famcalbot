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
import { captureError } from '../../lib/error-capture';
import {
  canWriteAccess,
  encodeCalendarId,
  getCalendarAccess,
  isFirstOccurrence,
  listVisibleCalendars,
  mayDeleteReminder,
  occurrenceAt,
  type NativeAccess,
} from '../native-calendar/event-store';
import { classifyRule, fixesDays, type VirtualInstance } from '../native-calendar/recurrence';
import { effectiveOwnerForViewer, loadViewerContext, type ViewerContext } from '../native-reminders/ownership';
import { getReminderSupport } from '../native-reminders/support';
import type { AnyItemKey, ItemKey } from './validate';
import { sourcesFor } from '../calendar-read/index';
import { instantToWall, lastDayOf, localDate } from './walltime';


/** The viewer's writable calendars, each with its row: own, and the partner's SHARED_EDITOR, the viewer's first. */
async function writableCalendarRows(user: UserConfig): Promise<Array<{ calendar: NativeCalendar; entry: EditorCalendar }>> {
  const [visible, ctx] = await Promise.all([
    listVisibleCalendars(user.id, user.pairingId ?? null),
    loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }),
  ]);
  const own = visible.filter((c) => c.ownerUserId === user.id);
  // The main one, as getMainNativeCalendar picks it, without its write when there is none.
  const main = own.find((c) => c.labels.includes('primary')) ?? own[0];
  const out: Array<{ calendar: NativeCalendar; entry: EditorCalendar }> = [];
  for (const c of visible) {
    const access = await getCalendarAccess(user, c);
    if (!canWriteAccess(access)) continue;
    const mine = c.ownerUserId === user.id;
    out.push({
      calendar: c,
      entry: {
        id: encodeCalendarId(c.id),
        name: c.name,
        color: c.color,
        main: main?.id === c.id,
        mine,
        ...(!mine && ctx.partner ? { ownerName: ctx.partner.name } : {}),
      },
    });
  }
  return out.sort((a, b) => Number(b.entry.mine) - Number(a.entry.mine));
}

/** The viewer's calendars they may add events to (own, and the partner's SHARED_EDITOR), the viewer's first. */
export async function writableCalendars(user: UserConfig): Promise<EditorCalendar[]> {
  return (await writableCalendarRows(user)).map((r) => r.entry);
}

/**
 * GET /api/calendar/editor: what the user can add, to which calendars, and for whom. Per
 * calendar (3b spec §3.3, and "Google as a connection" §4): the union of a FamCal part
 * (its calendars, reminders and the partner, by FamCal's rules) when the user reads FamCal,
 * and a Google part (the chosen calendars they can write, read live) when they read
 * Google. A Google list that can't be read drops only the Google rows, and is logged.
 */
export async function editorInfo(user: UserConfig, tz: string): Promise<EditorInfoResponse> {
  const sources = sourcesFor(user);
  const famcal = sources.includes('famcal');
  const google = sources.includes('google');
  const [famcalCalendars, googleCalendars, reminders, ctx] = await Promise.all([
    famcal ? writableCalendars(user) : Promise.resolve([]),
    google ? import('./google-item').then(async (m) => (await m.googleEditorCalendars(user)).calendars) : Promise.resolve([]),
    // quiet: a hint, not a gate, so a plan without reminders logs nothing
    getReminderSupport(user, { quiet: true }),
    famcal ? loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }) : Promise.resolve(null),
  ]);
  const calendars = [...famcalCalendars, ...googleCalendars];
  const partner = ctx?.partner ? { name: ctx.partner.name, canRemind: partnerCanRemind(ctx) } : null;
  return {
    kinds: { event: calendars.length > 0, reminder: reminders.supported },
    calendars,
    partner,
    tz,
  };
}

/**
 * GET /api/calendar/item: an item's edit info, by its key's source (FamCal read from the
 * store, Google read live), or not_found.
 */
export async function itemInfoFor(user: UserConfig, key: AnyItemKey, userTz: string): Promise<ItemEditInfoResponse | 'not_found'> {
  if (key.source === 'google') {
    const { googleEditInfo } = await import('./google-item');
    return googleEditInfo(user, key, userTz);
  }
  const item = await loadItem(user, key);
  if (item.status !== 'ok') return 'not_found';
  return itemEditInfo(item, userTz, user);
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
  if (!sourcesFor(user).includes('famcal')) return { status: 'not_found' };
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
  let occurrence: VirtualInstance | undefined;
  try {
    occurrence = occurrenceAt(series, overrides, slot);
  } catch (error) {
    // A stored rule that can't be read: logged by id, and there's nothing to show or change.
    captureError(error, 'calendar-item-series', { series_id: series.id, user_id: user.id });
    return { status: 'not_found' };
  }
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
  } catch (error) {
    captureError(error, 'native-rule-repeat-info', {}, 'warning');
    return null;
  }
}

/**
 * Whether a reminder is for its creator's partner, relative to its creator, as the viewer
 * can tell: the creator's ACTIVE partner is the viewer's when the viewer created it, and
 * the viewer when the partner did. The stored value, even for a partner who can't be
 * pinged now, so the creator can take it back.
 */
export function isForPartner(series: Pick<NativeEvent, 'kind' | 'creatorUserId' | 'forUserId'>, ctx: ViewerContext): boolean {
  if (series.kind !== 'REMINDER' || series.forUserId === null || !ctx.partner) return false;
  if (series.creatorUserId === ctx.viewerId) return series.forUserId === ctx.partner.id;
  return series.creatorUserId === ctx.partner.id && series.forUserId === ctx.viewerId;
}

/** Whether the viewer's partner can be pinged, so a reminder can be for them (resolve.ts targetFor). */
export const partnerCanRemind = (ctx: ViewerContext): boolean =>
  ctx.partner !== null && ctx.partner.calendarSource === 'NATIVE' && ctx.partner.telegramId !== null;

/**
 * Where an event may move (3b spec §2.2): the calendars the user can write, its own among
 * them, without the user's own private ones when it is on the partner's calendar (it would
 * leave their view). None for a reminder, or an event the user can't change.
 */
async function moveTargetsOf(user: UserConfig, item: Extract<LoadedItem, { status: 'ok' }>): Promise<string[]> {
  if (item.series.kind === 'REMINDER' || !canWriteAccess(item.access)) return [];
  const partnersEvent = item.calendar.ownerUserId !== user.id;
  return (await writableCalendarRows(user))
    .filter(({ calendar }) => calendar.id === item.calendar.id || !(partnersEvent && calendar.ownerUserId === user.id && calendar.privacy === 'PRIVATE'))
    .map(({ entry }) => entry.id);
}

/** GET /api/calendar/item: the edit info of a loaded item. */
export async function itemEditInfo(item: Extract<LoadedItem, { status: 'ok' }>, userTz: string, user: UserConfig): Promise<ItemEditInfoResponse> {
  const { series, calendar, ctx, occurrence, masked } = item;
  const itemTz = itemZone(series);
  const isReminder = series.kind === 'REMINDER';
  const at = wallFor(occurrence.startsAt, occurrence.endsAt, occurrence.allDay, userTz, itemTz);
  const first = wallFor(series.startsAt, series.endsAt, series.allDay, userTz, itemTz);
  const ownerIsPartner = isReminder && ctx.partner !== null && effectiveOwnerForViewer(series, ctx) === ctx.partner.id;
  const classified = classifyRule(series.rrule, series.startsAt, itemTz);
  const rule = {
    choice: classified.choice,
    ...(classified.until ? { until: wallFor(classified.until, classified.until, series.allDay, userTz, itemTz).start.slice(0, 10) } : {}),
  };
  const moveTargets = await moveTargetsOf(user, item);
  const forPartner = isForPartner(series, ctx);
  const creator = isReminder && series.creatorUserId === user.id;
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
    series: {
      recurring: Boolean(series.rrule),
      start: first.start,
      repeat: repeatInfo(series.rrule),
      fixedDays: fixesDays(series.rrule),
      zone: itemTz,
      rule,
      first: !series.rrule || (await isFirstOccurrence(series, occurrence.instanceStartsAt)),
    },
    tz: userTz,
    calendar: masked
      ? { id: null, name: ctx.partner?.name ?? '', color: null }
      : { id: encodeCalendarId(calendar.id), name: calendar.name, color: calendar.color },
    forName: ownerIsPartner && ctx.partner ? ctx.partner.name : null,
    scopes: series.rrule ? ['single', 'following', 'all'] : ['single'],
    canMoveCalendar: moveTargets.length > 1,
    moveTargets,
    // The creator, while the partner can be pinged or it is theirs now (so it can come back).
    canChangeRecipient: creator && (partnerCanRemind(ctx) || forPartner),
    forPartner,
    source: 'famcal',
  };
}
