// The calendar home's client store (spec §5): one store of days, fed by the answers of
// GET /api/calendar/range and shared by the Agenda (Plan D) and the Month (Plan E).
// A reducer for React's useReducer: pure, no fetch, no clock, no storage. It imports
// only the DTO types, so it is client-safe and the smoke runs it as it is.
//
// - An answer replaces, for each source whose status in it is `ok`, that source's items
//   on every day of its [from, to). Other days, and sources with any other status,
//   keep what they had. Within a day, items are deduped by key and sorted with
//   compareItems.
// - The first answer pins tz, today, week start and the sources that apply. A later
//   answer with other values drops the store and starts over; so does `reset` (the
//   midnight timer). Each drop bumps `epoch`, and an answer to a request sent under an
//   older epoch is kept only while its facts still match.
// - Each day remembers, per source, whether an ok answer covered it ("answered", spec
//   §5 "Empty means answered") and whether a failed one did, with that failure: a state
//   row says why for its own days, whatever another window got later. Only answered
//   days may read as empty.
// - A Google reconnect, and the chosen calendars an ok answer lists as unavailable, hold
//   for the epoch: a later answer from Google's cache (ok with a dead token, or a legend
//   from before a calendar went) never takes the banner or the row away, so nothing above
//   the Month comes and goes as its months answer (Plan E, iOS has no scroll anchoring).

import {
  compareItems,
  type CalendarDTO,
  type DayKey,
  type GoogleStatusReason,
  type ItemDTO,
  type ItemReminderDTO,
  type RangeResponse,
  type SourceName,
  type WeekStart,
} from './types';

/** The order sources are listed in: FamCal before Google, as compareItems does. */
export const SOURCE_ORDER: readonly SourceName[] = ['famcal', 'google'];

export type FamcalStatus = NonNullable<RangeResponse['sources']['famcal']>;
export type GoogleStatus = NonNullable<RangeResponse['sources']['google']>;

/** What the server worked out for this user. Every answer carries them. */
export interface StoreFacts {
  tz: string;
  today: DayKey;
  weekStart: WeekStart;
  /** Not pinned: it follows the latest answer (no stored data depends on it). */
  hebrewDates: boolean;
  /** The sources that apply to this user (the keys of an answer's `sources`), in SOURCE_ORDER. */
  sources: SourceName[];
}

/** One source on one day. */
export interface DayCoverage {
  /** An ok answer covered the day: the source's items on it are the latest ok answer's. */
  ok: boolean;
  /** An error or reconnect answer, or a failed request, covered it while no ok answer had. */
  failed: boolean;
  /** The latest ok answer was partial (Google calendars that failed or were cut short). */
  partial: boolean;
  /** The failure that marked the day (set exactly when failed); null when ok or untouched. */
  failure: SourceFailure | null;
}

export interface StoreDay {
  /** Every applicable source's items on the day, deduped by key, sorted with compareItems. */
  items: ItemDTO[];
  coverage: Partial<Record<SourceName, DayCoverage>>;
}

/** Why a source has no data for a day: what its state row says (spec §5 States). */
export type SourceFailure =
  | { kind: 'error'; source: SourceName; reason: GoogleStatusReason | null }
  | { kind: 'calendarsGone'; source: 'google' }
  | { kind: 'reconnect'; source: 'google'; reason: 'token' | 'scopes' }
  | { kind: 'busy'; source: SourceName };

export interface CalendarStore {
  /** Bumped by every drop. Stamp each request with it and pass it back with the answer. */
  epoch: number;
  /** null until the first answer, and after a drop by `reset`. */
  facts: StoreFacts | null;
  days: Readonly<Record<DayKey, StoreDay>>;
  /** Each source's status in the latest answer that asked for it (a `pending` one never overwrites it). */
  status: { famcal?: FamcalStatus; google?: GoogleStatus };
  /** Each source's latest failure, kept after a later ok answer for another window. A state row reads its day's own (dayFailure) first. */
  lastFailure: Partial<Record<SourceName, SourceFailure>>;
  /** The legend from each source's latest ok answer, FamCal first. */
  calendars: CalendarDTO[];
  /** Google asked for a reconnect in this epoch (the latest such answer's reason); null until it does. */
  reconnect: 'token' | 'scopes' | null;
  /** The ids of the Google calendars any ok answer in this epoch listed as unavailable, in the order first seen. */
  unavailable: string[];
  /** From the latest answer with FamCal ok. */
  partner: { name: string } | null;
  /** From the latest answer that carried them (FamCal ok and a window holding today), newest first; null before. */
  carryOvers: ItemDTO[] | null;
}

export type StoreAction =
  /** An answer (HTTP 200). `epoch` is the store's epoch when the request was sent. */
  | { type: 'response'; response: RangeResponse; epoch: number; hold?: ReadonlyMap<string, ItemReminderDTO> }
  /**
   * A request that got no answer to store: 429 (`busy`), 500 or a network error
   * (`error`). Its days that no ok answer covers read as failed, not loading. Needs
   * pinned facts: before the first answer the container shows its own retry card.
   */
  | { type: 'windowFailed'; from: DayKey; to: DayKey; sources: readonly SourceName[]; kind: 'busy' | 'error'; epoch: number }
  /**
   * A reminder's new state after done, undo or snooze (POST /api/calendar/reminder): every
   * copy of the item `key` takes it, in the days' items and in carryOvers, with `open`
   * worked out again (patchedReminder). The next answer confirms it; one that was asked
   * before it comes with `hold` (the loader's) and leaves that key's state as patched.
   */
  | { type: 'patchReminder'; key: string; reminder: ItemReminderDTO }
  /** The midnight timer in tz: drop everything and start over. */
  | { type: 'reset' };

/** A day as the screens see it: every source answered ok, one still to answer, or none will. */
export type DayStatus = 'answered' | 'loading' | 'failed';

/** What the banners need from the store (spec §5 States, §7.2 Banners). */
export interface HomeNotices {
  /** Google asked for a reconnect in this epoch: kept until the store drops. Never set for a FamCal user. */
  reconnect: 'token' | 'scopes' | null;
  /** Chosen Google calendars seen gone in this epoch: "N calendars aren't available · Choose again". */
  unavailableCalendars: number;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** A guard for the day loops: the route answers at most 42 days. */
const MAX_WINDOW_DAYS = 366;
const NO_ITEMS: readonly ItemDTO[] = Object.freeze([]);

/** Plus `days` calendar days to a yyyy-MM-dd key, in UTC arithmetic: the same as the server's addDaysToDate. */
export function addDaysToKey(day: DayKey, days: number): DayKey {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The day keys in [from, to); none for a malformed window. */
export function daysInWindow(from: DayKey, to: DayKey): DayKey[] {
  if (!DAY_KEY.test(from) || !DAY_KEY.test(to)) return [];
  const out: DayKey[] = [];
  for (let d = from; d < to && out.length < MAX_WINDOW_DAYS; d = addDaysToKey(d, 1)) out.push(d);
  return out;
}

export function emptyStore(epoch = 0): CalendarStore {
  return { epoch, facts: null, days: {}, status: {}, lastFailure: {}, calendars: [], reconnect: null, unavailable: [], partner: null, carryOvers: null };
}

function factsOf(r: RangeResponse): StoreFacts {
  return {
    tz: r.tz,
    today: r.today,
    weekStart: r.weekStart,
    hebrewDates: r.hebrewDates,
    sources: SOURCE_ORDER.filter((s) => r.sources[s] !== undefined),
  };
}

/** The pinned facts: tz, today, week start and the sources. hebrewDates is not one of them. */
function samePinnedFacts(a: StoreFacts, b: StoreFacts): boolean {
  return a.tz === b.tz && a.today === b.today && a.weekStart === b.weekStart && a.sources.join() === b.sources.join();
}

function famcalFailure(s: FamcalStatus): SourceFailure | null {
  return s.status === 'error' ? { kind: 'error', source: 'famcal', reason: null } : null;
}

function googleFailure(s: GoogleStatus): SourceFailure | null {
  if (s.status === 'reconnect') return { kind: 'reconnect', source: 'google', reason: s.reason === 'scopes' ? 'scopes' : 'token' };
  if (s.status !== 'error') return null;
  if (s.reason === 'calendars_gone') return { kind: 'calendarsGone', source: 'google' };
  return { kind: 'error', source: 'google', reason: s.reason ?? null };
}

function isPartial(s: GoogleStatus): boolean {
  return s.status === 'ok' && !!s.partial && (s.partial.failed > 0 || s.partial.truncated > 0);
}

/** Deduped by key (the first one stays), then sorted with compareItems. A new array. */
function dedupeSorted(items: readonly ItemDTO[]): ItemDTO[] {
  const seen = new Set<string>();
  const out: ItemDTO[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out.sort(compareItems);
}

const failedCoverage = (failure: SourceFailure): DayCoverage => ({ ok: false, failed: true, partial: false, failure });

/** Merges an answer whose facts match `state.facts` (already pinned). */
function merge(state: CalendarStore, r: RangeResponse, hold?: ReadonlyMap<string, ItemReminderDTO>): CalendarStore {
  // An answer asked before a patch: its copy of a patched reminder is the older state.
  const held = (item: ItemDTO, place: 'carryOver' | 'today' | 'other'): ItemDTO => {
    const reminder = item.kind === 'reminder' ? hold?.get(item.key) : undefined;
    return reminder ? { ...item, reminder: patchedReminder(item.reminder, reminder, place) } : item;
  };
  const ok: SourceName[] = [];
  const failures: SourceFailure[] = [];
  const status = { ...state.status };
  let partial = false;
  const famcal = r.sources.famcal;
  if (famcal && famcal.status !== 'pending') {
    status.famcal = famcal;
    if (famcal.status === 'ok') ok.push('famcal');
    const f = famcalFailure(famcal);
    if (f) failures.push(f);
  }
  const google = r.sources.google;
  if (google && google.status !== 'pending') {
    status.google = google;
    if (google.status === 'ok') ok.push('google');
    partial = isPartial(google);
    const f = googleFailure(google);
    if (f) failures.push(f);
  }
  if (ok.length === 0 && failures.length === 0) {
    // Only pending sources: nothing to store (hebrewDates may still have moved).
    return state;
  }

  const lastFailure = { ...state.lastFailure };
  for (const f of failures) lastFailure[f.source] = f;

  const incoming = new Map<DayKey, readonly ItemDTO[]>();
  for (const d of r.days) incoming.set(d.date, d.items);
  const days: Record<DayKey, StoreDay> = { ...state.days };
  for (const date of daysInWindow(r.from, r.to)) {
    const prev = state.days[date];
    const coverage = { ...prev?.coverage };
    let items = prev ? prev.items : [];
    if (ok.length > 0) {
      // Only the ok sources' items are read from the answer, and only theirs are replaced.
      const kept = items.filter((i) => !ok.includes(i.source));
      const place = date === state.facts?.today ? 'today' : 'other';
      const fresh = (incoming.get(date) ?? NO_ITEMS).filter((i) => ok.includes(i.source)).map((i) => (hold ? held(i, place) : i));
      items = dedupeSorted([...kept, ...fresh]);
      for (const s of ok) coverage[s] = { ok: true, failed: false, partial: s === 'google' && partial, failure: null };
    }
    for (const f of failures) {
      if (!coverage[f.source]?.ok) coverage[f.source] = failedCoverage(f);
    }
    days[date] = { items, coverage };
  }

  const calendars =
    ok.length > 0
      ? SOURCE_ORDER.flatMap((s) => (ok.includes(s) ? r.calendars : state.calendars).filter((c) => c.source === s))
      : state.calendars;
  const partner = ok.includes('famcal') ? (r.partner ? { name: r.partner.name } : null) : state.partner;
  const carryOvers = r.carryOvers ? r.carryOvers.map((i) => (hold ? held(i, 'carryOver') : i)) : state.carryOvers;
  const reconnect = google?.status === 'reconnect' ? (google.reason === 'scopes' ? 'scopes' : 'token') : state.reconnect;
  const gone = ok.includes('google') ? r.calendars.filter((c) => c.source === 'google' && c.unavailable === true).map((c) => c.id) : [];
  const added = gone.filter((id, i) => !state.unavailable.includes(id) && gone.indexOf(id) === i);
  const unavailable = added.length > 0 ? [...state.unavailable, ...added] : state.unavailable;
  return { ...state, days, status, lastFailure, calendars, reconnect, unavailable, partner, carryOvers };
}

function receive(state: CalendarStore, r: RangeResponse, epoch: number, hold?: ReadonlyMap<string, ItemReminderDTO>): CalendarStore {
  const facts = factsOf(r);
  let base: CalendarStore;
  if (state.facts && samePinnedFacts(state.facts, facts)) {
    base = state.facts.hebrewDates === facts.hebrewDates ? state : { ...state, facts: { ...state.facts, hebrewDates: facts.hebrewDates } };
  } else if (epoch < state.epoch) {
    // Asked before the last drop, and its facts are not the store's: it is stale.
    return state;
  } else {
    // The first answer pins the facts; a mismatch drops the store and pins the new ones.
    base = { ...emptyStore(state.facts ? state.epoch + 1 : state.epoch), facts };
  }
  return merge(base, r, hold);
}

function markFailed(state: CalendarStore, a: Extract<StoreAction, { type: 'windowFailed' }>): CalendarStore {
  if (!state.facts || a.epoch < state.epoch) return state;
  const sources = state.facts.sources.filter((s) => a.sources.includes(s));
  if (sources.length === 0) return state;
  const failures = sources.map((s): SourceFailure => (a.kind === 'busy' ? { kind: 'busy', source: s } : { kind: 'error', source: s, reason: null }));
  const lastFailure = { ...state.lastFailure };
  for (const f of failures) lastFailure[f.source] = f;
  const days: Record<DayKey, StoreDay> = { ...state.days };
  for (const date of daysInWindow(a.from, a.to)) {
    const prev = state.days[date];
    const coverage = { ...prev?.coverage };
    for (const f of failures) {
      if (!coverage[f.source]?.ok) coverage[f.source] = failedCoverage(f);
    }
    days[date] = { items: prev ? prev.items : [], coverage };
  }
  return { ...state, days, lastFailure };
}

/**
 * A reminder's state after an action, for one copy of the item. The server's `open` is
 * for the occurrence as of now, the store's rules are per place: a done item is not
 * open; a carry-over is (it stays in the list, struck, until the next answer drops it);
 * a copy on today is open when the server says it is past due and undone; a copy on
 * another day never is. A snooze leaves a past-due item open.
 */
export function patchedReminder(prev: ItemReminderDTO | undefined, next: ItemReminderDTO, place: 'carryOver' | 'today' | 'other'): ItemReminderDTO {
  const open = !next.done && (place === 'carryOver' || (place === 'today' && next.open));
  const openSince = place === 'carryOver' ? (prev?.openSince ?? next.openSince) : place === 'today' ? next.openSince : (prev?.openSince ?? null);
  return { ...next, open, openSince };
}

function patchReminder(state: CalendarStore, key: string, reminder: ItemReminderDTO): CalendarStore {
  const today = state.facts?.today;
  const patch = (item: ItemDTO, place: 'carryOver' | 'today' | 'other'): ItemDTO =>
    item.key === key && item.kind === 'reminder' ? { ...item, reminder: patchedReminder(item.reminder, reminder, place) } : item;
  let changed = false;
  const days: Record<DayKey, StoreDay> = {};
  for (const [date, day] of Object.entries(state.days)) {
    if (!day.items.some((i) => i.key === key && i.kind === 'reminder')) {
      days[date] = day;
      continue;
    }
    changed = true;
    days[date] = { ...day, items: day.items.map((i) => patch(i, date === today ? 'today' : 'other')) };
  }
  let carryOvers = state.carryOvers;
  if (carryOvers?.some((i) => i.key === key && i.kind === 'reminder')) {
    changed = true;
    carryOvers = carryOvers.map((i) => patch(i, 'carryOver'));
  }
  return changed ? { ...state, days, carryOvers } : state;
}

/** The reducer. It never changes `state` or the answer; an action that changes nothing returns `state` itself. */
export function reduceStore(state: CalendarStore, action: StoreAction): CalendarStore {
  switch (action.type) {
    case 'reset':
      return emptyStore(state.epoch + 1);
    case 'response':
      return receive(state, action.response, action.epoch, action.hold);
    case 'windowFailed':
      return markFailed(state, action);
    case 'patchReminder':
      return patchReminder(state, action.key, action.reminder);
  }
}

/** A day's items, every applicable source's, sorted with compareItems. */
export function dayItems(state: CalendarStore, day: DayKey): readonly ItemDTO[] {
  return state.days[day]?.items ?? NO_ITEMS;
}

/**
 * Whether a day may read as empty: `answered` once every applicable source answered ok
 * for it (partial included), now or earlier; `loading` while one has not answered yet;
 * `failed` when the rest failed (error, reconnect, a failed request) with no ok data.
 */
export function dayStatus(state: CalendarStore, day: DayKey): DayStatus {
  if (!state.facts) return 'loading';
  const coverage = state.days[day]?.coverage ?? {};
  let failed = false;
  for (const s of state.facts.sources) {
    const c = coverage[s];
    if (c?.ok) continue;
    if (c?.failed) {
      failed = true;
      continue;
    }
    return 'loading';
  }
  return failed ? 'failed' : 'answered';
}

/** The applicable sources that failed on a day with no ok data, in SOURCE_ORDER. */
export function failedSources(state: CalendarStore, day: DayKey): SourceName[] {
  if (!state.facts) return [];
  const coverage = state.days[day]?.coverage ?? {};
  return state.facts.sources.filter((s) => !coverage[s]?.ok && coverage[s]?.failed === true);
}

/**
 * Why `source` has no data for `day`: the failure that marked the day, the latest one
 * that covered it. null when the source answered ok for it or nothing has covered it.
 */
export function dayFailure(state: CalendarStore, day: DayKey, source: SourceName): SourceFailure | null {
  return state.days[day]?.coverage[source]?.failure ?? null;
}

/** Whether the day's Google data came from a partial answer. */
export function isPartialDay(state: CalendarStore, day: DayKey): boolean {
  const c = state.days[day]?.coverage.google;
  return !!c?.ok && c.partial;
}

/** The banners' inputs. Both hold for the epoch (see the header): a store drop clears them. */
export function homeNotices(state: CalendarStore): HomeNotices {
  return { reconnect: state.reconnect, unavailableCalendars: state.unavailable.length };
}
