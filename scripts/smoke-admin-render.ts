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
//  - R9 React logs no warning; R10 the panel's CSS is the kit's rules and its class names are free;
//  - U1 Users: the rows, their plan lines and tags, the search, the filters, and both kept after a profile; U2 the profile of a person on a
//    trial, a paid one, one given Pro for free, a WhatsApp-only one and a suspended one, in en, he and ru; U3 every action of a profile (it
//    asks, Cancel sends nothing, the exact body with the person's database id, a reload on success, our own message and a log on failure);
//    U4 deleting a person (DELETE typed, a working sheet, the notice on the people list once); U5 a long profile still ends on Account;
//    U6 a late answer for another person shows nowhere; U7 the panel is made of the kit and its messages are all read;
//  - the fix round: U8 a delete waits for the people list and lands on Users with its notice, from Users or from the log; U9 saving away
//    the last override settles; U10 notices sit under their action; U11 RTL rows start on the page's start side; U12 only open setup
//    steps can be sent; U13 scroll is kept per view; U14 a plan that will not renew says so.
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
import { ADMIN_CSS } from '../app/[locale]/admin-panel/admin-css';
import { UserProfile } from '../app/[locale]/admin-panel/views/UserProfile';
import { FORM_CSS } from '../components/app-ui/form-kit';
import { ListRow } from '../components/app-ui/ListRow';
import { calls, defaultRespond, detail, INIT_DATA, installFakeFetch, json, NAMES, OTHER, ok, overrideAfterPost, TARGET, VIEWER_TELEGRAM_ID, world, type Call, type Row } from './lib/admin-world';

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

// The people of the Users screen: a person on a trial, a free one, a paid one (its plan includes some features), one given Pro for free,
// one with WhatsApp only, and a suspended one. Names are in the page's language, so a Hebrew or Russian page shows no Latin from them.
const TRIAL = TARGET;
const FREE = OTHER;
const PAID = 21;
const COMPED = 22;
const WA_ONLY = 23;
const SUSPENDED = 24;
const IDS = [TRIAL, FREE, PAID, COMPED, WA_ONLY, SUSPENDED];
const PEOPLE_NAMES: Record<Locale, string[]> = {
  en: ['Noa Levi', 'Dan Cohen', 'Maya Bar', 'Tom Peretz', 'Rina Katz', 'Omer Dayan'],
  he: ['נועה לוי', 'דן כהן', 'מאיה בר', 'תום פרץ', 'רינה כץ', 'עומר דיין'],
  ru: ['Ноа Леви', 'Дан Коэн', 'Майя Бар', 'Том Перец', 'Рина Кац', 'Омер Даян'],
};
const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const SUBS: Record<string, Row> = {
  trial: { plan: 'FREE', status: 'TRIALING', trialEndsAt: inDays(9), trialDaysRemaining: 9, currentPeriodEnd: null, comped: false, compedAt: null, compReason: null },
  free: { plan: 'FREE', status: 'EXPIRED', trialEndsAt: null, trialDaysRemaining: null, currentPeriodEnd: null, comped: false, compedAt: null, compReason: null },
  paid: { plan: 'BASIC', status: 'ACTIVE', trialEndsAt: null, trialDaysRemaining: null, currentPeriodEnd: inDays(20), comped: false, compedAt: null, compReason: null },
  comped: { plan: 'PRO', status: 'ACTIVE', trialEndsAt: null, trialDaysRemaining: null, currentPeriodEnd: null, comped: true, compedAt: ago(5 * 24 * 60), compReason: 'pilot' },
};
const NO_PAID = { unlimitedSummaries: false, remindersEnabled: false, voiceEventsEnabled: false, unlimitedCalendars: false };
function makePeople(locale: Locale): Map<number, Row> {
  const names = PEOPLE_NAMES[locale];
  const spam = { en: 'spam', he: 'ספאם', ru: 'спам' }[locale];
  const person = (id: number, over: Row): [number, Row] => [id, detail(id, { name: names[IDS.indexOf(id)], ...over })];
  return new Map<number, Row>([
    person(TRIAL, { subscription: SUBS.trial, registrationStatus: { hasOAuth: false, hasCalendars: false, hasLocation: false, applicableReminder: 'location', googleState: 'none' }, setupReminders: { daysSinceCreated: 12, daysSinceStart: 12, wasReset: false, calendars: [], reconnect: [], location: [{ day: 1, sent: true, due: true }, { day: 3, sent: true, due: true }, { day: 7, sent: false, due: true }, { day: 14, sent: false, due: false }] } }),
    person(FREE, { subscription: SUBS.free, whatsappPhone: null, registrationStatus: { hasOAuth: true, hasCalendars: false, hasLocation: false, applicableReminder: 'calendars', googleState: 'choose' } }),
    person(PAID, { subscription: SUBS.paid, whatsappPhone: null, paidFeatures: { ...NO_PAID, unlimitedSummaries: true, remindersEnabled: true }, limits: { textSummaries: null, voiceSummaries: 20, calendars: 5 }, override: { unlimitedSummaries: null, remindersEnabled: null, voiceEventsEnabled: null, unlimitedCalendars: null, earlyAdopter: true, reason: 'early tester', grantedAt: ago(100), grantedBy: 9 }, registrationStatus: { hasOAuth: true, hasCalendars: true, hasLocation: true, applicableReminder: null, googleState: 'connected' }, setupReminders: { daysSinceCreated: 40, daysSinceStart: 3, wasReset: true, calendars: [{ day: 1, sent: true, due: true }], reconnect: [{ day: 1, sent: true, due: true }, { day: 3, sent: false, due: false }], location: [{ day: 1, sent: true, due: true }] } }),
    person(COMPED, { subscription: SUBS.comped, whatsappPhone: null }),
    person(WA_ONLY, { telegramId: null, whatsappPhone: '+972501230023', messagingPlatform: 'whatsapp', subscription: SUBS.free }),
    person(SUSPENDED, { subscription: SUBS.free, suspendedAt: ago(2 * 24 * 60), suspendedReason: spam, suspendedBy: 9 }),
  ]);
}
/** A row of the people list, from a person's profile. */
const listOf = (d: Row): Row => ({
  id: d.id,
  telegramId: d.telegramId,
  name: d.name,
  suspendedAt: d.suspendedAt,
  subscription: d.subscription && { plan: d.subscription.plan, status: d.subscription.status, trialEndsAt: d.subscription.trialEndsAt, trialDaysRemaining: d.subscription.trialDaysRemaining, currentPeriodEnd: d.subscription.currentPeriodEnd, comped: d.subscription.comped },
  usage: d.usage,
  calendarsCount: d.calendarsCount,
  hasOverride: d.override !== null,
  earlyAdopter: d.override?.earlyAdopter === true,
});

const scenario = {
  locale: 'en' as Locale,
  people: makePeople('en'),
  /** How many rows of activity each person has. */
  userActivityTotal: 45,
  feedback: FEEDBACK as Row[],
  feedbackTotal: 2,
  blocked: BLOCKED.map((b) => ({ ...b })) as Row[],
  /** "POST settings" and the like: answered with a 500. A profile's own request is "GET user-overrides?7". */
  fail: new Set<string>(),
  /** A route answered with something else: "POST users/blocklist" -> a 400 SELF_BAN. */
  answers: new Map<string, () => Response>(),
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
const userActivityRows = (id: number, url: URL): Row[] => {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 20);
  return Array.from({ length: Math.max(0, Math.min(limit, scenario.userActivityTotal - offset)) }, (_, i) => {
    const n = offset + i;
    return { id: `u${id}-${n}`, userId: id, userName: scenario.people.get(id)?.name ?? 'x', userTelegramId: null, action: n === 0 ? 'settings_changed' : 'login', metadata: n === 0 ? { changed_fields: ['location', 'language'] } : null, createdAt: ago(30 + n * 5) };
  });
};
const respond = (call: Call): Response | Promise<Response> => {
  const url = new URL(call.url, 'http://localhost');
  const route = url.pathname.replace('/api/admin/', '');
  const key = `${call.method} ${route}`;
  if (scenario.denied && (route === 'settings' || route === 'stats')) return json({ error: 'Admin access required' }, 403);
  if (scenario.loadFails && (route === 'settings' || route === 'stats')) return json({ error: 'x' }, 500);
  if (scenario.fail.has(key) || scenario.fail.has(`${key}?${url.searchParams.get('user_id')}`)) return json({ error: 'Failed' }, 500);
  const answer = scenario.answers.get(key);
  if (answer) return answer();
  const held = scenario.hold.get(key);
  if (held) return new Promise<Response>((resolve) => void scenario.hold.set(key, resolve));
  if (key === 'GET feedback') return ok({ feedbacks: scenario.feedback, pagination: { total: scenario.feedbackTotal, limit: 50, offset: 0, hasMore: scenario.feedbackTotal > scenario.feedback.length } });
  if (key === 'GET users/blocklist') return ok({ blocklist: scenario.blocked });
  if (key === 'GET user-activity' && !url.searchParams.has('user_id')) {
    const rows = activityRows(url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return ok({ activities: rows, pagination: { total: 45, limit: 20, offset, hasMore: offset + 20 < 45 }, actionStats: [{ action: 'login', count: 30 }, { action: 'command_completed', count: 15 }] });
  }
  if (key === 'GET user-overrides' && url.searchParams.get('list') === 'all') {
    const list = 'GET user-overrides?list=all';
    if (scenario.hold.has(list)) return new Promise<Response>((resolve) => void scenario.hold.set(list, resolve));
    return ok({ users: [...scenario.people.values()].map(listOf) });
  }
  if (key === 'GET user-overrides' && url.searchParams.has('user_id')) {
    const held = scenario.hold.get(`${key}?${url.searchParams.get('user_id')}`);
    const person = scenario.people.get(Number(url.searchParams.get('user_id')));
    if (held) return new Promise<Response>((resolve) => void scenario.hold.set(`${key}?${url.searchParams.get('user_id')}`, (r) => resolve(r)));
    return person ? ok({ user: person }) : json({ error: 'User not found' }, 404);
  }
  if (key === 'GET user-activity' && url.searchParams.has('user_id')) {
    const id = Number(url.searchParams.get('user_id'));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return ok({ activities: userActivityRows(id, url), pagination: { total: scenario.userActivityTotal, limit: 20, offset, hasMore: offset + 20 < scenario.userActivityTotal }, actionStats: [] });
  }
  // What an action does to the person, so that the reload after it shows it
  const target = scenario.people.get(Number(call.body?.user_id ?? url.searchParams.get('user_id')));
  if (key === 'POST users/moderation' && target) {
    if (call.body?.action === 'suspend') Object.assign(target, { suspendedAt: ago(0), suspendedReason: call.body.reason ?? null });
    else if (call.body?.action === 'unsuspend') Object.assign(target, { suspendedAt: null, suspendedReason: null });
    else if (call.body?.action === 'hard_delete') scenario.people.delete(target.id);
    return ok({});
  }
  if (key === 'POST subscription' && target) {
    target.subscription = { ...SUBS.comped, compedAt: ago(0), compReason: call.body?.reason ?? null };
    return ok({});
  }
  if (key === 'DELETE subscription' && target) {
    target.subscription = SUBS.free;
    return ok({});
  }
  if (key === 'POST user-overrides' && target) {
    target.override = overrideAfterPost(call.body ?? {}, ago(0));
    return ok({ override: target.override });
  }
  if (key === 'POST switch-platform' && target) {
    Object.assign(target, { whatsappPhone: call.body?.whatsapp_phone, messagingPlatform: 'whatsapp' });
    return ok({});
  }
  if (key === 'POST users/blocklist' && call.body?.action === 'ban') {
    scenario.blocked.push({ id: 90 + scenario.blocked.length, telegramId: call.body.telegramId, whatsappPhone: call.body.whatsappPhone, bannedBy: 9, bannedReason: call.body.reason, createdAt: ago(0) });
    return ok({});
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
  scenario.locale = 'en';
  scenario.people = makePeople('en');
  scenario.userActivityTotal = 45;
  scenario.feedback = FEEDBACK;
  scenario.feedbackTotal = 2;
  scenario.blocked = BLOCKED.map((b) => ({ ...b }));
  scenario.fail.clear();
  scenario.answers.clear();
  scenario.hold.clear();
  scenario.resetCount = 4;
  scenario.denied = false;
  scenario.loadFails = false;
};
/** How many requests were sent, and how many failures logged, since the last reset (functions, so that a narrowed type does not stick). */
const sent = () => calls.length;
const logged = () => adminLogs.length;
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
  scenario.locale = locale;
  scenario.people = makePeople(locale);
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

// ---- Task 3's helpers: the people list, a profile, a sheet's fields ----

const searchBox = (m: Mounted, locale: Locale) => elements(m.container).find((e) => e.localName === 'input' && e.getAttribute('aria-label') === word(locale, 'users.search')) as FakeElement;
const selectOf = (m: Mounted) => elements(m.container).find((e) => e.localName === 'select') as FakeElement;
const sectionsOf = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'h2' && classes(e).includes('ch-section-label')).map(flat);
const idFields = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'input' && classes(e).includes('ch-copy-field-input'));
/** The button whose whole text is `text`. */
const btn = (m: Mounted, text: string) => buttonsOf(m).find((b) => flat(b) === text) as FakeElement;
/** The text field in the open sheet. */
const sheetField = (m: Mounted) => inSheet(m, (e) => e.localName === 'input' || e.localName === 'textarea') as FakeElement;
/** The people's rows, by their index in PEOPLE_NAMES. */
const personRow = (m: Mounted, locale: Locale, index: number) => listRows(m).find((r) => flat(r).startsWith(PEOPLE_NAMES[locale][index])) as FakeElement;
/** From the Overview to a person's profile, through the people list. */
async function openPerson(o: ReturnType<typeof open>, locale: Locale, index: number) {
  await enter(o, locale, 'rows.users');
  o.m.click(personRow(o.m, locale, index));
  await settle();
}
/** After the request at `index`, the screen asked for the profile of `id` and for the list again. */
const reloadedAfter = (index: number, id: number) => {
  const later = calls.slice(index + 1).map((c) => `${c.method} ${c.url}`);
  return later.includes(`GET /api/admin/user-overrides?user_id=${id}`) && later.includes('GET /api/admin/user-overrides?list=all');
};
/** Nothing a request carries but its launch data is the viewer's Telegram id. */
const viewerIdSent = () => calls.some((c) => show({ ...c.body, initData: undefined }).includes(String(VIEWER_TELEGRAM_ID)) || c.url.includes(String(VIEWER_TELEGRAM_ID)));

/** The markup without the style sheets. */
const markupOf = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

const BRANDS = /Telegram|WhatsApp|Google|FamCal|Pro|Gemini|\bID\b/g;

/** Every .ts and .tsx file of the panel (app/[locale]/admin-panel), whole path. */
function panelFiles(dir = path.join(ROOT, 'app/[locale]/admin-panel')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? panelFiles(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
}

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
      assert(show(alertsIn(o.m.container)) === show([word('en', 'errors.switch')]) && logged() === 1 && adminLogs[0].startsWith('[admin] settings failed:'), `the error: ${show(alertsIn(o.m.container))}, logs ${show(adminLogs)}`);
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
      assert(checked(reminders()) === before && show(alertsIn(o.m.container)) === show([word('en', 'errors.switch')]) && logged() === 1, `a failed plain switch goes back: on ${checked(reminders())}, ${show(alertsIn(o.m.container))}`);
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
      assert(logged() === 1 && adminLogs[0].startsWith('[admin] reset-reminders failed:') && !confirmOf(o.m)?.hasAttribute('disabled'), `its log ${show(adminLogs)}, the button usable`);
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
    for (const source of panelFiles()) {
      const code = fs.readFileSync(source, 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      assert(!/useTelegramBackButton\(/.test(code), `${path.relative(ROOT, source)} calls useTelegramBackButton`);
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
      assert(logged() === 1 && adminLogs[0].startsWith('[admin] users/blocklist failed:') && !confirmOf(o.m)?.hasAttribute('disabled'), `its log ${show(adminLogs)}, the button usable`);
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

  // ---- Task 3: Users and a person's profile ----

  await check('U1 Users: a row per person (the name; the plan in a line, WhatsApp for someone who is only there; the tags Suspended, Early access and Overrides in their tones) and the count; the search by name (any case) and by Telegram id; each filter; a line for no match; the search and the filter as they were after a profile is opened and Back is tapped; a failed list says so with a retry', async () => {
    const planLines: Record<Locale, Record<number, string>> = {
      en: { [TRIAL]: 'Pro · trial, 9 days left', [FREE]: 'Free · expired', [PAID]: 'Basic · until', [COMPED]: 'Pro · free from an admin' },
      he: { [TRIAL]: 'Pro · תקופת ניסיון, נשארו 9 ימים', [FREE]: 'חינם · פג תוקף', [PAID]: 'בסיסי · עד', [COMPED]: 'Pro · במתנה מהניהול' },
      ru: { [TRIAL]: 'Pro · пробный период, осталось 9 дней', [FREE]: 'Бесплатный · срок истёк', [PAID]: 'Базовый · до', [COMPED]: 'Pro · бесплатно от администратора' },
    };
    const count6: Record<Locale, string> = { en: '6 people', he: '6 אנשים', ru: '6 человек' };
    const count0: Record<Locale, string> = { en: '0 people', he: '0 אנשים', ru: '0 человек' };
    const nameSearch: Record<Locale, string> = { en: 'NOA', he: 'נוע', ru: 'НОА' };
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      const w = (key: string, args?: Row) => word(locale, key, 'admin', args);
      const names = PEOPLE_NAMES[locale];
      const shown = () => listRows(o.m).map((r) => names.findIndex((n) => flat(r).startsWith(n)));
      try {
        calls.splice(0);
        await enter(o, locale, 'rows.users');
        assert(flat(title(o.m) as FakeElement) === w('users.title'), `${locale}: the header`);
        assert(requests('GET', 'user-overrides').length === 1 && requests('GET', 'user-overrides')[0].url === '/api/admin/user-overrides?list=all', `${locale}: ${show(urls())}`);
        assert(show(shown()) === show([0, 1, 2, 3, 4, 5]) && page(o.m).includes(count6[locale]), `${locale}: the rows ${show(shown())}, the count: ${page(o.m).slice(0, 200)}`);
        for (const [index, id] of [[0, TRIAL], [1, FREE], [2, PAID], [3, COMPED]] as const) assert(flat(personRow(o.m, locale, index)).includes(planLines[locale][id]), `${locale}: ${names[index]}: ${flat(personRow(o.m, locale, index))}`);
        assert(flat(personRow(o.m, locale, 4)).includes(w('users.whatsapp')) && !flat(personRow(o.m, locale, 0)).includes(w('users.whatsapp')), `${locale}: WhatsApp only for the person with no Telegram: ${flat(personRow(o.m, locale, 4))}`);
        const tagsOf = (row: FakeElement) => elements(row).filter((e) => classes(e).includes('ch-tag')).map((e) => `${classes(e).filter((c) => c.startsWith('ch-tag-')).join('')}:${flat(e)}`);
        assert(show(tagsOf(personRow(o.m, locale, 5))) === show([`ch-tag-danger:${w('users.suspended')}`]), `${locale}: Suspended: ${show(tagsOf(personRow(o.m, locale, 5)))}`);
        assert(show(tagsOf(personRow(o.m, locale, 2))) === show([`:${w('users.earlyAccess')}`, `ch-tag-muted:${w('users.overrides')}`]), `${locale}: early access and overrides: ${show(tagsOf(personRow(o.m, locale, 2)))}`);
        assert(tagsOf(personRow(o.m, locale, 0)).length === 0 && tagsOf(personRow(o.m, locale, 3)).length === 0, `${locale}: tags on people who have none`);
        // The search: a name in any case, a Telegram id (in part), nothing
        const type = (text: string) => o.m.input(searchBox(o.m, locale), text);
        type(nameSearch[locale]);
        assert(show(shown()) === show([0]), `${locale}: search by name: ${show(shown())}`);
        type('7000021');
        assert(show(shown()) === show([2]), `${locale}: search by Telegram id: ${show(shown())}`);
        type('zzzz');
        assert(show(shown()) === show([]) && page(o.m).includes(w('users.empty')) && !page(o.m).includes(count0[locale]), `${locale}: no match: ${page(o.m).slice(0, 200)}`);
        type('');
        // The filters
        const pick = (value: string) => o.m.change(selectOf(o.m), value);
        const wanted: Record<string, number[]> = { trial: [0], paid: [2, 3], free: [1, 4, 5], override: [2], all: [0, 1, 2, 3, 4, 5] };
        for (const [value, rows] of Object.entries(wanted)) {
          pick(value);
          assert(show(shown()) === show(rows), `${locale}: the ${value} filter: ${show(shown())}`);
        }
        assert(show(selectOf(o.m).options.map((x) => x.value)) === show(['all', 'trial', 'paid', 'free', 'override']) && flat(selectOf(o.m).options[4]) === w('users.filters.override'), `${locale}: the filter's options`);
        // Kept after a profile: a filter and a search, a tap on a row, Back
        pick('free');
        type('7000');
        assert(show(shown()) === show([1, 5]), `${locale}: filter and search: ${show(shown())}`);
        o.m.click(personRow(o.m, locale, 5));
        await settle();
        assert(flat(title(o.m) as FakeElement) === names[5], `${locale}: the profile's header ${flat(title(o.m) as FakeElement)}`);
        tapBack(o);
        await settle();
        assert(flat(title(o.m) as FakeElement) === w('users.title') && searchBox(o.m, locale).value === '7000' && selectOf(o.m).value === 'free' && show(shown()) === show([1, 5]), `${locale}: after Back: search ${searchBox(o.m, locale).value}, filter ${selectOf(o.m).value}, rows ${show(shown())}`);
      } finally {
        close(o);
      }
    }
    reset();
    const failing = open('en', propsOf('en'), { version: '7.7' });
    try {
      scenario.fail.add('GET user-overrides');
      await enter(failing, 'en', 'rows.users');
      assert(alertsIn(failing.m.container).length === 1 && alertsIn(failing.m.container)[0].startsWith(word('en', 'errors.load')) && listRows(failing.m).length === 0, 'a failed list');
      assert(adminLogs.some((l) => l.startsWith('[admin] user-overrides failed:')), `its log ${show(adminLogs)}`);
      scenario.fail.clear();
      failing.m.click(btn(failing.m, word('en', 'retry', 'pageGate')));
      await settle();
      assert(listRows(failing.m).length === 6 && alertsIn(failing.m.container).length === 0, 'the retry shows the people');
    } finally {
      close(failing);
    }
  });

  await check('U2 the profile in en, he and ru for a person on a trial, a paid one, one given Pro for free, one with WhatsApp only and a suspended one: the name as the header; the sections in order; ids left to right and copyable; a meter per limit (none for an unlimited one); what their plan includes is on and cannot be switched, with the note; the Reminders switch only with a Telegram id; the early access note; their own profile offers nothing that locks the viewer out; a profile that fails to load says so with a retry; no raw key, no emoji, no English in he and ru beyond the brands', async () => {
    const sectionKeys = ['profile.plan.title', 'profile.setup.title', 'profile.access.title', 'profile.messaging.title', 'activity.userTitle', 'profile.account.title'];
    for (const locale of LOCALES) {
      const w = (key: string, args?: Row) => word(locale, key, 'admin', args);
      for (const index of locale === 'en' ? [0, 2, 3, 4, 5] : [0, 5]) {
        reset();
        scenario.userActivityTotal = locale === 'en' ? 45 : 0;
        const id = IDS[index];
        const o = open(locale, propsOf(locale), { version: '7.7' });
        const where = `${locale} ${PEOPLE_NAMES[locale][index]}`;
        try {
          await openPerson(o, locale, index);
          const text = page(o.m);
          const person = scenario.people.get(id) as Row;
          assert(flat(title(o.m) as FakeElement) === PEOPLE_NAMES[locale][index], `${where}: the header`);
          assert(show(sectionsOf(o.m)) === show(sectionKeys.map((k) => w(k))), `${where}: sections ${show(sectionsOf(o.m))}`);
          assert(!/\badmin\.[a-zA-Z]|\bui\.[a-zA-Z]/.test(text) && !/\p{Extended_Pictographic}/u.test(text), `${where}: a raw key or an emoji`);
          if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(BRANDS, '')), `${where}: Latin letters in ${text.replace(BRANDS, '')}`);
          // Ids: left to right, copyable
          const fields = idFields(o.m);
          const wantIds = [person.telegramId === null ? null : String(person.telegramId), person.whatsappPhone].filter(Boolean);
          assert(show(fields.map((f) => f.value)) === show(wantIds) && fields.every((f) => f.getAttribute('dir') === 'ltr'), `${where}: ids ${show(fields.map((f) => f.value))} want ${show(wantIds)}`);
          assert(buttonsOf(o.m).filter((b) => b.getAttribute('aria-label') === w('profile.who.copy')).length === wantIds.length, `${where}: copy buttons`);
          assert(text.includes(person.telegramId === null ? w('profile.who.noTelegram') : w('profile.who.telegram')), `${where}: the Telegram row`);
          // The plan: its tag, a meter per limit
          const tagWant: Record<number, string> = { [TRIAL]: w('profile.plan.tagTrial'), [PAID]: w('profile.plan.tagPaid'), [COMPED]: w('profile.plan.tagComped') };
          const planTags = elements(o.m.container).filter((e) => e.localName === 'span' && e.className === 'ch-tag' && Object.values(tagWant).includes(flat(e))).map(flat);
          assert(show(planTags) === show(tagWant[id] ? [tagWant[id]] : []), `${where}: the plan tag ${show(planTags)}`);
          const limits = person.limits as Row;
          const limited = [limits.textSummaries, limits.voiceSummaries, limits.calendars].filter((n) => n !== null).length;
          assert(byRole(o.m.container, 'meter').length === limited, `${where}: ${byRole(o.m.container, 'meter').length} meters for ${limited} limits`);
          assert(elements(o.m.container).filter((e) => classes(e).includes('ch-meter-value') && flat(e) === w('profile.plan.unlimited')).length === 3 - limited, `${where}: Unlimited shows for an unlimited limit only`);
          // The switches: a plan's own features are locked, the Reminders switch is Telegram's
          const rows = switches(o.m);
          assert(rows.length === (person.telegramId === null ? 4 : 5), `${where}: ${rows.length} switches`);
          if (id === PAID) {
            const locked = rows.filter((r) => r.getAttribute('aria-disabled') === 'true');
            assert(locked.length === 2 && locked.every((r) => checked(r) && flat(r).includes(w('profile.access.locked'))), `${where}: locked ${locked.map(flat)}`);
            assert(checked(rows.find((r) => flat(r).startsWith(w('profile.access.earlyAccess')))) && rows.filter((r) => r.getAttribute('aria-disabled') !== 'true').length === 3, `${where}: the rest`);
          } else {
            assert(rows.every((r) => r.getAttribute('aria-disabled') === null && !checked(r)), `${where}: switches start off and free`);
          }
          // Plan actions, messaging, the account
          assert(!!btn(o.m, w('profile.comp.stop')) === (id === COMPED), `${where}: Stop free Pro`);
          // Free Pro can be given to everyone but a paid plan (a person on a trial included: the gift replaces the trial); the paid one is told why not
          assert(!!btn(o.m, w('profile.comp.give')) === (id !== PAID && id !== COMPED), `${where}: Give Pro for free`);
          assert(text.includes(w('profile.comp.blocked')) === (id === PAID), `${where}: the "nothing to give" hint`);
          assert(!!btn(o.m, w('profile.messaging.move')) === (person.whatsappPhone === null), `${where}: the Move to WhatsApp row`);
          assert(!!btn(o.m, w('profile.account.suspend')) === (id !== SUSPENDED) && !!btn(o.m, w('profile.account.unsuspend')) === (id === SUSPENDED), `${where}: suspend / unsuspend`);
          assert(elements(o.m.container).some((e) => classes(e).includes('ch-tag-danger') && flat(e) === w('users.suspended')) === (id === SUSPENDED), `${where}: the Suspended tag`);
          assert(buttonsOf(o.m).some((b) => classes(b).includes('ch-danger-row') && flat(b) === w('profile.account.delete')) && !!btn(o.m, w('profile.account.block')), `${where}: delete and block`);
          // Setup
          if (id === TRIAL) {
            assert(text.includes(w('profile.setup.sent', { sent: 2, total: 4 })) && text.includes(w('profile.setup.overdue', { count: 1 })), `${where}: the reminders ${text.slice(0, 300)}`);
            assert(elements(o.m.container).filter((e) => classes(e).includes('ch-admin-seg')).map((e) => classes(e).join(' ')).join('|') === 'ch-admin-seg is-sent|ch-admin-seg is-sent|ch-admin-seg is-due|ch-admin-seg', `${where}: the bar`);
            assert(!!btn(o.m, w('profile.setup.send')) && !!btn(o.m, w('profile.setup.reset')), `${where}: the setup actions`);
            assert([w('profile.setup.send'), w('profile.setup.reset'), w('profile.account.suspend'), w('profile.account.block')].every((text) => classes(btn(o.m, text)).includes('ch-action-row')) && classes(btn(o.m, w('profile.account.delete'))).includes('ch-danger-row'), `${where}: the action rows read as actions`);
          }
          if (id === PAID) {
            assert(elements(o.m.container).filter((e) => classes(e).includes('ch-admin-step')).length === 3 && !btn(o.m, w('profile.setup.send')) && text.includes(w('profile.setup.allDone')), `${where}: a set-up person with Google`);
          }
          if (locale === 'en') {
            assert(text.includes(w('common.showMore')) && dialogs(o.m).length === 0, `${where}: Show more under the activity`);
          }
        } finally {
          close(o);
        }
      }
    }
    // Early access on for everyone: a note says they have Pro anyway. Off: no note.
    for (const on of [true, false]) {
      reset();
      const o = open('en', propsOf('en', { flags: { ...FLAGS, earlyAdoptionMode: on } }), { version: '7.7' });
      try {
        await openPerson(o, 'en', 0);
        assert(page(o.m).includes(word('en', 'profile.plan.earlyOn')) === on, `early access ${on}: the note`);
      } finally {
        close(o);
      }
    }
    // The viewer's own profile (their Telegram id is the person's): nothing that locks them out, and it says why
    reset();
    const self = open('en', propsOf('en', { viewerTelegramId: 7000007 }), { version: '7.7' });
    try {
      await openPerson(self, 'en', 0);
      assert(page(self.m).includes(word('en', 'profile.self')) && !buttonsOf(self.m).some((b) => [word('en', 'profile.account.suspend'), word('en', 'profile.account.block'), word('en', 'profile.account.delete')].includes(flat(b))), `the viewer's own profile: ${page(self.m).slice(-300)}`);
    } finally {
      close(self);
    }
    // A profile that cannot be loaded says so, with a retry that loads it
    reset();
    const failing = open('en', propsOf('en'), { version: '7.7' });
    try {
      scenario.fail.add(`GET user-overrides?${TRIAL}`);
      await openPerson(failing, 'en', 0);
      assert(alertsIn(failing.m.container).length === 1 && alertsIn(failing.m.container)[0].startsWith(word('en', 'errors.load')) && sectionsOf(failing.m).length === 0 && flat(title(failing.m) as FakeElement) === word('en', 'profile.title'), `a failed profile: ${show(alertsIn(failing.m.container))}`);
      assert(adminLogs.some((l) => l.startsWith('[admin] user-overrides failed:')), 'its log');
      scenario.fail.clear();
      failing.m.click(btn(failing.m, word('en', 'retry', 'pageGate')));
      await settle();
      assert(flat(title(failing.m) as FakeElement) === PEOPLE_NAMES.en[0] && sectionsOf(failing.m).length === 6 && alertsIn(failing.m.container).length === 0, 'the retry loads the profile');
    } finally {
      close(failing);
    }
  });

  await check('U3 every action of a profile, in en: the risky ones ask first (a sheet that names the person), Cancel and Back send nothing, Confirm sends the exact body with the person\'s database id (never the viewer\'s Telegram id), a success reloads the profile and the list and says so, a failure shows our own message in the sheet (or under the button), logs once and reloads nothing; and every sheet opens in he and ru with the person\'s name', async () => {
    const w = (key: string, args?: Row) => word('en', key, 'admin', args);
    const names = PEOPLE_NAMES.en;
    // Open a profile with a clean record of requests
    const profileOf = async (index: number) => {
      reset();
      const o = open('en', propsOf('en'), { version: '7.7' });
      await openPerson(o, 'en', index);
      calls.splice(0);
      return o;
    };
    /** Open a sheet by its row, cancel it (nothing is sent), open it again. */
    const askAndCancel = (o: ReturnType<typeof open>, rowText: string, titleText: string) => {
      o.m.click(btn(o.m, rowText));
      assert(dialogs(o.m).length === 1 && dialogs(o.m)[0].getAttribute('aria-label') === titleText, `${rowText}: the sheet is ${dialogs(o.m)[0]?.getAttribute('aria-label')}, wanted ${titleText}`);
      o.m.click(cancelOf(o.m) as FakeElement);
      assert(dialogs(o.m).length === 0 && sent() === 0, `${rowText}: Cancel sent ${sent()}`);
      o.m.click(btn(o.m, rowText));
      tapBack(o);
      assert(dialogs(o.m).length === 0 && sent() === 0 && pushes.length === 0, `${rowText}: Back sent ${sent()} or left (${show(pushes)})`);
      o.m.click(btn(o.m, rowText));
    };
    const expectPost = (route: string, body: Row, label: string) => {
      const made = posts(route);
      assert(made.length === 1 && show(made[0].body) === show({ ...body, initData: INIT_DATA }), `${label}: ${made.length} request(s), ${show(made.map((c) => c.body))}`);
      return calls.indexOf(made[0]);
    };

    // Save the feature overrides: the button is on only for a change; the body is the person's, with null for a switch left off
    let o = await profileOf(0);
    try {
      const save = () => btn(o.m, w('profile.access.save'));
      assert(save().hasAttribute('disabled'), 'Save waits while nothing changed');
      o.m.click(switches(o.m).find((r) => flat(r).startsWith(w('profile.access.voiceEvents'))) as FakeElement);
      assert(!save().hasAttribute('disabled'), 'Save is on once a switch moved');
      o.m.input(elements(o.m.container).find((e) => e.localName === 'input' && e.getAttribute('aria-label') === w('profile.access.reason')) as FakeElement, 'beta');
      o.m.click(save());
      await settle();
      const at = expectPost('user-overrides', { user_id: TRIAL, unlimitedSummaries: null, remindersEnabled: null, voiceEventsEnabled: true, unlimitedCalendars: null, earlyAdopter: false, reason: 'beta' }, 'save');
      assert(reloadedAfter(at, TRIAL) && statusesIn(o.m.container).includes(w('profile.access.saved')) && save().hasAttribute('disabled'), `save: reloaded ${reloadedAfter(at, TRIAL)}, ${show(statusesIn(o.m.container))}`);
      assert(!viewerIdSent(), 'save: the viewer\'s Telegram id was sent');
      // A failure: said under the button, the draft kept, logged once, nothing reloaded
      calls.splice(0);
      adminLogs.length = 0;
      o.m.click(switches(o.m).find((r) => flat(r).startsWith(w('profile.access.unlimitedCalendars'))) as FakeElement);
      scenario.fail.add('POST user-overrides');
      o.m.click(save());
      await settle();
      assert(show(alertsIn(o.m.container)) === show([w('errors.generic')]) && sent() === 1 && logged() === 1 && !save().hasAttribute('disabled') && checked(switches(o.m).find((r) => flat(r).startsWith(w('profile.access.unlimitedCalendars')))), `a failed save: ${show(alertsIn(o.m.container))}, ${sent()} request(s), ${show(adminLogs)}`);
    } finally {
      close(o);
    }

    // Give Pro for free (a free person), then stop it
    o = await profileOf(1);
    try {
      assert(!!btn(o.m, w('profile.comp.give')) && !btn(o.m, w('profile.comp.stop')), 'a free person can be given Pro');
      askAndCancel(o, w('profile.comp.give'), w('profile.comp.giveTitle', { name: names[1] }));
      o.m.input(sheetField(o.m), 'pilot');
      scenario.answers.set('POST subscription', () => json({ error: 'User already has an active plan (PRO / ACTIVE)' }, 409));
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('errors.compGrant')]) && logged() === 1 && !calls.some((c) => c.url.includes('user-overrides')), `a refused give: ${show(alertsIn(o.m.container))}, ${show(adminLogs)}, ${show(urls())}`);
      scenario.answers.clear();
      calls.splice(0);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const at = expectPost('subscription', { user_id: FREE, reason: 'pilot' }, 'give');
      assert(dialogs(o.m).length === 0 && reloadedAfter(at, FREE) && show(statusesIn(o.m.container)).includes(w('profile.comp.given', { name: names[1] })) && !!btn(o.m, w('profile.comp.stop')) && !btn(o.m, w('profile.comp.give')), `give: ${show(statusesIn(o.m.container))}`);
      assert(!viewerIdSent(), 'give: the viewer\'s Telegram id was sent');
      // Stop it: asks, then DELETE with the id in the URL
      calls.splice(0);
      askAndCancel(o, w('profile.comp.stop'), w('profile.comp.stopTitle', { name: names[1] }));
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(calls[0].method === 'DELETE' && calls[0].url === `/api/admin/subscription?user_id=${FREE}` && calls[0].body === undefined && reloadedAfter(0, FREE), `stop: ${calls[0]?.method} ${calls[0]?.url}`);
      assert(show(statusesIn(o.m.container)).includes(w('profile.comp.stopped')) && !!btn(o.m, w('profile.comp.give')), `stopped: ${show(statusesIn(o.m.container))}`);
    } finally {
      close(o);
    }

    // Give Pro for free to a person on a trial (the gift replaces the trial): the Give row is there and the hint is not, giving reloads the
    // profile and shows Stop and the free-Pro tag in place of the trial's
    o = await profileOf(0);
    try {
      const planTags = () => elements(o.m.container).filter((e) => e.localName === 'span' && e.className === 'ch-tag' && [w('profile.plan.tagTrial'), w('profile.plan.tagComped')].includes(flat(e))).map(flat);
      assert(!!btn(o.m, w('profile.comp.give')) && !btn(o.m, w('profile.comp.stop')) && !page(o.m).includes(w('profile.comp.blocked')) && show(planTags()) === show([w('profile.plan.tagTrial')]), `a person on a trial can be given Pro: ${show(planTags())}`);
      askAndCancel(o, w('profile.comp.give'), w('profile.comp.giveTitle', { name: names[0] }));
      o.m.input(sheetField(o.m), 'pilot');
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const at = expectPost('subscription', { user_id: TRIAL, reason: 'pilot' }, 'give over a trial');
      assert(dialogs(o.m).length === 0 && reloadedAfter(at, TRIAL) && show(statusesIn(o.m.container)).includes(w('profile.comp.given', { name: names[0] })), `give over a trial: ${show(statusesIn(o.m.container))}`);
      assert(!!btn(o.m, w('profile.comp.stop')) && !btn(o.m, w('profile.comp.give')) && !page(o.m).includes(w('profile.comp.blocked')) && show(planTags()) === show([w('profile.plan.tagComped')]), `after the gift: ${show(planTags())}`);
    } finally {
      close(o);
    }

    // A paid plan, and a cancelled one that still runs, are told there is nothing to give (the route refuses them); a cancelled one past its end is not
    for (const [label, sub, blocked] of [
      ['a paid plan', SUBS.paid, true],
      ['a cancelled plan that still runs', { ...SUBS.paid, status: 'CANCELED', currentPeriodEnd: inDays(5) }, true],
      ['a cancelled plan past its end', { ...SUBS.paid, status: 'CANCELED', currentPeriodEnd: inDays(-5) }, false],
    ] as const) {
      reset();
      o = open('en', propsOf('en'), { version: '7.7' }); // (it makes the people afresh, so the plan is set after it)
      (scenario.people.get(PAID) as Row).subscription = sub;
      try {
        await openPerson(o, 'en', 2);
        assert(!!btn(o.m, w('profile.comp.give')) === !blocked && page(o.m).includes(w('profile.comp.blocked')) === blocked && !btn(o.m, w('profile.comp.stop')), `${label}: Give ${!!btn(o.m, w('profile.comp.give'))}, hint ${page(o.m).includes(w('profile.comp.blocked'))}`);
      } finally {
        close(o);
      }
    }

    // Send a setup reminder (it sends a real message): pick the reminder, name the person; a failure stays in the sheet
    o = await profileOf(1);
    try {
      askAndCancel(o, w('profile.setup.send'), w('profile.setup.sendTitle', { name: names[1] }));
      const options = elements(dialogs(o.m)[0]).filter((e) => e.getAttribute('role') === 'radio');
      assert(show(options.map((e) => e.getAttribute('data-value'))) === show(['calendars', 'location']) && checked(options[0]) && flat(options[1]) === w('profile.setup.types.location'), `the reminders (the steps still open; the server's own pick first): ${show(options.map((e) => `${e.getAttribute('data-value')}:${e.getAttribute('aria-checked')}`))}`);
      o.m.click(options[1]);
      scenario.fail.add('POST send-reminder');
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('errors.generic')]) && logged() === 1 && posts('send-reminder').length === 1, `a failed send: ${show(alertsIn(o.m.container))}`);
      scenario.fail.clear();
      calls.splice(0);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const at = expectPost('send-reminder', { user_id: FREE, reminder_type: 'location' }, 'send');
      assert(dialogs(o.m).length === 0 && reloadedAfter(at, FREE) && show(statusesIn(o.m.container)).includes(w('profile.setup.sentTo', { name: names[1] })), `send: ${show(statusesIn(o.m.container))}`);
      // Reset the person's reminders
      calls.splice(0);
      askAndCancel(o, w('profile.setup.reset'), w('profile.setup.resetTitle', { name: names[1] }));
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const reset1 = expectPost('reset-reminders', { user_id: FREE }, 'reset');
      assert(reloadedAfter(reset1, FREE) && show(statusesIn(o.m.container)).includes(w('profile.setup.resetDone')), `reset: ${show(statusesIn(o.m.container))}`);
      assert(!viewerIdSent(), 'send and reset: the viewer\'s Telegram id was sent');
    } finally {
      close(o);
    }

    // Move to WhatsApp: the number is required, trimmed, and the route's refusals are said in our words
    o = await profileOf(2);
    try {
      o.m.click(btn(o.m, w('profile.messaging.move')));
      assert(dialogs(o.m)[0].getAttribute('aria-label') === w('profile.messaging.moveTitle', { name: names[2] }) && (confirmOf(o.m) as FakeElement).hasAttribute('disabled'), 'the move sheet waits for a number');
      o.m.click(cancelOf(o.m) as FakeElement);
      assert(sent() === 0, 'Cancel sent something');
      o.m.click(btn(o.m, w('profile.messaging.move')));
      o.m.input(sheetField(o.m), '  +972501234567 ');
      assert(!(confirmOf(o.m) as FakeElement).hasAttribute('disabled'), 'a number turns the button on');
      for (const [status, text] of [[400, w('errors.invalidPhone')], [409, w('errors.phoneTaken')], [500, w('errors.generic')]] as const) {
        scenario.answers.set('POST switch-platform', () => json({ error: 'Phone +972501234567 is already used by user X' }, status));
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([text]), `${status}: ${show(alertsIn(o.m.container))}`);
      }
      assert(logged() === 3 && !calls.some((c) => c.method === 'GET'), `three refusals, three logs, no reload: ${adminLogs.length}`);
      scenario.answers.clear();
      calls.splice(0);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const at = expectPost('switch-platform', { user_id: PAID, whatsapp_phone: '+972501234567' }, 'move');
      assert(dialogs(o.m).length === 0 && reloadedAfter(at, PAID) && !btn(o.m, w('profile.messaging.move')) && show(statusesIn(o.m.container)).includes(w('profile.messaging.moved')), `move: ${show(statusesIn(o.m.container))}`);
      assert(idFields(o.m).some((f) => f.value === '+972501234567') && !viewerIdSent(), 'the number shows after the reload, and the viewer\'s id was not sent');
    } finally {
      close(o);
    }

    // Suspend (asks, with an optional reason), then unsuspend (at once)
    o = await profileOf(0);
    try {
      askAndCancel(o, w('profile.account.suspend'), w('profile.account.suspendTitle', { name: names[0] }));
      o.m.input(sheetField(o.m), 'spam');
      scenario.answers.set('POST users/moderation', () => json({ error: 'Admins cannot moderate their own account' }, 400));
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('errors.selfModerate')]) && logged() === 1, `a refused suspend: ${show(alertsIn(o.m.container))}`);
      scenario.answers.clear();
      calls.splice(0);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const at = expectPost('users/moderation', { action: 'suspend', user_id: TRIAL, reason: 'spam' }, 'suspend');
      assert(dialogs(o.m).length === 0 && reloadedAfter(at, TRIAL) && show(statusesIn(o.m.container)).includes(w('profile.account.suspended', { name: names[0] })), `suspend: ${show(statusesIn(o.m.container))}`);
      assert(!!btn(o.m, w('profile.account.unsuspend')) && !btn(o.m, w('profile.account.suspend')) && elements(o.m.container).some((e) => classes(e).includes('ch-tag-danger')), 'the profile shows the suspension');
      // Unsuspend: no sheet, one request, its outcome said; a failure says so too
      calls.splice(0);
      adminLogs.length = 0;
      scenario.fail.add('POST users/moderation');
      o.m.click(btn(o.m, w('profile.account.unsuspend')));
      await settle();
      assert(dialogs(o.m).length === 0 && posts('users/moderation').length === 1 && show(alertsIn(o.m.container)) === show([w('errors.generic')]) && logged() === 1 && !calls.some((c) => c.method === 'GET'), `a failed unsuspend: ${show(alertsIn(o.m.container))}`);
      scenario.fail.clear();
      calls.splice(0);
      o.m.click(btn(o.m, w('profile.account.unsuspend')));
      await settle();
      const back = expectPost('users/moderation', { action: 'unsuspend', user_id: TRIAL, reason: null }, 'unsuspend');
      assert(reloadedAfter(back, TRIAL) && show(statusesIn(o.m.container)).includes(w('profile.account.unsuspended', { name: names[0] })) && !!btn(o.m, w('profile.account.suspend')), `unsuspend: ${show(statusesIn(o.m.container))}`);
      assert(!viewerIdSent(), 'suspend: the viewer\'s Telegram id was sent');
    } finally {
      close(o);
    }

    // Block their Telegram and WhatsApp: a switch for each, a reason, never an empty ban; SELF_BAN is said in our words
    o = await profileOf(0);
    try {
      askAndCancel(o, w('profile.account.block'), w('profile.account.blockTitle', { name: names[0] }));
      const toggles = () => elements(dialogs(o.m)[0]).filter((e) => e.getAttribute('role') === 'switch');
      assert(toggles().length === 2 && toggles().every(checked) && flat(toggles()[0]).includes('7000007') && flat(toggles()[1]).includes('+972501230007'), `the block sheet: ${toggles().map(flat)}`);
      o.m.click(toggles()[0]);
      o.m.click(toggles()[1]);
      assert((confirmOf(o.m) as FakeElement).hasAttribute('disabled'), 'with nothing to block the button waits');
      o.m.click(toggles()[1]);
      o.m.input(sheetField(o.m), 'abuse');
      scenario.answers.set('POST users/blocklist', () => json({ error: 'SELF_BAN' }, 400));
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('errors.selfBan')]), `SELF_BAN: ${show(alertsIn(o.m.container))}`);
      scenario.answers.clear();
      calls.splice(0);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const at = expectPost('users/blocklist', { action: 'ban', telegramId: null, whatsappPhone: '+972501230007', reason: 'abuse' }, 'block');
      assert(dialogs(o.m).length === 0 && reloadedAfter(at, TRIAL) && show(statusesIn(o.m.container)).includes(w('profile.account.blockedDone')), `block: ${show(statusesIn(o.m.container))}`);
    } finally {
      close(o);
    }

    // Every sheet opens in each language with the person's name
    const sheets: [number, string, string][] = [
      [0, 'profile.setup.send', 'profile.setup.sendTitle'],
      [0, 'profile.setup.reset', 'profile.setup.resetTitle'],
      [0, 'profile.account.suspend', 'profile.account.suspendTitle'],
      [0, 'profile.account.block', 'profile.account.blockTitle'],
      [0, 'profile.account.delete', 'profile.account.deleteTitle'],
      [1, 'profile.comp.give', 'profile.comp.giveTitle'],
      [3, 'profile.comp.stop', 'profile.comp.stopTitle'],
      [2, 'profile.messaging.move', 'profile.messaging.moveTitle'],
    ];
    for (const locale of ['he', 'ru'] as const) {
      for (const [index, row, titleKey] of sheets) {
        reset();
        scenario.userActivityTotal = 0;
        const sheetOpened = open(locale, propsOf(locale), { version: '7.7' });
        try {
          await openPerson(sheetOpened, locale, index);
          sheetOpened.m.click(btn(sheetOpened.m, word(locale, row)));
          const dialog = dialogs(sheetOpened.m)[0];
          const name = PEOPLE_NAMES[locale][index];
          assert(dialog && dialog.getAttribute('aria-label') === word(locale, titleKey, 'admin', { name }) && flat(dialog).includes(name) && flat(cancelOf(sheetOpened.m) as FakeElement) === word(locale, 'cancel', 'ui'), `${locale} ${row}: ${dialog && flat(dialog)}`);
          assert(!/[A-Za-z]/.test(flat(dialog).replace(BRANDS, '').replace('DELETE', '').replace(/\+972501230\d{3}/, '')), `${locale} ${row}: Latin letters in ${flat(dialog)}`);
        } finally {
          close(sheetOpened);
        }
      }
    }
  });

  await check('U4 deleting a person: the sheet names them, and the button waits until DELETE is typed exactly (Latin in every language); while it works Back, Escape, the scrim and Cancel do nothing and a second tap sends nothing; the request is { action: "hard_delete", user_id, reason: null, confirmation: "DELETE" } with the person\'s id; a failure stays in the sheet; success goes to the people list, which says whose account was deleted, once, without the person, and the profile is not asked for again; opening another person and coming back shows no old notice', async () => {
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      const w = (key: string, args?: Row) => word(locale, key, 'admin', args);
      const names = PEOPLE_NAMES[locale];
      try {
        await openPerson(o, locale, 0);
        calls.splice(0);
        o.m.click(buttonsOf(o.m).find((b) => classes(b).includes('ch-danger-row') && flat(b) === w('profile.account.delete')) as FakeElement);
        const sheet = dialogs(o.m)[0];
        assert(sheet.getAttribute('aria-label') === w('profile.account.deleteTitle', { name: names[0] }) && flat(sheet).includes(w('profile.account.deleteBody')) && flat(sheet).includes(w('profile.account.deleteType')), `${locale}: the sheet ${flat(sheet)}`);
        const field = sheetField(o.m);
        assert(field.getAttribute('placeholder') === 'DELETE' && field.getAttribute('dir') === 'auto', `${locale}: the field ${field.getAttribute('placeholder')}`);
        assert(classes(confirmOf(o.m) as FakeElement).includes('ch-btn-danger') && flat(confirmOf(o.m) as FakeElement) === w('profile.account.deleteConfirm'), `${locale}: the red button`);
        for (const typed of ['', 'delete', 'DELET', 'DELETE ', 'DELETED']) {
          o.m.input(field, typed);
          o.m.click(confirmOf(o.m) as FakeElement);
          assert((confirmOf(o.m) as FakeElement).hasAttribute('disabled') && sent() === 0, `${locale}: "${typed}" turned the delete on (${sent()} request(s))`);
        }
        if (locale !== 'en') continue;
        // The exact word: the button works; while the request runs nothing closes the sheet
        o.m.input(field, 'DELETE');
        assert(!(confirmOf(o.m) as FakeElement).hasAttribute('disabled'), 'DELETE turns the button on');
        let release: (r: Response) => void = () => undefined;
        scenario.hold.set('POST users/moderation', () => undefined);
        o.m.click(confirmOf(o.m) as FakeElement);
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        release = scenario.hold.get('POST users/moderation') as (r: Response) => void;
        assert(posts('users/moderation').length === 1, `${posts('users/moderation').length} request(s) for two taps`);
        const working = confirmOf(o.m) as FakeElement;
        assert(working.hasAttribute('disabled') && working.getAttribute('aria-busy') === 'true' && (cancelOf(o.m) as FakeElement).hasAttribute('disabled'), 'the working sheet');
        tapBack(o);
        o.m.key(dialogs(o.m)[0], 'Escape');
        o.m.click(elements(o.m.container).find((e) => e.className === 'ch-sheet-backdrop') as FakeElement);
        o.m.click(cancelOf(o.m) as FakeElement);
        assert(dialogs(o.m).length === 1 && flat(title(o.m) as FakeElement) === names[0] && pushes.length === 0, `the sheet or the profile closed while it works: ${dialogs(o.m).length} dialog(s), ${flat(title(o.m) as FakeElement)}`);
        // A failure: the sheet stays, says so, and the person is still there
        scenario.hold.clear();
        await act(async () => {
          release(json({ error: 'Failed to moderate user' }, 500));
          await new Promise((r) => setTimeout(r, 0));
        });
        assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('errors.generic')]) && scenario.people.has(TRIAL) && !(confirmOf(o.m) as FakeElement).hasAttribute('disabled'), `a failed delete: ${show(alertsIn(o.m.container))}`);
        // Success
        calls.splice(0);
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        const at = calls.findIndex((c) => c.method === 'POST' && c.url === '/api/admin/users/moderation');
        assert(show(calls[at].body) === show({ action: 'hard_delete', user_id: TRIAL, reason: null, confirmation: 'DELETE', initData: INIT_DATA }), `the request: ${show(calls[at]?.body)}`);
        assert(!calls.slice(at + 1).some((c) => c.url === `/api/admin/user-overrides?user_id=${TRIAL}`) && calls.slice(at + 1).some((c) => c.url === '/api/admin/user-overrides?list=all'), `after the delete: ${show(urls().slice(at + 1))}`);
        assert(!viewerIdSent(), 'the viewer\'s Telegram id was sent');
        // The people list says whose account it was, once
        assert(flat(title(o.m) as FakeElement) === w('users.title') && dialogs(o.m).length === 0, `back on ${flat(title(o.m) as FakeElement)}`);
        assert(show(statusesIn(o.m.container)) === show([w('users.deleted', { name: names[0] })]) && listRows(o.m).length === 5 && !listRows(o.m).some((r) => flat(r).startsWith(names[0])), `the list: ${show(statusesIn(o.m.container))}, ${listRows(o.m).length} rows`);
        // Another person: no old notice there; and none when the list comes back
        o.m.click(personRow(o.m, locale, 1));
        await settle();
        assert(!page(o.m).includes(w('users.deleted', { name: names[0] })) && statusesIn(o.m.container).every((s) => !s.includes(names[0])), 'the old notice is on another person\'s profile');
        tapBack(o);
        await settle();
        assert(flat(title(o.m) as FakeElement) === w('users.title') && statusesIn(o.m.container).length === 0, `the old notice came back: ${show(statusesIn(o.m.container))}`);
      } finally {
        close(o);
      }
    }
    // The notice is said once also when the list is left another way: back to the Overview and in again
    reset();
    const again = open('en', propsOf('en'), { version: '7.7' });
    try {
      await openPerson(again, 'en', 5);
      again.m.click(buttonsOf(again.m).find((b) => classes(b).includes('ch-danger-row') && flat(b) === word('en', 'profile.account.delete')) as FakeElement);
      again.m.input(sheetField(again.m), 'DELETE');
      again.m.click(confirmOf(again.m) as FakeElement);
      await settle();
      assert(statusesIn(again.m.container).length === 1, 'the notice after the delete');
      tapBack(again);
      await enter(again, 'en', 'rows.users');
      assert(statusesIn(again.m.container).length === 0, `the notice came back: ${show(statusesIn(again.m.container))}`);
    } finally {
      close(again);
    }
  });

  await check('U5 a long profile: Show more three times still ends on the Account section (its rows are in the markup after the last activity row), and nothing of the panel clips a height', async () => {
    reset();
    scenario.userActivityTotal = 100;
    const o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await openPerson(o, 'en', 0);
      const rows = () => elements(o.m.container).filter((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'ltr' && /^(?:login|settings_changed)$/.test(flat(e)));
      assert(rows().length === 20, `${rows().length} activity rows to start with`);
      calls.splice(0);
      for (let i = 0; i < 3; i++) {
        o.m.click(btn(o.m, word('en', 'common.showMore')));
        await settle();
      }
      assert(rows().length === 80 && requests('GET', 'user-activity').length === 3 && requests('GET', 'user-activity').map((c) => c.url).join('|') === [20, 40, 60].map((n) => `/api/admin/user-activity?user_id=${TRIAL}&limit=20&offset=${n}`).join('|'), `${rows().length} rows after three: ${show(urls())}`);
      const all = elements(o.m.container);
      const lastRow = all.indexOf(rows()[rows().length - 1]);
      const accountLabel = all.findIndex((e) => e.localName === 'h2' && flat(e) === word('en', 'profile.account.title'));
      const deleteRow = all.findIndex((e) => e.localName === 'button' && classes(e).includes('ch-danger-row') && flat(e) === word('en', 'profile.account.delete'));
      assert(lastRow > -1 && accountLabel > lastRow && deleteRow > accountLabel, `the Account section is after the activity: ${lastRow} < ${accountLabel} < ${deleteRow}`);
      assert(!/max-(?:height|block-size)/.test(`${ADMIN_CSS}\n${FORM_CSS}`), 'a rule clips a height');
    } finally {
      close(o);
    }
  });

  await check('U6 two quick taps on different people never show one under the other\'s name: A is opened and its profile is slow, Back, B is opened and shows, then A\'s answer comes in late and shows nowhere (no name, no id); and the profile screen on its own, given another person while the first is on its way, keeps the first answer off the second', async () => {
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    const names = PEOPLE_NAMES.en;
    try {
      await enter(o, 'en', 'rows.users');
      scenario.hold.set(`GET user-overrides?${TRIAL}`, () => undefined);
      o.m.click(personRow(o.m, 'en', 0));
      await settle();
      const release = scenario.hold.get(`GET user-overrides?${TRIAL}`) as (r: Response) => void;
      assert(flat(title(o.m) as FakeElement) === word('en', 'profile.title') && sectionsOf(o.m).length === 0, 'A is still on its way: the screen waits');
      tapBack(o);
      await settle();
      o.m.click(personRow(o.m, 'en', 1));
      await settle();
      assert(flat(title(o.m) as FakeElement) === names[1] && sectionsOf(o.m).length === 6, `B shows: ${flat(title(o.m) as FakeElement)}`);
      await act(async () => {
        release(ok({ user: scenario.people.get(TRIAL) }));
        await new Promise((r) => setTimeout(r, 0));
      });
      await settle();
      const text = page(o.m);
      assert(flat(title(o.m) as FakeElement) === names[1] && !text.includes(names[0]) && !text.includes(String(7000000 + TRIAL)) && idFields(o.m).every((f) => f.value !== String(7000000 + TRIAL)), `A's late answer showed: ${flat(title(o.m) as FakeElement)}, ${text.slice(0, 200)}`);
      assert(elements(o.m.container).some((e) => classes(e).includes('ch-copy-field-input') && e.value === String(7000000 + FREE)), 'B\'s own id shows');
    } finally {
      close(o);
    }
    // The screen on its own, given another person while the first one is still on its way: it is the same screen, so only its own guard
    // (the shell never does this, since it opens a new screen for each person) keeps the first answer from landing on the second
    reset();
    installWindow();
    fakeWindow.Telegram = { WebApp: { initData: INIT_DATA } };
    scenario.locale = 'en';
    scenario.people = makePeople('en');
    const profileTree = (id: number) => tree('en', createElement(UserProfile, { targetUserId: id, viewerTelegramId: VIEWER_TELEGRAM_ID, earlyAccessOn: false, onUsersChanged: () => undefined, onBack: () => undefined, onDeleted: () => undefined }));
    scenario.hold.set(`GET user-overrides?${TRIAL}`, () => undefined);
    const m = mount(profileTree(TRIAL));
    try {
      await settle();
      const late = scenario.hold.get(`GET user-overrides?${TRIAL}`) as (r: Response) => void;
      m.render(profileTree(FREE));
      await settle();
      assert(flat(title(m) as FakeElement) === names[1], `the second person shows: ${flat(title(m) as FakeElement)}`);
      await act(async () => {
        late(ok({ user: scenario.people.get(TRIAL) }));
        await new Promise((r) => setTimeout(r, 0));
      });
      await settle();
      assert(flat(title(m) as FakeElement) === names[1] && !page(m).includes(names[0]) && idFields(m).every((f) => f.value !== String(7000000 + TRIAL)), `the first answer landed on the second person: ${flat(title(m) as FakeElement)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('U7 the panel is made of the kit: no styled-jsx, no :hover, no hex colour, no physical CSS property, no emoji and no Tailwind class in any file of app/[locale]/admin-panel; the old body, its dead messages and the old panel\'s strings are gone; every admin message is read by the panel; none that the panel reads is missing', () => {
    const dir = path.join(ROOT, 'app/[locale]/admin-panel');
    const files = panelFiles();
    const code = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    const problems: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const source = code(file);
      if (/<style jsx|styled-jsx/.test(source)) problems.push(`${rel}: styled-jsx`);
      if (/:hover/.test(source)) problems.push(`${rel}: :hover`);
      if (/#[0-9a-fA-F]{3,8}\b/.test(source)) problems.push(`${rel}: a hex colour`);
      if (/(?:margin|padding|border)-(?:left|right)|(?:margin|padding)(?:Left|Right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|textAlign:\s*['"](?:left|right)/.test(source)) problems.push(`${rel}: a physical property`);
      if (/\p{Extended_Pictographic}/u.test(fs.readFileSync(file, 'utf8'))) problems.push(`${rel}: an emoji`);
      if (/className="[^"]*\b(?:bg-|text-(?:gray|rose|blue|xs|sm|lg|xl)|rounded|px-\d|py-\d|min-h-screen|flex-1|shadow|mt-\d|mb-\d|p-\d|gap-\d|max-w)/.test(source)) problems.push(`${rel}: a Tailwind class`);
      if (/style=\{\{/.test(source) && !/inlineSize/.test(source)) problems.push(`${rel}: an inline style`);
    }
    assert(problems.length === 0, problems.join('; '));
    const client = fs.readFileSync(path.join(dir, 'AdminPanelClient.tsx'), 'utf8');
    assert(client.split('\n').length < 150 && !/LegacyAdminPanel|AdminCard|Lock size|#667eea|linear-gradient/.test(client), 'the old panel body or its cards are still in AdminPanelClient.tsx');
    // The messages: a leaf key is read when its dotted path is written out in the panel's code; and each message the code names exists
    const sources = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const leaves = (node: Row, prefix = ''): string[] => Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? leaves(v as Row, `${prefix}${k}.`) : [`${prefix}${k}`]));
    for (const locale of LOCALES) {
      const unread = leaves(messages[locale].admin).filter((key) => !sources.includes(`'${key}'`) && !sources.includes(`"${key}"`) && !sources.includes(`\`${key}\``));
      assert(unread.length === 0, `${locale}: messages the panel never reads: ${unread.slice(0, 12).join(', ')}${unread.length > 12 ? ` (+${unread.length - 12})` : ''}`);
    }
    const dead = ['badge', 'testing', 'statistics', 'health', 'overrides', 'comp', 'openDashboard'];
    for (const locale of LOCALES) {
      const present = dead.filter((key) => key in messages[locale].admin);
      assert(present.length === 0, `${locale}: dead message groups: ${present.join(', ')}`);
      for (const [group, keys] of Object.entries({ activity: ['filterByAction', 'loading', 'loadMore', 'filterByUser', 'ago', 'justNow', 'minutes', 'hours', 'days'], feedback: ['loading', 'user', 'preview', 'source', 'time'], features: ['title'] })) {
        const left = keys.filter((key) => key in (messages[locale].admin[group] ?? {}));
        assert(left.length === 0, `${locale}: dead admin.${group} keys: ${left.join(', ')}`);
      }
      // The messages the smokes and the bot pin stay
      assert(typeof messages[locale].admin.features.nativeReminders === 'string' && typeof messages[locale].admin.features.nativeRemindersDescription === 'string', `${locale}: the native reminders messages`);
    }
    // Every message name the panel writes out resolves in every language
    const names = [...sources.matchAll(/\bt\(\s*['"`]([\w.]+)['"`]/g)].map((m) => m[1]);
    const lookups = [...sources.matchAll(/(?:label|hint|title|body):\s*'([a-zA-Z.]+)'/g)].map((m) => m[1]);
    for (const locale of LOCALES) {
      const missing = [...new Set([...names, ...lookups])].filter((key) => key.includes('.') && /^(?:users|profile|rows|counts|sections|features|earlyAccess|reset|errors|common|activity|feedback|blocked|plan|planLine|unauthorized)\./.test(key)).filter((key) => key.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale].admin) === undefined);
      assert(missing.length === 0, `${locale}: messages the panel reads that do not exist: ${missing.join(', ')}`);
    }
  });

  // ---- The fix round: a delete that waits, saving away the last override, notices beside their action, RTL rows, due setup reminders, scroll, a plan that won't renew ----

  await check('U8 deleting waits for the people list and lands on Users with its notice: while the list reloads the profile and its working sheet are still there and Back, Escape, the scrim and Cancel do nothing; then the stack is the Overview and Users (one Back goes to the Overview, not two), with "{name} was deleted" once; the same from a profile opened from the activity log', async () => {
    const LIST = 'GET user-overrides?list=all';
    const names = PEOPLE_NAMES.en;
    const w = (key: string, args?: Row) => word('en', key, 'admin', args);
    const releaseList = async () => {
      const resolve = scenario.hold.get(LIST) as (r: Response) => void;
      scenario.hold.delete(LIST);
      await act(async () => {
        resolve(ok({ users: [...scenario.people.values()].map(listOf) }));
        await new Promise((r) => setTimeout(r, 0));
      });
      await settle();
    };
    const deleteFromProfile = async (o: ReturnType<typeof open>) => {
      o.m.click(buttonsOf(o.m).find((b) => classes(b).includes('ch-danger-row') && flat(b) === w('profile.account.delete')) as FakeElement);
      o.m.input(sheetField(o.m), 'DELETE');
    };

    // Back and the rest, while the list is on its way
    reset();
    let o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await openPerson(o, 'en', 0);
      await deleteFromProfile(o);
      scenario.hold.set(LIST, () => undefined);
      calls.splice(0);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(posts('users/moderation').length === 1 && requests('GET', 'user-overrides').some((c) => c.url === '/api/admin/user-overrides?list=all'), `the delete went and the list was asked for: ${show(urls())}`);
      const working = confirmOf(o.m) as FakeElement;
      assert(dialogs(o.m).length === 1 && working.hasAttribute('disabled') && working.getAttribute('aria-busy') === 'true' && flat(title(o.m) as FakeElement) === names[0] && sectionsOf(o.m).length === 6, `while the list reloads the profile and the sheet are there: ${dialogs(o.m).length} dialog(s), ${flat(title(o.m) as FakeElement)}, ${sectionsOf(o.m).length} sections`);
      tapBack(o);
      o.m.key(dialogs(o.m)[0], 'Escape');
      o.m.click(elements(o.m.container).find((e) => e.className === 'ch-sheet-backdrop') as FakeElement);
      o.m.click(cancelOf(o.m) as FakeElement);
      await settle();
      assert(dialogs(o.m).length === 1 && flat(title(o.m) as FakeElement) === names[0] && pushes.length === 0, `Back, Escape, the scrim or Cancel acted while the list reloads: ${dialogs(o.m).length} dialog(s), ${flat(title(o.m) as FakeElement)}, pushes ${show(pushes)}`);
      await releaseList();
      assert(flat(title(o.m) as FakeElement) === w('users.title') && dialogs(o.m).length === 0 && show(statusesIn(o.m.container)) === show([w('users.deleted', { name: names[0] })]) && listRows(o.m).length === 5, `after the list answered: ${flat(title(o.m) as FakeElement)}, ${show(statusesIn(o.m.container))}, ${listRows(o.m).length} rows`);
      // One Back from Users is the Overview (the stack is [Overview, Users]), and the notice does not follow
      tapBack(o);
      await settle();
      assert(flat(title(o.m) as FakeElement) === w('title') && pushes.length === 0, `one Back from Users: ${flat(title(o.m) as FakeElement)}`);
    } finally {
      close(o);
    }

    // A profile opened from the activity log: after the delete it is the people list, with the notice, and Back is the Overview
    reset();
    o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await enter(o, 'en', 'rows.activity');
      o.m.click(listRows(o.m)[0]);
      await settle();
      assert(flat(title(o.m) as FakeElement) === names[0], `the profile from the log: ${flat(title(o.m) as FakeElement)}`);
      await deleteFromProfile(o);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(flat(title(o.m) as FakeElement) === w('users.title') && show(statusesIn(o.m.container)) === show([w('users.deleted', { name: names[0] })]) && listRows(o.m).length === 5, `from the log: ${flat(title(o.m) as FakeElement)}, ${show(statusesIn(o.m.container))}`);
      tapBack(o);
      await settle();
      assert(flat(title(o.m) as FakeElement) === w('title'), `Back from Users after a delete that began in the log: ${flat(title(o.m) as FakeElement)}`);
    } finally {
      close(o);
    }
  });

  await check('U9 saving away the last override settles: the route deletes the override and its reason, so after the reload the draft is rebuilt from the profile: Save goes off, says Saved, the reason field is empty, and another tap sends nothing; a reason typed with no switch on (which the route also drops) settles the same way', async () => {
    const w = (key: string, args?: Row) => word('en', key, 'admin', args);
    const reasonField = (m: Mounted) => elements(m.container).find((e) => e.localName === 'input' && e.getAttribute('aria-label') === w('profile.access.reason')) as FakeElement;
    reset();
    let o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await openPerson(o, 'en', 2); // a paid person with early access and the reason "early tester"
      const save = () => btn(o.m, w('profile.access.save'));
      const early = () => switches(o.m).find((r) => flat(r).startsWith(w('profile.access.earlyAccess'))) as FakeElement;
      assert(checked(early()) && reasonField(o.m).value === 'early tester' && save().hasAttribute('disabled'), 'it starts saved');
      calls.splice(0);
      o.m.click(early());
      assert(!save().hasAttribute('disabled'), 'switching off the last override turns Save on');
      o.m.click(save());
      await settle();
      assert(posts('user-overrides').length === 1 && show(posts('user-overrides')[0].body) === show({ user_id: PAID, unlimitedSummaries: null, remindersEnabled: null, voiceEventsEnabled: null, unlimitedCalendars: null, earlyAdopter: false, reason: 'early tester', initData: INIT_DATA }), `the save: ${show(posts('user-overrides').map((c) => c.body))}`);
      assert(scenario.people.get(PAID)?.override === null, 'the route kept no override');
      assert(save().hasAttribute('disabled') && statusesIn(o.m.container).includes(w('profile.access.saved')) && !checked(early()) && reasonField(o.m).value === '', `after the save: Save disabled ${save().hasAttribute('disabled')}, ${show(statusesIn(o.m.container))}, early ${checked(early())}, reason "${reasonField(o.m).value}"`);
      o.m.click(save());
      await settle();
      assert(posts('user-overrides').length === 1, `another tap posted again: ${posts('user-overrides').length}`);
    } finally {
      close(o);
    }
    // A reason and no switch: the route has nothing to keep
    reset();
    o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await openPerson(o, 'en', 1);
      const save = () => btn(o.m, w('profile.access.save'));
      o.m.input(reasonField(o.m), 'just a note');
      assert(!save().hasAttribute('disabled'), 'a reason alone turns Save on');
      calls.splice(0);
      o.m.click(save());
      await settle();
      assert(posts('user-overrides').length === 1 && save().hasAttribute('disabled') && statusesIn(o.m.container).includes(w('profile.access.saved')) && reasonField(o.m).value === '', `a reason alone: ${posts('user-overrides').length} post(s), Save disabled ${save().hasAttribute('disabled')}, "${reasonField(o.m).value}"`);
      o.m.click(save());
      await settle();
      assert(posts('user-overrides').length === 1, 'another tap posted again');
    } finally {
      close(o);
    }
    // A reload that fails after a good save leaves the draft alone (nothing to rebuild it from)
    reset();
    o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await openPerson(o, 'en', 0);
      const save = () => btn(o.m, w('profile.access.save'));
      o.m.click(switches(o.m).find((r) => flat(r).startsWith(w('profile.access.voiceEvents'))) as FakeElement);
      scenario.fail.add(`GET user-overrides?${TRIAL}`);
      o.m.click(save());
      await settle();
      assert(checked(switches(o.m).find((r) => flat(r).startsWith(w('profile.access.voiceEvents')))) && posts('user-overrides').length === 1, 'the draft stays when the profile could not be reloaded');
    } finally {
      close(o);
    }
  });

  await check('U10 a result or a failure of the Overview is said under the card of its action, not at the top of the page: a failed switch under the switches (before the setup reminders), the reset result under the reset row (the last thing on the page)', async () => {
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    const w = (key: string, args?: Row) => word('en', key, 'admin', args);
    try {
      const all = () => elements(o.m.container);
      scenario.fail.add('POST settings');
      o.m.click(switchOf(o.m, 'en', 'voiceTtsOutcome') as FakeElement);
      await settle();
      const lastSwitch = all().lastIndexOf(switches(o.m)[4]);
      const alert = all().findIndex((e) => e.getAttribute('role') === 'alert');
      const remindersLabel = all().findIndex((e) => e.localName === 'h2' && flat(e) === w('sections.reminders'));
      assert(alert > lastSwitch && alert < remindersLabel && show(alertsIn(o.m.container)) === show([w('errors.switch')]), `the failed switch's notice: switch ${lastSwitch}, alert ${alert}, reminders ${remindersLabel}`);
      scenario.fail.clear();
      const resetRow = () => all().findIndex((e) => e.localName === 'button' && classes(e).includes('ch-danger-row') && flat(e) === w('reset.row'));
      o.m.click(all()[resetRow()]);
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      const status = all().findIndex((e) => e.getAttribute('role') === 'status' && flat(e) === '4 people reset');
      assert(status > resetRow() && !all().slice(status).some((e) => e.localName === 'h2' || classes(e).includes('ch-form-card')), `the reset result: row ${resetRow()}, notice ${status}`);
    } finally {
      close(o);
    }
  });

  await check('U11 in Hebrew the rows of the profile\'s activity, the activity log, the feedback and the blocked start on the page\'s start side: a line is a plain block that reads in the page\'s direction, the action code and an id sit in a <bdi dir="ltr">, free text in a <bdi dir="auto">, and no flex item of a row carries a dir of its own (which would align it by its own text); a name keeps dir="auto"', async () => {
    const lineProblems = (row: FakeElement, where: string): string[] => {
      const problems: string[] = [];
      for (const label of elements(row).filter((e) => classes(e).includes('ch-form-label'))) {
        for (const child of label.childNodes.filter((n): n is FakeElement => n instanceof FakeElement)) {
          if (child.getAttribute('dir') !== null && !classes(child).includes('ch-list-title')) problems.push(`${where}: a flex item with dir="${child.getAttribute('dir')}": ${flat(child)}`);
        }
      }
      return problems;
    };
    reset();
    const o = open('he', propsOf('he'), { version: '7.7' });
    const problems: string[] = [];
    try {
      // The profile's activity
      await openPerson(o, 'he', 0);
      const rows = elements(o.m.container).filter((e) => classes(e).includes('ch-form-row') && elements(e).some((x) => x.localName === 'bdi' && /^(?:login|settings_changed)$/.test(flat(x))));
      assert(rows.length === 20, `${rows.length} activity rows`);
      for (const row of rows) {
        problems.push(...lineProblems(row, 'profile activity'));
        const label = elements(row).find((e) => classes(e).includes('ch-form-label')) as FakeElement;
        const lines = label.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
        const action = elements(lines[0]).find((e) => e.localName === 'bdi');
        if (!action || action.getAttribute('dir') !== 'ltr' || !classes(lines[0]).includes('ch-admin-line')) problems.push(`profile activity: the action is not a <bdi dir="ltr"> in a block line: ${flat(lines[0])}`);
        if (lines[1] && elements(lines[1]).find((e) => e.localName === 'bdi')?.getAttribute('dir') !== 'auto') problems.push(`profile activity: the detail is not a <bdi dir="auto">: ${flat(lines[1])}`);
      }
      tapBack(o);
      await settle();
      tapBack(o);
      await settle();
      // The log, the feedback, the blocked
      await enter(o, 'he', 'rows.activity');
      for (const row of listRows(o.m)) problems.push(...lineProblems(row, 'activity log'));
      assert(elements(listRows(o.m)[0]).some((e) => classes(e).includes('ch-list-title') && e.getAttribute('dir') === 'auto'), 'a name keeps dir="auto"');
      tapBack(o);
      await enter(o, 'he', 'rows.feedback');
      for (const row of listRows(o.m)) {
        problems.push(...lineProblems(row, 'feedback'));
        if (!elements(row).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto')) problems.push(`feedback: the first line is not a <bdi dir="auto">: ${flat(row)}`);
      }
      tapBack(o);
      await enter(o, 'he', 'rows.blocked');
      for (const row of listRows(o.m)) {
        problems.push(...lineProblems(row, 'blocked'));
        const titleEl = elements(row).find((e) => classes(e).includes('ch-list-title')) as FakeElement;
        if (titleEl.getAttribute('dir') !== null || !elements(titleEl).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'ltr')) problems.push(`blocked: the id's title takes the page's direction and holds a <bdi dir="ltr">: dir=${titleEl.getAttribute('dir')}`);
        if (!elements(row).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto')) problems.push(`blocked: the reason is not a <bdi dir="auto">: ${flat(row)}`);
      }
    } finally {
      close(o);
    }
    assert(problems.length === 0, problems.slice(0, 5).join('; '));
    // The kit: a title the caller built follows the page, a plain one its own text
    assert(/ch-list-title"><bdi/.test(markupOf(renderToString(createElement(ListRow as never, { title: createElement('bdi', { dir: 'ltr' }, '5551234'), onClick: () => undefined })))) && /ch-list-title" dir="auto">Noa</.test(markupOf(renderToString(createElement(ListRow as never, { title: 'Noa', onClick: () => undefined })))), 'ListRow: a built title has no dir, a string title dir="auto"');
  });

  await check('U12 the send-reminder sheet offers a reminder only for a step that is still open (location: no location yet; calendars: a Google token and no calendars chosen; reconnect: a legacy Google user whose token is gone), never "Reconnect Google" to someone whose connection works; with every step done there is no send row', async () => {
    const cases: [string, Row, string[]][] = [
      ['no Google, no location', { googleState: 'none', hasOAuth: false, hasCalendars: false, hasLocation: false, applicableReminder: 'location' }, ['location']],
      ['no Google, location set', { googleState: 'none', hasOAuth: false, hasCalendars: false, hasLocation: true, applicableReminder: null }, []],
      ['a token, no calendars chosen', { googleState: 'choose', hasOAuth: true, hasCalendars: false, hasLocation: true, applicableReminder: 'calendars' }, ['calendars']],
      ['a token, no calendars, no location', { googleState: 'choose', hasOAuth: true, hasCalendars: false, hasLocation: false, applicableReminder: 'calendars' }, ['calendars', 'location']],
      ['a legacy Google user whose token is gone', { googleState: 'reconnect', hasOAuth: false, hasCalendars: true, hasLocation: true, applicableReminder: 'reconnect' }, ['reconnect']],
      ['the same, with no location', { googleState: 'reconnect', hasOAuth: false, hasCalendars: true, hasLocation: false, applicableReminder: 'reconnect' }, ['reconnect', 'location']],
      ['connected, calendars chosen, location set', { googleState: 'connected', hasOAuth: true, hasCalendars: true, hasLocation: true, applicableReminder: null }, []],
    ];
    for (const [what, registrationStatus, want] of cases) {
      reset();
      const o = open('en', propsOf('en'), { version: '7.7' });
      try {
        (scenario.people.get(TRIAL) as Row).registrationStatus = registrationStatus;
        await openPerson(o, 'en', 0);
        const send = btn(o.m, word('en', 'profile.setup.send'));
        assert(!!send === (want.length > 0), `${what}: the send row is ${send ? 'there' : 'not there'}`);
        if (!send) {
          assert(page(o.m).includes(word('en', 'profile.setup.allDone')), `${what}: it says they are fully set up`);
          continue;
        }
        o.m.click(send);
        const options = elements(dialogs(o.m)[0]).filter((e) => e.getAttribute('role') === 'radio').map((e) => e.getAttribute('data-value'));
        assert(show(options) === show(want), `${what}: offered ${show(options)}, wanted ${show(want)}`);
        assert(!flat(dialogs(o.m)[0]).includes(word('en', 'profile.setup.types.reconnect')) || want.includes('reconnect'), `${what}: "Reconnect Google" offered to a working connection`);
      } finally {
        close(o);
      }
    }
  });

  await check('U13 a view opens at the top and Back puts the view it returns to where it was left: Users at the row that was opened, the Overview where it was, also after a delete that returns to Users; the offset is the document\'s', async () => {
    const scrolled: number[] = [];
    fakeWindow.scrollTo = (_x: number, y: number) => void scrolled.push(y);
    fakeWindow.scrollY = 300;
    reset();
    const o = open('en', propsOf('en'), { version: '7.7' });
    try {
      await settle();
      scrolled.length = 0;
      await enter(o, 'en', 'rows.users'); // from the Overview, scrolled to 300
      assert(show(scrolled) === show([0]), `Users opens at the top: ${show(scrolled)}`);
      fakeWindow.scrollY = 1400; // the person scrolls down the list and taps a row
      o.m.click(personRow(o.m, 'en', 2));
      await settle();
      assert(show(scrolled) === show([0, 0]), `the profile opens at the top: ${show(scrolled)}`);
      fakeWindow.scrollY = 900;
      tapBack(o);
      await settle();
      assert(flat(title(o.m) as FakeElement) === word('en', 'users.title') && scrolled[scrolled.length - 1] === 1400, `back to Users at 1400: ${show(scrolled)}`);
      tapBack(o);
      await settle();
      assert(flat(title(o.m) as FakeElement) === word('en', 'title') && scrolled[scrolled.length - 1] === 300, `back to the Overview at 300: ${show(scrolled)}`);
      // A delete returns to Users, at the offset it was left at
      fakeWindow.scrollY = 300;
      await enter(o, 'en', 'rows.users');
      fakeWindow.scrollY = 700;
      o.m.click(personRow(o.m, 'en', 5));
      await settle();
      o.m.click(buttonsOf(o.m).find((b) => classes(b).includes('ch-danger-row') && flat(b) === word('en', 'profile.account.delete')) as FakeElement);
      o.m.input(sheetField(o.m), 'DELETE');
      o.m.click(confirmOf(o.m) as FakeElement);
      await settle();
      assert(flat(title(o.m) as FakeElement) === word('en', 'users.title') && scrolled[scrolled.length - 1] === 700, `after a delete, Users at 700: ${show(scrolled)}`);
    } finally {
      delete fakeWindow.scrollTo;
      delete fakeWindow.scrollY;
      close(o);
    }
  });

  await check('U14 a paid plan that will not renew says so, in the list and in the profile, in en, he and ru ("{plan} · until {date}, won\'t renew"); an active one does not; and he says Telegram for a Telegram message (not טלגרם)', async () => {
    const tails: Record<Locale, string> = { en: ", won't renew", he: ', לא יתחדש', ru: ', без продления' };
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, propsOf(locale), { version: '7.7' });
      const names = PEOPLE_NAMES[locale];
      try {
        (scenario.people.get(FREE) as Row).subscription = { ...SUBS.paid, status: 'CANCELED' };
        await enter(o, locale, 'rows.users');
        assert(flat(personRow(o.m, locale, 1)).includes(tails[locale]), `${locale}: the list: ${flat(personRow(o.m, locale, 1))}`);
        assert(!flat(personRow(o.m, locale, 2)).includes(tails[locale]), `${locale}: an active plan says it will not renew: ${flat(personRow(o.m, locale, 2))}`);
        o.m.click(personRow(o.m, locale, 1));
        await settle();
        assert(page(o.m).includes(tails[locale]) && elements(o.m.container).some((e) => e.className === 'ch-tag' && flat(e) === word(locale, 'profile.plan.tagPaid')), `${locale}: the profile of ${names[1]}: ${page(o.m).slice(0, 200)}`);
      } finally {
        close(o);
      }
    }
    assert(messages.he.admin.feedback.telegram === 'Telegram' && messages.en.admin.feedback.telegram === 'Telegram' && messages.ru.admin.feedback.telegram === 'Telegram', 'the Telegram source label is the brand in every language');
  });

  await check('R10 the panel\'s CSS keeps the kit\'s rules (logical properties, no hover, nothing under 11 px, no hex outside a token, a 44 px tap) and its class names are its own: no other file defines .ch-admin-*; the list row\'s and the tag tones\' names are free of the home\'s', () => {
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
    for (const name of ['ch-list-row', 'ch-list-title', 'ch-list-tags', 'ch-tag-danger', 'ch-tag-muted', 'ch-action-row']) {
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
