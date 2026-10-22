// Smoke test for secret hygiene around the rotation (secret rotation spec, sections e.2
// and e.3; the source scan from its Testing section is in smoke-fail-closed.ts).
//
// - Sentry: the cron Authorization header and Telegram's webhook secret header, the
//   secret / sig / hub.verify_token query values, and the bot token Telegram API URLs
//   carry in their path (/bot<id>:<token>/) reached server events, transactions and
//   breadcrumbs. src/lib/sentry-scrub.ts now removes them, and the server config scrubs
//   breadcrumbs too.
// - scripts/setup-webhook.ts, the deploy-day command: no dotenv (the local .env is DEV),
//   both secrets required before any network call, the secret and the URL validated,
//   getMe first, getWebhookInfo after, and the token and the secret never printed. Its
//   parameter building is a pure export, and importing it runs nothing.
//
// Representative events go through the scrub functions; the Sentry configs are loaded
// with @sentry/nextjs replaced by a recorder of its init options; the Bot API is a fake
// caller and https.request is recorded. No network.
//
// Run: bash <scratchpad>/run-smoke.sh scripts/smoke-secret-hygiene.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

// ---- @sentry/nextjs replaced by a recorder of Sentry.init's options ----

const inits: Row[] = [];
(globalThis as Row).__sentryInits = inits;
const Module = nodeRequire('module');
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!file.includes(`${path.sep}@sentry${path.sep}nextjs${path.sep}`)) return nextLoad(url, context);
    return { format: 'module', source: 'export const init = (o) => { globalThis.__sentryInits.push(o); };', shortCircuit: true };
  },
});
const sentryEntry = nodeRequire.resolve('@sentry/nextjs');
const sentryStub = new Module(sentryEntry);
Object.assign(sentryStub, { filename: sentryEntry, loaded: true, exports: { init: (o: Row) => { inits.push(o); } } });
Module._cache[sentryEntry] = sentryStub;

// ---- Network guard: every https.request is recorded and refused ----

const httpsRequests: string[] = [];
const https = nodeRequire('https');
https.request = (url: unknown) => {
  httpsRequests.push(String(url).replace(/bot[^/]+/, 'bot<token>'));
  throw new Error('network call in a smoke');
};

// ---- Fixtures ----

const CRON = 'cron-s3cr3t-value';
const TG_SECRET = 'tg-hook-secret-1';
const BOT_TOKEN = '123456789:AAHfake_Bot-Token_value0123456789';
const SIG = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const VERIFY = 'meta-verify-token-1';

const leaks = (value: unknown): string[] => {
  const text = show(value);
  const found: string[] = [];
  for (const [name, secret] of [['cron secret', CRON], ['webhook secret', TG_SECRET], ['bot token', BOT_TOKEN],
    ['bot token (encoded)', BOT_TOKEN.replace(':', '%3A')], ['sig', SIG], ['verify token', VERIFY]] as [string, string][]) {
    if (text.includes(secret)) found.push(name);
  }
  if (/AAHfake/.test(text)) found.push('part of the bot token');
  return found;
};

async function main() {
  // The scrubber exists before the change; its new rules are what the checks pin.
  const scrub = await load('src/lib/sentry-scrub.ts');

  await check('#1 server event: the Authorization and X-Telegram-Bot-Api-Secret-Token headers are dropped (any case); other headers kept', () => {
    const out = scrub.scrubServerEvent({
      request: {
        method: 'POST',
        url: 'https://famcal.bot/api/webhook',
        headers: {
          host: 'famcal.bot',
          Authorization: `Bearer ${CRON}`,
          'X-Telegram-Bot-Api-Secret-Token': TG_SECRET,
          'content-type': 'application/json',
        },
      },
    });
    assert(leaks(out).length === 0, `leaks ${leaks(out).join(', ')}: ${show(out)}`);
    assert(show(out.request.headers) === show({ host: 'famcal.bot', 'content-type': 'application/json' }), `headers ${show(out.request.headers)}`);
  });

  await check('#2 server event: secret, sig and hub.verify_token query values scrubbed in url, query_string (string, object, pairs) and the nextjs request path; other values kept', () => {
    const query = `user_id=9&secret=${CRON}&sig=${SIG}&ts=1760000000&hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=ch-1&signal=on`;
    const want = 'user_id=9&secret=[scrubbed]&sig=[scrubbed]&ts=1760000000&hub.mode=subscribe&hub.verify_token=[scrubbed]&hub.challenge=ch-1&signal=on';
    const out = scrub.scrubServerEvent({
      request: { url: `https://famcal.bot/api/weather-image?${query}`, query_string: query },
      contexts: { nextjs: { request_path: `/api/weather-image?${query}` } },
    });
    assert(out.request.url === `https://famcal.bot/api/weather-image?${want}`, `url ${out.request.url}`);
    assert(out.request.query_string === want, `query_string ${out.request.query_string}`);
    assert(out.contexts.nextjs.request_path === `/api/weather-image?${want}`, `request_path ${out.contexts.nextjs.request_path}`);
    const obj = scrub.scrubServerEvent({ request: { query_string: { user_id: '9', secret: CRON, sig: SIG, 'hub.verify_token': VERIFY, ts: '1' } } }).request.query_string;
    assert(show(obj) === show({ user_id: '9', secret: '[scrubbed]', sig: '[scrubbed]', 'hub.verify_token': '[scrubbed]', ts: '1' }), `object ${show(obj)}`);
    const pairs = scrub.scrubServerEvent({ request: { query_string: [['user_id', '9'], ['sig', SIG], ['hub.verify_token', VERIFY]] } }).request.query_string;
    assert(show(pairs) === show([['user_id', '9'], ['sig', '[scrubbed]'], ['hub.verify_token', '[scrubbed]']]), `pairs ${show(pairs)}`);
  });

  await check('#3 a bot token in a URL path becomes /bot[scrubbed]/ (plain and %3A-encoded colon); the method and query stay', () => {
    const plain = scrub.scrubServerEvent({ request: { url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=9` } }).request.url;
    assert(plain === 'https://api.telegram.org/bot[scrubbed]/sendMessage?chat_id=9', `plain ${plain}`);
    const encoded = scrub.scrubServerEvent({ request: { url: `https://api.telegram.org/bot${BOT_TOKEN.replace(':', '%3A')}/getMe` } }).request.url;
    assert(encoded === 'https://api.telegram.org/bot[scrubbed]/getMe', `encoded ${encoded}`);
    const untouched = scrub.scrubServerEvent({ request: { url: 'https://famcal.bot/robots.txt?about=bots' } }).request.url;
    assert(untouched === 'https://famcal.bot/robots.txt?about=bots', `untouched ${untouched}`);
  });

  await check('#4 server transaction: span descriptions and URL attributes scrubbed; the secret header attributes dropped, in the trace context and in each span', () => {
    const data = (): Row => ({
      'http.method': 'POST',
      'http.request.header.authorization': `Bearer ${CRON}`,
      'http.request.header.x_telegram_bot_api_secret_token': TG_SECRET,
      'http.request.header.x-telegram-bot-api-secret-token': TG_SECRET,
      'http.request.header.user_agent': 'TelegramBot',
      'url.full': `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      'http.url': `https://famcal.bot/api/reminders?secret=${CRON}`,
    });
    const out = scrub.scrubServerTransaction({
      type: 'transaction',
      contexts: { trace: { trace_id: 't', span_id: 's', data: data() } },
      spans: [{ span_id: 'a', description: `POST https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, data: data() }],
    });
    assert(leaks(out).length === 0, `leaks ${leaks(out).join(', ')}: ${show(out)}`);
    for (const [where, d] of [['trace', out.contexts.trace.data], ['span', out.spans[0].data]] as [string, Row][]) {
      const keys = Object.keys(d).sort();
      assert(show(keys) === show(['http.method', 'http.request.header.user_agent', 'http.url', 'url.full']), `${where} keys ${show(keys)}`);
      assert(d['url.full'] === 'https://api.telegram.org/bot[scrubbed]/sendMessage', `${where} url.full ${d['url.full']}`);
      assert(d['http.url'] === 'https://famcal.bot/api/reminders?secret=[scrubbed]', `${where} http.url ${d['http.url']}`);
    }
    assert(out.spans[0].description === 'POST https://api.telegram.org/bot[scrubbed]/sendMessage', `description ${out.spans[0].description}`);
  });

  await check('#5 the server config scrubs breadcrumbs: http/fetch URLs and messages lose the bot token and secret query values; other fields kept', async () => {
    inits.length = 0;
    await load('sentry.server.config.ts');
    assert(inits.length === 1, `Sentry.init calls: ${inits.length}`);
    const before = inits[0].beforeBreadcrumb;
    assert(typeof before === 'function', 'sentry.server.config.ts has no beforeBreadcrumb');
    const http = before({ category: 'http', type: 'http', data: { url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, method: 'POST', status_code: 200 } }, {});
    assert(show(http) === show({ category: 'http', type: 'http', data: { url: 'https://api.telegram.org/bot[scrubbed]/sendMessage', method: 'POST', status_code: 200 } }), `http ${show(http)}`);
    const fetchCrumb = before({ category: 'fetch', data: { url: `https://famcal.bot/api/weather-image?user_id=9&sig=${SIG}`, method: 'GET' } }, {});
    assert(fetchCrumb.data.url === 'https://famcal.bot/api/weather-image?user_id=9&sig=[scrubbed]', `fetch ${show(fetchCrumb)}`);
    const consoleCrumb = before({ category: 'console', message: `request to https://api.telegram.org/bot${BOT_TOKEN}/getMe failed`, data: { arguments: ['x'] } }, {});
    assert(consoleCrumb.message === 'request to https://api.telegram.org/bot[scrubbed]/getMe failed', `console ${show(consoleCrumb)}`);
    assert(show(consoleCrumb.data) === show({ arguments: ['x'] }), `console data ${show(consoleCrumb.data)}`);
  });

  // ---- scripts/setup-webhook.ts ----

  const exits: unknown[] = [];
  const realExit = process.exit;
  let hook: Row = {};
  try {
    process.exit = ((code?: number) => { exits.push(code); throw new Error(`process.exit(${code}) during import`); }) as typeof process.exit;
    hook = await load('scripts/setup-webhook.ts');
  } catch (err) {
    console.log(`(setup-webhook import failed: ${err instanceof Error ? err.message : String(err)})`);
  } finally {
    process.exit = realExit;
  }
  const importExits = [...exits];
  const importRequests = [...httpsRequests];

  await check('#6 setup-webhook: importing runs nothing (no exit, no request); no dotenv; buildSetWebhookParams validates the secret and the URL', () => {
    assert(importExits.length === 0, `the import called process.exit(${importExits.join(', ')})`);
    assert(importRequests.length === 0, `the import made requests: ${show(importRequests)}`);
    const src = readSource('scripts/setup-webhook.ts');
    assert(!/\bimport\b[^;]*['"]dotenv['"]|require\(\s*['"]dotenv|dotenv\.config\s*\(/.test(src), 'setup-webhook still loads dotenv');
    const build = hook.buildSetWebhookParams;
    assert(typeof build === 'function', 'buildSetWebhookParams is not exported');
    const ok = build({ TELEGRAM_WEBHOOK_SECRET: 'Ab_9-z' }, 'https://famcal.bot/api/webhook');
    assert(show(ok) === show({ url: 'https://famcal.bot/api/webhook', secret_token: 'Ab_9-z' }), `params ${show(ok)}`);
    const throwsFor = (env: Row, url: string | undefined) => { try { build(env, url); return false; } catch { return true; } };
    const bad: [string, Row, string | undefined][] = [
      ['secret unset', {}, 'https://famcal.bot/api/webhook'],
      ['secret empty', { TELEGRAM_WEBHOOK_SECRET: '' }, 'https://famcal.bot/api/webhook'],
      ['secret with a space', { TELEGRAM_WEBHOOK_SECRET: 'a b' }, 'https://famcal.bot/api/webhook'],
      ['secret with a colon', { TELEGRAM_WEBHOOK_SECRET: 'a:b' }, 'https://famcal.bot/api/webhook'],
      ['secret of 257 characters', { TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(257) }, 'https://famcal.bot/api/webhook'],
      ['no URL', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, undefined],
      ['http URL', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'http://famcal.bot/api/webhook'],
      ['another path', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'https://famcal.bot/api/webhooks'],
      ['a trailing slash', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'https://famcal.bot/api/webhook/'],
      ['a query', { TELEGRAM_WEBHOOK_SECRET: 'abc' }, 'https://famcal.bot/api/webhook?x=1'],
    ];
    const accepted = bad.filter(([, env, url]) => !throwsFor(env, url)).map(([name]) => name);
    assert(accepted.length === 0, `accepted: ${accepted.join(', ')}`);
    assert(!throwsFor({ TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(256) }, 'https://famcal.bot/api/webhook'), 'a 256-character secret was refused');
  });

  await check('#7 setup-webhook run(): a missing token or secret, or a bad URL, exits 1 before any call; set does getMe, setWebhook, getWebhookInfo and never prints the token or the secret', async () => {
    const run = hook.run;
    assert(typeof run === 'function', 'run is not exported');
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET };
    const session = (fail?: string) => {
      const calls: { method: string; params?: Row }[] = [];
      const lines: string[] = [];
      const tokens: string[] = [];
      const makeCall = (token: string) => {
        tokens.push(token);
        return async (method: string, params?: Row) => {
          calls.push({ method, params });
          if (method === fail) throw new Error(`Telegram said no to bot${BOT_TOKEN} with ${TG_SECRET}`);
          if (method === 'getMe') return { id: 1, is_bot: true, username: 'FamCalTestBot' };
          if (method === 'getWebhookInfo') {
            return { url: 'https://famcal.bot/api/webhook', pending_update_count: 3, last_error_date: 1760000000, last_error_message: 'Wrong response from the webhook: 401 Unauthorized' };
          }
          return true;
        };
      };
      const log = (line: string) => { lines.push(line); };
      return { calls, lines, tokens, makeCall, log };
    };

    for (const [name, e, args] of [
      ['no token', { TELEGRAM_WEBHOOK_SECRET: TG_SECRET }, ['set', 'https://famcal.bot/api/webhook']],
      ['no secret', { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, ['get']],
      ['bad URL', env, ['set', 'https://famcal.bot/api/other']],
      ['bad secret', { ...env, TELEGRAM_WEBHOOK_SECRET: 'has space' }, ['set', 'https://famcal.bot/api/webhook']],
    ] as [string, Row, string[]][]) {
      const s = session();
      const code = await run(args, e, s.makeCall, s.log, s.log);
      assert(code === 1, `${name}: exit ${code}`);
      assert(s.tokens.length === 0 && s.calls.length === 0, `${name}: calls ${show(s.calls.map(c => c.method))}`);
    }

    const set = session();
    const code = await run(['set', 'https://famcal.bot/api/webhook'], env, set.makeCall, set.log, set.log);
    assert(code === 0, `set: exit ${code}; ${show(set.lines)}`);
    assert(show(set.calls.map(c => c.method)) === show(['getMe', 'setWebhook', 'getWebhookInfo']), `calls ${show(set.calls.map(c => c.method))}`);
    assert(show(set.calls[1].params) === show({ url: 'https://famcal.bot/api/webhook', secret_token: TG_SECRET }), `setWebhook params ${show(set.calls[1].params)}`);
    const out = set.lines.join('\n');
    for (const want of ['@FamCalTestBot', 'https://famcal.bot/api/webhook', '3', 'Wrong response from the webhook: 401 Unauthorized']) {
      assert(out.includes(want), `output lacks ${want}: ${out}`);
    }
    assert(leaks(out).length === 0 && !out.includes(TG_SECRET), `output leaks: ${out}`);

    const failing = session('setWebhook');
    const failCode = await run(['set', 'https://famcal.bot/api/webhook'], env, failing.makeCall, failing.log, failing.log);
    const failOut = failing.lines.join('\n');
    assert(failCode === 1, `failed setWebhook: exit ${failCode}`);
    assert(/Telegram said no/.test(failOut) && leaks(failOut).length === 0 && !failOut.includes(TG_SECRET), `failure output: ${failOut}`);

    const del = session();
    assert(await run(['delete'], env, del.makeCall, del.log, del.log) === 0, 'delete: exit not 0');
    assert(show(del.calls.map(c => c.method)) === show(['getMe', 'deleteWebhook']), `delete calls ${show(del.calls.map(c => c.method))}`);
    assert(httpsRequests.length === 0, `https requests: ${show(httpsRequests)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
