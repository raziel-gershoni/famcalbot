// Smoke test for what a Mini App page shows before its data arrives, and for the cards a
// page shows when nobody has proved who they are.
//
// Full height at once: PageGate renders only a loader until /api/page-data answers, and
// the page's own TelegramLayout, which called ready() and expand(), mounted only after
// that round trip. So the sheet sat at half height with Telegram's header colour for a
// whole request. PageGate now calls them on its first mount, before the fetch starts.
// share-story keeps ready() alone: it opens the story composer and closes.
//
// Ways back: the "open this from the bot" cards offered nothing to tap. In a browser the
// card now leads with a WhatsApp link that asks for a fresh magic link ("settings"; the
// landing pages' public number when the env names none), then the bot for Telegram users (a WhatsApp-only user who taps that would get a second,
// unlinked account, so it comes second and says who it is for). Inside Telegram it closes
// the Mini App, back to the chat whose buttons reopen it. A stale or used magic link used
// to land on /en/dashboard and a hard-coded English card with no link; it now gets the
// same card, in the link's language or the browser's, or that browser's own dashboard
// while its session cookie is still valid.
//
// The dashboard (calendar-home spec §7.1; Plan D, Task D7; #16-#19): always the calendar
// home, with exactly the props it takes. It loads behind the dashboard's purple loader,
// and its chunk starts loading while the data is in flight. The home's chunk sits inside
// PageGate's own boundary (spec §5); what it does with a failed import is the render
// smoke's #40, in real React (next/dynamic under tsx is the pages-router loadable, which
// never throws on a failed import).
//
// The pages, PageGate's cards and its dashboard branch, the magic-link route and its
// service run for real. Faked at the boundaries: Redis (in memory), Prisma (the one user
// lookup the magic route makes), the calendar home (a placeholder that records its
// props), and the browser window. No network, no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-miniapp-gate.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';

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

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

// ---- Fake Redis (Upstash parses JSON on read) ----

const redisStore = new Map<string, string>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown) => { redisStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return 'OK'; },
  // Reads and deletes in one tick, as GETDEL does.
  getdel: async (k: string) => { const raw = redisStore.get(k); redisStore.delete(k); return decode(raw); },
  del: async (k: string) => (redisStore.delete(k) ? 1 : 0),
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

/** What PageGate's dashboard branch rendered: the home's placeholder records its props (#16-#17). */
const rendered: { props: Row }[] = [];

function installStubs() {
  // The calendar home is a placeholder at its real path: it records the props PageGate
  // hands it and renders one marker line.
  stub('app/[locale]/dashboard/CalendarHome.tsx', {
    __esModule: true,
    default: function CalendarHome(props: Row) {
      rendered.push({ props });
      return 'smoke:CalendarHome';
    },
  });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  // next-intl/server is the request-scoped half of next-intl: outside Next its getTranslations refuses to run,
  // so the server pages' getTranslations reads the same messages through the library's own translator.
  const { createTranslator } = nodeRequire('next-intl');
  stub(path.relative(ROOT, nodeRequire.resolve('next-intl/server')), {
    __esModule: true,
    getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) =>
      createTranslator({ locale, namespace, messages: JSON.parse(readSource(`messages/${locale}.json`)) }),
  });
  // The magic route's only DB read: is the user suspended?
  stub('src/utils/prisma.ts', { prisma: { user: { findUnique: async () => ({ suspendedAt: null }) } } });
}

const he = JSON.parse(readSource('messages/he.json'));

/** Server-render an element inside the providers the [locale] layout gives a client page. */
function renderHtml(el: unknown, locale: string): string {
  const React = nodeRequire('react');
  const { renderToString } = nodeRequire('react-dom/server');
  const { NextIntlClientProvider } = nodeRequire('next-intl');
  const messages = JSON.parse(readSource(`messages/${locale}.json`));
  return renderToString(React.createElement(NextIntlClientProvider, { locale, messages, timeZone: 'Asia/Jerusalem' }, el));
}

/** What a component returns (its hooks run inside a render), for reaching its handlers. */
function treeOf(component: (props: Row) => unknown, props: Row, locale: string): unknown {
  const React = nodeRequire('react');
  let tree: unknown;
  const Capture = () => { tree = component(props); return null; };
  renderHtml(React.createElement(Capture), locale);
  return tree;
}

/** Text as React writes it into HTML. */
const asHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const LINKS = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };

/** Call a page server component as Next does. */
async function callPage(rel: string, locale: string, userId?: string): Promise<Row> {
  const page = (await load(rel)).default;
  return page({ params: Promise.resolve({ locale }), searchParams: Promise.resolve(userId ? { user_id: userId } : {}) });
}

/** A fake Telegram.WebApp that records every call; `throwOn` methods throw as old SDKs do. */
function fakeWebApp(throwOn: string[] = [], version: string | null = null) {
  const calls: string[] = [];
  const method = (name: string) => (...args: unknown[]) => {
    calls.push(args.length ? `${name}(${args.map(a => String(a)).join(',')})` : `${name}()`);
    if (throwOn.includes(name)) throw new Error(`${name}: this WebApp version rejects a hex colour`);
  };
  const webApp: Row = {
    initData: '',
    initDataUnsafe: {},
    ready: method('ready'),
    expand: method('expand'),
    close: method('close'),
    setHeaderColor: method('setHeaderColor'),
    setBackgroundColor: method('setBackgroundColor'),
    // Only a fake given a version has the 7.x members, so the existing checks see no new calls
    ...(version
      ? {
          isVersionAtLeast: (v: string) => {
            const a = version.split('.').map(Number);
            const b = v.split('.').map(Number);
            return a[0] !== b[0] ? a[0] > b[0] : (a[1] ?? 0) >= (b[1] ?? 0);
          },
          enableVerticalSwipes: method('enableVerticalSwipes'),
          disableVerticalSwipes: method('disableVerticalSwipes'),
        }
      : {}),
  };
  return { webApp, calls };
}

/** Runs fn with a fake browser window (Telegram SDK included unless webApp is null). */
async function withWindow<T>(webApp: Row | null, fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as Row;
  const had = 'window' in g;
  const prev = g.window;
  g.window = {
    location: { hash: '' },
    sessionStorage: { getItem: () => null, setItem: () => undefined },
    ...(webApp ? { Telegram: { WebApp: webApp } } : {}),
  };
  try {
    return await fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

/** The bodies of the useEffect calls in PageGate's component, in declaration order. */
function pageGateEffects(src: string): string[] {
  const start = src.indexOf('export default function PageGate');
  assert(start >= 0, 'no PageGate component in PageGate.tsx');
  const body = src.slice(start);
  const end = body.indexOf('const look = LOOK[page]');
  const component = end > 0 ? body.slice(0, end) : body;
  return component.split('useEffect(').slice(1);
}

async function main() {
  installStubs();

  // ---- Full height at once ----

  await check('#1 PageGate calls ready() and expand() in an effect declared before its /api/page-data fetch effect', () => {
    const src = readSource('app/[locale]/PageGate.tsx');
    const effects = pageGateEffects(src);
    const fetchAt = effects.findIndex(e => e.includes("fetch('/api/page-data'"));
    assert(fetchAt >= 0, 'no effect fetches /api/page-data');
    // The effect either makes the calls itself or calls startMiniApp, which must make them
    const helper = src.match(/export function startMiniApp\([\s\S]*?\n}\n/)?.[0] ?? '';
    const lifecycleAt = effects.findIndex(e => {
      const calls = e.includes('startMiniApp(') ? helper : e.slice(0, e.indexOf('}, ['));
      return calls.includes('.ready()') && calls.includes('.expand()');
    });
    assert(lifecycleAt >= 0, 'no PageGate effect calls ready() and expand()');
    assert(lifecycleAt < fetchAt, `the ready/expand effect is #${lifecycleAt + 1}, the fetch effect #${fetchAt + 1}`);
  });

  await check('#2 startMiniApp: ready + expand always; purple pages also get the purple header and white background, each surviving a throw', async () => {
    const { startMiniApp } = await load('app/[locale]/PageGate.tsx');
    assert(typeof startMiniApp === 'function', 'PageGate exports no startMiniApp');

    const purple = fakeWebApp();
    await withWindow(purple.webApp, () => startMiniApp('telegram'));
    for (const call of ['ready()', 'expand()', 'setHeaderColor(#667eea)', 'setBackgroundColor(#ffffff)']) {
      assert(purple.calls.includes(call), `purple look: no ${call} in ${show(purple.calls)}`);
    }
    assert(purple.calls.indexOf('ready()') < purple.calls.indexOf('setHeaderColor(#667eea)'), `order: ${show(purple.calls)}`);

    // WebApp 6.1-6.8 throw on a hex header colour; a throw here would replace the gate
    const old = fakeWebApp(['setHeaderColor']);
    await withWindow(old.webApp, () => startMiniApp('telegram'));
    assert(old.calls.includes('expand()') && old.calls.includes('setBackgroundColor(#ffffff)'),
      `after setHeaderColor threw: ${show(old.calls)}`);
    const oldBg = fakeWebApp(['setBackgroundColor']);
    await withWindow(oldBg.webApp, () => startMiniApp('telegram'));

    const light = fakeWebApp();
    await withWindow(light.webApp, () => startMiniApp('light'));
    assert(show(light.calls) === show(['ready()', 'expand()']), `light look: ${show(light.calls)}`);

    // The app's own look sets no colour (its AppScreen takes the theme's bg_color), and turns swipes on
    const app = fakeWebApp([], '7.7');
    await withWindow(app.webApp, () => startMiniApp('app'));
    assert(show(app.calls) === show(['ready()', 'expand()', 'enableVerticalSwipes()']), `app look: ${show(app.calls)}`);
    const appOld = fakeWebApp();
    await withWindow(appOld.webApp, () => startMiniApp('app'));
    assert(show(appOld.calls) === show(['ready()', 'expand()']), `app look without the 7.x members: ${show(appOld.calls)}`);

    await withWindow(null, () => startMiniApp('telegram'));
    await withWindow(null, () => startMiniApp('app'));
  });

  await check('#2b startMiniApp: a 7.7+ client gets enableVerticalSwipes() once and never disable; 7.6 gets none; a throw there costs nothing; the light look stays ready+expand', async () => {
    const { startMiniApp } = await load('app/[locale]/PageGate.tsx');
    const modern = fakeWebApp([], '7.7');
    await withWindow(modern.webApp, () => startMiniApp('telegram'));
    assert(modern.calls.filter(c => c === 'enableVerticalSwipes()').length === 1, `7.7: ${show(modern.calls)}`);
    assert(!modern.calls.includes('disableVerticalSwipes()'), `7.7 disabled swipes: ${show(modern.calls)}`);

    const old = fakeWebApp([], '7.6');
    await withWindow(old.webApp, () => startMiniApp('telegram'));
    assert(!old.calls.some(c => c.includes('VerticalSwipes')), `7.6: ${show(old.calls)}`);

    const throws = fakeWebApp(['enableVerticalSwipes'], '8.0');
    const logged = console.warn;
    console.warn = () => undefined;
    try {
      await withWindow(throws.webApp, () => startMiniApp('telegram'));
    } finally {
      console.warn = logged;
    }
    for (const call of ['ready()', 'expand()', 'setHeaderColor(#667eea)', 'setBackgroundColor(#ffffff)']) {
      assert(throws.calls.includes(call), `swipes threw: no ${call} in ${show(throws.calls)}`);
    }

    const light = fakeWebApp([], '8.0');
    await withWindow(light.webApp, () => startMiniApp('light'));
    assert(show(light.calls) === show(['ready()', 'expand()']), `light look: ${show(light.calls)}`);

    const app = fakeWebApp([], '8.0');
    await withWindow(app.webApp, () => startMiniApp('app'));
    assert(app.calls.filter(c => c === 'enableVerticalSwipes()').length === 1 && !app.calls.includes('disableVerticalSwipes()'), `app look 8.0: ${show(app.calls)}`);
    const appOld = fakeWebApp([], '7.6');
    await withWindow(appOld.webApp, () => startMiniApp('app'));
    assert(!appOld.calls.some(c => c.includes('VerticalSwipes')), `app look 7.6: ${show(appOld.calls)}`);
  });

  await check('#3 share-story keeps ready() alone: no expand() anywhere in it', () => {
    const src = readSource('app/[locale]/share-story/page.tsx');
    assert(src.includes('tg.ready()'), 'share-story no longer calls ready()');
    assert(!/expand\s*\(/.test(src), 'share-story calls expand()');
  });

  await check("#4 the global menu button path (TelegramDashboardRedirect) is the dashboard's own, in the app look: it makes startMiniApp('app')'s calls (ready, expand, swipes, and no colour) through PageGate's function, shows PageGate's app loader before its effect runs (no purple), and its gate card is the app's; the user is still pushed on", async () => {
    const src = readSource('app/[locale]/dashboard/TelegramDashboardRedirect.tsx');
    assert(src.includes("startMiniApp('app')"), "it does not call startMiniApp('app')");
    assert(!/setHeaderColor|setBackgroundColor|#667eea|linear-gradient|Loader2/.test(src), 'a purple header, background or loader is still there');
    assert(src.includes('<PageLoader look="app"') && src.includes('<NoCredentialCard look="app"') && !src.includes('look="telegram"'), 'the loader and the card are not the app look');
    // The first render, before any effect: the app loader inside its own AppScreen
    const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
    const React = nodeRequire('react');
    const { default: Redirect } = await load('app/[locale]/dashboard/TelegramDashboardRedirect.tsx');
    const html = renderHtml(React.createElement(AppRouterContext.Provider, { value: {} }, React.createElement(Redirect, { locale: 'he', links: LINKS })), 'he');
    assert(html.startsWith('<div class="ch-app ch-screen" data-theme="light" dir="rtl" lang="he">') && html.includes('class="ch-loader" role="status"') && html.includes(asHtml(he.pageGate.loading)), `the first render: ${html.slice(0, 160)}`);
    assert(!html.includes('#667eea') && !html.includes('linear-gradient'), 'the loader is purple');
  });

  // ---- Ways back from the "open this from the bot" cards ----

  await check('#5 gateLinks: wa.me with "settings" and t.me/<bot>?start=dashboard from env; both fall back to the public number and bot the landing pages use', async () => {
    const { gateLinks } = await load('src/lib/gate-links.ts');
    process.env.TELEGRAM_BOT_USERNAME = 'test_bot';
    process.env.WHATSAPP_PHONE_NUMBER = '972500000000';
    const set = gateLinks();
    assert(show(set) === show(LINKS), `with env: ${show(set)}`);
    delete process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.WHATSAPP_PHONE_NUMBER;
    const unset = gateLinks();
    // Without a WhatsApp line the card's only action would be the account-splitting Telegram one
    const landingNumber = readSource('app/[locale]/page.tsx').match(/const WA_PHONE = '(\d+)'/)?.[1];
    assert(landingNumber, 'the landing page no longer names its WhatsApp number');
    assert(unset.whatsapp === `https://wa.me/${landingNumber}?text=settings`, `no WA number: ${show(unset)}`);
    assert(unset.telegram === 'https://t.me/family_calendar_telegram_bot?start=dashboard', `no bot username: ${show(unset)}`);
  });

  await check('#6 every gated page hands PageGate the links from the server, and /dashboard with no user_id hands them to TelegramDashboardRedirect', async () => {
    process.env.TELEGRAM_BOT_USERNAME = 'test_bot';
    process.env.WHATSAPP_PHONE_NUMBER = '972500000000';
    const problems: string[] = [];
    for (const name of ['dashboard', 'settings', 'select-calendars', 'subscription', 'calendars', 'pair']) {
      const el = await callPage(`app/[locale]/${name}/page.tsx`, 'he', '5550001');
      if (el?.type?.name !== 'PageGate') problems.push(`${name} renders ${el?.type?.name ?? show(el)}`);
      else if (show(el.props.links) !== show(LINKS)) problems.push(`${name} links: ${show(el.props.links)}`);
    }
    const redirect = await callPage('app/[locale]/dashboard/page.tsx', 'he');
    if (redirect?.type?.name !== 'TelegramDashboardRedirect') problems.push(`dashboard without user_id renders ${redirect?.type?.name}`);
    else if (show(redirect.props.links) !== show(LINKS)) problems.push(`TelegramDashboardRedirect links: ${show(redirect.props.links)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#7 the browser card (he): the WhatsApp link first, then the Telegram one labelled for Telegram users', async () => {
    const React = nodeRequire('react');
    const { NoCredentialCard } = await load('app/[locale]/PageGate.tsx');
    assert(typeof NoCredentialCard === 'function', 'PageGate exports no NoCredentialCard');
    const problems: string[] = [];
    for (const look of ['telegram', 'light', 'app']) {
      const html = renderHtml(React.createElement(NoCredentialCard, { look, inTelegram: false, links: LINKS }), 'he');
      const wa = html.indexOf(`href="${LINKS.whatsapp}"`);
      const tg = html.indexOf(`href="${LINKS.telegram}"`);
      if (wa < 0 || tg < 0 || wa > tg) problems.push(`${look}: WhatsApp link at ${wa}, Telegram link at ${tg}`);
      for (const key of ['browserTitle', 'browserBody', 'openWhatsApp', 'openTelegram']) {
        if (!he.pageGate[key] || !html.includes(asHtml(he.pageGate[key]))) problems.push(`${look}: no pageGate.${key}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#8 the in-Telegram card: its action closes the Mini App (back to the chat), and it links nowhere', async () => {
    const React = nodeRequire('react');
    const { NoCredentialCard } = await load('app/[locale]/PageGate.tsx');
    assert(typeof NoCredentialCard === 'function', 'PageGate exports no NoCredentialCard');
    const html = renderHtml(React.createElement(NoCredentialCard, { look: 'telegram', inTelegram: true, links: LINKS }), 'he');
    assert(html.includes(asHtml(he.pageGate.telegramBody)) && he.pageGate.close && html.includes(asHtml(he.pageGate.close)),
      `the card: ${html.slice(0, 300)}`);
    assert(!html.includes('wa.me') && !html.includes('t.me/'), 'the in-Telegram card links out');
    // The card's action is data for the gate (Gate renders it as a button in each look)
    for (const look of ['telegram', 'light', 'app']) {
      const card = treeOf(NoCredentialCard, { look, inTelegram: true, links: LINKS }, 'he') as Row;
      const clicks = (card.props.actions as Row[]).map(a => a.onClick).filter((f): f is () => void => typeof f === 'function');
      assert(clicks.length === 1 && card.props.actions.length === 1, `${look}: ${clicks.length} click handlers`);
      const tg = fakeWebApp();
      await withWindow(tg.webApp, () => clicks[0]());
      assert(show(tg.calls) === show(['close()']), `${look}: the click called ${show(tg.calls)}`);
      const appHtml = renderHtml(React.createElement(NoCredentialCard, { look, inTelegram: true, links: LINKS }), 'he');
      assert(appHtml.includes(asHtml(he.pageGate.telegramTitle)) && appHtml.includes(asHtml(he.pageGate.close)), `${look}: the card's text`);
    }
  });

  await check('#9 PageGate\'s gate outcome renders the shared card with the page\'s links', () => {
    const src = readSource('app/[locale]/PageGate.tsx');
    const gate = src.slice(src.indexOf("if (outcome.kind === 'gate')"), src.indexOf('const data = outcome.data'));
    assert(/<NoCredentialCard[^>]*inTelegram=\{outcome\.inTelegram\}[^>]*links=\{links\}/.test(gate), `the gate branch: ${gate.trim()}`);
  });

  await check('#10 the browser title no longer says the link expired (en/he/ru), and the new labels exist in all three', () => {
    const titles: Record<string, RegExp> = { en: /expired/i, he: /פג/, ru: /устарел|истек/i };
    const problems: string[] = [];
    for (const [locale, expired] of Object.entries(titles)) {
      const gate = JSON.parse(readSource(`messages/${locale}.json`)).pageGate;
      if (expired.test(gate.browserTitle)) problems.push(`${locale} title: ${gate.browserTitle}`);
      for (const key of ['openWhatsApp', 'openTelegram', 'close']) {
        if (typeof gate[key] !== 'string' || !gate[key].trim()) problems.push(`${locale} has no pageGate.${key}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#11 a stale or used magic link lands on /<locale>/dashboard (the link\'s locale, else Accept-Language among en/he/ru), with no user_id and no cookie', async () => {
    const { NextRequest } = nodeRequire('next/server');
    const { GET } = await load('app/api/auth/magic/route.ts');
    const cases: [string, string | null, string][] = [
      ['token=stale&locale=he', 'ru-RU,ru;q=0.9', '/he/dashboard'],
      ['token=stale', 'ru-RU,ru;q=0.9,en;q=0.8', '/ru/dashboard'],
      ['token=stale', 'fr-FR,fr;q=0.9,he;q=0.5', '/he/dashboard'],
      ['token=stale', 'en;q=0.5, he', '/he/dashboard'],
      ['token=stale&locale=xx', 'de-DE', '/en/dashboard'],
      ['token=stale', null, '/en/dashboard'],
    ];
    const problems: string[] = [];
    for (const [query, acceptLanguage, want] of cases) {
      const res: Response = await GET(new NextRequest(`http://localhost/api/auth/magic?${query}`, {
        headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
      }));
      const to = new URL(res.headers.get('location') ?? 'http://x/none');
      if (to.pathname !== want || to.search) problems.push(`${query} + ${acceptLanguage}: ${to.pathname}${to.search} (want ${want})`);
      if (res.headers.get('set-cookie')) problems.push(`${query}: sets a cookie`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#12 a fresh magic link carries its locale, and still signs in: /<its locale>/dashboard?user_id=<id> with the session cookie', async () => {
    const { NextRequest } = nodeRequire('next/server');
    const { generateMagicLink } = await load('src/services/magic-link.ts');
    const { GET } = await load('app/api/auth/magic/route.ts');
    const link = new URL(await generateMagicLink(42, 'ru'));
    assert(link.searchParams.get('token') && link.searchParams.get('locale') === 'ru', `the link: ${link.pathname}${link.search.replace(/token=\w+/, 'token=…')}`);
    const res: Response = await GET(new NextRequest(`http://localhost${link.pathname}${link.search}`, { headers: { 'accept-language': 'he' } }));
    const to = new URL(res.headers.get('location') ?? 'http://x/none');
    assert(`${to.pathname}${to.search}` === '/ru/dashboard?user_id=42', `redirect: ${to.pathname}${to.search}`);
    assert((res.headers.get('set-cookie') ?? '').includes('famcal_session='), 'no session cookie');
  });

  await check('#13 TelegramDashboardRedirect shows the shared card when there is no Telegram user (no hard-coded English), and keeps pushing Telegram users on', () => {
    const src = readSource('app/[locale]/dashboard/TelegramDashboardRedirect.tsx');
    assert(src.includes('<NoCredentialCard'), 'it does not render NoCredentialCard');
    assert(src.includes('readInitData()'), 'it does not read initData to tell a browser from Telegram');
    assert(!/Please open this app|Type \/start in Telegram/.test(src), 'the hard-coded English card is still there');
    assert(src.includes('router.push(`/${locale}/dashboard?user_id=${userId}`)'), 'Telegram users are no longer pushed to their dashboard');
  });

  await check('#15 a stale or used magic link in a browser still signed in (valid famcal_session) goes to that user\'s dashboard; a bad cookie still gets the card', async () => {
    const { NextRequest } = nodeRequire('next/server');
    const { createSessionToken } = await load('src/lib/session-auth.ts');
    const { GET } = await load('app/api/auth/magic/route.ts');
    const call = async (cookie: string) => {
      const res: Response = await GET(new NextRequest('http://localhost/api/auth/magic?token=stale&locale=he', {
        headers: { 'accept-language': 'ru', cookie: `famcal_session=${cookie}` },
      }));
      const to = new URL(res.headers.get('location') ?? 'http://x/none');
      return { to: `${to.pathname}${to.search}`, setCookie: res.headers.get('set-cookie') };
    };
    const signedIn = await call(createSessionToken(7));
    assert(signedIn.to === '/he/dashboard?user_id=7', `valid session: ${signedIn.to}`);
    assert(!signedIn.setCookie, 'a stale link must not mint or touch a cookie');
    const [payload] = createSessionToken(7).split('.');
    const forged = await call(`${payload}.forged`);
    assert(forged.to === '/he/dashboard', `forged session: ${forged.to}`);
  });

  // ---- The dashboard's two homes (spec §7.1) ----

  /** The dashboard's props as page-data sends them before the calendar home (the trial end as an ISO string). */
  const DASHBOARD: Row = {
    user: { id: 5550001, name: 'Dana', location: 'Tel Aviv', isAdmin: true },
    locale: 'he',
    sources: ['famcal'],
    googleConnected: false,
    googleState: 'none',
    trial: { isTrialing: true, daysRemaining: 5, trialEndsAt: '2026-10-21T12:00:00.000Z' },
    isEarlyAdopter: false,
    hints: { reminders: true, voiceEvents: false },
    lookahead7: false,
  };
  /** JSON with sorted keys, so a comparison ignores key order. */
  const canon = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Row).sort().map(k => [k, (v as Row)[k]]))
      : v);
  /**
   * renderPage('dashboard', props), server-rendered once the home's dynamic() chunk has
   * loaded. The first pass starts the import and shows the loader while the chunk is not
   * in yet; later passes wait for the placeholder to record its props.
   */
  const renderDashboard = async (props: Row): Promise<{ first: string; html: string }> => {
    const { renderPage } = await load('app/[locale]/PageGate.tsx');
    assert(typeof renderPage === 'function', 'PageGate exports no renderPage');
    rendered.length = 0;
    const el = renderPage('dashboard', props);
    const first = renderHtml(el, 'he');
    let html = first;
    for (let i = 0; i < 200 && rendered.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      html = renderHtml(el, 'he');
    }
    return { first, html };
  };

  await check('#16 the app\'s dashboard loader (the home\'s own background and a spinner, no purple) while the home loads, then CalendarHome with exactly CalendarHomeProps (user.id is the page\'s user_id)', async () => {
    // The first check that renders the home, so its chunk is not loaded yet
    const { first, html } = await renderDashboard(DASHBOARD);
    assert(first.startsWith('<div class="ch-app ch-screen" data-theme="light" dir="rtl" lang="he">') && first.includes('class="ch-loader" role="status"') && first.includes('ch-spin'), `the first pass: ${first.slice(0, 200)}`);
    assert(first.includes(asHtml(he.pageGate.loading)) && !first.includes('#667eea') && !first.includes('smoke:'), 'the loading text, no purple, no home yet');
    assert(html.includes('smoke:CalendarHome'), `rendered: ${html.slice(0, 200)}`);
    const want = {
      user: { id: 5550001, name: 'Dana', isAdmin: true },
      locale: 'he',
      sources: ['famcal'],
      googleConnected: false,
      googleState: 'none',
      hints: { reminders: true, voiceEvents: false },
      trialDaysLeft: 5,
      hasLocation: true,
      lookahead7: false,
    };
    assert(canon(rendered[0]?.props) === canon(want), `CalendarHome got ${canon(rendered[0]?.props)}`);
  });

  await check('#17 a user with Google connected: the sources and the Google facts pass through, the hints are the page\'s, and an early adopter with no location gets no trial days and hasLocation false', async () => {
    const { html } = await renderDashboard({
      ...DASHBOARD, sources: ['famcal', 'google'], googleConnected: true, googleState: 'choose',
      user: { ...DASHBOARD.user, location: '' }, isEarlyAdopter: true,
    });
    assert(html.includes('smoke:CalendarHome'), `rendered: ${html.slice(0, 200)}`);
    const got = rendered[0].props;
    assert(canon(got.sources) === canon(['famcal', 'google']) && got.googleConnected === true && got.googleState === 'choose', `CalendarHome got ${canon(got)}`);
    assert(!('calendarSource' in got) && !('needsOAuth' in got) && !('needsCalendars' in got), `no legacy fact: ${canon(got)}`);
    assert(canon(got.hints) === canon({ reminders: true, voiceEvents: false }), `hints ${canon(got.hints)}`);
    assert(got.trialDaysLeft === null && got.hasLocation === false, `trialDaysLeft ${show(got.trialDaysLeft)}, hasLocation ${show(got.hasLocation)}`);
  });

  await check('#18 PRELOAD.dashboard starts the home\'s chunk, and LOOK.dashboard and LOOK.settings are app (the loader\'s look, which Settings\' chunk loads behind, on Settings\' own ground); the other pages keep theirs', () => {
    const src = readSource('app/[locale]/PageGate.tsx');
    const block = (name: string) => {
      const at = src.indexOf(`const ${name}`);
      return at < 0 ? '' : src.slice(at, src.indexOf('\n};', at));
    };
    const preload = block('PRELOAD');
    const entry = preload.slice(preload.indexOf('dashboard:'), preload.indexOf('settings:'));
    assert(entry.includes("import('./dashboard/CalendarHome')"), `no CalendarHome chunk in PRELOAD.dashboard: ${entry.trim() || '(not found)'}`);
    assert(!entry.includes('DashboardClient'), `PRELOAD.dashboard: ${entry.trim()}`);
    const look = block('LOOK');
    for (const page of ['dashboard', 'settings']) assert(new RegExp(`\\n\\s*${page}: 'app',`).test(look), `${page} is app: ${look}`);
    assert(/const Settings = dynamic\([^\n]*loading: groupedAppLoader/.test(src) && /const groupedAppLoader = \(\) => <PageLoader look="app" ground=\{GROUND\.settings\} \/>;/.test(src), "Settings' chunk loads behind the app's loader on its own (grouped) ground");
    for (const [page, kept] of [["'select-calendars'", 'telegram'], ['subscription', 'telegram'], ['calendars', 'light'], ['pair', 'light']]) {
      assert(new RegExp(`\\n\\s*${page}: '${kept}',`).test(look), `${page} keeps ${kept}: ${look}`);
    }
  });

  await check('#19 the calendar home\'s chunk sits inside PageGate\'s own boundary (the home\'s boundary lives inside that chunk), which reads the reload guard from the leaf reload-guard, never the home\'s code', async () => {
    const { renderPage, HomeChunkBoundary } = await load('app/[locale]/PageGate.tsx');
    assert(typeof HomeChunkBoundary === 'function', 'PageGate exports no HomeChunkBoundary');
    const on = renderPage('dashboard', DASHBOARD);
    assert(on?.type === HomeChunkBoundary, `the root is ${on?.type?.name ?? show(on?.type)}`);
    const home = on.props.children;
    assert(home?.props?.user?.id === 5550001 && home.props.hints?.reminders === true, `inside it, the home with its props: ${canon(home?.props)}`);
    const src = readSource('app/[locale]/PageGate.tsx');
    assert(src.includes("from '@/src/lib/calendar-view/reload-guard'"), 'the guard does not come from reload-guard');
    assert(!/calendar-view\/(?:home-client|home-loader|store|format)'|dashboard\/HomeErrorBoundary'/.test(src), 'PageGate imports the home\'s client code, which every page would then load');
    const leaf = readSource('src/lib/calendar-view/reload-guard.ts');
    assert(!/^import /m.test(leaf), 'reload-guard imports something');
  });

  await check("#20 a missing user_id gives the app's MissingParameterCard on all seven pages that had their own copy (settings, admin-panel, feedback, select-calendars, calendars, pair and refresh-token), in en, he and ru, with its text from messages and none of the old inline cards; subscription still answers notFound; select-calendars' two notices are StateCards in an AppScreen with their copy from messages in en, he and ru and nothing from the server", async () => {
    const { renderToString } = nodeRequire('react-dom/server');
    const problems: string[] = [];
    const old = (html: string) => /Missing Parameter|user_id parameter is required|Missing user_id|#667eea|linear-gradient|text-rose-600/.test(html);
    for (const locale of ['en', 'he', 'ru']) {
      const copy = JSON.parse(readSource(`messages/${locale}.json`)).ui.missingParameter;
      for (const name of ['settings', 'admin-panel', 'feedback', 'select-calendars', 'calendars', 'pair']) {
        const el = await callPage(`app/[locale]/${name}/page.tsx`, locale);
        if (el?.type?.name !== 'MissingParameterCard') {
          problems.push(`${locale} ${name} renders ${el?.type?.name ?? show(el)}`);
          continue;
        }
        const html = renderHtml(el, locale);
        if (!html.includes(asHtml(copy.title)) || !html.includes(asHtml(copy.body)) || old(html)) problems.push(`${locale} ${name}: ${html.slice(html.indexOf('<h1'), html.indexOf('<h1') + 160)}`);
        if (!html.startsWith(`<div class="ch-app ch-screen" data-theme="light" dir="${locale === 'he' ? 'rtl' : 'ltr'}" lang="${locale}">`) || !html.includes('<h1 class="ch-home-card-title">')) problems.push(`${locale} ${name}: not an AppScreen with the card's h1`);
      }
      // refresh-token sits outside [locale]: its page brings its own provider, in English
      const refresh = await callPage('app/refresh-token/page.tsx', locale);
      const html = renderToString(refresh);
      const en = JSON.parse(readSource('messages/en.json')).ui.missingParameter;
      if (!html.includes(asHtml(en.title)) || !html.includes(asHtml(en.body)) || old(html) || !html.includes('lang="en"')) problems.push(`refresh-token: ${html.slice(0, 200)}`);
    }
    let threw = false;
    try {
      await callPage('app/[locale]/subscription/page.tsx', 'en');
    } catch (err) {
      threw = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(String((err as Row)?.digest ?? err));
    }
    if (!threw) problems.push('subscription without a user_id no longer calls notFound()');
    // The notices of select-calendars: their copy from messages in each language, no raw key, nothing from the server
    for (const locale of ['en', 'he', 'ru']) {
      const m = JSON.parse(readSource(`messages/${locale}.json`));
      const gate = await callPage('app/[locale]/select-calendars/page.tsx', locale, '5550001');
      const notices = gate.props.notices as Row;
      const root = `<div class="ch-app ch-screen" data-theme="light" dir="${locale === 'he' ? 'rtl' : 'ltr'}" lang="${locale}">`;
      const none = renderHtml(notices.noGoogleToken, locale);
      if (!none.startsWith(root) || !none.includes(asHtml(m.calendars.noGoogle.title)) || !none.includes(asHtml(m.calendars.noGoogle.body)) || old(none) || /calendars\.noGoogle|No Google Token/.test(none)) problems.push(`${locale} noGoogleToken: ${none.slice(none.indexOf('<h1'), none.indexOf('<h1') + 220)}`);
      const error = renderHtml(notices.error, locale);
      const retry = `<a class="ch-btn ch-btn-primary ch-home-card-action" href="/${locale}/select-calendars?user_id=5550001">${asHtml(m.pageGate.retry)}</a>`;
      if (!error.startsWith(root) || !error.includes(asHtml(m.pageGate.errorTitle)) || !error.includes(asHtml(m.pageGate.errorBody)) || !error.includes(retry) || old(error)) problems.push(`${locale} error: ${error.slice(error.indexOf('<h1'), error.indexOf('<h1') + 300)}`);
      // The server's message never reaches the page: no fallback text, and no detail in the wire type or in PageGate
      if (/Unknown error|Try Again|NoticeDetail/.test(error)) problems.push(`${locale} error notice shows server detail or old copy`);
    }
    for (const rel of ['app/[locale]/PageGate.tsx', 'src/lib/page-data.ts']) {
      const code = readSource(rel).split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/NoticeDetail|\bdetail\b/.test(code)) problems.push(`${rel} still carries a notice detail`);
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
