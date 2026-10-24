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
    return { format: 'module', source: 'export const init = (o) => { globalThis.__sentryInits.push(o); }; export const captureRouterTransitionStart = () => {};', shortCircuit: true };
  },
});
const sentryEntry = nodeRequire.resolve('@sentry/nextjs');
const sentryStub = new Module(sentryEntry);
Object.assign(sentryStub, { filename: sentryEntry, loaded: true, exports: { init: (o: Row) => { inits.push(o); }, captureRouterTransitionStart: () => {} } });
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
    const clientModule = await load('instrumentation-client.ts');
    assert(typeof clientModule.onRouterTransitionStart === 'function', 'instrumentation-client.ts must export onRouterTransitionStart (Sentry docs, Next 15.3+)');
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
    // What the configs set before keeps its value
    if (server.tracesSampleRate !== 0.01 || client.replaysOnErrorSampleRate !== 1.0 || !Array.isArray(client.ignoreErrors)) {
      problems.push(`other options changed: ${show({ server: server.tracesSampleRate, client: client.replaysOnErrorSampleRate })}`);
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
