// Smoke test for the Google connect pages in the app's design (plan docs/superpowers/plans/2026-10-29-w4-3-google-connect.md;
// spec 2026-10-19-screens-and-colours §4, §5; the connect flow is spec 2026-10-19-google-connection, unchanged here):
// /refresh-token, /oauth-callback and /oauth-complete.
//
//  - D1..D4 the shell: the three pages sit in the (connect) route group, whose one root layout loads the global CSS (the
//    kit's colours outside Telegram) and leaves the document to ConnectShell; each page's <html> has its language and
//    direction (en, he, ru); the Telegram SDK loads before hydration on /refresh-token only.
//
// The pages run as Next runs them (the server page as a function, then react-dom/server), with Prisma, Redis, error
// capture, the request's headers and Google's token endpoint faked. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-connect-screens.ts

import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { renderToString } from 'react-dom/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const CONNECT = 'app/(connect)';

process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';
process.env.WHATSAPP_PHONE_NUMBER = '15550001111';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ENCRYPTION_KEY_PREVIOUS = '';

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
    if (googleThrows) throw googleThrows;
    return new Response(JSON.stringify(googleAnswer), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`network blocked in smoke: ${url}`);
}) as typeof fetch;

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
    user({ id: 9, name: 'Tal Cohen', telegramId: BigInt(TAL_TG), language: o.talLanguage ?? 'en', googleRefreshToken: 'enc', calendarSource: 'GOOGLE' }),
    user({ id: 42, name: 'Noa', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.123', language: o.noaLanguage ?? 'he' }),
  ];
  DB.oAuthState = [];
  redisStore.clear();
  captured.length = 0;
  acceptLanguage = 'en-US,en;q=0.9';
  googleAnswer = { refresh_token: 'google-rt-new', scope: BOTH_SCOPES, access_token: 'test' };
  googleThrows = null;
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
