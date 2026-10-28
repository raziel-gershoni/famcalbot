/**
 * Secrets never reach the server's logs. A Telegram error (node-telegram-bot-api's TelegramError) keeps the HTTP response,
 * and its request's path holds `/bot<token>/<method>`, so any `console.error('...', error)` of one printed the bot token in
 * the Railway logs; a Prisma error can carry the database URL. Rather than trust every catch in the codebase, the server
 * installs this once at startup (instrumentation.ts): each console line is formatted as Node formats it, then every secret
 * value of the environment is replaced. Sentry has its own scrubber (sentry-scrub.ts).
 */

import { formatWithOptions } from 'util';

const REDACTED = '[redacted]';

/**
 * Environment names whose values are secrets: tokens, keys, passwords and the database URLs. A new secret must be named
 * to match (…_TOKEN, …_SECRET, …_API_KEY, …), or its value is not scrubbed from the logs.
 */
const SECRET_NAME = /TOKEN(?!S)|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|CREDENTIALS|DATABASE_URL|DIRECT_URL|REDIS_URL/i;

/** The secret values of an environment, longest first (so one that contains another is replaced whole). Short values are left: they would match ordinary text. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 12)
    .map(([, value]) => value as string);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** `text` with every secret value replaced. */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Wraps the console's methods so each line is written with the secrets taken out. Installed once per process; a second
 * call does nothing. With no secrets in the environment, nothing is wrapped.
 */
export function installConsoleScrub(env: NodeJS.ProcessEnv = process.env, target: ConsoleLike = console): void {
  const marked = target as ConsoleLike & { __secretsScrubbed?: boolean };
  if (marked.__secretsScrubbed) return;
  const secrets = secretValues(env);
  // Names only, never values: which secrets the logs are kept clear of, and any too short to scrub safely
  const named = Object.keys(env).filter((name) => SECRET_NAME.test(name) && typeof env[name] === 'string' && env[name] !== '');
  const short = named.filter((name) => (env[name] as string).length < 12);
  target.info(`[console-scrub] ${secrets.length ? 'scrubbing' : 'nothing to scrub:'} ${named.filter((n) => !short.includes(n)).join(', ') || 'no secret-named variables'}${short.length ? `; too short to scrub: ${short.join(', ')}` : ''}`);
  if (secrets.length === 0) return;
  for (const level of LEVELS) {
    const write = target[level].bind(target);
    target[level] = (...args: unknown[]) => write(scrubText(formatWithOptions({ colors: false }, ...args), secrets));
  }
  marked.__secretsScrubbed = true;
}
