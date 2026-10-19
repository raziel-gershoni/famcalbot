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
  type ItemEditInfoResponse,
  type ItemKind,
  type RepeatChoice,
  type RepeatInfo,
  type UpdateItemBody,
} from './editor-types';

/** When a reminder with no time arrives, as the bot's date-only reminders do (spec §2). */
export const REMINDER_DEFAULT_TIME = '09:00';
/** What a new event lasts, and the time a new one on another day starts at. */
export const DEFAULT_EVENT_MINUTES = 60;
export const DEFAULT_EVENT_TIME = '09:00';
/** The years the server accepts. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
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
  repeat: RepeatChoice;
  /** A new event's calendar: 'native:<cuid>'. */
  calendarId: string | null;
  /** A new reminder is for the partner. */
  forPartner: boolean;
}

export type FieldName = 'title' | 'location' | 'notes' | 'start' | 'end';

/** The copy key (calendarHome.editor.<key>) of each inline error, by field. */
export type FieldErrors = Partial<Record<FieldName, 'errTitle' | 'errTitleLong' | 'errTooLong' | 'errDate' | 'errEnd' | 'errField'>>;

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

/** Whether `day` names a real date in the years the server accepts. */
export function isRealDay(day: string): boolean {
  const ms = wallMs(day, '00:00');
  if (ms === null) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

const isRealTime = (time: string) => wallMs('2000-01-01', time) !== null;

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
    forPartner: false,
  };
}

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
    repeat: 'none',
    calendarId: info.calendar.id,
    forPartner: false,
  };
}

// ---- Edits ----

/**
 * The form after the start moved (a new day or time): the end keeps its distance from the
 * start. All day, that is the days between them; timed, the minutes. A start that is not
 * a real date or time leaves the end where it is.
 */
export function moveStart(form: EditorForm, patch: { startDay?: string; startTime?: string }): EditorForm {
  const next = { ...form, ...patch };
  if (form.allDay) {
    const span = daysApart(form.startDay, form.endDay);
    if (span === null || !isRealDay(next.startDay)) return next;
    return { ...next, endDay: addDays(next.startDay, span) };
  }
  const from = wallMs(form.startDay, form.startTime);
  const to = wallMs(form.endDay, form.endTime);
  const moved = wallMs(next.startDay, next.startTime);
  if (from === null || to === null || moved === null) return next;
  const end = shiftWall(next.startDay, next.startTime, Math.round((to - from) / MINUTE_MS));
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

/** Whether the form differs from where it started (Cancel asks to discard only then). */
export function isDirty(form: EditorForm, initial: EditorForm): boolean {
  const keys = Object.keys(initial) as (keyof EditorForm)[];
  return keys.some((k) => {
    // A reminder has no end, and a switch-off time is not an edit.
    if (form.kind === 'reminder' && (k === 'endDay' || k === 'endTime')) return false;
    if (form.allDay && initial.allDay && (k === 'startTime' || k === 'endTime')) return false;
    return form[k] !== initial[k];
  });
}

// ---- Checks ----

const length = (text: string) => Array.from(text).length;

/** The inline errors; empty when the form can be sent. */
export function checkForm(form: EditorForm): FieldErrors {
  const errors: FieldErrors = {};
  const title = form.title.trim();
  if (title === '') errors.title = 'errTitle';
  else if (length(title) > TITLE_MAX) errors.title = 'errTitleLong';
  if (length(form.location.trim()) > LOCATION_MAX) errors.location = 'errTooLong';
  if (length(form.notes.trim()) > NOTES_MAX) errors.notes = 'errTooLong';

  const reminder = form.kind === 'reminder';
  const timed = !form.allDay;
  if (!isRealDay(form.startDay) || (timed && !isRealTime(form.startTime))) errors.start = 'errDate';
  if (!reminder && !errors.start) {
    if (!isRealDay(form.endDay) || (timed && !isRealTime(form.endTime))) errors.end = 'errDate';
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

/** The wall time the server takes: with the clock when timed, the bare day when all-day. */
const wallOf = (day: string, time: string, allDay: boolean) => (allDay ? day : `${day}T${time}`);

/** The POST body for a new item (user_id and the init data are added by the client). */
export function createBody(form: EditorForm): Omit<CreateItemBody, 'user_id' | 'initData'> {
  const reminder = form.kind === 'reminder';
  // A reminder with no time is a date-only one, which arrives at 09:00.
  const allDay = form.allDay;
  const body: Omit<CreateItemBody, 'user_id' | 'initData'> = {
    kind: form.kind,
    title: form.title.trim(),
    allDay,
    start: wallOf(form.startDay, form.startTime, allDay),
    repeat: form.repeat,
  };
  const location = form.location.trim();
  const notes = form.notes.trim();
  if (location && !reminder) body.location = location;
  if (notes && !reminder) body.description = notes;
  if (!reminder) {
    body.end = wallOf(form.endDay, form.endTime, allDay);
    if (form.calendarId) body.calendarId = form.calendarId;
  } else if (form.forPartner) {
    body.forPartner = true;
  }
  return body;
}

/** The PATCH body for an edit: only what changed, or null when nothing did. */
export function updateBody(
  form: EditorForm,
  initial: EditorForm,
  key: string,
  scope: EditScope,
): Omit<UpdateItemBody, 'user_id' | 'initData'> | null {
  const reminder = form.kind === 'reminder';
  const changes: UpdateItemBody['changes'] = {};
  const title = form.title.trim();
  if (title !== initial.title.trim()) changes.title = title;
  if (!reminder) {
    if (form.location.trim() !== initial.location.trim()) changes.location = form.location.trim();
    if (form.notes.trim() !== initial.notes.trim()) changes.description = form.notes.trim();
  }
  const was = wallOf(initial.startDay, initial.startTime, initial.allDay);
  const now = wallOf(form.startDay, form.startTime, form.allDay);
  const wasEnd = wallOf(initial.endDay, initial.endTime, initial.allDay);
  const nowEnd = wallOf(form.endDay, form.endTime, form.allDay);
  const timeMoved = form.allDay !== initial.allDay || now !== was || (!reminder && nowEnd !== wasEnd);
  if (timeMoved) {
    if (form.allDay !== initial.allDay) changes.allDay = form.allDay;
    changes.start = now;
    if (!reminder) changes.end = nowEnd;
  }
  return Object.keys(changes).length === 0 ? null : { key, scope, changes };
}

// ---- Words for a repeat ----

/** How the editor words a series' repeat: a copy key with its arguments. */
export type RepeatWords =
  | { key: 'daily' }
  | { key: 'weekday'; weekday: WeekdayId }
  | { key: 'interval'; unit: RepeatInfo['freq']; count: number }
  | { key: 'weekly' | 'monthly' | 'yearly' }
  | { key: 'other' };

const BYDAY: Record<string, WeekdayId> = { SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat' };

/**
 * What a series repeats on, from the server's rule info: "every day", "every Tuesday"
 * (a weekly rule on one day, or following the start), "every 2 weeks", the frequency
 * alone for the rest, and "other" for a rule with no words (null).
 */
export function repeatWords(repeat: RepeatInfo | null, seriesStart: string): RepeatWords {
  if (!repeat) return { key: 'other' };
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
 * or every <weekday>. A series that ends (cut by "this one and the ones after"), or any
 * other rule, has none.
 */
export function allOfThem(repeat: RepeatInfo | null, seriesStart: string): { key: 'all' } | { key: 'daily' } | { key: 'weekday'; weekday: WeekdayId } {
  if (!repeat || repeat.ends) return { key: 'all' };
  const words = repeatWords(repeat, seriesStart);
  if (words.key === 'daily') return { key: 'daily' };
  if (words.key === 'weekday') return { key: 'weekday', weekday: words.weekday };
  return { key: 'all' };
}
