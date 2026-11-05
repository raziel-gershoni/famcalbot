/**
 * The one sender of FamCal's browser notifications (spec docs/superpowers/specs/2026-11-05-web-push-design.md §3.4,
 * §3.6).
 *
 *   sendWebPush(user, input)            one notification to every device of the account: the devices read at send
 *                                       time (devicesForSend), each request built and encrypted by web-push
 *                                       (generateRequestDetails, never its own sender) and POSTed through
 *                                       fetchWithRetry, the one loop for third parties, FCM included (CLAUDE.md).
 *                                       Never throws; one log line, "[push] user <id>: <kind> sent to N of M devices"
 *   pushTtlSeconds(user, kind, now)     how long a push may wait at the push service: the kind's lifetime, an alert's
 *                                       event start, and for a scheduled kind the next Shabbat or Yom Tov window;
 *                                       never over a day
 *
 * A transport: it does not ask the pause. Each scheduled caller asks `isPaused` before it calls this
 * (scripts/smoke-pause.ts lists this file as not paused), and the lifetime makes a waiting push expire before the
 * next window opens.
 *
 * Answers: any 2xx is sent; 404 and 410 delete the device; 429, 5xx and no answer are retried by the loop, and a
 * give-up makes the result retriable; 401 and 403 (the keys don't match the subscription) are logged each time and
 * reported once a day per device; 400, 413 and any other status are a bug in our request, logged and reported.
 *
 * The VAPID header is made once an hour per push service (Apple asks for no more) and kept on globalThis (Next 16 gives
 * the scheduler and the routes separate module instances). No console line or Sentry field holds an endpoint, a key, a
 * title or a body: the user id, the kind, the device id, counts and the status. Server only.
 */

import { generateRequestDetails, getVapidHeaders } from 'web-push';
import { captureError } from '../../lib/error-capture';
import { fetchWithRetry, HttpStatusError } from '../../utils/fetch-retry';
import { SafeSignInError, safeErrorSummary } from '../web-signin/safe-error';
import { nextPauseStart, type PauseUser } from '../zmanim/pause';
import { vapidKeys, vapidSubject } from './config';
import { deleteGoneDevice, devicesForSend, type StoredDevice } from './devices';
import { buildPushPayload, topicFor, type PushMessage } from './payload';

export type PushKind = 'reminder' | 'alert' | 'briefing' | 'partner-accepted' | 'partner-done' | 'reconnect' | 'test';

/** How long each kind may wait at the push service for a device that is off, in seconds (spec §3.6). */
export const PUSH_LIFETIME_S: Record<PushKind, number> = {
  reminder: 3600,
  alert: 86_400,
  briefing: 10_800,
  'partner-accepted': 86_400,
  'partner-done': 86_400,
  reconnect: 86_400,
  test: 600,
};

/** RFC 8030 Urgency: high for reminders and alerts, low for the partner's Done, normal for the rest (spec §3.4). */
export const PUSH_URGENCY: Record<PushKind, 'high' | 'normal' | 'low'> = {
  reminder: 'high',
  alert: 'high',
  briefing: 'normal',
  'partner-accepted': 'normal',
  'partner-done': 'low',
  reconnect: 'normal',
  test: 'normal',
};

/** The scheduled kinds: their callers ask the pause, and their lifetime ends before the next window. */
export const PAUSED_KINDS: readonly PushKind[] = ['reminder', 'alert', 'briefing', 'reconnect'];

/** No push waits longer than a day (spec §3.6, the Policy's "within a day"). */
export const MAX_PUSH_TTL_S = 86_400;

/** The pause's fields of the person (their place and switch); id required. */
export type PushUser = PauseUser;

export interface PushSendInput extends PushMessage {
  kind: PushKind;
  /** An alert's event start: the lifetime never passes it. */
  until?: Date;
  /** Only this device (the "Notifications are on" reply goes to the browser that just turned them on). */
  onlyEndpoint?: string;
}

/**
 * sent: devices that took it; total: devices tried. retriable: none took it and one answered 429 or 5xx or nothing
 * (the loop gave up), or the devices could not be read: a passing failure, so a reminder's claim is let go.
 */
export interface PushSendResult {
  sent: number;
  total: number;
  retriable: boolean;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface KeptVapid {
  authorization: string;
  publicKey: string;
  madeAt: number;
}
const shared = globalThis as { __pushVapidByOrigin?: Map<string, KeptVapid>; __pushAuthReportedOn?: Map<string, number> };
/** The hour's VAPID header per push service origin. */
const vapidByOrigin: Map<string, KeptVapid> = (shared.__pushVapidByOrigin ??= new Map());
/** The UTC day a device's 401/403 was last reported to Sentry. */
const authReportedOn: Map<string, number> = (shared.__pushAuthReportedOn ??= new Map());

/** Smoke scripts only: forgets the kept VAPID headers and the once-a-day reports. */
export function __resetPushForTests(): void {
  vapidByOrigin.clear();
  authReportedOn.clear();
}

export async function pushTtlSeconds(user: PushUser, kind: PushKind, now: Date, until?: Date): Promise<number> {
  let ttl = Math.min(PUSH_LIFETIME_S[kind], MAX_PUSH_TTL_S);
  if (until) ttl = Math.min(ttl, Math.floor((until.getTime() - now.getTime()) / 1000));
  if (ttl > 0 && PAUSED_KINDS.includes(kind)) {
    const start = await nextPauseStart(user, now, ttl * 1000);
    if (start) ttl = Math.min(ttl, Math.floor((start.getTime() - now.getTime()) / 1000));
  }
  return Math.max(1, ttl);
}

/** The hour's VAPID Authorization for this endpoint's push service, made anew after an hour or a key change. */
function vapidAuthorization(endpoint: string, keys: { publicKey: string; privateKey: string }, nowMs: number): string {
  const origin = new URL(endpoint).origin;
  const kept = vapidByOrigin.get(origin);
  if (kept && kept.publicKey === keys.publicKey && nowMs - kept.madeAt < HOUR_MS) return kept.authorization;
  // The token is good for 12 hours (the library's default, at most 24): an hour's reuse is well inside it
  const { Authorization } = getVapidHeaders(origin, vapidSubject(), keys.publicKey, keys.privateKey, 'aes128gcm');
  vapidByOrigin.set(origin, { authorization: Authorization, publicKey: keys.publicKey, madeAt: nowMs });
  return Authorization;
}

type Outcome = 'sent' | 'gone' | 'retriable' | 'refused';

async function sendToDevice(
  user: PushUser,
  kind: PushKind,
  device: StoredDevice,
  payload: string,
  options: { ttl: number; topic: string; urgency: 'high' | 'normal' | 'low' },
  keys: { publicKey: string; privateKey: string },
  now: Date,
): Promise<Outcome> {
  const who = `[push] user ${user.id}: ${kind} to device ${device.id}`;
  let request: { endpoint: string; headers: Record<string, string>; body: Buffer | null };
  try {
    const details = generateRequestDetails(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      payload,
      // No VAPID details given to the library: the Authorization is the hour's kept one (given them, it signs a token per call)
      {
        TTL: options.ttl,
        urgency: options.urgency,
        topic: options.topic,
        contentEncoding: 'aes128gcm',
        headers: { Authorization: vapidAuthorization(device.endpoint, keys, now.getTime()) },
      },
    );
    // fetch sets Content-Length from the body itself; the library gives TTL and the length as numbers
    const headers = Object.fromEntries(
      Object.entries(details.headers)
        .filter(([name]) => name.toLowerCase() !== 'content-length')
        .map(([name, value]) => [name, String(value)]),
    );
    request = { endpoint: details.endpoint, headers, body: details.body };
  } catch (error) {
    // web-push's own messages name the problem (a key's length, the subject), never a key or the endpoint
    const why = error instanceof Error ? error.message : safeErrorSummary(error);
    console.error(`${who} could not be built: ${why}`);
    captureError(new SafeSignInError(`push-send: ${why}`), 'push-send', { user_id: user.id, kind, device_id: device.id, purpose: 'build' });
    return 'refused';
  }
  try {
    const response = await fetchWithRetry(
      request.endpoint,
      { method: 'POST', headers: request.headers, body: request.body ? new Uint8Array(request.body) : undefined },
      {
        label: who,
        // A refusal is told below; a give-up of 429, 5xx or no answer is told here
        onGiveUp: (error, { why }) => {
          if (why !== 'not retryable') console.warn(`${who} not delivered (${why}): ${safeErrorSummary(error)}`);
        },
      },
    );
    // The answer's body is of no use: free the connection
    response.body?.cancel().catch((error: unknown) => console.warn(`${who}: could not drop the answer's body: ${safeErrorSummary(error)}`));
    return 'sent';
  } catch (error) {
    const status = error instanceof HttpStatusError ? error.status : null;
    if (status === 404 || status === 410) {
      console.log(`${who}: the push service says it is gone (${status}); deleting the device`);
      await deleteGoneDevice(device.id);
      return 'gone';
    }
    if (status === null || status === 429 || status >= 500) return 'retriable';
    if (status === 401 || status === 403) {
      console.error(`${who}: refused (${status}): the VAPID keys don't match this device's subscription`);
      const day = Math.floor(now.getTime() / DAY_MS);
      if (authReportedOn.get(device.id) !== day) {
        authReportedOn.set(device.id, day);
        captureError(new SafeSignInError(`push-send: HTTP ${status}`), 'push-send', { user_id: user.id, kind, device_id: device.id, status });
      }
      return 'refused';
    }
    console.error(`${who}: refused (${status}): the request is wrong`);
    captureError(new SafeSignInError(`push-send: HTTP ${status}`), 'push-send', { user_id: user.id, kind, device_id: device.id, status });
    return 'refused';
  }
}

/** Sends one notification to every device of the account (see the header). Never throws. */
export async function sendWebPush(user: PushUser, input: PushSendInput, now: Date = new Date()): Promise<PushSendResult> {
  const { kind } = input;
  const keys = vapidKeys();
  if (!keys) {
    console.log(`[push] user ${user.id}: ${kind} not sent: browser notifications are off (no VAPID keys)`);
    return { sent: 0, total: 0, retriable: false };
  }
  try {
    const all = await devicesForSend(user.id);
    const devices = input.onlyEndpoint === undefined ? all : all.filter((d) => d.endpoint === input.onlyEndpoint);
    if (devices.length === 0) {
      console.log(`[push] user ${user.id}: ${kind} sent to 0 of 0 devices`);
      return { sent: 0, total: 0, retriable: false };
    }
    const ttl = await pushTtlSeconds(user, kind, now, input.until);
    const payload = buildPushPayload(input);
    const options = { ttl, topic: topicFor(input.tag), urgency: PUSH_URGENCY[kind] };
    const outcomes = await Promise.all(devices.map((device) => sendToDevice(user, kind, device, payload, options, keys, now)));
    const sent = outcomes.filter((outcome) => outcome === 'sent').length;
    console.log(`[push] user ${user.id}: ${kind} sent to ${sent} of ${devices.length} devices`);
    return { sent, total: devices.length, retriable: sent === 0 && outcomes.includes('retriable') };
  } catch (error) {
    // The device read (the database) or a bug: a passing failure, told by its kind only
    console.error(`[push] user ${user.id}: ${kind} not sent: ${safeErrorSummary(error)}`);
    captureError(new SafeSignInError(`push-send: ${safeErrorSummary(error)}`), 'push-send', { user_id: user.id, kind });
    return { sent: 0, total: 0, retriable: true };
  }
}
