// The calendar home's client plumbing (spec §5, §7.1): the range request and what its
// answer means for the screen, the midnight check, the "Times in <zone>" rule and the
// reload-once guard (re-exported from ./reload-guard, a leaf PageGate also reads).
// Client components only. Nothing here touches window at import.
//
// - One GET /api/calendar/range per source. The init data goes in the header only
//   (a GET has no body), never in the URL; in a browser the session cookie rides along.
// - The answer is read into one of four outcomes: ok (a RangeResponse), noCredential
//   (401, 403, 404), busy (429, also when the limiter's Redis is down) and error (500, any other status, a
//   body that isn't a RangeResponse, or no answer at all).
// - A request that hasn't settled within its time limit (a network handover, or iOS
//   suspending the webview mid-request) is aborted and reads as no answer, so it never
//   holds its place in the loader's in-flight set.

import { initDataHeaders } from '../read-init-data';
import { instantDay, intlLocale } from './format';
import type { DayKey, RangeResponse, SourceName } from './types';

export { isChunkLoadError } from './reload-guard';

/** A window of days, [from, to). */
export interface RangeWindow {
  from: DayKey;
  to: DayKey;
}

export type RangeOutcome =
  | { kind: 'ok'; response: RangeResponse }
  | { kind: 'noCredential'; status: number }
  | { kind: 'busy' }
  | { kind: 'error'; status: number | null };

/**
 * The range route's URL for one source. No window means no dates: the server's
 * [today, today+7). `fresh` asks the server to skip its Google cache (⋯ → Refresh).
 */
export function rangeUrl(userId: number, source: SourceName, window: RangeWindow | null, fresh: boolean): string {
  const query = new URLSearchParams({ user_id: String(userId), sources: source });
  if (window) {
    query.set('from', window.from);
    query.set('to', window.to);
  }
  if (fresh) query.set('fresh', '1');
  return `/api/calendar/range?${query.toString()}`;
}

/** The fields the store reads, so a body that isn't a RangeResponse is an error, not a crash. */
function isRangeResponse(value: unknown): value is RangeResponse {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tz === 'string' &&
    typeof r.today === 'string' &&
    typeof r.from === 'string' &&
    typeof r.to === 'string' &&
    typeof r.weekStart === 'number' &&
    typeof r.hebrewDates === 'boolean' &&
    typeof r.sources === 'object' &&
    r.sources !== null &&
    Array.isArray(r.days) &&
    Array.isArray(r.calendars)
  );
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** A time limit for one request: after `ms` on the caller's timer, it is aborted and reads as no answer. */
export interface RangeTimeLimit {
  ms: number;
  setTimer: (run: () => void, ms: number) => () => void;
}

/**
 * Asks the range route for one source's window. `userId` is the page's own user_id,
 * exactly as CalendarHomeProps carries it (a Telegram id or a DB id); it is never swapped.
 * With `limit`, an answer that hasn't come (headers and body) within `limit.ms` is
 * aborted and reads as `{ kind: 'error', status: null }`, whether or not the fetch honours
 * the abort. Never throws.
 */
export async function fetchRange(
  userId: number,
  source: SourceName,
  window: RangeWindow | null,
  fresh: boolean,
  limit?: RangeTimeLimit,
): Promise<RangeOutcome> {
  if (!limit) return askRange(userId, source, window, fresh, undefined);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let cancel = () => {};
  const timedOut = new Promise<RangeOutcome>((resolve) => {
    cancel = limit.setTimer(() => {
      try {
        controller?.abort();
      } catch {
        // The answer below is what counts.
      }
      resolve({ kind: 'error', status: null });
    }, limit.ms);
  });
  try {
    return await Promise.race([askRange(userId, source, window, fresh, controller?.signal), timedOut]);
  } finally {
    cancel();
  }
}

async function askRange(userId: number, source: SourceName, window: RangeWindow | null, fresh: boolean, signal: AbortSignal | undefined): Promise<RangeOutcome> {
  let res: Response;
  try {
    res = await fetch(rangeUrl(userId, source, window, fresh), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: initDataHeaders(),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: 'error', status: null };
  }
  if (res.status === 200) {
    const body = await bodyOf(res);
    return isRangeResponse(body) ? { kind: 'ok', response: body } : { kind: 'error', status: 200 };
  }
  if (res.status === 429) return { kind: 'busy' };
  if (res.status === 401 || res.status === 403) return { kind: 'noCredential', status: res.status };
  if (res.status === 404) return { kind: 'noCredential', status: 404 };
  return { kind: 'error', status: res.status };
}

const HOUR_MS = 3_600_000;

/**
 * How long to wait before checking whether the day has changed in `tz`: until just
 * after the next local midnight, but never more than an hour, so a DST change on the
 * way can move the check by minutes at most. At least one second.
 */
export function msUntilDayCheck(nowMs: number, tz: string): number {
  let sinceMidnight: number | null = null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(new Date(nowMs));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    const [h, m, s] = [part('hour'), part('minute'), part('second')];
    if ([h, m, s].every(Number.isFinite)) sinceMidnight = ((h * 60 + m) * 60 + s) * 1000 + (nowMs % 1000);
  } catch {
    // A zone the device's Intl doesn't know: check again in an hour.
  }
  if (sinceMidnight === null) return HOUR_MS;
  return Math.min(HOUR_MS, Math.max(1000, 24 * HOUR_MS - sinceMidnight + 500));
}

/**
 * The device's day is already past the server's today: its clock runs ahead. The check
 * asks the server again after a minute, then two, four... but never more than 15
 * minutes apart, so a clock that is far ahead costs a few requests an hour.
 * `attempt` counts from 0.
 */
export function msUntilAheadCheck(attempt: number): number {
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, attempt));
}

/** Whether the day in `tz` is already later than `today` (the server's). */
export function isPastDay(nowMs: number, tz: string, today: DayKey): boolean {
  const day = instantDay(new Date(nowMs).toISOString(), tz);
  return day !== null && day > today;
}

/** The device's own timezone, or null when Intl doesn't say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function canonicalZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** "Times in <zone>" shows only when the device's zone isn't the one the times are in (aliases count as the same). */
export function zoneDiffers(device: string | null, tz: string): boolean {
  if (!device) return false;
  const a = canonicalZone(device);
  const b = canonicalZone(tz);
  return a !== null && b !== null && a !== b;
}

/** A zone's name for people: "Israel Time" / "שעון ישראל" / "Израиль"; else its city ("New York"). */
export function zoneLabel(tz: string, locale: string): string {
  for (const style of ['longGeneric', 'long'] as const) {
    try {
      const name = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: tz, timeZoneName: style })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value;
      if (name && !/^(GMT|UTC)\b/.test(name.replace(/\u200e/g, ''))) return name;
    } catch {
      // Not supported by this Intl: try the next style, then the city.
    }
  }
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}
