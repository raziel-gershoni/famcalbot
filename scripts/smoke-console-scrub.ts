// Smoke test: no secret value of the environment reaches the server's logs.
//
// An HTTP client's error that keeps the response (its request path is `/bot<token>/<method>`), or a failed Bot API call
// whose cause names the request URL, would print the bot token in the Railway logs. instrumentation.ts installs
// src/lib/console-scrub.ts once at startup; this checks that a line written through it carries no secret, whatever the
// arguments, and that it is installed at startup.
//
// Nothing is faked but the console the scrub wraps: no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-console-scrub.ts

import fs from 'fs';
import path from 'path';
import { installConsoleScrub, secretValues, scrubText, withoutHttpResponse } from '../src/lib/console-scrub';
import { tgNoAnswer } from './lib/fake-telegram';

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

const show = (value: unknown) => JSON.stringify(value);

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

/** An HTTP client's error that keeps the response, with the request whose path holds the token. */
function httpClientError(message: string, response: object) {
  return Object.assign(new Error(message), { code: 'ETELEGRAM', response });
}
function telegramError() {
  const request = { method: 'POST', path: `/bot${BOT_TOKEN}/setChatMenuButton`, href: `https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton` };
  return httpClientError('ETELEGRAM: 400 Bad Request: chat not found', { statusCode: 400, body: { ok: false, description: 'Bad Request: chat not found' }, request });
}

check('the secrets are the values of secret-named variables, long enough to be secrets; others are left', () => {
  const secrets = secretValues(ENV);
  assert(secrets.includes(BOT_TOKEN) && secrets.includes(DB_URL) && secrets.includes('cron-secret-of-the-smoke'), `missing: ${JSON.stringify(secrets)}`);
  assert(!secrets.includes('production') && !secrets.includes('FamCalBot_of_the_smoke') && !secrets.includes('abc'), `not a secret: ${JSON.stringify(secrets)}`);
});

check('a logged HTTP client error that keeps the response prints no bot token, but still says what went wrong', () => {
  const { target, lines } = capturedConsole();
  target.error('[set-menu-button] Setting the menu button failed:', telegramError());
  const line = lines.join('\n');
  assert(!line.includes(BOT_TOKEN), `the token is in the log:\n${line}`);
  assert(line.includes('chat not found') && line.includes('ETELEGRAM') && line.includes('400'), `the line lost its meaning:\n${line}`);
});

check('a logged HTTP client error prints none of the request it sent (a message\'s text, a guest query\'s id), only its name, code, status and message', () => {
  const request = { method: 'POST', path: '/bot0/answerGuestQuery', body: 'guest_query_id=GQ-SENTINEL-77&result=%7B%22message_text%22%3A%22Dinner%20at%20Grandma%22%7D' };
  const error = httpClientError('ETELEGRAM: 400 Bad Request: query is too old', { statusCode: 400, body: { ok: false, description: 'Bad Request: query is too old' }, request });
  const { target, lines } = capturedConsole();
  target.error('[ask-in-chat]', error);
  target.warn('a failed send:', error, { user: 1 });
  const line = lines.join('\n');
  assert(!line.includes('GQ-SENTINEL-77') && !line.includes('Dinner') && !line.includes('answerGuestQuery'), `the request is in the log:\n${line}`);
  assert(line.includes('[ETELEGRAM] (HTTP 400): ETELEGRAM: 400 Bad Request: query is too old'), `the line lost its meaning:\n${line}`);
  const plain = new Error('no response here');
  assert(withoutHttpResponse(plain) === plain && withoutHttpResponse('text') === 'text', 'an error with no response, or a non-error, is changed');
});

check('a logged Bot API network failure whose cause names the request URL prints no bot token, but still says what went wrong', () => {
  const error = tgNoAnswer('answerGuestQuery', `request to https://api.telegram.org/bot${BOT_TOKEN}/answerGuestQuery failed`);
  assert(String((error as Error & { cause?: unknown }).cause).includes(BOT_TOKEN), 'the fake lost the token it must carry');
  const { target, lines } = capturedConsole();
  target.error('[ask-in-chat] answerGuestQuery failed:', error);
  const line = lines.join('\n');
  assert(!line.includes(BOT_TOKEN), `the token is in the log:\n${line}`);
  assert(line.includes('EFETCH') && line.includes('Network request failed: answerGuestQuery'), `the line lost its meaning:\n${line}`);
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

check('[guard] the web sign-in secrets are named to be scrubbed: TELEGRAM_LOGIN_CLIENT_SECRET, GOOGLE_SIGNIN_CLIENT_SECRET, RESEND_API_KEY; their client ids are not secrets', () => {
  const env = {
    TELEGRAM_LOGIN_CLIENT_SECRET: 'tg-login-secret-of-the-smoke',
    GOOGLE_SIGNIN_CLIENT_SECRET: 'GOCSPX-signin-secret-of-the-smoke',
    RESEND_API_KEY: 're_resend_key_of_the_smoke_123',
    TELEGRAM_LOGIN_CLIENT_ID: '1234567890123',
    GOOGLE_SIGNIN_CLIENT_ID: '123-abc.apps.googleusercontent.com',
  } as unknown as NodeJS.ProcessEnv;
  const secrets = secretValues(env);
  assert(show(secrets.slice().sort()) === show([env.GOOGLE_SIGNIN_CLIENT_SECRET, env.RESEND_API_KEY, env.TELEGRAM_LOGIN_CLIENT_SECRET].sort()), `secrets: ${show(secrets)}`);
});

check('[guard] every environment variable the app reads that names a credential (…SECRET, …TOKEN, …KEY, …PASSWORD, …CREDENTIALS) is one the scrub covers', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(path.join(ROOT, dir))) return;
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(rel);
    }
  };
  for (const dir of ['src', 'app', 'components', 'i18n']) walk(dir);
  for (const file of fs.readdirSync(ROOT)) if (/\.(ts|js|mjs)$/.test(file)) files.push(file);
  const names = new Set<string>();
  for (const file of files) {
    for (const m of fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/process\.env(?:\.|\[\s*['"])([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  }
  assert(names.size > 10, `only ${names.size} names found`);
  const credential = /SECRET|TOKEN(?!S)|(^|_)KEY(_|$)|PASSWORD|CREDENTIALS/;
  // Public by design: Cloudflare Turnstile's site key, which every sign-in page shows to the browser (6c-1 Task 3)
  const PUBLIC_KEYS = ['TURNSTILE_SITE_KEY'];
  const unscrubbed = [...names].filter((name) => !PUBLIC_KEYS.includes(name) && credential.test(name) && secretValues({ [name]: 'x'.repeat(24) } as unknown as NodeJS.ProcessEnv).length === 0);
  assert(unscrubbed.length === 0, `named like a credential but not scrubbed: ${unscrubbed.join(', ')}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.reason ? `\n      ${r.reason}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
