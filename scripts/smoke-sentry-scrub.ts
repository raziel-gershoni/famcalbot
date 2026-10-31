// Smoke test for what reaches Sentry. Telegram initData (the X-Telegram-Init-Data header
// or a body field) and the WhatsApp famcal_session cookie are both 24h credentials, and
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
// Every check here fails until the fix lands.
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
const SESSION = 'famcal_session=42.1760000000.deadbeef';

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
      cookies: { famcal_session: '42.1760000000.deadbeef' },
      data: { user_id: 9, name: 'Kids', initData: INIT },
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
    'http.request.header.cookie.famcal_session': '[Filtered]',
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
    assert(show(r.data) === show({ user_id: 9, name: 'Kids' }), `data ${show(r.data)}`);
    assert(r.method === 'GET' && out.event_id === 'e1', `other fields: ${show(out)}`);
    assert(out.contexts.nextjs.request_path === '/api/native-calendars?user_id=9&initData=[scrubbed]' && out.contexts.nextjs.router_kind === 'App Router',
      `contexts.nextjs ${show(out.contexts.nextjs)}`);
  });

  await check('#2 the body as a JSON string, a form string or cut-off JSON: initData dropped or scrubbed, the rest kept', () => {
    const run = (data: unknown) => scrub.scrubServerEvent({ request: { data } }).request.data;
    const json = run(JSON.stringify({ initData: INIT, token: 'invite-1' }));
    assert(json === JSON.stringify({ token: 'invite-1' }), `JSON string: ${show(json)}`);
    const form = run(`user_id=9&initData=${INIT}`);
    assert(form === 'user_id=9&initData=[scrubbed]', `form string: ${show(form)}`);
    const cut = run(`{"name":"Kids","initData":"${decodeURIComponent(INIT)}","rules":["a`);
    assert(leaks(cut).length === 0 && String(cut).startsWith('{"name":"Kids"'), `cut-off JSON: ${show(cut)}`);
    const plain = run('{"name":"Kids"}');
    assert(plain === '{"name":"Kids"}', `JSON without initData: ${show(plain)}`);
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
