// The calendar home's editor, as pure logic (home editing spec §2, §4): the form's state,
// its defaults for a new item and for an edit, what moving the start does to the end,
// the checks that give the inline errors, and the request bodies. Client-safe and pure:
// it imports only the shared editing types. Nothing here touches window.
//
// Times are wall times on the user's clock (EditorInfoResponse.tz), never instants:
// 'YYYY-MM-DDTHH:mm' for a timed item and 'YYYY-MM-DD' for an all-day one, whose end is
// its last day. The form keeps a day and a time apart, so the all-day switch can hide the
// times without losing them. The arithmetic runs on the wall clock as if it were UTC,
// which a calendar day and a clock time can be added to without a zone getting in.

import {
  LOCATION_MAX,
  NOTES_MAX,
  TITLE_MAX,
  type CreateItemBody,
  type EditScope,
  type EditorCalendar,
  type ForWho,
  type ItemEditInfoResponse,
  type ItemKind,
  type RepeatInfo,
  type RepeatInput,
  type RuleChoice,
  type RepeatSpec,
  type UpdateItemBody,
} from './editor-types';
import {
  endsBeforeStart,
  formRepeat,
  isHebrewForm,
  isSpec,
  repeatInput,
  sameRepeat,
  shownSpec,
  toGregorian,
  type RepeatForm,
} from './repeat-model';
import { type AlertChoice } from './alert-leads';
import { HOURS_PICK, ZMAN_HOURS_MAX, ZMAN_HOURS_MIN, readZmanSpec, sameZmanSpec, type TimeMode, type ZmanSpecValue, type ZmanimInfo } from './zman-spec';
import { MAX_YEAR, MIN_YEAR_BIRTH, MIN_YEAR_SERIES, minYearFor } from './year-limits';

/** What a new event lasts, and the time a new one on another day starts at. */
export const DEFAULT_EVENT_MINUTES = 60;
export const DEFAULT_EVENT_TIME = '09:00';
/** The years the server accepts (year-limits.ts: the floor depends on the repeat). */
/** The longest an item may last (the server's limit). */
const MAX_SPAN_DAYS = 366;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

/** Everything the form holds. */
export interface EditorForm {
  kind: ItemKind;
  title: string;
  location: string;
  notes: string;
  allDay: boolean;
  /** yyyy-MM-dd, or '' while the date input is cleared. */
  startDay: string;
  /** HH:mm, or '' while cleared. Kept while the item is all-day. */
  startTime: string;
  endDay: string;
  endTime: string;
  /**
   * A new item's repeat; on an edit, the stored rule as the Repeat sheet says it (repeat-model.ts:
   * a weekly spec lists the days beside the start's). 'custom' is the rule the sheet can't say,
   * kept as it is until another choice is picked (3b spec §2.1).
   */
  repeat: RepeatForm;
  /** The event's calendar: a new one's, or the edited one's current calendar (a native id or a Google id). */
  calendarId: string | null;
  /** Who the reminder is for: me, the partner, or both (a new one's, or the edited one's current recipients). */
  forWho: ForWho;
  /**
   * A reminder for both of us: each marks their own Done (off: one Done covers both). Shown, and sent, only while
   * `forWho` is 'both'; a switch left on under another For is kept in the form but never sent.
   */
  eachMarksDone: boolean;
  /**
   * An event's alert (editor upgrades spec §2): the default, none, or a lead in minutes. A stored
   * lead off the list is kept as it is until another is picked. A Google item's is its own, read-only.
   */
  alert: AlertChoice;
  /**
   * A reminder's time: 'time' (a time of day, or the reminder time when all-day), or 'zman': date-only, due each day at a
   * zman plus an offset at the person's place. Only a reminder has it; the zman* fields mean something only in 'zman'.
   */
  timeMode: TimeMode;
  /** The zman picked: a ZmanKey, or HOURS_PICK for "N halachic hours after sunrise". '' = none yet (the default is chosen when the mode is turned on). */
  zmanPick: string;
  /** The N of HOURS_PICK, ZMAN_HOURS_MIN..ZMAN_HOURS_MAX. */
  zmanHours: number;
  /** The offset's size in clock minutes (0..ZMAN_OFFSET_MAX_MIN) and whether it is before the zman (after otherwise). */
  zmanMinutes: number;
  zmanBefore: boolean;
}

export type FieldName = 'title' | 'location' | 'notes' | 'start' | 'end' | 'alert' | 'repeat';

/** The copy key (calendarHome.editor.<key>) of each inline error, by field. */
export type FieldErrors = Partial<Record<FieldName, 'errTitle' | 'errTitleLong' | 'errTooLong' | 'errDate' | 'errYear' | 'errSeriesYear' | 'errEnd' | 'errField' | 'errRepeat' | 'errRepeatEnd'>>;

// ---- Wall-time arithmetic ----

/** The UTC milliseconds of a real yyyy-MM-dd and HH:mm (the wall clock read as UTC), else null. */
function wallMs(day: string, time: string): number | null {
  const d = DAY.exec(day);
  const t = TIME.exec(time);
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, da, h, mi);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === da ? ms : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function timeOf(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Whether `day` names a real date in the years the server accepts. `minYear` is the earliest
 * year (year-limits.ts minYearFor): 2000 unless the item is a one-off or a yearly one.
 */
export function isRealDay(day: string, minYear: number = MIN_YEAR_SERIES): boolean {
  const ms = wallMs(day, '00:00');
  if (ms === null) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= minYear && year <= MAX_YEAR;
}

/** The earliest year the form's item may start in, by its repeat. */
const floorOf = (form: EditorForm): number => minYearFor(form.repeat);

const isRealTime = (time: string) => wallMs('2000-01-01', time) !== null;

/** wallMs of a day the server accepts (isRealDay) from `minYear` on, else null: a year being typed (0002, 0202) is not one. */
const realWallMs = (day: string, time: string, minYear: number) => (isRealDay(day, minYear) ? wallMs(day, time) : null);

/** `day` moved by `n` days; `day` itself when it isn't a real date. */
export function addDays(day: string, n: number): string {
  const ms = wallMs(day, '00:00');
  return ms === null ? day : dayOf(ms + n * DAY_MS);
}

/** Whole days from `a` to `b`, or null when either isn't a real date. */
export function daysApart(a: string, b: string): number | null {
  const x = wallMs(a, '00:00');
  const y = wallMs(b, '00:00');
  return x === null || y === null ? null : Math.round((y - x) / DAY_MS);
}

/** 0 (Sunday) to 6 of a real day, else null. */
export function weekdayIndex(day: string): number | null {
  const ms = wallMs(day, '00:00');
  return ms === null ? null : new Date(ms).getUTCDay();
}

export const WEEKDAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayId = (typeof WEEKDAY_IDS)[number];

/** The weekday id the copy's select takes, of a real day. */
export function weekdayId(day: string): WeekdayId | null {
  const i = weekdayIndex(day);
  return i === null ? null : WEEKDAY_IDS[i];
}

/** The day of the month of a real day, else null. */
export function dayOfMonth(day: string): number | null {
  const ms = wallMs(day, '00:00');
  return ms === null ? null : new Date(ms).getUTCDate();
}

/** The wall clock of `nowMs` in `tz`, as 'YYYY-MM-DD' and 'HH:mm'. A zone Intl rejects reads as UTC. */
export function clockIn(nowMs: number, tz: string): { day: string; time: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(new Date(nowMs));
  } catch {
    return { day: dayOf(nowMs), time: timeOf(nowMs) };
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/**
 * The instant (ms) whose clock in `zone` reads this wall time, or null when it is no real time. A time the
 * zone skips (spring forward) reads an hour later; one it repeats (fall back) is the first of the two.
 */
export function instantOfWall(day: string, time: string, zone: string): number | null {
  const wall = Date.parse(`${day}T${time}:00Z`);
  if (Number.isNaN(wall)) return null;
  // The zone's offset at a guess, then at the instant that guess gives.
  const offsetAt = (ms: number) => {
    const c = clockIn(ms, zone);
    return Date.parse(`${c.day}T${c.time}:00Z`) - ms;
  };
  const guess = wall - offsetAt(wall);
  return wall - offsetAt(guess);
}

/**
 * A wall time on `from`'s clock as the wall time on `to`'s clock (the same instant). A time that
 * is no real time keeps its day and time.
 */
export function wallInZone(day: string, time: string, from: string, to: string): { day: string; time: string } {
  if (from === to) return { day, time };
  const instant = instantOfWall(day, time, from);
  return instant === null ? { day, time } : clockIn(instant, to);
}

/** The day, in `to`, of a wall time on `from`'s clock. A time that is no real time keeps its day. */
export function dayInZone(day: string, time: string, from: string, to: string): string {
  return wallInZone(day, time, from, to).day;
}

/**
 * Whether the form's start is on another day than the item's was, as the store reads it:
 * in the series' own zone (`zone`), not on the user's clock (`tz`). An all-day start is
 * already a day of the item's zone.
 */
export function movesDay(form: EditorForm, initial: EditorForm, tz: string, zone: string): boolean {
  const dayOf = (f: EditorForm) => (f.allDay ? f.startDay : dayInZone(f.startDay, f.startTime, tz, zone));
  return dayOf(form) !== dayOf(initial);
}

// ---- Defaults ----

/** What a new item starts from: the day in view (spec §2). */
export interface NewItemContext {
  /** The server's today, in the user's zone. */
  today: string;
  /** The Month's picked day, when the Month is in picked; else null. */
  pickedDay: string | null;
  /** The clock now (ms) and the user's zone. */
  nowMs: number;
  tz: string;
  kinds: { event: boolean; reminder: boolean };
  calendars: EditorCalendar[];
}

/**
 * The form for a new item. The day is the Month's picked day, else today. On today it
 * starts at the next round hour and lasts an hour; on another day it starts at 09:00 (a
 * picked day has no "now"). Events open first when both kinds apply.
 */
export function newItemForm(ctx: NewItemContext): EditorForm {
  const day = ctx.pickedDay ?? ctx.today;
  let startDay = day;
  let startTime = DEFAULT_EVENT_TIME;
  if (day === ctx.today) {
    const now = clockIn(ctx.nowMs, ctx.tz);
    const base = wallMs(now.day, '00:00');
    const mins = Number(now.time.slice(0, 2)) * 60 + 60;
    const next = base === null ? null : base + mins * MINUTE_MS;
    if (next !== null) {
      startDay = dayOf(next);
      startTime = timeOf(next);
    }
  }
  const end = shiftWall(startDay, startTime, DEFAULT_EVENT_MINUTES);
  const main = ctx.calendars.find((c) => c.main) ?? ctx.calendars[0] ?? null;
  return {
    kind: ctx.kinds.event ? 'event' : 'reminder',
    title: '',
    location: '',
    notes: '',
    allDay: false,
    startDay,
    startTime,
    endDay: end.day,
    endTime: end.time,
    repeat: 'none',
    calendarId: main ? main.id : null,
    forWho: 'me',
    eachMarksDone: false,
    alert: 'default',
    ...ZMAN_DEFAULTS,
  };
}

/** A reminder's time by zman before anything is picked: the latest time for Shema, no offset. */
const ZMAN_DEFAULTS = { timeMode: 'time' as TimeMode, zmanPick: '', zmanHours: 3, zmanMinutes: 0, zmanBefore: true };

/** A day and time moved by `minutes`. */
export function shiftWall(day: string, time: string, minutes: number): { day: string; time: string } {
  const ms = wallMs(day, time);
  if (ms === null) return { day, time };
  const next = ms + minutes * MINUTE_MS;
  return { day: dayOf(next), time: timeOf(next) };
}

const splitWall = (wall: string): { day: string; time: string } => ({ day: wall.slice(0, 10), time: wall.length > 10 ? wall.slice(11, 16) : '' });

/** The form of an item being edited, from its edit info. */
export function editItemForm(info: ItemEditInfoResponse): EditorForm {
  const { occurrence } = info;
  const start = splitWall(occurrence.start);
  const end = splitWall(occurrence.end);
  const allDay = occurrence.allDay;
  return {
    kind: info.kind,
    title: occurrence.title,
    location: occurrence.location,
    notes: occurrence.description,
    allDay,
    startDay: start.day,
    // An all-day item turned timed starts at 09:00 for an hour, as a new event does.
    startTime: allDay ? DEFAULT_EVENT_TIME : start.time,
    endDay: end.day,
    endTime: allDay ? shiftWall(start.day, DEFAULT_EVENT_TIME, DEFAULT_EVENT_MINUTES).time : end.time,
    repeat: storedRepeat(info, repeatDayOf({ startDay: start.day, startTime: allDay ? '00:00' : start.time, allDay }, info)),
    calendarId: info.calendar.id,
    forWho: info.forWho ?? 'me',
    eachMarksDone: info.eachMarksDone === true,
    alert: info.alert ?? 'default',
    ...zmanFields(info),
  };
}

/** The zman fields of an edit: the series' rule when it has one (even for an occurrence moved to a time of its own), else the defaults. */
function zmanFields(info: ItemEditInfoResponse): Pick<EditorForm, 'timeMode' | 'zmanPick' | 'zmanHours' | 'zmanMinutes' | 'zmanBefore'> {
  const spec = readZmanSpec(info.zmanSpec);
  if (!spec) return { ...ZMAN_DEFAULTS };
  return {
    timeMode: info.timeMode === 'zman' ? 'zman' : 'time',
    zmanPick: 'zman' in spec ? spec.zman : HOURS_PICK,
    zmanHours: 'halachicHours' in spec ? Math.min(ZMAN_HOURS_MAX, Math.max(ZMAN_HOURS_MIN, spec.halachicHours)) : ZMAN_DEFAULTS.zmanHours,
    zmanMinutes: Math.abs(spec.offsetMin),
    zmanBefore: spec.offsetMin <= 0,
  };
}

// ---- A reminder by zman ----

/** Whether the form is a reminder by zman: it is date-only, whatever its all-day switch says. */
export const isByZman = (form: Pick<EditorForm, 'kind' | 'timeMode'>): boolean => form.kind === 'reminder' && form.timeMode === 'zman';

/** The all-day state the request carries: a reminder by zman is always date-only. */
export const effectiveAllDay = (form: Pick<EditorForm, 'kind' | 'timeMode' | 'allDay'>): boolean => isByZman(form) || form.allDay;

/** The rule the form holds, as a request carries it. */
export function zmanSpecOf(form: Pick<EditorForm, 'zmanPick' | 'zmanHours' | 'zmanMinutes' | 'zmanBefore'>): ZmanSpecValue {
  const offsetMin = form.zmanMinutes === 0 ? 0 : (form.zmanBefore ? -1 : 1) * form.zmanMinutes;
  return form.zmanPick === HOURS_PICK ? { halachicHours: form.zmanHours, offsetMin } : { zman: form.zmanPick, offsetMin };
}

/** The default pick when the mode is turned on: the latest time for Shema (GRA) where the set offers it, else its first zman. */
export function defaultZmanPick(zmanim: ZmanimInfo | undefined): string {
  return zmanim?.zmanim.find((z) => z.key === 'SOF_SHMA_GRA')?.key ?? zmanim?.zmanim[0]?.key ?? HOURS_PICK;
}

/** The By zman switch: turning it on picks the default zman until one is chosen; turning it off keeps the pick for turning it on again. */
export function setTimeMode(form: EditorForm, timeMode: TimeMode, zmanim: ZmanimInfo | undefined): EditorForm {
  if (timeMode === form.timeMode) return form;
  return { ...form, timeMode, ...(timeMode === 'zman' && form.zmanPick === '' ? { zmanPick: defaultZmanPick(zmanim) } : {}) };
}

/**
 * Today's time of the form's rule at the person's place, as an instant (epoch ms), or null where there is none (the
 * zman does not exist today, or the editor info has none). It only adds the offset to a time the server worked out.
 */
export function zmanPreviewMs(form: EditorForm, zmanim: ZmanimInfo | undefined): number | null {
  if (!zmanim) return null;
  const spec = zmanSpecOf(form);
  const base = 'zman' in spec ? zmanim.zmanim.find((z) => z.key === spec.zman)?.at : zmanim.hours[spec.halachicHours - 1];
  const ms = base ? Date.parse(base) : NaN;
  return Number.isNaN(ms) ? null : ms + spec.offsetMin * MINUTE_MS;
}

/** Whether the rule of the form differs from the one the edit started with (only meaningful while both are by zman). */
const zmanRuleChanged = (form: EditorForm, initial: EditorForm): boolean => !sameZmanSpec(zmanSpecOf(form), zmanSpecOf(initial));

/**
 * The change to a reminder's time mode the person made, as the request carries it, or null while it is as it was:
 * turning zman on (or changing its rule) sends the mode with the rule; turning it off sends 'time' alone.
 */
function timeModeChange(form: EditorForm, initial: EditorForm): Pick<UpdateItemBody['changes'], 'timeMode' | 'zmanSpec'> | null {
  if (form.kind !== 'reminder') return null;
  if (form.timeMode === 'zman' && (initial.timeMode !== 'zman' || zmanRuleChanged(form, initial))) return { timeMode: 'zman', zmanSpec: zmanSpecOf(form) };
  if (form.timeMode === 'time' && initial.timeMode === 'zman') return { timeMode: 'time' };
  return null;
}

/** The Repeat row's current choice: the stored rule's (3b spec §2.1), 'none' for a one-off, 'custom' for a rule the server did not classify. */
export function storedChoice(info: ItemEditInfoResponse): RuleChoice {
  if (info.series.rule) return info.series.rule.choice;
  return info.series.recurring ? 'custom' : 'none';
}

/**
 * The form's repeat for an item: the spec the server reported it as, or, from a server that
 * reports a choice alone, that choice as a spec (with the end it names). A rule the sheet
 * can't say is 'custom'.
 */
export function storedRepeat(info: ItemEditInfoResponse, startDay: string): RepeatForm {
  if (info.series.spec) return formRepeat(info.series.spec, startDay);
  const choice = storedChoice(info);
  if (choice === 'none' || choice === 'custom') return choice;
  const spec: RepeatSpec = { freq: choice, interval: 1 };
  const until = info.series.rule?.until;
  if (until) spec.until = until;
  else if (info.series.repeat?.count !== undefined) spec.count = info.series.repeat.count;
  return formRepeat(spec, startDay);
}

/**
 * The day the repeat is built and worded on: the form's start day on a new item, and on an edit
 * that day in the series' own zone (the server builds the rule on the part's start there, so a
 * start near midnight can be another weekday or day of the month than on the user's clock).
 */
export function repeatDayOf(form: Pick<EditorForm, 'startDay' | 'startTime' | 'allDay'>, info?: Pick<ItemEditInfoResponse, 'tz' | 'series'>): string {
  if (!info || form.allDay || !form.startDay) return form.startDay;
  return dayInZone(form.startDay, form.startTime || '00:00', info.tz, info.series.zone);
}

// ---- Edits ----

/** How long the form's item lasts: the days between start and end all day, the minutes timed. */
export interface FormSpan {
  allDay: boolean;
  size: number;
}

/** The form's span, or null while its start or end is not a real date and time (isRealDay). */
export function spanOf(form: EditorForm): FormSpan | null {
  const floor = floorOf(form);
  if (form.allDay) {
    const days = isRealDay(form.startDay, floor) && isRealDay(form.endDay, floor) ? daysApart(form.startDay, form.endDay) : null;
    return days === null ? null : { allDay: true, size: days };
  }
  const from = realWallMs(form.startDay, form.startTime, floor);
  const to = realWallMs(form.endDay, form.endTime, floor);
  return from === null || to === null ? null : { allDay: false, size: Math.round((to - from) / MINUTE_MS) };
}

/**
 * The form after the start moved (a new day or time): the end keeps its distance from the
 * start. All day, that is the days between them; timed, the minutes. While a date is being
 * typed its year passes through ones that aren't real (0002, 0020, 0202): the distance is
 * then the last real one, `held` (the editor keeps it), never one measured from those. A
 * start that is not a real date or time leaves the end where it is.
 */
export function moveStart(form: EditorForm, patch: { startDay?: string; startTime?: string }, held: FormSpan | null = null): EditorForm {
  return moveStartTimes(form, patch, held);
}

function moveStartTimes(form: EditorForm, patch: { startDay?: string; startTime?: string }, held: FormSpan | null): EditorForm {
  const next = { ...form, ...patch };
  const span = spanOf(form) ?? (held && held.allDay === form.allDay ? held : null);
  if (span === null) return next;
  if (form.allDay) {
    return isRealDay(next.startDay, floorOf(next)) ? { ...next, endDay: addDays(next.startDay, span.size) } : next;
  }
  if (realWallMs(next.startDay, next.startTime, floorOf(next)) === null) return next;
  const end = shiftWall(next.startDay, next.startTime, span.size);
  return { ...next, endDay: end.day, endTime: end.time };
}

/** The all-day switch. Turning it on leaves the days as they are; the end day never falls before the start. */
export function setAllDay(form: EditorForm, allDay: boolean): EditorForm {
  if (allDay === form.allDay) return form;
  if (allDay) {
    const span = daysApart(form.startDay, form.endDay);
    return { ...form, allDay, endDay: span !== null && span >= 0 ? form.endDay : form.startDay };
  }
  // Timed again: an end that does not follow the start gets an hour after it.
  const start = wallMs(form.startDay, form.startTime);
  const end = wallMs(form.endDay, form.endTime);
  if (start !== null && (end === null || end <= start)) {
    const after = shiftWall(form.startDay, form.startTime, DEFAULT_EVENT_MINUTES);
    return { ...form, allDay, endDay: after.day, endTime: after.time };
  }
  return { ...form, allDay };
}

/** Whether a calendar id is FamCal's own (a Hebrew-date repeat is only offered there; null is the default, FamCal's). */
export const isNativeCalendar = (calendarId: string | null): boolean => !calendarId || calendarId.startsWith('native:');

/**
 * The Event | Reminder switch. A reminder is always FamCal's, so it keeps any repeat; an event
 * is on its chosen calendar, and on a Google one a Hebrew-date repeat is not offered, so the
 * pick falls back to the Gregorian yearly one (as the Calendar row does), never sent with it.
 */
export function setKind(form: EditorForm, kind: EditorForm['kind']): EditorForm {
  if (kind === form.kind) return form;
  const repeat = kind === 'event' && isHebrewRepeat(form.repeat) && !isNativeCalendar(form.calendarId) ? toGregorian(form.repeat, form.startDay) : form.repeat;
  return { ...form, kind, repeat };
}

/** Whether the form differs from where it started (Cancel asks to discard only then); a repeat is compared on the series' zone day. */
export function isDirty(form: EditorForm, initial: EditorForm, info?: ItemEditInfoResponse): boolean {
  const keys = Object.keys(initial) as (keyof EditorForm)[];
  return keys.some((k) => {
    // A reminder has no end, and a switch-off time is not an edit.
    if (form.kind === 'reminder' && (k === 'endDay' || k === 'endTime')) return false;
    if (effectiveAllDay(form) && effectiveAllDay(initial) && (k === 'startTime' || k === 'endTime')) return false;
    // The zman fields mean something only while the reminder is by zman; a pick left behind in 'time' mode is no edit.
    if (k.startsWith('zman') && form.timeMode === 'time' && initial.timeMode === 'time') return false;
    if (k === 'repeat') return !sameRepeat(form.repeat, initial.repeat, repeatDayOf(form, info));
    return form[k] !== initial[k];
  });
}

// ---- Checks ----

const length = (text: string) => Array.from(text).length;

/** The inline errors; empty when the form can be sent. */
export function checkForm(form: EditorForm, info?: ItemEditInfoResponse): FieldErrors {
  const errors: FieldErrors = {};
  const title = form.title.trim();
  if (title === '') errors.title = 'errTitle';
  else if (length(title) > TITLE_MAX) errors.title = 'errTitleLong';
  if (length(form.location.trim()) > LOCATION_MAX) errors.location = 'errTooLong';
  if (length(form.notes.trim()) > NOTES_MAX) errors.notes = 'errTooLong';

  const reminder = form.kind === 'reminder';
  const timed = !form.allDay;
  const floor = floorOf(form);
  if (endsBeforeStart(form.repeat, repeatDayOf(form, info))) errors.repeat = 'errRepeatEnd';
  /** The year-floor error when the day is real from 1900 on but not from this repeat's floor, else the plain date error. */
  const dayError = (day: string): 'errYear' | 'errDate' => (isRealDay(day, MIN_YEAR_BIRTH) ? 'errYear' : 'errDate');
  if (!isRealDay(form.startDay, floor)) errors.start = dayError(form.startDay);
  else if (timed && !isRealTime(form.startTime)) errors.start = 'errDate';
  if (!reminder && !errors.start) {
    if (!isRealDay(form.endDay, floor)) errors.end = dayError(form.endDay);
    else if (timed && !isRealTime(form.endTime)) errors.end = 'errDate';
    else if (timed) {
      const start = wallMs(form.startDay, form.startTime);
      const end = wallMs(form.endDay, form.endTime);
      if (start !== null && end !== null && end <= start) errors.end = 'errEnd';
      else if (start !== null && end !== null && (end - start) / DAY_MS > MAX_SPAN_DAYS) errors.end = 'errField';
    } else {
      const span = daysApart(form.startDay, form.endDay);
      if (span !== null && span < 0) errors.end = 'errEnd';
      else if (span !== null && span >= MAX_SPAN_DAYS) errors.end = 'errField';
    }
  }
  return errors;
}

// ---- Requests ----

/** The repeat that follows the start's Hebrew date (hebrew-repeats spec §1). */
export const isHebrewRepeat = isHebrewForm;

/** A Hebrew series' anchor day (yyyy-MM-dd, in its zone), from the edit info, or null for any other. */
export const hebrewAnchorOf = (info: ItemEditInfoResponse): string | null => info.series.rule?.anchor ?? info.series.repeat?.hebrew?.anchor ?? null;

/** The wall time the server takes: with the clock when timed, the bare day when all-day. */
const wallOf = (day: string, time: string, allDay: boolean) => (allDay ? day : `${day}T${time}`);

/** The POST body for a new item (user_id and the init data are added by the client). */
export function createBody(form: EditorForm): Omit<CreateItemBody, 'user_id' | 'initData'> {
  const reminder = form.kind === 'reminder';
  // A reminder with no time is a date-only one, which arrives at the reminder time; one by zman is date-only too.
  const allDay = effectiveAllDay(form);
  const body: Omit<CreateItemBody, 'user_id' | 'initData'> = {
    kind: form.kind,
    title: form.title.trim(),
    allDay,
    start: wallOf(form.startDay, form.startTime, allDay),
    // A rule kept as it is has no meaning for a new item; a spec goes as the sheet shows it, end included.
    repeat: repeatInput(form.repeat, form.startDay),
  };
  const location = form.location.trim();
  const notes = form.notes.trim();
  if (location && !reminder) body.location = location;
  if (notes && !reminder) body.description = notes;
  if (!reminder) {
    body.end = wallOf(form.endDay, form.endTime, allDay);
    if (form.calendarId) body.calendarId = form.calendarId;
    // Only a timed FamCal event takes one: a Google calendar keeps its own, an all-day event has none.
    if (form.alert !== 'default' && !allDay && isNativeCalendar(form.calendarId)) body.alert = form.alert;
  } else if (form.forWho !== 'me') {
    body.forWho = form.forWho;
    // The switch goes only for a reminder for both of us, and only when it is on (the default is one shared Done).
    if (form.forWho === 'both' && form.eachMarksDone) body.eachMarksDone = true;
  }
  // A reminder by zman carries its rule (the default, a plain time, is nothing).
  if (isByZman(form)) {
    body.timeMode = 'zman';
    body.zmanSpec = zmanSpecOf(form);
  }
  return body;
}

/**
 * The PATCH body for an edit: only what changed, or null when nothing did. `info` is the
 * item's edit info: with it, a 'following' day move on a set-weekdays series whose rule reads
 * as one of the five sends that choice again (restatedRepeat).
 */
export function updateBody(
  form: EditorForm,
  initial: EditorForm,
  key: string,
  scope: EditScope,
  info?: ItemEditInfoResponse,
): Omit<UpdateItemBody, 'user_id' | 'initData'> | null {
  const reminder = form.kind === 'reminder';
  const changes: UpdateItemBody['changes'] = {};
  const title = form.title.trim();
  if (title !== initial.title.trim()) changes.title = title;
  if (!reminder) {
    if (form.location.trim() !== initial.location.trim()) changes.location = form.location.trim();
    if (form.notes.trim() !== initial.notes.trim()) changes.description = form.notes.trim();
  }
  // A reminder by zman is date-only whatever its all-day switch says.
  const allDayNow = effectiveAllDay(form);
  const allDayWas = effectiveAllDay(initial);
  const was = wallOf(initial.startDay, initial.startTime, allDayWas);
  const now = wallOf(form.startDay, form.startTime, allDayNow);
  const wasEnd = wallOf(initial.endDay, initial.endTime, allDayWas);
  const nowEnd = wallOf(form.endDay, form.endTime, allDayNow);
  const timeMoved = allDayNow !== allDayWas || now !== was || (!reminder && nowEnd !== wasEnd);
  if (timeMoved) {
    if (allDayNow !== allDayWas) changes.allDay = allDayNow;
    changes.start = now;
    if (!reminder) changes.end = nowEnd;
  }
  // A reminder's time mode: by zman (with its rule) or back to a plain time, from this occurrence on or for all of them (a series change).
  const mode = timeModeChange(form, initial);
  if (mode !== null) Object.assign(changes, mode);
  // The series-level fields go only when the person changed them (3b spec §4). A rule kept
  // as it is ('custom' untouched, or the stored choice) is never sent: the server would read
  // a stored bot rule that classifies as one of the five as a repeat change.
  const repeat = pickedRepeat(form, initial, info) ?? (scope === 'following' && info ? restatedRepeat(form, initial, info) : null);
  if (repeat !== null) changes.repeat = repeat;
  if (!reminder && form.calendarId && form.calendarId !== initial.calendarId) changes.calendarId = form.calendarId;
  if (reminder && form.forWho !== initial.forWho) changes.forWho = form.forWho;
  const each = eachMarksDoneChange(form, initial);
  if (each !== null) changes.eachMarksDone = each;
  const alert = alertChange(form, initial);
  if (alert !== null) changes.alert = alert;
  // A stop makes this occurrence a one-off: it always carries the occurrence's own times,
  // with the form's edits on top, never the series' (3b spec §3.1).
  if (repeat === 'none' && initial.repeat !== 'none') {
    changes.start ??= now;
    if (!reminder) changes.end ??= nowEnd;
  }
  return Object.keys(changes).length === 0 ? null : { key, scope, changes };
}

/**
 * The "each of us marks it done" switch the person set, or null while it is as it was. Only a reminder for both of us has
 * one: moving the For away from both sends the For alone (the server clears the switch), and a hidden switch is never sent.
 */
function eachMarksDoneChange(form: EditorForm, initial: EditorForm): boolean | null {
  return form.kind === 'reminder' && form.forWho === 'both' && form.eachMarksDone !== initial.eachMarksDone ? form.eachMarksDone : null;
}

/**
 * The alert the person picked, or null while it is as it was. Not sent for a reminder, or while the
 * form is all-day (the row is hidden then; the stored alert stays and shows again).
 */
function alertChange(form: EditorForm, initial: EditorForm): AlertChoice | null {
  return form.kind === 'event' && !form.allDay && form.alert !== initial.alert ? form.alert : null;
}

/**
 * The repeat the person picked, as the request carries it, or null while the row is as it was
 * (including a custom rule left alone). A spec is compared to the stored one relative to each
 * start, so moving the start of a plain weekly or monthly series is not a change of its repeat.
 */
function pickedRepeat(form: EditorForm, initial: EditorForm, info?: ItemEditInfoResponse): RepeatInput | null {
  const day = repeatDayOf(form, info);
  if (form.repeat === 'custom' || sameRepeat(form.repeat, initial.repeat, day)) return null;
  return repeatInput(form.repeat, day);
}

const canonicalByDay = (spec: RepeatSpec): string[] => [...(spec.byDay ?? [])].sort();

/**
 * The shown spec, to send again, when the form moves the day of a set-weekdays series whose
 * rule the sheet can say (Google's own weekly events, BYDAY=MO from a Monday; the bot's "every
 * Tuesday"; the second Tuesday of a month); else null. The server builds it again on the new
 * start (write.ts repeatChanges, ruling 8: the days gain the new start's, the ordinal follows
 * it), so "this one and the ones after" can move the day (3b spec §2.1).
 */
export function restatedRepeat(form: EditorForm, initial: EditorForm, info: ItemEditInfoResponse): RepeatSpec | null {
  if (!info.series.recurring || !info.series.fixedDays || !isSpec(initial.repeat) || !sameRepeat(form.repeat, initial.repeat, repeatDayOf(form, info))) return null;
  if (!movesDay(form, initial, info.tz, info.series.zone)) return null;
  const restated = shownSpec(form.repeat, repeatDayOf(form, info));
  // A move onto a day the weekly set already has restates the same rule: the server then sees no change
  // and refuses the day move, so only "this one" is offered (as in 3b).
  const opened = shownSpec(initial.repeat, repeatDayOf(initial, info));
  if (restated?.freq === 'weekly' && opened && canonicalByDay(restated).join() === canonicalByDay(opened).join()) return null;
  return restated;
}

/**
 * The edit moves the event to the other kind of calendar, FamCal and Google ("Google as a
 * connection" §5): a copy there, then a delete here. It is saved on its own, and takes a
 * whole series.
 */
export function crossesKinds(form: EditorForm, initial: EditorForm): boolean {
  if (form.kind === 'reminder' || !form.calendarId || !initial.calendarId) return false;
  return isNativeCalendar(form.calendarId) !== isNativeCalendar(initial.calendarId);
}

/** Which occurrences a Save applies to, and whether to ask (3b spec §4). */
export type ScopePlan =
  /** Nothing to ask: this item alone (a one-off, or no series-level change). */
  | { kind: 'none' }
  /** A repeat change applies from the opened occurrence on: 'following', with no question. */
  | { kind: 'following' }
  /** Ask, with these choices; `note` is the line the sheet adds ('crossKind': a move to the other kind takes the whole series). */
  | { kind: 'sheet'; choices: EditScope[]; note?: 'dayMove' | 'series' | 'crossKind' }
  /**
   * Can't be saved as it is: a day move on a set-weekdays series cannot ride with a calendar or
   * recipient change; a move to the other kind of calendar cannot ride with any other change.
   */
  | { kind: 'refuse'; note: 'dayMoveAlone' | 'moveAlone' };

/**
 * What Save does for the form against where it started. A repeat change is always from this
 * occurrence on; a calendar, alert or recipient change on a series asks 'following' or 'all' (an
 * occurrence has none of its own); a day move on a set-weekdays series (the bot's "every
 * Tuesday") can apply to this one alone, so it can't share a save with those. A repeat pick
 * writes a rule that names no days, so a move that also picks one is never refused. A day
 * move alone on a set-weekdays series whose rule reads as one of the five offers this one, or
 * this one and the ones after with that choice sent again (restatedRepeat); the line on
 * moving them all shows unless the opened occurrence is the first (then that is all of them).
 * A move to the other kind of calendar is saved alone, and on a series asks only "All of them".
 */
export function scopePlan(form: EditorForm, initial: EditorForm, info: ItemEditInfoResponse): ScopePlan {
  if (crossesKinds(form, initial)) {
    const changed = Object.keys(updateBody(form, initial, '', 'all', info)?.changes ?? {});
    if (changed.some((field) => field !== 'calendarId')) return { kind: 'refuse', note: 'moveAlone' };
    return info.series.recurring ? { kind: 'sheet', choices: ['all'], note: 'crossKind' } : { kind: 'none' };
  }
  if (!info.series.recurring) return { kind: 'none' };
  if (pickedRepeat(form, initial, info) !== null) return { kind: 'following' };
  const reminder = form.kind === 'reminder';
  // A reminder given a time of its own on one occurrence of a series is just a move of that occurrence to a fixed time;
  // any other change of its zman rule or mode is a series change, like the recipient's.
  const zmanOffTimed = reminder && form.timeMode === 'time' && initial.timeMode === 'zman' && !effectiveAllDay(form);
  const otherSeriesLevel =
    (!reminder && !!form.calendarId && form.calendarId !== initial.calendarId) ||
    alertChange(form, initial) !== null ||
    eachMarksDoneChange(form, initial) !== null ||
    (reminder && form.forWho !== initial.forWho);
  const zmanSeriesLevel = timeModeChange(form, initial) !== null && !zmanOffTimed;
  const dayMove = info.series.fixedDays && movesDay(form, initial, info.tz, info.series.zone);
  // The note under the choices speaks of a calendar, alert or recipient change: a change of the zman alone asks without it.
  if (otherSeriesLevel || zmanSeriesLevel) {
    return dayMove ? { kind: 'refuse', note: 'dayMoveAlone' } : { kind: 'sheet', choices: ['following', 'all'], ...(otherSeriesLevel ? { note: 'series' as const } : {}) };
  }
  if (info.scopes.length <= 1) return { kind: 'none' };
  if (!dayMove) return { kind: 'sheet', choices: ['single', 'following', 'all'] };
  if (restatedRepeat(form, initial, info) === null) return { kind: 'sheet', choices: ['single'], note: 'dayMove' };
  return info.series.first === true ? { kind: 'sheet', choices: ['single', 'following'] } : { kind: 'sheet', choices: ['single', 'following'], note: 'dayMove' };
}

// ---- Words for a repeat ----

/** How the editor words a series' repeat: a copy key with its arguments. */
export type RepeatWords =
  | { key: 'daily' }
  | { key: 'weekday'; weekday: WeekdayId }
  | { key: 'interval'; unit: RepeatInfo['freq']; count: number }
  /** Every N years on the anchor's Hebrew date (the editor words the date), for a rule the Hebrew choice can't say. */
  | { key: 'hebrewEvery'; count: number; anchor: string }
  /** A weekly rule on several days (Monday first), every N weeks. */
  | { key: 'weekdays'; interval: number; days: WeekdayId[] }
  /** A monthly rule on the n-th (or last) weekday, every N months. */
  | { key: 'nth'; interval: number; ordinal: number | 'last'; weekday: WeekdayId }
  /** A monthly rule on one day of the month, every N months. */
  | { key: 'monthDay'; interval: number; day: number }
  | { key: 'weekly' | 'monthly' | 'yearly' }
  | { key: 'other' };

const BYDAY: Record<string, WeekdayId> = { SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat' };

/**
 * What a series repeats on, from the server's rule info: "every day", "every Tuesday"
 * (a weekly rule on one day, or following the start), "every 2 weeks", the days of a weekly
 * rule, the n-th weekday or the day of a monthly one, the frequency alone for the rest, and
 * "other" for a rule with no words (null). A Hebrew-date rule names its anchor's date, never
 * the start's (hebrew-repeats spec §3). A rule the Repeat sheet can say is worded from its spec
 * instead (repeat-words.ts); this is for the rest, which open with their real words.
 */
export function repeatWords(repeat: RepeatInfo | null, seriesStart: string): RepeatWords {
  if (!repeat) return { key: 'other' };
  if (repeat.hebrew) return { key: 'hebrewEvery', count: repeat.interval, anchor: repeat.hebrew.anchor };
  if (repeat.freq === 'monthly' && repeat.byDay.length === 1 && BYDAY[repeat.byDay[0]] && repeat.byDayOrdinals) {
    const n = repeat.byDayOrdinals[0];
    if (n !== null && n !== undefined && ((n >= 1 && n <= 5) || n === -1)) return { key: 'nth', interval: repeat.interval, ordinal: n === -1 ? 'last' : n, weekday: BYDAY[repeat.byDay[0]] };
  }
  if (repeat.freq === 'monthly' && repeat.byDay.length === 0 && repeat.byMonthDay?.length === 1 && repeat.byMonthDay[0] >= 1) return { key: 'monthDay', interval: repeat.interval, day: repeat.byMonthDay[0] };
  if (repeat.freq === 'weekly' && repeat.byDay.length > 1 && !repeat.byDayOrdinals && repeat.byDay.every((c) => BYDAY[c])) {
    return { key: 'weekdays', interval: repeat.interval, days: repeat.byDay.map((c) => BYDAY[c]) };
  }
  if (repeat.interval > 1) return { key: 'interval', unit: repeat.freq, count: repeat.interval };
  if (repeat.freq === 'daily') return { key: 'daily' };
  if (repeat.freq === 'weekly') {
    if (repeat.byDay.length === 1 && BYDAY[repeat.byDay[0]]) return { key: 'weekday', weekday: BYDAY[repeat.byDay[0]] };
    if (repeat.byDay.length === 0) {
      const w = weekdayId(seriesStart.slice(0, 10));
      return w ? { key: 'weekday', weekday: w } : { key: 'weekly' };
    }
    return { key: 'weekly' };
  }
  return { key: repeat.freq };
}

/**
 * The short name of "all of them" in the scope sheet, when the series has one: every day,
 * every <weekday>, or, when the series' spec is richer than those, the spec in words (the same
 * words as the Repeat row). A series that ends (cut by "this one and the ones after"), or any
 * other rule, has none.
 */
export function allOfThem(
  repeat: RepeatInfo | null,
  seriesStart: string,
  spec?: RepeatSpec,
): { key: 'all' } | { key: 'daily' } | { key: 'weekday'; weekday: WeekdayId } | { key: 'rule'; spec: RepeatSpec; startDay: string } {
  if (!repeat || repeat.ends) return { key: 'all' };
  const words = repeatWords(repeat, seriesStart);
  if (words.key === 'daily') return { key: 'daily' };
  if (words.key === 'weekday') return { key: 'weekday', weekday: words.weekday };
  if (spec && !spec.until && spec.count === undefined) return { key: 'rule', spec, startDay: seriesStart.slice(0, 10) };
  return { key: 'all' };
}
