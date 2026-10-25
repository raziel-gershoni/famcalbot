// The Repeat sheet's rule model on the server (editor upgrades spec §3, "Richer repeats"):
// the one builder every write goes through (ruleOfSpec), the change test of a repeat
// (repeatChanges) and the rule a repeat change writes with its end (ruleToWrite). Pure, so a
// smoke runs it with nothing faked; write.ts and google-item.ts use it for FamCal and Google.

import { formatInTimeZone } from 'date-fns-tz';
import {
  NativeRuleError,
  assertStorableRule,
  endOfRule,
  inLastWeek,
  slotsBefore,
  weekdayOrdinalOf,
  type HebrewColumns,
  type HebrewRule,
} from '../native-calendar/recurrence';
import { WEEKDAY_CODES, type RepeatChoice, type RepeatInput, type RepeatSpec, type RuleChoice } from '../../lib/calendar-view/editor-types';
import type { WeekStart } from '../../lib/calendar-view/types';
import { specWithinLimits } from './validate';

/** The spec a string choice stands for (cached clients send those), or null for 'none': every write goes through ruleOfSpec. */
export function specOfChoice(choice: RepeatChoice): RepeatSpec | null {
  return choice === 'none' ? null : { freq: choice, interval: 1 };
}

/** The spec a body's `repeat` stands for, or null for none. */
export const specOfInput = (repeat: RepeatInput): RepeatSpec | null => (typeof repeat === 'string' ? specOfChoice(repeat) : repeat);

/** A stored rule and the pair that goes with it, as the store takes them (no RRULE: prefix). */
export interface BuiltRule {
  rrule: string;
  hebrewRule: HebrewRule | null;
}

const inZone = (start: Date, zone: string) => {
  const [year, month, day] = formatInTimeZone(start, zone, 'yyyy-M-d').split('-').map(Number);
  return { day, daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(), weekday: Number(formatInTimeZone(start, zone, 'i')) - 1, date: formatInTimeZone(start, zone, 'yyyy-MM-dd') };
};

/**
 * The rule a spec stores on a start (richer repeats spec §3, ruling 2): the one builder for every
 * write, FamCal and Google, string choice or spec. Bare, parts in the bot's order (FREQ, INTERVAL,
 * BYDAY, the end). INTERVAL only above 1; weekly writes BYDAY only for more days than the start's
 * own, which is always one of them; monthly 'weekday' is the start's n-th weekday, 'last' its last
 * one (refused unless the start is in its month's last seven days); a Hebrew repeat is FREQ=YEARLY
 * with the pair; the end is a date-only UNTIL or a COUNT. `start` is read in `zone`, the item's.
 * Throws NativeRuleError for a spec beyond its limits, an until before the start's day, or a rule
 * the store won't keep (assertStorableRule).
 */
export function ruleOfSpec(spec: RepeatSpec, start: Date, zone: string, weekStart?: WeekStart): BuiltRule {
  if (!specWithinLimits(spec)) throw new NativeRuleError('The repeat is beyond its limits');
  const at = inZone(start, zone);
  if (spec.until !== undefined && spec.until < at.date) throw new NativeRuleError('The repeat ends before it starts');
  const parts = [`FREQ=${spec.freq === 'hebrew' ? 'YEARLY' : spec.freq.toUpperCase()}`];
  if (spec.interval > 1) parts.push(`INTERVAL=${spec.interval}`);
  if (spec.freq === 'weekly') {
    const days = new Set([...(spec.byDay ?? []).map((d) => WEEKDAY_CODES.indexOf(d)), at.weekday]);
    if (days.size > 1) {
      parts.push(`BYDAY=${[...days].sort((a, b) => a - b).map((n) => WEEKDAY_CODES[n]).join(',')}`);
      // Every N weeks on several days pairs the days within a week, and which week it is depends on where weeks start:
      // the saving user's week start. Every other spec writes no WKST.
      if (spec.interval > 1 && weekStart !== undefined) parts.push(`WKST=${WEEKDAY_CODES[(weekStart + 6) % 7]}`);
    }
  } else if (spec.freq === 'monthly' && spec.monthly === 'weekday') {
    parts.push(`BYDAY=${weekdayOrdinalOf(at.day)}${WEEKDAY_CODES[at.weekday]}`);
  } else if (spec.freq === 'monthly' && spec.monthly === 'last') {
    if (!inLastWeek(at.day, at.daysInMonth)) throw new NativeRuleError('The start is not in its month\'s last week');
    parts.push(`BYDAY=-1${WEEKDAY_CODES[at.weekday]}`);
  }
  if (spec.until !== undefined) parts.push(`UNTIL=${spec.until.replace(/-/g, '')}`);
  else if (spec.count !== undefined) parts.push(`COUNT=${spec.count}`);
  const built: BuiltRule = { rrule: parts.join(';'), hebrewRule: spec.freq === 'hebrew' ? 'anniversary' : null };
  assertStorableRule(built.rrule, built.hebrewRule);
  return built;
}

/** A spec with no end: what the rule is, apart from where it stops. */
const withoutSpecEnd = (spec: RepeatSpec): RepeatSpec => {
  const { until: _until, count: _count, ...rest } = spec;
  return rest;
};

/** The series a repeat change reads: its rule, start, zone and Hebrew pair as stored. */
export type StoredSeries = { rrule: string | null; startsAt: Date; timeZone: string | null } & HebrewColumns;

/**
 * A rule normalised to compare: no prefix, no end, no WKST, no INTERVAL=1, the BYDAY list sorted, the parts in
 * a fixed order. Two rules that expand alike by the editor's own writing compare equal.
 */
function withoutEnd(rule: string): string {
  return rule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter((p) => !/^(UNTIL|COUNT|WKST)=/i.test(p) && !/^INTERVAL=1$/i.test(p))
    .map((p) => (/^BYDAY=/i.test(p) ? `BYDAY=${p.slice(6).split(',').sort().join(',')}` : p))
    .sort()
    .join(';')
    .toUpperCase();
}

/** The week start a stored rule is shaped by: its WKST (Monday without one) when it is an every-N-weeks rule on several days, else undefined. */
function storedWeekStart(rule: string | null): WeekStart | undefined {
  if (!rule) return undefined;
  const parts = Object.fromEntries(rule.replace(/^RRULE:/i, '').toUpperCase().split(';').map((p) => p.split('=') as [string, string]));
  if (parts.FREQ !== 'WEEKLY' || !(Number(parts.INTERVAL) > 1) || (parts.BYDAY ?? '').split(',').filter(Boolean).length < 2) return undefined;
  const at = WEEKDAY_CODES.indexOf((parts.WKST ?? 'MO') as (typeof WEEKDAY_CODES)[number]);
  return at < 0 ? 1 : (((at + 1) % 7) as WeekStart);
}

/**
 * Whether picking `repeat` changes the stored rule (3b spec §2.1, richer repeats ruling 6).
 * A string choice: another of the five, or the same one for a rule that isn't the one that choice
 * writes (a bot's "every Tuesday", BYDAY=TU, re-picked as 'weekly' follows its start); ends
 * ignored. A spec: the rule it builds on `tailStart` (the start the new part will have), end
 * excluded, differs from the stored rule, end excluded and normalised (withoutEnd), or its Hebrew
 * pair differs, or its end is not the stored one. The client sends a spec only for a real pick or a
 * restated move, so a bot's BYDAY=TU series with a spec is a change: the rule follows its start.
 */
export function repeatChanges(repeat: RepeatInput, stored: StoredSeries, current: RuleChoice, tailStart: Date, zone: string): boolean {
  if (typeof repeat === 'string') {
    if (repeat !== current) return true;
    const spec = specOfChoice(repeat);
    return spec !== null && stored.rrule !== null && withoutEnd(stored.rrule) !== withoutEnd(ruleOfSpec(spec, stored.startsAt, zone).rrule);
  }
  if (stored.rrule === null) return true;
  const built = ruleOfSpec(withoutSpecEnd(repeat), tailStart, zone);
  if ((stored.hebrewRule ?? null) !== built.hebrewRule) return true;
  if (withoutEnd(built.rrule) !== withoutEnd(stored.rrule)) return true;
  const end = endOfRule(stored.rrule, stored.startsAt, zone, stored);
  return repeat.until !== end.until || repeat.count !== end.count;
}

/**
 * The rule a repeat change writes (richer repeats ruling 5). A string choice, and a spec whose end
 * is the stored one, give the rule without an end: the store carries the old end (endCarriedRule).
 * A spec with another end applies it to the part written: an until as given; a count counted from
 * the series' first occurrence, so a part cut at a later occurrence (`cut`, with the stored series
 * to count its slots) gets what is left of it, at least 1. From the first occurrence, or for a one-off
 * becoming a repeat, it is the whole count. Never on a stored end removes it.
 */
export function ruleToWrite(
  repeat: RepeatSpec | RepeatChoice,
  stored: StoredSeries | null,
  tailStart: Date,
  zone: string,
  cut: { at: Date; first: boolean } | null,
  userWeekStart?: WeekStart
): BuiltRule & { endGiven: boolean } {
  const spec = specOfInput(repeat);
  if (!spec) throw new NativeRuleError('No repeat to build');
  const end = stored?.rrule ? endOfRule(stored.rrule, stored.startsAt, zone, stored) : {};
  // A stored every-N-weeks rule on several days keeps its own week start when rebuilt (its weeks would shift otherwise).
  const weekStart = storedWeekStart(stored?.rrule ?? null) ?? userWeekStart;
  const unchanged = typeof repeat === 'string' || (spec.until === end.until && spec.count === end.count);
  if (unchanged) {
    // A stored date-time UNTIL (a split head's, a full period past its last occurrence) is shown as its last
    // occurrence's day. When that is another day, a rule that fills more days would run past what the sheet
    // showed, so the shown day is written as the end. The editor's specs only: a choice string keeps the carry.
    const own = /(^|;)UNTIL=(\d{8})T/i.exec(stored?.rrule ?? '');
    if (typeof repeat !== 'string' && own && end.until && own[2] !== end.until.replace(/-/g, '')) {
      return { ...ruleOfSpec({ ...withoutSpecEnd(spec), until: end.until }, tailStart, zone, weekStart), endGiven: true };
    }
    return { ...ruleOfSpec(withoutSpecEnd(spec), tailStart, zone, weekStart), endGiven: false };
  }
  // The end is the spec's now (Never included): the store must not carry the old one onto it.
  if (spec.count !== undefined && stored?.rrule && cut && !cut.first) {
    const left = Math.max(1, spec.count - slotsBefore({ ...stored, rrule: stored.rrule }, cut.at));
    return { ...ruleOfSpec({ ...spec, count: left }, tailStart, zone, weekStart), endGiven: true };
  }
  return { ...ruleOfSpec(spec, tailStart, zone, weekStart), endGiven: true };
}
