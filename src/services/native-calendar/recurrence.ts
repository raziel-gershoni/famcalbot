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
import type { NativeEvent, NativeEventInstance } from '@prisma/client';

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
 * Compute the duration of a series's default occurrence (endsAt - startsAt).
 * Used to derive end times for instances when the override doesn't specify one.
 */
function defaultDurationMs(series: NativeEvent): number {
  return series.endsAt.getTime() - series.startsAt.getTime();
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
    const endsAt =
      override.endsAt ??
      (override.startsAt
        ? new Date(override.startsAt.getTime() + defaultDurationMs(series))
        : new Date(occurrenceStart.getTime() + defaultDurationMs(series)));

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
  const occurrenceEnd = new Date(occurrenceStart.getTime() + defaultDurationMs(series));
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
 * date range. The range is treated as half-open [from, to) on the occurrence
 * start time — instances starting at exactly `to` are excluded.
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
    if (event.startsAt >= range.to || event.startsAt < range.from) return [];
    const instance = buildInstance(event, event.startsAt, overrideMap);
    return instance ? [{ ...instance, isRecurringInstance: false }] : [];
  }

  // Recurring: enumerate occurrences in [from, to)
  const ruleset = buildRuleSet(event.rrule, event.startsAt);
  // rrule's `between(after, before, inc=true)` is inclusive on both ends; we want
  // [from, to) so we trim any equal-to-to result below.
  const occurrences = ruleset.between(range.from, range.to, true);

  const instances: VirtualInstance[] = [];
  for (const start of occurrences) {
    if (start.getTime() >= range.to.getTime()) continue;
    const inst = buildInstance(event, start, overrideMap);
    if (inst) instances.push(inst);
  }

  // Floating overrides whose new start lands inside the range but whose original
  // occurrence falls outside the range still need to be rendered. Iterate any
  // overrides whose effective startsAt is in range and whose original time was
  // NOT already enumerated above.
  const enumeratedStarts = new Set(occurrences.map((d) => d.getTime()));
  for (const o of overrides) {
    if (enumeratedStarts.has(o.originalStartsAt.getTime())) continue;
    if (o.status === 'CANCELLED') continue;
    const effectiveStart = o.startsAt ?? o.originalStartsAt;
    if (effectiveStart < range.from || effectiveStart >= range.to) continue;
    const inst = buildInstance(event, o.originalStartsAt, overrideMap);
    if (inst) instances.push(inst);
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
 * Strategy: strip any existing UNTIL/COUNT and append UNTIL=<instanceDate-1>
 * formatted as YYYYMMDD (the RFC-5545 date form, which RRULE accepts when
 * the original DTSTART was timed). We use the day-before so the truncation
 * is exclusive of the targeted instance.
 */
export function truncateRruleBefore(rrule: string, instanceDate: Date): string {
  const dayBefore = new Date(instanceDate);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const yyyy = dayBefore.getUTCFullYear();
  const mm = String(dayBefore.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dayBefore.getUTCDate()).padStart(2, '0');
  const untilStr = `${yyyy}${mm}${dd}`;

  const trimmed = rrule.startsWith('RRULE:') ? rrule.slice(6) : rrule;
  const parts = trimmed
    .split(';')
    .filter((p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='));
  parts.push(`UNTIL=${untilStr}`);
  return parts.join(';');
}
