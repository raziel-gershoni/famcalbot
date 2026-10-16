/**
 * The calendar home's Google half (spec §2.5): one live read of the user's chosen Google
 * calendars over a window.
 *
 * - The token step runs first, inside the deadline. A dead token, missing scopes, a
 *   rejected OAuth client or a stuck token server is then one outcome for the whole half,
 *   and no calendar is listed.
 * - Each chosen calendar gets its own events.list, in parallel, with a trimmed field mask,
 *   the user's timezone, a request timeout and one retry. The response's top-level
 *   `summary` is the calendar's title, so there is no calendars.get.
 * - Pages are followed until done or 5,000 items per calendar.
 * - Items go through keepGoogleEvent and mapGoogleEvent (google-map.ts). The legend
 *   (CalendarRef) is joined from the user's choices at read time and is never cached.
 * - One deadline covers all of it. What settled keeps its outcome; a calendar that got a
 *   page by then is truncated, one that got none failed.
 *
 * readGoogleUncached is the live read. readGoogle is what readRange calls: the live read
 * here, with Task B7's route cache put in front of it later. Nothing here stamps the
 * cache; B7's wrapper does that for reads that end in reconnect or calendars_gone.
 */

import { calendar as googleCalendar } from '@googleapis/calendar';
import type { calendar_v3 } from '@googleapis/calendar';
import { getGoogleAuth } from '../calendar';
import { classifyGoogleError, keepGoogleEvent, mapGoogleEvent } from './google-map';
import { captureError, captureWarning } from '../../lib/error-capture';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import type { CalendarAssignment, UserConfig } from '../../types';
import type { CalendarRef, GoogleRead, ReadItem } from './types';

/** A Google item before its calendar is joined. This is what B7's cache stores. */
export type GoogleItem = Omit<ReadItem, 'calendar'>;

export interface GoogleReadOptions {
  tz: string;                          // the user's resolveUserTimezone; Google writes times in it
  calendarIds?: readonly string[];     // summary callers: the ids they resolved, narrowed to the choices
  deadlineMs: number;                  // covers the token step, the lists and the paging (spec §2.2)
}

export interface GoogleReadResult {
  read: GoogleRead;
  items: ReadItem[];                   // empty unless read.status is 'ok'
}

type ErrorClass = ReturnType<typeof classifyGoogleError>;

const LOG_CONTEXT = 'calendar-read-google';
const FIELDS =
  'summary,nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,eventType,attendees(self,responseStatus),htmlLink)';
const PAGE_SIZE = 2500;
const MAX_ITEMS_PER_CALENDAR = 5000;
const MAX_REQUEST_TIMEOUT_MS = 10_000;
const DEADLINE_MARGIN_MS = 500;
const GONE_WARNING_TTL_S = 86_400;
const CONFIG_ALERT_TTL_S = 3_600;

/**
 * The calendars a read covers: the user's choices (calendarAssignments, A-3) in their own
 * order, narrowed to calendarIds when given. Ids never come from the client. A repeated id
 * is read once.
 */
export function googleCalendarSet(
  user: Pick<UserConfig, 'calendarAssignments'>,
  calendarIds?: readonly string[],
): CalendarAssignment[] {
  const wanted = calendarIds ? new Set(calendarIds) : null;
  const seen = new Set<string>();
  return (user.calendarAssignments ?? []).filter(a => {
    if (!a?.calendarId || seen.has(a.calendarId) || (wanted && !wanted.has(a.calendarId))) return false;
    seen.add(a.calendarId);
    return true;
  });
}

/**
 * What the UI may show about a chosen calendar: its saved name and colour, whether it is
 * the user's own (not labelled spouse), the spouse's name, and whether it is gone. Per-event
 * colorId is ignored in step 1.
 */
export function googleCalendarRef(a: CalendarAssignment, goneIds: readonly string[]): CalendarRef {
  const spouse = (a.labels ?? []).includes('spouse');
  const ref: CalendarRef = {
    id: a.calendarId,
    source: 'google',
    name: a.name || a.calendarId,
    color: a.color || null,
    mine: !spouse,
    inLegend: true,
  };
  if (spouse && a.personName) ref.ownerName = a.personName;
  if (goneIds.includes(a.calendarId)) ref.unavailable = true;
  return ref;
}

/** Joins each item's CalendarRef from the set. An item whose calendar is not in the set is dropped. */
export function attachGoogleCalendars(
  items: readonly GoogleItem[],
  set: readonly CalendarAssignment[],
  goneIds: readonly string[],
): ReadItem[] {
  const refs = new Map(set.map(a => [a.calendarId, googleCalendarRef(a, goneIds)]));
  return items.flatMap(item => {
    const calendar = refs.get(item.event.calendarId);
    return calendar ? [{ ...item, calendar }] : [];
  });
}

interface Deadline {
  readonly reached: Promise<void>;
  expired(): boolean;
  clear(): void;
}

function startDeadline(ms: number): Deadline {
  let expired = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<void>(resolve => {
    handle = setTimeout(() => {
      expired = true;
      resolve();
    }, ms);
  });
  return { reached, expired: () => expired, clear: () => clearTimeout(handle) };
}

/** One calendar's list, as far as it got. */
interface CalendarProgress {
  calendarId: string;
  pages: number;                       // pages received
  received: number;                    // raw items received, counted against the cap
  items: GoogleItem[];                 // kept and mapped
  truncated: boolean;                  // stopped at the cap with more to read
  failure: { cls: ErrorClass; error: unknown } | null;
  settled: boolean;
}

type Outcome =
  | { calendarId: string; kind: 'ok'; items: GoogleItem[]; truncated: boolean }
  | { calendarId: string; kind: 'failed'; cls: ErrorClass; error: unknown };
type Failure = Extract<Outcome, { kind: 'failed' }>;

/** Lists one calendar page by page. Never rejects; after the deadline it changes nothing. */
async function listCalendar(
  cal: calendar_v3.Calendar,
  p: CalendarProgress,
  window: { from: Date; to: Date },
  tz: string,
  timeoutMs: number,
  deadline: Deadline,
): Promise<void> {
  let pageToken: string | undefined;
  let calendarName: string | undefined;
  try {
    do {
      const res = await cal.events.list(
        {
          calendarId: p.calendarId,
          timeMin: window.from.toISOString(),
          timeMax: window.to.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          timeZone: tz,
          maxResults: PAGE_SIZE,
          maxAttendees: 1,
          pageToken,
          fields: FIELDS,
        },
        { timeout: timeoutMs, retryConfig: { retry: 1, noResponseRetries: 0 } },
      );
      if (deadline.expired()) return;
      p.pages++;
      // The calendar's title in Google, as calendar.ts:113 takes it from calendars.get.
      calendarName ??= res.data.summary || p.calendarId;
      for (const raw of res.data.items ?? []) {
        if (p.received === MAX_ITEMS_PER_CALENDAR) {
          p.truncated = true;
          break;
        }
        p.received++;
        if (keepGoogleEvent(raw)) p.items.push(mapGoogleEvent(raw, p.calendarId, calendarName));
      }
      pageToken = res.data.nextPageToken || undefined;
      if (pageToken && p.received === MAX_ITEMS_PER_CALENDAR) p.truncated = true;
    } while (pageToken && !p.truncated);
    p.settled = true;
  } catch (error) {
    if (deadline.expired()) return;
    p.failure = { cls: classifyGoogleError(error), error };
    p.settled = true;
  }
}

/** A calendar's outcome when the lists end or the deadline fires. */
function outcomeOf(p: CalendarProgress, deadlineMs: number): Outcome {
  if (p.failure) return { calendarId: p.calendarId, kind: 'failed', ...p.failure };
  if (p.settled || p.pages > 0) {
    return { calendarId: p.calendarId, kind: 'ok', items: [...p.items], truncated: p.truncated || !p.settled };
  }
  return {
    calendarId: p.calendarId,
    kind: 'failed',
    cls: 'transient',
    error: new Error(`Google sent no page of this calendar within the ${deadlineMs} ms deadline`),
  };
}

function errorReason(cls: ErrorClass): 'transient' | 'config' | 'unknown' {
  return cls === 'transient' || cls === 'config' ? cls : 'unknown';
}

/** The token step's failure decides the whole half; a token-step 404 is not a gone calendar. */
function tokenStepRead(error: unknown): GoogleRead {
  const cls = classifyGoogleError(error);
  if (cls === 'scopes') return { status: 'reconnect', reason: 'scopes' };
  if (cls === 'token') return { status: 'reconnect', reason: 'token' };
  return { status: 'error', reason: errorReason(cls), cause: error };
}

/** Spec §2.5 "Source status", steps 2-5. `set` is in the same order as `outcomes`. */
function readOf(outcomes: Outcome[], set: readonly CalendarAssignment[]): GoogleRead {
  const failures = outcomes.filter((o): o is Failure => o.kind === 'failed');
  if (failures.some(f => f.cls === 'scopes')) return { status: 'reconnect', reason: 'scopes' };
  if (failures.some(f => f.cls === 'token')) return { status: 'reconnect', reason: 'token' };
  const goneIds = failures.filter(f => f.cls === 'gone').map(f => f.calendarId);
  if (goneIds.length === outcomes.length) return { status: 'error', reason: 'calendars_gone' };
  const failed = failures.filter(f => f.cls !== 'gone');
  if (failed.length === outcomes.length - goneIds.length) {
    return { status: 'error', reason: errorReason(failed[0].cls), cause: failed[0].error };
  }
  const truncated = outcomes.filter(o => o.kind === 'ok' && o.truncated).length;
  return {
    status: 'ok',
    calendars: set.map(a => googleCalendarRef(a, goneIds)),
    goneIds,
    partial: failed.length || truncated ? { failed: failed.length, truncated } : null,
    stale: false,
  };
}

/** Runs reporting off the read's path: it never delays, changes or fails a read. */
function inBackground(what: string, task: () => Promise<void>): void {
  task().catch(err => console.warn(`[${LOG_CONTEXT}] ${what} failed:`, err));
}

/**
 * A Sentry warning when chosen calendars are gone, at most once per user per day. Without
 * Redis it warns anyway: a lost warning hides a broken setup, an extra one costs nothing.
 */
function warnGoneOnce(userId: number, gone: number, chosen: number): void {
  inBackground('gone warning', async () => {
    let first = true;
    try {
      first = (await redis.set(REDIS_KEYS.gcalGoneWarned(userId), '1', { nx: true, ex: GONE_WARNING_TTL_S })) === 'OK';
    } catch (err) {
      console.warn(`[${LOG_CONTEXT}] gone-warning gate unavailable:`, err);
    }
    if (first) {
      captureWarning(
        `${gone} of ${chosen} chosen Google calendars are gone (deleted, unshared or on another account)`,
        LOG_CONTEXT,
        { user_id: userId, gone, chosen },
      );
    }
  });
}

/**
 * One admin notice an hour for an OAuth client Google rejects: a wrong server secret
 * breaks every Google user at once. Without Redis there is no notice (the error capture
 * still goes out), so an outage of both never pages the admin once per read.
 */
function alertConfigOnce(error: unknown): void {
  inBackground('config alert', async () => {
    const first = (await redis.set(REDIS_KEYS.gcalConfigAlert(), '1', { nx: true, ex: CONFIG_ALERT_TTL_S })) === 'OK';
    if (!first) return;
    const { notifyAdminError } = await import('../../utils/error-notifier');
    await notifyAdminError(
      'Google Calendar read',
      error,
      'Google rejected the OAuth client (invalid_client or unauthorized_client), so every Google user is affected. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    );
  });
}

/** Spec §2.5 "Logging": failures as warnings, config as an error plus the hourly notice, gone once a day. */
function report(userId: number, failures: readonly { cls: ErrorClass; error: unknown }[], chosen: number): void {
  let alerted = false;
  for (const f of failures) {
    if (f.cls === 'gone') continue;
    if (f.cls === 'config') {
      captureError(f.error, LOG_CONTEXT, { user_id: userId }, 'error');
      if (!alerted) alertConfigOnce(f.error);
      alerted = true;
    } else {
      captureError(f.error, LOG_CONTEXT, { user_id: userId }, 'warning');
    }
  }
  const gone = failures.filter(f => f.cls === 'gone').length;
  if (gone > 0) warnGoneOnce(userId, gone, chosen);
}

function timedOut(userId: number, deadlineMs: number, stage: 'token' | 'lists'): GoogleReadResult {
  captureError(
    new Error(`Google read passed its ${deadlineMs} ms deadline in the ${stage} step`),
    LOG_CONTEXT,
    { user_id: userId, stage },
    'warning',
  );
  return { read: { status: 'error', reason: 'timeout' }, items: [] };
}

/**
 * One live read of the user's chosen Google calendars over [window.from, window.to), with
 * no cache (spec §2.5). It never rejects: every outcome is a GoogleRead, and an unexpected
 * throw is error('unknown'). The caller decides whether Google applies (sourcesFor); this
 * only looks at the token and the choices.
 */
export async function readGoogleUncached(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: GoogleReadOptions,
): Promise<GoogleReadResult> {
  const token = user.googleRefreshToken;
  if (!token) return { read: { status: 'reconnect', reason: 'token' }, items: [] };
  const set = googleCalendarSet(user, opts.calendarIds);
  if (set.length === 0) {
    return { read: { status: 'ok', calendars: [], goneIds: [], partial: null, stale: false }, items: [] };
  }

  const deadline = startDeadline(opts.deadlineMs);
  try {
    const auth = getGoogleAuth(token);
    type Step = { kind: 'ok' } | { kind: 'failed'; error: unknown } | { kind: 'deadline' };
    const step: Step = await Promise.race([
      auth.getAccessToken().then(
        (): Step => ({ kind: 'ok' }),
        (error: unknown): Step => ({ kind: 'failed', error }),
      ),
      deadline.reached.then((): Step => ({ kind: 'deadline' })),
    ]);
    if (step.kind === 'deadline') return timedOut(user.id, opts.deadlineMs, 'token');
    if (step.kind === 'failed') {
      const cls = classifyGoogleError(step.error);
      // A 404 from the token endpoint is not a gone calendar: it is reported as any failure.
      report(user.id, [{ cls: cls === 'gone' ? 'unknown' : cls, error: step.error }], set.length);
      return { read: tokenStepRead(step.error), items: [] };
    }

    const cal = googleCalendar({ version: 'v3', auth });
    const timeoutMs = Math.min(MAX_REQUEST_TIMEOUT_MS, opts.deadlineMs - DEADLINE_MARGIN_MS);
    const progress: CalendarProgress[] = set.map(a => ({
      calendarId: a.calendarId,
      pages: 0,
      received: 0,
      items: [],
      truncated: false,
      failure: null,
      settled: false,
    }));
    await Promise.race([
      Promise.all(progress.map(p => listCalendar(cal, p, window, opts.tz, timeoutMs, deadline))),
      deadline.reached,
    ]);
    if (deadline.expired() && !progress.some(p => p.settled || p.pages > 0)) {
      return timedOut(user.id, opts.deadlineMs, 'lists');
    }

    const outcomes = progress.map(p => outcomeOf(p, opts.deadlineMs));
    report(user.id, outcomes.filter((o): o is Failure => o.kind === 'failed'), set.length);
    const read = readOf(outcomes, set);
    if (read.status !== 'ok') return { read, items: [] };

    // Calendars in the order of the choices, then a stable sort by start, as calendar.ts:159.
    const items = outcomes.flatMap(o => (o.kind === 'ok' ? o.items : []));
    items.sort((a, b) => new Date(a.event.start).getTime() - new Date(b.event.start).getTime());
    return { read, items: attachGoogleCalendars(items, set, read.goneIds) };
  } catch (error) {
    // Nothing above should throw; if something does, the half reports it and still answers.
    captureError(error, LOG_CONTEXT, { user_id: user.id }, 'error');
    return { read: { status: 'error', reason: 'unknown', cause: error }, items: [] };
  } finally {
    deadline.clear();
  }
}

/**
 * The Google half for readRange (spec §2.5). In this task it is the live read; Task B7 puts
 * the route's cache in front of it and adds opts.googleCache and opts.defer.
 */
export function readGoogle(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: GoogleReadOptions,
): Promise<GoogleReadResult> {
  return readGoogleUncached(user, window, opts);
}
