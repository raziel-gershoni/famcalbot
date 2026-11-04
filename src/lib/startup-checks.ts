/**
 * Secrets the app refuses to work without, checked once at startup (instrumentation.ts)
 * so a missing or reused one is named in the deploy log, in Sentry and in the deploy
 * message, instead of failing quietly request by request. Pure: env in, problems out.
 * A message names the variable, never its value.
 */

import { isUsableEncryptionKey } from '../utils/encryption';
import { googleSignInUsesCalendarClient } from '../services/web-signin/client-ids';

export interface StartupProblem {
  /** The variable at fault */
  name: string;
  /** One log line, without the [startup] prefix */
  message: string;
  /** No usable value (unset, empty or malformed): the deploy message lists these as missing */
  missing?: true;
}

export function startupSecretProblems(env: Record<string, string | undefined>): StartupProblem[] {
  const problems: StartupProblem[] = [];
  if (!isUsableEncryptionKey(env.ENCRYPTION_KEY)) {
    problems.push({ name: 'ENCRYPTION_KEY', message: "ENCRYPTION_KEY is missing or not 64 hex characters: Google tokens can't be read or saved", missing: true });
  }
  if (!env.SESSION_SECRET) {
    problems.push({ name: 'SESSION_SECRET', message: 'SESSION_SECRET is not set: web sign-in and share-story image links are refused', missing: true });
  }
  if (!env.WHATSAPP_APP_SECRET) {
    problems.push({ name: 'WHATSAPP_APP_SECRET', message: 'WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)', missing: true });
  }
  // app/api/webhook/route.ts answers every Telegram update with a 500 while it is unset
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    problems.push({ name: 'TELEGRAM_WEBHOOK_SECRET', message: 'TELEGRAM_WEBHOOK_SECRET is not set: every Telegram update is refused (500)', missing: true });
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET === env.CRON_SECRET) {
    problems.push({ name: 'SESSION_SECRET', message: 'SESSION_SECRET equals CRON_SECRET: give it its own value' });
  }
  return problems;
}

/**
 * The web sign-in ways and the variables each one needs (web sign-in spec §6), email sign-up's bot check (web sign-up
 * spec §6: Turnstile, turnstile.ts's turnstileConfigured) and Google sign-up's mail (signup-open.ts). The owner sets them after the deploy, and a way stays
 * hidden until its own are set (oidc.ts's providerConfigured, email-send.ts's emailConfigured), so an unset one is a
 * warning (signInSetupWarnings), never a StartupProblem: no Sentry capture, not "missing" in the deploy message.
 * `off` names what is off when it is not the way's sign-in.
 */
export const SIGN_IN_ENV: readonly { way: string; names: readonly string[]; off?: string }[] = [
  { way: 'Telegram', names: ['TELEGRAM_LOGIN_CLIENT_ID', 'TELEGRAM_LOGIN_CLIENT_SECRET'] },
  { way: 'Google', names: ['GOOGLE_SIGNIN_CLIENT_ID', 'GOOGLE_SIGNIN_CLIENT_SECRET'] },
  { way: 'an email code', names: ['RESEND_API_KEY'] },
  // Email sign-in works without it; sign-up by email waits for both
  { way: 'an email code', names: ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET'], off: 'web sign-up with an email code' },
  // Google sign-in works without it; sign-up with Google waits for it (a browser-only account's notices go only by
  // email; signup-open.ts)
  { way: 'Google', names: ['RESEND_API_KEY'], off: 'web sign-up with Google' },
];

/**
 * One line per web sign-in way that is off, naming its unset variables (never a value), and one for a Google sign-in
 * client that is the calendar client (oidc.ts keeps that way off: a calendar-client token must never sign anyone in).
 * Pure: env in, lines out.
 */
export function signInSetupWarnings(env: Record<string, string | undefined>): string[] {
  const warnings: string[] = [];
  for (const { way, names, off } of SIGN_IN_ENV) {
    const unset = names.filter((name) => !env[name]);
    if (unset.length > 0) warnings.push(`${off ?? `web sign-in with ${way}`} is off: ${unset.join(' and ')} ${unset.length > 1 ? 'are' : 'is'} not set`);
  }
  if (env.GOOGLE_SIGNIN_CLIENT_SECRET && googleSignInUsesCalendarClient(env.GOOGLE_SIGNIN_CLIENT_ID, env.GOOGLE_CLIENT_ID)) {
    warnings.push('web sign-in with Google is off: GOOGLE_SIGNIN_CLIENT_ID is the calendar client GOOGLE_CLIENT_ID; give sign-in its own Web client');
  }
  return warnings;
}

/**
 * One line for the startup log: the zone the server process runs in and whether it observes summer/winter
 * time. A cron job without a zone option follows it (node-cron), so the log shows whether "UTC" really is.
 * Reads the process zone on purpose; `now` only picks the year to look at.
 */
export function processZoneLine(now: Date = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const year = now.getUTCFullYear();
  const observes = new Date(Date.UTC(year, 0, 1)).getTimezoneOffset() !== new Date(Date.UTC(year, 6, 1)).getTimezoneOffset();
  return `process timezone ${zone}, summer/winter time ${observes ? 'observed' : 'not observed'}`;
}
