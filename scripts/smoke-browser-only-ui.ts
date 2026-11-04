// Smoke test for what a browser-only account sees (plan 6c-1 Task 9; spec docs/superpowers/specs/2026-11-03-web-sign-up-design.md
// §2.13, §3.11, §4): an account with no Telegram and no WhatsApp ("no chat") in a browser. Real modules, in real React on the
// small fake DOM with a router stub and a scripted fetch, over the real messages. No network, no DB.
//  - B1 the pure parts: homeBanners' Connect Telegram banner (no chat, outside Telegram, not closed) beside the old
//    Open FamCal in Telegram one (WhatsApp-only); the banner's close on the device (per account, a broken storage reads as not
//    closed); the Connect words by phase; the session-ended words by place
//  - B2 openTelegramConnect: one POST /api/telegram-connect?user_id= (same origin, JSON {}, no initData), the bot link opened in
//    this tab; each refusal said by its kind; no log line holds the link or its token
//  - B3 signInAgain: this browser signs out (POST /api/auth/signout), then /signin in the page's language; a refusal stays put
//  - B4 Settings with no chat (en, he, ru): no Summaries, no Timing, no voice input, alerts or Shabbat pause, no Pro notice; the
//    Telegram note card with Connect Telegram in their place; no Events section (page-data gives no-Telegram accounts
//    nativeRemindersSupported false, a partner's Telegram included)
//  - B5 Settings with a chat: every section and row as before, no note card
//  - B6 the note card's Connect: the link opened and what comes next; a stale sign-in turns it into "Sign in again", which signs
//    out and opens /signin; the hour's limit and a failure each said
//  - B7 Sign in on the web with no chat: the browser hint and a Telegram row with Connect Telegram; with a chat, as before
//  - B8 Plans with no chat: "Plans are paid with Telegram Stars..." with Connect Telegram, no pay button, no WhatsApp note;
//    WhatsApp-only keeps its note; early access shows neither
//  - B9 the page gate's card in a browser says to sign in and leads with Sign in; inside Telegram it is as before
//  - B10 the words: every new key in en, he and ru, none empty, no emoji, Hebrew and Russian in their own letters, none sends a
//    browser to the bot; every telegramConnect key is read
//  - B11 the wiring: page-data sends hasChat (Task 1's helper) for the home, Settings and Plans; PageGate hands it to the home;
//    the home gives the header Send only with a chat, the banners their close and the empty state its hint; Sign in on the web
//    reads view.chat (no prop); Calendars and Select calendars pick the session-ended words by place
//  - B13 the missing-link card: in a browser its browser words and Sign in; inside Telegram and on the server as before
//  - B12 React logged no warning
//
// Run with the fake env (never the real one), from the repo root:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-browser-only-ui

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, memoryStorage, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// The wheel library (Settings' reminder-time sheet) runs on touch events and animation frames, which the fake DOM has none of:
// the stub smoke-settings-render.ts uses stands in for it, before the screen is loaded.
{
  const wheelLib = nodeRequire.resolve('@ncdai/react-wheel-picker');
  const StubWheel = (p: { options: { value: string; label: unknown }[]; value: string }) =>
    createElement('div', { 'data-stub-wheel': '', 'data-value': p.value, tabIndex: 0 }, p.options.map((o) => createElement('span', { key: o.value }, String(o.label))));
  const StubWrapper = (p: { className?: string; children?: ReactElement }) => createElement('div', { className: p.className }, p.children);
  nodeRequire.cache[wheelLib] = { id: wheelLib, filename: wheelLib, loaded: true, exports: { WheelPicker: StubWheel, WheelPickerWrapper: StubWrapper } } as unknown as NodeJS.Module;
}

type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;
/** A message by its full key ('settings.noChat.title'); a missing one throws. */
const at = (locale: Locale, key: string): string => {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${key} in ${locale}`);
  return value;
};
const signInPath = (locale: Locale) => (locale === 'en' ? '/signin' : `/${locale}/signin`);

const results: { name: string; ok: boolean; reason?: string }[] = [];
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
const show = (v: unknown) => JSON.stringify(v);

// ---- React must not warn; the app's own lines are kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
const APP_TAGS = ['[telegram-connect]', '[sign-in-again]', '[settings]', '[signin-methods]', '[subscription]'];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (APP_TAGS.some((tag) => text.startsWith(tag))) return void appLogs.push(text);
    if (text.startsWith('[telegram-ui]') || text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: a router, a scripted fetch and this tab's location ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
const router = { push: (href: string) => void pushes.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };

const CONNECT_TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const CONNECT_URL = `https://t.me/test_bot?start=w_${CONNECT_TOKEN}`;
type Call = { url: string; path: string; method: string; headers: Record<string, string>; body: Row | null; credentials?: string };
const calls: Call[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** A browser-only account's sign-in ways: its Google way (its only one, Task 8's lastWay), signed in with it in this browser; no chat (Task 8's chat). */
const NO_CHAT_VIEW: Row = { telegram: false, google: { address: 'dana@gmail.com' }, googleFromCalendar: null, email: null, providers: { telegram: true, google: true, email: true }, chat: false, lastWay: 'google', session: 'google' };
/** A Telegram account with no web way added, opened in the Mini App. */
const CHAT_VIEW: Row = { telegram: true, google: null, googleFromCalendar: null, email: null, providers: { telegram: true, google: true, email: true }, chat: true, lastWay: 'telegram', session: null };
const world = {
  connect: (): Response | Promise<Response> => json({ url: CONNECT_URL }),
  signout: (): Response | Promise<Response> => json({ ok: true }),
  signInView: NO_CHAT_VIEW,
};
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  const parsed = new URL(url, 'https://famcal.bot');
  const call: Call = {
    url,
    path: parsed.pathname,
    method: init.method ?? 'GET',
    headers: { ...(init.headers as Record<string, string> | undefined) },
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    credentials: init.credentials,
  };
  calls.push(call);
  if (call.path === '/api/telegram-connect' && call.method === 'POST') return world.connect();
  if (call.path === '/api/auth/signout' && call.method === 'POST') return world.signout();
  if (call.path === '/api/signin-methods' && call.method === 'GET') return json(world.signInView);
  throw new TypeError(`Failed to fetch: an unexpected request ${call.method} ${url}`);
}) as typeof fetch;
const callsTo = (pathname: string) => calls.filter((c) => c.path === pathname);
const assigned: string[] = [];

/** A fresh browser tab (no Telegram) and a fresh server. */
function reset(view: Row = NO_CHAT_VIEW) {
  calls.length = 0;
  assigned.length = 0;
  appLogs.length = 0;
  pushes.length = 0;
  world.connect = () => json({ url: CONNECT_URL });
  world.signout = () => json({ ok: true });
  world.signInView = view;
  installWindow();
  fakeWindow.Telegram = undefined;
  fakeWindow.location = { hash: '', origin: 'https://famcal.bot', href: 'https://famcal.bot/settings?user_id=1', assign: (u: string) => void assigned.push(u) };
  fakeWindow.localStorage = memoryStorage();
  fakeWindow.sessionStorage = memoryStorage();
}

// ---- Reading what is on the page ----

function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
const flat = (node: FakeNode) => visible(node).replace(/\s+/g, ' ').trim();
const page = (m: Mounted) => flat(m.container);
const buttonsOf = (node: FakeNode) => elements(node).filter((e) => e.localName === 'button');
const buttonsNamed = (node: FakeNode, text: string) => buttonsOf(node).filter((b) => flat(b) === text);
const sectionLabels = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'h2' && e.className === 'ch-section-label').map(flat);
const switches = (m: Mounted) => byRole(m.container, 'switch').map(flat);
const alerts = (m: Mounted) => byRole(m.container, 'alert').map(flat);
const formRows = (m: Mounted) => elements(m.container).filter((e) => e.className.split(' ').includes('ch-form-row'));
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
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });

// ---- Fixtures ----

const settingsValues = (locale: Locale) => ({
  language: locale,
  gender: 'male',
  location: 'Tel Aviv',
  messagingPlatform: 'telegram',
  culture: 'jewish',
  textSummaryEnabled: true,
  voiceSummaryEnabled: false,
  weatherEnabled: true,
  includeLookaheadInTomorrow: false,
  lookaheadAlways7Days: false,
  preferredMorningHour: 7,
  preferredEveningHour: 20,
  dailySummaryDays: [0, 1, 2, 3, 4, 5],
  tomorrowSummaryDays: [0, 1, 2, 3, 4, 6],
  remindersEnabled: true,
  defaultReminderMinutes: 15,
  reminderTime: '09:15',
  pickupRemindersEnabled: false,
  voiceInputEnabled: false,
  pauseOnShabbat: true,
  zmanimCommunity: 'sephardi',
});
/** Settings for a browser-only account on a trial whose plan has no alerts (the chat account sees the Pro notice). */
const settingsProps = (locale: Locale, over: Row = {}): Row => ({
  userId: 1,
  currentSettings: settingsValues(locale),
  weekStart: 0,
  remindersGloballyEnabled: true,
  googleConnected: false,
  nativeRemindersSupported: false,
  subscriptionInfo: { effectivePlan: 'BASIC', textSummariesUsed: 0, textSummariesLimit: -1, voiceSummariesUsed: 0, voiceSummariesLimit: -1, remindersAllowed: false, isTrialing: false },
  bothChannels: false,
  hasChat: false,
  ...over,
});
/** Plans on a trial (both cards can be chosen), for a browser-only account. */
const planProps = (locale: Locale, over: Row = {}): Row => ({
  userId: 41,
  locale,
  subscription: { plan: 'FREE', status: 'TRIALING', effectivePlan: 'PRO', currentPeriodEnd: null, cancelAtPeriodEnd: false },
  usage: { textSummaries: 0, voiceSummaries: 0, voiceEvents: 0, reminders: 0, cycleStartDate: '2026-11-01T00:00:00.000Z' },
  trial: { isTrialing: true, daysRemaining: 9, trialEndsAt: '2026-11-18T10:00:00.000Z' },
  isEarlyAdopter: false,
  calendarsUsed: 1,
  telegramLinked: false,
  hasChat: false,
  ...over,
});
const LINKS = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };

/** The new keys of this task. */
const NEW_KEYS = [
  'calendarHome.banner.connectTelegramBody',
  'calendarHome.banner.close',
  'calendarHome.empty.hintBrowser',
  'calendarHome.send.signedOutBrowser',
  'calendarsPage.errors.reopenBrowser',
  'pageGate.signInTitle',
  'pageGate.signInBody',
  'ui.missingParameter.bodyBrowser',
  'subscription.screen.connectTelegram',
  'settings.noChat.title',
  'settings.noChat.body',
  'settings.signIn.hintNoChat',
  'settings.signIn.telegramConnectHint',
  'telegramConnect.action',
  'telegramConnect.opening',
  'telegramConnect.signInAgain',
  'telegramConnect.opened',
  'telegramConnect.limit',
  'telegramConnect.failed',
];
/** The words a browser reads in place of the chat's: none may send it to the bot. */
const BROWSER_KEYS = ['calendarHome.empty.hintBrowser', 'calendarHome.send.signedOutBrowser', 'calendarsPage.errors.reopenBrowser', 'pageGate.signInTitle', 'pageGate.signInBody', 'ui.missingParameter.bodyBrowser', 'settings.signIn.hintNoChat'];

async function main() {
  const connectClient = await import('../src/lib/telegram-connect-client');
  const signInAgainModule = await import('../src/lib/sign-in-again');
  const { homeBanners } = await import('../app/[locale]/(app)/dashboard/HomeBanners');
  const storage = await import('../src/lib/calendar-view/home-storage');
  const Settings = (await import('../app/[locale]/(app)/settings/SettingsClient')).default as unknown as (props: Row) => ReactElement;
  const Subscription = (await import('../app/[locale]/(app)/subscription/SubscriptionClient')).default as unknown as (props: Row) => ReactElement;
  const { NoCredentialCard } = (await import('../app/[locale]/(app)/PageGate')) as unknown as { NoCredentialCard: (props: Row) => ReactElement };
  const { MissingParameterCard } = await import('../components/app-ui/StateCard');
  const { openTelegramConnect, connectButtonKey, connectLineKey } = connectClient;
  const { signInAgain, sessionEndedKey } = signInAgainModule;

  const inApp = (locale: Locale, el: ReactElement) =>
    createElement(AppRouterContext.Provider, { value: router }, createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, el));
  const mountIn = (locale: Locale, component: (p: Row) => ReactElement, props: Row): Mounted => mount(inApp(locale, createElement(component, props)));

  await check('B1 the pure parts: the Connect Telegram banner for no chat outside Telegram until closed, Open FamCal in Telegram still for WhatsApp-only; the close flag per account on the device (a storage that throws reads as not closed); the Connect words by phase; the session-ended words by place', () => {
    const base = { googleState: 'none' as const, googleConnected: false, reconnect: null, inTelegram: false };
    const cases: [Row, string[]][] = [
      [{ hasTelegram: false, hasChat: false }, ['connectTelegram']],
      [{ hasTelegram: false, hasChat: false, connectClosed: true }, []],
      [{ hasTelegram: false, hasChat: false, inTelegram: true }, []],
      [{ hasTelegram: false, hasChat: true }, ['openInTelegram']],
      // Not told whether there is a chat (an older fixture, a page cached before this deploy): as before
      [{ hasTelegram: false }, ['openInTelegram']],
      [{ hasTelegram: true, hasChat: true }, []],
      [{ trialDaysLeft: 3, hasLocation: false, hasTelegram: false, hasChat: false }, ['trial', 'location', 'connectTelegram']],
    ];
    for (const [facts, want] of cases) {
      const got = homeBanners({ ...base, ...facts } as never);
      assert(show(got) === show(want), `${show(facts)}: ${show(got)}, want ${show(want)}`);
    }

    installWindow();
    fakeWindow.localStorage = memoryStorage();
    assert(storage.connectBannerKey(7) === 'famcal:connectBanner:v1:7', storage.connectBannerKey(7));
    assert(storage.readConnectBannerClosed(7) === false, 'not closed yet');
    storage.writeConnectBannerClosed(7);
    assert(fakeWindow.localStorage.getItem('famcal:connectBanner:v1:7') === '1' && storage.readConnectBannerClosed(7) === true, 'closed and remembered');
    assert(storage.readConnectBannerClosed(8) === false, 'another account on the device keeps its banner');
    fakeWindow.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    assert(storage.readConnectBannerClosed(7) === false, 'a storage that throws reads as not closed');
    storage.writeConnectBannerClosed(7);
    fakeWindow.localStorage = memoryStorage();

    const phases = ['idle', 'busy', 'leaving', 'opened', 'stale', 'limit', 'failed'] as const;
    assert(show(phases.map(connectButtonKey)) === show(['action', 'opening', 'signInAgain', 'action', 'signInAgain', 'action', 'action']), `button words ${show(phases.map(connectButtonKey))}`);
    assert(show(phases.map(connectLineKey)) === show([null, null, null, { key: 'opened', problem: false }, null, { key: 'limit', problem: true }, { key: 'failed', problem: true }]), `lines ${show(phases.map(connectLineKey))}`);
    assert(sessionEndedKey(true) === 'errors.reopen' && sessionEndedKey(false) === 'errors.reopenBrowser', 'the session-ended words');
  });

  await check('B2 openTelegramConnect: one POST /api/telegram-connect?user_id=<id> (same origin, JSON {}, no initData) and the bot link in this tab; a stale sign-in (its code or a 401), the limit (its code or a 429), has-chat, unavailable, a link that is not Telegram\'s, a body that is not JSON and no answer each say their kind and are logged; no log line holds the link or its token', async () => {
    reset();
    assert((await openTelegramConnect(7)) === 'opened', 'opened');
    const [call, ...more] = callsTo('/api/telegram-connect');
    assert(call && more.length === 0 && call.url === '/api/telegram-connect?user_id=7' && call.method === 'POST' && call.credentials === 'same-origin', `the request ${show(calls)}`);
    assert(call.headers['Content-Type'] === 'application/json' && show(call.body) === '{}' && !('X-Telegram-Init-Data' in call.headers), `headers and body ${show(call)}`);
    assert(fakeWindow.location.href === CONNECT_URL, `the tab went to ${show(fakeWindow.location.href)}`);
    assert(appLogs.length === 0, `logged on success: ${show(appLogs)}`);

    const cases: [string, () => Response, string][] = [
      ['stale-sign-in', () => json({ error: 'stale-sign-in' }, 403), 'stale-sign-in'],
      ['401', () => json({ error: 'Unauthorized' }, 401), 'stale-sign-in'],
      ['limit', () => json({ error: 'limit' }, 429), 'limit'],
      ['429 without a code', () => json({}, 429), 'limit'],
      ['has-chat', () => json({ error: 'has-chat' }, 409), 'failed'],
      ['unavailable', () => json({ error: 'unavailable' }, 503), 'failed'],
      ['a link that is not Telegram\'s', () => json({ url: 'https://example.com/w_x' }), 'failed'],
      ['not JSON', () => new Response('<html>', { status: 500 }), 'failed'],
      ['no answer', () => { throw new TypeError('Failed to fetch'); }, 'failed'],
    ];
    for (const [what, answer, want] of cases) {
      reset();
      world.connect = answer;
      const got = await openTelegramConnect(7);
      assert(got === want, `${what}: ${got}, want ${want}`);
      assert(fakeWindow.location.href === 'https://famcal.bot/settings?user_id=1', `${what}: the tab moved to ${show(fakeWindow.location.href)}`);
      assert(appLogs.some((l) => l.startsWith('[telegram-connect]')), `${what}: not logged`);
      assert(!appLogs.some((l) => l.includes(CONNECT_TOKEN) || l.includes('t.me') || l.includes('example.com')), `${what}: a log holds a link: ${show(appLogs)}`);
    }
  });

  await check('B3 signInAgain: POST /api/auth/signout (same origin, JSON {}), then /signin in the page\'s language; a refused or failed sign-out stays on the page and is logged', async () => {
    for (const locale of LOCALES) {
      reset();
      assert((await signInAgain(locale)) === true, `${locale}: true`);
      const [call] = callsTo('/api/auth/signout');
      assert(call && call.method === 'POST' && call.credentials === 'same-origin' && show(call.body) === '{}' && call.headers['Content-Type'] === 'application/json', `${locale}: the sign-out ${show(calls)}`);
      assert(show(assigned) === show([signInPath(locale)]), `${locale}: went to ${show(assigned)}`);
    }
    for (const [what, answer] of [['500', () => json({}, 500)], ['no answer', () => { throw new TypeError('Failed to fetch'); }]] as [string, () => Response][]) {
      reset();
      world.signout = answer;
      assert((await signInAgain('he')) === false && assigned.length === 0, `${what}: stays`);
      assert(appLogs.some((l) => l.startsWith('[sign-in-again]')), `${what}: not logged`);
    }
  });

  await check('B4 Settings with no chat (en, he, ru): the place card without the Shabbat pause; no Summaries, no Timing; the Telegram note card ("Briefings and reminders come in Telegram") with Connect Telegram; no voice input, no alerts, no Pro notice; no Events section and no reminder time (page-data sends nativeRemindersSupported false without Telegram)', async () => {
    for (const locale of LOCALES) {
      reset();
      const m = mountIn(locale, Settings, settingsProps(locale, { nativeRemindersSupported: false }));
      await settle();
      try {
        const where = locale;
        const want = [at(locale, 'settings.sections.place'), at(locale, 'settings.signIn.title')];
        assert(show(sectionLabels(m)) === show(want), `${where}: the sections ${show(sectionLabels(m))}, want ${show(want)}`);
        for (const key of ['pause.label', 'text.label', 'voice.label', 'weather.label', 'voiceInput.label', 'alerts.label', 'pickup.label']) {
          assert(!switches(m).some((s) => s.startsWith(at(locale, `settings.${key}`))), `${where}: the ${key} switch shows`);
        }
        const text = page(m);
        assert(text.includes(at(locale, 'settings.noChat.title')) && text.includes(at(locale, 'settings.noChat.body')), `${where}: the note card`);
        assert(!text.includes(at(locale, 'settings.alerts.proOnly')) && !text.includes(at(locale, 'settings.morning.label')), `${where}: the Pro notice or the timing shows`);
        assert(buttonsNamed(m.container, at(locale, 'telegramConnect.action')).length === 2, `${where}: Connect Telegram in the note card and in Sign in on the web: ${show(buttonsOf(m.container).map(flat))}`);
        const reminderRow = formRows(m).some((r) => flat(r).startsWith(at(locale, 'settings.reminderTime')));
        assert(!reminderRow, `${where}: the reminder time ${reminderRow}`);
        // The language, the place, the zmanim community and the calendar stay
        for (const key of ['language.label', 'location.label', 'zmanim.label', 'culture.label']) assert(text.includes(at(locale, `settings.${key}`)), `${where}: ${key} is gone`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('B5 Settings with a chat: the place, summaries, timing and events sections and Sign in on the web; the pause, voice input and alert switches and the Pro notice as before; no note card and no Connect Telegram', async () => {
    for (const locale of LOCALES) {
      reset(CHAT_VIEW);
      const m = mountIn(locale, Settings, settingsProps(locale, { hasChat: true, nativeRemindersSupported: true }));
      await settle();
      try {
        const want = ['place', 'summaries', 'timing', 'events'].map((k) => at(locale, `settings.sections.${k}`)).concat(at(locale, 'settings.signIn.title'));
        assert(show(sectionLabels(m)) === show(want), `${locale}: the sections ${show(sectionLabels(m))}`);
        for (const key of ['pause.label', 'text.label', 'voiceInput.label', 'alerts.label']) assert(switches(m).some((s) => s.startsWith(at(locale, `settings.${key}`))), `${locale}: no ${key} switch`);
        const text = page(m);
        assert(text.includes(at(locale, 'settings.alerts.proOnly')), `${locale}: the Pro notice`);
        assert(!text.includes(at(locale, 'settings.noChat.title')) && buttonsNamed(m.container, at(locale, 'telegramConnect.action')).length === 0, `${locale}: the note card shows with a chat`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('B6 the note card\'s Connect Telegram: the link in this tab and "Finish in Telegram..."; a stale sign-in turns the button into "Sign in again to connect Telegram", whose press signs out and opens /signin; the hour\'s limit and a failure are alerts; a second tap while one runs sends nothing', async () => {
    reset();
    const m = mountIn('en', Settings, settingsProps('en'));
    await settle();
    try {
      let hold: (r: Response) => void = () => undefined;
      world.connect = () => new Promise<Response>((resolve) => void (hold = resolve));
      const [note] = buttonsNamed(m.container, at('en', 'telegramConnect.action'));
      // Both presses in one act: React paints nothing between them, so the button is still enabled for the second (the ref guard's case)
      await act(async () => {
        m.click(note);
        m.click(note);
      });
      await settle();
      assert(callsTo('/api/telegram-connect').length === 1 && note.getAttribute('aria-busy') === 'true' && flat(note) === at('en', 'telegramConnect.opening'), `one request at a time, said: ${flat(note)}`);
      await act(async () => {
        hold(json({ url: CONNECT_URL }));
        await new Promise((r) => setTimeout(r, 0));
      });
      await settle();
      assert(callsTo('/api/telegram-connect')[0].url === '/api/telegram-connect?user_id=1' && fakeWindow.location.href === CONNECT_URL, 'the link opened');
      assert(page(m).includes(at('en', 'telegramConnect.opened')), 'what comes next');
    } finally {
      m.unmount();
    }

    reset();
    world.connect = () => json({ error: 'stale-sign-in' }, 403);
    const stale = mountIn('he', Settings, settingsProps('he'));
    await settle();
    try {
      stale.click(buttonsNamed(stale.container, at('he', 'telegramConnect.action'))[0]);
      await settle();
      const again = buttonsNamed(stale.container, at('he', 'telegramConnect.signInAgain'));
      assert(again.length === 1, `the button says sign in again: ${show(buttonsOf(stale.container).map(flat))}`);
      stale.click(again[0]);
      await settle();
      assert(callsTo('/api/auth/signout').length === 1 && show(assigned) === show(['/he/signin']) && callsTo('/api/telegram-connect').length === 1, `signed out, then /he/signin: ${show(assigned)}`);
    } finally {
      stale.unmount();
    }

    for (const [what, answer, key] of [
      ['limit', () => json({ error: 'limit' }, 429), 'limit'],
      ['no answer', () => { throw new TypeError('Failed to fetch'); }, 'failed'],
    ] as [string, () => Response, string][]) {
      reset();
      world.connect = answer;
      const r = mountIn('ru', Settings, settingsProps('ru'));
      await settle();
      try {
        r.click(buttonsNamed(r.container, at('ru', 'telegramConnect.action'))[0]);
        await settle();
        assert(alerts(r).includes(at('ru', `telegramConnect.${key}`)), `${what}: ${show(alerts(r))}`);
        assert(buttonsNamed(r.container, at('ru', 'telegramConnect.action')).length === 2, `${what}: the button is ready again`);
      } finally {
        r.unmount();
      }
    }
  });

  await check('B7 Sign in on the web with no chat: the browser hint (no word of Telegram and WhatsApp keeping working), a Telegram row "Not connected..." with Connect Telegram under it; with a chat the old hint and Telegram on', async () => {
    for (const locale of LOCALES) {
      reset();
      const m = mountIn(locale, Settings, settingsProps(locale));
      await settle();
      try {
        const hints = elements(m.container).filter((e) => e.className === 'ch-form-hint').map(flat);
        assert(hints.includes(at(locale, 'settings.signIn.hintNoChat')) && !hints.includes(at(locale, 'settings.signIn.hint')), `${locale}: the hint ${show(hints)}`);
        const telegramRow = formRows(m).find((r) => flat(r).startsWith(at(locale, 'settings.signIn.telegram')));
        assert(telegramRow && flat(telegramRow).includes(at(locale, 'settings.signIn.telegramConnectHint')) && !flat(telegramRow).includes(at(locale, 'settings.signIn.on')), `${locale}: the Telegram row ${telegramRow && flat(telegramRow)}`);
        const connects = buttonsNamed(m.container, at(locale, 'telegramConnect.action'));
        assert(connects.length === 2 && connects[1].className === 'ch-form-row ch-action-row', `${locale}: Connect in the sign-in group`);
        m.click(connects[1]);
        await settle();
        assert(callsTo('/api/telegram-connect').length === 1 && fakeWindow.location.href === CONNECT_URL, `${locale}: the group's Connect opens the link`);
      } finally {
        m.unmount();
      }
      reset(CHAT_VIEW);
      const chat = mountIn(locale, Settings, settingsProps(locale, { hasChat: true }));
      await settle();
      try {
        const hints = elements(chat.container).filter((e) => e.className === 'ch-form-hint').map(flat);
        assert(hints.includes(at(locale, 'settings.signIn.hint')), `${locale}: the old hint`);
        const row = formRows(chat).find((r) => flat(r).startsWith(at(locale, 'settings.signIn.telegram')));
        assert(row && flat(row).includes(at(locale, 'settings.signIn.on')), `${locale}: Telegram on`);
      } finally {
        chat.unmount();
      }
    }
  });

  await check('B8 Plans with no chat: "Plans are paid with Telegram Stars..." with Connect Telegram (which asks for the link), no pay button, no Stars or WhatsApp note; WhatsApp-only keeps "Paying with Telegram Stars needs Telegram"; early access shows neither', async () => {
    for (const locale of LOCALES) {
      reset();
      const m = mountIn(locale, Subscription, planProps(locale));
      await settle();
      try {
        const text = page(m);
        assert(text.includes(at(locale, 'subscription.screen.connectTelegram')), `${locale}: the line`);
        assert(!text.includes(at(locale, 'subscription.screen.needsTelegram')) && !text.includes(at(locale, 'subscription.screen.starsNote')), `${locale}: the WhatsApp or Stars note`);
        assert(buttonsNamed(m.container, at(locale, 'subscription.screen.agreeAndPay')).length === 0, `${locale}: a pay button`);
        const action = buttonsOf(m.container).find((b) => b.className === 'ch-notice-action' && flat(b) === at(locale, 'telegramConnect.action'));
        assert(action, `${locale}: Connect Telegram ${show(buttonsOf(m.container).map(flat))}`);
        m.click(action);
        await settle();
        assert(callsTo('/api/telegram-connect')[0]?.url === '/api/telegram-connect?user_id=41' && fakeWindow.location.href === CONNECT_URL, `${locale}: the link`);
      } finally {
        m.unmount();
      }
      reset();
      const wa = mountIn(locale, Subscription, planProps(locale, { hasChat: true }));
      try {
        assert(page(wa).includes(at(locale, 'subscription.screen.needsTelegram')) && !page(wa).includes(at(locale, 'subscription.screen.connectTelegram')), `${locale}: WhatsApp-only`);
      } finally {
        wa.unmount();
      }
      const early = mountIn(locale, Subscription, planProps(locale, { isEarlyAdopter: true }));
      try {
        assert(!page(early).includes(at(locale, 'subscription.screen.connectTelegram')) && !page(early).includes(at(locale, 'subscription.screen.needsTelegram')), `${locale}: early access`);
      } finally {
        early.unmount();
      }
    }
  });

  await check('B9 the page gate\'s card in a browser says to sign in ("Sign in to open this page") and leads with Sign in, then WhatsApp and Telegram; it no longer says to open the page from a chat; inside Telegram it is as before', () => {
    for (const locale of LOCALES) {
      const html = renderToString(inApp(locale, createElement(NoCredentialCard, { inTelegram: false, links: LINKS })));
      const text = textOf(html);
      assert(text.includes(at(locale, 'pageGate.signInTitle')) && text.includes(at(locale, 'pageGate.signInBody')), `${locale}: the words ${text.slice(0, 200)}`);
      assert(!text.includes(at(locale, 'pageGate.browserTitle')) && !text.includes(at(locale, 'pageGate.browserBody')), `${locale}: the chat words`);
      const signIn = html.indexOf(`href="${signInPath(locale)}"`);
      const wa = html.indexOf(`href="${LINKS.whatsapp}"`);
      const tg = html.indexOf(`href="${LINKS.telegram}"`);
      assert(signIn > 0 && signIn < wa && wa < tg, `${locale}: the order ${signIn} ${wa} ${tg}`);
      const telegram = textOf(renderToString(inApp(locale, createElement(NoCredentialCard, { inTelegram: true, links: LINKS }))));
      assert(telegram.includes(at(locale, 'pageGate.telegramTitle')) && !telegram.includes(at(locale, 'pageGate.signInTitle')), `${locale}: inside Telegram`);
    }
  });

  await check('B10 the words: every new key in en, he and ru, none empty, no emoji, Hebrew and Russian in their own letters; the browser words never send anyone to the bot; every telegramConnect key is read by the helper or a screen', () => {
    for (const locale of LOCALES) {
      for (const key of NEW_KEYS) {
        const value = at(locale, key);
        assert(value.trim() !== '' && !/\p{Extended_Pictographic}/u.test(value), `${locale}: ${key} is empty or has an emoji`);
        if (locale === 'he') assert(/[֐-׿]/.test(value), `he: ${key} has no Hebrew: ${value}`);
        if (locale === 'ru') assert(/[А-Яа-яЁё]/.test(value), `ru: ${key} has no Russian: ${value}`);
      }
      // famcal.bot is the site's address, not the bot
      for (const key of BROWSER_KEYS) assert(!/\bbot\b|בוט|бот/i.test(at(locale, key).replace(/famcal\.bot/g, '')), `${locale}: ${key} names the bot: ${at(locale, key)}`);
      assert(show(Object.keys(messages[locale].telegramConnect).sort()) === show(['action', 'failed', 'limit', 'opened', 'opening', 'signInAgain']), `${locale}: telegramConnect ${show(Object.keys(messages[locale].telegramConnect))}`);
    }
    const sources = ['src/lib/telegram-connect-client.ts', 'app/[locale]/(app)/dashboard/HomeBanners.tsx', 'app/[locale]/(app)/settings/SettingsClient.tsx', 'app/[locale]/(app)/settings/SignInMethods.tsx', 'app/[locale]/(app)/subscription/SubscriptionClient.tsx']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .join('\n');
    for (const key of Object.keys(messages.en.telegramConnect)) assert(sources.includes(`'${key}'`), `telegramConnect.${key} is read by nothing`);
  });

  await check('B11 the wiring: page-data sends hasChat (Task 1\'s hasChat) for the home, Settings and Plans; PageGate hands it to the home; the home gives the header Send only with a chat, the banners hasChat and their close, the empty state its hint; Sign in on the web reads view.chat and takes no hasChat prop; Calendars and Select calendars choose the session-ended words by place', () => {
    const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const pageData = src('src/lib/page-data.ts');
    assert((pageData.match(/hasChat: hasChat\(user\)/g) ?? []).length === 3 && pageData.includes("import { hasChat } from '@/src/lib/has-chat';"), 'page-data: hasChat for the dashboard, settings and subscription, from src/lib/has-chat');
    assert(/hasChat: p\.hasChat/.test(src('app/[locale]/(app)/PageGate.tsx')), 'PageGate: the home gets hasChat');
    const home = src('app/[locale]/(app)/dashboard/CalendarHome.tsx');
    assert(/onSend=\{hasChat === false \? undefined : \(\) => setSheet\('send'\)\}/.test(home), 'CalendarHome: Send only with a chat');
    assert(/hasChat=\{hasChat\}/.test(home) && /connectClosed=\{connectClosed\}/.test(home) && /onCloseConnect=\{closeConnect\}/.test(home) && /hints=\{shownHints\}/.test(home), 'CalendarHome: the banners and the hint');
    const signIn = src('app/[locale]/(app)/settings/SignInMethods.tsx');
    assert(/view\.chat \? t\('hint'\) : t\('hintNoChat'\)/.test(signIn) && /\{!view\.chat \? \(/.test(signIn) && !/hasChat/.test(signIn), 'Sign in on the web: the hint and the Telegram row by view.chat, and no hasChat prop');
    assert(/<SignInMethods userId=\{userId\} onSheet=/.test(src('app/[locale]/(app)/settings/SettingsClient.tsx')), 'Settings hands Sign in on the web no hasChat');
    assert(/t\(sessionEndedKey\(isInTelegram\(\)\)\)/.test(src('app/[locale]/(app)/calendars/CalendarsClient.tsx')), 'Calendars: the session-ended words by place');
    assert(/page\(sessionEndedKey\(isInTelegram\(\)\)\)/.test(src('app/[locale]/(app)/select-calendars/SelectCalendarsClient.tsx')), 'Select calendars: the session-ended words by place');
    assert(/sendResultKey\(answer, isInTelegram\(\)\)/.test(src('app/[locale]/(app)/dashboard/SendSheet.tsx')), 'the Send sheet: the session-ended words by place');
  });

  await check('B13 the missing-link card (a page opened without user_id): in a browser "Sign in again to open your calendar." with Sign in, one link to /signin in the page\'s language, and no word of the bot; inside Telegram, and in the server\'s markup, the card as before with no Sign in', () => {
    for (const locale of LOCALES) {
      const title = at(locale, 'ui.missingParameter.title');
      reset();
      const browser = mount(inApp(locale, createElement(MissingParameterCard)));
      try {
        const card = elements(browser.container).find((e) => e.getAttribute('role') === 'alert');
        assert(card && flat(card) === `${title}${at(locale, 'ui.missingParameter.bodyBrowser')}${at(locale, 'pageGate.signIn')}`, `${locale}: the browser card ${card && flat(card)}`);
        const links = elements(card).filter((e) => e.localName === 'a');
        assert(links.length === 1 && links[0].getAttribute('href') === signInPath(locale) && flat(links[0]) === at(locale, 'pageGate.signIn'), `${locale}: Sign in ${show(links.map((a) => a.getAttribute('href')))}`);
      } finally {
        browser.unmount();
      }
      reset();
      fakeWindow.Telegram = { WebApp: fakeTelegram([], '7.7') };
      const inside = mount(inApp(locale, createElement(MissingParameterCard)));
      try {
        const card = elements(inside.container).find((e) => e.getAttribute('role') === 'alert');
        assert(card && flat(card) === `${title}${at(locale, 'ui.missingParameter.body')}` && !elements(card).some((e) => e.localName === 'a'), `${locale}: inside Telegram ${card && flat(card)}`);
      } finally {
        inside.unmount();
        fakeWindow.Telegram = undefined;
      }
      // The server's markup (and so the first render that hydrates it) is the card as it was
      const server = textOf(renderToString(inApp(locale, createElement(MissingParameterCard))));
      assert(server.includes(at(locale, 'ui.missingParameter.body')) && !server.includes(at(locale, 'ui.missingParameter.bodyBrowser')), `${locale}: the server's markup ${server}`);
    }
  });

  await check('B12 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings.slice(0, 5)));
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
