/**
 * The one place a local wall time becomes an instant, and an instant becomes a wall time.
 * Pure, and the same whatever zone the server process runs in: it reads a zone's offset
 * from Intl by instant and never builds a Date from local fields (new Date(y, m, d, h),
 * setHours, date-fns-tz fromZonedTime), whose answer for a skipped or repeated hour
 * depends on the host's own zone.
 *
 * The rule for the two hours a clock change makes odd:
 *   - a wall time that happens twice (the clocks go back) is the FIRST occurrence;
 *   - a wall time that never happens (the clocks jump ahead) moves forward by the length of
 *     the jump, so 02:30 on the night Israel springs forward is 03:30, as Google Calendar
 *     and a phone's clock do.
 *
 * It lives here, in a leaf, so day-events.ts and calendar-write/walltime.ts (which
 * re-exports it) can both use it without importing each other.
 */

const DAY_MS = 86_400_000;
/** yyyy-MM-dd, a 'T' or a space, HH:mm, then optional :ss and .SSS. A zone offset or a 'Z' is not a wall time. */
const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** One formatter per zone, or null where Intl does not know the zone (a bad name is an Invalid Date, as with fromZonedTime). */
const clocks = new Map<string, Intl.DateTimeFormat | null>();

function clockOf(zone: string): Intl.DateTimeFormat | null {
  let clock = clocks.get(zone);
  if (clock === undefined) {
    try {
      clock = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch (error) {
      // Intl refuses an unknown zone with a RangeError; any other failure is not ours to hide.
      if (!(error instanceof RangeError)) throw error;
      clock = null;
    }
    clocks.set(zone, clock);
  }
  return clock;
}

/** Milliseconds for a calendar reading, carried in a UTC timestamp (any year, 0 to 99 included). */
function utcMs(year: number, month: number, day: number, hour: number, minute: number, second: number, milli: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milli);
  return date.getTime();
}

/** The zone's reading of `ms`, as the fields the clock shows. */
function readingAt(clock: Intl.DateTimeFormat, ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const reading = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of clock.formatToParts(ms)) {
    if (part.type in reading) reading[part.type as keyof typeof reading] = Number(part.value);
  }
  reading.hour %= 24;
  return reading;
}

/** The zone's offset from UTC at the instant `ms`, in milliseconds (east is positive). */
function offsetAt(clock: Intl.DateTimeFormat, ms: number): number {
  const r = readingAt(clock, ms);
  return utcMs(r.year, r.month, r.day, r.hour, r.minute, r.second, 0) - Math.floor(ms / 1000) * 1000;
}

function isRealDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= (month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]);
}

/**
 * The instant at which `zone`'s clock reads `wall` ('yyyy-MM-ddTHH:mm[:ss[.SSS]]', a space
 * for the T also read), by the rule above. An unreadable wall time or an unknown zone gives
 * an Invalid Date, as date-fns-tz did, so a caller that checks for one still can.
 */
export function wallTimeToInstant(wall: string, zone: string): Date {
  const m = WALL.exec(wall);
  if (!m) return new Date(NaN);
  const [year, month, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const milli = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  // 24:00 is read as date-fns-tz read it (the day's own 00:00): the voice code's "until 24:00" relies on it.
  if (!isRealDay(year, month, day) || hour > 24 || minute > 59 || second > 59) return new Date(NaN);
  const clock = clockOf(zone || 'UTC');
  if (!clock) return new Date(NaN);

  // The wall time read as if it were UTC; the instant is that minus the zone's offset, once we know which offset.
  const floating = utcMs(year, month, day, hour % 24, minute, second, milli);
  // The offsets a day on either side. Equal: no clock change near this time, and that is the offset.
  const before = offsetAt(clock, floating - DAY_MS);
  const after = offsetAt(clock, floating + DAY_MS);
  if (before === after) return new Date(floating - before);

  // A change within a day of the time: each offset gives a candidate instant, and a candidate holds if the zone
  // really reads `wall` at it (the round trip).
  const early = floating - before;
  const late = floating - after;
  const earlyHolds = offsetAt(clock, early) === before;
  const lateHolds = offsetAt(clock, late) === after;
  if (earlyHolds && lateHolds) return new Date(Math.min(early, late)); // happens twice: the first
  if (earlyHolds) return new Date(early);
  if (lateHolds) return new Date(late);
  // Never happens: the offset before the jump carries it forward by the jump's length.
  return new Date(floating - Math.min(before, after));
}

/** `instant` on `zone`'s clock as 'yyyy-MM-ddTHH:mm:ss'. Throws RangeError for an unknown zone or an Invalid Date, as Intl does. */
export function instantToWallTime(instant: Date, zone: string): string {
  const clock = clockOf(zone || 'UTC');
  if (!clock) throw new RangeError(`Invalid time zone specified: ${zone}`);
  const r = readingAt(clock, instant.getTime());
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(r.year, 4)}-${pad(r.month)}-${pad(r.day)}T${pad(r.hour)}:${pad(r.minute)}:${pad(r.second)}`;
}
