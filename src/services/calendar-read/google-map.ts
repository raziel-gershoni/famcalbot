// The calendar reader's pure Google rules (spec §2.5): which error is which, which
// events are kept, and how a Google event becomes a ReadItem. No I/O and no Google
// client at run time (the calendar_v3 import is a type), so google.ts and the smokes
// share one copy of the rules.

import type { calendar_v3 } from '@googleapis/calendar';
import { htmlToText } from '../../utils/html';
import { isInsufficientScopesError } from '../../utils/errors';
import type { ReadItem } from './types';
import { isSyncCopy } from '../google-sync/markers';

/**
 * - scopes: the user unticked a permission on Google's consent screen;
 * - token: the refresh token is dead (revoked, expired, blocked by an admin);
 * - config: Google rejects our OAuth client, which breaks every user;
 * - gone: the calendar was deleted or unshared, or is on another account;
 * - transient: rate limits, timeouts, Google's own failures, the network;
 * - forbidden: any other 403, Google refusing this one write or read (a read-only
 *   calendar, an event the user doesn't organize, an organizer that can't change);
 * - unknown: anything else.
 */
export type GoogleErrorClass = 'scopes' | 'token' | 'config' | 'gone' | 'transient' | 'forbidden' | 'unknown';

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);

/** What the Google client's errors carry (gaxios GaxiosError, after google-auth-library's processError). */
interface GoogleErrorShape {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  type?: unknown;
  errors?: unknown;
  response?: { status?: unknown; data?: unknown } | null;
  error?: { name?: unknown; type?: unknown } | null;
}

/** The token endpoint's OAuth error ('invalid_grant', ...), when the body carries one. */
function oauthError(data: unknown): string | undefined {
  const error = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
  return typeof error === 'string' ? error : undefined;
}

/** The HTTP status: the error's, else the response's, else a numeric code (an API error body's). */
function httpStatus(err: GoogleErrorShape): number | undefined {
  for (const s of [err.status, err.response?.status, err.code]) if (typeof s === 'number') return s;
  return undefined;
}

/**
 * What a Google error says, for a log line: its HTTP status, the API's reasons and Google's
 * own message. Never the request it carried (a write's body holds the title).
 */
export function googleErrorFacts(e: unknown): { status?: number; reasons: string[]; message: string } {
  if (!e || typeof e !== 'object') return { reasons: [], message: String(e) };
  const err = e as GoogleErrorShape & { message?: unknown };
  return { status: httpStatus(err), reasons: errorReasons(err), message: typeof err.message === 'string' ? err.message : '' };
}

/** Google's reasons for a token that lacks a scope (the 403 the grant-write flow fixes). */
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

/** The Calendar API's error reasons ('rateLimitExceeded', ...). */
function errorReasons(err: GoogleErrorShape): string[] {
  const data = err.response?.data;
  const body = data && typeof data === 'object' ? (data as { error?: { errors?: unknown } }).error : undefined;
  const list = Array.isArray(err.errors) ? err.errors : body && typeof body === 'object' && Array.isArray(body.errors) ? body.errors : [];
  return list.map((x: unknown) => (x && typeof x === 'object' ? (x as { reason?: unknown }).reason : undefined)).filter((r): r is string => typeof r === 'string');
}

/**
 * Sorts a Google error into the class that decides the source's status (spec §2.5).
 * The OAuth strings come before the status: Google's token endpoint sends invalid_client,
 * and often unauthorized_client, with HTTP 401. The writes (calendar.ts, 3b spec §3.2)
 * map every class to a result; the reader treats 'forbidden' as 'unknown'. The status is
 * err.status ?? err.response?.status ?? err.code.
 */
export function classifyGoogleError(e: unknown): GoogleErrorClass {
  if (isInsufficientScopesError(e)) return 'scopes';
  if (!e || typeof e !== 'object') return 'unknown';
  const err = e as GoogleErrorShape;
  if (httpStatus(err) === 403 && errorReasons(err).some((r) => SCOPE_REASONS.has(r))) return 'scopes';
  const oauth = oauthError(err.response?.data);
  if (oauth === 'invalid_grant' || oauth === 'admin_policy_enforced') return 'token';
  if (oauth === 'invalid_client' || oauth === 'unauthorized_client') return 'config';
  const status = httpStatus(err);
  if (status === 401) return 'token';
  if (status === 404 || status === 410) return 'gone';
  if (status === 403 && errorReasons(err).some((r) => RATE_LIMIT_REASONS.has(r))) return 'transient';
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return 'transient';
  // gaxios keeps the fetch error it wraps on `error`: node-fetch's request-timeout and AbortError.
  const cause = err.error && typeof err.error === 'object' ? err.error : undefined;
  if (!err.response && (typeof err.code === 'string' || err.type === 'request-timeout' || cause?.type === 'request-timeout')) return 'transient';
  if (err.name === 'AbortError' || cause?.name === 'AbortError') return 'transient';
  if (status === 403) return 'forbidden';
  return 'unknown';
}

/** Not events: Google's work-status blocks (Ruling R1). Every other type is kept, birthdays included. */
const DROPPED_EVENT_TYPES = new Set(['workingLocation', 'outOfOffice', 'focusTime']);

/**
 * Whether a listed Google event is shown. Drops cancelled ones, ones with no start, the
 * work-status types, invites the calendar's owner declined (Ruling R2: `self` is the
 * calendar this copy sits on, so on a spouse's calendar it is the spouse's decline), and
 * FamCal's own copies to Google (google-sync spec §2: their FamCal series is shown already).
 */
export function keepGoogleEvent(raw: calendar_v3.Schema$Event): boolean {
  if (raw.status === 'cancelled') return false;
  if (isSyncCopy(raw)) return false;
  if (!raw.start?.dateTime && !raw.start?.date) return false;
  if (raw.eventType && DROPPED_EVENT_TYPES.has(raw.eventType)) return false;
  if (raw.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return false;
  return true;
}

/**
 * A Google event as the reader's item, without its calendar (google.ts joins that from
 * the assignment at read time). `event` is today's day mapper (calendar.ts fetchEvents)
 * plus the provider tag, without `reminders`, and with the description as plain text.
 */
export function mapGoogleEvent(raw: calendar_v3.Schema$Event, calendarId: string, calendarName: string): Omit<ReadItem, 'calendar'> {
  return {
    source: 'google',
    key: `google|${calendarId}|${raw.id ?? ''}`,
    event: {
      summary: raw.summary || 'No title',
      start: raw.start?.dateTime || raw.start?.date || '',
      end: raw.end?.dateTime || raw.end?.date || '',
      description: htmlToText(raw.description) || undefined,
      location: raw.location || undefined,
      calendarName,
      calendarId,
      eventType: raw.eventType || undefined,
      recurringEventId: raw.recurringEventId || undefined,
      eventId: raw.id || undefined,
      provider: 'google',
    },
    title: raw.summary ?? null,
    kind: 'event',
    seriesId: raw.recurringEventId ?? null,
    originalStart: raw.originalStartTime?.dateTime ?? raw.originalStartTime?.date ?? null,
    recurring: Boolean(raw.recurringEventId),
    rrule: null,
    hebrewRule: null,
    hebrewAnchor: null,
    google: { birthday: raw.eventType === 'birthday', htmlLink: raw.htmlLink ?? null },
  };
}
