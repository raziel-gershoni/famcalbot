// RRULE expansion for native calendar events.
//
// A NativeEvent can be:
//   - single occurrence (rrule = null)
//   - a recurring series (rrule = RFC-5545 string, optional exdates[])
//
// Per-occurrence customizations live in NativeEventInstance rows (status =
// OVERRIDE for modified, CANCELLED for skipped). Series-level cancellations
// can also live in NativeEvent.exdates[] (cheaper, no row).
//
// expandSeries computes "virtual instances" for a date range, applying overrides
// and exdates. Callers feed the result into UnifiedEvent shape via toUnifiedEvent.

import { RRule, RRuleSet } from 'rrule';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { HDate, getBirthdayOrAnniversary, getYahrzeit } from '@hebcal/hdate';
import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import { TIMEZONE } from '../../config/constants';
import { captureError } from '../../lib/error-capture';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';

export interface VirtualInstance {
  // Identity
  seriesEventId: string;
  // For recurring: the *original* (un-overridden) start of this occurrence;
  // for non-recurring: equals startsAt. Used as the recurrence-id when editing
  // a single instance.
  instanceStartsAt: Date;
  // Effective fields (overrides applied)
  title: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timeZone: string;
  // Whether this is one occurrence of a recurring series (vs a one-off event)
  isRecurringInstance: boolean;
  // Whether this occurrence has an OVERRIDE row (non-default fields)
  isOverridden: boolean;
}

/**
 * Read a date-only UNTIL as the end of that day. The bot writes "until the 20th"
 * as UNTIL=20261020 (calendar.ts buildRecurrenceRule), which rrule takes as 00:00
 * on the 20th in the floating time expansion runs in, so a timed series lost its
 * last day. Done when the rule is read, so rules already stored are fixed too. A
 * date-time UNTIL, as truncateRruleBefore writes it, is left alone.
 */
function withInclusiveUntil(rule: string): string {
  return rule.replace(/(^|;)UNTIL=(\d{8})(?=;|$)/, '$1UNTIL=$2T235959');
}

/**
 * Parse an RRULE string into an RRuleSet, anchored at a dtstart.
 * Accepts either a bare rule like "FREQ=WEEKLY;BYDAY=MO" or one with the
 * "RRULE:" prefix. Building via RRule.parseString + the constructor (rather
 * than rrulestr with a `dtstart` option) is the only way to reliably anchor
 * occurrences at the series's actual start time — `rrulestr` ignores the
 * `dtstart` option when the RRULE string doesn't include its own DTSTART.
 */
function buildRuleSet(rrule: string, dtstart: Date): RRuleSet {
  const trimmed = rrule.startsWith('RRULE:') ? rrule.slice('RRULE:'.length) : rrule;
  const opts = RRule.parseString(withInclusiveUntil(trimmed));
  const rule = new RRule({ ...opts, dtstart });
  const set = new RRuleSet();
  set.rrule(rule);
  return set;
}

/**
 * Carry an instant's wall-clock reading in `tz` inside a Date's UTC fields.
 * "Floating" time in RFC-5545 terms: 08:00 local becomes 08:00Z regardless of
 * the real offset, which is the only representation in which a weekly rule
 * keeps a constant local time across a DST transition.
 */
function toFloating(instant: Date, tz: string): Date {
  return new Date(`${formatInTimeZone(instant, tz, "yyyy-MM-dd'T'HH:mm:ss")}Z`);
}

/** Inverse of toFloating: re-anchor a wall clock in `tz` to a real instant. */
function fromFloating(floating: Date, tz: string): Date {
  return fromZonedTime(floating.toISOString().slice(0, 19), tz);
}

/**
 * Where an occurrence lands when its series moves as `from` (an occurrence's slot) moved
 * to `to`: the same shift on the wall clock in `tz`, so 10:00 moved to 09:00 is 09:00 on
 * every later day too, across a DST change. A "this one and the ones after" split keys
 * what it carries over to its new series this way.
 */
export function shiftOnWall(instant: Date, from: Date, to: Date, tz: string): Date {
  const zone = tz || TIMEZONE;
  const shiftMs = toFloating(to, zone).getTime() - toFloating(from, zone).getTime();
  return fromFloating(new Date(toFloating(instant, zone).getTime() + shiftMs), zone);
}

/**
 * Compute the duration of a series's default occurrence (endsAt - startsAt).
 * Used to derive end times for instances when the override doesn't specify one.
 */
function defaultDurationMs(series: NativeEvent): number {
  return series.endsAt.getTime() - series.startsAt.getTime();
}

/**
 * The end of an occurrence starting at `start` when no override sets one. A timed
 * occurrence keeps the series's length. An all-day one keeps its wall-clock span
 * (the bot saves 00:00 to 23:59 local on the last day): a fixed length would run
 * an hour past midnight on a 23-hour DST day, into the next day's fetch.
 */
function defaultEnd(series: NativeEvent, start: Date): Date {
  if (!series.allDay) return new Date(start.getTime() + defaultDurationMs(series));
  const tz = series.timeZone || TIMEZONE;
  const spanMs = toFloating(series.endsAt, tz).getTime() - toFloating(series.startsAt, tz).getTime();
  return fromFloating(new Date(toFloating(start, tz).getTime() + spanMs), tz);
}

/**
 * Whether an occurrence belongs to a fetch window: it overlaps [from, to), the
 * way Google's events.list decides it, so an event from Monday 22:00 to Tuesday
 * 02:00 is in both days' windows. One that starts inside the window always
 * counts, whatever its end says, as it did before.
 */
function overlapsRange(start: Date, end: Date, range: { from: Date; to: Date }): boolean {
  return start < range.to && (start >= range.from || end > range.from);
}

/**
 * Apply overrides + exdates to a single occurrence start time. Returns a
 * VirtualInstance, or undefined if this occurrence is cancelled.
 */
function buildInstance(
  series: NativeEvent,
  occurrenceStart: Date,
  overrideMap: Map<number, NativeEventInstance>
): VirtualInstance | undefined {
  // Series-level skip
  if (series.exdates.some((d) => d.getTime() === occurrenceStart.getTime())) {
    return undefined;
  }

  const override = overrideMap.get(occurrenceStart.getTime());

  if (override?.status === 'CANCELLED') {
    return undefined;
  }

  if (override?.status === 'OVERRIDE') {
    const startsAt = override.startsAt ?? occurrenceStart;
    const endsAt = override.endsAt ?? defaultEnd(series, startsAt);

    return {
      seriesEventId: series.id,
      instanceStartsAt: occurrenceStart,
      title: override.title ?? series.title,
      description: override.description ?? series.description ?? undefined,
      location: override.location ?? series.location ?? undefined,
      startsAt,
      endsAt,
      allDay: override.allDay ?? series.allDay,
      timeZone: series.timeZone,
      isRecurringInstance: true,
      isOverridden: true,
    };
  }

  // No override, use series defaults shifted to this occurrence
  const occurrenceEnd = defaultEnd(series, occurrenceStart);
  return {
    seriesEventId: series.id,
    instanceStartsAt: occurrenceStart,
    title: series.title,
    description: series.description ?? undefined,
    location: series.location ?? undefined,
    startsAt: occurrenceStart,
    endsAt: occurrenceEnd,
    allDay: series.allDay,
    timeZone: series.timeZone,
    isRecurringInstance: true,
    isOverridden: false,
  };
}

/**
 * Expand a NativeEvent (single or recurring) into virtual instances within a
 * date range: every instance that overlaps the half-open [from, to), with
 * overrides applied. An instance starting at exactly `to`, or ending at exactly
 * `from`, is excluded.
 */
export function expandSeries(
  event: NativeEvent,
  range: { from: Date; to: Date },
  overrides: NativeEventInstance[] = []
): VirtualInstance[] {
  // Build a fast lookup keyed by the override's originalStartsAt timestamp
  const overrideMap = new Map<number, NativeEventInstance>();
  for (const o of overrides) {
    overrideMap.set(o.originalStartsAt.getTime(), o);
  }

  // Non-recurring: at most one instance
  if (!event.rrule) {
    if (!overlapsRange(event.startsAt, event.endsAt, range)) return [];
    const instance = buildInstance(event, event.startsAt, overrideMap);
    return instance ? [{ ...instance, isRecurringInstance: false }] : [];
  }

  // Recurring: enumerate the occurrences that overlap [from, to).
  //
  // Expansion runs in floating local time and each occurrence is re-anchored to
  // a real instant through the event's own timezone. Anchoring the rule at the
  // stored UTC instant instead holds the UTC time-of-day constant, which walks
  // the local clock by an hour at every DST transition — a weekly 08:00 event
  // silently becomes 07:00. Verified against rrule 2.8.1. Note that rrule's own
  // `tzid` option does NOT fix this: it expects a floating dtstart, so handing
  // it a real instant makes it a no-op.
  const tz = event.timeZone || TIMEZONE;

  // Reach back by the series's length too, so an occurrence that started before
  // the window but is still running in it (Monday 22:00 to Tuesday 02:00, on
  // Tuesday) is a candidate. Widen the floating window by a further day either
  // side so an occurrence sitting near a DST boundary can't be trimmed by the
  // offset shift, then filter exactly below. `between(after, before, inc=true)`
  // is inclusive at both ends; the overlap filter restores the half-open window.
  const PAD_MS = 24 * 60 * 60 * 1000;
  const reachBackMs = Math.max(0, defaultDurationMs(event)) + PAD_MS;
  // A Hebrew series never reaches the rrule library: its days come from hebcal
  // (hebrew-repeats spec §3), and then go through the same filters as any other.
  const candidates = event.hebrewRule
    ? hebrewCandidates(hebrewSeriesOf(event), {
        from: new Date(range.from.getTime() - reachBackMs),
        to: new Date(range.to.getTime() + PAD_MS),
      })
    : buildRuleSet(event.rrule, toFloating(event.startsAt, tz))
        .between(
          new Date(toFloating(range.from, tz).getTime() - reachBackMs),
          new Date(toFloating(range.to, tz).getTime() + PAD_MS),
          true
        )
        .map((floating) => fromFloating(floating, tz));

  // Filter on the instance as overridden, not the original slot: an occurrence
  // moved to Tuesday shows on Tuesday, not on the Monday it was moved off.
  const instances: VirtualInstance[] = [];
  for (const start of candidates) {
    const inst = buildInstance(event, start, overrideMap);
    if (inst && overlapsRange(inst.startsAt, inst.endsAt, range)) instances.push(inst);
  }

  // Overrides whose original occurrence is too far away to be a candidate can
  // still land in the window - moved into it, or lengthened into it. Render any
  // of those whose effective instance overlaps the window; the ones that were
  // candidates were already decided above.
  const candidateStarts = new Set(candidates.map((d) => d.getTime()));
  for (const o of overrides) {
    if (candidateStarts.has(o.originalStartsAt.getTime())) continue;
    if (o.status === 'CANCELLED') continue;
    const inst = buildInstance(event, o.originalStartsAt, overrideMap);
    if (inst && overlapsRange(inst.startsAt, inst.endsAt, range)) instances.push(inst);
  }

  // Sort by effective start time
  instances.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return instances;
}

/**
 * How far back latestOccurrenceBefore looks, in days, widening a step at a time:
 * a daily series is found in the first window, a yearly one by the fourth, and
 * one that ended years ago by the last.
 */
const LOOKBACK_STEPS_DAYS = [2, 14, 62, 400, 4000];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The occurrence with the latest effective start strictly before `at`, or null.
 * Exdates, CANCELLED and moved OVERRIDEs apply as in expandSeries: an occurrence
 * moved past `at` doesn't count, and a later one moved before it does, keyed by
 * its original slot. A digest uses it for a repeating reminder's last occurrence
 * before its cutoff ("open since").
 */
export function latestOccurrenceBefore(
  event: NativeEvent,
  overrides: NativeEventInstance[],
  at: Date
): VirtualInstance | null {
  if (!event.rrule) {
    // A one-off has one occurrence; its effective start decides, as for a series.
    const [only] = expandSeries(event, { from: event.startsAt, to: at }, overrides);
    return only && only.startsAt < at ? only : null;
  }

  // Nothing starts before the series except an occurrence moved there, such as a
  // first occurrence moved earlier: the search goes back to that too.
  const earliest = overrides.reduce(
    (min, o) => (o.status === 'OVERRIDE' && o.startsAt && o.startsAt < min ? o.startsAt : min),
    event.startsAt
  );
  for (const days of LOOKBACK_STEPS_DAYS) {
    const from = new Date(at.getTime() - days * DAY_MS);
    // Only occurrences that start in [from, at). One that started earlier and is
    // still running at `from` may not be the latest; a wider window decides it.
    const started = expandSeries(event, { from, to: at }, overrides).filter((i) => i.startsAt >= from);
    if (started.length > 0) return started[started.length - 1];
    // The window already reaches the series' first occurrence, and any moved before it.
    if (from <= earliest) break;
  }
  return null;
}

/**
 * Whether a stored rule names its days (BYDAY, BYMONTHDAY, BYMONTH, as the bot's rules
 * do): its occurrences fall on those days wherever the series starts, so moving one
 * occurrence to another day can't take the others with it.
 */
export function fixesDays(rrule: string | null): boolean {
  return rrule !== null && /(^|[;:])BY(DAY|MONTHDAY|MONTH|YEARDAY|WEEKNO)=/i.test(rrule);
}

/**
 * Which of `slots` a series' rule yields, its exdates and overrides aside, as getTime()s.
 * What was skipped or renamed is carried to a moved series only where the series still
 * has an occurrence: a monthly series moved from the 30th to the 31st has no 1 May.
 */
export function yieldsSlots(series: NativeEvent, slots: readonly Date[]): Set<number> {
  if (slots.length === 0 || !series.rrule) return new Set();
  const times = slots.map((d) => d.getTime());
  const range = { from: new Date(Math.min(...times)), to: new Date(Math.max(...times) + 1) };
  const made = new Set(expandSeries({ ...series, exdates: [] }, range, []).map((i) => i.instanceStartsAt.getTime()));
  return new Set(times.filter((t) => made.has(t)));
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** A Date's UTC fields as an RRULE date-time, YYYYMMDDTHHMMSS. */
const ruleDateTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').slice(0, 15);

/**
 * A rule's UNTIL moved as its series moved, `from` to `to` on the wall clock, so the
 * series keeps its last occurrence (and one cut off by "this one and the ones after",
 * moved earlier, gains none on the cut's day). A date-time UNTIL moves as expansion reads
 * it, as wall time (floating, with a Z or without), so a move across a DST change keeps
 * the same last occurrence; a date-only one moves by the days alone; a COUNT, or no end,
 * is left as it is.
 */
export function shiftUntil(rrule: string, from: Date, to: Date, timeZone: string): string {
  const m = /(^|;)UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?(?=;|$)/.exec(rrule);
  if (!m) return rrule;
  const zone = timeZone || TIMEZONE;
  const [whole, lead, y, mo, d, h, mi, se, z] = m;
  const shiftMs = toFloating(to, zone).getTime() - toFloating(from, zone).getTime();
  let until: string;
  if (h === undefined) {
    const days = Math.round((Date.parse(`${formatInTimeZone(to, zone, 'yyyy-MM-dd')}T00:00:00Z`) - Date.parse(`${formatInTimeZone(from, zone, 'yyyy-MM-dd')}T00:00:00Z`)) / 86_400_000);
    const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d) + days));
    until = `${day.getUTCFullYear()}${pad2(day.getUTCMonth() + 1)}${pad2(day.getUTCDate())}`;
  } else {
    // The stamp's fields are its wall time: expansion compares it with floating occurrences.
    const stamp = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
    until = `${ruleDateTime(new Date(stamp.getTime() + shiftMs))}${z}`;
  }
  return rrule.replace(whole, `${lead}UNTIL=${until}`);
}

/**
 * Truncate a recurring series' RRULE so it ends before a given instance.
 * Used for scope=following edits/deletes — caller updates NativeEvent.rrule
 * with the returned string.
 *
 * Strategy: strip any existing UNTIL/COUNT and append an UNTIL set one second
 * before the targeted occurrence, expressed in the same floating local space
 * expandSeries works in.
 *
 * The earlier form used UNTIL=<instanceDate-1 day> as a bare YYYYMMDD, which
 * rrule reads as the previous midnight — so a timed series lost an extra
 * occurrence. Cutting a daily 08:00 series at 2026-09-20 produced
 * UNTIL=20260919 and dropped the 08:00 event on the 19th as well.
 *
 * The UNTIL is deliberately floating rather than UTC: expansion is anchored in
 * the event's local time, and this string is only ever read back by
 * expandSeries. It would need converting to a UTC `Z` form to be RFC-5545
 * conformant for export.
 */
export function truncateRruleBefore(rrule: string, instanceDate: Date, timeZone: string): string {
  const justBefore = toFloating(new Date(instanceDate.getTime() - 1000), timeZone || TIMEZONE);
  // YYYYMMDDTHHMMSS
  const untilStr = justBefore.toISOString().replace(/[-:]/g, '').slice(0, 15);

  const trimmed = rrule.startsWith('RRULE:') ? rrule.slice(6) : rrule;
  const parts = trimmed
    .split(';')
    .filter((p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='));
  parts.push(`UNTIL=${untilStr}`);
  return parts.join(';');
}

/**
 * A rule the store won't keep (3b spec §3.1): one that doesn't parse, has a part the app
 * can't expand safely, or an INTERVAL or COUNT below 1 (a negative INTERVAL hangs the
 * rrule library). event-store re-exports it; it lives here so the check needs no cycle.
 */
export class NativeRuleError extends Error {
  constructor(message = 'This repeat rule cannot be stored') {
    super(message);
    this.name = 'NativeRuleError';
  }
}

const RULE_PREFIX = 'RRULE:';
const bare = (rule: string) => (rule.startsWith(RULE_PREFIX) ? rule.slice(RULE_PREFIX.length) : rule);

// ---- Hebrew-date repeats (hebrew-repeats spec §2, §3) ----
//
// A Hebrew series stores a plain FREQ=YEARLY rule (at most INTERVAL, UNTIL or COUNT), so
// every check that only asks "is this a series" keeps working, and next to it the pair:
// hebrewRule, the kind, and hebrewAnchor, the anchor's civil date in the series' zone. Its
// occurrence k (from the anchor, 0-based) is in Hebrew year Y0 + k * INTERVAL, Y0 being the
// anchor's; the day comes from hebcal: getBirthdayOrAnniversary for 'anniversary',
// getYahrzeit for 'yahrzeit'. Days are daytime dates, with no sunset shift (the home's rule).

/** The two Hebrew kinds: every year on the Hebrew date (hebcal's birthday rules), or a yahrzeit. */
export type HebrewRule = 'anniversary' | 'yahrzeit';
export const isHebrewRule = (value: unknown): value is HebrewRule => value === 'anniversary' || value === 'yahrzeit';

/** What the Hebrew expander reads of a series. */
export interface HebrewSeries {
  startsAt: Date;
  timeZone: string | null;
  rrule: string;
  hebrewRule: HebrewRule;
  hebrewAnchor: string;
}

/** A series' Hebrew columns, as the rule helpers take them (absent or null: a Gregorian rule). */
export interface HebrewColumns {
  hebrewRule?: string | null;
  hebrewAnchor?: string | null;
}

/** Whether `day` is a real yyyy-MM-dd. */
function isCivilDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/** A civil day's Hebrew date, read off a Date at local midnight as hebcal reads one (hebrew-date.ts does the same). */
function hebrewDateOf(day: string): HDate {
  const [y, m, d] = day.split('-').map(Number);
  return new HDate(new Date(y, m - 1, d));
}

/** The civil day of a Date at local midnight (what hebcal returns), from its local getters, never toISOString. */
const civilDayOf = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** A series' Hebrew fields checked: NativeRuleError for a kind, rule or anchor the app can't read. */
export function hebrewSeriesOf(series: { startsAt: Date; timeZone: string | null; rrule: string | null } & HebrewColumns): HebrewSeries {
  if (!isHebrewRule(series.hebrewRule)) throw new NativeRuleError(`Hebrew repeat kind not supported: ${String(series.hebrewRule)}`);
  if (!series.rrule) throw new NativeRuleError('A Hebrew repeat has no yearly rule');
  if (!series.hebrewAnchor || !isCivilDay(series.hebrewAnchor)) throw new NativeRuleError('A Hebrew repeat anchor is not a date');
  return { startsAt: series.startsAt, timeZone: series.timeZone, rrule: series.rrule, hebrewRule: series.hebrewRule, hebrewAnchor: series.hebrewAnchor };
}

/**
 * A Hebrew series' slots by index from its anchor: `at(j)` is slot j's instant (the anchor's
 * wall-clock time, read off startsAt in the series' zone, on that year's day there); `first`
 * is the first slot at or after startsAt (a tail's anchor year can precede its start, and
 * what comes before is not the series'); `last` is the last slot its COUNT or UNTIL admits
 * (Infinity with no end, below `first` when none is left). A COUNT counts from `first`.
 */
function hebrewPlan(series: HebrewSeries): { at: (j: number) => Date | null; first: number; last: number; anchorYear: number; interval: number; zone: string } {
  const zone = series.timeZone || TIMEZONE;
  let opts: ReturnType<typeof RRule.parseString>;
  try {
    opts = RRule.parseString(withInclusiveUntil(bare(series.rrule)));
  } catch (error) {
    throw new NativeRuleError(`Unreadable repeat rule: ${error instanceof Error ? error.message : String(error)}`);
  }
  const interval = opts.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) throw new NativeRuleError('Repeat rule interval must be a whole number of at least 1');
  const anchor = hebrewDateOf(series.hebrewAnchor);
  const anchorYear = anchor.getFullYear();
  const month = anchor.getMonth();
  const date = anchor.getDate();
  // To the millisecond: a start with a sub-second part would otherwise put slot 0 just before it.
  const wall = formatInTimeZone(series.startsAt, zone, 'HH:mm:ss.SSS');
  const dayIn = series.hebrewRule === 'yahrzeit' ? getYahrzeit : getBirthdayOrAnniversary;
  const slots = new Map<number, Date | null>();
  const at = (j: number): Date | null => {
    if (j < 0) return null;
    if (!slots.has(j)) {
      // The anchor year is the anchor itself, for both kinds: hebcal gives nothing there for a
      // yahrzeit. getYahrzeit writes to the date it is given, so each call gets a fresh one.
      const found = j === 0 ? null : dayIn(anchorYear + j * interval, { yy: anchorYear, mm: month, dd: date });
      const day = j === 0 ? series.hebrewAnchor : found ? civilDayOf(found) : null;
      slots.set(j, day ? fromZonedTime(`${day}T${wall}`, zone) : null);
    }
    return slots.get(j)!;
  };
  // Slots grow one Hebrew year (or INTERVAL of them) at a time, so the first one at or after
  // the start is a step or two past the one before the start's own Hebrew year.
  const startYear = hebrewDateOf(localDate(series.startsAt, zone)).getFullYear();
  let first = Math.max(0, Math.floor((startYear - anchorYear) / interval) - 1);
  for (let tries = 0; ; tries++) {
    const slot = at(first);
    if (slot && slot >= series.startsAt) break;
    if (tries > 8) throw new NativeRuleError('A Hebrew repeat has no occurrence at or after its start');
    first++;
  }
  let last = opts.count != null ? first + opts.count - 1 : Infinity;
  if (opts.until) {
    // The UNTIL's fields are a wall time (a date-only one is 23:59:59): compared with each
    // slot's floating wall time, never its instant.
    const until = opts.until;
    let j = Math.floor((hebrewDateOf(until.toISOString().slice(0, 10)).getFullYear() - anchorYear) / interval) + 1;
    for (;;) {
      if (j < first) break;
      const slot = at(j);
      if (slot && toFloating(slot, zone) <= until) break;
      j--;
    }
    last = Math.min(last, j);
  }
  return { at, first, last, anchorYear, interval, zone };
}

/**
 * A Hebrew series' slots (instants, exdates and overrides aside) in the Hebrew years
 * `window` touches, padded by one Hebrew year each side: the years are picked by arithmetic,
 * so a window far from the start counts COUNT right. expandSeries filters them exactly.
 */
export function hebrewCandidates(series: HebrewSeries, window: { from: Date; to: Date }): Date[] {
  const plan = hebrewPlan(series);
  const yearOf = (d: Date) => hebrewDateOf(localDate(d, plan.zone)).getFullYear();
  const lo = Math.max(plan.first, Math.ceil((yearOf(window.from) - 1 - plan.anchorYear) / plan.interval));
  const hi = Math.min(plan.last, Math.floor((yearOf(window.to) + 1 - plan.anchorYear) / plan.interval));
  const out: Date[] = [];
  for (let j = lo; j <= hi; j++) {
    const slot = plan.at(j);
    if (slot) out.push(slot);
  }
  return out;
}

/** The Hebrew year a plan gives `slot` for (its anchor year plus j steps), or null when `slot` is none of its slots. */
function planYearOf(plan: ReturnType<typeof hebrewPlan>, slot: Date): number | null {
  // A slot falls in its own Hebrew year (a rolled day stays in it: 30 Cheshvan to 1 Kislev).
  const near = Math.round((hebrewDateOf(localDate(slot, plan.zone)).getFullYear() - plan.anchorYear) / plan.interval);
  for (const j of [near, near - 1, near + 1]) {
    if (plan.at(j)?.getTime() === slot.getTime()) return plan.anchorYear + j * plan.interval;
  }
  return null;
}

/**
 * Where a Hebrew series' slots go when it becomes `to` (another Hebrew series): each to `to`'s
 * slot in the same Hebrew year, counted from `ref` (a slot of `from` and where it went in
 * `to`; without, the anchors stand for each other). A day move on the wall clock would put a
 * rolled year one day off (30 Cheshvan moved to 1 Kislev leaves the years with no 30 Cheshvan
 * where they were). The function gives null for a slot that is not one of `from`'s, or a year
 * `to` has no slot in; null in place of the function when `ref` is not a slot pair.
 */
export function hebrewSlotMap(from: HebrewSeries, to: HebrewSeries, ref?: { from: Date; to: Date }): ((slot: Date) => Date | null) | null {
  const old = hebrewPlan(from);
  const next = hebrewPlan(to);
  let years = next.anchorYear - old.anchorYear;
  if (ref) {
    const was = planYearOf(old, ref.from);
    const is = planYearOf(next, ref.to);
    if (was === null || is === null) return null;
    years = is - was;
  }
  return (slot) => {
    const year = planYearOf(old, slot);
    if (year === null) return null;
    const k = (year + years - next.anchorYear) / next.interval;
    return Number.isInteger(k) ? next.at(k) : null;
  };
}

/** The last slot of a Hebrew series that ends (UNTIL or COUNT), or null. */
function hebrewLastSlot(series: HebrewSeries): Date | null {
  const plan = hebrewPlan(series);
  return Number.isFinite(plan.last) && plan.last >= plan.first ? plan.at(plan.last) : null;
}

/** The parts a stored rule may have, as RRule.parseString names them. */
const STORABLE_PARTS = new Set(['freq', 'interval', 'byweekday', 'bymonthday', 'bymonth', 'until', 'count', 'wkst']);
const STORABLE_FREQS: readonly number[] = [RRule.DAILY, RRule.WEEKLY, RRule.MONTHLY, RRule.YEARLY];
/** The parts a Hebrew rule may have besides FREQ=YEARLY: no BY part, so fixesDays stays false. */
const HEBREW_PARTS = new Set(['freq', 'interval', 'until', 'count']);

/**
 * Throw NativeRuleError unless `rule` (bare, or with an RRULE: prefix) is one every reader
 * can expand: it parses, its parts are within freq, interval, byweekday, bymonthday,
 * bymonth, until, count and wkst, its FREQ is daily to yearly, and INTERVAL and COUNT,
 * when present, are whole numbers of at least 1, each BYDAY is a weekday (with an ordinal of
 * ±1..53 or none), each BYMONTHDAY ±1..31 and each BYMONTH 1..12. Checked on the parsed
 * options, so a prefix or the order of the parts doesn't matter.
 *
 * With `hebrewRule` (hebrew-repeats spec §2), both ways: a kind is 'anniversary' or
 * 'yahrzeit' and needs a rule, which is FREQ=YEARLY with at most INTERVAL, UNTIL or COUNT;
 * no rule (null) takes no kind.
 */
export function assertStorableRule(rule: string | null, hebrewRule?: string | null): void {
  if (hebrewRule !== undefined && hebrewRule !== null && !isHebrewRule(hebrewRule)) {
    throw new NativeRuleError(`Hebrew repeat kind not supported: ${String(hebrewRule)}`);
  }
  if (rule === null) {
    if (hebrewRule) throw new NativeRuleError('A Hebrew repeat needs a yearly rule');
    return;
  }
  let opts: Record<string, unknown>;
  try {
    opts = RRule.parseString(withInclusiveUntil(bare(rule))) as Record<string, unknown>;
  } catch (error) {
    throw new NativeRuleError(`Unreadable repeat rule: ${error instanceof Error ? error.message : String(error)}`);
  }
  const extra = Object.keys(opts).find((k) => !STORABLE_PARTS.has(k));
  if (extra) throw new NativeRuleError(`Repeat rule part not supported: ${extra}`);
  if (typeof opts.freq !== 'number' || !STORABLE_FREQS.includes(opts.freq)) throw new NativeRuleError('Repeat rule frequency not supported');
  if (hebrewRule) {
    if (opts.freq !== RRule.YEARLY) throw new NativeRuleError('A Hebrew repeat is yearly');
    const part = Object.keys(opts).find((k) => !HEBREW_PARTS.has(k));
    if (part) throw new NativeRuleError(`A Hebrew repeat cannot have ${part}`);
  }
  for (const part of ['interval', 'count'] as const) {
    if (part in opts && !(Number.isInteger(opts[part]) && (opts[part] as number) >= 1)) {
      throw new NativeRuleError(`Repeat rule ${part} must be a whole number of at least 1`);
    }
  }
  // parseString takes a BY value it can't read (BYDAY=tu, BYMONTHDAY=0) and leaves a hole or
  // a value no date has, which throws on every expansion or yields nothing, so each is checked.
  const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
  const whole = (v: unknown, ok: (n: number) => boolean) => typeof v === 'number' && Number.isInteger(v) && ok(v);
  const weekday = (v: unknown) => {
    if (whole(v, (n) => n >= 0 && n <= 6)) return true;
    if (!v || typeof v !== 'object') return false;
    const { weekday: day, n } = v as { weekday?: unknown; n?: unknown };
    return whole(day, (d) => d >= 0 && d <= 6) && (n === undefined || whole(n, (k) => k !== 0 && Math.abs(k) <= 53));
  };
  const valid: Record<string, (v: unknown) => boolean> = {
    byweekday: weekday,
    bymonthday: (v) => whole(v, (n) => n !== 0 && Math.abs(n) <= 31),
    bymonth: (v) => whole(v, (n) => n >= 1 && n <= 12),
  };
  for (const [part, ok] of Object.entries(valid)) {
    if (part in opts && !listOf(opts[part]).every(ok)) throw new NativeRuleError(`Repeat rule ${part} has a value no date has`);
  }
}

/**
 * The last slot of a rule that ends (UNTIL or COUNT), exdates aside, or null. Capped, so a
 * huge COUNT can't run away. A Hebrew rule's (with `hebrew`'s pair) is its last Hebrew slot.
 */
function lastSlot(rule: string, start: Date, zone: string, hebrew?: HebrewColumns | null): Date | null {
  if (hebrew?.hebrewRule) return hebrewLastSlot(hebrewSeriesOf({ startsAt: start, timeZone: zone, rrule: rule, ...hebrew }));
  const tz = zone || TIMEZONE;
  let last: Date | null = null;
  buildRuleSet(rule, toFloating(start, tz)).all((date, i) => {
    if (i >= 100_000) return false;
    last = date;
    return true;
  });
  return last ? fromFloating(last, tz) : null;
}

/**
 * What the editor's Repeat row calls a stored rule: one of its five, a Hebrew kind ('hebrew'
 * every year on the Hebrew date, 'yahrzeit'), or 'custom' (3b spec §2.1, hebrew-repeats §3).
 */
export type RuleChoice = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'hebrew' | 'yahrzeit' | 'custom';
const CHOICE_OF_FREQ: Record<number, RuleChoice> = {
  [RRule.DAILY]: 'daily',
  [RRule.WEEKLY]: 'weekly',
  [RRule.MONTHLY]: 'monthly',
  [RRule.YEARLY]: 'yearly',
};
/** The BY parts each choice may name, each only as its start's own value. */
const CHOICE_PARTS: Record<string, readonly string[]> = {
  daily: [],
  weekly: ['byweekday'],
  monthly: ['bymonthday'],
  yearly: ['bymonth', 'bymonthday'],
};
const asList = (v: unknown): unknown[] => ([] as unknown[]).concat(v);

/**
 * How the editor names a stored rule (3b spec §2.1), read on the item's own start in its
 * zone. One of the five when its FREQ matches, its INTERVAL is 1 or absent, its BY parts
 * are only those that choice means and each equals the start's own (the start's weekday
 * for weekly, its day of the month for monthly, its month and day for yearly), and it has
 * no other part (WKST aside). Anything else, an unreadable rule included, is 'custom'.
 * A rule with an end (UNTIL or COUNT) has `until`, the start of its last slot.
 */
export function classifyRule(rule: string | null, start: Date, zone: string, hebrew?: HebrewColumns | null): { choice: RuleChoice; until?: Date } {
  if (!rule) return { choice: 'none' };
  const tz = zone || TIMEZONE;
  let opts: Record<string, unknown>;
  try {
    opts = RRule.parseString(withInclusiveUntil(bare(rule))) as Record<string, unknown>;
  } catch (error) {
    captureError(error, 'native-rule-classify', {}, 'warning');
    return { choice: 'custom' };
  }
  const ends = opts.until != null || opts.count != null;
  let until: Date | undefined;
  if (ends) {
    try {
      until = lastSlot(rule, start, tz, hebrew) ?? undefined;
    } catch (error) {
      captureError(error, 'native-rule-classify', {}, 'warning');
    }
  }
  const withEnd = (choice: RuleChoice) => (until ? { choice, until } : { choice });
  // A Hebrew rule is its kind only with INTERVAL 1 or absent and nothing else besides its end
  // (hebrew-repeats spec §3); "every 2 years on 15 Shvat" is custom.
  if (hebrew?.hebrewRule) {
    const plain = opts.freq === RRule.YEARLY && (opts.interval === undefined || opts.interval === 1)
      && Object.keys(opts).every((k) => HEBREW_PARTS.has(k));
    if (!plain || !isHebrewRule(hebrew.hebrewRule)) return withEnd('custom');
    return withEnd(hebrew.hebrewRule === 'yahrzeit' ? 'yahrzeit' : 'hebrew');
  }
  const choice = typeof opts.freq === 'number' ? CHOICE_OF_FREQ[opts.freq] : undefined;
  if (!choice) return withEnd('custom');
  if (opts.interval !== undefined && opts.interval !== 1) return withEnd('custom');
  const allowed = CHOICE_PARTS[choice];
  const own: Record<string, number> = {
    // rrule numbers weekdays from Monday = 0; ISO's 1..7 from Monday.
    byweekday: Number(formatInTimeZone(start, tz, 'i')) - 1,
    bymonthday: Number(formatInTimeZone(start, tz, 'd')),
    bymonth: Number(formatInTimeZone(start, tz, 'M')),
  };
  for (const [part, value] of Object.entries(opts)) {
    if (value === undefined || ['freq', 'interval', 'until', 'count', 'wkst'].includes(part)) continue;
    if (!allowed.includes(part)) return withEnd('custom');
    const values = asList(value);
    const matches = values.length === 1 && values.every((v) => {
      if (part !== 'byweekday') return v === own[part];
      const day = v as { weekday?: number; n?: number } | number;
      return typeof day === 'number' ? day === own.byweekday : day.weekday === own.byweekday && !day.n;
    });
    if (!matches) return withEnd('custom');
  }
  return withEnd(choice);
}

/**
 * How many of a series' rule slots fall before `cut`, its exdates and overrides aside (as
 * yieldsSlots counts): a COUNT counts the skipped ones too, so "this one and the ones after"
 * keeps what is left of it.
 */
export function slotsBefore(series: { rrule: string; startsAt: Date; timeZone: string | null } & HebrewColumns, cut: Date): number {
  if (series.hebrewRule) return hebrewCandidates(hebrewSeriesOf(series), { from: series.startsAt, to: cut }).filter((d) => d < cut).length;
  const tz = series.timeZone || TIMEZONE;
  const from = toFloating(series.startsAt, tz);
  const to = new Date(toFloating(cut, tz).getTime() - 1);
  if (to < from) return 0;
  return buildRuleSet(series.rrule, from).between(from, to, true).length;
}

/**
 * The rule a repeat change stores (3b spec §2.1, Ends): `newRule` (one of the five, bare)
 * with the old rule's end. An UNTIL carries over as it is; a COUNT becomes a date-only
 * UNTIL on the day of its last slot under the old rule, so the series still ends that
 * day. Never (null) has no end. A new rule with an end of its own keeps it.
 */
export function endCarriedRule(
  newRule: string | null,
  oldRule: string,
  series: { startsAt: Date; timeZone: string | null } & HebrewColumns
): string | null {
  if (newRule === null) return null;
  if (/(^|[;:])(UNTIL|COUNT)=/i.test(newRule)) return newRule;
  const old = bare(oldRule);
  const until = /(^|;)UNTIL=([^;]+)/i.exec(old);
  if (until) return `${newRule};UNTIL=${until[2]}`;
  if (/(^|;)COUNT=/i.test(old)) {
    const tz = series.timeZone || TIMEZONE;
    const last = lastSlot(old, series.startsAt, tz, series);
    if (last) return `${newRule};UNTIL=${formatInTimeZone(last, tz, 'yyyyMMdd')}`;
  }
  return newRule;
}

/**
 * A rule whose UNTIL is the day of `start` (date-only, read as the end of that day). A
 * repeat change keeps its carried end unless the opened occurrence moved past it; then the
 * end goes to that occurrence's day, so the new part still has it. A rule with no UNTIL is
 * left as it is.
 */
export function withUntilOnDayOf(rule: string, start: Date, timeZone: string | null): string {
  return rule.replace(/(^|;)UNTIL=[^;]+/i, `$1UNTIL=${formatInTimeZone(start, timeZone || TIMEZONE, 'yyyyMMdd')}`);
}

/** A rule with its COUNT replaced (the rest of a series cut by "this one and the ones after"). */
export function withCount(rule: string, count: number): string {
  return rule.replace(/(^|;)COUNT=\d+/i, `$1COUNT=${count}`);
}

// ---- The scope arithmetic of a moved occurrence (shared by the store, the home's routes and
// the Google path, calendar.ts) ----

/** Calendar days from one yyyy-MM-dd to another. */
export const daysFromTo = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** An all-day item's end as the bot stores it: 23:59 on its last day. */
export const endOfLocalDay = (day: string, tz: string) => fromZonedTime(`${day}T23:59:00`, tz);

/**
 * Where a series goes when one of its occurrences moves to `to` and every occurrence
 * follows: by the days that occurrence moved, at its new time of day, so the series keeps
 * its place in the rule and its first occurrences. Timed, it takes the occurrence's new
 * length; all day, its new span in days. `occurrenceStart` is where the occurrence is now
 * (its override's start, when it was moved on its own).
 */
export function seriesTimesFor(
  series: { startsAt: Date; timeZone: string | null },
  occurrenceStart: Date,
  to: { startsAt: Date; endsAt: Date; allDay: boolean }
): { startsAt: Date; endsAt: Date } {
  const tz = series.timeZone || TIMEZONE;
  const day = addDaysToDate(localDate(series.startsAt, tz), daysFromTo(localDate(occurrenceStart, tz), localDate(to.startsAt, tz)));
  if (to.allDay) {
    const span = daysFromTo(localDate(to.startsAt, tz), localDate(to.endsAt, tz));
    return { startsAt: startOfLocalDay(day, tz), endsAt: endOfLocalDay(addDaysToDate(day, Math.max(0, span)), tz) };
  }
  const startsAt = fromZonedTime(`${day}T${formatInTimeZone(to.startsAt, tz, 'HH:mm')}:00`, tz);
  return { startsAt, endsAt: new Date(startsAt.getTime() + (to.endsAt.getTime() - to.startsAt.getTime())) };
}

/**
 * Where "this one and the ones after" starts its new series when the cut occurrence goes
 * to `to` (it is now at `occurrenceStart`): on the date entered when that is another day,
 * as a rule that follows its start moves its weekday with it (one with fixed days is
 * refused a day move); a new time alone keeps the cut's own slot, so an occurrence moved
 * on its own to another day and given a new time takes the rule's day back.
 */
export function followingTimesFor(
  series: { rrule: string | null; timeZone: string | null },
  slot: Date,
  occurrenceStart: Date,
  to: { startsAt: Date; endsAt: Date; allDay: boolean }
): { startsAt: Date; endsAt: Date } {
  const tz = series.timeZone || TIMEZONE;
  if (!fixesDays(series.rrule) && localDate(to.startsAt, tz) !== localDate(occurrenceStart, tz)) return { startsAt: to.startsAt, endsAt: to.endsAt };
  return seriesTimesFor({ startsAt: slot, timeZone: series.timeZone }, occurrenceStart, to);
}
