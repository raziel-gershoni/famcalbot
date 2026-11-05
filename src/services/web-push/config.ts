/**
 * Browser notifications' setup (spec docs/superpowers/specs/2026-11-05-web-push-design.md §3.9): the VAPID key pair,
 * read from the environment at each call (never NEXT_PUBLIC_, never at build), FamCal's contact claim, and the push
 * services a browser's subscription may point at. Push stays off until both keys are set: the props' key is null, the
 * routes answer 503, the senders skip, and production startup warns (startup-checks.ts pushSetupWarnings).
 * The private key leaves this file only through vapidKeys (send.ts signs with it). Server only.
 */

import { SELLER } from '../../lib/seller';

export const PUSH_ENV = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] as const;

/** The VAPID variables that are unset or blank, in PUSH_ENV's order: the one rule pushConfigured and the startup warning read. */
export function missingPushEnv(env: Record<string, string | undefined> = process.env): string[] {
  return PUSH_ENV.filter((name) => !env[name]?.trim());
}

export function pushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return missingPushEnv(env).length === 0;
}

/** The public key the browser subscribes with, or null while push is off. */
export function vapidPublicKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return pushConfigured(env) ? env.VAPID_PUBLIC_KEY!.trim() : null;
}

/** Both keys, for signing (send.ts), or null while push is off. */
export function vapidKeys(env: NodeJS.ProcessEnv = process.env): { publicKey: string; privateKey: string } | null {
  if (!pushConfigured(env)) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY!.trim(), privateKey: env.VAPID_PRIVATE_KEY!.trim() };
}

/** The contact the push services see in every VAPID token: FamCal's own address (Apple refuses a localhost one). */
export function vapidSubject(): string {
  return `mailto:${SELLER.email}`;
}

/**
 * The push services a device's endpoint may point at, by host (the host itself, or one under it): Google's FCM (Chrome,
 * Edge on Android, Brave, Opera, Samsung Internet), Apple's (Safari, iPhone and iPad), Mozilla's (Firefox) and
 * Microsoft's WNS (Edge on Windows). The server POSTs to every stored endpoint, so one anywhere else is refused
 * (devices.ts isValidDeviceInput). src/lib/sentry-scrub.ts scrubs the paths of these hosts; scripts/smoke-sentry-scrub.ts
 * holds the two lists together.
 */
export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'] as const;

/** An https URL of a known push service, on the default port, with no user name or password. */
export function isPushServiceUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((service) => host === service || host.endsWith(`.${service}`));
}
