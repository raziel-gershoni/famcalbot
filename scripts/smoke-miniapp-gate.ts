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
// while its session cookie is still valid. The dashboard's "open in Telegram"
// banner never showed, since the SDK defines Telegram.WebApp in any browser.
//
// The dashboard's two homes (calendar-home spec §7.1; Plan D, Task D7; #16-#20): the
// props' calendarHome picks CalendarHome or today's DashboardClient, each with exactly the
// props it takes. The new home loads behind the dashboard's purple loader, and both
// chunks start loading while the data is in flight. The new home's chunk sits inside
// PageGate's own boundary (spec §5); what it does with a failed import is the render
// smoke's #40, in real React (next/dynamic under tsx is the pages-router loadable, which
// never throws on a failed import).
//
// The pages, PageGate's cards and its dashboard branch, the magic-link route and its
// service run for real. Faked at the boundaries: Redis (in memory), Prisma (the one user
// lookup the magic route makes), the two dashboard homes (placeholders that record their
// props; DashboardClient cannot load under tsx), and the browser window. No network, no DB.
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

/** What PageGate's dashboard branch rendered: each home's placeholder records its props (#16-#18). */
const rendered: { home: 'DashboardClient' | 'CalendarHome'; props: Row }[] = [];

function installStubs() {
  // DashboardClient imports @hebcal/core, which ships ESM only with no require entry, so
  // it cannot load under tsx. It and the calendar home are placeholders at their real
  // paths: each records the props PageGate hands it and renders one marker line.
  stub('app/[locale]/dashboard/DashboardClient.tsx', {
    __esModule: true,
    default: function DashboardClient(props: Row) {
      rendered.push({ home: 'DashboardClient', props });
      return 'smoke:DashboardClient';
    },
  });
  stub('app/[locale]/dashboard/CalendarHome.tsx', {
    __esModule: true,
    default: function CalendarHome(props: Row) {
      rendered.push({ home: 'CalendarHome', props });
      return 'smoke:CalendarHome';
    },
  });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  // The magic route's only DB read: is the user suspended?
  stub('src/utils/prisma.ts', { prisma: { user: { findUnique: async () => ({ suspendedAt: null }) } } });
}

const he = JSON.parse(readSource('messages/he.json'));

/** Every element in a tree, with the elements inside its props (children, action). */
function elementsIn(node: unknown, out: Row[] = []): Row[] {
  if (Array.isArray(node)) {
    node.forEach(n => elementsIn(n, out));
  } else if (node && typeof node === 'object' && 'props' in node) {
    out.push(node as Row);
    for (const v of Object.values((node as Row).props ?? {})) elementsIn(v, out);
  }
  return out;
}

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

    await withWindow(null, () => startMiniApp('telegram'));
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
  });

  await check('#3 share-story keeps ready() alone: no expand() anywhere in it', () => {
    const src = readSource('app/[locale]/share-story/page.tsx');
    assert(src.includes('tg.ready()'), 'share-story no longer calls ready()');
    assert(!/expand\s*\(/.test(src), 'share-story calls expand()');
  });

  await check('#4 the global menu button path (TelegramDashboardRedirect) expands with ready() and sets the purple header', () => {
    const src = readSource('app/[locale]/dashboard/TelegramDashboardRedirect.tsx');
    const ready = src.indexOf('tg.ready()');
    const expand = src.indexOf('tg.expand()');
    assert(ready >= 0 && expand > ready, `ready() at ${ready}, expand() at ${expand}`);
    assert(src.includes("tg.setHeaderColor('#667eea')"), 'the header is not set to #667eea');
    assert(!src.includes("'secondary_bg_color'"), 'the header is still set to the theme colour first');
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
    for (const look of ['telegram', 'light']) {
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
    const clicks = elementsIn(treeOf(NoCredentialCard, { look: 'telegram', inTelegram: true, links: LINKS }, 'he'))
      .map(e => e.props.onClick).filter((f): f is () => void => typeof f === 'function');
    assert(clicks.length === 1, `${clicks.length} click handlers`);
    const tg = fakeWebApp();
    await withWindow(tg.webApp, () => clicks[0]());
    assert(show(tg.calls) === show(['close()']), `the click called ${show(tg.calls)}`);
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

  await check('#14 the dashboard\'s "open in Telegram" banner keys on readInitData() === \'\', not on window.Telegram.WebApp', () => {
    const src = readSource('app/[locale]/dashboard/DashboardClient.tsx');
    const at = src.indexOf('setShowTelegramBanner(true)');
    assert(at >= 0, 'no banner effect');
    const effect = src.slice(src.lastIndexOf('useEffect(', at), at);
    assert(effect.includes("readInitData() === ''"), `the banner effect: ${effect.trim()}`);
    assert(!effect.includes('window.Telegram'), 'the banner still checks window.Telegram');
    assert(src.includes("from '@/src/lib/read-init-data'"), 'DashboardClient does not import readInitData');
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
    user: { id: 5550001, name: 'Dana', location: 'Tel Aviv', calendarsCount: 0, isAdmin: true },
    calendarAssignments: [],
    locale: 'he',
    calendarSource: 'NATIVE',
    needsOAuth: false,
    needsCalendars: false,
    subscription: { plan: 'FREE', status: 'TRIALING', effectivePlan: 'PRO' },
    trial: { isTrialing: true, daysRemaining: 5, trialEndsAt: '2026-10-21T12:00:00.000Z' },
    isEarlyAdopter: false,
  };
  /** JSON with sorted keys, so a comparison ignores key order. */
  const canon = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Row).sort().map(k => [k, (v as Row)[k]]))
      : v);
  /**
   * renderPage('dashboard', props), server-rendered once the chosen home's dynamic() chunk
   * has loaded. The first pass starts the import and shows the loader while the chunk is
   * not in yet; later passes wait for a placeholder to record its props.
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

  await check('#16 calendarHome true: the purple dashboard loader while the new home loads, then CalendarHome with exactly CalendarHomeProps (user.id is the page\'s user_id), never DashboardClient', async () => {
    // The first check that renders the new home, so its chunk is not loaded yet
    const { first, html } = await renderDashboard({ ...DASHBOARD, calendarHome: true, hints: { reminders: true, voiceEvents: false } });
    assert(first.includes('linear-gradient(135deg, #667eea 0%, #764ba2 100%)') && !first.includes('smoke:'), `the first pass: ${first.slice(0, 200)}`);
    assert(html.includes('smoke:CalendarHome'), `rendered: ${html.slice(0, 200)}`);
    assert(rendered.every(r => r.home === 'CalendarHome'), `rendered ${show(rendered.map(r => r.home))}`);
    const want = {
      user: { id: 5550001, name: 'Dana', isAdmin: true },
      locale: 'he',
      calendarSource: 'NATIVE',
      needsOAuth: false,
      needsCalendars: false,
      hints: { reminders: true, voiceEvents: false },
      trialDaysLeft: 5,
      hasLocation: true,
    };
    assert(canon(rendered[0]?.props) === canon(want), `CalendarHome got ${canon(rendered[0]?.props)}`);
  });

  await check('#17 calendarHome false: today\'s DashboardClient with exactly today\'s props (the trial end back as a Date), never CalendarHome', async () => {
    const { html } = await renderDashboard({ ...DASHBOARD, calendarHome: false });
    assert(html.includes('smoke:DashboardClient'), `rendered: ${html.slice(0, 200)}`);
    assert(rendered.every(r => r.home === 'DashboardClient'), `rendered ${show(rendered.map(r => r.home))}`);
    const got = rendered[0].props;
    assert(Object.keys(got).sort().join(',') === Object.keys(DASHBOARD).sort().join(','), `DashboardClient's props: ${Object.keys(got).sort().join(',')}`);
    assert(got.trial.trialEndsAt instanceof Date && got.trial.trialEndsAt.toISOString() === DASHBOARD.trial.trialEndsAt, `trial: ${show(got.trial)}`);
    assert(canon({ ...got, trial: { ...got.trial, trialEndsAt: DASHBOARD.trial.trialEndsAt } }) === canon(DASHBOARD), `DashboardClient got ${canon(got)}`);
  });

  await check('#18 a Google user\'s home: calendarSource and the setup flags pass through, no hints promise nothing (R10), and an early adopter with no location gets no trial days and hasLocation false', async () => {
    const { html } = await renderDashboard({
      ...DASHBOARD, calendarSource: 'GOOGLE', needsOAuth: true, needsCalendars: true, calendarHome: true,
      user: { ...DASHBOARD.user, location: '' }, isEarlyAdopter: true,
    });
    assert(html.includes('smoke:CalendarHome'), `rendered: ${html.slice(0, 200)}`);
    const got = rendered[0].props;
    assert(got.calendarSource === 'GOOGLE' && got.needsOAuth === true && got.needsCalendars === true, `CalendarHome got ${canon(got)}`);
    assert(canon(got.hints) === canon({ reminders: false, voiceEvents: false }), `hints ${canon(got.hints)}`);
    assert(got.trialDaysLeft === null && got.hasLocation === false, `trialDaysLeft ${show(got.trialDaysLeft)}, hasLocation ${show(got.hasLocation)}`);
  });

  await check('#19 PRELOAD.dashboard starts both homes\' chunks, and LOOK.dashboard stays telegram (the loader\'s look)', () => {
    const src = readSource('app/[locale]/PageGate.tsx');
    const block = (name: string) => {
      const at = src.indexOf(`const ${name}`);
      return at < 0 ? '' : src.slice(at, src.indexOf('\n};', at));
    };
    const preload = block('PRELOAD');
    const entry = preload.slice(preload.indexOf('dashboard:'), preload.indexOf('settings:'));
    for (const chunk of ["import('./dashboard/DashboardClient')", "import('./dashboard/CalendarHome')"]) {
      assert(entry.includes(chunk), `no ${chunk} in PRELOAD.dashboard: ${entry.trim() || '(not found)'}`);
    }
    assert(/\n\s*dashboard: 'telegram',/.test(block('LOOK')), `LOOK: ${block('LOOK')}`);
  });

  await check('#20 the calendar home\'s chunk sits inside PageGate\'s own boundary (the home\'s boundary lives inside that chunk), which reads the reload guard from the leaf reload-guard, never the home\'s code; DashboardClient gets no boundary', async () => {
    const { renderPage, HomeChunkBoundary } = await load('app/[locale]/PageGate.tsx');
    assert(typeof HomeChunkBoundary === 'function', 'PageGate exports no HomeChunkBoundary');
    const on = renderPage('dashboard', { ...DASHBOARD, calendarHome: true, hints: { reminders: true, voiceEvents: false } });
    assert(on?.type === HomeChunkBoundary, `the switch on: the root is ${on?.type?.name ?? show(on?.type)}`);
    const home = on.props.children;
    assert(home?.props?.user?.id === 5550001 && home.props.hints?.reminders === true, `inside it, the home with its props: ${canon(home?.props)}`);
    const off = renderPage('dashboard', { ...DASHBOARD, calendarHome: false });
    assert(!elementsIn(off).some(e => e.type === HomeChunkBoundary), 'the switch off: no boundary around DashboardClient');
    const src = readSource('app/[locale]/PageGate.tsx');
    assert(src.includes("from '@/src/lib/calendar-view/reload-guard'"), 'the guard does not come from reload-guard');
    assert(!/calendar-view\/(?:home-client|home-loader|store|format)'|dashboard\/HomeErrorBoundary'/.test(src), 'PageGate imports the home\'s client code, which every page would then load');
    const leaf = readSource('src/lib/calendar-view/reload-guard.ts');
    assert(!/^import /m.test(leaf), 'reload-guard imports something');
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
