/**
 * Secrets the app refuses to work without, checked once at startup (instrumentation.ts)
 * so a missing or reused one is named in the deploy log, in Sentry and in the deploy
 * message, instead of failing quietly request by request. Pure: env in, problems out.
 * A message names the variable, never its value.
 */

import { isUsableEncryptionKey } from '../utils/encryption';

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
    problems.push({ name: 'SESSION_SECRET', message: 'SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused', missing: true });
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
