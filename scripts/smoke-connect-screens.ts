// Smoke test for the Google connect pages in the app's design (plan docs/superpowers/plans/2026-10-29-w4-3-google-connect.md;
// spec 2026-10-19-screens-and-colours §4, §5; the connect flow is spec 2026-10-19-google-connection, unchanged here):
// /refresh-token, /oauth-callback and /oauth-complete.
//
//  - D1..D4 the shell: the three pages sit in the (connect) route group, whose one root layout loads the global CSS (the
//    kit's colours outside Telegram) and leaves the document to ConnectShell; each page's <html> has its language and
//    direction (en, he, ru); the Telegram SDK loads before hydration on /refresh-token only.
//  - R1..R6 /refresh-token on the kit (en, he, ru; light and dark; inside Telegram and in a browser): the header, the
//    steps in order, Connect busy while Google's URL is made; a failed start says why and can be tried again; the
//    waiting notice with Check again and, once the 3-minute poll ends, the line that says so; the loader while it
//    checks; the move on once the token lands; Back to the calendar with a full load (Telegram's button and the page's).
//  - B1..B7 /oauth-callback: every state that is not a success is one translated card with a way back (an expired or
//    used link, Google's deny, a failure on our side with no raw error text, Google refusing the code, the scopes page,
//    no refresh token), in the owner's language or else the browser's; /api/refresh-token turns a return with no code
//    into the callback's card instead of JSON.
//  - F1..F4 /oauth-complete: the loader before the fragment is read, the ready page (the owner line through ICU, the
//    buttons per b=), the incomplete card.
//  - K1 the pages' own style sheet passes the kit's lint and the sources hold no old look and no inline copy.
//
// The pages run as Next runs them (the server page as a function, then react-dom/server), with Prisma, Redis, error
// capture, the request's headers and Google's token endpoint faked; the two client screens also run in real React on the
// small fake DOM, with a fake Telegram.WebApp, a fake fetch, a clock and the poll's interval in hand. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-connect-screens.ts

import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { act, createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { elements, fakeDocument, fakeTelegram, fakeWindow, FakeElement, installWindow, memoryStorage, mount, type Mounted } from './lib/fake-dom';
import { lintCss } from './lib/css-lint';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const CONNECT = 'app/(connect)';

process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';
process.env.WHATSAPP_PHONE_NUMBER = '15550001111';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ENCRYPTION_KEY_PREVIOUS = '';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';

type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;
const dirOf = (l: Locale) => (l === 'he' ? 'rtl' : 'ltr');

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message || String(err.stack).split("\n").slice(0, 6).join(" | ") : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Text as React writes it into HTML. */
const asHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// ---- The server's world: Prisma, Redis, error capture, the request's headers, Google ----

const DB: { user: Row[]; oAuthState: Row[] } = { user: [], oAuthState: [] };
let takenBetween = false;
const redisStore = new Map<string, string>();
const captured: string[] = [];
let acceptLanguage = 'en-US,en;q=0.9';
let googleAnswer: Row = {};
let googleThrows: Error | null = null;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BOTH_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';

const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => (typeof v === 'bigint' || typeof row[k] === 'bigint' ? String(row[k]) === String(v) : row[k] === v));
const fakePrisma = {
  user: {
    findUnique: async ({ where }: Row) => DB.user.find((u) => matches(u, where)) ?? null,
    findFirst: async ({ where }: Row = {}) => DB.user.find((u) => matches(u, where)) ?? null,
  },
  oAuthState: {
    findUnique: async ({ where }: Row) => DB.oAuthState.find((s) => matches(s, where)) ?? null,
    deleteMany: async ({ where }: Row) => {
      // Another callback took the row between this one's read and its delete
      if (takenBetween) {
        takenBetween = false;
        DB.oAuthState = DB.oAuthState.filter((s) => !matches(s, where));
      }
      const before = DB.oAuthState.length;
      DB.oAuthState = DB.oAuthState.filter((s) => !matches(s, where));
      return { count: before - DB.oAuthState.length };
    },
  },
};
const fakeRedis = {
  set: async (k: string, v: string) => void redisStore.set(k, v),
  get: async (k: string) => redisStore.get(k) ?? null,
  del: async (k: string) => Number(redisStore.delete(k)),
};

function stubFile(filename: string, exports: Row) {
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  (Module as unknown as { _cache: Record<string, Module> })._cache[filename] = mod;
}
const stub = (rel: string, exports: Row) => stubFile(path.join(ROOT, rel), exports);

stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
stub('src/utils/redis.ts', { redis: fakeRedis });
const capture = (e: unknown, ctx: string) => void captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`);
stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
// The request's headers, as next/headers gives them in a request
stubFile(nodeRequire.resolve('next/headers', { paths: [ROOT] }), { headers: async () => new Headers({ 'accept-language': acceptLanguage }) });
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === GOOGLE_TOKEN_URL) {
    tokenCalls++;
    if (googleThrows) throw googleThrows;
    return new Response(JSON.stringify(googleAnswer), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`network blocked in smoke: ${url}`);
}) as typeof fetch;
/** The server's fetch (Google's token endpoint); a browser of the smoke's replaces it while it is open. */
const serverFetch = globalThis.fetch;

const DAY = 86_400_000;
function user(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    googleScopes: [], googleSyncNotifiedAt: null, pairingId: null, remindersEnabled: false, suspendedAt: null,
    unreachableSince: null, whatsappPhone: null, whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [],
    voiceInputEnabled: true, textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY),
    ...o,
  };
}
/** 9 = Tal on Telegram 111111111; 42 = Noa, WhatsApp only. */
const TAL_TG = 111111111;
function seed(o: { talLanguage?: Locale; noaLanguage?: Locale } = {}) {
  DB.user = [
    // A legacy Google user whose token was cleared, with calendars stored: the reconnect copy
    user({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), language: o.talLanguage ?? 'en', calendarSource: 'GOOGLE', calendarAssignments: [{ calendarId: 'tal@gmail.com', labels: ['primary', 'yours'], name: 'Tal', color: '#4285F4' }] }),
    user({ id: 42, name: 'Noa', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.123', language: o.noaLanguage ?? 'he' }),
  ];
  DB.oAuthState = [];
  redisStore.clear();
  captured.length = 0;
  acceptLanguage = 'en-US,en;q=0.9';
  googleAnswer = { refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'test' };
  googleThrows = null;
  tokenCalls = 0;
}
let seq = 0;
function addState(userId: number, o: { expired?: boolean } = {}): string {
  const token = `u1_${crypto.randomBytes(32).toString('hex')}`;
  DB.oAuthState.push({ id: `st-${++seq}`, userId: BigInt(userId), token, createdAt: new Date(), expiresAt: new Date(Date.now() + (o.expired ? -60_000 : 10 * 60_000)) });
  return token;
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

/** Runs `fn` with the pages' logs kept apart; returns what console.error and console.warn got. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const { log, warn, error } = console;
  const logs: string[] = [];
  console.log = () => undefined;
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    return { value: await fn(), logs };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

type PageEnd = { element?: Row; redirect?: string; threw?: string };
/** Run a server page as Next does; a redirect throws. */
async function runPage(rel: string, searchParams: Row): Promise<PageEnd> {
  const page = (await load(rel)).default;
  try {
    return { element: (await page({ searchParams: Promise.resolve(searchParams) })) as Row };
  } catch (err) {
    const digest = String((err as Row)?.digest ?? '');
    if (digest.startsWith('NEXT_REDIRECT')) return { redirect: digest.split(';')[2] };
    return { threw: err instanceof Error ? err.stack ?? err.message : String(err) };
  }
}
const refreshPage = (q: Row) => runPage(`${CONNECT}/refresh-token/page.tsx`, q);
const callbackPage = (q: Row) => quietly(() => runPage(`${CONNECT}/oauth-callback/page.tsx`, q));
const completePage = (q: Row) => runPage(`${CONNECT}/oauth-complete/page.tsx`, q);

/**
 * Every element of a server-rendered tree, components included. A component is called to see what it draws; one that
 * needs React's runtime (a hook: the kit's screen, next-intl's provider, next/script) is not, and its children are
 * walked instead.
 */
const NEEDS_REACT = new Error('needs React');
function elementsOf(node: unknown, out: Row[] = []): Row[] {
  if (Array.isArray(node)) {
    node.forEach((n) => elementsOf(n, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const el = node as Row;
  out.push(el);
  if (typeof el.type === 'function') {
    const internals = nodeRequire('react').__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as Row;
    const saved = internals.H;
    // A hook throws NEEDS_REACT; a library may wrap what its hook threw (next-intl does), so the hook's call is what counts
    let hooked = false;
    internals.H = new Proxy({}, { get: () => () => { hooked = true; throw NEEDS_REACT; } });
    let rendered: unknown;
    try {
      rendered = el.type(el.props);
    } catch (err) {
      if (!hooked) throw err;
      rendered = el.props?.children;
    } finally {
      internals.H = saved;
    }
    if (!(rendered && typeof (rendered as Row).then === 'function')) elementsOf(rendered, out);
    return out;
  }
  elementsOf(el.props?.children, out);
  return out;
}

/** The page's document, as react-dom/server writes it. */
function html(end: PageEnd): string {
  assert(end.element, `the page did not render: ${show(end.redirect ?? end.threw)}`);
  return renderToString(end.element as never);
}
const htmlTag = (doc: string) => /^<html[^>]*>/.exec(doc)?.[0] ?? `(no <html> first: ${doc.slice(0, 80)})`;

const SDK = 'https://telegram.org/js/telegram-web-app.js';
/** The SDK's <Script> in the document's head, with its strategy, or null. */
function sdkScript(end: PageEnd): Row | null {
  assert(end.element, `the page did not render: ${show(end.redirect ?? end.threw)}`);
  const all = elementsOf(end.element);
  const head = all.find((e) => e.type === 'head');
  const inHead = head ? elementsOf(head.props.children) : [];
  const anywhere = all.filter((e) => e.props?.src === SDK);
  assert(anywhere.every((e) => inHead.includes(e)), 'an SDK tag outside <head>');
  return anywhere[0] ?? null;
}

const CONNECT_FILES = () => {
  const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : /\.tsx?$/.test(d.name) ? [`${dir}/${d.name}`] : []));
  return walk(CONNECT);
};


// ---- What a person reads ----

/** The text a person sees or hears in a document: no style sheets or scripts; aria-labels and titles counted. */
function visibleText(doc: string): string {
  const labels = [...doc.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  const body = doc.replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
  return [body, ...labels].join(' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
/** Latin words left in a Hebrew or Russian page once the names that stay Latin are taken out. */
const NAMES = /\b(?:Google|FamCal|Telegram|WhatsApp|Gmail)\b/g;
const englishIn = (text: string) => text.replace(NAMES, ' ').match(/[A-Za-z]{2,}/g) ?? [];

// ---- The browser's side: the fake DOM, Telegram, fetch, the clock and the poll's interval ----

interface ApiCall { path: string; method: string; headers: Record<string, string>; body: unknown; credentials?: string }
interface Browser {
  calls: ApiCall[];
  opened: string[];
  tgCalls: string[];
  storage: Row;
  tg: Row | null;
  /** The next answers for a route, in order; when none is queued the default answers. */
  answer: Record<string, Array<() => Promise<Response> | Response>>;
  /** Moves the page's clock on. */
  advance: (ms: number) => void;
  /** Runs every live interval once. */
  tick: () => Promise<void>;
  intervals: Map<number, () => void>;
}
const realNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fresh browser: inside Telegram (`telegram` is its colour scheme) or a plain one (the WhatsApp session cookie),
 * `prefersDark` for the browser's own scheme. oauth/start answers a Google URL by default; check-token-refresh "not yet".
 */
function freshBrowser(o: { telegram?: 'light' | 'dark' | null; prefersDark?: boolean } = {}): Browser {
  installWindow();
  let shift = 0;
  const intervals = new Map<number, () => void>();
  let next = 0;
  const b: Browser = {
    calls: [], opened: [], tgCalls: [], storage: memoryStorage(), tg: null, answer: {}, intervals,
    advance: (ms) => { shift += ms; },
    tick: async () => {
      await act(async () => { for (const run of [...intervals.values()]) run(); });
      await settle();
    },
  };
  Date.now = () => realNow() + shift;
  globalThis.setInterval = ((run: () => void) => { intervals.set(++next, run); return next; }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => void intervals.delete(id)) as typeof clearInterval;
  if (o.telegram) {
    b.tg = { ...fakeTelegram(b.tgCalls, '8.0'), colorScheme: o.telegram, openLink: (url: string) => void b.opened.push(url) };
    fakeWindow.Telegram = { WebApp: b.tg };
  } else {
    delete fakeWindow.Telegram;
  }
  fakeWindow.open = (url: string) => void b.opened.push(url);
  fakeWindow.location = { href: 'https://app.example.test/refresh-token', hash: '' };
  fakeWindow.matchMedia = () => ({ matches: !!o.prefersDark, addEventListener() {}, removeEventListener() {} });
  fakeWindow.history = { back: () => { throw new Error('history.back() was called'); } };
  fakeDocument.hidden = false;
  (globalThis as Row).localStorage = b.storage;
  globalThis.fetch = (async (input: unknown, init: Row = {}) => {
    const url = new URL(String(input), 'https://app.example.test');
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    b.calls.push({ path: url.pathname + url.search, method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : undefined, credentials: init.credentials });
    const queued = b.answer[url.pathname]?.shift();
    if (queued) return queued();
    if (url.pathname === '/api/oauth/start') return json({ oauthUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=u1_${b.calls.length}`, serverTime: Date.now() });
    if (url.pathname === '/api/check-token-refresh') return json({ refreshed: false });
    throw new Error(`no route in the smoke: ${url.pathname}`);
  }) as typeof fetch;
  return b;
}
function leaveBrowser() {
  globalThis.fetch = serverFetch;
  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
}

const settle = () => act(async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});
const textOf = (node: Row) => String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
const all = (m: Mounted) => elements(m.container);
const buttonNamed = (m: Mounted, label: string) => all(m).find((e: Row) => e.localName === 'button' && (textOf(e) === label || e.getAttribute('aria-label') === label)) as Row | undefined;
const root = (m: Mounted) => all(m).find((e: Row) => String(e.getAttribute('class') ?? '').includes('ch-app')) as Row;

/** The provider the shell gives the page, around a client element. */
function inProvider(locale: Locale, namespaces: string[], child: ReactElement): ReactElement {
  const pick = Object.fromEntries(['ui', 'pageGate', ...namespaces].map((n) => [n, messages[locale][n]]));
  return h(NextIntlClientProvider, { locale, messages: pick, timeZone: 'UTC', children: child });
}

/** /refresh-token's client, as its page gives it (the user's language and copy), mounted in the browser. */
async function mountRefresh(locale: Locale, o: { telegram?: 'light' | 'dark' | null; prefersDark?: boolean; user?: number } = {}): Promise<{ m: Mounted; b: Browser; client: Row }> {
  seed({ talLanguage: locale, noaLanguage: locale });
  const end = await refreshPage({ user_id: String(o.user ?? TAL_TG) });
  assert(end.element, `refresh-token: ${show(end.redirect ?? end.threw)}`);
  const client = pageClient(end.element);
  const b = freshBrowser({ telegram: o.telegram === undefined ? 'light' : o.telegram, prefersDark: o.prefersDark });
  const m = mount(inProvider(locale, ['refreshToken'], h(client.type, client.props)));
  await settle();
  return { m, b, client };
}
/** The page's own element inside the document its page draws. */
const pageClient = (el: Row): Row => (el?.type?.name === 'ConnectShell' ? el.props.children : el);
const connectButton = (m: Mounted, t: Row) => all(m).find((e: Row) => e.localName === 'button' && (textOf(e) === t.button || textOf(e) === t.preparing)) as Row | undefined;


/** A mounted tree as HTML (enough for the text a person reads). */
function serialize(node: Row): string {
  if (!(node instanceof FakeElement)) return String(node.data ?? '').replace(/</g, '&lt;');
  const attrs = [...node.attributes.entries()].map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  return `<${node.localName}${attrs}>${node.childNodes.map((c: Row) => serialize(c)).join('')}</${node.localName}>`;
}
let tokenCalls = 0;
const googleCalls = () => tokenCalls;

async function main() {
  // ---- D: the shell ----

  await check('D1 the three pages sit in the (connect) route group; its one root layout loads the global CSS (the kit\'s colours outside Telegram) and leaves the document to the page; no page or client draws an <html> of its own, and nothing but the shell names the Telegram SDK', async () => {
    for (const page of ['refresh-token', 'oauth-callback', 'oauth-complete']) {
      assert(fs.existsSync(path.join(ROOT, `${CONNECT}/${page}/page.tsx`)), `${page} is not in the group`);
      assert(!fs.existsSync(path.join(ROOT, `app/${page}`)), `app/${page} is still there`);
    }
    const layouts = CONNECT_FILES().filter((f) => /\/layout\.tsx?$/.test(f));
    assert(show(layouts) === show([`${CONNECT}/layout.tsx`]), `layouts: ${show(layouts)}`);
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const layoutSrc = code(readSource(`${CONNECT}/layout.tsx`));
    assert(/^import '\.\.\/globals\.css';$/m.test(layoutSrc), 'the layout does not import ../globals.css');
    assert(!/<html|<body/.test(layoutSrc), 'the layout draws the document');
    const globals = readSource('app/globals.css');
    const theme = readSource('components/app-ui/theme.ts');
    for (const token of ['--bg-white', '--text-primary', '--brand-primary-dark']) {
      assert(new RegExp(`^\\s*${token}:`, 'm').test(globals) && theme.includes(`var(${token})`), `${token}: the kit's fallback is not in globals.css`);
    }
    // The layout can't be loaded here (Node has no CSS loader); its body is the children, as they are
    assert(/export default function \w+\(\{ children \}[^)]*\) \{\s*return children;\s*\}/.test(layoutSrc), 'the layout does more than pass the page through');
    for (const file of CONNECT_FILES().filter((f) => !f.endsWith('/ConnectShell.tsx'))) {
      const src = code(readSource(file));
      assert(!/<html\b|<body\b|<head\b/.test(src), `${file} draws a document of its own`);
      assert(!src.includes('telegram-web-app.js'), `${file} names the Telegram SDK`);
    }
  });

  await check('D2 each page\'s <html> has its language and direction: /refresh-token the user\'s (en, he, ru; no user_id: en), /oauth-complete its ?locale (anything else: en), /oauth-callback the user\'s', async () => {
    const problems: string[] = [];
    const want = (l: Locale) => `<html lang="${l}" dir="${dirOf(l)}">`;
    for (const l of LOCALES) {
      seed({ talLanguage: l });
      const tag = htmlTag(html(await refreshPage({ user_id: String(TAL_TG) })));
      if (tag !== want(l)) problems.push(`refresh-token ${l}: ${tag}`);
      const done = htmlTag(html(await completePage({ locale: l })));
      if (done !== want(l)) problems.push(`oauth-complete ${l}: ${done}`);
      // A refusal of the code: the card is in the owner's language
      seed({ talLanguage: l });
      googleAnswer = { error: 'invalid_grant', error_description: 'Bad Request' };
      const { value: end } = await callbackPage({ code: 'c', state: addState(9) });
      const cb = htmlTag(html(end));
      if (cb !== want(l)) problems.push(`oauth-callback ${l}: ${cb}`);
    }
    seed();
    const missing = html(await refreshPage({}));
    if (htmlTag(missing) !== want('en') || !missing.includes(asHtml(messages.en.ui.missingParameter.title))) problems.push(`refresh-token, no user_id: ${htmlTag(missing)}`);
    const odd = htmlTag(html(await completePage({ locale: 'xx' })));
    if (odd !== want('en')) problems.push(`oauth-complete ?locale=xx: ${odd}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('D3 the Telegram SDK loads before hydration (next/script, beforeInteractive, in <head>) on /refresh-token, with and without a user_id; never on the two browser pages', async () => {
    seed();
    for (const q of [{ user_id: String(TAL_TG) }, {}]) {
      const sdk = sdkScript(await refreshPage(q));
      assert(sdk?.props.strategy === 'beforeInteractive', `refresh-token ${show(q)}: ${show(sdk?.props ?? null)}`);
    }
    assert(sdkScript(await completePage({ locale: 'he' })) === null, 'the finish page loads the SDK');
    googleAnswer = { error: 'invalid_grant' };
    const { value: refused } = await callbackPage({ code: 'c', state: addState(9) });
    assert(sdkScript(refused) === null, 'the callback loads the SDK');
  });

  await check('D4 the document\'s title is the page\'s own, in its language', async () => {
    for (const l of LOCALES) {
      seed({ talLanguage: l });
      const doc = html(await refreshPage({ user_id: String(TAL_TG) }));
      const title = /<title>([^<]*)<\/title>/.exec(doc)?.[1];
      assert(title === asHtml(messages[l].refreshToken.title), `refresh-token ${l}: ${title}`);
      const done = /<title>([^<]*)<\/title>/.exec(html(await completePage({ locale: l })))?.[1];
      assert(done === asHtml(messages[l].oauthComplete.title), `oauth-complete ${l}: ${done}`);
    }
  });


  // ---- R: /refresh-token ----

  await check('R1 /refresh-token is an AppScreen on the kit in each language and look: the title in the header, the lead, the three steps as a numbered list in order under their label, one primary Continue; busy with "Getting Google ready" until oauth/start answers; Telegram\'s theme inside Telegram, the browser\'s outside it; nothing in English in he and ru', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const look of [{ telegram: 'light' as const }, { telegram: 'dark' as const }, { telegram: null, prefersDark: true }, { telegram: null, prefersDark: false }]) {
        const t = messages[l].refreshToken;
        // Hold oauth/start's answer, to see the button while the URL is made
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        seed({ talLanguage: l });
        const end = await refreshPage({ user_id: String(TAL_TG) });
        const client = pageClient(end.element as Row);
        const b = freshBrowser(look);
        b.answer['/api/oauth/start'] = [async () => { await held; return json({ oauthUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=u1_x', serverTime: Date.now() }); }];
        const m = mount(inProvider(l, ['refreshToken'], h(client.type, client.props)));
        await settle();
        const tag = `${l} ${look.telegram ?? (look.prefersDark ? 'browser-dark' : 'browser-light')}`;
        const scheme = look.telegram ?? (look.prefersDark ? 'dark' : 'light');
        const r = root(m);
        if (r?.getAttribute('data-theme') !== scheme || r?.getAttribute('dir') !== dirOf(l) || !String(r.getAttribute('class')).includes('ch-screen')) problems.push(`${tag}: root ${show([...(r?.attributes ?? [])])}`);
        const h1 = all(m).find((e: Row) => e.localName === 'h1');
        if (!h1 || textOf(h1) !== t.title) problems.push(`${tag}: h1 ${h1 ? textOf(h1) : 'none'}`);
        if (!all(m).some((e: Row) => textOf(e) === t.subtitle && e.localName === 'p')) problems.push(`${tag}: no lead`);
        const ol = all(m).find((e: Row) => e.localName === 'ol') as Row | undefined;
        const steps = ol ? elements(ol as FakeElement).filter((e: Row) => e.localName === 'li').map(textOf) : [];
        if (show(steps) !== show([`1${t.step1}`, `2${t.step2}`, `3${t.step3}`].map((x) => x.replace(/\s+/g, ' ')))) problems.push(`${tag}: steps ${show(steps)}`);
        const label = all(m).find((e: Row) => e.localName === 'h2');
        if (!label || textOf(label) !== t.stepsTitle) problems.push(`${tag}: steps label ${label ? textOf(label) : 'none'}`);
        const busy = connectButton(m, t);
        if (!busy || busy.getAttribute('disabled') === null || textOf(busy) !== t.preparing || !String(busy.getAttribute('class')).includes('ch-btn-primary') || !elements(busy as FakeElement).some((e: Row) => String(e.getAttribute('class')).includes('ch-form-spinner'))) problems.push(`${tag}: while preparing ${busy ? show([textOf(busy), busy.getAttribute('disabled'), busy.getAttribute('class')]) : 'no button'}`);
        release();
        await settle();
        const ready = connectButton(m, t);
        if (!ready || ready.getAttribute('disabled') !== null || textOf(ready) !== t.button) problems.push(`${tag}: ready ${ready ? show([textOf(ready), ready.getAttribute('disabled')]) : 'no button'}`);
        if (l !== 'en') {
          const english = englishIn(visibleText(m.container.textContent ? serialize(m.container) : ''));
          if (english.length) problems.push(`${tag}: English ${show(english)}`);
        }
        m.unmount();
        leaveBrowser();
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('R2 a start that fails says why in an error notice: a server or network failure offers Try again, which asks oauth/start again and brings Continue back; a refused credential says what the gate says (Telegram: reopen from the bot; browser: the WhatsApp link) with nothing to retry', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      const t = messages[l].refreshToken;
      const gate = messages[l].pageGate;
      for (const failure of ['500', 'network'] as const) {
        seed({ talLanguage: l });
        const client = pageClient((await refreshPage({ user_id: String(TAL_TG) })).element as Row);
        const b = freshBrowser({ telegram: 'dark' });
        b.answer['/api/oauth/start'] = [failure === '500' ? () => json({ error: 'x' }, 500) : () => { throw new TypeError('Failed to fetch'); }];
        const { value: m, logs } = await quietly(async () => {
          const mounted = mount(inProvider(l, ['refreshToken'], h(client.type, client.props)));
          await settle();
          return mounted;
        });
        const alert = all(m).find((e: Row) => e.getAttribute('role') === 'alert') as Row | undefined;
        if (!alert || !textOf(alert).includes(t.startFailed)) problems.push(`${l} ${failure}: alert ${alert ? textOf(alert) : 'none'}`);
        if (connectButton(m, t)) problems.push(`${l} ${failure}: Continue shows beside the error`);
        if (!logs.some((x) => x.startsWith('[refresh-token]'))) problems.push(`${l} ${failure}: nothing logged ${show(logs)}`);
        const retry = buttonNamed(m, t.retry);
        if (!retry) { problems.push(`${l} ${failure}: no Try again`); m.unmount(); leaveBrowser(); continue; }
        const before = b.calls.filter((c) => c.path === '/api/oauth/start').length;
        m.click(retry as FakeElement);
        await settle();
        const after = b.calls.filter((c) => c.path === '/api/oauth/start').length;
        const ready = connectButton(m, t);
        if (after !== before + 1 || !ready || ready.getAttribute('disabled') !== null || all(m).some((e: Row) => e.getAttribute('role') === 'alert')) problems.push(`${l} ${failure}: after Try again: calls ${before}->${after}, button ${ready ? textOf(ready) : 'none'}`);
        m.unmount();
        leaveBrowser();
      }
      for (const inTelegram of [true, false]) {
        seed({ talLanguage: l });
        const client = pageClient((await refreshPage({ user_id: String(TAL_TG) })).element as Row);
        const b = freshBrowser({ telegram: inTelegram ? 'light' : null });
        b.answer['/api/oauth/start'] = [() => json({ error: 'Unauthorized' }, 401)];
        const { value: m } = await quietly(async () => {
          const mounted = mount(inProvider(l, ['refreshToken'], h(client.type, client.props)));
          await settle();
          return mounted;
        });
        const alert = all(m).find((e: Row) => e.getAttribute('role') === 'alert') as Row | undefined;
        const want = inTelegram ? [gate.telegramTitle, gate.telegramBody] : [gate.browserTitle, gate.browserBody, gate.browserTelegramHint];
        if (!alert || !want.every((x) => textOf(alert).includes(x))) problems.push(`${l} 401 ${inTelegram ? 'telegram' : 'browser'}: ${alert ? textOf(alert) : 'none'}`);
        if (buttonNamed(m, t.retry)) problems.push(`${l} 401: a Try again that cannot help`);
        m.unmount();
        leaveBrowser();
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('R3 after Continue: Google opens (Telegram\'s openLink inside Telegram, a new tab in a browser on the WhatsApp session, with no initData header), the waiting notice says where to finish and offers Check again, which asks check-token-refresh at once (the header credential and since) behind the loader that says it is checking; the 2 s poll runs for 3 minutes and then the notice says it is still waiting and the poll stops; Continue again starts a new wait', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const inTelegram of [true, false]) {
        const t = messages[l].refreshToken;
        const { m, b } = await mountRefresh(l, { telegram: inTelegram ? 'dark' : null });
        const tag = `${l} ${inTelegram ? 'telegram' : 'browser'}`;
        const start = b.calls.find((c) => c.path === '/api/oauth/start');
        if (!start || start.method !== 'POST' || start.credentials !== 'same-origin' || (start.body as Row)?.user_id !== String(TAL_TG)) problems.push(`${tag}: oauth/start ${show(start)}`);
        m.click(connectButton(m, t) as FakeElement);
        await settle();
        if (b.opened.length !== 1 || !b.opened[0].startsWith('https://accounts.google.com/')) problems.push(`${tag}: opened ${show(b.opened)}`);
        const pending = JSON.parse(b.storage.getItem('famcalbot_oauth_pending') ?? 'null');
        if (pending?.userId !== String(TAL_TG) || typeof pending.startTime !== 'number') problems.push(`${tag}: pending ${show(pending)}`);
        const status = () => all(m).find((e: Row) => e.getAttribute('role') === 'status' && textOf(e).includes(inTelegram ? t.waitingTelegram : t.waitingWhatsApp)) as Row | undefined;
        if (!status()) problems.push(`${tag}: no waiting notice`);
        if (status() && textOf(status() as Row).includes(t.stillWaiting)) problems.push(`${tag}: says still waiting too soon`);
        // Check again: one check at once, behind the loader
        let answer!: (r: Response) => void;
        b.answer['/api/check-token-refresh'] = [() => new Promise<Response>((resolve) => { answer = resolve; })];
        const checks = () => b.calls.filter((c) => c.path.startsWith('/api/check-token-refresh'));
        const before = checks().length;
        m.click(buttonNamed(m, t.checkAgain) as FakeElement);
        await settle();
        const asked = checks().at(-1);
        if (checks().length !== before + 1 || !asked?.path.includes(`since=${pending?.startTime}`) || asked.path.includes('initData')) problems.push(`${tag}: Check again asked ${show(checks().slice(before))}`);
        if (inTelegram ? !asked?.headers['x-telegram-init-data'] : asked?.headers['x-telegram-init-data'] !== undefined) problems.push(`${tag}: the credential header ${show(asked?.headers)}`);
        const loader = all(m).find((e: Row) => String(e.getAttribute('class')).includes('ch-loader')) as Row | undefined;
        if (!loader || loader.getAttribute('role') !== 'status' || !textOf(loader).includes(t.checking) || connectButton(m, t)) problems.push(`${tag}: while checking ${loader ? textOf(loader) : 'no loader'}`);
        answer(json({ refreshed: false }));
        await settle();
        if (all(m).some((e: Row) => String(e.getAttribute('class')).includes('ch-loader')) || !status()) problems.push(`${tag}: after the check the page did not come back`);
        // The poll: every 2 s while the window is open, then the line that says so
        if (b.intervals.size !== 1) problems.push(`${tag}: ${b.intervals.size} intervals`);
        const polled = checks().length;
        await b.tick();
        if (checks().length !== polled + 1) problems.push(`${tag}: the poll did not ask`);
        b.advance(3 * 60_000 + 1000);
        await b.tick();
        const late = status();
        if (!late || !textOf(late).includes(t.stillWaiting) || b.intervals.size !== 0) problems.push(`${tag}: after 3 minutes: ${late ? textOf(late) : 'no notice'}, intervals ${b.intervals.size}`);
        if (!buttonNamed(m, t.checkAgain)) problems.push(`${tag}: no Check again after the timeout`);
        // Continue again: a new wait, its own 3 minutes, and nothing yet about still waiting
        m.click(connectButton(m, t) as FakeElement);
        await settle();
        const again = status();
        if (b.opened.length !== 2 || !again || textOf(again).includes(t.stillWaiting) || b.intervals.size !== 1) problems.push(`${tag}: after Continue again: opened ${b.opened.length}, ${again ? textOf(again) : 'no notice'}, intervals ${b.intervals.size}`);
        m.unmount();
        leaveBrowser();
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('R4 once the token lands the page moves on by itself to /<locale>/select-calendars?user_id=… (the pending flag cleared), from the poll and from Check again', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const via of ['poll', 'checkAgain'] as const) {
        const t = messages[l].refreshToken;
        const { m, b } = await mountRefresh(l, { telegram: 'light' });
        m.click(connectButton(m, t) as FakeElement);
        await settle();
        b.answer['/api/check-token-refresh'] = [() => json({ refreshed: true })];
        if (via === 'poll') await b.tick();
        else {
          m.click(buttonNamed(m, t.checkAgain) as FakeElement);
          await settle();
        }
        if (fakeWindow.location.href !== `/${l}/select-calendars?user_id=${TAL_TG}` || b.storage.getItem('famcalbot_oauth_pending') !== null) problems.push(`${l} ${via}: at ${fakeWindow.location.href}, pending ${b.storage.getItem('famcalbot_oauth_pending')}`);
        m.unmount();
        leaveBrowser();
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('R5 Back goes to the calendar with a full page load (/<locale>/dashboard?user_id=…): Telegram\'s BackButton inside Telegram (no button of the page\'s own), the header\'s back in a browser (labelled in the page\'s language); never history.back()', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      const inTg = await mountRefresh(l, { telegram: 'light' });
      const handlers = inTg.b.tg?.backHandlers as Array<() => void>;
      if (!inTg.b.tgCalls.includes('BackButton.show()') || handlers?.length !== 1) problems.push(`${l} telegram: ${show(inTg.b.tgCalls)}`);
      if (buttonNamed(inTg.m, messages[l].ui.back)) problems.push(`${l} telegram: a back of the page's own`);
      act(() => handlers[0]());
      if (fakeWindow.location.href !== `/${l}/dashboard?user_id=${TAL_TG}`) problems.push(`${l} telegram: back went to ${fakeWindow.location.href}`);
      inTg.m.unmount();
      leaveBrowser();
      const inBrowser = await mountRefresh(l, { telegram: null });
      const back = buttonNamed(inBrowser.m, messages[l].ui.back);
      if (!back) problems.push(`${l} browser: no back in the header`);
      else {
        inBrowser.m.click(back as FakeElement);
        if (fakeWindow.location.href !== `/${l}/dashboard?user_id=${TAL_TG}`) problems.push(`${l} browser: back went to ${fakeWindow.location.href}`);
      }
      inBrowser.m.unmount();
      leaveBrowser();
    }
    const src = readSource(`${CONNECT}/refresh-token/RefreshTokenClient.tsx`);
    if (/history\.back|Go back/.test(src)) problems.push('the source still has history.back() or "Go back"');
    assert(problems.length === 0, problems.join('; '));
  });

  await check('R6 a first connect (Google state none) has the connect copy, a reconnect the reconnect copy, and a WhatsApp-only person in a browser gets "Finish in WhatsApp" after Continue', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      const t = messages[l].refreshToken;
      // Noa (WhatsApp only, never connected): the connect copy, the WhatsApp finish
      const { m } = await mountRefresh(l, { telegram: null, user: 42 });
      const h1 = all(m).find((e: Row) => e.localName === 'h1');
      if (!h1 || textOf(h1) !== t.connectTitle || !all(m).some((e: Row) => textOf(e) === t.connectSubtitle)) problems.push(`${l} Noa: ${h1 ? textOf(h1) : 'no h1'}`);
      const steps = all(m).filter((e: Row) => e.localName === 'li').map(textOf);
      if (steps[2] !== `3${t.connectStep3}`) problems.push(`${l} Noa: step 3 ${steps[2]}`);
      m.click(connectButton(m, t) as FakeElement);
      await settle();
      if (!all(m).some((e: Row) => e.getAttribute('role') === 'status' && textOf(e).includes(t.waitingWhatsApp))) problems.push(`${l} Noa: no WhatsApp waiting text`);
      m.unmount();
      leaveBrowser();
    }
    assert(problems.length === 0, problems.join('; '));
  });

  // ---- B: /oauth-callback and the redirect URI ----

  /** The callback's card: the document, its h1, its action link and the text a person reads. */
  const cardOf = (end: PageEnd) => {
    const doc = html(end);
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(doc)?.[1] ?? '';
    const action = /<a class="ch-btn ch-btn-primary[^"]*" href="([^"]*)">([^<]*)<\/a>/.exec(doc);
    return { doc, h1: visibleText(h1), href: action?.[1]?.replace(/&amp;/g, '&') ?? null, label: action ? visibleText(action[2]) : null, text: visibleText(doc), alert: /role="alert"/.test(doc) };
  };
  const BOT = 'https://t.me/famcal_test_bot?start=dashboard';
  const ACCEPT: Record<Locale, string> = { en: 'en-GB,en;q=0.9', he: 'he-IL,he;q=0.9,en;q=0.5', ru: 'ru-RU,ru;q=0.9,en;q=0.8' };

  await check('B1 a link that is used up or expired is one translated card ("This link has expired") with Back to FamCal: a missing or old-style state, a state that is not there, one a second callback used, an expired one, an owner who is gone; in the owner\'s language and with their way back when the state names them (Telegram: the bot; WhatsApp only: /refresh-token), else the browser\'s language and the bot', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      const expect = (tag: string, end: PageEnd, href: string, lang: Locale) => {
        const card = cardOf(end);
        const want = messages[lang].oauth;
        if (card.h1 !== want.expired.title || !card.text.includes(want.expired.body) || card.label !== want.backToFamcal || card.href !== href || !card.alert) problems.push(`${l} ${tag}: ${show({ h1: card.h1, href: card.href, label: card.label })}`);
        if (htmlTag(card.doc) !== `<html lang="${lang}" dir="${dirOf(lang)}">`) problems.push(`${l} ${tag}: ${htmlTag(card.doc)}`);
        if (lang !== 'en' && englishIn(card.text).length) problems.push(`${l} ${tag}: English ${show(englishIn(card.text))}`);
      };
      // Nobody known: the browser's language
      seed();
      acceptLanguage = ACCEPT[l];
      expect('no state', (await callbackPage({ code: 'c' })).value, BOT, l);
      expect('old state', (await callbackPage({ code: 'c', state: crypto.randomBytes(32).toString('hex') })).value, BOT, l);
      expect('unknown state', (await callbackPage({ code: 'c', state: `u1_${'0'.repeat(64)}` })).value, BOT, l);
      // The state names its owner: their language, their way back
      seed({ talLanguage: l, noaLanguage: l });
      acceptLanguage = ACCEPT[l === 'en' ? 'ru' : 'en'];
      const browserLang: Locale = acceptLanguage.startsWith('ru') ? 'ru' : 'en';
      const tal = addState(9);
      // Two callbacks at once: one parks, the other gets the card (in the owner's language when it read the row before
      // the winner used it up, else the browser's: which one is up to the timing)
      const { value: [a, b2] } = await quietly(() => Promise.all([runPage(`${CONNECT}/oauth-callback/page.tsx`, { code: 'c', state: tal }), runPage(`${CONNECT}/oauth-callback/page.tsx`, { code: 'c', state: tal })]));
      const lost = [a, b2].find((e) => e.element);
      if (!lost || [a, b2].filter((e) => e.redirect).length !== 1) problems.push(`${l} race: ${show([a, b2].map((e) => e.redirect ?? e.threw ?? 'page'))}`);
      else expect('the race', lost, BOT, htmlTag(html(lost)).includes(`lang="${l}"`) ? l : browserLang);
      // The row taken between the read and the delete (the race's other order): the owner is known
      const taken = addState(9);
      takenBetween = true;
      expect('used by the other callback', (await callbackPage({ code: 'c', state: taken })).value, BOT, l);
      if (takenBetween) problems.push(`${l}: the callback did not reach the delete`);
      expect('used', (await callbackPage({ code: 'c', state: tal })).value, BOT, browserLang);
      expect('expired (Telegram owner)', (await callbackPage({ code: 'c', state: addState(9, { expired: true }) })).value, BOT, l);
      expect('expired (WhatsApp only)', (await callbackPage({ code: 'c', state: addState(42, { expired: true }) })).value, '/refresh-token?user_id=42', l);
      const ghost = addState(77);
      expect('owner gone', (await callbackPage({ code: 'c', state: ghost })).value, BOT, browserLang);
      // Only the race's winner parked a token
      if (redisStore.size !== 1) problems.push(`${l}: ${redisStore.size} tokens parked (the race's winner only)`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('B2 a failure on our side (the code exchange throws, or parking the token fails) is the translated "Couldn\'t connect Google" card with the way back; the exception\'s text is logged and captured, never on the page', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const where of ['exchange', 'save'] as const) {
        seed({ talLanguage: l });
        if (where === 'exchange') googleThrows = new Error('secret-detail');
        const realSet = fakeRedis.set;
        if (where === 'save') fakeRedis.set = async () => { throw new Error('secret-detail'); };
        const { value: end, logs } = await callbackPage({ code: 'c', state: addState(9) });
        fakeRedis.set = realSet;
        const card = cardOf(end);
        const o = messages[l].oauth;
        if (card.h1 !== o.generic.title || !card.text.includes(o.generic.body) || card.href !== BOT || card.label !== o.backToFamcal) problems.push(`${l} ${where}: ${show({ h1: card.h1, href: card.href, label: card.label })}`);
        if (card.doc.includes('secret-detail') || /Error (?:exchanging|saving)|Unknown error/.test(card.doc)) problems.push(`${l} ${where}: the error's text is on the page`);
        if (!captured.some((c) => c.includes('secret-detail'))) problems.push(`${l} ${where}: not captured ${show(captured)}`);
        if (!logs.some((x) => x.startsWith('[oauth-callback]') && x.includes('secret-detail'))) problems.push(`${l} ${where}: not logged ${show(logs)}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('B3 Google refusing the code is the translated "couldn\'t finish" card with its way back, in the owner\'s language', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      seed({ talLanguage: l });
      googleAnswer = { error: 'invalid_grant', error_description: 'Bad Request' };
      const card = cardOf((await callbackPage({ code: 'c', state: addState(9) })).value);
      const o = messages[l].oauth.exchangeFailed;
      if (card.h1 !== o.title || !card.text.includes(o.message) || card.href !== BOT || card.label !== o.tryAgain) problems.push(`${l}: ${show({ h1: card.h1, href: card.href, label: card.label })}`);
      if (l !== 'en' && englishIn(card.text).length) problems.push(`${l}: English ${show(englishIn(card.text))}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('B4 missing permissions: the scopes page in the app\'s look (its title, the description with "both" in bold through t.rich, the two permissions as rows with what each is for, the footnote, Try again to the way back), in the owner\'s language; no HTML from a message', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      seed({ talLanguage: l });
      googleAnswer = { refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/calendar.readonly', access_token: 'a' };
      const card = cardOf((await callbackPage({ code: 'c', state: addState(9) })).value);
      const o = messages[l].oauth.insufficientScopes;
      const bold = /<b>([^<]*)<\/b>/.exec(card.doc)?.[1];
      const wantBold = /<b>([^<]*)<\/b>/.exec(o.description)?.[1];
      if (card.h1 !== o.title || !bold || bold !== wantBold || !card.text.includes(visibleText(o.description))) problems.push(`${l}: title ${card.h1}, bold ${bold}`);
      for (const key of ['checkAll', 'viewCalendar', 'viewCalendarDesc', 'editEvents', 'editEventsDesc', 'footnote']) if (!card.text.includes(o[key])) problems.push(`${l}: no ${key}`);
      if (!/class="ch-form-card"/.test(card.doc) || (card.doc.match(/class="ch-form-row"/g) ?? []).length !== 2) problems.push(`${l}: the permissions are not two rows of a card`);
      if (card.href !== BOT || card.label !== o.tryAgain) problems.push(`${l}: action ${card.label} ${card.href}`);
      if (l !== 'en' && englishIn(card.text).length) problems.push(`${l}: English ${show(englishIn(card.text))}`);
      if (redisStore.size) problems.push(`${l}: a token was parked`);
    }
    if (/dangerouslySetInnerHTML/.test(readSource(`${CONNECT}/oauth-callback/page.tsx`) + readSource(`${CONNECT}/oauth-callback/CallbackCard.tsx`))) problems.push('dangerouslySetInnerHTML is still there');
    assert(problems.length === 0, problems.join('; '));
  });

  await check('B5 no refresh token from Google: the translated "Connect again" card with Back to FamCal (never the English "One More Step" page)', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      seed({ talLanguage: l, noaLanguage: l });
      googleAnswer = { scope: BOTH_SCOPES, access_token: 'a' };
      for (const [owner, href] of [[9, BOT], [42, '/refresh-token?user_id=42']] as const) {
        const { value: end } = await callbackPage({ code: 'c', state: addState(owner) });
        const card = cardOf(end);
        const o = messages[l].oauth;
        if (card.h1 !== o.noRefreshToken.title || !card.text.includes(o.noRefreshToken.body) || card.href !== href || card.label !== o.backToFamcal || /One More Step|revoke/i.test(card.doc)) problems.push(`${l} owner ${owner}: ${show({ h1: card.h1, href: card.href })}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('B6 Google\'s deny: /api/refresh-token answers a return with no code with a redirect to the callback (Google\'s error, or missing_code, and the state), never JSON; the callback shows "Google wasn\'t connected" for access_denied and the expired card for anything else, in the owner\'s language when the state names them (and leaves the state alone), else the browser\'s', async () => {
    const problems: string[] = [];
    const { NextRequest } = nodeRequire('next/server');
    const { GET } = await load('app/api/refresh-token/route.ts');
    const { value: deny } = await quietly(async () => GET(new NextRequest('http://localhost:8080/api/refresh-token?error=access_denied&state=u1_abc')) as Promise<Response>);
    if (deny.status !== 307 || deny.headers.get('location') !== 'https://app.example.test/oauth-callback?error=access_denied&state=u1_abc') problems.push(`deny: ${deny.status} ${deny.headers.get('location')}`);
    const { value: none } = await quietly(async () => GET(new NextRequest('http://localhost:8080/api/refresh-token?state=u1_abc')) as Promise<Response>);
    if (none.status !== 307 || none.headers.get('location') !== 'https://app.example.test/oauth-callback?error=missing_code&state=u1_abc') problems.push(`no code: ${none.status} ${none.headers.get('location')}`);
    const { value: ok } = await quietly(async () => GET(new NextRequest('http://localhost:8080/api/refresh-token?code=4/0AbC&state=u1_abc')) as Promise<Response>);
    if (ok.headers.get('location') !== 'https://app.example.test/oauth-callback?code=4/0AbC&state=u1_abc') problems.push(`with a code: ${ok.headers.get('location')}`);
    for (const l of LOCALES) {
      const o = messages[l].oauth;
      seed({ talLanguage: l, noaLanguage: l });
      acceptLanguage = ACCEPT[l === 'en' ? 'he' : 'en'];
      const state = addState(42);
      const card = cardOf((await callbackPage({ error: 'access_denied', state })).value);
      if (card.h1 !== o.denied.title || !card.text.includes(o.denied.body) || card.label !== o.backToFamcal || card.href !== '/refresh-token?user_id=42' || htmlTag(card.doc) !== `<html lang="${l}" dir="${dirOf(l)}">`) problems.push(`${l} denied: ${show({ h1: card.h1, href: card.href, tag: htmlTag(card.doc) })}`);
      if (!DB.oAuthState.some((r) => r.token === state)) problems.push(`${l} denied: the state was used up`);
      if (googleCalls()) problems.push(`${l} denied: Google was asked`);
      const other = cardOf((await callbackPage({ error: 'missing_code', state })).value);
      if (other.h1 !== o.expired.title) problems.push(`${l} missing_code: ${other.h1}`);
      seed();
      acceptLanguage = ACCEPT[l];
      const stranger = cardOf((await callbackPage({ error: 'access_denied' })).value);
      if (stranger.h1 !== o.denied.title || stranger.href !== BOT || htmlTag(stranger.doc) !== `<html lang="${l}" dir="${dirOf(l)}">`) problems.push(`${l} denied, no state: ${show({ h1: stranger.h1, href: stranger.href })}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('B7 [guard] a consent that went through still parks the token and redirects to /oauth-complete?locale=… with the pendingId only in the fragment', async () => {
    seed({ talLanguage: 'he' });
    const { value: end } = await callbackPage({ code: 'c', state: addState(9) });
    assert(end.redirect?.startsWith('/oauth-complete?locale=he#p=') && redisStore.size === 1, `ended with ${show(end.redirect ?? end.threw ?? 'a page')}`);
  });

  // ---- F: /oauth-complete ----

  await check('F1 before the fragment is read (the server\'s render) the finish page is the app\'s loader, never an empty card', async () => {
    for (const l of LOCALES) {
      const doc = html(await completePage({ locale: l }));
      assert(/class="ch-loader[^"]*"[^>]*role="status"/.test(doc) && !/class="ch-home-card|<h1|<a /.test(doc), `${l}: ${visibleText(doc).slice(0, 200)}`);
      assert(doc.includes(asHtml(messages[l].pageGate.loading)), `${l}: the loader has no words for a screen reader`);
    }
  });

  const PENDING = 'A'.repeat(16) + '_-'.repeat(8);
  async function mountComplete(l: Locale, hash: string, look: { telegram?: 'light' | 'dark' | null; prefersDark?: boolean } = {}) {
    const end = await completePage({ locale: l });
    const client = pageClient(end.element as Row);
    freshBrowser({ telegram: look.telegram ?? null, prefersDark: look.prefersDark });
    fakeWindow.location = { href: `https://app.example.test/oauth-complete?locale=${l}${hash}`, hash };
    const m = mount(inProvider(l, ['oauthComplete'], h(client.type, client.props)));
    await settle();
    return m;
  }

  await check('F2 the ready page: a success icon, the title and subtitle, the owner line as a notice through ICU ({name}), Finish in Telegram as the primary button and Finish in WhatsApp as the outlined one with its hint under it; a WhatsApp-only owner\'s one button is the primary; light and dark; no English in he and ru', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const prefersDark of [false, true]) {
        const t = messages[l].oauthComplete;
        const name = l === 'he' ? 'טל' : l === 'ru' ? 'Таль' : 'Tal';
        const m = await mountComplete(l, `#p=${PENDING}&n=${encodeURIComponent(name)}&b=tg%2Cwa`, { prefersDark });
        const tag = `${l} ${prefersDark ? 'dark' : 'light'}`;
        const r = root(m);
        if (r?.getAttribute('data-theme') !== (prefersDark ? 'dark' : 'light') || r?.getAttribute('dir') !== dirOf(l)) problems.push(`${tag}: root`);
        const h1 = all(m).find((e: Row) => e.localName === 'h1');
        if (!h1 || textOf(h1) !== t.title || !all(m).some((e: Row) => textOf(e) === t.subtitle)) problems.push(`${tag}: ${h1 ? textOf(h1) : 'no h1'}`);
        if (!all(m).some((e: Row) => e.localName === 'svg' && String(e.getAttribute('class')).includes('lucide-circle-check'))) problems.push(`${tag}: no success icon`);
        const owner = all(m).find((e: Row) => String(e.getAttribute('class')).split(' ').includes('ch-notice')) as Row | undefined;
        const ownerText = t.owner.replace('{name}', name);
        if (!owner || textOf(owner) !== ownerText) problems.push(`${tag}: owner ${owner ? textOf(owner) : 'none'}`);
        const links = all(m).filter((e: Row) => e.localName === 'a') as Row[];
        const tg = links.find((a) => a.getAttribute('href') === `https://t.me/famcal_test_bot?start=gc_${PENDING}`);
        const wa = links.find((a) => String(a.getAttribute('href')).startsWith('https://wa.me/15550001111?text='));
        if (!tg || textOf(tg) !== t.telegramButton || !String(tg.getAttribute('class')).includes('ch-btn-primary')) problems.push(`${tag}: Telegram ${tg ? tg.getAttribute('class') : 'none'}`);
        if (!wa || textOf(wa) !== t.whatsappButton || !String(wa.getAttribute('class')).includes('ch-btn-outline')) problems.push(`${tag}: WhatsApp ${wa ? wa.getAttribute('class') : 'none'}`);
        const hintAt = all(m).findIndex((e: Row) => textOf(e) === t.whatsappHint && e.localName === 'p');
        if (hintAt < 0 || hintAt < all(m).indexOf(wa as FakeElement)) problems.push(`${tag}: the hint is not under WhatsApp`);
        if (l !== 'en') {
          const english = englishIn(visibleText(serialize(m.container)));
          if (english.length) problems.push(`${tag}: English ${show(english)}`);
        }
        m.unmount();
        leaveBrowser();
      }
      const t = messages[l].oauthComplete;
      const waOnly = await mountComplete(l, `#p=${PENDING}&b=wa`);
      const links = all(waOnly).filter((e: Row) => e.localName === 'a') as Row[];
      if (links.length !== 1 || !String(links[0].getAttribute('class')).includes('ch-btn-primary') || !all(waOnly).some((e: Row) => textOf(e) === t.ownerUnnamed)) problems.push(`${l} WhatsApp only: ${show(links.map((a) => a.getAttribute('class')))}`);
      waOnly.unmount();
      leaveBrowser();
    }
    const src = readSource(`${CONNECT}/oauth-complete/OAuthCompleteClient.tsx`);
    if (/\.replace\('\{name\}'/.test(src)) problems.push('the owner line is still filled in by hand');
    assert(problems.length === 0, problems.join('; '));
  });

  await check('F3 a link missing its fragment (or with a bad one) is the translated "incomplete" card', async () => {
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const hash of ['', '#', '#p=short&b=tg', `#p=${PENDING}&b=`]) {
        const t = messages[l].oauthComplete;
        const m = await mountComplete(l, hash);
        const h1 = all(m).find((e: Row) => e.localName === 'h1');
        if (!h1 || textOf(h1) !== t.incompleteTitle || !all(m).some((e: Row) => textOf(e) === t.incompleteBody) || all(m).some((e: Row) => e.localName === 'a')) problems.push(`${l} ${show(hash)}: ${h1 ? textOf(h1) : 'no h1'}`);
        m.unmount();
        leaveBrowser();
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('F4 [guard] the finish page\'s exports keep their shapes: parseFinishFragment, finishLinks (gc_<id> in both links), FinishButtons', async () => {
    const mod = await load(`${CONNECT}/oauth-complete/OAuthCompleteClient.tsx`);
    const parsed = mod.parseFinishFragment(`#p=${PENDING}&n=Tal&b=tg%2Cwa`);
    const links = mod.finishLinks(parsed, 'bot', '1', messages.en.oauthComplete.whatsappText);
    assert(links.telegram === `https://t.me/bot?start=gc_${PENDING}` && String(links.whatsapp).includes(`gc_${PENDING}`), show(links));
    assert(typeof mod.FinishButtons === 'function', 'no FinishButtons');
  });

  // ---- K: the pages' own style sheet and sources ----

  await check('K1 the connect pages\' style sheet passes the kit\'s lint (sizes, 44 px, logical properties, no hover, no colour literals) and names only ch-connect-* classes; the sources hold no old look (styled-jsx, gradients, hex colours, inline styles) and no English left inline', async () => {
    const { CONNECT_CSS } = await load(`${CONNECT}/connect-css.ts`);
    const problems = lintCss(CONNECT_CSS);
    // The subject of each rule (its first class) is the pages' own
    const own = [...String(CONNECT_CSS).matchAll(/^\.(ch-[\w-]+)/gm)].map((m) => m[1]);
    if (!own.length || own.some((c) => !c.startsWith('ch-connect-'))) problems.push(`classes ${show(own)}`);
    for (const file of CONNECT_FILES()) {
      const src = readSource(file);
      if (/style jsx|linear-gradient|#[0-9a-f]{3,8}\b|style=\{\{/i.test(src.replace(/\/\/.*$/gm, ''))) problems.push(`${file}: an old look`);
      if (/>\s*(?:Try Again|Error|One More Step|Go back)\s*</.test(src) || /aria-label="[A-Za-z]/.test(src)) problems.push(`${file}: inline English`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
