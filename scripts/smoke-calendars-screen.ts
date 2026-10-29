// Smoke test for the Calendars screen in the app's design (plan docs/superpowers/plans/2026-10-29-w4-1-calendars.md;
// spec 2026-10-19-screens-and-colours §4, §5): CalendarsClient on AppScreen and the form kit, in real React on the small
// fake DOM, with a fake Telegram.WebApp, a router stub and a fake fetch. No network, no DB.
//
//  - C1 the page data: where the person is with Google (all four states, the chosen count) and the partner's name;
//  - C2 the kit's colour swatches and the swatch dot's CSS;
//  - C3 the screen's words in en, he and ru;
//  - S1..S17 the screen itself (light and dark, en / he (RTL) / ru): its source is made of the kit; the list's rows (dot,
//    privacy line, category tags); the partner's section; the Google row for each state; the Copy to Google section; the edit
//    sheet (the saved values, the exact PATCH, the refusals 404 / 429 / 401 / 403 / 500 / no network keep it open with the typed
//    values); the colours named in the page's language; delete (the confirm step, Remove / Keep when the copy is on, the only
//    calendar); window.confirm never called; create (the limit, See plans); the copy's turn-off question; Back; one request at
//    a time; no word of the old inline copy in he and ru; React logs no warning.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-calendars-screen.ts

import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { lintCss } from './lib/css-lint';
import { CALENDAR_PALETTE, displayColours } from '../src/lib/calendar-colours';
import { ColorSwatches, FORM_CSS } from '../components/app-ui/form-kit';
import { byRole, elements, fakeTelegram, fakeWindow, FakeElement, FakeText, installWindow, mount, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const nodeRequire = createRequire(__filename);

type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message || String(((err as unknown as { errors?: Error[] }).errors?.[0] ?? err).stack).split('\n').slice(0, 5).join(' | ') : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (value: unknown) => JSON.stringify(value);

// ---- React must not warn; what the screen itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[calendars]') || text.startsWith('[google-copy]')) return void appLogs.push(text);
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The server side of the page: page-data.ts over a world of three calls, everything else real ----

interface World {
  calendars: Row[];
  partner: { partner: { name: string } } | null;
}
const world: World = { calendars: [], partner: null };

const untouchable = (what: string): object =>
  new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' ? undefined : untouchable(`${what}.${String(key)}`)),
    apply: () => {
      throw new Error(`the page data reached ${what}, which this smoke does not fake`);
    },
  });
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/utils/prisma.ts`]: { prisma: untouchable('prisma'), withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/utils/redis.ts`]: { redis: untouchable('redis') },
  [`${SRC}/services/native-calendar/event-store.ts`]: (real) => fakeOver(real, { listVisibleCalendars: async () => world.calendars }),
  [`${SRC}/services/native-calendar/onboarding.ts`]: (real) => fakeOver(real, { ensurePrimaryNativeCalendar: async () => undefined }),
  [`${SRC}/services/native-calendar/colour.ts`]: (real) => fakeOver(real, { googleColoursOnScreen: async () => [] }),
  [`${SRC}/services/pairing-service.ts`]: (real) => fakeOver(real, { getActivePartner: async () => world.partner }),
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};
const built = new Map<string, object>();
const loadingReal = new Set<string>();
function fakeFor(file: string, loadReal: () => unknown): object {
  const stub = stubs[file];
  if (typeof stub !== 'function') return stub;
  if (!built.has(file)) {
    loadingReal.add(file);
    try {
      built.set(file, stub(loadReal() as Record<string, unknown>));
    } finally {
      loadingReal.delete(file);
    }
  }
  return built.get(file)!;
}
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  if (!(resolved in stubs) || loadingReal.has(resolved)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(resolved, () => realLoad.call(this, request, parent, isMain));
};
// import() goes through the ES module loader: the same fakes, served as ES modules.
(globalThis as { calendarsScreenFake?: (file: string) => object }).calendarsScreenFake = (file) => fakeFor(file, () => realLoad.call(Module, file, null, false));
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { calendarsScreenFake: (file: string) => object }).calendarsScreenFake(file);
    const names = Object.keys(fake).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.calendarsScreenFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Fixtures ----

const ownCalendar = (id: string, name: string, o: Row = {}): Row => ({
  id, name, color: '#039be5', privacy: 'PRIVATE', ownerUserId: 1, labels: ['yours'], rules: [], personName: null, personEnglishName: null, personGender: null, createdAt: new Date('2026-01-01T00:00:00Z'), ...o,
});
const userRow = (o: Row = {}): Row => ({ id: 1, name: 'Noa', language: 'en', pairingId: null, googleRefreshToken: null, calendarSource: 'NATIVE', calendarAssignments: null, ...o });
const picks = (n: number) => Array.from({ length: n }, (_, i) => ({ calendarId: `g${i}@example.com`, labels: ['yours'] }));

// ---- The browser side: a router, a fetch, window.confirm that throws, and Telegram ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
const assigned: string[] = [];
const router = { push: (href: string) => void pushes.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };

let confirmCalls = 0;
const noConfirm = () => {
  confirmCalls++;
  throw new Error('window.confirm was called');
};
(globalThis as Row).confirm = noConfirm;
fakeWindow.confirm = noConfirm;

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Row | null;
  /** The calendar id of /api/native-calendars/<id>. */
  id: string | null;
}
const calls: Call[] = [];
type Reply = Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ISO = '2026-01-01T00:00:00.000Z';
const cal = (rawId: string, name: string, o: Row = {}): Row => ({
  rawId, name, color: '#039BE5', labels: ['yours'], privacy: 'PRIVATE', ownerUserId: 5, isOwner: true,
  personName: null, personEnglishName: null, personGender: null, rules: [], createdAt: ISO, ...o,
});
const NAMES: Record<Locale, { home: string; work: string; noa: string; partner: string }> = {
  en: { home: 'Home', work: 'Work', noa: 'Noa family', partner: 'Noa' },
  he: { home: 'בית', work: 'עבודה', noa: 'המשפחה של נועה', partner: 'נועה' },
  ru: { home: 'Дом', work: 'Работа', noa: 'Семья Ноа', partner: 'Ноа' },
};
const calendarsFor = (locale: Locale): Row[] => [
  cal('own', NAMES[locale].home, { labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR', color: '#039BE5' }),
  cal('plain', NAMES[locale].work, { labels: ['kids', 'birthdays'], privacy: 'SHARED_VIEWER', color: '#F4511E' }),
  cal('noa-cal', NAMES[locale].noa, { isOwner: false, ownerUserId: 6, labels: [], privacy: 'SHARED_EDITOR', color: '#0b8043' }),
];
const copyRow = (calendarId: string, o: Row = {}) => ({ calendarId, linkId: `link-${calendarId}`, on: true, status: 'copied', copied: 0, total: 0, unsupported: 0, consentOpen: false, ...o });
const VIEW = { shown: true, ownerName: 'Noa', rows: [copyRow('own'), copyRow('plain', { on: false, status: 'off', linkId: null })] };

const srv = {
  list: [] as Row[],
  copies: (): Reply => json(VIEW),
  copyWrite: (_c: Call): Reply => json({ status: 'off' }),
  create: (_c: Call): Reply => json({}),
  patch: (_c: Call): Reply => json({}),
  del: (_c: Call): Reply => json({}),
  listGet: (): Reply => json({ calendars: srv.list }),
};
let created = 0;
function resetWorld(locale: Locale = 'en') {
  calls.length = 0;
  pushes.length = 0;
  assigned.length = 0;
  appLogs.length = 0;
  confirmCalls = 0;
  created = 0;
  srv.list = calendarsFor(locale).map((c) => ({ ...c }));
  srv.copies = () => json(VIEW);
  srv.copyWrite = () => json({ status: 'off' });
  srv.listGet = () => json({ calendars: srv.list });
  // The server as it is: a PATCH changes the row, a DELETE removes it, a POST adds one
  srv.patch = (c) => {
    const row = srv.list.find((x) => x.rawId === c.id);
    if (!row) return json({ error: 'not_found' }, 404);
    for (const key of ['name', 'color', 'labels', 'privacy']) if (c.body && key in c.body) row[key] = c.body[key];
    return json({ success: true, calendar: row });
  };
  srv.del = (c) => {
    srv.list = srv.list.filter((x) => x.rawId !== c.id);
    return json({ success: true });
  };
  srv.create = (c) => {
    const row = cal(`new-${++created}`, String(c.body?.name), { color: '#ad1457', labels: [] });
    srv.list.push(row);
    return json({ success: true, calendar: { id: `native:${row.rawId}`, rawId: row.rawId, name: row.name, color: row.color, labels: [], privacy: 'PRIVATE' } });
  };
}
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = new URL(String(input), 'https://famcal.test');
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Row) : null;
  const id = /^\/api\/native-calendars\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
  const call: Call = { method, path: url.pathname, query: url.searchParams, headers: Object.fromEntries(new Headers(init.headers).entries()), body, id };
  calls.push(call);
  if (url.pathname === '/api/google-sync') return method === 'GET' ? srv.copies() : srv.copyWrite(call);
  if (url.pathname === '/api/native-calendars' && method === 'GET') return srv.listGet();
  if (url.pathname === '/api/native-calendars' && method === 'POST') return srv.create(call);
  if (id && method === 'PATCH') return srv.patch(call);
  if (id && method === 'DELETE') return srv.del(call);
  throw new Error(`an unexpected request: ${method} ${url.pathname}`);
}) as typeof fetch;
const callsTo = (method: string, test: string | RegExp) => calls.filter((c) => c.method === method && (typeof test === 'string' ? c.path === test : test.test(c.path)));
const patches = () => callsTo('PATCH', /^\/api\/native-calendars\/[^/]+$/);
const deletes = () => callsTo('DELETE', /^\/api\/native-calendars\/[^/]+$/);
const posts = () => callsTo('POST', '/api/native-calendars');
const listGets = () => callsTo('GET', '/api/native-calendars');
const copyGets = () => callsTo('GET', '/api/google-sync');

// ---- Mounting the screen ----

type Props = Row;
let Calendars: (props: Props) => ReactElement;
const propsOf = (locale: Locale, o: Props = {}): Props => ({
  userId: 5, locale, initialCalendars: calendarsFor(locale), googleColors: [], google: { state: 'connected', chosen: 2 }, partnerName: NAMES[locale].partner, ...o,
});
function tree(locale: Locale, props: Props): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Calendars, props));
  return createElement(AppRouterContext.Provider, { value: router }, intl);
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** Mount in a browser (no Telegram), or in Telegram `version` with a scheme; the caller closes it. */
async function open(locale: Locale, o: Props = {}, telegram?: { version: string; scheme?: 'light' | 'dark' }) {
  installWindow();
  const tgCalls: string[] = [];
  const tg = telegram ? fakeTelegram(tgCalls, telegram.version) : null;
  if (tg && telegram?.scheme) tg.colorScheme = telegram.scheme;
  fakeWindow.Telegram = tg ? { WebApp: tg } : undefined;
  fakeWindow.location = { hash: '', assign: (u: string) => void assigned.push(u), reload: () => undefined };
  const m = mount(tree(locale, propsOf(locale, o)));
  await settle();
  return { m, tg, tgCalls, locale };
}
type Opened = Awaited<ReturnType<typeof open>>;
const close = (o: Opened) => {
  o.m.unmount();
  fakeWindow.Telegram = undefined;
};
const back = (o: Opened) => act(() => void (o.tg as Row).backHandlers[0]());

// ---- Reading what is on the page ----

const messageAt = (locale: Locale, key: string): string => {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${key} in ${locale}`);
  return value;
};
/** What a language's message says, its {arguments} filled in (not plurals: those are written out by the check). */
const word = (locale: Locale, key: string, args: Row = {}, ns = 'calendarsPage'): string =>
  Object.entries(args).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), messageAt(locale, `${ns}.${key}`));
const BIDI = /[⁦-⁩]/g;
/** What a reader sees: a space between two elements side by side (rows, spans of a label), none around text or <bdi>. */
const INLINE = new Set(['bdi', 'b', 'i', 'em', 'strong']);
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  let out = '';
  let previousInline = true;
  for (const child of node.childNodes) {
    const inline = child instanceof FakeText || (child instanceof FakeElement && INLINE.has(child.localName));
    const text = visible(child);
    if (out && text && (!inline || !previousInline)) out += ' ';
    out += text;
    previousInline = inline;
  }
  return out;
}
const isInside = (node: FakeNode, root: FakeNode | undefined) => {
  for (let n: FakeNode | null = node; n; n = n.parentNode) if (n === root) return true;
  return false;
};
const flat = (node: FakeNode) => visible(node).replace(BIDI, '').replace(/\s+/g, ' ').trim();
const page = (m: Mounted) => flat(m.container);
/** A dialog's accessible name, without the direction isolates a name is wrapped in. */
const labelOf = (sheet: FakeElement | undefined) => (sheet?.getAttribute('aria-label') ?? '').replace(BIDI, '');
const classes = (e: FakeElement) => e.className.split(' ');
const buttonsOf = (node: FakeNode) => elements(node).filter((e) => e.localName === 'button');
const dialogs = (m: Mounted) => byRole(m.container, 'dialog');
const sheetOf = (m: Mounted) => dialogs(m)[0] as FakeElement | undefined;
const alertsIn = (node: FakeNode) => byRole(node, 'alert').map(flat);
/** The own calendars' rows (a list row is a button of the ch-list-row class). */
const listRows = (m: Mounted) => buttonsOf(m.container).filter((b) => classes(b).includes('ch-list-row'));
const rowOf = (m: Mounted, name: string) => {
  const row = listRows(m).find((b) => flat(b).startsWith(name));
  assert(row, `no list row for ${name} in ${show(listRows(m).map(flat))}`);
  return row;
};
const dotColour = (node: FakeNode) => {
  const dot = elements(node).find((e) => classes(e).includes('ch-swatch-dot'));
  assert(dot, 'no .ch-swatch-dot');
  return String(dot.style.background);
};
const tagsOf = (row: FakeNode) => elements(row).filter((e) => classes(e).includes('ch-tag')).map((e) => ({ text: flat(e), tone: classes(e).includes('ch-tag-muted') ? 'muted' : classes(e).includes('ch-tag-danger') ? 'danger' : 'accent' }));
const sectionLabels = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'h2' && classes(e).includes('ch-section-label')).map(flat);
const buttonNamed = (node: FakeNode, text: string) => buttonsOf(node).find((b) => flat(b) === text);
const mustButton = (node: FakeNode, text: string) => {
  const b = buttonNamed(node, text);
  assert(b, `no button ${show(text)} in ${show(buttonsOf(node).map(flat))}`);
  return b;
};
/** The sheet's name field, switches, swatches and the like. */
const nameField = (m: Mounted) => elements(sheetOf(m) as FakeNode).find((e) => e.localName === 'input') as FakeElement;
const groupOf = (m: Mounted, label: string) => {
  const g = byRole(sheetOf(m) as FakeNode, 'radiogroup').find((e) => e.getAttribute('aria-label') === label);
  assert(g, `no radio group ${show(label)}`);
  return g;
};
const radiosOf = (group: FakeNode) => byRole(group, 'radio');
const checkedOf = (group: FakeNode) => radiosOf(group).filter((r) => r.getAttribute('aria-checked') === 'true');
const switchesOf = (node: FakeNode) => byRole(node, 'switch');
const saveButton = (m: Mounted) => buttonsOf(sheetOf(m) as FakeNode).find((b) => classes(b).includes('ch-save') && !classes(b).includes('ch-btn-danger')) as FakeElement;
const dangerButtons = (m: Mounted) => buttonsOf(sheetOf(m) as FakeNode).filter((b) => classes(b).includes('ch-btn-danger'));
const cancelButton = (m: Mounted) => buttonsOf(sheetOf(m) as FakeNode).find((b) => classes(b).includes('ch-sheet-close')) as FakeElement;
const ui = (locale: Locale, key: string) => messageAt(locale, `ui.${key}`);
const tc = (locale: Locale, key: string, args: Row = {}) => word(locale, key, args, 'googleCopy');
const cat = (locale: Locale, key: string) => word(locale, key, {}, 'calendars.categories');

async function main() {
  const { loadPageData } = await import('../src/lib/page-data');

  await check('C1 the page data says where the person is with Google (none, choose, connected, reconnect; how many calendars are chosen, a FamCal user\'s stale choices counting as none) and names the active partner, or null when not paired', async () => {
    world.calendars = [ownCalendar('own1', 'Home')];
    const dataFor = async (user: Row, partner: World['partner'] = null) => {
      world.partner = partner;
      const page = await loadPageData('calendars', user as never, 5550001, 'en');
      assert(page.kind === 'props', `the page: ${show(page)}`);
      return page.props as unknown as { google: { state: string; chosen: number }; partnerName: string | null; initialCalendars: Row[] };
    };
    const cases: [string, Row, { state: string; chosen: number }][] = [
      ['none', userRow(), { state: 'none', chosen: 0 }],
      ['none with stale choices and no token (a FamCal user)', userRow({ calendarAssignments: picks(2) }), { state: 'none', chosen: 0 }],
      ['choose', userRow({ googleRefreshToken: 'tok' }), { state: 'choose', chosen: 0 }],
      ['connected', userRow({ googleRefreshToken: 'tok', calendarAssignments: picks(3) }), { state: 'connected', chosen: 3 }],
      ['reconnect', userRow({ calendarSource: 'GOOGLE', calendarAssignments: picks(2) }), { state: 'reconnect', chosen: 2 }],
    ];
    for (const [name, user, want] of cases) {
      const data = await dataFor(user);
      assert(show(data.google) === show(want), `${name}: ${show(data.google)} (want ${show(want)})`);
      assert(data.partnerName === null, `${name}: a partner name ${show(data.partnerName)} with no partner`);
      assert(data.initialCalendars.length === 1, `${name}: the calendars`);
    }
    const paired = await dataFor(userRow({ pairingId: 'pair1' }), { partner: { name: 'Dana' } });
    assert(paired.partnerName === 'Dana', `the partner: ${show(paired.partnerName)}`);
    // The Google facts never carry the token or the chosen calendars themselves
    assert(!JSON.stringify(paired).includes('tok') && Object.keys(paired.google).sort().join() === 'chosen,state', `the Google facts: ${show(paired.google)}`);
  });

  await check('C2 the kit\'s colour swatches: a radiogroup of radio buttons labelled with the given texts, the chosen one aria-checked, each at least 44 px with a 28 px dot in its colour; tapping one reports its value; FORM_CSS draws .ch-swatch-dot (it moved from the editor\'s sheet) and passes the CSS lint', () => {
    const options = [
      { value: '#039be5', color: '#039be5', text: 'Blue' },
      { value: '#f4511e', color: '#f4511e', text: 'Orange' },
      { value: '#0b8043', color: '#0b8043', text: 'Green' },
    ];
    const tree = (locale: Locale, chosen: string, onChange: (v: string) => void = () => undefined) =>
      createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(ColorSwatches, { label: 'Color', value: chosen, options, onChange, disabled: false }));
    const html = renderToString(tree('en', '#f4511e'));
    assert(/<div[^>]*role="radiogroup"[^>]*aria-label="Color"/.test(html), `the group: ${html.slice(0, 200)}`);
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert(buttons.length === 3 && buttons.every((b) => /role="radio"/.test(b)), `the swatches: ${show(buttons)}`);
    assert(show(buttons.map((b) => /aria-label="([^"]*)"/.exec(b)?.[1])) === show(['Blue', 'Orange', 'Green']), `the labels: ${show(buttons)}`);
    assert(show(buttons.map((b) => /aria-checked="(true|false)"/.exec(b)?.[1])) === show(['false', 'true', 'false']), `the chosen one: ${show(buttons)}`);
    assert(html.includes('background:#039be5') && html.includes('background:#f4511e') && !/\p{Extended_Pictographic}/u.test(html), 'the dots are drawn in their colours');
    assert((html.match(/<svg\b/g) ?? []).length === 1 && /<svg[^>]*aria-hidden="true"/.test(html), 'one check mark, on the chosen swatch, hidden from screen readers');
    installWindow();
    const taken: string[] = [];
    const m = mount(tree('he', '#039be5', (v) => taken.push(v)));
    const radios = elements(m.container).filter((e) => e.getAttribute('role') === 'radio');
    m.click(radios[2]);
    m.unmount();
    assert(show(taken) === show(['#0b8043']), `a tap reports ${show(taken)}`);
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(FORM_CSS)?.[1] ?? '';
    assert(/inline-size:\s*44px/.test(rule('.ch-swatch')) && /block-size:\s*44px/.test(rule('.ch-swatch')), `.ch-swatch: ${rule('.ch-swatch')}`);
    assert(/inline-size:\s*28px/.test(rule('.ch-swatch-color')) && /block-size:\s*28px/.test(rule('.ch-swatch-color')), `.ch-swatch-color: ${rule('.ch-swatch-color')}`);
    assert(/flex-wrap:\s*wrap/.test(rule('.ch-swatches')), `.ch-swatches: ${rule('.ch-swatches')}`);
    assert(rule('.ch-swatch-dot') !== '', 'FORM_CSS does not draw .ch-swatch-dot');
    const problems = lintCss(FORM_CSS);
    assert(problems.length === 0, `FORM_CSS: ${show(problems)}`);
  });

  await check('C3 the screen\'s words: calendarsPage has the same keys in en, he and ru; every palette colour has a name in each language (and colors.unknown a fallback); {name} and {count} are kept where the English has them; he and ru are their own text, with no Latin letter but the product names; no emoji', () => {
    const leaves = (node: unknown, prefix = ''): [string, string][] =>
      typeof node === 'string' ? [[prefix, node]] : node && typeof node === 'object' ? Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k)) : [];
    const page = (l: Locale) => new Map(leaves(messages[l].calendarsPage));
    const keys = (l: Locale) => [...page(l).keys()].sort();
    for (const l of ['he', 'ru'] as Locale[]) assert(show(keys(l)) === show(keys('en')), `${l}: the keys differ from en: ${show(keys(l).filter((k) => !keys('en').includes(k)))} / ${show(keys('en').filter((k) => !keys(l).includes(k)))}`);
    for (const need of ['title', 'yours', 'sharedBy', 'sharedByPartner', 'newCalendar', 'name', 'namePlaceholder', 'create', 'color', 'categories', 'privacy', 'privacyPrivate', 'privacyViewer', 'privacyEditor', 'delete', 'deleteTitle', 'deleteBody', 'onlyOne', 'seePlans', 'google', 'googleHint', 'googleChosen', 'googleChosenCount', 'googleChoose', 'googleConnect', 'googleReconnect', 'sharedAccess.view', 'sharedAccess.edit', 'colors.unknown']) assert(page('en').has(need), `en: no ${need}`);
    for (const k of ['primary', 'yours', 'spouse', 'kids', 'birthdays']) assert(page('en').has(`categoryHint.${k}`), `no categoryHint.${k}`);
    for (const k of ['save', 'create', 'delete', 'notFound', 'tooMany', 'reopen', 'limit']) assert(page('en').has(`errors.${k}`), `no errors.${k}`);
    for (const colour of CALENDAR_PALETTE) assert(page('en').has(`colors.${colour.name.toLowerCase()}`), `no name for the palette colour ${colour.name}`);
    for (const l of LOCALES) {
      for (const [key, text] of page(l)) {
        const english = page('en').get(key) as string;
        for (const arg of ['name', 'count']) assert(english.includes(`{${arg}`) === text.includes(`{${arg}`), `${l} ${key}: {${arg}} differs from en`);
        assert(!/\p{Extended_Pictographic}/u.test(text), `${l} ${key}: an emoji`);
        if (l !== 'en') {
          assert(text !== english || /^(?:Google|\{count)/.test(english), `${l} ${key}: the English text`);
          assert(!/[A-Za-z]/.test(text.replace(/\{[^}]*\}/g, '').replace(/\b(?:plural|one|two|few|many|other)\b/g, '').replace(/Google/g, '')), `${l} ${key}: Latin letters in ${text}`);
        }
      }
    }
    assert(messages.he.calendars.categories.spouse === 'בן או בת זוג', `the Hebrew spouse chip: ${messages.he.calendars.categories.spouse}`);
  });

  Calendars = (await import('../app/[locale]/calendars/CalendarsClient')).default as unknown as (props: Props) => ReactElement;
  const noComments = (code: string) => code.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
  const source = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const PAGE_FILES = ['app/[locale]/calendars/CalendarsClient.tsx', 'app/[locale]/calendars/GoogleCopyRow.tsx'];
  const TELEGRAM = { version: '7.7' };
  const initDataOf = (o: Opened) => (o.tg as Row).initData as string;
  const swatchLabels = (locale: Locale) => CALENDAR_PALETTE.map((c) => messageAt(locale, `calendarsPage.colors.${c.name.toLowerCase()}`));
  const privacyTexts = (locale: Locale) => ['privacyPrivate', 'privacyViewer', 'privacyEditor'].map((k) => word(locale, k));
  /** Opens the edit sheet of a calendar by its row. */
  const openRow = async (o: Opened, name: string) => {
    o.m.click(rowOf(o.m, name));
    await settle();
    assert(sheetOf(o.m), `no sheet after tapping ${name}`);
  };
  const countText = (locale: Locale, chosen: number) => {
    const one = { en: '1 chosen', he: 'אחד נבחר', ru: 'выбран 1' }[locale];
    const other = { en: `${chosen} chosen`, he: `${chosen} נבחרו`, ru: `выбрано ${chosen}` }[locale];
    return chosen === 1 ? one : chosen === 2 && locale === 'he' ? 'שניים נבחרו' : other;
  };
  /** The Copy to Google switches of the page: the sheet's category switches are not among them. */
  const pageSwitches = (m: Mounted) => switchesOf(m.container).filter((s) => !isInside(s, sheetOf(m)));
  const holdNext = <K extends 'patch' | 'del' | 'create' | 'copyWrite'>(key: K) => {
    let release: (r: Response) => void = () => undefined;
    (srv as Row)[key] = () => new Promise<Response>((resolve) => void (release = resolve));
    return (r: Response) => act(async () => { release(r); await new Promise((res) => setTimeout(res, 0)); });
  };

  await check('S1 the screen is made of the kit: no inline COPY, no Tailwind class, no emoji, no hover style, no window.confirm and no direct useTelegramBackButton in CalendarsClient.tsx or GoogleCopyRow.tsx; no style sheet of their own (only the form kit\'s); getInitData is readInitData; the grouped AppScreen owns Back', () => {
    for (const file of PAGE_FILES) {
      const raw = source(file);
      const code = noComments(raw);
      assert(!/\bCOPY\b/.test(code), `${file}: an inline COPY`);
      assert(!/(?:^|[\s"'`])(?:bg-(?:white|gray|blue|rose|indigo)|text-(?:gray|rose|blue|indigo|white|xs|sm|lg|xl|2xl|3xl)\b|rounded(?:-[a-z0-9]+)?\b|px-\d|py-\d|min-h-|min-w-|flex-1|shadow\b|mt-\d|mb-\d|p-\d|gap-\d|max-w|space-[xy]-|animate-|border-(?:gray|rose|blue|t|b)\b|hover:)/.test(code.replace(/aria-[a-z]+="[^"]*"/g, '')), `${file}: a Tailwind class`);
      assert(!/\p{Extended_Pictographic}/u.test(raw), `${file}: an emoji`);
      assert(!/:hover/.test(code), `${file}: a :hover style`);
      assert(!/(?<![\w.])(?:window\.)?confirm\(/.test(code), `${file}: confirm()`);
      assert(!/useTelegramBackButton\(/.test(code), `${file}: useTelegramBackButton`);
      assert(!/[א-ת]|[а-яА-Я]/.test(raw.replace(/\/\/.*$/gm, '')), `${file}: inline Hebrew or Russian`);
      const styles = code.match(/<style[^>]*>/g) ?? [];
      assert(styles.every((s) => s === '<style>') && !/<style>\{(?!FORM_CSS\})/.test(code), `${file}: a style sheet of its own`);
    }
    const screen = noComments(source(PAGE_FILES[0]));
    assert(/function getInitData\(\)[^{]*\{\s*return readInitData\(\);\s*\}/.test(screen), 'getInitData is readInitData');
    assert(/<AppScreen ground="grouped" onBack=\{back\}>/.test(screen) && /<style>\{FORM_CSS\}<\/style>/.test(screen), 'the grouped AppScreen and the form kit\'s style sheet');
    assert(/<ScreenHeader title=\{t\('title'\)\} backLabel=\{ui\('back'\)\} onBack=\{back\} \/>/.test(screen), 'the header with the same back');
  });

  await check('S2 the list in en, he (RTL) and ru, light (the server) and dark (Telegram): the grouped AppScreen root, the title, one row per own calendar with a dot in the colour it is drawn in (Google colours keep it apart), the privacy line, category tags (never "yours"; primary in the accent, the rest muted); a "New calendar" row; no raw key, no emoji, no 12-hour time, and in he and ru no Latin letter but the product names', async () => {
    for (const locale of LOCALES) {
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const solo = cal('solo', 'Solo', { privacy: 'PRIVATE', labels: ['yours', 'spouse'], color: '#8E24AA' });
      const calendars = [...calendarsFor(locale), solo];
      // A Google calendar in nearly Home's blue: Home is drawn apart from it
      const googleColors = ['#039be5'];
      const drawn = displayColours([...calendars.map((c) => ({ id: String(c.rawId), color: String(c.color), native: true })), ...googleColors.map((color, i) => ({ id: `google:${i}`, color, native: false }))]);
      assert(drawn.get('own') !== '#039BE5'.toLowerCase(), 'the fixture does not push Home away from the Google blue');
      const props = propsOf(locale, { initialCalendars: calendars, googleColors });
      const want = [
        { name: NAMES[locale].home, privacy: word(locale, 'privacyEditor'), tags: [{ text: cat(locale, 'primary'), tone: 'accent' }], colour: drawn.get('own') },
        { name: NAMES[locale].work, privacy: word(locale, 'privacyViewer'), tags: [{ text: cat(locale, 'kids'), tone: 'muted' }, { text: cat(locale, 'birthdays'), tone: 'muted' }], colour: drawn.get('plain') },
        { name: 'Solo', privacy: word(locale, 'privacyPrivate'), tags: [{ text: cat(locale, 'spouse'), tone: 'muted' }], colour: drawn.get('solo') },
      ];
      const html = renderToString(tree(locale, props));
      assert(html.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the server's root: ${html.slice(0, 140)}`);
      assert(html.includes(`<h1 class="ch-screen-title">${word(locale, 'title')}</h1>`), `${locale}: the title`);
      for (const scheme of ['dark', 'light'] as const) {
        const o = await open(locale, props, { ...TELEGRAM, scheme });
        try {
          const root = elements(o.m.container).find((e) => e.className === 'ch-app ch-screen ch-grouped');
          assert(root && root.getAttribute('data-theme') === scheme && root.getAttribute('dir') === dir && root.getAttribute('lang') === locale, `${locale} ${scheme}: the root`);
          assert(flat(elements(o.m.container).find((e) => e.localName === 'h1') as FakeNode) === word(locale, 'title'), `${locale} ${scheme}: the h1`);
          const rows = listRows(o.m);
          assert(rows.length === 3, `${locale} ${scheme}: ${rows.length} rows`);
          rows.forEach((row, i) => {
            const w = want[i];
            assert(flat(row).startsWith(w.name), `${locale} ${scheme}: row ${i} is ${flat(row)}`);
            assert(dotColour(row) === w.colour, `${locale} ${scheme}: ${w.name}'s dot is ${dotColour(row)} (drawn ${w.colour})`);
            assert(flat(row).includes(w.privacy), `${locale} ${scheme}: ${w.name}'s privacy line in ${flat(row)}`);
            assert(show(tagsOf(row)) === show(w.tags), `${locale} ${scheme}: ${w.name}'s tags ${show(tagsOf(row))}`);
          });
          assert(!rows.some((r) => tagsOf(r).some((t) => t.text === cat(locale, 'yours'))), `${locale} ${scheme}: a "yours" tag`);
          assert(rows.every((r) => elements(r).some((e) => classes(e).includes('ch-form-chevron'))), `${locale} ${scheme}: a row with no chevron`);
          // The name keeps its own direction inside the row
          assert(rows.every((r) => elements(r).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto')), `${locale} ${scheme}: a name outside a <bdi dir="auto">`);
          const add = buttonNamed(o.m.container, word(locale, 'newCalendar'));
          assert(add && classes(add).includes('ch-form-row') && classes(add).includes('ch-action-row') && elements(add).some((e) => e.localName === 'svg' && e.getAttribute('aria-hidden') === 'true'), `${locale} ${scheme}: the New calendar row`);
          const text = page(o.m);
          assert(!/\b(?:calendarsPage|googleCopy|ui|calendars\.categories)\.[a-zA-Z]/.test(text), `${locale} ${scheme}: a raw key in ${text}`);
          assert(!/\p{Extended_Pictographic}/u.test(text), `${locale} ${scheme}: an emoji`);
          assert(!/\b[AP]\.?M\b/i.test(text), `${locale} ${scheme}: a 12-hour time`);
          if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(/Google|FamCal|Solo|Noa/g, '')), `${locale} ${scheme}: Latin letters in ${text}`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('S3 the partner\'s section: named for the partner when there is a name ("Noa\'s calendars"), "Your partner\'s calendars" without one, absent when nothing is shared; its rows are not buttons and say what the viewer may do; the partner\'s copy line appears with the copies', async () => {
    for (const locale of LOCALES) {
      resetWorld(locale);
      const named = await open(locale, {}, TELEGRAM);
      try {
        assert(sectionLabels(named.m).includes(word(locale, 'sharedBy', { name: NAMES[locale].partner })), `${locale}: ${show(sectionLabels(named.m))}`);
        const heading = elements(named.m.container).find((e) => e.localName === 'h2' && flat(e) === word(locale, 'sharedBy', { name: NAMES[locale].partner })) as FakeElement;
        const card = heading.parentNode?.childNodes[(heading.parentNode?.childNodes.indexOf(heading) ?? 0) + 1] as FakeElement;
        assert(card && classes(card).includes('ch-form-card'), `${locale}: the card after the heading`);
        assert(buttonsOf(card).length === 0 && !elements(card).some((e) => e.getAttribute('role') === 'switch'), `${locale}: a control on the partner's calendar`);
        assert(flat(card).startsWith(NAMES[locale].noa) && flat(card).includes(word(locale, 'sharedAccess.edit')), `${locale}: the partner's row: ${flat(card)}`);
        assert(dotColour(card).length > 0, `${locale}: no dot`);
        assert(page(named.m).includes(tc(locale, 'nonOwner', { owner: 'Noa' })), `${locale}: the owner's copy line`);
      } finally {
        close(named);
      }
      const unnamed = await open(locale, { partnerName: null }, TELEGRAM);
      try {
        assert(sectionLabels(unnamed.m).includes(word(locale, 'sharedByPartner')) && !sectionLabels(unnamed.m).some((l) => l.includes(NAMES[locale].partner)), `${locale}: ${show(sectionLabels(unnamed.m))}`);
      } finally {
        close(unnamed);
      }
      const none = await open(locale, { initialCalendars: calendarsFor(locale).filter((c) => c.isOwner), partnerName: NAMES[locale].partner }, TELEGRAM);
      try {
        assert(!sectionLabels(none.m).some((l) => l === word(locale, 'sharedByPartner') || l === word(locale, 'sharedBy', { name: NAMES[locale].partner })), `${locale}: a partner section with nothing shared: ${show(sectionLabels(none.m))}`);
        assert(!page(none.m).includes(tc(locale, 'nonOwner', { owner: 'Noa' })), `${locale}: the owner's line with nothing shared`);
      } finally {
        close(none);
      }
    }
    // The copies don't apply: no owner line, but the partner's calendar is still listed
    resetWorld();
    srv.copies = () => json({ shown: false, ownerName: 'Noa', rows: [] });
    const off = await open('en', {}, TELEGRAM);
    try {
      assert(page(off.m).includes('Noa family') && !page(off.m).includes(tc('en', 'nonOwner', { owner: 'Noa' })), 'the copies are not shown: the partner row stays, its copy line goes');
    } finally {
      close(off);
    }
  });

  await check('S4 the Google row: connected shows "Google calendars" with the count (plural per language) and opens Select calendars; choose says "Choose Google calendars" and opens it; none and reconnect lead to /refresh-token (no locale prefix, through the browser); the hint sits under the card; works in a browser with no Telegram', async () => {
    const cases: [string, Row, string, string | null, 'push' | 'assign', string][] = [
      ['connected', { state: 'connected', chosen: 2 }, 'googleChosen', 'count2', 'push', '/select-calendars?user_id=5'],
      ['connected one', { state: 'connected', chosen: 1 }, 'googleChosen', 'count1', 'push', '/select-calendars?user_id=5'],
      ['connected five', { state: 'connected', chosen: 5 }, 'googleChosen', 'count5', 'push', '/select-calendars?user_id=5'],
      ['choose', { state: 'choose', chosen: 0 }, 'googleChoose', null, 'push', '/select-calendars?user_id=5'],
      ['none', { state: 'none', chosen: 0 }, 'googleConnect', null, 'assign', '/refresh-token?user_id=5'],
      ['reconnect', { state: 'reconnect', chosen: 2 }, 'googleReconnect', null, 'assign', '/refresh-token?user_id=5'],
    ];
    for (const locale of LOCALES) {
      for (const [name, google, label, count, how, target] of cases) {
        resetWorld(locale);
        const o = await open(locale, { google });
        try {
          assert(sectionLabels(o.m).at(-1) === word(locale, 'google'), `${locale} ${name}: the section label ${show(sectionLabels(o.m))}`);
          const row = buttonsOf(o.m.container).find((b) => flat(b).startsWith(word(locale, label)));
          assert(row && classes(row).includes('ch-form-row') && elements(row).some((e) => classes(e).includes('ch-form-chevron')), `${locale} ${name}: the row in ${show(buttonsOf(o.m.container).map(flat))}`);
          if (count) assert(flat(row) === `${word(locale, label)} ${countText(locale, Number(count.slice(5)))}`, `${locale} ${name}: ${flat(row)}`);
          else assert(flat(row) === word(locale, label), `${locale} ${name}: a value on ${flat(row)}`);
          const hint = elements(o.m.container).find((e) => e.localName === 'p' && classes(e).includes('ch-form-fixed') && flat(e) === word(locale, 'googleHint'));
          assert(hint, `${locale} ${name}: the hint`);
          const before = [pushes.length, assigned.length];
          o.m.click(row);
          if (how === 'push') assert(show(pushes) === show([`/${locale}${target}`]) && assigned.length === before[1], `${locale} ${name}: pushes ${show(pushes)} assigns ${show(assigned)}`);
          else assert(show(assigned) === show([target]) && pushes.length === before[0], `${locale} ${name}: assigns ${show(assigned)} pushes ${show(pushes)}`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('S5 Copy to Google: its section (label, one switch row per own calendar named for it, labelled "Copy “name” to Google Calendar", the notes once) shows when the copies apply, and not before the first answer, when they don\'t, or after a failed answer, which says so in the page\'s alert', async () => {
    for (const locale of LOCALES) {
      resetWorld(locale);
      const o = await open(locale, {}, TELEGRAM);
      try {
        assert(sectionLabels(o.m).includes(tc(locale, 'title')), `${locale}: ${show(sectionLabels(o.m))}`);
        const switches = switchesOf(o.m.container);
        assert(switches.length === 2, `${locale}: ${switches.length} switches`);
        assert(show(switches.map((s) => s.getAttribute('aria-label'))) === show([NAMES[locale].home, NAMES[locale].work].map((name) => tc(locale, 'switchLabel', { name }))), `${locale}: ${show(switches.map((s) => s.getAttribute('aria-label')))}`);
        assert(show(switches.map((s) => s.getAttribute('aria-checked'))) === show(['true', 'false']), `${locale}: switch states`);
        assert(flat(switches[0]).startsWith(NAMES[locale].home) && flat(switches[0]).includes(tc(locale, 'status.copied')), `${locale}: Home's row: ${flat(switches[0])}`);
        assert(elements(switches[0]).some((e) => classes(e).includes('ch-switch') && classes(e).includes('is-on')) && !elements(switches[1]).some((e) => classes(e).includes('is-on')), `${locale}: the switches' look`);
        assert(page(o.m).split(tc(locale, 'notes.alerts')).length === 2, `${locale}: the notes once`);
        assert(copyGets().length === 1, `${locale}: ${copyGets().length} copy GETs`);
      } finally {
        close(o);
      }
    }
    resetWorld();
    srv.copies = () => json({ shown: false, ownerName: 'Noa', rows: [] });
    const off = await open('en', {}, TELEGRAM);
    try {
      assert(switchesOf(off.m.container).length === 0 && !sectionLabels(off.m).includes(tc('en', 'title')) && !page(off.m).includes(tc('en', 'notes.alerts')), 'a Copy section when the copies do not apply');
      assert(alertsIn(off.m.container).length === 0, 'an alert with nothing wrong');
    } finally {
      close(off);
    }
    resetWorld();
    srv.copies = () => json({ error: 'failed' }, 500);
    const failed = await open('en', {}, TELEGRAM);
    try {
      assert(show(alertsIn(failed.m.container)) === show([tc('en', 'errors.load')]) && switchesOf(failed.m.container).length === 0, `a failed answer: ${show(alertsIn(failed.m.container))}`);
      assert(appLogs.some((l) => l.startsWith('[calendars] loading the Google copies failed')), `logged: ${show(appLogs)}`);
      assert(rowOf(failed.m, 'Home') && rowOf(failed.m, 'Work'), 'the calendars are still listed');
    } finally {
      close(failed);
    }
    resetWorld();
    let answer: (r: Response) => void = () => undefined;
    srv.copies = () => new Promise<Response>((resolve) => void (answer = resolve));
    const waiting = await open('en', {}, TELEGRAM);
    try {
      assert(switchesOf(waiting.m.container).length === 0 && !sectionLabels(waiting.m).includes(tc('en', 'title')), 'a Copy section before the first answer');
      await act(async () => { answer(json(VIEW)); await new Promise((r) => setTimeout(r, 0)); });
      await settle();
      assert(switchesOf(waiting.m.container).length === 2, 'the rows after the answer');
    } finally {
      close(waiting);
    }
  });

  await check('S6 the edit sheet, in en: a tap opens it named for the calendar with the saved values (name, the saved colour checked, five category switches in order with their hints, the privacy choice), a changed form sends exactly { name, color, labels, privacy, initData }, and a success closes it and the row shows the new name, privacy and tags', async () => {
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      await openRow(o, 'Home');
      const sheet = sheetOf(o.m) as FakeElement;
      assert(sheet.getAttribute('aria-label') === 'Home', `the sheet's name: ${sheet.getAttribute('aria-label')}`);
      assert(nameField(o.m).value === 'Home' && nameField(o.m).getAttribute('maxLength') === '60' && nameField(o.m).getAttribute('aria-label') === word('en', 'name'), `the name field: ${show([nameField(o.m).value, [...nameField(o.m).attributes.entries()]])}`);
      const colours = groupOf(o.m, word('en', 'color'));
      assert(show(radiosOf(colours).map((r) => r.getAttribute('aria-label'))) === show(swatchLabels('en')) && show(checkedOf(colours).map((r) => r.getAttribute('aria-label'))) === show(['Blue']), `the swatches: ${show(checkedOf(colours).map((r) => r.getAttribute('aria-label')))}`);
      const switches = switchesOf(sheet);
      const order = ['primary', 'yours', 'spouse', 'kids', 'birthdays'];
      assert(switches.length === 5, `${switches.length} category switches`);
      order.forEach((k, i) => {
        assert(flat(switches[i]) === `${cat('en', k)} ${word('en', `categoryHint.${k}`)}`, `switch ${k}: ${flat(switches[i])}`);
      });
      assert(show(switches.map((s) => s.getAttribute('aria-checked'))) === show(['true', 'true', 'false', 'false', 'false']), 'the saved labels');
      const privacy = groupOf(o.m, word('en', 'privacy'));
      assert(show(radiosOf(privacy).map(flat)) === show(privacyTexts('en')) && show(checkedOf(privacy).map(flat)) === show([word('en', 'privacyEditor')]), `privacy: ${show(checkedOf(privacy).map(flat))}`);
      assert(flat(saveButton(o.m)) === ui('en', 'save') && !saveButton(o.m).hasAttribute('disabled'), 'the Save button');
      assert(flat(cancelButton(o.m)) === ui('en', 'cancel'), 'the sheet\'s close says Cancel');
      assert(patches().length === 0, 'a request before Save');
      // Change everything
      o.m.input(nameField(o.m), '  Home base  ');
      o.m.click(radiosOf(colours).find((r) => r.getAttribute('aria-label') === 'Green') as FakeNode);
      o.m.click(switches[0]);
      o.m.click(switches[3]);
      o.m.click(radiosOf(privacy).find((r) => flat(r) === word('en', 'privacyPrivate')) as FakeNode);
      assert(show(checkedOf(groupOf(o.m, word('en', 'color'))).map((r) => r.getAttribute('aria-label'))) === show(['Green']) && show(switchesOf(sheetOf(o.m) as FakeNode).map((s) => s.getAttribute('aria-checked'))) === show(['false', 'true', 'false', 'true', 'false']), 'the form follows the taps');
      o.m.click(saveButton(o.m));
      await settle();
      const sent = patches();
      assert(sent.length === 1, `${sent.length} PATCH(es)`);
      assert(sent[0].path === '/api/native-calendars/own' && sent[0].query.get('user_id') === '5' && sent[0].headers['content-type'] === 'application/json', `the request: ${sent[0].path}?${sent[0].query}`);
      assert(show(sent[0].body) === show({ name: 'Home base', color: '#0b8043', labels: ['yours', 'kids'], privacy: 'PRIVATE', initData: initDataOf(o) }), `the body: ${show(sent[0].body)}`);
      assert(!sheetOf(o.m) && listGets().length >= 1, `the sheet closed: ${dialogs(o.m).length}, list GETs ${listGets().length}`);
      const row = rowOf(o.m, 'Home base');
      assert(flat(row).includes(word('en', 'privacyPrivate')) && show(tagsOf(row)) === show([{ text: 'Kids', tone: 'muted' }]), `the row: ${flat(row)} ${show(tagsOf(row))}`);
      assert(!listRows(o.m).some((r) => flat(r).startsWith('Home ') && !flat(r).startsWith('Home base')), 'the old row is still there');
      assert(confirmCalls === 0, 'window.confirm');
    } finally {
      close(o);
    }
    // A sheet opened again shows the saved values, not the earlier draft; and a cancelled edit leaves the row as it was
    resetWorld();
    const again = await open('en', {}, TELEGRAM);
    try {
      await openRow(again, 'Home');
      again.m.input(nameField(again.m), 'Draft');
      again.m.click(cancelButton(again.m));
      assert(!sheetOf(again.m) && patches().length === 0 && listRows(again.m).some((r) => flat(r).startsWith('Home')), 'Cancel leaves the row as it was');
      await openRow(again, 'Home');
      assert(nameField(again.m).value === 'Home', `the draft came back: ${nameField(again.m).value}`);
      // A blank name cannot be saved
      again.m.input(nameField(again.m), '   ');
      assert(saveButton(again.m).hasAttribute('disabled'), 'Save is on for a blank name');
    } finally {
      close(again);
    }
  });

  await check('S7 the server refuses a save (404 deleted elsewhere, 429, 401, 403, 500, no network): the sheet stays open with the typed values and says what happened in the page\'s language, the list does not change (a 404 asks it again), the failure is logged, and the next save that works closes the sheet', async () => {
    for (const locale of LOCALES) {
      const cases: [string, () => Reply, string][] = [
        ['404', () => json({ error: 'not_found' }, 404), 'errors.notFound'],
        ['429', () => json({ error: 'Too many requests' }, 429), 'errors.tooMany'],
        ['401', () => json({ error: 'Unauthorized' }, 401), 'errors.reopen'],
        ['403', () => json({ error: 'forbidden' }, 403), 'errors.reopen'],
        ['500', () => json({ error: 'Failed to update calendar' }, 500), 'errors.save'],
        ['400 with a body that is not JSON', () => new Response('<html>', { status: 400 }), 'errors.save'],
        ['no network', () => { throw new TypeError('Failed to fetch'); }, 'errors.save'],
      ];
      for (const [what, answer, key] of cases) {
        resetWorld(locale);
        const o = await open(locale, {}, TELEGRAM);
        try {
          await openRow(o, NAMES[locale].home);
          o.m.input(nameField(o.m), 'Typed name');
          const listBefore = listGets().length;
          srv.patch = answer;
          o.m.click(saveButton(o.m));
          await settle();
          const where = `${locale} ${what}`;
          assert(dialogs(o.m).length === 1, `${where}: ${dialogs(o.m).length} dialogs`);
          assert(show(alertsIn(sheetOf(o.m) as FakeNode)) === show([word(locale, key)]) && alertsIn(o.m.container).length === 1, `${where}: ${show(alertsIn(o.m.container))}`);
          assert(nameField(o.m).value === 'Typed name', `${where}: the typed name is ${nameField(o.m).value}`);
          assert(listRows(o.m).some((r) => flat(r).startsWith(NAMES[locale].home)) && !listRows(o.m).some((r) => flat(r).startsWith('Typed name')), `${where}: the list changed`);
          assert(appLogs.some((l) => l.startsWith('[calendars]')), `${where}: not logged: ${show(appLogs)}`);
          assert(!saveButton(o.m).hasAttribute('disabled') && !cancelButton(o.m).hasAttribute('disabled'), `${where}: the sheet is not usable again`);
          if (what === '404') assert(listGets().length > listBefore, `${where}: the list was not asked again`);
          else assert(listGets().length === listBefore, `${where}: the list was asked again`);
          // The next save that works closes the sheet and clears the error
          resetWorld(locale);
          o.m.click(saveButton(o.m));
          await settle();
          assert(!sheetOf(o.m) && listRows(o.m).some((r) => flat(r).startsWith('Typed name')), `${where}: a good save: ${dialogs(o.m).length} dialogs`);
          assert(alertsIn(o.m.container).length === 0, `${where}: the error stayed`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('S8 the colours are named in the page\'s language (never an English colour name in he or ru), each swatch is a labelled radio with its dot in the palette colour, a calendar whose colour is not in the palette has none checked, and the saved colour is checked in any letter case', async () => {
    for (const locale of LOCALES) {
      resetWorld(locale);
      const odd = cal('odd', 'Odd', { color: '#123456' });
      const o = await open(locale, { initialCalendars: [...calendarsFor(locale), odd] }, { ...TELEGRAM, scheme: 'dark' });
      try {
        await openRow(o, NAMES[locale].home);
        const group = groupOf(o.m, word(locale, 'color'));
        const labels = radiosOf(group).map((r) => r.getAttribute('aria-label'));
        assert(show(labels) === show(swatchLabels(locale)), `${locale}: ${show(labels)}`);
        if (locale !== 'en') for (const c of CALENDAR_PALETTE) assert(!labels.includes(c.name) && !labels.includes(messageAt('en', `calendarsPage.colors.${c.name.toLowerCase()}`)), `${locale}: the English name of ${c.name}`);
        assert(radiosOf(group).every((r, i) => elements(r).some((e) => classes(e).includes('ch-swatch-color') && e.style.background === CALENDAR_PALETTE[i].hex)), `${locale}: the dots`);
        assert(show(checkedOf(group).map((r) => r.getAttribute('aria-label'))) === show([swatchLabels(locale)[0]]), `${locale}: ${show(checkedOf(group).map((r) => r.getAttribute('aria-label')))}`);
        assert(radiosOf(group).every((r) => elements(r).every((e) => e.localName !== 'svg') || r.getAttribute('aria-checked') === 'true'), `${locale}: a check on an unchosen swatch`);
        o.m.click(cancelButton(o.m));
        await openRow(o, 'Odd');
        assert(checkedOf(groupOf(o.m, word(locale, 'color'))).length === 0, `${locale}: a swatch checked for an off-palette colour`);
      } finally {
        close(o);
      }
    }
  });

  await check('S9 delete, no Google copy: Delete calendar turns the sheet into its confirm step (named, with the warning and one danger button), nothing is sent until that button, then one DELETE whose body is { initData } alone and the row goes; Cancel leaves everything as it was; Back goes to the edit step first', async () => {
    for (const locale of LOCALES) {
      resetWorld(locale);
      const o = await open(locale, {}, TELEGRAM);
      try {
        const name = NAMES[locale].work;
        await openRow(o, name);
        const edited = 'Edited but not saved';
        o.m.input(nameField(o.m), edited);
        const delRow = mustButton(sheetOf(o.m) as FakeNode, word(locale, 'delete'));
        assert(classes(delRow).includes('ch-form-row') && classes(delRow).includes('ch-danger-row') && !delRow.hasAttribute('disabled'), `${locale}: the delete row`);
        o.m.click(delRow);
        await settle();
        const sheet = sheetOf(o.m) as FakeElement;
        assert(dialogs(o.m).length === 1 && labelOf(sheet) === word(locale, 'deleteTitle', { name }), `${locale}: the confirm step's name: ${sheet.getAttribute('aria-label')?.replace(BIDI, '')}`);
        const heading = elements(sheet).find((e) => e.localName === 'h2' && classes(e).includes('ch-sheet-heading'));
        assert(heading && flat(heading) === word(locale, 'deleteTitle', { name }) && elements(heading).some((e) => e.localName === 'bdi'), `${locale}: the heading ${heading && flat(heading)}`);
        assert(flat(sheet).includes(word(locale, 'deleteBody')) && show(dangerButtons(o.m).map(flat)) === show([word(locale, 'delete')]), `${locale}: the confirm step: ${flat(sheet)}`);
        assert(!nameField(o.m) && deletes().length === 0 && confirmCalls === 0, `${locale}: a field or a request before the confirm`);
        // Back: the edit step, with what was typed
        await back(o);
        assert(dialogs(o.m).length === 1 && labelOf(sheetOf(o.m)) === name && nameField(o.m).value === edited && deletes().length === 0, `${locale}: back from the confirm step: ${dialogs(o.m).length} dialogs, ${labelOf(sheetOf(o.m))}`);
        // Cancel on the confirm step: closed, nothing sent, nothing changed
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, word(locale, 'delete')));
        o.m.click(cancelButton(o.m));
        assert(!sheetOf(o.m) && deletes().length === 0 && listRows(o.m).some((r) => flat(r).startsWith(name)), `${locale}: Cancel`);
        // Delete
        await openRow(o, name);
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, word(locale, 'delete')));
        o.m.click(dangerButtons(o.m)[0]);
        await settle();
        assert(deletes().length === 1, `${locale}: ${deletes().length} DELETE(s)`);
        assert(deletes()[0].path === '/api/native-calendars/plain' && deletes()[0].query.get('user_id') === '5' && show(deletes()[0].body) === show({ initData: initDataOf(o) }), `${locale}: the DELETE ${show(deletes()[0])}`);
        assert(!sheetOf(o.m) && !listRows(o.m).some((r) => flat(r).startsWith(name)) && listRows(o.m).length === 1, `${locale}: after the delete: ${show(listRows(o.m).map(flat))}`);
        assert(confirmCalls === 0, `${locale}: window.confirm`);
      } finally {
        close(o);
      }
    }
  });

  await check('S10 delete of a calendar whose Google copy is on: the confirm step asks the Remove / Keep question (the name isolated in it) with no plain Delete button, each answer reaches the DELETE body as googleCopy, the copy rows are asked again after it, Cancel and Back send nothing; copies not loaded yet (a failed first answer, or one still in flight) are loaded first and a delete never goes without them', async () => {
    for (const locale of LOCALES) {
      for (const choice of ['remove', 'keep'] as const) {
        resetWorld(locale);
        const o = await open(locale, {}, TELEGRAM);
        try {
          const name = NAMES[locale].home;
          await openRow(o, name);
          o.m.click(mustButton(sheetOf(o.m) as FakeNode, word(locale, 'delete')));
          await settle();
          const sheet = sheetOf(o.m) as FakeElement;
          assert(flat(sheet).includes(tc(locale, 'unlink.question', { name })), `${locale}: the question in ${flat(sheet)}`);
          assert(show(buttonsOf(sheet).filter((b) => !classes(b).includes('ch-sheet-close')).map(flat)) === show([tc(locale, 'unlink.remove'), tc(locale, 'unlink.keep')]), `${locale}: the answers ${show(buttonsOf(sheet).map(flat))}`);
          assert(classes(mustButton(sheet, tc(locale, 'unlink.remove'))).includes('ch-btn-danger') && !classes(mustButton(sheet, tc(locale, 'unlink.keep'))).includes('ch-btn-danger'), `${locale}: Remove is the danger one`);
          assert(deletes().length === 0, `${locale}: a DELETE before the answer`);
          const gets = copyGets().length;
          o.m.click(mustButton(sheet, tc(locale, `unlink.${choice}`)));
          await settle();
          assert(deletes().length === 1 && show(deletes()[0].body) === show({ initData: initDataOf(o), googleCopy: choice }), `${locale} ${choice}: ${show(deletes()[0])}`);
          assert(!sheetOf(o.m) && !listRows(o.m).some((r) => flat(r).startsWith(name)) && copyGets().length === gets + 1, `${locale} ${choice}: after: ${dialogs(o.m).length} dialogs, copy GETs ${copyGets().length - gets}`);
        } finally {
          close(o);
        }
      }
    }
    // Cancel, and Back, on the question
    resetWorld();
    const cancelled = await open('en', {}, TELEGRAM);
    try {
      await openRow(cancelled, 'Home');
      cancelled.m.click(mustButton(sheetOf(cancelled.m) as FakeNode, word('en', 'delete')));
      await settle();
      await back(cancelled);
      assert(labelOf(sheetOf(cancelled.m)) === 'Home' && deletes().length === 0, 'back from the question');
      cancelled.m.click(mustButton(sheetOf(cancelled.m) as FakeNode, word('en', 'delete')));
      cancelled.m.click(cancelButton(cancelled.m));
      assert(!sheetOf(cancelled.m) && deletes().length === 0 && listRows(cancelled.m).length === 2, 'Cancel on the question');
    } finally {
      close(cancelled);
    }
    // The first answer of the copy rows failed: the delete asks again, and the question comes first
    resetWorld();
    let gets = 0;
    srv.copies = () => (++gets === 1 ? json({ error: 'failed' }, 500) : json(VIEW));
    const late = await open('en', {}, TELEGRAM);
    try {
      assert(switchesOf(late.m.container).length === 0, 'rows after a failed answer');
      await openRow(late, 'Home');
      tap(late, 'Delete calendar');
      await settle();
      assert(gets === 2 && deletes().length === 0 && flat(sheetOf(late.m) as FakeNode).includes('from Google too'), `asked again (${gets}) and the question: ${flat(sheetOf(late.m) as FakeNode)}`);
      late.m.click(mustButton(sheetOf(late.m) as FakeNode, 'Keep'));
      await settle();
      assert(deletes().length === 1 && deletes()[0].body?.googleCopy === 'keep', `the DELETE ${show(deletes()[0])}`);
    } finally {
      close(late);
    }
    // The first answer is still in flight: its absence is not "no copy"
    resetWorld();
    gets = 0;
    let first: (r: Response) => void = () => undefined;
    srv.copies = () => (++gets === 1 ? new Promise<Response>((resolve) => void (first = resolve)) : json(VIEW));
    const slow = await open('en', {}, TELEGRAM);
    try {
      await openRow(slow, 'Home');
      tap(slow, 'Delete calendar');
      await settle();
      assert(deletes().length === 0 && flat(sheetOf(slow.m) as FakeNode).includes('from Google too'), `the question while the first answer is in flight: ${flat(sheetOf(slow.m) as FakeNode)}`);
      await act(async () => { first(json(VIEW)); await new Promise((r) => setTimeout(r, 0)); });
    } finally {
      close(slow);
    }
    // The rows cannot load at all: nothing is deleted, and the sheet says so
    resetWorld();
    srv.copies = () => json({ error: 'failed' }, 500);
    const dead = await open('en', {}, TELEGRAM);
    try {
      await openRow(dead, 'Home');
      tap(dead, 'Delete calendar');
      await settle();
      assert(deletes().length === 0 && show(alertsIn(sheetOf(dead.m) as FakeNode)) === show([word('en', 'errors.delete')]) && labelOf(sheetOf(dead.m)) === 'Home', `rows that cannot load: ${show(alertsIn(dead.m.container))}`);
      assert(appLogs.some((l) => l.startsWith('[calendars] loading the Google copies before a delete failed')), `logged: ${show(appLogs)}`);
    } finally {
      close(dead);
    }
    function tap(o: Opened, text: string) {
      o.m.click(mustButton(sheetOf(o.m) as FakeNode, text));
    }
  });

  await check('S11 a delete the server refuses keeps the sheet on the confirm step with the reason in the page\'s language: the last calendar (400 cannot_delete_last), deleted elsewhere (404, and the list is asked again), 429, 401, 403, 500, no network; the list still has the row, and a retry that works closes the sheet', async () => {
    for (const locale of LOCALES) {
      const cases: [string, () => Reply, string][] = [
        ['cannot_delete_last', () => json({ error: 'cannot_delete_last' }, 400), 'onlyOne'],
        ['404', () => json({ error: 'not_found' }, 404), 'errors.notFound'],
        ['429', () => json({ error: 'Too many requests' }, 429), 'errors.tooMany'],
        ['401', () => json({ error: 'Unauthorized' }, 401), 'errors.reopen'],
        ['403', () => json({ error: 'forbidden' }, 403), 'errors.reopen'],
        ['500', () => json({ error: 'Failed to delete calendar' }, 500), 'errors.delete'],
        ['no network', () => { throw new TypeError('Failed to fetch'); }, 'errors.delete'],
      ];
      for (const [what, answer, key] of cases) {
        resetWorld(locale);
        const o = await open(locale, {}, TELEGRAM);
        try {
          const name = NAMES[locale].work;
          await openRow(o, name);
          o.m.click(mustButton(sheetOf(o.m) as FakeNode, word(locale, 'delete')));
          await settle();
          srv.del = answer;
          const listBefore = listGets().length;
          o.m.click(dangerButtons(o.m)[0]);
          await settle();
          const where = `${locale} ${what}`;
          assert(dialogs(o.m).length === 1 && labelOf(sheetOf(o.m)) === word(locale, 'deleteTitle', { name }), `${where}: not on the confirm step`);
          assert(show(alertsIn(sheetOf(o.m) as FakeNode)) === show([word(locale, key)]) && alertsIn(o.m.container).length === 1, `${where}: ${show(alertsIn(o.m.container))}`);
          assert(listRows(o.m).some((r) => flat(r).startsWith(name)), `${where}: the row went`);
          assert(appLogs.some((l) => l.startsWith('[calendars]')), `${where}: not logged`);
          assert(!dangerButtons(o.m)[0].hasAttribute('disabled') && !cancelButton(o.m).hasAttribute('disabled'), `${where}: the sheet is not usable again`);
          if (what === '404') assert(listGets().length > listBefore, `${where}: the list was not asked again`);
          resetWorld(locale);
          o.m.click(dangerButtons(o.m)[0]);
          await settle();
          assert(!sheetOf(o.m) && !listRows(o.m).some((r) => flat(r).startsWith(name)), `${where}: a retry that works`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('S12 the only own calendar cannot be deleted: its sheet shows a disabled delete row with "Your only calendar can\'t be deleted." and a tap on it goes nowhere; with two it is offered', async () => {
    for (const locale of LOCALES) {
      resetWorld(locale);
      const only = calendarsFor(locale).filter((c) => c.isOwner).slice(0, 1).concat(calendarsFor(locale).filter((c) => !c.isOwner));
      srv.list = only.map((c) => ({ ...c }));
      const o = await open(locale, { initialCalendars: only }, TELEGRAM);
      try {
        await openRow(o, NAMES[locale].home);
        const row = buttonsOf(sheetOf(o.m) as FakeNode).find((b) => classes(b).includes('ch-danger-row')) as FakeElement;
        assert(row && row.hasAttribute('disabled') && flat(row).includes(word(locale, 'onlyOne')) && flat(row).includes(word(locale, 'delete')), `${locale}: ${row && flat(row)}`);
        o.m.click(row);
        await settle();
        assert(labelOf(sheetOf(o.m)) === NAMES[locale].home && dangerButtons(o.m).length === 0 && deletes().length === 0, `${locale}: a tap went somewhere`);
      } finally {
        close(o);
      }
    }
    // A partner's calendar does not count as one of the person's own
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      await openRow(o, 'Home');
      const row = buttonsOf(sheetOf(o.m) as FakeNode).find((b) => classes(b).includes('ch-danger-row')) as FakeElement;
      assert(!row.hasAttribute('disabled') && !flat(row).includes('only calendar'), 'the delete row is offered with two own calendars');
    } finally {
      close(o);
    }
  });

  await check('S13 create: the row opens a sheet with an empty name and the example placeholder, Create is off for a blank name; it sends exactly { name, initData } (the name trimmed), closes, and the new calendar is in the list; the plan\'s limit says so with See plans, which opens the subscription page; 429, 401, 403, 500 and no network each say their own thing, keep the sheet and the typed name, and are logged', async () => {
    for (const locale of LOCALES) {
      resetWorld(locale);
      const o = await open(locale, {}, TELEGRAM);
      try {
        o.m.click(mustButton(o.m.container, word(locale, 'newCalendar')));
        await settle();
        const sheet = sheetOf(o.m) as FakeElement;
        assert(sheet.getAttribute('aria-label') === word(locale, 'newCalendar'), `${locale}: the sheet's name`);
        assert(nameField(o.m).value === '' && nameField(o.m).getAttribute('placeholder') === word(locale, 'namePlaceholder') && nameField(o.m).getAttribute('aria-label') === word(locale, 'name') && nameField(o.m).getAttribute('maxLength') === '60', `${locale}: the field ${show([nameField(o.m).value, [...nameField(o.m).attributes.entries()]])}`);
        assert(flat(saveButton(o.m)) === word(locale, 'create') && saveButton(o.m).hasAttribute('disabled'), `${locale}: Create is on for a blank name`);
        o.m.input(nameField(o.m), '   ');
        assert(saveButton(o.m).hasAttribute('disabled'), `${locale}: Create is on for spaces`);
        o.m.input(nameField(o.m), '  Soccer  ');
        o.m.click(saveButton(o.m));
        await settle();
        assert(posts().length === 1 && posts()[0].query.get('user_id') === '5' && show(posts()[0].body) === show({ name: 'Soccer', initData: initDataOf(o) }), `${locale}: ${show(posts()[0]?.body)}`);
        assert(!sheetOf(o.m) && listRows(o.m).some((r) => flat(r).startsWith('Soccer')) && listRows(o.m).length === 3, `${locale}: after: ${show(listRows(o.m).map(flat))}`);
        // The sheet opens empty again
        o.m.click(mustButton(o.m.container, word(locale, 'newCalendar')));
        assert(nameField(o.m).value === '', `${locale}: the old name is back`);
      } finally {
        close(o);
      }
    }
    for (const locale of LOCALES) {
      const cases: [string, () => Reply, string][] = [
        ['limit', () => json({ error: 'calendar_limit_reached', limit: 3, current: 3 }, 403), 'errors.limit'],
        ['429', () => json({ error: 'Too many requests' }, 429), 'errors.tooMany'],
        ['401', () => json({ error: 'Unauthorized' }, 401), 'errors.reopen'],
        ['403', () => json({ error: 'forbidden' }, 403), 'errors.reopen'],
        ['500', () => json({ error: 'Failed to create calendar' }, 500), 'errors.create'],
        ['no network', () => { throw new TypeError('Failed to fetch'); }, 'errors.create'],
      ];
      for (const [what, answer, key] of cases) {
        resetWorld(locale);
        const o = await open(locale, {}, TELEGRAM);
        try {
          o.m.click(mustButton(o.m.container, word(locale, 'newCalendar')));
          o.m.input(nameField(o.m), 'Soccer');
          srv.create = answer;
          o.m.click(saveButton(o.m));
          await settle();
          const where = `${locale} ${what}`;
          assert(dialogs(o.m).length === 1 && nameField(o.m).value === 'Soccer', `${where}: the sheet or the name went`);
          // The limit's notice carries its action (See plans) inside the alert
          const said = what === 'limit' ? `${word(locale, key)} ${word(locale, 'seePlans')}` : word(locale, key);
          assert(show(alertsIn(sheetOf(o.m) as FakeNode)) === show([said]) && listRows(o.m).length === 2, `${where}: ${show(alertsIn(o.m.container))}`);
          assert(appLogs.some((l) => l.startsWith('[calendars]')), `${where}: not logged`);
          const plans = buttonNamed(sheetOf(o.m) as FakeNode, word(locale, 'seePlans'));
          if (what === 'limit') {
            assert(plans && classes(plans).includes('ch-notice-action'), `${where}: no See plans`);
            o.m.click(plans);
            assert(show(pushes) === show([`/${locale}/subscription?user_id=5`]), `${where}: ${show(pushes)}`);
          } else {
            assert(!plans, `${where}: See plans for something that is not the limit`);
          }
        } finally {
          close(o);
        }
      }
    }
  });

  await check('S14 the copy\'s own question: turning a copy off asks Remove or Keep in a sheet (never window.confirm), Cancel sends nothing, Keep / Remove send the DELETE with the choice and close the sheet, a refusal shows under the row; turning one on sends the enable request', async () => {
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      const home = () => switchesOf(o.m.container)[0];
      o.m.click(home());
      await settle();
      const sheet = sheetOf(o.m) as FakeElement;
      assert(sheet && flat(sheet).includes('from Google too, including anything you added to it?') && flat(sheet).includes('FamCal · Home'), `the question: ${sheet && flat(sheet)}`);
      assert(show(buttonsOf(sheet).map(flat)) === show(['Remove', 'Keep', 'Cancel']), `the buttons ${show(buttonsOf(sheet).map(flat))}`);
      o.m.click(cancelButton(o.m));
      assert(!sheetOf(o.m) && callsTo('DELETE', '/api/google-sync').length === 0, 'Cancel sent a DELETE');
      o.m.click(home());
      o.m.click(mustButton(sheetOf(o.m) as FakeNode, 'Keep'));
      await settle();
      const del = callsTo('DELETE', '/api/google-sync')[0];
      assert(del && show(del.body) === show({ nativeCalendarId: 'own', googleCopy: 'keep' }) && !sheetOf(o.m), `Keep: ${show(del)}, ${dialogs(o.m).length} dialogs`);
      // A refusal: the sheet closes, the row says why
      srv.copyWrite = () => json({ error: 'failed' }, 500);
      o.m.click(home());
      o.m.click(mustButton(sheetOf(o.m) as FakeNode, 'Remove'));
      await settle();
      assert(!sheetOf(o.m) && show(alertsIn(o.m.container)) === show([tc('en', 'errors.failed')]), `the refusal: ${show(alertsIn(o.m.container))}`);
      // On
      srv.copyWrite = () => json({ status: 'created' });
      const work = () => switchesOf(o.m.container)[1];
      o.m.click(work());
      await settle();
      const enable = callsTo('POST', '/api/google-sync')[0];
      assert(enable && show(enable.body) === show({ action: 'enable', nativeCalendarId: 'plain' }), `enable ${show(enable)}`);
      assert(confirmCalls === 0, 'window.confirm');
    } finally {
      close(o);
    }
  });

  await check('S15 Back has one owner (AppScreen): Telegram\'s BackButton is registered once and goes to the dashboard in the page\'s language with no sheet open, closes the sheet when one is, goes from a confirm step to the edit step, and does nothing while a request runs (nor do Escape, the scrim and Cancel); in a browser the header\'s own back does the same; an open sheet locks Telegram\'s swipe down', async () => {
    for (const locale of LOCALES) {
      resetWorld(locale);
      const o = await open(locale, {}, TELEGRAM);
      try {
        const handlers = (o.tg as Row).backHandlers as unknown[];
        assert(handlers.length === 1 && o.tgCalls.includes('BackButton.show()'), `${locale}: ${handlers.length} BackButton handler(s)`);
        assert(!buttonsOf(o.m.container).some((b) => b.getAttribute('aria-label') === ui(locale, 'back')), `${locale}: an in-page back inside Telegram 7.7`);
        const swipes = () => o.tgCalls.filter((c) => /VerticalSwipes/.test(c)).at(-1);
        assert(swipes() === 'enableVerticalSwipes()', `${locale}: swipes ${swipes()}`);
        await openRow(o, NAMES[locale].home);
        assert(swipes() === 'disableVerticalSwipes()', `${locale}: the open sheet does not lock the swipe: ${swipes()}`);
        await back(o);
        assert(!sheetOf(o.m) && pushes.length === 0 && swipes() === 'enableVerticalSwipes()', `${locale}: Back with the sheet open: ${dialogs(o.m).length} dialogs, pushes ${show(pushes)}`);
        await back(o);
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=5`]), `${locale}: Back with no sheet: ${show(pushes)}`);
      } finally {
        close(o);
      }
    }
    // While a request runs nothing closes the sheet
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      await openRow(o, 'Home');
      o.m.input(nameField(o.m), 'Held');
      const release = holdNext('patch');
      o.m.click(saveButton(o.m));
      await settle();
      assert(saveButton(o.m).hasAttribute('disabled') && saveButton(o.m).getAttribute('aria-busy') === 'true' && cancelButton(o.m).hasAttribute('disabled'), 'the sheet does not show the request');
      await back(o);
      o.m.key(sheetOf(o.m) as FakeNode, 'Escape');
      o.m.click(elements(o.m.container).find((e) => e.className === 'ch-sheet-backdrop') as FakeNode);
      o.m.click(cancelButton(o.m));
      assert(dialogs(o.m).length === 1 && pushes.length === 0 && nameField(o.m).value === 'Held', `closed while it works: ${dialogs(o.m).length} dialogs, pushes ${show(pushes)}`);
      await release(json({ success: true }));
      await settle();
      assert(!sheetOf(o.m), 'the sheet stays after the answer');
      // With no sheet, a copy request running also holds Back
      const releaseCopy = holdNext('copyWrite');
      o.m.click(switchesOf(o.m.container)[1]);
      await settle();
      await back(o);
      assert(pushes.length === 0, `Back went on while a copy request ran: ${show(pushes)}`);
      await releaseCopy(json({ status: 'created' }));
      await settle();
      await back(o);
      assert(show(pushes) === show(['/en/dashboard?user_id=5']), `Back after it: ${show(pushes)}`);
    } finally {
      close(o);
    }
    // A browser (a WhatsApp person): the header's own back, once, mirrored in he
    for (const locale of ['en', 'he'] as Locale[]) {
      resetWorld(locale);
      const b = await open(locale, {});
      try {
        const buttons = buttonsOf(b.m.container).filter((x) => x.getAttribute('aria-label') === ui(locale, 'back'));
        assert(buttons.length === 1, `${locale}: ${buttons.length} header back buttons`);
        await openRow(b, NAMES[locale].home);
        b.m.click(buttons[0]);
        assert(!sheetOf(b.m) && pushes.length === 0, `${locale}: the header back with a sheet open`);
        b.m.click(buttons[0]);
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=5`]), `${locale}: the header back: ${show(pushes)}`);
        assert(elements(buttons[0]).some((e) => e.localName === 'svg' && classes(e).includes('ch-flip')), `${locale}: the back arrow does not flip in RTL`);
      } finally {
        close(b);
      }
    }
  });

  await check('S16 one request at a time: while a save runs only it is busy (spinner, aria-busy), the delete row, the New calendar row and the copy switches are off, a tap on a list row opens nothing, and a second Save sends nothing; while a copy request runs the New calendar row and the other switches are off too', async () => {
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      await openRow(o, 'Home');
      o.m.input(nameField(o.m), 'Held');
      const release = holdNext('patch');
      o.m.click(saveButton(o.m));
      o.m.click(saveButton(o.m));
      await settle();
      assert(patches().length === 1, `${patches().length} PATCH(es) for two taps`);
      const save = saveButton(o.m);
      assert(save.hasAttribute('disabled') && save.getAttribute('aria-busy') === 'true' && elements(save).some((e) => classes(e).includes('ch-form-spinner')), 'Save does not show it works');
      const del = buttonsOf(sheetOf(o.m) as FakeNode).find((b) => classes(b).includes('ch-danger-row')) as FakeElement;
      assert(del.hasAttribute('disabled') && !del.hasAttribute('aria-busy'), 'the delete row is not off while Save works');
      assert(buttonNamed(o.m.container, 'New calendar')?.hasAttribute('disabled') && pageSwitches(o.m).length === 2 && pageSwitches(o.m).every((s) => s.hasAttribute('disabled')), 'the page\'s rows are on while Save works');
      o.m.click(rowOf(o.m, 'Work'));
      assert(labelOf(sheetOf(o.m)) === 'Home' && dialogs(o.m).length === 1, 'a list row opened something');
      await release(json({ success: true }));
      await settle();
      assert(!sheetOf(o.m) && patches().length === 1, 'after the answer');
      // Two taps inside one frame (no render between them, so nothing is disabled yet): still one request
      await openRow(o, 'Work');
      o.m.input(nameField(o.m), 'Frame');
      const frame = holdNext('patch');
      await act(async () => {
        o.m.click(saveButton(o.m));
        o.m.click(saveButton(o.m));
      });
      await settle();
      assert(patches().length === 2, `two taps in one frame sent ${patches().length - 1} PATCH(es)`);
      await frame(json({ success: true }));
      await settle();
      // The same for the question's answers: one DELETE, and only the answer that was pressed shows it works
      await openRow(o, 'Home');
      o.m.click(mustButton(sheetOf(o.m) as FakeNode, word('en', 'delete')));
      await settle();
      const hold = holdNext('del');
      await act(async () => {
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, 'Keep'));
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, 'Remove'));
      });
      await settle();
      assert(deletes().length === 1 && deletes()[0].body?.googleCopy === 'keep', `two answers in one frame: ${show(deletes().map((d) => d.body))}`);
      const [remove, keep] = ['Remove', 'Keep'].map((text) => mustButton(sheetOf(o.m) as FakeNode, text));
      assert(keep.getAttribute('aria-busy') === 'true' && elements(keep).some((e) => classes(e).includes('ch-form-spinner')) && !remove.hasAttribute('aria-busy') && !elements(remove).some((e) => classes(e).includes('ch-form-spinner')) && remove.hasAttribute('disabled') && keep.hasAttribute('disabled'), 'only Keep shows it works, both are off');
      await hold(json({ success: true }));
      await settle();
      assert(!sheetOf(o.m), 'the sheet stays after the delete');
      // A copy request: the other controls wait, only its row shows it works
      const releaseCopy = holdNext('copyWrite');
      o.m.click(switchesOf(o.m.container)[1]);
      await settle();
      const [homeSwitch, workSwitch] = switchesOf(o.m.container);
      assert(workSwitch.hasAttribute('disabled') && workSwitch.getAttribute('aria-busy') === 'true' && flat(workSwitch).includes(tc('en', 'busy.on')) && elements(workSwitch).some((e) => classes(e).includes('ch-form-spinner')), `the busy row: ${flat(workSwitch)}`);
      assert(homeSwitch.hasAttribute('disabled') && !homeSwitch.hasAttribute('aria-busy') && buttonNamed(o.m.container, 'New calendar')?.hasAttribute('disabled'), 'the other controls are on while a copy request runs');
      o.m.click(rowOf(o.m, 'Home'));
      o.m.click(homeSwitch);
      assert(!sheetOf(o.m) && callsTo('POST', '/api/google-sync').length === 1, 'something opened or was sent while a copy request ran');
      await releaseCopy(json({ status: 'created' }));
      await settle();
      assert(switchesOf(o.m.container).every((s) => !s.hasAttribute('disabled')) && !buttonNamed(o.m.container, 'New calendar')?.hasAttribute('disabled'), 'the controls stay off after the answer');
    } finally {
      close(o);
    }
  });

  await check('S17 in he and ru no word of the old inline copy shows on the list, the edit sheet, the confirm step, the create sheet or the copy question; the strings come from messages (Hebrew gender-neutral and Russian formal are the language smokes\' job)', async () => {
    const OLD = ['Your calendars', 'Partner can', 'Private', 'Delete this calendar', 'Shared from partner', 'Visibility', 'Labels', 'Save', 'Cancel', 'Rename', 'Delete', 'New calendar', 'Calendar name', 'Yours', 'שלך', 'הפרטנר רואה', 'פרטנר רואה', 'תוויות', 'נראות', 'Твои', 'Приватный', 'Партнёр редактирует', 'Метки', 'Видимость'];
    for (const locale of ['he', 'ru'] as Locale[]) {
      resetWorld(locale);
      const o = await open(locale, {}, { ...TELEGRAM, scheme: 'dark' });
      try {
        const seen: string[] = [page(o.m)];
        await openRow(o, NAMES[locale].home);
        seen.push(flat(sheetOf(o.m) as FakeNode));
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, word(locale, 'delete')));
        await settle();
        seen.push(flat(sheetOf(o.m) as FakeNode));
        o.m.click(cancelButton(o.m));
        o.m.click(mustButton(o.m.container, word(locale, 'newCalendar')));
        seen.push(flat(sheetOf(o.m) as FakeNode));
        o.m.click(cancelButton(o.m));
        o.m.click(switchesOf(o.m.container)[0]);
        seen.push(flat(sheetOf(o.m) as FakeNode));
        const text = seen.join(' | ');
        for (const old of OLD) {
          // The words of the language's own strings may spell a word of the old copy: only the English and the retired ones are checked
          if (/[A-Za-z]/.test(old)) assert(!text.includes(old), `${locale}: "${old}" in ${text.slice(0, 300)}`);
        }
        assert(!/[A-Za-z]/.test(text.replace(/Google|FamCal|Noa/g, '')), `${locale}: Latin letters in ${text}`);
        for (const retired of ['נראות', 'תוויות', 'Видимость', 'Метки', 'Приватный', 'Твои']) assert(!text.includes(retired), `${locale}: the retired word ${retired}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S19 a write that went through while the list could not be asked again (a 500, an answer with no calendars, no network) still shows: the saved calendar has its new values, a deleted one is gone, a created one is added from the server\'s answer; each failed list request is logged and nothing throws', async () => {
    const answers: [string, () => Reply][] = [
      ['500', () => json({ error: 'Failed to load calendars' }, 500)],
      ['no calendars', () => json({ success: true })],
      ['no network', () => { throw new TypeError('Failed to fetch'); }],
    ];
    for (const [what, answer] of answers) {
      resetWorld();
      const o = await open('en', {}, TELEGRAM);
      try {
        srv.listGet = answer;
        await openRow(o, 'Work');
        o.m.input(nameField(o.m), 'Work 2');
        o.m.click(saveButton(o.m));
        await settle();
        assert(!sheetOf(o.m) && listRows(o.m).some((r) => flat(r).startsWith('Work 2')) && !listRows(o.m).some((r) => flat(r).startsWith('Work ') && !flat(r).startsWith('Work 2')), `${what}: the saved name: ${show(listRows(o.m).map(flat))}`);
        assert(appLogs.some((l) => l.startsWith('[calendars] reloading the list')), `${what}: not logged: ${show(appLogs)}`);
        o.m.click(mustButton(o.m.container, 'New calendar'));
        o.m.input(nameField(o.m), 'Soccer');
        o.m.click(saveButton(o.m));
        await settle();
        assert(!sheetOf(o.m) && listRows(o.m).some((r) => flat(r).startsWith('Soccer')), `${what}: the created calendar: ${show(listRows(o.m).map(flat))}`);
        await openRow(o, 'Work 2');
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, word('en', 'delete')));
        await settle();
        o.m.click(dangerButtons(o.m).length ? dangerButtons(o.m)[0] : mustButton(sheetOf(o.m) as FakeNode, 'Keep'));
        await settle();
        assert(!sheetOf(o.m) && !listRows(o.m).some((r) => flat(r).startsWith('Work 2')) && listRows(o.m).some((r) => flat(r).startsWith('Soccer')), `${what}: after the delete: ${show(listRows(o.m).map(flat))}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S18 window.confirm was never called on any path above, and React logged no warning (keys, nesting, attributes, act); the screen\'s own logs are only the failures the checks caused', () => {
    assert(confirmCalls === 0, `window.confirm was called ${confirmCalls} time(s)`);
    assert(reactWarnings.length === 0, `React warned: ${show(reactWarnings.slice(0, 3))}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
