// Smoke test for the admin panel's screens (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Tasks 2 and 3; spec
// 2026-10-19-screens-and-colours §4, §5): the shell, the Overview, Activity, Feedback and Blocked on AppScreen and the form kit,
// in real React on the small fake DOM, with a fake Telegram.WebApp, a router stub and a fake admin back end
// (scripts/lib/admin-world.ts). No network, no DB.
//  - R1 the Overview in en, he and ru, light (the server's) and dark (Telegram): the grouped root, the four counts (two of them
//    buttons) and the setup share (no NaN at 0 people), the rows into people, feedback, blocked and activity, the five switches, the
//    reset row; no raw key, no emoji, no English in he and ru beyond the brands;
//  - R2 early access asks in a sheet in both directions: Cancel and Back send nothing, Confirm posts once; a failure puts the switch
//    back and says so; the other four switches post at once and revert on a failure;
//  - R3 reset everyone: it asks, posts { initData, reset_all: true } and says how many people, with each language's plurals; a
//    failure keeps the sheet with the error;
//  - R4 the back stack: a sub-screen pushes and pops, a sheet closes first, a working sheet ignores Back, the root returns to the
//    calendar in the page's language with the viewer's Telegram id; AppScreen is the only BackButton caller;
//  - R5 Activity: one request when it opens, the filter, Show more (once for two taps), the rows' text;
//  - R6 Feedback: the rows, the sheet with the whole text in its own direction;
//  - R7 Blocked: the rows, Unblock posts the entry's own identifiers and says so; a failure stays in the sheet and is logged;
//  - R8 the loader is the grouped app loader, the denied card and the error card are in the app look with their text from messages;
//  - R9 React logs no warning; R10 the panel's CSS is the kit's rules and its class names are free.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-admin-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-admin-render.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, mount, FakeElement, FakeText, type FakeNode, type Mounted } from './lib/fake-dom';
import { lintCss } from './lib/css-lint';
import { calls, defaultRespond, INIT_DATA, installFakeFetch, json, NAMES, OTHER, ok, TARGET, VIEWER_TELEGRAM_ID, world, type Call, type Row } from './lib/admin-world';

const ROOT = path.resolve(__dirname, '..');
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

// ---- React must not warn; what the panel itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const adminLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : show(a))).join(' ');
    if (text.startsWith('[admin]')) return void adminLogs.push(text);
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: a router and a small admin back end ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
const router = { push: (href: string) => void pushes.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };
installFakeFetch();

const ago = (minutes: number) => new Date(Date.now() - minutes * 60000 - 5000).toISOString();
const FEEDBACK = [
  { id: 'f1', userId: TARGET, userName: 'Noa', userTelegramId: 7000007, text: 'Love the new calendar.\nCould the weekly summary arrive earlier on Fridays?', source: 'telegram', createdAt: ago(5) },
  { id: 'f2', userId: OTHER, userName: 'דנה', userTelegramId: 7000008, text: 'אפשר להוסיף תזכורת קולית?', source: 'dashboard', createdAt: ago(26 * 60) },
];
const BLOCKED = [
  { id: 1, telegramId: 99123, whatsappPhone: null, bannedBy: 9, bannedReason: 'spam', createdAt: ago(3 * 24 * 60) },
  { id: 2, telegramId: null, whatsappPhone: '+972501112233', bannedBy: 9, bannedReason: null, createdAt: ago(9 * 24 * 60) },
];
const scenario = {
  feedback: FEEDBACK as Row[],
  feedbackTotal: 2,
  blocked: BLOCKED.map((b) => ({ ...b })) as Row[],
  /** "POST settings" and the like: answered with a 500. */
  fail: new Set<string>(),
  /** A route held until released: "GET user-activity". */
  hold: new Map<string, (r: Response) => void>(),
  resetCount: 4,
  denied: false,
  loadFails: false,
};
const activityRows = (url: URL): Row[] => {
  const action = url.searchParams.get('action');
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 20);
  return Array.from({ length: Math.max(0, Math.min(limit, 45 - offset)) }, (_, i) => {
    const n = offset + i;
    const first = n === 0 && !action;
    return {
      id: `act-${n}`,
      userId: n % 2 === 0 ? TARGET : OTHER,
      userName: n % 2 === 0 ? NAMES[TARGET] : NAMES[OTHER],
      userTelegramId: null,
      action: action ?? (first ? 'command_completed' : 'login'),
      metadata: first ? { command: 'weather', platform: 'telegram' } : null,
      createdAt: ago(10 + n),
    };
  });
};
const respond = (call: Call): Response | Promise<Response> => {
  const url = new URL(call.url, 'http://localhost');
  const route = url.pathname.replace('/api/admin/', '');
  const key = `${call.method} ${route}`;
  if (scenario.denied && (route === 'settings' || route === 'stats')) return json({ error: 'Admin access required' }, 403);
  if (scenario.loadFails && (route === 'settings' || route === 'stats')) return json({ error: 'x' }, 500);
  if (scenario.fail.has(key)) return json({ error: 'Failed' }, 500);
  const held = scenario.hold.get(key);
  if (held) return new Promise<Response>((resolve) => void scenario.hold.set(key, resolve));
  if (key === 'GET feedback') return ok({ feedbacks: scenario.feedback, pagination: { total: scenario.feedbackTotal, limit: 50, offset: 0, hasMore: scenario.feedbackTotal > scenario.feedback.length } });
  if (key === 'GET users/blocklist') return ok({ blocklist: scenario.blocked });
  if (key === 'GET user-activity' && !url.searchParams.has('user_id')) {
    const rows = activityRows(url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return ok({ activities: rows, pagination: { total: 45, limit: 20, offset, hasMore: offset + 20 < 45 }, actionStats: [{ action: 'login', count: 30 }, { action: 'command_completed', count: 15 }] });
  }
  if (key === 'POST users/blocklist' && call.body?.action === 'unban') {
    scenario.blocked = scenario.blocked.filter((b) => !(b.telegramId === call.body?.telegramId && b.whatsappPhone === call.body?.whatsappPhone));
    return ok({});
  }
  if (key === 'POST reset-reminders' && call.body?.reset_all) return ok({ usersReset: scenario.resetCount });
  return defaultRespond(call);
};
world.respond = respond;

const reset = () => {
  pushes.length = 0;
  calls.splice(0);
  adminLogs.length = 0;
  scenario.feedback = FEEDBACK;
  scenario.feedbackTotal = 2;
  scenario.blocked = BLOCKED.map((b) => ({ ...b }));
  scenario.fail.clear();
  scenario.hold.clear();
  scenario.resetCount = 4;
  scenario.denied = false;
  scenario.loadFails = false;
};
const urls = () => calls.map((c) => c.url);
const requests = (method: string, route: string) => calls.filter((c) => c.method === method && c.url.startsWith(`/api/admin/${route}`));
const posts = (route: string) => requests('POST', route);

// ---- Fixtures ----

const STATS = { totalUsers: 12, usersWithOAuth: 5, usersWithCalendars: 4, needSetup: 3 };
const FLAGS = { remindersEnabled: true, nativeRemindersEnabled: false, earlyAdoptionMode: false, voiceAutoCreateHighConf: true, voiceTtsOutcome: false };
const propsOf = (locale: Locale, over: Row = {}): Row => ({ viewerTelegramId: VIEWER_TELEGRAM_ID, locale, stats: STATS, flags: FLAGS, ...over });

let AdminPanel: (props: Row) => ReactElement;
function tree(locale: Locale, el: ReactElement): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, el);
  return createElement(AppRouterContext.Provider, { value: router }, intl);
}
const panelTree = (locale: Locale, props: Row = propsOf(locale)) => tree(locale, createElement(AdminPanel, props));

/** What the strings of a language say, by key in the admin namespace ('rows.users'); {name} arguments filled in (plain ones only). */
const word = (locale: Locale, key: string, ns = 'admin', args: Row = {}): string => {
  const value = `${ns}.${key}`.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${ns}.${key} in ${locale}`);
  return Object.entries(args).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), value);
};

// ---- Reading what is on the page ----

/** What a reader sees: style sheets, tags and React's separators out, entities decoded, spaces collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
const flat = (node: FakeNode) => visible(node).replace(/\s+/g, ' ').trim();
const page = (m: Mounted) => flat(m.container);
const classes = (e: FakeElement) => e.className.split(' ');
const buttonsOf = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'button');
const dialogs = (m: Mounted) => byRole(m.container, 'dialog');
const alertsIn = (node: FakeNode) => byRole(node, 'alert').map(flat);
const statusesIn = (node: FakeNode) => byRole(node, 'status').map(flat);
const switches = (m: Mounted) => byRole(m.container, 'switch');
const switchOf = (m: Mounted, locale: Locale, key: string) => switches(m).find((s) => flat(s).startsWith(word(locale, `features.${key}`)));
const checked = (e: FakeElement | undefined) => e?.getAttribute('aria-checked') === 'true';
const listRows = (m: Mounted) => buttonsOf(m).filter((b) => classes(b).includes('ch-list-row'));
const rowOf = (m: Mounted, startsWith: string) => listRows(m).find((b) => flat(b).startsWith(startsWith));
const tilesOf = (m: Mounted) => elements(m.container).filter((e) => e.className === 'ch-admin-count');
const title = (m: Mounted) => elements(m.container).find((e) => e.localName === 'h1' && classes(e).includes('ch-screen-title'));
const inSheet = (m: Mounted, predicate: (e: FakeElement) => boolean) => {
  const dialog = dialogs(m)[0];
  return dialog ? elements(dialog).find(predicate) : undefined;
};
const confirmOf = (m: Mounted) => inSheet(m, (e) => e.localName === 'button' && classes(e).includes('ch-save'));
const cancelOf = (m: Mounted) => inSheet(m, (e) => e.localName === 'button' && classes(e).includes('ch-sheet-close'));
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** Mount in a browser (no Telegram) or in Telegram `version`; the caller closes it. */
function open(locale: Locale, props: Row = propsOf(locale), telegram?: { version: string; scheme?: 'light' | 'dark' }) {
  installWindow();
  const calls: string[] = [];
  const tg = telegram ? fakeTelegram(calls, telegram.version) : null;
  if (tg && telegram?.scheme) tg.colorScheme = telegram.scheme;
  fakeWindow.Telegram = tg ? { WebApp: tg } : { WebApp: { initData: INIT_DATA } };
  const m = mount(panelTree(locale, props));
  return { m, tg, calls };
}
const close = (opened: ReturnType<typeof open>) => {
  opened.m.unmount();
  fakeWindow.Telegram = undefined;
};
/** Tap Telegram's BackButton (the handler AppScreen registered). */
const tapBack = (o: ReturnType<typeof open>) => act(() => void (o.tg as Row).backHandlers[0]());
/** Open the Overview's row (its title starts with `name`) and wait for what the screen asks for. */
async function enter(o: ReturnType<typeof open>, locale: Locale, rowKey: string) {
  o.m.click(rowOf(o.m, word(locale, rowKey)) as FakeElement);
  await settle();
}

const BRANDS = /Telegram|WhatsApp|Google|FamCal|Pro|Gemini/g;

async function main() {
  AdminPanel = (await import('../app/[locale]/admin-panel/AdminPanel')).default as unknown as (props: Row) => ReactElement;

  await check('R1 the Overview in en, he and ru, light (server) and dark (Telegram): a grouped AppScreen root with its direction and language and the page title; four counts, People and Still setting up as buttons and the other two plain, the setup share (75%) and none at 0 people; the rows into people, feedback, blocked and activity; the five switches with the right state; the reset row; no raw key, no emoji, no English in he and ru beyond the brands', async () => {
    for (const locale of LOCALES) {
      reset();
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const html = renderToString(panelTree(locale));
      const text = textOf(html);
      const where = `${locale} light`;
      assert(html.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`), `${where}: the root: ${html.slice(0, 140)}`);
      assert(html.includes(`<h1 class="ch-screen-title">${word(locale, 'title')}</h1>`), `${where}: the title`);
      assert(!/\badmin\.[a-zA-Z]|\bui\.[a-zA-Z]/.test(text), `${where}: a raw key in ${text}`);
      assert(!/\p{Extended_Pictographic}/u.test(html), `${where}: an emoji`);
      if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(BRANDS, '')), `${where}: Latin letters in ${text.replace(BRANDS, '')}`);
      // The counts: four numbers over four labels; two buttons (People, Still setting up) with a chevron, two plain boxes
      const tiles = [...html.matchAll(/<(button|div)(?: type="button")? class="ch-admin-count"[^>]*>([\s\S]*?)<\/\1>/g)];
      assert(tiles.length === 4, `${where}: ${tiles.length} count tiles`);
      assert(show(tiles.map((t) => t[1])) === show(['button', 'div', 'div', 'button']), `${where}: the tiles' tags ${show(tiles.map((t) => t[1]))}`);
      const wantTiles = [
        ['12', word(locale, 'counts.people')],
        ['5', word(locale, 'counts.google')],
        ['4', word(locale, 'counts.calendars')],
        ['3', word(locale, 'counts.setup')],
      ];
      tiles.forEach((t, i) => {
        const [n, label] = wantTiles[i];
        assert(t[2].includes(`<span class="ch-admin-count-num">${n}</span>`) && t[2].includes(`<span class="ch-admin-count-label">${label}</span>`), `${where}: tile ${i}: ${t[2]}`);
        assert((i === 0 || i === 3) === t[2].includes('ch-form-chevron'), `${where}: tile ${i}: the chevron`);
      });
      assert(text.includes(word(locale, 'counts.setupDone', 'admin', { percent: 75 })), `${where}: the setup share: ${text}`);
      // The rows
      const rows = [...html.matchAll(/<button type="button" class="ch-form-row ch-list-row"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1]));
      const users = word(locale, 'rows.withCount', 'admin', { name: word(locale, 'rows.users'), count: 12 });
      assert(show(rows) === show([users, word(locale, 'rows.feedback'), word(locale, 'rows.blocked'), `${word(locale, 'rows.activity')} ${word(locale, 'rows.activityHint')}`]), `${where}: rows ${show(rows)}`);
      const sections = [...html.matchAll(/<h2 class="ch-section-label">([^<]*)<\/h2>/g)].map((m) => m[1]);
      assert(show(sections) === show(['people', 'activity', 'switches', 'reminders'].map((k) => word(locale, `sections.${k}`))), `${where}: sections ${show(sections)}`);
      // The switches, in order, with their state
      const sw = [...html.matchAll(/role="switch" aria-checked="(true|false)"/g)].map((m) => m[1] === 'true');
      assert(show(sw) === show([true, false, false, true, false]), `${where}: switches ${show(sw)}`);
      for (const key of ['reminders', 'nativeReminders', 'earlyAdoption', 'voiceAutoCreate', 'voiceTtsOutcome']) {
        assert(text.includes(word(locale, `features.${key}`)) && text.includes(word(locale, `features.${key}Description`)), `${where}: the ${key} switch`);
      }
      assert(html.includes('class="ch-form-row ch-danger-row"') && text.includes(word(locale, 'reset.row')) && text.includes(word(locale, 'reset.hint')), `${where}: the reset row`);
      assert(!html.includes('role="dialog"') && !html.includes('role="alert"'), `${where}: a sheet or an alert before anything happened`);
      // No setup share (and no NaN) with nobody
      const empty = textOf(renderToString(panelTree(locale, propsOf(locale, { stats: { totalUsers: 0, usersWithOAuth: 0, usersWithCalendars: 0, needSetup: 0 } }))));
      assert(!/NaN|Infinity/.test(empty) && !empty.includes(word(locale, 'counts.setupDone', 'admin', { percent: 0 }).replace('0', '')), `${where}: at 0 people: ${empty}`);
      assert(!empty.includes(word(locale, 'counts.setupDone', 'admin', { percent: 0 })), `${where}: a setup share at 0 people`);
      // Dark, as Telegram says it: the same root with its scheme; a light Telegram theme paints the header with the ground the cards sit on
      for (const scheme of ['dark', 'light'] as const) {
        const o = open(locale, propsOf(locale), { version: '7.7', scheme });
        try {
          const rootEl = elements(o.m.container).find((e) => e.className === 'ch-app ch-screen ch-grouped');
          assert(rootEl && rootEl.getAttribute('data-theme') === scheme && rootEl.getAttribute('dir') === dir, `${locale} ${scheme}: the root`);
          const colour = scheme === 'dark' ? 'bg_color' : 'secondary_bg_color';
          assert(o.calls.includes(`setHeaderColor(${colour})`) && !o.calls.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), `${locale} ${scheme}: ${show(o.calls.filter((c) => /Color/.test(c)))}`);
          assert(tilesOf(o.m).filter((t) => t.localName === 'button').length === 2 && switches(o.m).length === 5, `${locale} ${scheme}: tiles and switches`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('R2 early access asks first, in both directions: the switch opens a sheet (named, with its line and a Turn on / Turn off button), Cancel and Telegram\'s Back send nothing, Confirm posts { earlyAdoptionMode, initData } once and the switch flips; a failure puts it back with the error and a log; the other four switches post at once with no sheet and revert on a failure', async () => {
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      const w = (key: string) => word(locale, key);
      try {
        const early = () => switchOf(o.m, locale, 'earlyAdoption');
        assert(early() && !checked(early()), `${locale}: starts off`);
        // Turning on: a sheet, and nothing is sent until Confirm
        o.m.click(early() as FakeElement);
        const sheet = dialogs(o.m)[0];
        assert(sheet && sheet.getAttribute('aria-label') === w('earlyAccess.onTitle') && flat(sheet).includes(w('earlyAccess.onBody')), `${locale}: the on sheet: ${sheet && flat(sheet)}`);
        assert(flat(confirmOf(o.m) as FakeElement) === w('earlyAccess.onConfirm') && !classes(confirmOf(o.m) as FakeElement).includes('ch-btn-danger') && flat(cancelOf(o.m) as FakeElement) === word(locale, 'cancel', 'ui'), `${locale}: its buttons`);
        assert(posts('settings').length === 0 && !checked(early()), `${locale}: the switch moved before Confirm`);
        o.m.click(cancelOf(o.m) as FakeElement);
        await settle();
        assert(dialogs(o.m).length === 0 && posts('settings').length === 0 && !checked(early()), `${locale}: Cancel sent ${posts('settings').length} or moved the switch`);
        o.m.click(early() as FakeElement);
        tapBack(o);
        await settle();
        assert(dialogs(o.m).length === 0 && posts('settings').length === 0 && pushes.length === 0, `${locale}: Back with the sheet open: ${dialogs(o.m).length} dialog(s), ${posts('settings').length} post(s), pushes ${show(pushes)}`);
        o.m.click(early() as FakeElement);
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(dialogs(o.m).length === 0 && posts('settings').length === 1 && checked(early()), `${locale}: Confirm: ${posts('settings').length} post(s), on ${checked(early())}`);
        assert(show(posts('settings')[0].body) === show({ earlyAdoptionMode: true, initData: INIT_DATA }), `${locale}: the body ${show(posts('settings')[0].body)}`);
        // Turning off: its own sheet, and the red button
        o.m.click(early() as FakeElement);
        const off = dialogs(o.m)[0];
        assert(off && off.getAttribute('aria-label') === w('earlyAccess.offTitle') && flat(off).includes(w('earlyAccess.offBody')), `${locale}: the off sheet: ${off && flat(off)}`);
        assert(flat(confirmOf(o.m) as FakeElement) === w('earlyAccess.offConfirm') && classes(confirmOf(o.m) as FakeElement).includes('ch-btn-danger'), `${locale}: the off button`);
        assert(posts('settings').length === 1 && checked(early()), `${locale}: the switch moved before Confirm`);
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(posts('settings').length === 2 && !checked(early()) && show(posts('settings')[1].body) === show({ earlyAdoptionMode: false, initData: INIT_DATA }), `${locale}: turned off: ${show(posts('settings')[1]?.body)}`);
        assert(alertsIn(o.m.container).length === 0, `${locale}: an alert after two good saves`);
      } finally {
        close(o);
      }
    }

    // A failure, in en: the switch goes back and the page says so; a failed request is logged once
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    try {
      const early = () => switchOf(o.m, 'en', 'earlyAdoption') as FakeElement;
      scenario.fail.add('POST settings');
      o.m.click(early());
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(posts('settings').length === 1 && !checked(early()) && dialogs(o.m).length === 0, `a failed save: ${posts('settings').length} post(s), on ${checked(early())}`);
      assert(show(alertsIn(o.m.container)) === show([word('en', 'errors.switch')]) && adminLogs.length === 1 && adminLogs[0].startsWith('[admin] settings failed:'), `the error: ${show(alertsIn(o.m.container))}, logs ${show(adminLogs)}`);
      // The other switches post at once, in either direction, and revert on a failure
      scenario.fail.clear();
      const reminders = () => switchOf(o.m, 'en', 'reminders') as FakeElement;
      const was = checked(reminders());
      o.m.click(reminders());
      assert(dialogs(o.m).length === 0 && checked(reminders()) === !was, 'a plain switch flips at once, with no sheet');
      await settle();
      assert(posts('settings').length === 2 && show(posts('settings')[1].body) === show({ remindersEnabled: !was, initData: INIT_DATA }) && alertsIn(o.m.container).length === 0, `reminders: ${show(posts('settings')[1]?.body)}, alerts ${show(alertsIn(o.m.container))} (a good save clears the old error)`);
      for (const [key, flag] of [['nativeReminders', 'nativeRemindersEnabled'], ['voiceAutoCreate', 'voiceAutoCreateHighConf'], ['voiceTtsOutcome', 'voiceTtsOutcome']] as const) {
        const row = () => switchOf(o.m, 'en', key) as FakeElement;
        const before = checked(row());
        const count = posts('settings').length;
        o.m.click(row());
        await settle();
        assert(posts('settings').length === count + 1 && show(posts('settings')[count].body) === show({ [flag]: !before, initData: INIT_DATA }) && checked(row()) === !before, `${key}: ${show(posts('settings')[count]?.body)}`);
      }
      scenario.fail.add('POST settings');
      adminLogs.length = 0;
      const before = checked(reminders());
      o.m.click(reminders());
      await settle();
      assert(checked(reminders()) === before && show(alertsIn(o.m.container)) === show([word('en', 'errors.switch')]) && adminLogs.length === 1, `a failed plain switch goes back: on ${checked(reminders())}, ${show(alertsIn(o.m.container))}`);
      // A switch that is saving takes no second tap
      scenario.fail.clear();
      let release: (r: Response) => void = () => undefined;
      world.respond = (call) => (call.method === 'POST' && call.url.endsWith('/settings') ? new Promise<Response>((resolve) => void (release = resolve)) : respond(call));
      const count = posts('settings').length;
      o.m.click(reminders());
      o.m.click(reminders());
      await settle();
      assert(posts('settings').length === count + 1 && reminders().getAttribute('aria-disabled') === 'true', `two taps: ${posts('settings').length - count} post(s), disabled ${reminders().getAttribute('aria-disabled')}`);
      await act(async () => {
        release(ok());
        await new Promise((r) => setTimeout(r, 0));
      });
      world.respond = respond;
      assert(reminders().getAttribute('aria-disabled') === null, 'usable again after the answer');
    } finally {
      close(o);
    }
  });

  await check('R3 reset everyone still setting up: the danger row opens a sheet; Cancel sends nothing; Confirm posts { initData, reset_all: true } once and the page says how many people, with the plurals of each language (en 1 / 4, he 1 / 2 / 5, ru 1 / 2 / 5 / 21); a failure keeps the sheet with the error and a log', async () => {
    const cases: Record<Locale, [number, string][]> = {
      en: [[1, '1 person reset'], [4, '4 people reset']],
      he: [[1, 'התזכורות אופסו עבור אדם אחד'], [2, 'התזכורות אופסו עבור שני אנשים'], [5, 'התזכורות אופסו עבור 5 אנשים']],
      ru: [[1, 'Напоминания сброшены для 1 человека'], [2, 'Напоминания сброшены для 2 человек'], [5, 'Напоминания сброшены для 5 человек'], [21, 'Напоминания сброшены для 21 человека']],
    };
    for (const locale of LOCALES) {
      for (const [count, text] of cases[locale]) {
        reset();
        scenario.resetCount = count;
        const o = open(locale, propsOf(locale), { version: '7.7' });
        const w = (key: string) => word(locale, key);
        try {
          const row = () => buttonsOf(o.m).find((b) => classes(b).includes('ch-danger-row')) as FakeElement;
          assert(flat(row()) === w('reset.row'), `${locale}: the row says ${flat(row())}`);
          o.m.click(row());
          const sheet = dialogs(o.m)[0];
          assert(sheet && sheet.getAttribute('aria-label') === w('reset.title') && flat(sheet).includes(w('reset.body')) && classes(confirmOf(o.m) as FakeElement).includes('ch-btn-danger') && flat(confirmOf(o.m) as FakeElement) === w('reset.confirm'), `${locale}: the sheet: ${sheet && flat(sheet)}`);
          if (count === cases[locale][0][0]) {
            o.m.click(cancelOf(o.m) as FakeElement);
            await settle();
            assert(dialogs(o.m).length === 0 && posts('reset-reminders').length === 0, `${locale}: Cancel sent ${posts('reset-reminders').length}`);
            o.m.click(row());
          }
          o.m.click(confirmOf(o.m) as FakeElement);
          await settle();
          assert(posts('reset-reminders').length === 1 && show(posts('reset-reminders')[0].body) === show({ reset_all: true, initData: INIT_DATA }), `${locale} ${count}: ${show(posts('reset-reminders').map((c) => c.body))}`);
          assert(dialogs(o.m).length === 0 && show(statusesIn(o.m.container)) === show([text]), `${locale} ${count}: the result ${show(statusesIn(o.m.container))}`);
        } finally {
          close(o);
        }
      }
    }
    // A failure: the sheet stays with the error; closing it and trying again works; nothing is said about a reset that did not happen
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    try {
      const row = () => buttonsOf(o.m).find((b) => classes(b).includes('ch-danger-row')) as FakeElement;
      scenario.fail.add('POST reset-reminders');
      o.m.click(row());
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([word('en', 'errors.generic')]) && statusesIn(o.m.container).length === 0, `a failed reset: ${show(alertsIn(o.m.container))}`);
      assert(adminLogs.length === 1 && adminLogs[0].startsWith('[admin] reset-reminders failed:') && !confirmOf(o.m)?.hasAttribute('disabled'), `its log ${show(adminLogs)}, the button usable`);
      // Working: Back, Escape, the scrim and Cancel do nothing
      scenario.fail.clear();
      let release: (r: Response) => void = () => undefined;
      world.respond = (call) => (call.body?.reset_all ? new Promise<Response>((resolve) => void (release = resolve)) : respond(call));
      o.m.click(confirmOf(o.m) as FakeElement);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(posts('reset-reminders').length === 2, `${posts('reset-reminders').length} request(s) for the failed one and two taps`);
      const working = confirmOf(o.m);
      assert(working?.hasAttribute('disabled') && working.getAttribute('aria-busy') === 'true' && cancelOf(o.m)?.hasAttribute('disabled'), 'the working sheet');
      tapBack(o);
      o.m.key(dialogs(o.m)[0], 'Escape');
      o.m.click(elements(o.m.container).find((e) => e.className === 'ch-sheet-backdrop') as FakeElement);
      o.m.click(cancelOf(o.m) as FakeElement);
      assert(dialogs(o.m).length === 1 && pushes.length === 0, `the sheet closed while it works (${dialogs(o.m).length}, pushes ${show(pushes)})`);
      await act(async () => {
        release(ok({ usersReset: 4 }));
        await new Promise((r) => setTimeout(r, 0));
      });
      world.respond = respond;
      assert(dialogs(o.m).length === 0 && show(statusesIn(o.m.container)) === show(['4 people reset']), `after the answer: ${show(statusesIn(o.m.container))}`);
    } finally {
      close(o);
    }
  });

  await check('R4 the back stack: Activity, Feedback and Blocked push over the Overview and Telegram\'s Back pops them (one handler, one pop); a sheet closes before the view; at the Overview Back goes to /<locale>/dashboard?user_id=<the viewer\'s Telegram id>; the header\'s own back in a browser does the same and Telegram shows none; AppScreen is the only BackButton caller', async () => {
    for (const file of ['AdminPanel.tsx', 'navigation.tsx', 'sheets.tsx', 'views']) {
      const full = path.join(ROOT, 'app/[locale]/admin-panel', file);
      const sources = fs.statSync(full).isDirectory() ? fs.readdirSync(full).map((f) => path.join(full, f)) : [full];
      for (const source of sources) {
        const code = fs.readFileSync(source, 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
        assert(!/useTelegramBackButton\(/.test(code), `${path.basename(source)} calls useTelegramBackButton`);
      }
    }
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      try {
        assert((o.tg as Row).backHandlers.length === 1 && o.calls.includes('BackButton.show()'), `${locale}: the BackButton handlers: ${(o.tg as Row).backHandlers.length}`);
        assert(!buttonsOf(o.m).some((b) => b.getAttribute('aria-label') === word(locale, 'back', 'ui')), `${locale}: an in-page back inside Telegram 7.7`);
        for (const [rowKey, headerKey] of [['rows.activity', 'activity.title'], ['rows.feedback', 'feedback.title'], ['rows.blocked', 'blocked.title']] as const) {
          await enter(o, locale, rowKey);
          assert(flat(title(o.m) as FakeElement) === word(locale, headerKey), `${locale}: ${rowKey}: the header says ${title(o.m) && flat(title(o.m) as FakeElement)}`);
          assert((o.tg as Row).backHandlers.length === 1, `${locale}: ${rowKey}: ${(o.tg as Row).backHandlers.length} handlers`);
          tapBack(o);
          assert(flat(title(o.m) as FakeElement) === word(locale, 'title') && pushes.length === 0, `${locale}: ${rowKey}: Back popped to ${title(o.m) && flat(title(o.m) as FakeElement)} (pushes ${show(pushes)})`);
        }
        // From the Overview: the calendar, in the page's language, with the viewer's Telegram id
        tapBack(o);
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=${VIEWER_TELEGRAM_ID}`]), `${locale}: Back at the Overview: ${show(pushes)}`);
      } finally {
        close(o);
      }
    }
    // A sheet before the view: Feedback's message sheet
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await enter(o, 'en', 'rows.feedback');
      o.m.click(rowOf(o.m, 'Noa') as FakeElement);
      assert(dialogs(o.m).length === 1, 'the message sheet opens');
      tapBack(o);
      assert(dialogs(o.m).length === 0 && flat(title(o.m) as FakeElement) === word('en', 'feedback.title'), 'Back closed the sheet and stayed on Feedback');
      tapBack(o);
      assert(flat(title(o.m) as FakeElement) === word('en', 'title') && pushes.length === 0, 'the next Back popped the view');
    } finally {
      close(o);
    }
    // In a browser the header's own back does the same, and there is exactly one
    reset();
    const browser = open('he', propsOf('he'));
    try {
      const backs = () => buttonsOf(browser.m).filter((b) => b.getAttribute('aria-label') === word('he', 'back', 'ui'));
      assert(backs().length === 1, `the header's own back: ${backs().length}`);
      await enter(browser, 'he', 'rows.blocked');
      assert(backs().length === 1, 'one back on a sub-screen');
      browser.m.click(backs()[0]);
      assert(flat(title(browser.m) as FakeElement) === word('he', 'title'), 'the header back popped the view');
      browser.m.click(backs()[0]);
      assert(show(pushes) === show([`/he/dashboard?user_id=${VIEWER_TELEGRAM_ID}`]), `its tap at the Overview: ${show(pushes)}`);
    } finally {
      close(browser);
    }
  });

  await check('R5 Activity: one request when it opens; the filter (fed by the route\'s counts) asks again with the action and the rows follow it; Show more asks once for two taps and appends; a row says who, how long ago, the action and its detail (left to right); a failure says so with a retry', async () => {
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      try {
        calls.splice(0);
        await enter(o, locale, 'rows.activity');
        assert(requests('GET', 'user-activity').length === 1 && urls()[0] === '/api/admin/user-activity?limit=20&offset=0', `${locale}: ${requests('GET', 'user-activity').length} request(s) when it opened: ${show(calls.map((c) => c.url))}`);
        const rows = () => listRows(o.m);
        assert(rows().length === 20, `${locale}: ${rows().length} rows`);
        const first = flat(rows()[0]);
        assert(first.startsWith(NAMES[TARGET]) && first.includes('command_completed') && first.includes('weather · telegram'), `${locale}: the first row: ${first}`);
        const ltr = elements(rows()[0]).filter((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'ltr').map(flat);
        assert(show(ltr) === show(['command_completed']), `${locale}: the action is left to right: ${show(ltr)}`);
        assert(first.includes(NAMES[TARGET]) && flat(rows()[1]).startsWith(NAMES[OTHER]), `${locale}: the rows alternate between the two people: ${flat(rows()[1])}`);
        // The filter
        const select = elements(o.m.container).find((e) => e.localName === 'select') as FakeElement;
        assert(select && show(select.options.map((x) => x.value)) === show(['', 'login', 'command_completed']), `${locale}: the filter's options ${select && show(select.options.map((x) => x.value))}`);
        assert(flat(select.options[0]) === word(locale, 'activity.allActions') && flat(select.options[1]) === 'login (30)', `${locale}: the options' text`);
        calls.splice(0);
        o.m.change(select, 'login');
        await settle();
        assert(requests('GET', 'user-activity').length === 1 && urls()[0] === '/api/admin/user-activity?limit=20&offset=0&action=login', `${locale}: the filter asked ${show(calls.map((c) => c.url))}`);
        assert(rows().length === 20 && rows().every((r) => flat(r).includes('login')), `${locale}: the filtered rows`);
        // Show more: two quick taps, one request
        const more = () => buttonsOf(o.m).find((b) => flat(b) === word(locale, 'common.showMore')) as FakeElement;
        calls.splice(0);
        o.m.click(more());
        o.m.click(more());
        await settle();
        assert(requests('GET', 'user-activity').length === 1 && urls()[0] === '/api/admin/user-activity?limit=20&offset=20&action=login' && rows().length === 40, `${locale}: Show more: ${show(calls.map((c) => c.url))}, ${rows().length} rows`);
      } finally {
        close(o);
      }
    }
    // The guard on the screen: a page that is on its way when the filter changes lands nowhere
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await enter(o, 'en', 'rows.activity');
      scenario.hold.set('GET user-activity', () => undefined);
      const more = () => buttonsOf(o.m).find((b) => flat(b) === word('en', 'common.showMore')) as FakeElement;
      o.m.click(more());
      await settle();
      const release = scenario.hold.get('GET user-activity') as (r: Response) => void;
      scenario.hold.clear();
      o.m.change(elements(o.m.container).find((e) => e.localName === 'select') as FakeElement, 'command_completed');
      await settle();
      await act(async () => {
        release(ok({ activities: activityRows(new URL('http://x/?limit=20&offset=20')), pagination: { total: 45, limit: 20, offset: 20, hasMore: true }, actionStats: [] }));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert(listRows(o.m).length === 20 && listRows(o.m).every((r) => flat(r).includes('command_completed')), `the late page landed: ${listRows(o.m).length} rows`);
      // A failed first load says so, with a retry that asks again
      reset();
    } finally {
      close(o);
    }
    reset();
    const failing = open('en', propsOf('en'), { version: '7.7' });
    try {
      scenario.fail.add('GET user-activity');
      await enter(failing, 'en', 'rows.activity');
      assert(alertsIn(failing.m.container).length === 1 && alertsIn(failing.m.container)[0].startsWith(word('en', 'errors.load')) && adminLogs.some((l) => l.startsWith('[admin] user-activity failed:')), `a failed load: ${show(alertsIn(failing.m.container))}, ${show(adminLogs)}`);
      scenario.fail.clear();
      calls.splice(0);
      const retry = buttonsOf(failing.m).find((b) => flat(b) === word('en', 'retry', 'pageGate')) as FakeElement;
      failing.m.click(retry);
      await settle();
      assert(requests('GET', 'user-activity').length === 1 && alertsIn(failing.m.container).length === 0 && listRows(failing.m).length === 20, `the retry: ${requests('GET', 'user-activity').length} request(s), ${listRows(failing.m).length} rows`);
    } finally {
      close(failing);
    }
  });

  await check('R6 Feedback: a row per message (the sender, the first line only, how long ago, where it came from); a tap opens a sheet with the whole text in its own direction (dir="auto"), the date in 24-hour time and the source; Done closes it; an empty list says so', async () => {
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      try {
        await enter(o, locale, 'rows.feedback');
        const rows = listRows(o.m);
        assert(rows.length === 2, `${locale}: ${rows.length} rows`);
        const noa = flat(rows[0]);
        assert(noa.startsWith('Noa') && noa.includes('Love the new calendar.') && !noa.includes('Could the weekly summary') && noa.includes(word(locale, 'feedback.telegram')), `${locale}: Noa's row: ${noa}`);
        const dana = flat(rows[1]);
        assert(dana.startsWith('דנה') && dana.includes(word(locale, 'feedback.dashboard')), `${locale}: Dana's row: ${dana}`);
        // The sheet
        o.m.click(rows[0]);
        const sheet = dialogs(o.m)[0];
        assert(sheet && sheet.getAttribute('aria-label') === 'Noa', `${locale}: the sheet's name`);
        const text = inSheet(o.m, (e) => classes(e).includes('ch-admin-text'));
        assert(text && text.getAttribute('dir') === 'auto' && text.textContent === FEEDBACK[0].text, `${locale}: the whole text, dir ${text?.getAttribute('dir')}: ${text?.textContent}`);
        assert(flat(sheet).includes(word(locale, 'feedback.sentAt', 'admin', { date: '' }).trim().split(' ')[0]) && /\d{1,2}:\d{2}/.test(flat(sheet)) && !/\b[AP]M\b/i.test(flat(sheet)), `${locale}: the date: ${flat(sheet)}`);
        assert(flat(cancelOf(o.m) as FakeElement) === word(locale, 'done', 'ui'), `${locale}: the close button`);
        o.m.click(cancelOf(o.m) as FakeElement);
        assert(dialogs(o.m).length === 0, `${locale}: Done closes the sheet`);
        // A message in Hebrew keeps its direction on its own
        o.m.click(rows[1]);
        const hebrew = inSheet(o.m, (e) => classes(e).includes('ch-admin-text'));
        assert(hebrew?.getAttribute('dir') === 'auto' && hebrew.textContent === FEEDBACK[1].text, `${locale}: the Hebrew message`);
      } finally {
        close(o);
      }
    }
    // Nothing yet; and more than a page
    reset();
    scenario.feedback = [];
    scenario.feedbackTotal = 0;
    const empty = open('en', propsOf('en'), { version: '7.7' });
    try {
      await enter(empty, 'en', 'rows.feedback');
      assert(page(empty.m).includes(word('en', 'feedback.noFeedback')) && listRows(empty.m).length === 0, 'the empty line');
    } finally {
      close(empty);
    }
    reset();
    scenario.feedbackTotal = 120;
    const paged = open('en', propsOf('en'), { version: '7.7' });
    try {
      await enter(paged, 'en', 'rows.feedback');
      assert(buttonsOf(paged.m).some((b) => flat(b) === word('en', 'common.showMore')), 'Show more shows when the route says there is more');
    } finally {
      close(paged);
    }
  });

  await check('R7 Blocked: a row per entry (the id or number, always left to right, its kind and its reason); a tap opens a sheet with the reason, the date and Unblock; Unblock posts the entry\'s own identifiers { action: "unban", telegramId, whatsappPhone, initData } once, closes the sheet, says Unblocked and the entry is gone; a failure stays in the sheet with the error and a log (it is never silent); the Overview counts the entries', async () => {
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      try {
        await settle();
        assert(rowOf(o.m, word(locale, 'rows.withCount', 'admin', { name: word(locale, 'rows.blocked'), count: 2 })) !== undefined, `${locale}: the Overview's count of blocked: ${listRows(o.m).map(flat)}`);
        await enter(o, locale, 'rows.blocked');
        const rows = listRows(o.m);
        assert(rows.length === 2, `${locale}: ${rows.length} rows`);
        const ids = rows.map((r) => elements(r).find((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'ltr')?.textContent);
        assert(show(ids) === show(['99123', '+972501112233']), `${locale}: the identifiers (left to right): ${show(ids)}`);
        assert(flat(rows[0]).includes(word(locale, 'blocked.telegram')) && flat(rows[0]).includes('spam') && flat(rows[1]).includes(word(locale, 'blocked.whatsapp')) && flat(rows[1]).includes(word(locale, 'blocked.reasonNone')), `${locale}: the rows: ${flat(rows[0])} | ${flat(rows[1])}`);
        o.m.click(rows[1]);
        const sheet = dialogs(o.m)[0];
        assert(sheet && sheet.getAttribute('aria-label') === '+972501112233' && flat(confirmOf(o.m) as FakeElement) === word(locale, 'blocked.unblock'), `${locale}: the sheet: ${sheet && flat(sheet)}`);
        assert(/\d{1,2}:\d{2}/.test(flat(sheet)) && posts('users/blocklist').length === 0, `${locale}: the date, and nothing sent yet`);
        o.m.click(confirmOf(o.m) as FakeElement);
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(posts('users/blocklist').length === 1 && show(posts('users/blocklist')[0].body) === show({ action: 'unban', telegramId: null, whatsappPhone: '+972501112233', initData: INIT_DATA }), `${locale}: ${show(posts('users/blocklist').map((c) => c.body))}`);
        assert(dialogs(o.m).length === 0 && listRows(o.m).length === 1 && show(statusesIn(o.m.container)) === show([word(locale, 'blocked.unblocked')]), `${locale}: after Unblock: ${listRows(o.m).length} row(s), ${show(statusesIn(o.m.container))}`);
        // Opening another entry forgets the notice
        o.m.click(listRows(o.m)[0]);
        assert(statusesIn(o.m.container).filter((s) => s === word(locale, 'blocked.unblocked')).length === 0, `${locale}: the old notice stayed`);
      } finally {
        close(o);
      }
    }
    // A failure: the sheet stays, says so, and the entry stays
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await enter(o, 'en', 'rows.blocked');
      scenario.fail.add('POST users/blocklist');
      o.m.click(listRows(o.m)[0]);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([word('en', 'errors.unban')]) && scenario.blocked.length === 2, `a failed unblock: ${show(alertsIn(o.m.container))}`);
      assert(adminLogs.length === 1 && adminLogs[0].startsWith('[admin] users/blocklist failed:') && !confirmOf(o.m)?.hasAttribute('disabled'), `its log ${show(adminLogs)}, the button usable`);
      assert(statusesIn(o.m.container).filter((s) => s === word('en', 'blocked.unblocked')).length === 0, 'it says Unblocked after a failure');
      scenario.fail.clear();
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 0 && alertsIn(o.m.container).length === 0 && listRows(o.m).length === 1, 'a retry works and clears the error');
    } finally {
      close(o);
    }
    reset();
    scenario.blocked = [];
    const empty = open('en', propsOf('en'), { version: '7.7' });
    try {
      await enter(empty, 'en', 'rows.blocked');
      assert(page(empty.m).includes(word('en', 'blocked.empty')), 'the empty line');
    } finally {
      close(empty);
    }
  });

  await check('R8 the entry: the loader is the app\'s on the grouped ground; a non-admin gets the denied card (an alert with the page\'s h1, in the app look, text from messages in en, he and ru) and nothing of the panel; a failed load gets the error card with a retry that asks again; a good load shows the panel; startMiniApp asks for full height and sets no colour of its own', async () => {
    const client = await import('../app/[locale]/admin-panel/AdminPanelClient');
    const Client = client.default as unknown as (props: Row) => ReactElement;
    for (const locale of LOCALES) {
      reset();
      // The loader (what the server sends and the first client render)
      const loader = renderToString(tree(locale, createElement(Client, { userId: VIEWER_TELEGRAM_ID, locale })));
      assert(loader.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${locale === 'he' ? 'rtl' : 'ltr'}" lang="${locale}">`) && loader.includes('class="ch-loader"') && loader.includes(word(locale, 'loading', 'pageGate')), `${locale}: the loader: ${loader.slice(0, 200)}`);
      assert(!/role="switch"|stat-value|Unauthorized/.test(loader), `${locale}: the loader carries the panel`);
      // Denied
      scenario.denied = true;
      installWindow();
      const calls2: string[] = [];
      const tg = fakeTelegram(calls2, '7.7');
      fakeWindow.Telegram = { WebApp: tg };
      const denied = mount(tree(locale, createElement(Client, { userId: VIEWER_TELEGRAM_ID, locale })));
      await settle();
      try {
        const card = elements(denied.container).find((e) => classes(e).includes('ch-home-card'));
        assert(card && classes(card).includes('ch-crash') && card.getAttribute('role') === 'alert', `${locale}: the denied card`);
        assert(flat(elements(card).find((e) => e.localName === 'h1') as FakeElement) === word(locale, 'unauthorized.title') && flat(card).includes(word(locale, 'unauthorized.body')), `${locale}: its text: ${flat(card)}`);
        assert(elements(denied.container).some((e) => e.className === `ch-app ch-screen`) && !elements(denied.container).some((e) => classes(e).includes('ch-grouped')), `${locale}: the denied card is a plain AppScreen`);
        assert(switches(denied).length === 0 && listRows(denied).length === 0, `${locale}: the panel shows for a non-admin`);
        assert(calls2.includes('ready()') && calls2.includes('expand()') && !calls2.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), `${locale}: startMiniApp: ${show(calls2)}`);
        assert(show(calls.map((c) => c.url).sort()) === show(['/api/admin/settings', '/api/admin/stats']), `${locale}: the loader asked ${show(calls.map((c) => c.url))}`);
        assert(calls.every((c) => c.headers['x-telegram-init-data'] === (tg as Row).initData && !/initData/i.test(c.url)), `${locale}: the header, never the URL`);
      } finally {
        denied.unmount();
      }
      // The error card and its retry
      reset();
      scenario.loadFails = true;
      const errored = mount(tree(locale, createElement(Client, { userId: VIEWER_TELEGRAM_ID, locale })));
      await settle();
      try {
        const card = elements(errored.container).find((e) => classes(e).includes('ch-home-card'));
        assert(card && flat(card).includes(word(locale, 'errorTitle', 'pageGate')) && flat(card).includes(word(locale, 'errorBody', 'pageGate')), `${locale}: the error card: ${card && flat(card)}`);
        const retry = elements(card).find((e) => e.localName === 'button') as FakeElement;
        assert(flat(retry) === word(locale, 'retry', 'pageGate'), `${locale}: the retry button`);
        scenario.loadFails = false;
        calls.splice(0);
        errored.click(retry);
        await settle();
        assert(requests('GET', 'settings').length === 1 && requests('GET', 'stats').length === 1 && switches(errored).length === 5 && listRows(errored).length === 4, `${locale}: after the retry: ${show(urls())}, ${switches(errored).length} switches`);
        assert(flat(title(errored) as FakeElement) === word(locale, 'title'), `${locale}: the panel's title`);
      } finally {
        errored.unmount();
      }
      fakeWindow.Telegram = undefined;
    }
  });

  await check('R10 the panel\'s CSS keeps the kit\'s rules (logical properties, no hover, nothing under 11 px, no hex outside a token, a 44 px tap) and its class names are its own: no other file defines .ch-admin-*; the list row\'s and the tag tones\' names are free of the home\'s', () => {
    const { ADMIN_CSS } = nodeRequire('../app/[locale]/admin-panel/admin-css') as { ADMIN_CSS: string };
    const problems = lintCss(ADMIN_CSS);
    assert(problems.length === 0, `lintCss: ${show(problems)}`);
    assert(/min-block-size:\s*76px/.test(ADMIN_CSS), 'a count tile is taller than 44 px');
    const owners: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.(?:tsx?|css)$/.test(entry.name) && /\.ch-admin-/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')) && rel !== 'app/[locale]/admin-panel/admin-css.ts') owners.push(rel);
      }
    };
    for (const dir of ['app', 'components', 'src']) walk(dir);
    assert(owners.length === 0, `.ch-admin-* is also in ${owners.join(', ')}`);
    const taken = (name: string) => {
      const hits: string[] = [];
      const scan = (dir: string) => {
        for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
          const rel = path.join(dir, entry.name);
          if (entry.isDirectory()) scan(rel);
          else if (/\.(?:tsx?|css)$/.test(entry.name) && new RegExp(`\\.${name}(?![\\w-])`).test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) hits.push(rel);
        }
      };
      for (const dir of ['app', 'components', 'src']) scan(dir);
      return hits;
    };
    for (const name of ['ch-list-row', 'ch-list-title', 'ch-list-tags', 'ch-tag-danger', 'ch-tag-muted']) {
      const hits = taken(name);
      assert(hits.every((f) => f.startsWith('components/app-ui/')), `.${name} is also in ${hits.join(', ')}`);
    }
  });

  await check('R9 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
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
