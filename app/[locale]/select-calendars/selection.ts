// The Google calendars a person shows in FamCal, as the Select calendars screen holds them, and the changes it makes to
// them. Pure functions of immutable values: a change returns a new Selection and never touches the old one, so a save
// that fails can put the state from before it back (the screen keeps that value for the rollback).
//
// The rules are the ones the screen has always had and the server's validateCalendarAssignments checks (src/utils/
// calendar-helpers.ts): a calendar has at most one of yours / spouse / kids / birthdays; primary is one calendar across
// the list and is always also yours; a selection needs a calendar of yours. The request is the whole selection.
//
// Client-safe: no import beyond types.

import type { CalendarAssignment, CalendarLabel } from '@/src/types';

export interface SpouseInfo {
  personName?: string;
  personEnglishName?: string;
  personGender?: 'male' | 'female';
}

/** What Google lists of a calendar and the screen reads. */
export interface ListedCalendar {
  id: string;
  name: string;
  description?: string;
  backgroundColor: string;
  primary?: boolean;
  accessRole?: string;
}

/** The categories of which a calendar has at most one (primary is a label of its own). */
export const CATEGORIES = ['yours', 'spouse', 'kids', 'birthdays'] as const;
export type Category = (typeof CATEGORIES)[number];

export const GLOBAL_NOTES = 3;

export interface Selection {
  /** The chosen calendars' ids in the order they were chosen (the server's "first yours" follows it). */
  selected: Set<string>;
  labels: Map<string, Set<CalendarLabel>>;
  /** A calendar's note for the AI. */
  rules: Map<string, string>;
  /** One set of details for every spouse calendar. */
  spouse: SpouseInfo | null;
  /** The notes for all calendars, always GLOBAL_NOTES entries (empty ones included). */
  globalRules: string[];
}

/** The note list padded or cut to GLOBAL_NOTES entries. */
export function paddedNotes(rules: readonly string[]): string[] {
  return Array.from({ length: GLOBAL_NOTES }, (_, i) => rules[i] ?? '');
}

/** A Selection from what the page hands over (copies: the page's own Sets and Maps are never changed). */
export function selectionFrom(input: {
  selectedCalendars: ReadonlySet<string>;
  calendarLabels: ReadonlyMap<string, ReadonlySet<CalendarLabel>>;
  spouseInfo: SpouseInfo | null;
  calendarRules: ReadonlyMap<string, string>;
  globalRules: readonly string[];
}): Selection {
  return {
    selected: new Set(input.selectedCalendars),
    labels: new Map([...input.calendarLabels].map(([id, labels]) => [id, new Set(labels)])),
    rules: new Map(input.calendarRules),
    spouse: input.spouseInfo,
    globalRules: paddedNotes(input.globalRules),
  };
}

const cloneLabels = (labels: ReadonlyMap<string, ReadonlySet<CalendarLabel>>) => new Map([...labels].map(([id, set]) => [id, new Set(set)]));

/** The categories a calendar's labels hold, in the screen's order (more than one only in old data). */
export function categoriesOf(labels: ReadonlySet<CalendarLabel> | undefined): Category[] {
  return CATEGORIES.filter((c) => labels?.has(c));
}

/** The one category the sheet shows chosen (the first, for old data that holds more), or null. */
export function categoryOf(labels: ReadonlySet<CalendarLabel> | undefined): Category | null {
  return categoriesOf(labels)[0] ?? null;
}

/** The labels with `category` as their only category (null: none). Primary stays, and, being always yours, forces yours. */
export function withCategory(labels: ReadonlySet<CalendarLabel>, category: Category | null): Set<CalendarLabel> {
  const next = new Set<CalendarLabel>([...labels].filter((l) => !(CATEGORIES as readonly string[]).includes(l)));
  if (next.has('primary')) next.add('yours');
  else if (category) next.add(category);
  return next;
}

/** The labels with primary on (which makes the calendar yours, and only yours) or off (yours stays). */
export function withPrimary(labels: ReadonlySet<CalendarLabel>, on: boolean): Set<CalendarLabel> {
  if (on) return new Set<CalendarLabel>(['primary', 'yours']);
  const next = new Set(labels);
  next.delete('primary');
  return next;
}

/**
 * The calendar shown in FamCal, or no more. Off drops its labels and its note. On adds it with no labels, except that a
 * selection with no calendar of yours gives it yours: the server refuses such a selection, so without it a first tap
 * would always be undone.
 */
export function toggleShown(sel: Selection, id: string): Selection {
  const selected = new Set(sel.selected);
  const labels = cloneLabels(sel.labels);
  const rules = new Map(sel.rules);
  if (selected.has(id)) {
    selected.delete(id);
    labels.delete(id);
    rules.delete(id);
  } else {
    selected.add(id);
    const hasYours = [...selected].some((other) => other !== id && labels.get(other)?.has('yours'));
    labels.set(id, new Set<CalendarLabel>(hasYours ? [] : ['yours']));
  }
  return { ...sel, selected, labels, rules };
}

/** What the calendar's sheet edits. The spouse details are entered as text; empty ones mean none. */
export interface CalendarDraft {
  labels: ReadonlySet<CalendarLabel>;
  note: string;
  spouse: { name: string; englishName: string; gender: 'male' | 'female' | '' };
}

const clean = (text: string) => text.trim() || undefined;

/** The spouse details from their fields, or null when all are empty. */
export function spouseFrom(fields: CalendarDraft['spouse']): SpouseInfo | null {
  const info: SpouseInfo = { personName: clean(fields.name), personEnglishName: clean(fields.englishName), personGender: fields.gender || undefined };
  return info.personName || info.personEnglishName || info.personGender ? info : null;
}

/** The selection with this calendar's labels and note, and (for a spouse calendar) the spouse details; primary leaves every other calendar. */
export function applyCalendar(sel: Selection, id: string, draft: CalendarDraft): Selection {
  const labels = cloneLabels(sel.labels);
  if (draft.labels.has('primary')) for (const [other, set] of labels) if (other !== id) set.delete('primary');
  labels.set(id, new Set(draft.labels));
  const rules = new Map(sel.rules);
  const note = draft.note.trim();
  if (note) rules.set(id, note);
  else rules.delete(id);
  return { ...sel, labels, rules, spouse: draft.labels.has('spouse') ? spouseFrom(draft.spouse) : sel.spouse };
}

/** The selection with these notes for all calendars (trimmed, three entries). */
export function withNotes(sel: Selection, notes: readonly string[]): Selection {
  return { ...sel, globalRules: paddedNotes(notes.map((n) => n.trim())) };
}

/** The count the notes row shows: the non-empty notes. */
export const noteCount = (sel: Selection) => sel.globalRules.filter((r) => r.trim() !== '').length;

/** The body of the save: the whole selection, in the order it was chosen. */
export function saveBody(sel: Selection, listed: readonly ListedCalendar[]): { calendarAssignments: CalendarAssignment[]; globalRules: string[] } {
  const calendarAssignments: CalendarAssignment[] = [...sel.selected].map((calendarId) => {
    const calendar = listed.find((c) => c.id === calendarId);
    const labels = [...(sel.labels.get(calendarId) ?? [])];
    const rule = sel.rules.get(calendarId);
    return {
      calendarId,
      labels,
      name: calendar?.name || calendarId,
      color: calendar?.backgroundColor || '#4285f4',
      // One set of details for every spouse calendar
      ...(labels.includes('spouse') && sel.spouse
        ? { personName: sel.spouse.personName, personEnglishName: sel.spouse.personEnglishName, personGender: sel.spouse.personGender }
        : {}),
      ...(rule ? { rules: [rule] } : {}),
    };
  });
  return { calendarAssignments, globalRules: sel.globalRules.filter((r) => r.trim() !== '') };
}
