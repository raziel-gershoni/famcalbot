// The Agenda's model (spec §7.3, Rulings R8 and R10): what the Agenda shows, worked out
// from the client store. Pure and client-safe: it imports only the store and the DTO
// types. The view (AgendaView, DayList, ItemRow) formats dates, times and copy; this
// file decides which days show, which fold, which state rows appear, what the
// "Still open" card holds and whose each item is.
//
// - Today and the next 6 days; each "Show next week" adds 7 (weeks = 2, 3, …).
// - Today and tomorrow always show. A later empty day folds into one line with its
//   empty neighbours, but only once every applicable source answered ok for it (§5).
// - A day a source failed for, with no earlier ok data, shows no empty line and no
//   fold; the source's state row shows once, above the days, with the reason of the
//   earliest such day (dayFailure), so a later window's failure never rewrites it. A
//   reconnect is the Reconnect banner's (homeNotices, in the container), never a state row.
// - Still open: today's open reminders by time, then the carry-overs newest first;
//   5 shown, then the rest.

import type { DayKey, ItemDTO, SourceName, WeekStart } from './types';
import {
  SOURCE_ORDER,
  addDaysToKey,
  dayFailure,
  dayItems,
  dayStatus,
  failedSources,
  homeNotices,
  isPartialDay,
  type CalendarStore,
  type DayStatus,
  type SourceFailure,
} from './store';

/** Days in one Agenda week: today and the next 6 (Ruling R8), and each "Show next week". */
export const AGENDA_WEEK_DAYS = 7;
/** The "Still open" card shows this many, then "N more". */
export const STILL_OPEN_SHOWN = 5;

/**
 * Whose an item is (§7.3, Ruling R7). A reminder goes by `reminder.ownerIsViewer`, the
 * summaries' rule (categorizeEvents in src/services/telegram/summary.ts); an event by
 * `calendar.mine`. `mine` decides filled or outlined chips and filled or ring dots.
 */
export interface Whose {
  mine: boolean;
  /** The name on the person chip: the partner, or a spouse-labelled Google calendar's person. null on the viewer's own. */
  person: string | null;
  /**
   * Reminders only, as the summaries' reminderAttribution (src/utils/event-formatter.ts):
   * 'for' = the viewer set it for `person`; 'from' = `person` set it for the viewer.
   * null on the viewer's own and on one the partner set for themselves. Never set
   * without a name.
   */
  relation: 'for' | 'from' | null;
}

/** A reminder's icon (§7.3): open circle, check (title struck through), open circle with "until <time>", bell. */
export type ReminderMark = 'open' | 'done' | 'snoozed' | 'later';

export interface AgendaRow {
  item: ItemDTO;
  whose: Whose;
  /** null for events. */
  mark: ReminderMark | null;
}

export interface AgendaDay {
  type: 'day';
  date: DayKey;
  /** "Today", "Tomorrow", or null for the weekday and date. */
  relative: 'today' | 'tomorrow' | null;
  /**
   * With no rows: `answered` → "Nothing planned" (only today and tomorrow get here
   * empty); `loading` → placeholder rows; `failed` → nothing under the header (the
   * state row above says why). With rows, `loading` adds placeholders after them.
   */
  status: DayStatus;
  rows: AgendaRow[];
}

/** Later empty days, answered, in a run: "Nothing planned Sat 17 – Sun 18 Oct". first === last for one day. */
export interface AgendaFold {
  type: 'fold';
  first: DayKey;
  last: DayKey;
}

export type AgendaEntry = AgendaDay | AgendaFold;

export interface StillOpenRow extends AgendaRow {
  /** "since <day>": the carry-over's openSince, or today for today's. */
  since: DayKey;
  carriedOver: boolean;
}

export interface StillOpenCard {
  shown: StillOpenRow[];
  /** "N more" is more.length. */
  more: StillOpenRow[];
}

/** A source that has no data for some shown day, and why. */
export interface AgendaStateRow {
  source: SourceName;
  failure: Exclude<SourceFailure, { kind: 'reconnect' }>;
}

export interface AgendaModel {
  today: DayKey;
  tz: string;
  weekStart: WeekStart;
  hebrewDates: boolean;
  weeks: number;
  /** The day after the last one listed: the days are [today, end). */
  end: DayKey;
  /** At most one per source, in SOURCE_ORDER, above the days. */
  stateRows: AgendaStateRow[];
  /** A shown day's Google data came from a partial answer: "Some calendars didn't load · Retry". */
  partial: boolean;
  /** Chosen Google calendars that are gone: "N calendars aren't available · Choose again". */
  unavailableCalendars: number;
  /** null when nothing is open. */
  stillOpen: StillOpenCard | null;
  entries: AgendaEntry[];
  /** Every shown day answered, none has an item, and nothing is open: Ruling R10's empty state. */
  empty: boolean;
}

/**
 * The window week `week` of the Agenda reads: week 0 is [today, today+7), the route's
 * answer with no dates; week n is the n-th "Show next week".
 */
export function agendaWeekWindow(today: DayKey, week: number): { from: DayKey; to: DayKey } {
  return { from: addDaysToKey(today, week * AGENDA_WEEK_DAYS), to: addDaysToKey(today, (week + 1) * AGENDA_WEEK_DAYS) };
}

const VIEWERS_OWN: Whose = { mine: true, person: null, relation: null };

/** Whose an item is. `partnerName` (the store's partner) names the partner when the item doesn't. */
export function whoseItem(item: ItemDTO, partnerName: string | null): Whose {
  const r = item.reminder;
  if (item.kind === 'reminder' && r) {
    if (r.ownerIsViewer) {
      if (r.creatorIsViewer) return VIEWERS_OWN;
      const from = r.creatorName ?? partnerName;
      return from ? { mine: true, person: from, relation: 'from' } : VIEWERS_OWN;
    }
    const owner = r.ownerName ?? item.calendar.ownerName ?? partnerName;
    return { mine: false, person: owner ?? null, relation: r.creatorIsViewer && owner ? 'for' : null };
  }
  if (item.calendar.mine) return VIEWERS_OWN;
  // A masked calendar's name is the partner's name (never the calendar's own).
  const person = item.calendar.ownerName ?? (item.calendar.inLegend ? null : item.calendar.name || null);
  return { mine: false, person, relation: null };
}

/** A reminder's icon; null for events. A running snooze shows even though it is still open. */
export function reminderMark(item: ItemDTO): ReminderMark | null {
  const r = item.reminder;
  if (item.kind !== 'reminder' || !r) return null;
  if (r.done) return 'done';
  if (r.snoozedUntil) return 'snoozed';
  if (r.open) return 'open';
  return 'later';
}

function toRow(item: ItemDTO, partnerName: string | null): AgendaRow {
  return { item, whose: whoseItem(item, partnerName), mark: reminderMark(item) };
}

/** Today's reminders for the card: open, not done, and the viewer's to act on (its owner or its creator, as carry-overs: A-17). */
function isOpenForViewer(item: ItemDTO): boolean {
  const r = item.reminder;
  return item.kind === 'reminder' && !!r && r.open && !r.done && (r.ownerIsViewer || r.creatorIsViewer);
}

function stillOpenCard(state: CalendarStore, today: DayKey, partnerName: string | null): StillOpenCard | null {
  const rows: StillOpenRow[] = [];
  const seen = new Set<string>();
  for (const item of dayItems(state, today)) {
    if (!isOpenForViewer(item) || seen.has(item.key)) continue;
    seen.add(item.key);
    rows.push({ ...toRow(item, partnerName), since: today, carriedOver: false });
  }
  for (const item of state.carryOvers ?? []) {
    // A carry-over marked done stays in the store, struck, until the next answer drops it; it is no longer open.
    if (seen.has(item.key) || item.reminder?.open === false) continue;
    seen.add(item.key);
    rows.push({ ...toRow(item, partnerName), since: item.reminder?.openSince ?? today, carriedOver: true });
  }
  if (rows.length === 0) return null;
  return { shown: rows.slice(0, STILL_OPEN_SHOWN), more: rows.slice(STILL_OPEN_SHOWN) };
}

/**
 * The row for the item `key` as the store has it now: its first day's copy, else the
 * carry-over's. null when the store holds none (a store drop, or an answer without it).
 * The open item sheet re-derives its row with this on every render.
 */
export function storeRow(state: CalendarStore, key: string): AgendaRow | null {
  const partnerName = state.partner?.name ?? null;
  for (const date of Object.keys(state.days).sort()) {
    const item = state.days[date].items.find((i) => i.key === key);
    if (item) return toRow(item, partnerName);
  }
  const carried = state.carryOvers?.find((i) => i.key === key);
  return carried ? toRow(carried, partnerName) : null;
}

/** The Agenda for `weeks` weeks (1 = today + 6 days); null until the first answer pins the facts. */
export function buildAgenda(state: CalendarStore, weeks = 1): AgendaModel | null {
  const facts = state.facts;
  if (!facts) return null;
  const count = Math.max(1, Math.floor(weeks)) * AGENDA_WEEK_DAYS;
  const partnerName = state.partner?.name ?? null;
  const { today } = facts;

  const entries: AgendaEntry[] = [];
  /** Each source that failed for a shown day, with its earliest such day's failure. */
  const failing = new Map<SourceName, SourceFailure | null>();
  let fold: AgendaFold | null = null;
  let partial = false;
  let nothing = true;
  for (let i = 0; i < count; i++) {
    const date = addDaysToKey(today, i);
    const status = dayStatus(state, date);
    const rows = dayItems(state, date).map((item) => toRow(item, partnerName));
    for (const s of failedSources(state, date)) {
      if (!failing.has(s)) failing.set(s, dayFailure(state, date, s));
    }
    if (isPartialDay(state, date)) partial = true;
    if (status !== 'answered' || rows.length > 0) nothing = false;
    const relative = i === 0 ? 'today' : i === 1 ? 'tomorrow' : null;
    if (relative === null && rows.length === 0 && status !== 'loading') {
      if (status === 'answered') {
        if (fold) fold.last = date;
        else {
          fold = { type: 'fold', first: date, last: date };
          entries.push(fold);
        }
      } else {
        // Failed with nothing to show: left out, and the run of empty days ends here.
        fold = null;
      }
      continue;
    }
    fold = null;
    entries.push({ type: 'day', date, relative, status, rows });
  }

  const stateRows: AgendaStateRow[] = [];
  for (const source of SOURCE_ORDER) {
    if (!failing.has(source)) continue;
    const failure: SourceFailure = failing.get(source) ?? state.lastFailure[source] ?? { kind: 'error', source, reason: null };
    if (failure.kind === 'reconnect') continue;
    stateRows.push({ source, failure });
  }

  const stillOpen = stillOpenCard(state, today, partnerName);
  return {
    today,
    tz: facts.tz,
    weekStart: facts.weekStart,
    hebrewDates: facts.hebrewDates,
    weeks: count / AGENDA_WEEK_DAYS,
    end: addDaysToKey(today, count),
    stateRows,
    partial,
    unavailableCalendars: homeNotices(state).unavailableCalendars,
    stillOpen,
    entries,
    empty: nothing && stillOpen === null,
  };
}
