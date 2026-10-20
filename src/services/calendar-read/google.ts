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
 * - The range route's reads (opts.colours) also ask calendarList, in parallel with the
 *   lists, for each chosen calendar's colour as Google has it now (spec 2026-10-19 §3.1):
 *   choices saved before colours were kept have none, and a colour changed in Google
 *   since is stale. A calendar's colour is the live one, then the saved one, then null.
 *   The call shares the deadline and the cancel; a failed or late one keeps the saved
 *   colours and never changes the read's outcome. The summaries never ask.
 * - One deadline covers all of it. What settled keeps its outcome; a calendar that got a
 *   page by then is truncated, one that got none failed. When the read answers, whatever
 *   is still running is cancelled (a stuck token server's request, lists past the
 *   deadline), so nothing outlives the answer.
 *
 * readGoogleUncached is the live read. readGoogle is what readRange calls: the live read
 * for the summaries ('bypass'), and for the range route the cache in front of it (spec
 * §2.6, at the end of this file). stampGoogleCache invalidates a user's cached reads after
 * a write to Google, a reconnect, or a read that ends in reconnect or calendars_gone.
 */

import crypto from 'crypto';
import { calendar as googleCalendar } from '@googleapis/calendar';
import type { calendar_v3 } from '@googleapis/calendar';
import { Redis } from '@upstash/redis';
import { getGoogleAuth } from '../calendar';
import { clearRecurrenceCacheForUser } from '../recurrence-cache';
import { classifyGoogleError, keepGoogleEvent, mapGoogleEvent } from './google-map';
import { captureError, captureWarning } from '../../lib/error-capture';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import type { CalendarAssignment, UserConfig } from '../../types';
import type { CalendarRef, GoogleRead, ReadItem, ReadRangeOptions } from './types';
import { liveGoogleChoices } from '../../lib/google-state';

/** A Google item before its calendar is joined. This is what B7's cache stores. */
export type GoogleItem = Omit<ReadItem, 'calendar'>;

export interface GoogleReadOptions {
  tz: string;                          // the user's resolveUserTimezone; Google writes times in it
  calendarIds?: readonly string[];     // summary callers: the ids they resolved, narrowed to the choices
  deadlineMs: number;                  // covers the token step, the lists and the paging (spec §2.2)
  colours?: boolean;                   // also ask calendarList for the live colours; the range route's reads only
}

/** Live calendar colours by calendar id: '#rrggbb', lower case, the read's set only. */
export type LiveColours = Readonly<Record<string, string>>;

export interface GoogleReadResult {
  read: GoogleRead;
  items: ReadItem[];                   // empty unless read.status is 'ok'
  colours?: LiveColours;               // when asked for and calendarList answered in time
}

type ErrorClass = ReturnType<typeof classifyGoogleError>;

const LOG_CONTEXT = 'calendar-read-google';
const FIELDS =
  'summary,nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,eventType,attendees(self,responseStatus),htmlLink)';
const PAGE_SIZE = 2500;
const MAX_ITEMS_PER_CALENDAR = 5000;
const MAX_REQUEST_TIMEOUT_MS = 10_000;
/** No request is given less than this, however short the deadline; the deadline still cuts it off. */
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const DEADLINE_MARGIN_MS = 500;
/** calendarList's page: one page covers any real list; a calendar past it keeps its saved colour. */
const COLOUR_LIST_SIZE = 250;
const COLOUR_FIELDS = 'items(id,backgroundColor)';
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const GONE_WARNING_TTL_S = 86_400;
const CONFIG_ALERT_TTL_S = 3_600;

/**
 * The calendars a read covers: the user's choices (liveGoogleChoices, A-3) in their own
 * order, narrowed to calendarIds when given. Ids never come from the client. A repeated id
 * is read once.
 */
export function googleCalendarSet(
  user: Pick<UserConfig, 'googleRefreshToken' | 'calendarSource' | 'calendarAssignments'>,
  calendarIds?: readonly string[],
): CalendarAssignment[] {
  const wanted = calendarIds ? new Set(calendarIds) : null;
  const seen = new Set<string>();
  return liveGoogleChoices(user).filter(a => {
    if (!a?.calendarId || seen.has(a.calendarId) || (wanted && !wanted.has(a.calendarId))) return false;
    seen.add(a.calendarId);
    return true;
  });
}

/**
 * What the UI may show about a chosen calendar: its saved name, its colour (Google's live
 * one when the read has it, else the saved one), whether it is the user's own (not
 * labelled spouse), the spouse's name, and whether it is gone. Per-event colorId is
 * ignored (spec 2026-10-16 §2.5).
 */
export function googleCalendarRef(a: CalendarAssignment, goneIds: readonly string[], colours?: LiveColours): CalendarRef {
  const spouse = (a.labels ?? []).includes('spouse');
  const live = colours && Object.hasOwn(colours, a.calendarId) ? colours[a.calendarId] : undefined;
  const ref: CalendarRef = {
    id: a.calendarId,
    source: 'google',
    name: a.name || a.calendarId,
    color: (typeof live === 'string' && HEX_COLOUR.test(live) ? live : null) ?? (a.color || null),
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
  colours?: LiveColours,
): ReadItem[] {
  const refs = new Map(set.map(a => [a.calendarId, googleCalendarRef(a, goneIds, colours)]));
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

/**
 * The set's colours as Google has them now: one calendarList page, hidden calendars
 * included (a chosen calendar can be hidden in Google). Only the set's calendars are
 * kept, and only '#rrggbb'. Never rejects: a failure is a console warning and undefined
 * (a cosmetic miss is not worth a Sentry event per read), and after the deadline it
 * changes nothing.
 */
async function listColours(
  cal: calendar_v3.Calendar,
  set: readonly CalendarAssignment[],
  timeoutMs: number,
  deadline: Deadline,
): Promise<LiveColours | undefined> {
  try {
    const res = await cal.calendarList.list(
      { maxResults: COLOUR_LIST_SIZE, showHidden: true, fields: COLOUR_FIELDS },
      { timeout: timeoutMs, retryConfig: { retry: 1, noResponseRetries: 0 } },
    );
    if (deadline.expired()) return undefined;
    const wanted = new Set(set.map(a => a.calendarId));
    const colours: Record<string, string> = {};
    for (const entry of res.data.items ?? []) {
      if (entry?.id && wanted.has(entry.id) && typeof entry.backgroundColor === 'string' && HEX_COLOUR.test(entry.backgroundColor)) {
        colours[entry.id] = entry.backgroundColor.toLowerCase();
      }
    }
    return colours;
  } catch (error) {
    if (!deadline.expired()) console.warn(`[${LOG_CONTEXT}] calendar colours unavailable:`, classifyGoogleError(error));
    return undefined;
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
function readOf(outcomes: Outcome[], set: readonly CalendarAssignment[], colours?: LiveColours): GoogleRead {
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
    calendars: set.map(a => googleCalendarRef(a, goneIds, colours)),
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
  // Aborted when the read answers (the finally below). Every request of this read carries
  // it: a token request a stuck token server never answers, or a list still waiting at the
  // deadline, is cancelled then and not retried, so nothing keeps running after the read
  // has answered. The token request's own timeout is the deadline (the lists set theirs).
  const cancel = new AbortController();
  try {
    const auth = getGoogleAuth(token, { timeout: opts.deadlineMs, signal: cancel.signal });
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
    const timeoutMs = Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, opts.deadlineMs - DEADLINE_MARGIN_MS));
    const progress: CalendarProgress[] = set.map(a => ({
      calendarId: a.calendarId,
      pages: 0,
      received: 0,
      items: [],
      truncated: false,
      failure: null,
      settled: false,
    }));
    let colours: LiveColours | undefined;
    const colourList = opts.colours
      ? listColours(cal, set, timeoutMs, deadline).then(c => {
          colours = c;
        })
      : null;
    await Promise.race([
      Promise.all([...progress.map(p => listCalendar(cal, p, window, opts.tz, timeoutMs, deadline)), colourList]),
      deadline.reached,
    ]);
    if (deadline.expired() && !progress.some(p => p.settled || p.pages > 0)) {
      return timedOut(user.id, opts.deadlineMs, 'lists');
    }

    const outcomes = progress.map(p => outcomeOf(p, opts.deadlineMs));
    report(user.id, outcomes.filter((o): o is Failure => o.kind === 'failed'), set.length);
    const read = readOf(outcomes, set, colours);
    if (read.status !== 'ok') return { read, items: [] };

    // Calendars in the order of the choices, then a stable sort by start, as calendar.ts:159.
    const items = outcomes.flatMap(o => (o.kind === 'ok' ? o.items : []));
    items.sort((a, b) => new Date(a.event.start).getTime() - new Date(b.event.start).getTime());
    const result: GoogleReadResult = { read, items: attachGoogleCalendars(items, set, read.goneIds, colours) };
    if (colours) result.colours = colours;
    return result;
  } catch (error) {
    // Nothing above should throw; if something does, the half reports it and still answers.
    captureError(error, LOG_CONTEXT, { user_id: user.id }, 'error');
    return { read: { status: 'error', reason: 'unknown', cause: error }, items: [] };
  } finally {
    deadline.clear();
    cancel.abort();
  }
}

// ---- The range route's cache (spec §2.6) ----
//
// One entry per user, calendar set, timezone and window: { startedAt, items, goneIds,
// colours? }, the items without their calendar, which is joined from the user's choices
// on every read, so a relabel shows at once; the live colours its read got (spec
// 2026-10-19 §3.1) go with it and die with it. An entry without them (one written before
// they were kept, or after calendarList failed) joins the saved colours. An entry is valid only while its startedAt is later
// than the user's stamp. startedAt is taken before Google is asked, so a read that began
// before a write and landed after it is never served.
//
// The reads in flight and the last write per key live on globalThis: the scheduler and
// the routes are separate bundles (Next 16), each with its own module instances.
//
// Redis errors fail open: a miss, no write, a warning. The summaries never come here.

const CACHE_LOG_CONTEXT = 'calendar-read-google-cache';
const STAMP_LOG_CONTEXT = 'calendar-read-google-stamp';
/** An entry younger than this is served as it is. */
const FRESH_MS = 3 * 60_000;
/** Older than FRESH_MS and younger than this: served stale, with one background refresh. */
const STALE_MS = 30 * 60_000;
const ENTRY_TTL_S = 1_800;
/** Longer than any entry lives. */
const STAMP_TTL_S = 3_600;
const MAX_ENTRY_BYTES = 512 * 1024;
/** fresh=1 is honoured once per this, per user and window. */
const FRESH_LIMIT_S = 30;
const REFRESH_DEADLINE_MS = 6_000;
const STAMP_TIMEOUT_MS = 750;

/** The cached read's own Redis calls (the fresh limit, the entry read, the entry write) wait this long; the shared client retries for seconds. */
const CACHE_TIMEOUT_MS = 750;

/** p, or a rejection once CACHE_TIMEOUT_MS has passed; the caller falls back to the uncached read. */
async function withinCacheTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`The Google cache took over ${CACHE_TIMEOUT_MS} ms`)), CACHE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** readGoogle's options: the live read's, plus the cache's (ReadRangeOptions, spec §2.2). */
export interface GoogleHalfOptions extends GoogleReadOptions {
  googleCache?: ReadRangeOptions['googleCache'];   // default 'bypass'; only the range route passes 'use' or 'refresh'
  defer?: ReadRangeOptions['defer'];               // runs a stale entry's refresh; the route passes after()
}

/** What the cache keeps under a key. */
interface CacheEntry {
  startedAt: number;
  items: GoogleItem[];
  goneIds: string[];
  colours?: LiveColours;
}

/** A live read in flight for a key. */
interface Flight {
  startedAt: number;
  promise: Promise<GoogleReadResult>;
}

/** One cached read: who, which window, which calendars, under which key. */
interface CachedRead {
  user: UserConfig;
  window: { from: Date; to: Date };
  live: GoogleReadOptions;
  set: CalendarAssignment[];
  key: string;
  defer?: ReadRangeOptions['defer'];
}

const cacheState = globalThis as { __gcalInflight?: Map<string, Flight>; __gcalWritten?: Map<string, number> };
/** The newest read in flight per key. */
const inflight: Map<string, Flight> = (cacheState.__gcalInflight ??= new Map());
/** The startedAt of the last write per key, kept 30 minutes. */
const lastWrite: Map<string, number> = (cacheState.__gcalWritten ??= new Map());

/** The first 16 hex digits of sha256 over the sorted calendar ids, which are often email addresses. */
function calendarSetHash(calendarIds: readonly string[]): string {
  return crypto.createHash('sha256').update([...calendarIds].sort().join('\n')).digest('hex').slice(0, 16);
}

/** The stamp as Upstash returns it (a number, or a string). Unreadable invalidates everything. */
function stampValue(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const at = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

/** An entry as Upstash returns it (parsed JSON, or a string); anything else is a miss. */
function entryValue(raw: unknown): CacheEntry | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const e = value as Partial<CacheEntry>;
  if (typeof e.startedAt !== 'number' || !Array.isArray(e.items) || !Array.isArray(e.goneIds)) return null;
  // Unreadable colours cost the colours, not the entry: the saved ones are joined instead.
  const colours = e.colours && typeof e.colours === 'object' && !Array.isArray(e.colours) ? e.colours : undefined;
  return { startedAt: e.startedAt, items: e.items, goneIds: e.goneIds, ...(colours ? { colours } : {}) };
}

/** A valid entry as a read, its calendars joined from today's choices. */
function fromEntry(entry: CacheEntry, set: readonly CalendarAssignment[], stale: boolean): GoogleReadResult {
  return {
    read: {
      status: 'ok',
      calendars: set.map(a => googleCalendarRef(a, entry.goneIds, entry.colours)),
      goneIds: entry.goneIds,
      partial: null,
      stale,
    },
    items: attachGoogleCalendars(entry.items, set, entry.goneIds, entry.colours),
  };
}

function withoutCalendar({ calendar: _calendar, ...item }: ReadItem): GoogleItem {
  return item;
}

function rememberWrite(key: string, startedAt: number): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [k, at] of lastWrite) if (at < cutoff) lastWrite.delete(k);
  lastWrite.set(key, startedAt);
}

/**
 * After a live read: a dead token or no calendar left stamps the user's entries, so a
 * stale entry never hides it; a whole ok read (partial null) is written, gone calendars
 * and all. Only the newest read writes: none that started later may still be in flight
 * or have written already.
 */
async function afterRead(r: CachedRead, flight: Flight, result: GoogleReadResult): Promise<void> {
  const { read } = result;
  if (read.status === 'reconnect' || (read.status === 'error' && read.reason === 'calendars_gone')) {
    await stampGoogleCache(r.user.id);
    return;
  }
  if (read.status !== 'ok' || read.partial) return;
  const current = inflight.get(r.key);
  if (current && current !== flight && current.startedAt > flight.startedAt) return;
  const last = lastWrite.get(r.key);
  if (last !== undefined && last >= flight.startedAt) return;
  const entry: CacheEntry = { startedAt: flight.startedAt, items: result.items.map(withoutCalendar), goneIds: read.goneIds };
  if (result.colours) entry.colours = result.colours;
  const value = JSON.stringify(entry);
  if (Buffer.byteLength(value, 'utf8') > MAX_ENTRY_BYTES) return;
  rememberWrite(r.key, flight.startedAt);
  try {
    await withinCacheTimeout(redis.set(r.key, value, { ex: ENTRY_TTL_S }));
  } catch (err) {
    captureError(err, CACHE_LOG_CONTEXT, { user_id: r.user.id }, 'warning');
  }
}

async function runFlight(r: CachedRead, flight: Flight, deadlineMs: number): Promise<GoogleReadResult> {
  try {
    const result = await readGoogleUncached(r.user, r.window, { ...r.live, deadlineMs });
    await afterRead(r, flight, result);
    return result;
  } finally {
    // A newer read for the key may have taken the slot; it is not this read's to remove.
    if (inflight.get(r.key) === flight) inflight.delete(r.key);
  }
}

/** Starts a live read and puts it in flight. Its first step awaits Google, so it is in the map before its finally runs. */
function startRead(r: CachedRead, deadlineMs: number): Promise<GoogleReadResult> {
  const flight = { startedAt: Date.now() } as Flight;
  flight.promise = runFlight(r, flight, deadlineMs);
  inflight.set(r.key, flight);
  return flight.promise;
}

/**
 * A stale entry's refresh, after the response when the caller can defer it. One at a time
 * per key: a read already in flight since the stamp will write. It never rejects.
 */
function refreshInBackground(r: CachedRead, stamp: number): void {
  const task = async () => {
    const flight = inflight.get(r.key);
    if (flight && flight.startedAt > stamp) return;
    await startRead(r, REFRESH_DEADLINE_MS);
  };
  const run = () => task().catch(err => captureError(err, CACHE_LOG_CONTEXT, { user_id: r.user.id }, 'warning'));
  if (!r.defer) {
    void run();
    return;
  }
  try {
    r.defer(run);
  } catch (err) {
    captureError(err, CACHE_LOG_CONTEXT, { user_id: r.user.id }, 'warning');
    void run();
  }
}

/**
 * The Google half for readRange (spec §2.5, §2.6). 'bypass', the default and every
 * summary's, is the live read. The range route passes 'use', or 'refresh' for fresh=1,
 * and reads through the cache. An empty token or no chosen calendar never reaches Google,
 * so it never reads the cache either (§2.5 steps 1 and 2).
 */
export async function readGoogle(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: GoogleHalfOptions,
): Promise<GoogleReadResult> {
  const mode = opts.googleCache ?? 'bypass';
  const set = googleCalendarSet(user, opts.calendarIds);
  if (mode === 'bypass' || !user.googleRefreshToken || set.length === 0) {
    return readGoogleUncached(user, window, { tz: opts.tz, calendarIds: opts.calendarIds, deadlineMs: opts.deadlineMs });
  }
  // The range route's reads, live or cached, carry the calendars' live colours.
  const live: GoogleReadOptions = { tz: opts.tz, calendarIds: opts.calendarIds, deadlineMs: opts.deadlineMs, colours: true };

  const arrivedAt = Date.now();
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const key = REDIS_KEYS.gcalRange(user.id, calendarSetHash(set.map(a => a.calendarId)), opts.tz, from, to);
  const r: CachedRead = { user, window, live, set, key, defer: opts.defer };

  let refresh: boolean;
  let stamp: number;
  let entry: CacheEntry | null;
  try {
    // fresh=1 once per 30 s per user and window; past that it reads as 'use'.
    refresh = mode === 'refresh'
      && (await withinCacheTimeout(redis.set(REDIS_KEYS.gcalFresh(user.id, from, to), 1, { nx: true, ex: FRESH_LIMIT_S }))) === 'OK';
    const [rawStamp, rawEntry] = await withinCacheTimeout(redis.mget<[unknown, unknown]>(REDIS_KEYS.gcalStamp(user.id), key));
    stamp = stampValue(rawStamp);
    entry = entryValue(rawEntry);
  } catch (err) {
    captureError(err, CACHE_LOG_CONTEXT, { user_id: user.id }, 'warning');
    return readGoogleUncached(user, window, live);
  }

  if (!refresh && entry && entry.startedAt > stamp) {
    const age = arrivedAt - entry.startedAt;
    if (age < FRESH_MS) return fromEntry(entry, set, false);
    if (age < STALE_MS) {
      refreshInBackground(r, stamp);
      return fromEntry(entry, set, true);
    }
  }

  // Join the read in flight unless a stamp came after it started; a refresh joins only a
  // read that started once it had arrived.
  const flight = inflight.get(key);
  if (flight && flight.startedAt > stamp && (!refresh || flight.startedAt >= arrivedAt)) return flight.promise;
  return startRead(r, opts.deadlineMs);
}

// ---- The stamp ----

let stampClient: Redis | undefined;

/**
 * The stamp's own client: one attempt per command (in @upstash/redis 1.35, `retry: false`
 * still makes two) and each request aborted at 750 ms, so a slow Redis can't hold up a
 * write to Google.
 */
function stampRedis(): Redis {
  stampClient ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    retry: { retries: 0 },
    signal: () => AbortSignal.timeout(STAMP_TIMEOUT_MS),
  });
  return stampClient;
}

/**
 * Invalidates every cached Google read of the user (spec §2.6) and drops their weekly
 * recurrence answers (§8.3). Called after each bot write to Google (google-provider.ts),
 * after a reconnect (google-connect.ts), and by a cached read ('use', 'refresh' or a
 * stale entry's refresh) that ends in reconnect or calendars_gone. A 'bypass' read, every
 * summary's, never stamps. It never throws or rejects, and takes at most 750 ms: a lost
 * stamp means at worst three minutes of pre-write data on the home.
 */
export async function stampGoogleCache(userId: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    clearRecurrenceCacheForUser(userId);
    const write = stampRedis().set(REDIS_KEYS.gcalStamp(userId), Date.now(), { ex: STAMP_TTL_S });
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), STAMP_TIMEOUT_MS);
    });
    if ((await Promise.race([write, late])) === 'late') {
      captureError(new Error(`The Google cache stamp took over ${STAMP_TIMEOUT_MS} ms`), STAMP_LOG_CONTEXT, { user_id: userId }, 'warning');
    }
  } catch (err) {
    captureError(err, STAMP_LOG_CONTEXT, { user_id: userId }, 'warning');
  } finally {
    clearTimeout(timer);
  }
}
