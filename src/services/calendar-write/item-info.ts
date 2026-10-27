// The read side of the calendar home's editing (home editing spec §3): what the "+" needs
// (editorInfo), and one FamCal item read live from the store with what the home's DTO
// lacks, the series and the permissions (loadItem, itemEditInfo). The write routes load
// the item the same way, so what the editor showed and what a write acts on agree.

import type { NativeCalendar, NativeEvent, NativeEventInstance } from '@prisma/client';
import { RRule } from 'rrule';
import type {
  EditorCalendar,
  EditorInfoResponse,
  ForWho,
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
import { classifyRule, endOfRule, fixesDays, isHebrewRule, specOfRule, type HebrewColumns, type VirtualInstance } from '../native-calendar/recurrence';
import { loadViewerContext, recipientIdsForViewer, type ViewerContext } from '../native-reminders/ownership';
import { getReminderSupport } from '../native-reminders/support';
import { reminderTimeOf } from '../../lib/reminder-time';
import { alertChoiceOf, defaultLeadOf } from '../../lib/calendar-view/alert-leads';
import { getGlobalRemindersEnabled } from '../reminder-cache';
import { peekFeatureAccess } from '../subscription-service';
import type { AnyItemKey, ItemKey } from './validate';
import { sourcesFor } from '../calendar-read/index';
import { defaultCalendarIdFor } from '../calendar-provider/user-calendars';
import { ensurePrimaryNativeCalendar } from '../native-calendar/onboarding';
import { displayColourFor, displayColourMap } from '../native-calendar/colour';
import { instantToWall, lastDayOf, localDate } from './walltime';
import { famcalCrossRefusal, type CrossRefusal } from '../calendar-move/mapper';


/** The viewer's writable calendars, each with its row: own, and the partner's SHARED_EDITOR, the viewer's first. */
export async function writableCalendarRows(user: UserConfig): Promise<Array<{ calendar: NativeCalendar; entry: EditorCalendar }>> {
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

/** writableCalendars, with the FamCal main made first (lazily) when the user owns none. */
async function ownedWritableCalendars(user: UserConfig): Promise<EditorCalendar[]> {
  const calendars = await writableCalendars(user);
  if (calendars.some((c) => c.mine)) return calendars;
  await ensurePrimaryNativeCalendar(user.id);
  return writableCalendars(user);
}

/**
 * Whether an alert can reach the user (editor upgrades spec §2): the admin switch, their own
 * alerts setting (Settings), a plan with reminders, and a Telegram chat. The same four
 * conditions the pass applies, each read through its own function. A hint for the Alert row,
 * not a gate (a stored alert waits until alerts are on), so a plan without reminders logs
 * nothing; an error in the plan check fails closed.
 */
export async function alertsOnFor(user: Pick<UserConfig, 'id' | 'telegramId' | 'remindersEnabled'>): Promise<boolean> {
  if (user.telegramId === null || !user.remindersEnabled) return false;
  if (!(await getGlobalRemindersEnabled())) return false;
  try {
    return (await peekFeatureAccess(user.id, 'reminders')).allowed;
  } catch (error) {
    console.error(`[Editor] Feature check for alerts failed for user ${user.id}:`, error);
    captureError(error, 'editor-alerts-on', { user_id: user.id }, 'warning');
    return false;
  }
}

/**
 * GET /api/calendar/editor: what the user can add, to which calendars, and for whom. Per
 * calendar (3b spec §3.3, and "Google as a connection" §4): the union of a FamCal part
 * (its calendars, reminders and the partner, by FamCal's rules) when the user reads FamCal,
 * and a Google part (the chosen calendars they can write, read live) when they read
 * Google. A Google list that can't be read drops only the Google rows, and is logged.
 * main is the default (defaultCalendarFor, §3) for both kinds; a user with no FamCal
 * calendar of their own gets the main one made here, lazily.
 */
export async function editorInfo(user: UserConfig, tz: string): Promise<EditorInfoResponse> {
  const sources = sourcesFor(user);
  const famcal = sources.includes('famcal');
  const google = sources.includes('google');
  const [famcalCalendars, googleCalendars, reminders, ctx] = await Promise.all([
    famcal ? ownedWritableCalendars(user) : Promise.resolve([]),
    google ? import('./google-item').then(async (m) => (await m.googleEditorCalendars(user)).calendars) : Promise.resolve([]),
    // quiet: a hint, not a gate, so a plan without reminders logs nothing
    getReminderSupport(user, { quiet: true }),
    famcal ? loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }) : Promise.resolve(null),
  ]);
  // After the FamCal part, which may have made the main. The default when it is listed;
  // else (the FamCal main by the rule, or a Google default whose list failed or that
  // can't be written) the FamCal main, which writableCalendars marks.
  const defaultId = await defaultCalendarIdFor(user);
  const listed = [...famcalCalendars, ...googleCalendars];
  const mainId = listed.some((c) => c.id === defaultId) ? defaultId : famcalCalendars.find((c) => c.main)?.id;
  // The colours as drawn: a FamCal calendar too close to another is shifted on screen only.
  const drawn = await displayColourMap(user);
  const calendars = listed.map((c) => ({ ...displayColourFor(c, drawn), main: c.id === mainId }));
  const partner = ctx?.partner ? { name: ctx.partner.name, canRemind: partnerCanRemind(ctx) } : null;
  return {
    kinds: { event: calendars.length > 0, reminder: reminders.supported },
    calendars,
    partner,
    tz,
    reminderTime: reminderTimeOf(user),
    alertsOn: await alertsOnFor(user),
    defaultLead: defaultLeadOf(user),
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
      /** Every override row of the series (OVERRIDE and CANCELLED). */
      overrides: NativeEventInstance[];
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
    recipientIdsForViewer(series, ctx).includes(user.id);
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
  return { status: 'ok', series, calendar, access, ctx, occurrence, override, overrides, masked, canEdit, canDelete };
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

/**
 * How a stored rule repeats, or null for none (or a frequency the app has no words for). A
 * Hebrew series' (with its pair) names its anchor (hebrew-repeats spec §3).
 */
export function repeatInfo(rrule: string | null, hebrew?: HebrewColumns | null, at?: { startsAt: Date; zone: string }): RepeatInfo | null {
  if (!rrule) return null;
  try {
    const opts = RRule.parseString(rrule.startsWith('RRULE:') ? rrule.slice(6) : rrule);
    const freq = opts.freq === undefined ? undefined : FREQS[opts.freq];
    if (!freq) return null;
    const days = ([] as unknown[]).concat(opts.byweekday ?? []).flatMap((d) => {
      const n = typeof d === 'number' ? d : (d as { weekday?: number }).weekday;
      const ordinal = typeof d === 'number' ? undefined : (d as { n?: number }).n;
      return typeof n === 'number' && WEEKDAYS[n] ? [{ code: WEEKDAYS[n], ordinal: ordinal ?? null }] : [];
    });
    const byDay = days.map((d) => d.code);
    const numbers = (v: unknown) => ([] as unknown[]).concat(v ?? []).filter((n): n is number => typeof n === 'number');
    const monthDays = numbers(opts.bymonthday);
    const months = numbers(opts.bymonth);
    const end = endOfRule(rrule, at?.startsAt, at?.zone, hebrew);
    const info: RepeatInfo = {
      freq,
      interval: opts.interval ?? 1,
      byDay,
      ends: opts.until != null || opts.count != null,
      // The rest of the rule, so a bot rule the sheet can't say still opens with its real words.
      ...(days.some((d) => d.ordinal !== null) ? { byDayOrdinals: days.map((d) => d.ordinal) } : {}),
      ...(monthDays.length > 0 ? { byMonthDay: monthDays } : {}),
      ...(months.length > 0 ? { byMonth: months } : {}),
      ...(end.until ? { until: end.until } : {}),
      ...(end.count !== undefined ? { count: end.count } : {}),
    };
    if (hebrew?.hebrewRule) {
      if (!isHebrewRule(hebrew.hebrewRule) || !hebrew.hebrewAnchor) return null;
      info.hebrew = { anchor: hebrew.hebrewAnchor };
    }
    return info;
  } catch (error) {
    captureError(error, 'native-rule-repeat-info', {}, 'warning');
    return null;
  }
}

/**
 * Who a reminder is for, relative to its creator, as the viewer can tell: the creator's
 * ACTIVE partner is the viewer's when the viewer created it, and the viewer when the partner
 * did. The stored value, even for a partner who can't be pinged now, so the creator can take
 * it back: 'partner', or 'both' when it is also for the creator.
 */
export function forWhoOf(series: Pick<NativeEvent, 'kind' | 'creatorUserId' | 'forUserId' | 'forBoth'>, ctx: ViewerContext): ForWho {
  if (series.kind !== 'REMINDER' || series.forUserId === null || !ctx.partner) return 'me';
  const forPartner = series.creatorUserId === ctx.viewerId
    ? series.forUserId === ctx.partner.id
    : series.creatorUserId === ctx.partner.id && series.forUserId === ctx.viewerId;
  if (!forPartner) return 'me';
  return series.forBoth ? 'both' : 'partner';
}

/** Whether the viewer's partner can be pinged, so a reminder can be for them (resolve.ts targetFor). */
export const partnerCanRemind = (ctx: ViewerContext): boolean =>
  ctx.partner !== null && ctx.partner.telegramId !== null;

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

/**
 * The Google calendars a FamCal event may move to ("Google as a connection" §5): the user's
 * writable chosen ones, for the user's own event on their own calendar; or, when it can't
 * cross (a Hebrew rule, a repeat Google wouldn't yield the same way), none and why. A
 * partner's event lists none: it never leaves the partner's view.
 */
async function googleTargetsOf(user: UserConfig, item: Extract<LoadedItem, { status: 'ok' }>): Promise<{ ids: string[]; reason?: CrossRefusal }> {
  if (item.series.kind === 'REMINDER' || !canWriteAccess(item.access) || item.calendar.ownerUserId !== user.id) return { ids: [] };
  if (!sourcesFor(user).includes('google')) return { ids: [] };
  // A list that can't be read is logged by googleEditorCalendars, and leaves the row its own kind.
  const { calendars } = await (await import('./google-item')).googleEditorCalendars(user);
  if (calendars.length === 0) return { ids: [] };
  const reason = famcalCrossRefusal(item.series, item.overrides);
  return reason ? { ids: [], reason } : { ids: calendars.map((c) => c.id) };
}

/** GET /api/calendar/item: the edit info of a loaded item. */
export async function itemEditInfo(item: Extract<LoadedItem, { status: 'ok' }>, userTz: string, user: UserConfig): Promise<ItemEditInfoResponse> {
  const { series, calendar, ctx, occurrence, masked } = item;
  const itemTz = itemZone(series);
  const isReminder = series.kind === 'REMINDER';
  const at = wallFor(occurrence.startsAt, occurrence.endsAt, occurrence.allDay, userTz, itemTz);
  const first = wallFor(series.startsAt, series.endsAt, series.allDay, userTz, itemTz);
  const recipients = recipientIdsForViewer(series, ctx);
  const ownerIsPartner = isReminder && ctx.partner !== null && recipients.length === 1 && recipients[0] === ctx.partner.id;
  const classified = classifyRule(series.rrule, series.startsAt, itemTz, series);
  // The stored rule as the Repeat sheet says it, when it can (richer repeats spec §3).
  const spec = specOfRule(series.rrule, series.startsAt, itemTz, series);
  const rule = {
    choice: classified.choice,
    ...(classified.until ? { until: wallFor(classified.until, classified.until, series.allDay, userTz, itemTz).start.slice(0, 10) } : {}),
    // The words of a Hebrew series name its anchor, never the opened occurrence's day (a rolled year's).
    ...(series.rrule && series.hebrewRule && series.hebrewAnchor ? { anchor: series.hebrewAnchor } : {}),
  };
  const ownKind = await moveTargetsOf(user, item);
  const cross = ownKind.length > 0 ? await googleTargetsOf(user, item) : { ids: [] };
  const moveTargets = [...ownKind, ...cross.ids];
  const forWho = forWhoOf(series, ctx);
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
      repeat: repeatInfo(series.rrule, series, { startsAt: series.startsAt, zone: itemTz }),
      fixedDays: fixesDays(series.rrule),
      zone: itemTz,
      rule,
      ...(spec ? { spec } : {}),
      first: !series.rrule || (await isFirstOccurrence(series, occurrence.instanceStartsAt)),
    },
    tz: userTz,
    calendar: masked
      ? { id: null, name: ctx.partner?.name ?? '', color: null }
      : { id: encodeCalendarId(calendar.id), name: calendar.name, color: calendar.color },
    forName: ownerIsPartner && ctx.partner ? ctx.partner.name : null,
    // An event's alert (a reminder has none); a stored lead off the list reads as it is.
    ...(isReminder ? {} : { alert: alertChoiceOf(series) }),
    scopes: series.rrule ? ['single', 'following', 'all'] : ['single'],
    canMoveCalendar: moveTargets.length > 1,
    moveTargets,
    // The creator, while the partner can be pinged or it is theirs now (so it can come back).
    canChangeRecipient: creator && (partnerCanRemind(ctx) || forWho !== 'me'),
    forWho,
    // Each marks their own Done, for a reminder for both of us (the stored switch is off whenever it is not for both).
    ...(isReminder ? { eachMarksDone: series.eachMarksDone && forWho === 'both' } : {}),
    source: 'famcal',
    ...(cross.reason ? { moveReason: cross.reason } : {}),
  };
}
