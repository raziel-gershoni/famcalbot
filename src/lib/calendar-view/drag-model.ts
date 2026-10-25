// Drag to move, as pure logic (editor upgrades spec §4): which items lift, how far a drop moves
// an item, and the move as the editor's own edit. Client-safe and pure: it imports only the
// editor model and the shared types. Nothing here touches window.
//
// A drop is an editor edit with the start shifted: the item's edit info builds the form
// (editItemForm), the start moves by whole days (the end follows it, as in the editor), and
// scopePlan says what to ask. updateBody builds the PATCH body. There is no second set of scope
// or body rules here; this file only decides the shift.
//
// The days of a move are read in the series' zone (info.series.zone), where the store reads
// them: a timed item keeps its time of day there, so a series in another zone does not drift by
// the hour the two zones' daylight saving differ. A multi-day item shifts by the days between the
// grabbed day and the drop day, wherever on the item it was grabbed. An all-day item's days are
// already the item's own.

import type { DayKey, ItemDTO, ItemSpan } from './types';
import type { EditScope, ItemEditInfoResponse, UpdateItemBody } from './editor-types';
import {
  addDays,
  checkForm,
  clockIn,
  daysApart,
  editItemForm,
  instantOfWall,
  moveStart,
  scopePlan,
  updateBody,
  wallInZone,
  type EditorForm,
  type FieldErrors,
  type ScopePlan,
} from './editor-model';

/** Why an item does not lift (the message under it is calendarHome.drag.<reason>). */
export type CantLift = 'cantMove' | 'cantMoveDaily';

/**
 * Whether an item lifts (null), or why it does not: the viewer can't change it (a read-only
 * calendar, an event with guests), or it repeats every day (a day move would double a day, ruling D).
 * A holiday is not an item, so it never gets here.
 */
export function liftVerdict(item: Pick<ItemDTO, 'canEdit' | 'repeatsEveryDay'>): CantLift | null {
  if (!item.canEdit) return 'cantMove';
  return item.repeatsEveryDay ? 'cantMoveDaily' : null;
}

/** The whole days from the grabbed day to the drop day: 0 on its own day, null when either is no real day. */
export function dayDelta(grabbed: DayKey, drop: DayKey): number | null {
  return daysApart(grabbed, drop);
}

/** The drop's day as the grid names them: the id a day cell registers under. */
export const DROP_PREFIX = 'day:';
export const dropId = (day: DayKey): string => `${DROP_PREFIX}${day}`;
/** The day a drop id names, or null for any other target (a chevron, or nothing). */
export const dayOfDrop = (id: unknown): DayKey | null => (typeof id === 'string' && id.startsWith(DROP_PREFIX) ? id.slice(DROP_PREFIX.length) : null);

/**
 * Whether a series the item's edit info describes repeats every single day: the editor's rule
 * from the info, for a Google series, whose rule the range read does not carry.
 */
export function repeatsEveryDayInfo(info: ItemEditInfoResponse): boolean {
  const repeat = info.series.recurring ? info.series.repeat : null;
  return repeat !== null && repeat.freq === 'daily' && repeat.interval === 1;
}

/**
 * The editor's form for the item with its start `days` later (negative: earlier). Timed: the time of
 * day stays in the series' zone and the length stays; all-day: the days shift.
 */
export function shiftedForm(info: ItemEditInfoResponse, days: number): EditorForm {
  const form = editItemForm(info);
  if (form.allDay) return moveStart(form, { startDay: addDays(form.startDay, days) });
  const zone = info.series.zone;
  const there = wallInZone(form.startDay, form.startTime, info.tz, zone);
  const back = wallInZone(addDays(there.day, days), there.time, zone, info.tz);
  return moveStart(form, { startDay: back.day, startTime: back.time });
}

/** What a drop comes to, once the item's edit info is known. */
export type MovePlan =
  /** The item can't be moved: the edit info says the viewer can't change it, or it repeats every day. */
  | { kind: 'cant'; reason: CantLift }
  /** Nothing to change (the shifted start is the start). */
  | { kind: 'nothing' }
  /** The editor's own check blocks the moved form (calendarHome.editor.errors.<error>): a year the series can't start in, a repeat that would end before it starts. */
  | { kind: 'invalid'; error: NonNullable<FieldErrors[keyof FieldErrors]> }
  /** Save with this scope, no question. */
  | { kind: 'save'; scope: EditScope; form: EditorForm; initial: EditorForm }
  /** Ask which occurrences (the editor's ScopeSheet), with these choices and note. */
  | { kind: 'ask'; choices: EditScope[]; note?: 'dayMove' | 'series' | 'crossKind'; form: EditorForm; initial: EditorForm }
  /** The editor would refuse this save; the drop snaps back. */
  | { kind: 'refuse'; note: 'dayMoveAlone' | 'moveAlone' };

/** The move of an item by `days`, from its edit info: the scope question, as the editor's scopePlan asks it. */
export function planMove(info: ItemEditInfoResponse, days: number): MovePlan {
  if (!info.canEdit) return { kind: 'cant', reason: 'cantMove' };
  if (repeatsEveryDayInfo(info)) return { kind: 'cant', reason: 'cantMoveDaily' };
  const initial = editItemForm(info);
  const form = shiftedForm(info, days);
  if (updateBody(form, initial, '', 'single', info) === null) return { kind: 'nothing' };
  // The editor's checks for what a date move can break (the title and the notes are not touched by it).
  const errors = checkForm(form, info);
  const blocked = errors.start ?? errors.end ?? errors.repeat;
  if (blocked) return { kind: 'invalid', error: blocked };
  const plan: ScopePlan = scopePlan(form, initial, info);
  switch (plan.kind) {
    case 'none':
      return { kind: 'save', scope: 'single', form, initial };
    case 'following':
      return { kind: 'save', scope: 'following', form, initial };
    case 'sheet':
      return { kind: 'ask', choices: plan.choices, ...(plan.note ? { note: plan.note } : {}), form, initial };
    case 'refuse':
      return { kind: 'refuse', note: plan.note };
  }
}

/** The PATCH body of a planned move with the scope that was picked (updateBody), or null when nothing changes. */
export function moveBody(plan: Extract<MovePlan, { kind: 'save' | 'ask' }>, key: string, scope: EditScope, info: ItemEditInfoResponse): Omit<UpdateItemBody, 'user_id' | 'initData'> | null {
  return updateBody(plan.form, plan.initial, key, scope, info);
}

/**
 * The body that takes a move back (Undo): the item (on `key`, the one the PATCH answered) shifted by `-days`,
 * with the scope the move used. null when nothing changes.
 */
export function undoBody(info: ItemEditInfoResponse, key: string, scope: EditScope, days: number): Omit<UpdateItemBody, 'user_id' | 'initData'> | null {
  return updateBody(shiftedForm(info, -days), editItemForm(info), key, scope, info);
}

/** Whether a move offers Undo: not after "this one and the ones after", whose split can't be cleanly undone. */
export const undoable = (scope: EditScope): boolean => scope !== 'following';

// ---- The item as the store shows it, while the save runs ----

/** The day (yyyy-MM-dd) an instant falls on in `tz`, or null when it is no instant. */
export function dayOfInstant(value: string, tz: string): DayKey | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : clockIn(ms, tz).day;
}

/**
 * The item `days` later (optimistic, while the PATCH runs; the refetch brings the server's): an
 * all-day one on its shifted days, a timed one at the same time of day in its zone (its own, else
 * the user's `tz`) and as long. The key and everything else stay.
 */
export function shiftItemDto(item: ItemDTO, days: number, tz: string): ItemDTO {
  if (item.allDay) {
    const start = addDays(item.start.slice(0, 10), days);
    const end = item.end.length >= 10 ? addDays(item.end.slice(0, 10), days) : start;
    return { ...item, start, end };
  }
  const zone = item.tz ?? tz;
  const startMs = Date.parse(item.start);
  const endMs = Date.parse(item.end);
  if (Number.isNaN(startMs)) return item;
  const wall = clockIn(startMs, zone);
  const movedMs = instantOfWall(addDays(wall.day, days), wall.time, zone);
  if (movedMs === null) return item;
  const length = Number.isNaN(endMs) ? 0 : endMs - startMs;
  return { ...item, start: new Date(movedMs).toISOString(), end: new Date(movedMs + length).toISOString() };
}

/**
 * How the item sits on `day` in `tz`: not on it (null), wholly inside it ({ span: null }), or crossing
 * its edges ({ span }). This is src/utils/day-events.ts daySpanOf's rule, restated because the store is
 * client-only (a smoke checks the two agree): an all-day item's end is exclusive; a timed day is local
 * midnight to local midnight; a zero-length item belongs to the day it falls in; a tail that ends by
 * 06:00 on the day belongs to the night before.
 */
export function spanOnDay(item: Pick<ItemDTO, 'start' | 'end' | 'allDay'>, day: DayKey, tz: string): { span: ItemSpan | null } | null {
  const place = (startsBefore: boolean, endsAfter: boolean): { span: ItemSpan | null } =>
    ({ span: startsBefore ? (endsAfter ? 'spansDay' : 'continues') : endsAfter ? 'endsLater' : null });
  if (item.allDay) {
    const start = item.start.slice(0, 10);
    const end = item.end.length >= 10 && item.end.slice(0, 10) > start ? item.end.slice(0, 10) : addDays(start, 1);
    if (day < start || day >= end) return null;
    return place(start < day, end > addDays(day, 1));
  }
  const dayStart = instantOfWall(day, '00:00', tz);
  const dayEnd = instantOfWall(addDays(day, 1), '00:00', tz);
  const start = Date.parse(item.start);
  const end = Date.parse(item.end || item.start);
  if (dayStart === null || dayEnd === null || Number.isNaN(start) || Number.isNaN(end)) return null;
  if (end === start) return start >= dayStart && start < dayEnd ? { span: null } : null;
  if (end <= dayStart || start >= dayEnd) return null;
  const startsBefore = start < dayStart;
  const endsAfter = end > dayEnd;
  if (startsBefore && !endsAfter) {
    const cutoff = instantOfWall(day, OVERNIGHT_CUTOFF, tz);
    if (cutoff !== null && end <= cutoff) return null;
  }
  return place(startsBefore, endsAfter);
}

/** daySpanOf's OVERNIGHT_CUTOFF_HOUR (6) as a wall time. */
const OVERNIGHT_CUTOFF = '06:00';
