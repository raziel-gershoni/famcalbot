/**
 * "At most once a day" for a warning: the reminder pass ticks every minute and a zman that does not exist that day
 * would otherwise be logged on every tick. The memory is on globalThis (Next 16 gives the scheduler and the routes
 * separate module instances, src/lib/timezone.ts). Light: no import.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Past this many keys the memory starts over (a day's worth of distinct reminders, never a leak). */
const MAX_KEYS = 5000;

const shared = globalThis as { __zmanimWarnedOn?: Map<string, number> };
const warnedOn: Map<string, number> = (shared.__zmanimWarnedOn ??= new Map());

/** console.warn(`message`) unless `key` was already warned today (a UTC day). */
export function warnOnceADay(key: string, message: string): void {
  const day = Math.floor(Date.now() / DAY_MS);
  if (warnedOn.get(key) === day) return;
  if (warnedOn.size >= MAX_KEYS) warnedOn.clear();
  warnedOn.set(key, day);
  console.warn(message);
}

/** Smoke scripts only: back to a fresh process. */
export function __resetWarnOnceForTests(): void {
  warnedOn.clear();
}
