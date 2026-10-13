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
import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import { TIMEZONE } from '../../config/constants';

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
 * Parse an RRULE string into an RRuleSet, anchored at a dtstart.
 * Accepts either a bare rule like "FREQ=WEEKLY;BYDAY=MO" or one with the
 * "RRULE:" prefix. Building via RRule.parseString + the constructor (rather
 * than rrulestr with a `dtstart` option) is the only way to reliably anchor
 * occurrences at the series's actual start time — `rrulestr` ignores the
 * `dtstart` option when the RRULE string doesn't include its own DTSTART.
 */
function buildRuleSet(rrule: string, dtstart: Date): RRuleSet {
  const trimmed = rrule.startsWith('RRULE:') ? rrule.slice('RRULE:'.length) : rrule;
  const opts = RRule.parseString(trimmed);
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
  const ruleset = buildRuleSet(event.rrule, toFloating(event.startsAt, tz));

  // Reach back by the series's length too, so an occurrence that started before
  // the window but is still running in it (Monday 22:00 to Tuesday 02:00, on
  // Tuesday) is a candidate. Widen the floating window by a further day either
  // side so an occurrence sitting near a DST boundary can't be trimmed by the
  // offset shift, then filter exactly below. `between(after, before, inc=true)`
  // is inclusive at both ends; the overlap filter restores the half-open window.
  const PAD_MS = 24 * 60 * 60 * 1000;
  const reachBackMs = Math.max(0, defaultDurationMs(event)) + PAD_MS;
  const candidates = ruleset
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
