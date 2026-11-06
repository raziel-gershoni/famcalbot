// The browser's side of notifications (spec docs/superpowers/specs/2026-11-05-web-push-design.md §2.1, §2.4, §3.2, §3.3;
// plan 6c-2 Task 5): what the Settings card, the home's banner, the sign-outs and Remove a way (Task 6) ask of this browser.
// - pushSupport: 'ios-install' for an iPhone or an iPad in a browser tab (an iPad says it is a Mac, with touch points), where
//   notifications need FamCal added to the Home Screen (iOS 16.4 or later); 'unsupported' with no service workers, no
//   PushManager or no Notification; else 'supported'. The iPhone test comes first: a Safari tab has no PushManager.
// - turnOnPush (only from a tap): the worker's install (/sw.js at scope /, Task 4) and the permission prompt both start before
//   any await, so the prompt keeps the tap (Safari and Firefox ask only inside one); then the subscription (one the browser
//   holds is reused when it was made with FamCal's key) and POST /api/push/devices. A browser that wants a tap of its own for
//   the subscribe (NotAllowedError once the permission is granted) answers 'again'. Any answer but the server's ok undoes the
//   browser's subscription at once, so the browser never holds one the server refused (§2.1).
// - turnOffPush: the browser unsubscribes, then DELETE /api/push/devices with the endpoint. Without a user id (signInAgain)
//   only the browser: the server deletes the device when the push service answers "gone" at the next send.
// - checkPushOnOpen (every app open): reads the registration, never installs the worker; a subscription the server says isn't
//   this account's (an old account's, on a shared browser) is undone. No answer undoes nothing.
// - currentPushEndpoint: this browser's endpoint, for Remove a way (Task 6), which keeps this device.
// The routes take the account as every user route does (?user_id=, the DB id) and a browser's session only (no initData).
// Nothing here throws. A log line holds the tag, the step, a status, a known error code or an error's name: never an endpoint,
// a key or a body. Client-safe: two imports (one of them types only); nothing touches window at import.

import { readJsonBody } from '@/src/lib/read-json';
import type { PushPageProps } from '@/src/lib/web-push-props';

const TAG = '[web-push]';
const DEVICES = '/api/push/devices';
const CHECK = '/api/push/devices/check';
/** The worker Task 4 serves, and its scope. */
const WORKER_URL = '/sw.js';
const SCOPE = '/';
/** The routes' refusals (Task 3): the only error codes a log line may name. */
const KNOWN_ERRORS: readonly string[] = ['stale-sign-in', 'has-chat', 'push-off', 'bad-input'];

/**
 * Page-data's push (Settings and the home, Task 3): FamCal's public VAPID key (null while push is off), whether this session
 * proved its sign-in within the hour, and how many devices of the account have notifications on. Null inside Telegram and
 * for an account with a chat. The one type is Task 3's PushPageProps (src/lib/web-push-props.ts, types only); this is its
 * client-side name, never a second copy of the shape.
 */
export type PushProps = PushPageProps;

export type PushSupport = 'supported' | 'ios-install' | 'unsupported';

export type TurnOnResult = { ok: true; count: number } | { ok: false; reason: 'denied' | 'dismissed' | 'again' | 'stale' | 'refused' | 'failed' };

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** FamCal opened from the Home Screen (iOS's navigator.standalone, or the display mode the manifest asks for). */
function standalone(): boolean {
  try {
    if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  } catch (error) {
    console.warn(`${TAG} the display mode could not be read: ${errorName(error)}`);
    return false;
  }
}

/** Whether this browser can show FamCal's notifications here; read on the client only (the server's answer is 'unsupported'). */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  try {
    const nav = window.navigator;
    if (!nav) return 'unsupported';
    const ua = nav.userAgent ?? '';
    const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
    if (apple && !standalone()) return 'ios-install';
    return 'serviceWorker' in nav && 'PushManager' in window && 'Notification' in window ? 'supported' : 'unsupported';
  } catch (error) {
    console.warn(`${TAG} this browser's support could not be read: ${errorName(error)}`);
    return 'unsupported';
  }
}

/** The person blocked FamCal's notifications in this browser (no prompt can show; the site settings can undo it). */
export function pushBlocked(): boolean {
  try {
    return typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'denied';
  } catch (error) {
    console.warn(`${TAG} the permission could not be read: ${errorName(error)}`);
    return false;
  }
}

/** The key as the bytes subscribe() takes; null (logged) when it isn't base64url. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> | null {
  try {
    const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch (error) {
    console.error(`${TAG} the public key is not base64url: ${errorName(error)}`);
    return null;
  }
}

/** The subscription was made with this key (a browser that doesn't say is taken at its word: the key never changes, §3.9). */
function sameKey(subscription: PushSubscription, bytes: Uint8Array): boolean {
  const have = subscription.options?.applicationServerKey;
  if (!have) return true;
  const view = new Uint8Array(have);
  return view.length === bytes.length && view.every((b, i) => b === bytes[i]);
}

/** The registration once its worker is active (subscribe() needs one); null (logged) when the worker never installs. No timer of its own. */
function activated(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration | null> {
  if (registration.active) return Promise.resolve(registration);
  const worker = registration.installing ?? registration.waiting;
  if (!worker) {
    console.error(`${TAG} the registration has no worker`);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const settle = () => {
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', settle);
        resolve(registration);
      } else if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', settle);
        console.error(`${TAG} the worker did not install`);
        resolve(null);
      }
    };
    worker.addEventListener('statechange', settle);
    settle();
  });
}

/** The worker's registration, installed now when there is none (only turnOnPush calls this: an app open never installs it). Never rejects. */
async function registrationForPush(): Promise<ServiceWorkerRegistration | null> {
  try {
    const container = window.navigator.serviceWorker;
    const registration = (await container.getRegistration(SCOPE)) ?? (await container.register(WORKER_URL, { scope: SCOPE }));
    return await activated(registration);
  } catch (error) {
    console.error(`${TAG} the worker could not be installed: ${errorName(error)}`);
    return null;
  }
}

/** The subscription this browser holds for FamCal, or null (none, no worker, or a failure, logged). Never installs the worker. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof window === 'undefined') return null;
  try {
    const container = window.navigator?.serviceWorker;
    if (!container || !('PushManager' in window)) return null;
    const registration = await container.getRegistration(SCOPE);
    return registration ? await registration.pushManager.getSubscription() : null;
  } catch (error) {
    console.error(`${TAG} this browser's subscription could not be read: ${errorName(error)}`);
    return null;
  }
}

/** Unsubscribes this browser; whether it did (a refusal or a throw is logged). */
async function undo(subscription: PushSubscription): Promise<boolean> {
  try {
    const done = await subscription.unsubscribe();
    if (!done) console.warn(`${TAG} the browser kept its subscription`);
    return done;
  } catch (error) {
    console.error(`${TAG} unsubscribing failed: ${errorName(error)}`);
    return false;
  }
}

/** One request for the account (?user_id=): its status and body, or null when it got no answer (logged). */
async function send(method: 'POST' | 'DELETE', pathname: string, userId: number, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null } | null> {
  try {
    const res = await fetch(`${pathname}?user_id=${userId}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = await readJsonBody(res, `${TAG} ${method} ${pathname}`);
    if (!res.ok) {
      const code = typeof answer?.error === 'string' && KNOWN_ERRORS.includes(answer.error) ? answer.error : null;
      console.warn(`${TAG} ${method} ${pathname} answered ${res.status} (${code ?? 'no known code'})`);
    }
    return { status: res.status, ok: res.ok, body: answer };
  } catch (error) {
    console.error(`${TAG} ${method} ${pathname} got no answer: ${errorName(error)}`);
    return null;
  }
}

/** Turns this browser's notifications on for the account. Call it in the tap itself, synchronously: its first lines ask the browser. */
export async function turnOnPush(userId: number, key: string): Promise<TurnOnResult> {
  if (pushSupport() !== 'supported') {
    console.warn(`${TAG} turn on was asked where this browser can't show notifications`);
    return { ok: false, reason: 'failed' };
  }
  const notification = window.Notification;
  if (notification.permission === 'denied') {
    console.warn(`${TAG} notifications are blocked in this browser`);
    return { ok: false, reason: 'denied' };
  }
  // Both start here, in the tap, before any await: the prompt needs the tap, and the worker installs while it is up
  const registering = registrationForPush();
  let permission: NotificationPermission;
  try {
    permission = notification.permission === 'granted' ? 'granted' : (await notification.requestPermission()) || notification.permission;
  } catch (error) {
    console.error(`${TAG} the permission prompt failed: ${errorName(error)}`);
    permission = notification.permission;
  }
  const registration = await registering;
  if (permission === 'denied') {
    console.warn(`${TAG} the permission was refused`);
    return { ok: false, reason: 'denied' };
  }
  if (permission !== 'granted') {
    console.warn(`${TAG} the browser did not ask, or the prompt was closed (${permission})`);
    return { ok: false, reason: 'dismissed' };
  }
  const bytes = keyBytes(key);
  if (!registration || !bytes) return { ok: false, reason: 'failed' };

  let subscription: PushSubscription;
  try {
    const held = await registration.pushManager.getSubscription();
    if (held && !sameKey(held, bytes)) {
      // Made with another key: the push service would refuse every push to it, so it is made again
      console.warn(`${TAG} the browser's subscription has another key; it is made again`);
      await held.unsubscribe();
    }
    subscription = held && sameKey(held, bytes) ? held : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  } catch (error) {
    const name = errorName(error);
    if (name === 'NotAllowedError') {
      console.warn(`${TAG} the browser wants a tap of its own to subscribe (NotAllowedError)`);
      return { ok: false, reason: 'again' };
    }
    console.error(`${TAG} subscribing failed: ${name}`);
    return { ok: false, reason: 'failed' };
  }

  const keys = subscription.toJSON().keys;
  if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
    console.error(`${TAG} the subscription has no keys`);
    await undo(subscription);
    return { ok: false, reason: 'failed' };
  }
  const answer = await send('POST', DEVICES, userId, { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  if (answer?.ok && answer.body?.ok === true && typeof answer.body.count === 'number') return { ok: true, count: answer.body.count };
  // Refused or unanswered: the browser keeps no subscription the server may not hold
  await undo(subscription);
  if (answer && (answer.status === 401 || (answer.status === 403 && answer.body?.error === 'stale-sign-in'))) return { ok: false, reason: 'stale' };
  if (answer?.status === 409 && answer.body?.error === 'has-chat') return { ok: false, reason: 'refused' };
  return { ok: false, reason: 'failed' };
}

/**
 * Turns this browser's notifications off: it unsubscribes, then (with a user id) the device is deleted. True when this browser
 * gets no more notifications: it unsubscribed, or the server deleted its device. A failed DELETE is logged in send; the
 * device then goes at the next send, when the push service answers "gone". Nothing held: true, no request.
 */
export async function turnOffPush(userId: number | null): Promise<boolean> {
  const subscription = await currentSubscription();
  if (!subscription) return true;
  const endpoint = subscription.endpoint;
  const off = await undo(subscription);
  if (userId === null) return off;
  const answer = await send('DELETE', DEVICES, userId, { endpoint });
  return off || (answer?.ok === true && answer.body?.ok === true);
}

/** Every app open: whether this browser gets this account's notifications. Another account's subscription is undone; no answer undoes nothing. */
export async function checkPushOnOpen(userId: number): Promise<'on' | 'off'> {
  if (pushSupport() !== 'supported') return 'off';
  const subscription = await currentSubscription();
  if (!subscription) return 'off';
  const answer = await send('POST', CHECK, userId, { endpoint: subscription.endpoint });
  if (answer?.ok && answer.body?.ok === true && typeof answer.body.mine === 'boolean') {
    if (answer.body.mine) return 'on';
    console.warn(`${TAG} this browser's subscription is not this account's; undone`);
    await undo(subscription);
  }
  return 'off';
}

/** This browser's endpoint for FamCal, or null (Remove a way sends it, so this device stays: Task 6). Never installs the worker. */
export async function currentPushEndpoint(): Promise<string | null> {
  return (await currentSubscription())?.endpoint ?? null;
}
