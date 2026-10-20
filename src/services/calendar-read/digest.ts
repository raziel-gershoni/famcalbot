// The summaries' calendar read (calendar home spec §3.1 "Adapters"): the day of a daily
// or tomorrow summary (telegram/summary.ts), and the range of the week block, /week and
// /nextweek (week-lookahead.ts), read through the shared reader for every user.
//
// The summary gets each item's event exactly as the reader carries it, in the reader's
// order, so its own shaping and prompts run as they do today (Appendix A). This file
// decides how a read ends. A failed Google half never hides the FamCal half ("Google as a
// connection" spec §4 Summaries):
// - a dead token or missing scopes with FamCal items: those items, marked with the
//   reconnect kind (googleGap), for the summary to send with the reconnect line;
// - a dead token or missing scopes with no FamCal items throw the codes the summaries
//   already answer, GOOGLE_TOKEN_EXPIRED and GOOGLE_INSUFFICIENT_SCOPES;
// - any other Google failure throws GOOGLE_FETCH_FAILED with the read's first day, so
//   a scheduled run can retry that same day about 30 s later (spec §3.3 C5) and an
//   on-demand run can say Google couldn't be reached (Ruling R13); on demand with FamCal
//   items, those items come back marked 'unavailable' instead, with a warning;
// - before that, an on-demand read that failed fast gets one quick retry here, inside
//   the command's 50 s limit;
// - when every chosen calendar is gone, the day has no Google events and a warning
//   goes to Sentry, with no retry (Ruling R18);
// - a FamCal (database) error rethrows its own cause, so the pipeline's error texts
//   and admin notice stay as they are (A-28).
//
// Summary reads never use the Google cache ('bypass'), so they never read, write or
// stamp it (A-30).

import type { CalendarEvent, UserConfig } from '../../types';
import { captureWarning } from '../../lib/error-capture';
import { localDate, nextDate } from '../../utils/day-events';
import { readRange } from './index';
import type { DayKey, RangeRead, ReadRangeOptions, SourceName } from './types';

/**
 * Why a digest read kept its FamCal half without Google's: the reconnect kind of a dead token
 * or missing scopes, or an outage on demand.
 */
export type GoogleGap = 'token' | 'scopes' | 'unavailable';

/** A digest read's events, in the reader's order. googleGap says the Google half failed and only FamCal's are here. */
export type DigestEvents = CalendarEvent[] & { googleGap?: GoogleGap };

/** The error a gap stands for, for the answers the summaries and /week already give (answerGoogleReadError). */
export function googleGapError(gap: GoogleGap): Error {
  return new Error(gap === 'token' ? 'GOOGLE_TOKEN_EXPIRED' : gap === 'scopes' ? 'GOOGLE_INSUFFICIENT_SCOPES' : 'GOOGLE_FETCH_FAILED');
}

/** A summary run's kind, and the Google deadline of its reads (spec §2.2 Deadlines). */
export type DigestRead = { mode: 'scheduled' | 'onDemand'; deadlineMs: number };

/** On demand: the daily and tomorrow summaries, the tomorrow week block, /week and /nextweek. */
export const DEFAULT_ON_DEMAND_READ: DigestRead = Object.freeze({ mode: 'onDemand', deadlineMs: 10_000 });
/** A scheduled run's first attempt: the day read and the week block. */
export const SCHEDULED_READ: DigestRead = Object.freeze({ mode: 'scheduled', deadlineMs: 30_000 });
/** A scheduled run's retry, about 30 s after the first failure (spec §3.3 C5): the day read and the week block. */
export const SCHEDULED_RETRY_READ: DigestRead = Object.freeze({ mode: 'scheduled', deadlineMs: 15_000 });

/** An on-demand read whose Google half failed within this time of its start is tried once more. */
const QUICK_RETRY_WITHIN_MS = 5_000;
/** The pause before that retry. */
const QUICK_RETRY_PAUSE_MS = 1_000;
/** The retry's deadline. With the two above, one on-demand read takes at most about 14 s of Google time. */
const QUICK_RETRY_DEADLINE_MS = 8_000;

const LOG_CONTEXT = 'calendar-read-digest';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The reader's window: [fromKey, toKey) in the user's timezone, clipped to notBefore. */
type DigestWindow = { fromKey: DayKey; toKey: DayKey; notBefore?: Date };

/**
 * Worth one quick retry: the Google half failed, fast. A timeout has already used its
 * time, and a retry can't bring back calendars that are gone.
 */
function worthQuickRetry(result: RangeRead, tookMs: number): boolean {
  const google = result.google;
  return (
    google?.status === 'error' &&
    google.reason !== 'timeout' &&
    google.reason !== 'calendars_gone' &&
    tookMs <= QUICK_RETRY_WITHIN_MS
  );
}

/**
 * One summary read through the reader, never through the Google cache. On demand, a
 * Google failure within 5 s is read once more, about 1 s later, with an 8 s deadline;
 * the second result is the answer. A scheduled read never retries here; sendSummaryToAll's
 * retry queue does (spec §3.3 C5).
 */
async function readForDigest(
  user: UserConfig,
  window: DigestWindow,
  tz: string,
  ids: readonly string[],
  read: DigestRead,
  sources?: readonly SourceName[]
): Promise<RangeRead> {
  const optionsWith = (deadlineMs: number): ReadRangeOptions => ({
    tz,
    ...(sources ? { sources } : {}),
    calendarIds: ids,
    ...(window.notBefore ? { notBefore: window.notBefore } : {}),
    googleCache: 'bypass',
    deadlineMs,
  });
  const startedAt = Date.now();
  const first = await readRange(user, window.fromKey, window.toKey, optionsWith(read.deadlineMs));
  if (read.mode !== 'onDemand' || !worthQuickRetry(first, Date.now() - startedAt)) return first;
  await pause(QUICK_RETRY_PAUSE_MS);
  return readRange(user, window.fromKey, window.toKey, optionsWith(QUICK_RETRY_DEADLINE_MS));
}

/**
 * A read as the summaries take it (spec §3.1, throwForDigest; "Google as a connection" §4):
 *
 * | Read result                  | FamCal items | Result                                           |
 * |------------------------------|--------------|--------------------------------------------------|
 * | FamCal error                 | -            | rethrow the cause                                |
 * | reconnect('scopes')          | none         | GOOGLE_INSUFFICIENT_SCOPES                       |
 * | reconnect('token')           | none         | GOOGLE_TOKEN_EXPIRED                             |
 * | reconnect(reason)            | some         | the FamCal events, googleGap = reason            |
 * | error('calendars_gone')      | -            | no Google events, plus a warning                 |
 * | any other error, scheduled   | -            | GOOGLE_FETCH_FAILED, `day`: the read's first day |
 * | any other error, on demand   | none         | GOOGLE_FETCH_FAILED, `day`                       |
 * | any other error, on demand   | some         | the FamCal events, googleGap 'unavailable'       |
 * | ok (with or without partial) | -            | what loaded, as today                            |
 *
 * A scheduled outage still throws: the batch retries it, and its outage run reads FamCal only.
 * A Google half that isn't ok contributes no items, so what is returned then is FamCal's.
 */
function throwForDigest(result: RangeRead, user: UserConfig, day: DayKey, read: DigestRead): DigestEvents {
  if (result.famcal?.status === 'error') throw result.famcal.cause;
  const events: DigestEvents = result.items.map(item => item.event);
  const famcalItems = result.items.filter(item => item.source === 'famcal').length;
  const google = result.google;
  if (google?.status === 'reconnect') {
    if (famcalItems === 0) throw new Error(google.reason === 'scopes' ? 'GOOGLE_INSUFFICIENT_SCOPES' : 'GOOGLE_TOKEN_EXPIRED');
    console.warn(`[Digest] user ${user.id}: Google needs reconnecting (${google.reason}); ${day} keeps its ${famcalItems} FamCal items`);
    events.googleGap = google.reason;
    return events;
  }
  if (google?.status === 'error') {
    if (google.reason !== 'calendars_gone') {
      if (read.mode === 'scheduled' || famcalItems === 0) throw Object.assign(new Error('GOOGLE_FETCH_FAILED'), { day });
      captureWarning(
        "Google couldn't be read on demand; the summary keeps its FamCal items",
        LOG_CONTEXT,
        { user_id: user.id, day, mode: read.mode, reason: google.reason }
      );
      events.googleGap = 'unavailable';
      return events;
    }
    captureWarning(
      'Every chosen Google calendar is gone (deleted, unshared or on another account); the summary has no Google events',
      LOG_CONTEXT,
      { user_id: user.id, day, mode: read.mode }
    );
  }
  return events;
}

/**
 * The events of `day` (yyyy-MM-dd in `tz`) for a daily or tomorrow summary:
 * readRange over [day, next day) on the calendars the summary resolved (`ids`), for the
 * summary to shape (shapeEventsForDay). Throws as throwForDigest says;
 * GOOGLE_FETCH_FAILED carries `day`. `sources` narrows the read (the outage run: ['famcal']).
 */
export async function readDigestDay(
  user: UserConfig,
  day: DayKey,
  tz: string,
  ids: readonly string[],
  read: DigestRead,
  sources?: readonly SourceName[]
): Promise<DigestEvents> {
  const result = await readForDigest(user, { fromKey: day, toKey: nextDate(day) }, tz, ids, read, sources);
  return throwForDigest(result, user, day, read);
}

/**
 * The events of a lookahead range for the week block, /week and /nextweek: from the
 * instant `start` (This week starts now; the tomorrow block at the summary day's noon)
 * to `end`, the inclusive last instant of the range's last day (week-lookahead.ts's
 * endOfLocalDay). That is readRange over [start's day, the day after end's day),
 * clipped to start, so it covers [start, end] as the old Google read did. Throws as
 * throwForDigest says; GOOGLE_FETCH_FAILED carries start's day in `tz`. `sources` narrows
 * the read (the outage run's week block: ['famcal']).
 */
export async function readLookaheadEvents(
  user: UserConfig,
  start: Date,
  end: Date,
  tz: string,
  ids: readonly string[],
  read: DigestRead,
  sources?: readonly SourceName[]
): Promise<DigestEvents> {
  const firstDay = localDate(start, tz);
  const window = { fromKey: firstDay, toKey: nextDate(localDate(end, tz)), notBefore: start };
  const result = await readForDigest(user, window, tz, ids, read, sources);
  return throwForDigest(result, user, firstDay, read);
}
