// Smoke test: no secret value of the environment reaches the server's logs.
//
// node-telegram-bot-api's TelegramError keeps the HTTP response, whose request path is `/bot<token>/<method>`, so a
// `console.error('...', error)` of one printed the bot token in the Railway logs. instrumentation.ts installs
// src/lib/console-scrub.ts once at startup; this checks that a line written through it carries no secret, whatever the
// arguments, and that it is installed at startup.
//
// Nothing is faked but the console the scrub wraps: no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-console-scrub.ts

import fs from 'fs';
import path from 'path';
import { installConsoleScrub, secretValues, scrubText } from '../src/lib/console-scrub';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const ROOT = path.resolve(__dirname, '..');
const BOT_TOKEN = '123456789:AAFakeTokenForTheSmokeOnly_abcdefghij';
const DB_URL = 'postgresql://famcal:sup3r-secret-pw@db.example.test:5432/famcal';
const ENV = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DATABASE_URL: DB_URL, CRON_SECRET: 'cron-secret-of-the-smoke', NODE_ENV: 'production', TELEGRAM_BOT_USERNAME: 'FamCalBot_of_the_smoke', SHORT_TOKEN: 'abc' } as unknown as NodeJS.ProcessEnv;

/** A console whose lines are kept, wrapped by the scrub as the real one is. */
function capturedConsole() {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const target = { log: keep, info: keep, warn: keep, error: keep, debug: keep };
  installConsoleScrub(ENV, target);
  const coverage = lines.splice(0);
  return { target, lines, coverage };
}

/** What node-telegram-bot-api throws for a refused call: the response with the request whose path holds the token. */
function telegramError() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TelegramError } = require('node-telegram-bot-api/src/errors.js');
  const request = { method: 'POST', path: `/bot${BOT_TOKEN}/setChatMenuButton`, href: `https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton` };
  return new TelegramError('ETELEGRAM: 400 Bad Request: chat not found', { statusCode: 400, body: { ok: false, description: 'Bad Request: chat not found' }, request });
}

check('the secrets are the values of secret-named variables, long enough to be secrets; others are left', () => {
  const secrets = secretValues(ENV);
  assert(secrets.includes(BOT_TOKEN) && secrets.includes(DB_URL) && secrets.includes('cron-secret-of-the-smoke'), `missing: ${JSON.stringify(secrets)}`);
  assert(!secrets.includes('production') && !secrets.includes('FamCalBot_of_the_smoke') && !secrets.includes('abc'), `not a secret: ${JSON.stringify(secrets)}`);
});

check('a logged Telegram error prints no bot token, but still says what went wrong', () => {
  const { target, lines } = capturedConsole();
  target.error('[set-menu-button] Setting the menu button failed:', telegramError());
  const line = lines.join('\n');
  assert(!line.includes(BOT_TOKEN), `the token is in the log:\n${line}`);
  assert(line.includes('chat not found') && line.includes('[redacted]'), `the line lost its meaning:\n${line}`);
});

check('every level, format strings and nested objects are scrubbed', () => {
  const { target, lines } = capturedConsole();
  target.log('connecting to %s', DB_URL);
  target.info({ deep: { deeper: { url: DB_URL } } });
  target.warn(`token=${BOT_TOKEN}`);
  target.debug(new Error(`failed with cron-secret-of-the-smoke`));
  assert(lines.length === 4, `expected 4 lines, got ${lines.length}`);
  for (const line of lines) assert(![BOT_TOKEN, DB_URL, 'cron-secret-of-the-smoke'].some((s) => line.includes(s)), `a secret in: ${line}`);
});

check('the scrub is installed once: a second install leaves the wrapped methods as they are', () => {
  const { target, lines } = capturedConsole();
  const before = { log: target.log, error: target.error };
  installConsoleScrub(ENV, target);
  assert(target.log === before.log && target.error === before.error, 'a second install wrapped the console again');
  target.error('plain line');
  assert(lines.length === 1 && lines[0] === 'plain line', JSON.stringify(lines));
});

check('the install says which secret names it covers, and which are too short, by name only, never a value', () => {
  const { coverage } = capturedConsole();
  const line = coverage.join('\n');
  assert(line.includes('[console-scrub]') && line.includes('TELEGRAM_BOT_TOKEN') && line.includes('DATABASE_URL') && line.includes('too short to scrub: SHORT_TOKEN'), line);
  assert(![BOT_TOKEN, DB_URL, 'cron-secret-of-the-smoke'].some((v) => line.includes(v)), `a value in the coverage line: ${line}`);
  assert(!/AI_MAX_TOKENS/.test(secretValues({ AI_MAX_TOKENS: '123456789012345' } as unknown as NodeJS.ProcessEnv).join()) && secretValues({ AI_MAX_TOKENS: '123456789012345' } as unknown as NodeJS.ProcessEnv).length === 0, 'a count of tokens is not a token');
});

check('a value that contains another is replaced whole', () => {
  assert(scrubText(`x ${DB_URL} y`, secretValues({ ...ENV, DIRECT_URL: 'sup3r-secret-pw' } as unknown as NodeJS.ProcessEnv)) === 'x [redacted] y', 'partial replacement');
});

check('the server installs it at startup, in the Node runtime, before the scheduler starts', () => {
  const source = fs.readFileSync(path.join(ROOT, 'instrumentation.ts'), 'utf8');
  const start = source.indexOf("if (process.env.NEXT_RUNTIME === 'nodejs') {");
  const scheduler = source.indexOf('startScheduler()', start);
  assert(start >= 0 && scheduler > start, 'the Node branch or the scheduler start is not where this check expects it');
  const branch = source.slice(start, scheduler).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert(/^\s+installConsoleScrub\(\);/m.test(branch), 'the console scrub is not installed in the Node branch before the scheduler');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.reason ? `\n      ${r.reason}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
