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
  type RuleChoice,
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
  /**
   * A new item's repeat; on an edit, the stored rule as the Repeat row names it. 'custom' is
   * the rule the five can't say, kept as it is until another choice is picked (3b spec §2.1).
   */
  repeat: RuleChoice;
  /** The event's calendar: a new one's, or the edited one's current calendar (a native id or a Google id). */
  calendarId: string | null;
  /** The reminder is for the partner (a new one's, or the edited one's current recipient). */
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

/** wallMs of a day the server accepts (isRealDay), else null: a year being typed (0002, 0202) is not one. */
const realWallMs = (day: string, time: string) => (isRealDay(day) ? wallMs(day, time) : null);

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

/** The day, in `to`, of a wall time on `from`'s clock. A time that is no real time keeps its day. */
export function dayInZone(day: string, time: string, from: string, to: string): string {
  if (from === to) return day;
  const wall = Date.parse(`${day}T${time}:00Z`);
  if (Number.isNaN(wall)) return day;
  // The instant whose clock in `from` reads `wall`: the zone's offset at it, found from a guess.
  const offsetAt = (ms: number) => {
    const c = clockIn(ms, from);
    return Date.parse(`${c.day}T${c.time}:00Z`) - ms;
  };
  let instant = wall - offsetAt(wall);
  instant = wall - offsetAt(instant);
  return clockIn(instant, to).day;
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
    repeat: storedChoice(info),
    calendarId: info.calendar.id,
    forPartner: info.forPartner === true,
  };
}

/** The Repeat row's current choice: the stored rule's (3b spec §2.1), 'none' for a one-off, 'custom' for a rule the server did not classify. */
export function storedChoice(info: ItemEditInfoResponse): RuleChoice {
  if (info.series.rule) return info.series.rule.choice;
  return info.series.recurring ? 'custom' : 'none';
}

// ---- Edits ----

/** How long the form's item lasts: the days between start and end all day, the minutes timed. */
export interface FormSpan {
  allDay: boolean;
  size: number;
}

/** The form's span, or null while its start or end is not a real date and time (isRealDay). */
export function spanOf(form: EditorForm): FormSpan | null {
  if (form.allDay) {
    const days = isRealDay(form.startDay) && isRealDay(form.endDay) ? daysApart(form.startDay, form.endDay) : null;
    return days === null ? null : { allDay: true, size: days };
  }
  const from = realWallMs(form.startDay, form.startTime);
  const to = realWallMs(form.endDay, form.endTime);
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
  const next = { ...form, ...patch };
  const span = spanOf(form) ?? (held && held.allDay === form.allDay ? held : null);
  if (span === null) return next;
  if (form.allDay) {
    return isRealDay(next.startDay) ? { ...next, endDay: addDays(next.startDay, span.size) } : next;
  }
  if (realWallMs(next.startDay, next.startTime) === null) return next;
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

/** A stored rule the Repeat row can't pick, so it is kept as it is and never sent: 'custom'. */
const keptAsIs = (r: RuleChoice): r is Exclude<RuleChoice, RepeatChoice> => r === 'custom';

/** The two repeats that follow the start's Hebrew date (hebrew-repeats spec §1). */
export const isHebrewRepeat = (r: RuleChoice): r is 'hebrew' | 'yahrzeit' => r === 'hebrew' || r === 'yahrzeit';

/** A Hebrew series' anchor day (yyyy-MM-dd, in its zone), from the edit info, or null for any other. */
export const hebrewAnchorOf = (info: ItemEditInfoResponse): string | null => info.series.rule?.anchor ?? info.series.repeat?.hebrew?.anchor ?? null;

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
    repeat: keptAsIs(form.repeat) ? 'none' : form.repeat,
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
  // The series-level fields go only when the person changed them (3b spec §4). A rule kept
  // as it is ('custom' untouched, or the stored choice) is never sent: the server would read
  // a stored bot rule that classifies as one of the five as a repeat change.
  const repeat = pickedRepeat(form, initial) ?? (scope === 'following' && info ? restatedRepeat(form, initial, info) : null);
  if (repeat !== null) changes.repeat = repeat;
  if (!reminder && form.calendarId && form.calendarId !== initial.calendarId) changes.calendarId = form.calendarId;
  if (reminder && form.forPartner !== initial.forPartner) changes.forPartner = form.forPartner;
  // A stop makes this occurrence a one-off: it always carries the occurrence's own times,
  // with the form's edits on top, never the series' (3b spec §3.1).
  if (repeat === 'none' && initial.repeat !== 'none') {
    changes.start ??= now;
    if (!reminder) changes.end ??= nowEnd;
  }
  return Object.keys(changes).length === 0 ? null : { key, scope, changes };
}

/** The repeat the person picked, or null while the row is as it was (including a custom rule left alone). */
function pickedRepeat(form: EditorForm, initial: EditorForm): RepeatChoice | null {
  return !keptAsIs(form.repeat) && form.repeat !== initial.repeat ? form.repeat : null;
}

/**
 * The stored choice, to send again, when the form moves the day of a set-weekdays series
 * whose rule reads as one of the five (Google's own weekly events, BYDAY=MO from a Monday;
 * the bot's "every Tuesday"); else null. The Repeat row can't pick the choice it already
 * shows, and the server reads it sent again as a change to the rule that follows the start
 * (write.ts repeatChanges), so "this one and the ones after" can move the day (3b spec §2.1).
 */
export function restatedRepeat(form: EditorForm, initial: EditorForm, info: ItemEditInfoResponse): RepeatChoice | null {
  const choice = initial.repeat;
  if (!info.series.recurring || !info.series.fixedDays || choice === 'none' || keptAsIs(choice) || form.repeat !== choice) return null;
  return movesDay(form, initial, info.tz, info.series.zone) ? choice : null;
}

/** Which occurrences a Save applies to, and whether to ask (3b spec §4). */
export type ScopePlan =
  /** Nothing to ask: this item alone (a one-off, or no series-level change). */
  | { kind: 'none' }
  /** A repeat change applies from the opened occurrence on: 'following', with no question. */
  | { kind: 'following' }
  /** Ask, with these choices; `note` is the line the sheet adds. */
  | { kind: 'sheet'; choices: EditScope[]; note?: 'dayMove' | 'series' }
  /** Can't be saved as it is: a day move on a set-weekdays series cannot ride with a calendar or recipient change. */
  | { kind: 'refuse'; note: 'dayMoveAlone' };

/**
 * What Save does for the form against where it started. A repeat change is always from this
 * occurrence on; a calendar or recipient change on a series asks 'following' or 'all' (an
 * occurrence has neither of its own); a day move on a set-weekdays series (the bot's "every
 * Tuesday") can apply to this one alone, so it can't share a save with those. A repeat pick
 * writes a rule that names no days, so a move that also picks one is never refused. A day
 * move alone on a set-weekdays series whose rule reads as one of the five offers this one, or
 * this one and the ones after with that choice sent again (restatedRepeat); the line on
 * moving them all shows unless the opened occurrence is the first (then that is all of them).
 */
export function scopePlan(form: EditorForm, initial: EditorForm, info: ItemEditInfoResponse): ScopePlan {
  if (!info.series.recurring) return { kind: 'none' };
  if (pickedRepeat(form, initial) !== null) return { kind: 'following' };
  const reminder = form.kind === 'reminder';
  const seriesLevel = (!reminder && !!form.calendarId && form.calendarId !== initial.calendarId) || (reminder && form.forPartner !== initial.forPartner);
  const dayMove = info.series.fixedDays && movesDay(form, initial, info.tz, info.series.zone);
  if (seriesLevel) return dayMove ? { kind: 'refuse', note: 'dayMoveAlone' } : { kind: 'sheet', choices: ['following', 'all'], note: 'series' };
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
  /** Every N years on the anchor's Hebrew date (the editor words the date), for a rule the two Hebrew choices can't say. */
  | { key: 'hebrewEvery'; kind: 'anniversary' | 'yahrzeit'; count: number; anchor: string }
  | { key: 'weekly' | 'monthly' | 'yearly' }
  | { key: 'other' };

const BYDAY: Record<string, WeekdayId> = { SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat' };

/**
 * What a series repeats on, from the server's rule info: "every day", "every Tuesday"
 * (a weekly rule on one day, or following the start), "every 2 weeks", the frequency
 * alone for the rest, and "other" for a rule with no words (null). A Hebrew-date rule
 * names its anchor's date, never the start's (hebrew-repeats spec §3).
 */
export function repeatWords(repeat: RepeatInfo | null, seriesStart: string): RepeatWords {
  if (!repeat) return { key: 'other' };
  if (repeat.hebrew) return { key: 'hebrewEvery', kind: repeat.hebrew.kind, count: repeat.interval, anchor: repeat.hebrew.anchor };
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
