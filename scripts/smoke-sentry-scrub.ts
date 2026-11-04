// Smoke test for what reaches Sentry. Telegram initData (the X-Telegram-Init-Data header
// or a body field, 24h) and the __Host-famcal_session cookie (up to 30 days) are credentials, and
// the SDK copied them into every server error event: every header, the cookies, the
// URL with its query, and the body. Root spans carry every header as a span attribute,
// and the SDK's name filter does not cover x-telegram-init-data. In the browser,
// request.url and the navigation breadcrumbs carry the launch fragment
// (#tgWebAppData=<initData>). src/lib/sentry-scrub.ts now removes them, and the three
// Sentry configs run it.
//
// Representative events go through the scrub functions, and the configs are loaded with
// @sentry/nextjs replaced by a recorder of its init options. No network.
//
// Every check here fails until the fix lands. #12 to #14 (and #2's token field) fail until web sign-in's names
// (code, state, token, id_token, email) are scrubbed too (plan 6b, Task 3c).
//
// #8 to #10: Sentry gets error reports and nothing else, from every surface (the privacy policy says error reports).
// No init traces (no tracesSampleRate or tracesSampler, in any source file), none sends client reports, the browser
// drops the SDK's tracer and session tracker (BrowserTracing, BrowserSession: the names come from the SDK itself), and
// the server drops the process session and counts no request into a session. smoke-sentry-envelopes.ts runs the real
// server SDK and checks that only error events leave it.
//
// Run: npx tsx scripts/smoke-sentry-scrub.ts

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

// ---- @sentry/nextjs replaced by a recorder of Sentry.init's options ----

const inits: Row[] = [];
(globalThis as Row).__sentryInits = inits;
const Module = nodeRequire('module');
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!file.includes(`${path.sep}@sentry${path.sep}nextjs${path.sep}`)) return nextLoad(url, context);
    return { format: 'module', source: 'export const init = (o) => { globalThis.__sentryInits.push(o); }; export const httpIntegration = (o) => ({ name: "Http", options: o });', shortCircuit: true };
  },
});
const sentryEntry = nodeRequire.resolve('@sentry/nextjs');
const sentryStub = new Module(sentryEntry);
Object.assign(sentryStub, { filename: sentryEntry, loaded: true, exports: { init: (o: Row) => { inits.push(o); }, httpIntegration: (o: Row) => ({ name: 'Http', options: o }) } });
Module._cache[sentryEntry] = sentryStub;

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

// ---- Fixtures ----

const INIT = 'query_id%3DAAH%26user%3D%257B%2522id%2522%253A111111111%257D%26auth_date%3D1%26hash%3Dabc123';
const SESSION = '__Host-famcal_session=42.1760000000.deadbeef';

/** A server error event as the SDK builds it for a request to an API route. */
function serverEvent(): Row {
  return {
    event_id: 'e1',
    request: {
      method: 'GET',
      url: `https://famcal.bot/api/native-calendars?user_id=9&initData=${INIT}#frag`,
      query_string: `user_id=9&initData=${INIT}`,
      headers: {
        host: 'famcal.bot',
        'user-agent': 'TelegramBot',
        'X-Telegram-Init-Data': INIT,
        Cookie: SESSION,
      },
      cookies: { '__Host-famcal_session': '42.1760000000.deadbeef' },
      data: { user_id: 9, color: 'blue', initData: INIT },
    },
    contexts: { nextjs: { request_path: `/api/native-calendars?user_id=9&initData=${INIT}`, router_kind: 'App Router' } },
  };
}

/** Span attributes as the SDK names request headers (http.request.header.<name>, '-' -> '_'). */
function spanData(): Row {
  return {
    'http.method': 'GET',
    'http.request.header.user_agent': 'TelegramBot',
    'http.request.header.x_telegram_init_data': INIT,
    'http.request.header.x-telegram-init-data': INIT,
    'http.request.header.cookie': '[Filtered]',
    'http.request.header.cookie.__Host-famcal_session': '[Filtered]',
    'url.full': `https://famcal.bot/api/pair?user_id=9&initData=${INIT}`,
  };
}

const leaks = (value: unknown): string[] => {
  const text = show(value);
  const found: string[] = [];
  if (text.includes(INIT) || text.includes(decodeURIComponent(INIT))) found.push('initData');
  if (text.includes('deadbeef')) found.push('the session cookie');
  if (/x[-_]telegram[-_]init[-_]data/i.test(text)) found.push('the initData header');
  if (/tgWebAppData/.test(text)) found.push('the launch fragment');
  return found;
};

async function main() {
  // Missing before the fix: each check then fails on its own.
  const scrub = await load('src/lib/sentry-scrub.ts').catch(() => ({} as Row));

  await check('#1 server error event: no initData header, cookie or session cookie; initData scrubbed from url and query_string; no fragment; the rest kept', () => {
    const out = scrub.scrubServerEvent(serverEvent());
    const r = out.request;
    assert(leaks(out).length === 0, `leaks ${leaks(out).join(', ')}: ${show(out)}`);
    assert(r.url === 'https://famcal.bot/api/native-calendars?user_id=9&initData=[scrubbed]', `url ${r.url}`);
    assert(r.query_string === 'user_id=9&initData=[scrubbed]', `query_string ${r.query_string}`);
    assert(!('cookies' in r), `cookies ${show(r.cookies)}`);
    assert(show(r.headers) === show({ host: 'famcal.bot', 'user-agent': 'TelegramBot' }), `headers ${show(r.headers)}`);
    assert(show(r.data) === show({ user_id: 9, color: 'blue' }), `data ${show(r.data)}`);
    assert(r.method === 'GET' && out.event_id === 'e1', `other fields: ${show(out)}`);
    assert(out.contexts.nextjs.request_path === '/api/native-calendars?user_id=9&initData=[scrubbed]' && out.contexts.nextjs.router_kind === 'App Router',
      `contexts.nextjs ${show(out.contexts.nextjs)}`);
  });

  await check('#2 the body as a JSON string, a form string or cut-off JSON: initData dropped or scrubbed, the rest kept', () => {
    const run = (data: unknown) => scrub.scrubServerEvent({ request: { data } }).request.data;
    // A token field goes too since web sign-in (#13): an invite's token is a credential as well
    const json = run(JSON.stringify({ initData: INIT, token: 'invite-1', color: 'blue' }));
    assert(json === JSON.stringify({ color: 'blue' }), `JSON string: ${show(json)}`);
    const form = run(`user_id=9&initData=${INIT}`);
    assert(form === 'user_id=9&initData=[scrubbed]', `form string: ${show(form)}`);
    const cut = run(`{"color":"blue","initData":"${decodeURIComponent(INIT)}","rules":["a`);
    assert(leaks(cut).length === 0 && String(cut).startsWith('{"color":"blue"'), `cut-off JSON: ${show(cut)}`);
    const plain = run('{"color":"blue"}');
    assert(plain === '{"color":"blue"}', `JSON without initData: ${show(plain)}`);
  });

  await check('#3 query_string as an object or as pairs: initData scrubbed, the rest kept', () => {
    const obj = scrub.scrubServerEvent({ request: { query_string: { user_id: '9', initData: INIT } } }).request.query_string;
    assert(show(obj) === show({ user_id: '9', initData: '[scrubbed]' }), `object: ${show(obj)}`);
    const pairs = scrub.scrubServerEvent({ request: { query_string: [['user_id', '9'], ['initData', INIT]] } }).request.query_string;
    assert(show(pairs) === show([['user_id', '9'], ['initData', '[scrubbed]']]), `pairs: ${show(pairs)}`);
  });

  await check('#4 server transaction: no initData header or cookie keys in the trace context or span data; its request scrubbed too', () => {
    const out = scrub.scrubServerTransaction({
      type: 'transaction',
      request: serverEvent().request,
      contexts: { trace: { trace_id: 't', span_id: 's', data: spanData() } },
      spans: [{ span_id: 'a', trace_id: 't', start_timestamp: 1, data: spanData() }],
    });
    assert(leaks(out).length === 0, `leaks ${leaks(out).join(', ')}: ${show(out)}`);
    for (const [where, data] of [['trace', out.contexts.trace.data], ['span', out.spans[0].data]] as [string, Row][]) {
      const keys = Object.keys(data).sort();
      assert(show(keys) === show(['http.method', 'http.request.header.user_agent', 'url.full']), `${where} keys ${show(keys)}`);
      assert(data['url.full'] === 'https://famcal.bot/api/pair?user_id=9&initData=[scrubbed]', `${where} url.full ${data['url.full']}`);
    }
  });

  await check('#5 browser event: no #tgWebAppData in request.url or in navigation, fetch and xhr breadcrumbs; other breadcrumbs untouched', () => {
    const launch = `https://famcal.bot/he/dashboard?user_id=9#tgWebAppData=${INIT}&tgWebAppVersion=8.0`;
    const out = scrub.scrubBrowserEvent({
      request: { url: launch, headers: { 'User-Agent': 'x' } },
      breadcrumbs: [
        { category: 'navigation', data: { from: `/he/dashboard?user_id=9#tgWebAppData=${INIT}`, to: '/he/settings?user_id=9' } },
        { category: 'fetch', data: { url: `/api/x?user_id=9#tgWebAppData=${INIT}`, method: 'GET', status_code: 200 } },
        { category: 'xhr', data: { url: `/api/y#tgWebAppData=${INIT}` } },
        { category: 'console', message: 'hello', data: { arguments: ['hello'] } },
      ],
    });
    assert(leaks(out).length === 0, `leaks ${leaks(out).join(', ')}: ${show(out)}`);
    assert(out.request.url === 'https://famcal.bot/he/dashboard?user_id=9', `request.url ${out.request.url}`);
    const [nav, fetchCrumb, xhr, consoleCrumb] = out.breadcrumbs;
    assert(nav.data.from === '/he/dashboard?user_id=9' && nav.data.to === '/he/settings?user_id=9', `navigation ${show(nav)}`);
    assert(fetchCrumb.data.url === '/api/x?user_id=9' && fetchCrumb.data.status_code === 200, `fetch ${show(fetchCrumb)}`);
    assert(xhr.data.url === '/api/y', `xhr ${show(xhr)}`);
    assert(show(consoleCrumb) === show({ category: 'console', message: 'hello', data: { arguments: ['hello'] } }), `console ${show(consoleCrumb)}`);
  });

  await check('#6 the server and edge configs scrub events and transactions; the client config (instrumentation-client.ts, the file Turbopack loads) scrubs events, transactions and breadcrumbs', async () => {
    inits.length = 0;
    await load('sentry.server.config.ts');
    await load('sentry.edge.config.ts');
    // No onRouterTransitionStart export: it only starts navigation traces, and nothing is traced (#9, #10)
    const clientModule = await load('instrumentation-client.ts');
    assert(!('onRouterTransitionStart' in clientModule), 'instrumentation-client.ts exports onRouterTransitionStart, a navigation-trace hook');
    assert(!fs.existsSync(path.join(ROOT, 'sentry.client.config.ts')), 'sentry.client.config.ts is ignored by Turbopack: the browser init lives in instrumentation-client.ts only');
    assert(inits.length === 3, `Sentry.init calls: ${inits.length}`);
    const [server, edge, client] = inits;
    const problems: string[] = [];
    for (const [name, opts] of [['server', server], ['edge', edge]] as [string, Row][]) {
      const event = typeof opts.beforeSend === 'function' ? opts.beforeSend(serverEvent(), {}) : null;
      if (!event || leaks(event).length) problems.push(`${name} beforeSend: ${event ? leaks(event).join(', ') : 'missing'}`);
      const tx = typeof opts.beforeSendTransaction === 'function'
        ? opts.beforeSendTransaction({ type: 'transaction', request: serverEvent().request, contexts: { trace: { data: spanData() } }, spans: [{ data: spanData() }] }, {})
        : null;
      if (!tx || leaks(tx).length) problems.push(`${name} beforeSendTransaction: ${tx ? leaks(tx).join(', ') : 'missing'}`);
    }
    const launch = `https://famcal.bot/en/dashboard?user_id=9#tgWebAppData=${INIT}`;
    const ev = typeof client.beforeSend === 'function' ? client.beforeSend({ request: { url: launch } }, {}) : null;
    if (!ev || leaks(ev).length) problems.push(`client beforeSend: ${ev ? leaks(ev).join(', ') : 'missing'}`);
    const tx = typeof client.beforeSendTransaction === 'function' ? client.beforeSendTransaction({ type: 'transaction', request: { url: launch } }, {}) : null;
    if (!tx || leaks(tx).length) problems.push(`client beforeSendTransaction: ${tx ? leaks(tx).join(', ') : 'missing'}`);
    const crumb = typeof client.beforeBreadcrumb === 'function' ? client.beforeBreadcrumb({ category: 'navigation', data: { from: launch, to: '/en/settings' } }) : null;
    if (!crumb || leaks(crumb).length) problems.push(`client beforeBreadcrumb: ${crumb ? leaks(crumb).join(', ') : 'missing'}`);
    // What the configs set before keeps its value (what they no longer send is #9's)
    if (!Array.isArray(client.ignoreErrors) || [server, edge, client].some((opts) => typeof opts.enabled !== 'boolean')) {
      problems.push(`other options changed: ${show({ ignoreErrors: client.ignoreErrors, enabled: [server, edge, client].map((opts) => opts.enabled) })}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#7 the transaction name (a root span for a Telegram Bot API call) carries no bot token, plain or %3A-encoded, also through the server and edge configs', async () => {
    const { scrubServerTransaction } = await load('src/lib/sentry-scrub.ts');
    const plain = 'POST https://api.telegram.org/bot123456789:AAE-x_Yz/sendMessage';
    const encoded = 'POST https://api.telegram.org/bot123456789%3AAAE-x_Yz/sendMessage';
    const want = 'POST https://api.telegram.org/bot[scrubbed]/sendMessage';
    const problems: string[] = [];
    for (const [label, name] of [['plain', plain], ['encoded', encoded]]) {
      const event = scrubServerTransaction({ type: 'transaction', transaction: name, contexts: { trace: { data: {}, description: name } } });
      if (event.transaction !== want) problems.push(`${label} transaction: ${event.transaction}`);
      if (event.contexts?.trace?.description !== want) problems.push(`${label} trace description: ${event.contexts?.trace?.description}`);
    }
    // The configs were loaded (once: modules are cached) by #6
    await load('sentry.server.config.ts');
    await load('sentry.edge.config.ts');
    assert(inits.length >= 2, `Sentry.init calls: ${inits.length}`);
    for (const [label, opts] of [['server', inits[0]], ['edge', inits[1]]] as [string, Row][]) {
      const tx = typeof opts?.beforeSendTransaction === 'function'
        ? opts.beforeSendTransaction({ type: 'transaction', transaction: plain, contexts: { trace: { data: {} } } }, {})
        : null;
      if (!tx || tx.transaction !== want) problems.push(`${label} beforeSendTransaction: ${tx ? tx.transaction : 'missing'}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  /** A file's source without its comment lines. */
  const code = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  /** The keys that would send something but an error: traces, profiles, replays. */
  const NON_ERROR_OPTIONS = ['tracesSampleRate', 'tracesSampler', 'profilesSampleRate', 'profilesSampler', 'replaysSessionSampleRate', 'replaysOnErrorSampleRate'];

  await check('#8 the browser\'s integrations are the SDK\'s defaults without its tracer and its session tracker, named as the SDK names them', async () => {
    const { browserIntegrations, BROWSER_NON_ERROR_INTEGRATIONS } = await load('src/lib/sentry-errors-only.ts');
    const sdk = nodeRequire('@sentry/browser');
    const real = [sdk.browserSessionIntegration().name, sdk.browserTracingIntegration().name];
    const problems: string[] = [];
    if (show([...BROWSER_NON_ERROR_INTEGRATIONS].sort()) !== show([...real].sort())) problems.push(`the dropped names ${show(BROWSER_NON_ERROR_INTEGRATIONS)}, the SDK's ${show(real)}`);
    const defaults = [...sdk.getDefaultIntegrations({}), sdk.browserTracingIntegration()] as Row[];
    const names = (list: Row[]) => list.map((i) => i.name);
    const kept = names(browserIntegrations(defaults));
    const want = names(defaults).filter((name) => !real.includes(name));
    if (show(kept) !== show(want)) problems.push(`kept ${show(kept)}, want ${show(want)}`);
    if (!names(defaults).includes('BrowserSession')) problems.push('the SDK\'s defaults no longer hold BrowserSession: recheck what they send');
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#9 the three inits trace nothing, send no client reports or replays, the browser\'s integrations drop its tracer and sessions, and the server\'s drop the process session and count no request into a session', async () => {
    const [server, edge, client] = inits;
    assert(server && edge && client, `Sentry.init calls: ${inits.length}`);
    const problems: string[] = [];
    for (const [label, opts] of [['server', server], ['edge', edge], ['browser', client]] as [string, Row][]) {
      for (const key of NON_ERROR_OPTIONS) if (key in opts) problems.push(`the ${label} init sets ${key}`);
      if (opts.sendClientReports !== false) problems.push(`the ${label} init's sendClientReports ${show(opts.sendClientReports)}`);
    }
    if (client.integrations !== (await load('src/lib/sentry-errors-only.ts')).browserIntegrations) problems.push('the browser init\'s integrations are not browserIntegrations');
    // The server's list from the SDK's own defaults (@sentry/nextjs hands its init @sentry/node's, with its own Http)
    if (typeof server.integrations !== 'function') problems.push(`the server init's integrations are not a function: ${show(server.integrations)}`);
    else {
      const defaults = nodeRequire('@sentry/node').getDefaultIntegrations({}) as Row[];
      const list = server.integrations(defaults) as Row[];
      const names = list.map((i) => i.name);
      const want = [...defaults.map((i) => i.name).filter((name) => name !== 'Http' && name !== 'ProcessSession'), 'Http'];
      if (!defaults.some((i) => i.name === 'ProcessSession')) problems.push('the SDK\'s server defaults no longer hold ProcessSession: recheck what they send');
      if (show(names) !== show(want)) problems.push(`the server's integrations ${show(names)}, want ${show(want)}`);
      const http = list.find((i) => i.name === 'Http');
      if (http?.options?.trackIncomingRequestsAsSessions !== false || http?.options?.disableIncomingRequestSpans !== true) problems.push(`the server's Http integration ${show(http?.options)}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#10 no source file turns tracing, profiling or replay on: no non-error option and no replay or tracing integration outside comments', async () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push(rel);
      }
    };
    for (const dir of ['app', 'components', 'src', 'lib', 'i18n']) if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
    for (const file of fs.readdirSync(ROOT)) if (/\.(ts|js|mjs|cjs)$/.test(file)) files.push(file);
    const pattern = new RegExp(`\\b(${NON_ERROR_OPTIONS.join('|')}|replayIntegration|replayCanvasIntegration|browserTracingIntegration|browserProfilingIntegration|captureRouterTransitionStart)\\b`);
    const offenders = files.filter((file) => pattern.test(code(file))).map((file) => `${file}: ${code(file).match(pattern)?.[0]}`);
    assert(files.length > 100, `only ${files.length} files scanned`);
    assert(offenders.length === 0, offenders.join('; '));
  });

  await check('#11 an outgoing request to the forecast or to the place lookup loses its query in the breadcrumb (it holds the person\'s coordinates, or the place\'s name); the same breadcrumb of another host, and the rest of these, are kept', async () => {
    const { scrubServerBreadcrumb } = await load('src/lib/sentry-scrub.ts');
    const crumb = (url: string, query: string) => ({ category: 'http', type: 'http', data: { url, 'http.method': 'GET', 'http.query': query, status_code: 200 } });
    const met = scrubServerBreadcrumb(crumb('https://api.met.no/weatherapi/locationforecast/2.0/complete', '?lat=32.09&lon=34.78'));
    const nominatim = scrubServerBreadcrumb(crumb('https://nominatim.openstreetmap.org/search', '?q=Tel%20Aviv&format=json&limit=1'));
    const withQueryOnUrl = scrubServerBreadcrumb({ category: 'http', data: { url: 'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=32.09&lon=34.78' } });
    for (const [label, c] of [['MET', met], ['Nominatim', nominatim], ['MET with the query on the url', withQueryOnUrl]] as [string, Row][]) {
      assert(!JSON.stringify(c).match(/32\.09|34\.78|Tel|lat=|q=/), `${label} breadcrumb still has the place: ${show(c)}`);
    }
    assert(met.data.url === 'https://api.met.no/weatherapi/locationforecast/2.0/complete' && met.data['http.method'] === 'GET' && met.data.status_code === 200, `the rest of MET's breadcrumb: ${show(met)}`);
    const other = scrubServerBreadcrumb(crumb('https://example.test/path', '?page=2'));
    assert(other.data['http.query'] === '?page=2', `another host lost its query: ${show(other)}`);
    const telegram = scrubServerBreadcrumb(crumb('https://api.telegram.org/bot123456789:AAE-x_Yz/sendMessage', ''));
    assert(!JSON.stringify(telegram).includes('AAE-x_Yz'), 'the bot token scrub still holds');
  });

  // ---- Web sign-in (spec 2026-11-02 §8): code, state, token, id_token and email leave URLs, queries and bodies ----

  const CODE = '4/0AVG7fiQ-oauth-code';
  const STATE = 'st-9f8e7d6c5b4a';
  const TOKEN = 'a'.repeat(64);
  const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
  const EMAIL = 'dana@example.test';
  const OTP = '493817';
  const signInLeaks = (value: unknown): string[] => {
    const text = show(value);
    return [['code', CODE], ['state', STATE], ['token', TOKEN], ['id_token', ID_TOKEN], ['email', EMAIL], ['email (encoded)', encodeURIComponent(EMAIL)], ['the email code', OTP]]
      .filter(([, secret]) => text.includes(secret)).map(([name]) => name);
  };

  await check('#12 server event: code, state, token, id_token and email scrubbed from url, query_string (string, object, pairs) and the nextjs request path; names that only contain them (barcode, statement) and the rest kept', () => {
    const query = `state=${STATE}&code=${encodeURIComponent(CODE)}&scope=openid%20email&authuser=0&token=${TOKEN}&id_token=${ID_TOKEN}&email=${encodeURIComponent(EMAIL)}&barcode=5&statement=x&user_id=9`;
    const want = 'state=[scrubbed]&code=[scrubbed]&scope=openid%20email&authuser=0&token=[scrubbed]&id_token=[scrubbed]&email=[scrubbed]&barcode=5&statement=x&user_id=9';
    const out = scrub.scrubServerEvent({
      request: { url: `https://famcal.bot/api/auth/google/callback?${query}`, query_string: query },
      contexts: { nextjs: { request_path: `/api/auth/google/callback?${query}` } },
    });
    assert(signInLeaks(out).length === 0, `leaks ${signInLeaks(out).join(', ')}: ${show(out)}`);
    assert(out.request.url === `https://famcal.bot/api/auth/google/callback?${want}`, `url ${out.request.url}`);
    assert(out.request.query_string === want, `query_string ${out.request.query_string}`);
    assert(out.contexts.nextjs.request_path === `/api/auth/google/callback?${want}`, `request_path ${out.contexts.nextjs.request_path}`);
    const obj = scrub.scrubServerEvent({ request: { query_string: { code: CODE, State: STATE, token: TOKEN, email: EMAIL, locale: 'he' } } }).request.query_string;
    assert(show(obj) === show({ code: '[scrubbed]', State: '[scrubbed]', token: '[scrubbed]', email: '[scrubbed]', locale: 'he' }), `object ${show(obj)}`);
    const pairs = scrub.scrubServerEvent({ request: { query_string: [['id_token', ID_TOKEN], ['locale', 'ru']] } }).request.query_string;
    assert(show(pairs) === show([['id_token', '[scrubbed]'], ['locale', 'ru']]), `pairs ${show(pairs)}`);
  });

  await check('#13 server event body: code, state, token, id_token, email and a sign-up\'s name dropped from a JSON object or string (any case) and scrubbed in a form or cut-off JSON; the rest kept', () => {
    const run = (data: unknown) => scrub.scrubServerEvent({ request: { data } }).request.data;
    const object = run({ email: EMAIL, code: OTP, name: 'Dana Levi', locale: 'he' });
    assert(show(object) === show({ locale: 'he' }), `object ${show(object)}`);
    const json = run(JSON.stringify({ Email: EMAIL, id_token: ID_TOKEN, state: STATE, Name: 'Dana Levi', user_id: 9 }));
    assert(json === JSON.stringify({ user_id: 9 }), `JSON string ${show(json)}`);
    const form = run(`email=${encodeURIComponent(EMAIL)}&code=${OTP}&name=Dana%20Levi&locale=he`);
    assert(form === 'email=[scrubbed]&code=[scrubbed]&name=[scrubbed]&locale=he', `form ${show(form)}`);
    const cut = run(`{"locale":"he","email":"${EMAIL}","code":${OTP},"token":"${TOKEN}","name":"Dana Levi","note":"a`);
    assert(signInLeaks(cut).length === 0 && !String(cut).includes('Dana') && String(cut).startsWith('{"locale":"he"'), `cut-off JSON ${show(cut)}`);
    const plain = run('{"locale":"he"}');
    assert(plain === '{"locale":"he"}', `JSON without secrets ${show(plain)}`);
  });

  await check('#14 breadcrumbs, transactions and the browser: sign-in values scrubbed from http.query and urls, the transaction name, request.url and navigation', async () => {
    const crumb = scrub.scrubServerBreadcrumb({ category: 'http', data: { url: `https://famcal.bot/oauth-callback?code=${CODE}&state=${STATE}`, 'http.query': `?code=${CODE}&state=${STATE}`, status_code: 302 } });
    assert(signInLeaks(crumb).length === 0 && crumb.data.status_code === 302, `breadcrumb ${show(crumb)}`);
    const tx = scrub.scrubServerTransaction({ type: 'transaction', transaction: `GET /api/auth/magic?token=${TOKEN}&locale=he`, contexts: { trace: { data: { 'url.full': `https://famcal.bot/api/auth/magic?token=${TOKEN}` } } } });
    assert(signInLeaks(tx).length === 0 && tx.transaction === 'GET /api/auth/magic?token=[scrubbed]&locale=he', `transaction ${show(tx)}`);
    const browser = scrub.scrubBrowserEvent({
      request: { url: `https://famcal.bot/he/signin/add-google?token=${TOKEN}` },
      breadcrumbs: [{ category: 'navigation', data: { from: `/he/signin/add-google?token=${TOKEN}`, to: '/he/dashboard?user_id=9' } }],
    });
    assert(signInLeaks(browser).length === 0, `browser ${show(browser)}`);
    assert(browser.breadcrumbs[0].data.to === '/he/dashboard?user_id=9', `navigation ${show(browser.breadcrumbs[0])}`);
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
