// Smoke test for the browser side of notifications (plan 6c-2 Task 5; spec docs/superpowers/specs/2026-11-05-web-push-design.md
// §2.1, §2.3, §2.4): src/lib/web-push-client.ts and its hook (src/lib/use-push-device.ts), Settings' "Notifications on this
// device" card, the Settings rows that come back with a device on, the note card, the home's "Get reminders on this device"
// banner, and the sign-outs on this device that unsubscribe first. Real modules in real React on the small fake DOM
// (scripts/lib/fake-dom.ts) with a fake browser push stack (the service worker container, PushManager, Notification,
// display-mode) and a scripted fetch, over the real messages. No network, no DB.
//  - W1 pushSupport: Chrome on Android and desktop Safari can; an iPhone or an iPad (a Mac with touch) in a browser tab gets the
//    Home Screen steps; on the Home Screen it can, unless it has no PushManager (before iOS 16.4); no service worker, no
//    PushManager or no navigator can't
//  - W2 turnOnPush: the prompt and the install both start in the tap, before any await; /sw.js at scope /; subscribe with
//    userVisibleOnly and FamCal's key; one POST /api/push/devices?user_id= (same origin, JSON { endpoint, keys }, no initData);
//    a held subscription with the same key is reused, one with another key is made again
//  - W3 turnOnPush's refusals, each with its reason; after any server refusal the browser holds no subscription; no log line
//    holds the endpoint or a key
//  - W4 turnOffPush and currentPushEndpoint: unsubscribe, then DELETE with the endpoint; no user id: no DELETE; nothing held: no
//    request; a failed DELETE still leaves the browser off; neither installs the worker
//  - W5 checkPushOnOpen: never installs; mine is on; another account's is undone; no answer undoes nothing
//  - W6 Settings, off to on and back (en, he, ru): the card above Sign in on the web; the tap turns it on; the rows a
//    notification can honour come back, voice, weather, the week ahead and voice input stay hidden, the note card goes; off
//    again deletes the device and the page is as before
//  - W7 a stale sign-in: Sign in again first, asking the browser nothing; a stale answer from the server does the same
//  - W8 a second tap: "Tap again to allow", then on
//  - W9 the lines: not answered, blocked (also at the open), refused, failed, a turn off that failed
//  - W10 at the open: this account's subscription is on (the rows back from the page's count); another account's is undone
//  - W11 iPhone and iPad in a tab: the steps, no switch; a browser that can't: one line; push off (no key) or no push: no card
//  - W12 the home banner (the home's own two lines around HomeBanners)
//  - W13 the pure parts: pushBannerOf and homeBanners with it
//  - W14 sign-outs on this device unsubscribe (and delete, with the user id) before the sign-out; a failure never stops it
//  - W15 the wiring: the home, PageGate, Settings and the three sign-outs
//  - W16 the words: every new key in en, he and ru; Russian's no-break spaces; every settings.push key is read
//  - W17 the look: the iPhone steps are a numbered list with the Share icon in step 1; the bell at rest; aria-busy while turning on
//  - W18 React logged no warning
//
// Run with the fake env (never the real one), from the repo root: $RUN smoke-web-push-ui

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, memoryStorage, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// The wheel library (Settings' reminder-time sheet) runs on touch events the fake DOM has none of: the stub
// smoke-browser-only-ui.ts uses stands in for it, before the screen is loaded.
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
/** A message by its full key; a missing one throws. */
const at = (locale: Locale, key: string): string => {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${key} in ${locale}`);
  return value;
};
const p = (locale: Locale, key: string) => at(locale, `settings.push.${key}`);
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
const APP_TAGS = ['[web-push]', '[sign-in-again]', '[signin-methods]', '[telegram-connect]', '[settings]'];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (APP_TAGS.some((tag) => text.startsWith(tag))) return void appLogs.push(text);
    if (text.startsWith('[telegram-ui]') || text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- What no log line may hold ----

/** FamCal's public VAPID key: 65 bytes, 0x04 first, base64url. */
const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const KEY_BYTES = [...Buffer.from(KEY, 'base64url')];
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/endpoint-SECRET-token-0001';
const P256DH = 'BP256dh-SECRET-key-value-for-the-smoke-only-000000000000000000000000000000000000000';
const AUTH = 'auth-SECRET-0001';
const SECRETS = ['endpoint-SECRET', P256DH, AUTH, KEY];
const noLeak = (what: string) => {
  const bad = appLogs.filter((line) => SECRETS.some((s) => line.includes(s)));
  assert(bad.length === 0, `${what}: a log line holds the endpoint or a key: ${show(bad)}`);
};

// ---- The browser's push stack ----

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
};
interface Device {
  ua: string;
  touch: number;
  standalone: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  /** Notification.permission now, and what the prompt answers. */
  permission: 'default' | 'granted' | 'denied';
  answer: 'default' | 'granted' | 'denied';
  /** The worker is installed already (and active); else how register() goes. */
  registered: boolean;
  worker: 'installs' | 'redundant';
  /** The browser holds a subscription (made with FamCal's key, or another one). */
  subscribed: boolean;
  otherKey: boolean;
  subscribeError: string | null;
  unsubscribeOk: boolean;
}
const BASE: Device = { ua: UA.android, touch: 5, standalone: false, serviceWorker: true, pushManager: true, permission: 'default', answer: 'granted', registered: false, worker: 'installs', subscribed: false, otherKey: false, subscribeError: null, unsubscribeOk: true };
let dev: Device = { ...BASE };
/** What the browser and the server were asked, in order. */
const steps: string[] = [];
let subscribeOptions: Row | null = null;
let current: Row | null = null;
let registration: Row | null = null;

function subscriptionWith(key: number[]): Row {
  const sub: Row = {
    endpoint: ENDPOINT,
    options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(key).buffer },
    toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } }),
    unsubscribe: async () => {
      steps.push('unsubscribe');
      if (dev.unsubscribeOk && current === sub) current = null;
      return dev.unsubscribeOk;
    },
  };
  return sub;
}

function makeRegistration(start: 'activated' | 'installs' | 'redundant'): Row {
  const worker: Row = { state: start === 'activated' ? 'activated' : 'installing', listeners: [] as (() => void)[] };
  worker.addEventListener = (_type: string, fn: () => void) => void worker.listeners.push(fn);
  worker.removeEventListener = (_type: string, fn: () => void) => {
    worker.listeners = worker.listeners.filter((f: () => void) => f !== fn);
  };
  if (start !== 'activated') {
    setTimeout(() => {
      worker.state = start === 'installs' ? 'activated' : 'redundant';
      for (const fn of [...worker.listeners]) fn();
    }, 0);
  }
  return {
    scope: 'https://famcal.bot/',
    get active() {
      return worker.state === 'activated' ? worker : null;
    },
    get installing() {
      return worker.state === 'installing' ? worker : null;
    },
    waiting: null,
    pushManager: {
      getSubscription: async () => {
        steps.push('getSubscription');
        return current;
      },
      subscribe: async (options: Row) => {
        steps.push('subscribe');
        subscribeOptions = options;
        if (dev.subscribeError) throw Object.assign(new Error('the browser refused'), { name: dev.subscribeError });
        current = subscriptionWith([...new Uint8Array(options.applicationServerKey)]);
        return current;
      },
    },
  };
}

function installDevice(over: Partial<Device> = {}) {
  dev = { ...BASE, ...over };
  steps.length = 0;
  subscribeOptions = null;
  registration = dev.registered ? makeRegistration('activated') : null;
  current = dev.subscribed ? subscriptionWith(dev.otherKey ? KEY_BYTES.map((b) => b ^ 1) : KEY_BYTES) : null;
  const container = {
    register: async (url: string, options: Row) => {
      steps.push(`register ${url} ${options?.scope}`);
      registration ??= makeRegistration(dev.worker);
      return registration;
    },
    getRegistration: async (scope: string) => {
      steps.push(`getRegistration ${scope}`);
      return registration ?? undefined;
    },
  };
  fakeWindow.navigator = { userAgent: dev.ua, maxTouchPoints: dev.touch, ...(dev.standalone ? { standalone: true } : {}), ...(dev.serviceWorker ? { serviceWorker: container } : {}) };
  if (dev.pushManager) fakeWindow.PushManager = function PushManager() {};
  else delete fakeWindow.PushManager;
  fakeWindow.Notification = {
    get permission() {
      return dev.permission;
    },
    requestPermission: () => {
      steps.push('requestPermission');
      dev.permission = dev.answer;
      return Promise.resolve(dev.answer);
    },
  };
  fakeWindow.matchMedia = (query: string) => ({ matches: query === '(display-mode: standalone)' && dev.standalone, addEventListener: () => undefined, removeEventListener: () => undefined });
}

// ---- The server: a scripted fetch ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };
type Call = { url: string; path: string; method: string; headers: Record<string, string>; body: Row | null; credentials?: string };
const calls: Call[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const CONNECT_URL = 'https://t.me/test_bot?start=w_AbCdEfGhIjKlMnOpQrStUv';
/** A browser-only account signed in with Google in this browser (no chat). */
const NO_CHAT_VIEW: Row = { telegram: false, google: { address: 'dana@gmail.com' }, googleFromCalendar: null, email: null, providers: { telegram: true, google: true, email: true }, chat: false, lastWay: 'google', session: 'google' };
const server = {
  add: (): Response | Promise<Response> => json({ ok: true, count: 1 }),
  check: (): Response => json({ ok: true, mine: true }),
  remove: (): Response => json({ ok: true }),
  signout: (): Response => json({ ok: true }),
  signoutAll: (): Response => json({ ok: true }),
  connect: (): Response => json({ url: CONNECT_URL }),
  view: NO_CHAT_VIEW,
};
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  const parsed = new URL(url, 'https://famcal.bot');
  const call: Call = { url, path: parsed.pathname, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string> | undefined) }, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, credentials: init.credentials };
  calls.push(call);
  steps.push(`${call.method} ${call.path}`);
  if (call.path === '/api/push/devices' && call.method === 'POST') return server.add();
  if (call.path === '/api/push/devices' && call.method === 'DELETE') return server.remove();
  if (call.path === '/api/push/devices/check' && call.method === 'POST') return server.check();
  if (call.path === '/api/auth/signout' && call.method === 'POST') return server.signout();
  if (call.path === '/api/auth/signout-all' && call.method === 'POST') return server.signoutAll();
  if (call.path === '/api/signin-methods' && call.method === 'GET') return json(server.view);
  if (call.path === '/api/telegram-connect' && call.method === 'POST') return server.connect();
  throw new TypeError(`Failed to fetch: an unexpected request ${call.method} ${url}`);
}) as typeof fetch;
const callsTo = (pathname: string, method?: string) => calls.filter((c) => c.path === pathname && (!method || c.method === method));
const assigned: string[] = [];

/** A fresh browser tab (no Telegram), a fresh device and a fresh server. */
function reset(device: Partial<Device> = {}, view: Row = NO_CHAT_VIEW) {
  calls.length = 0;
  assigned.length = 0;
  appLogs.length = 0;
  server.add = () => json({ ok: true, count: 1 });
  server.check = () => json({ ok: true, mine: true });
  server.remove = () => json({ ok: true });
  server.signout = () => json({ ok: true });
  server.signoutAll = () => json({ ok: true });
  server.connect = () => json({ url: CONNECT_URL });
  server.view = view;
  installWindow();
  fakeWindow.Telegram = undefined;
  fakeWindow.location = { hash: '', origin: 'https://famcal.bot', href: 'https://famcal.bot/settings?user_id=1', assign: (u: string) => void assigned.push(u) };
  fakeWindow.localStorage = memoryStorage();
  fakeWindow.sessionStorage = memoryStorage();
  installDevice(device);
}

// ---- Reading the page ----

function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
// A no-break space (Russian's) is kept as it is: the words are compared with the messages'
const flat = (node: FakeNode) => visible(node).replace(/[^\S\u00a0]+/g, ' ').replace(/^[^\S\u00a0]+|[^\S\u00a0]+$/g, '');
const page = (m: Mounted) => flat(m.container);
const buttonsOf = (node: FakeNode) => elements(node).filter((e) => e.localName === 'button');
const buttonsNamed = (node: FakeNode, text: string) => buttonsOf(node).filter((b) => flat(b) === text);
const sectionLabels = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'h2' && e.className === 'ch-section-label').map(flat);
const switchTexts = (m: Mounted) => byRole(m.container, 'switch').map(flat);
const notices = (m: Mounted) => elements(m.container).filter((e) => e.className.split(' ').includes('ch-notice')).map(flat);
const pushSwitch = (m: Mounted, locale: Locale) =>
  byRole(m.container, 'switch').find((s) => ['switchOff', 'switchOn', 'again', 'checking', 'turningOn', 'turningOff'].some((k) => flat(s).startsWith(p(locale, k))));
const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
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
const PUSH = { key: KEY, recentSignIn: true, devices: 0 };
/** Settings for a browser-only account (no chat) on a plan whose text summaries are counted (10 a month). */
const settingsProps = (locale: Locale, over: Row = {}): Row => ({
  userId: 1,
  currentSettings: settingsValues(locale),
  weekStart: 0,
  remindersGloballyEnabled: true,
  googleConnected: false,
  nativeRemindersSupported: false,
  subscriptionInfo: { effectivePlan: 'PRO', textSummariesUsed: 3, textSummariesLimit: 10, voiceSummariesUsed: 0, voiceSummariesLimit: -1, remindersAllowed: true, isTrialing: true },
  bothChannels: false,
  hasChat: false,
  push: PUSH,
  ...over,
});
const bannerProps = (locale: Locale, over: Row = {}): Row => ({
  googleState: 'none',
  googleConnected: false,
  reconnect: null,
  inTelegram: false,
  hasTelegram: false,
  hasChat: false,
  connectClosed: false,
  onCloseConnect: () => undefined,
  userId: 41,
  locale,
  onNavigate: () => undefined,
  push: PUSH,
  ...over,
});
const BANNER_KEYS = ['calendarHome.banner.pushTitle', 'calendarHome.banner.pushBody', 'calendarHome.banner.pushAction'];

async function main() {
  const client = await import('../src/lib/web-push-client');
  const { usePushDevice } = await import('../src/lib/use-push-device');
  const { signInAgain } = await import('../src/lib/sign-in-again');
  const { HomeBanners, homeBanners, pushBannerOf } = await import('../app/[locale]/(app)/dashboard/HomeBanners');
  const Settings = (await import('../app/[locale]/(app)/settings/SettingsClient')).default as unknown as (props: Row) => ReactElement;
  const { pushSupport, turnOnPush, turnOffPush, checkPushOnOpen, currentPushEndpoint } = client;

  const inApp = (locale: Locale, el: ReactElement) =>
    createElement(AppRouterContext.Provider, { value: router }, createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, el));
  const mountIn = (locale: Locale, component: (p: Row) => ReactElement, props: Row): Mounted => mount(inApp(locale, createElement(component, props)));
  /** The home's own two lines around its banners (CalendarHome; W15 holds the home to them). */
  function BannersHost(props: Row) {
    const device = usePushDevice(props.userId, props.push, props.locale);
    return createElement(HomeBanners as never, { ...props, pushBanner: pushBannerOf(props.push, device), pushDevice: device });
  }
  const banner = (m: Mounted) => elements(m.container).find((e) => e.getAttribute('data-banner') === 'connectTelegram') ?? null;

  await check('W1 pushSupport: Chrome on Android and desktop Safari can; an iPhone or an iPad (a Mac with touch) in a tab gets the Home Screen steps; on the Home Screen it can, unless it has no PushManager; no service worker, no PushManager or no navigator can\'t', () => {
    const cases: [string, Partial<Device>, string][] = [
      ['Chrome on Android', {}, 'supported'],
      ['desktop Safari (a Mac with no touch)', { ua: UA.mac, touch: 0 }, 'supported'],
      ['an iPhone in a Safari tab', { ua: UA.iphone }, 'ios-install'],
      ['an iPad in a Safari tab (it says Mac, with touch)', { ua: UA.mac, touch: 5 }, 'ios-install'],
      ['an iPhone, FamCal on the Home Screen', { ua: UA.iphone, standalone: true }, 'supported'],
      ['an iPhone on the Home Screen with no PushManager (before iOS 16.4)', { ua: UA.iphone, standalone: true, pushManager: false }, 'unsupported'],
      ['no service workers', { serviceWorker: false }, 'unsupported'],
      ['no PushManager', { pushManager: false }, 'unsupported'],
    ];
    for (const [what, device, want] of cases) {
      reset(device);
      assert(pushSupport() === want, `${what}: ${pushSupport()}, want ${want}`);
      assert(steps.length === 0, `${what}: asked the browser ${show(steps)}`);
    }
    reset();
    fakeWindow.navigator = undefined;
    assert(pushSupport() === 'unsupported', 'no navigator');
  });

  await check('W2 turnOnPush: the prompt and the install start in the tap (before any await); /sw.js at scope /; subscribe with userVisibleOnly and FamCal\'s key; one POST /api/push/devices?user_id=7 (same origin, JSON { endpoint, keys }, no initData) and its count; a held subscription with the same key is reused, one with another key is made again', async () => {
    reset();
    const pending = turnOnPush(7, KEY);
    assert(show(steps) === show(['getRegistration /', 'requestPermission']), `still inside the tap: ${show(steps)}`);
    const result = await pending;
    assert(show(result) === show({ ok: true, count: 1 }), `the result ${show(result)}`);
    assert(show(steps) === show(['getRegistration /', 'requestPermission', 'register /sw.js /', 'getSubscription', 'subscribe', 'POST /api/push/devices']), `the steps ${show(steps)}`);
    assert(subscribeOptions?.userVisibleOnly === true && show([...new Uint8Array(subscribeOptions.applicationServerKey)]) === show(KEY_BYTES), 'the subscribe options');
    const [post, ...more] = calls;
    assert(post && more.length === 0 && post.url === '/api/push/devices?user_id=7' && post.method === 'POST' && post.credentials === 'same-origin', `the request ${show(calls)}`);
    assert(post.headers['Content-Type'] === 'application/json' && !('X-Telegram-Init-Data' in post.headers), `headers ${show(post.headers)}`);
    assert(show(post.body) === show({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } }), `the body ${show(post.body)}`);
    assert(current !== null && appLogs.length === 0, `kept, nothing logged: ${show(appLogs)}`);

    reset({ permission: 'granted', registered: true, subscribed: true });
    server.add = () => json({ ok: true, count: 3 });
    assert(show(await turnOnPush(7, KEY)) === show({ ok: true, count: 3 }), 'reused');
    assert(show(steps) === show(['getRegistration /', 'getSubscription', 'POST /api/push/devices']), `a held subscription is reused, no prompt: ${show(steps)}`);

    reset({ permission: 'granted', registered: true, subscribed: true, otherKey: true });
    assert((await turnOnPush(7, KEY)).ok === true, 'made again');
    assert(show(steps) === show(['getRegistration /', 'getSubscription', 'unsubscribe', 'subscribe', 'POST /api/push/devices']), `another key is made again: ${show(steps)}`);
    noLeak('W2');
  });

  await check('W3 turnOnPush\'s refusals: blocked before (no prompt, nothing installed), blocked at the prompt, not answered, a tap of its own, a failed subscribe, a worker that never installs, the server\'s stale sign-in (403 and 401), has-chat, push-off, bad input, a suspension and no answer; after any server answer but ok the browser holds no subscription; each is logged, never with the endpoint or a key', async () => {
    const cases: [string, Partial<Device>, (() => Response) | null, string, boolean][] = [
      ['blocked before', { permission: 'denied' }, null, 'denied', false],
      ['blocked at the prompt', { answer: 'denied' }, null, 'denied', false],
      ['not answered', { answer: 'default' }, null, 'dismissed', false],
      ['a tap of its own', { subscribeError: 'NotAllowedError' }, null, 'again', false],
      ['a failed subscribe', { subscribeError: 'AbortError' }, null, 'failed', false],
      ['a worker that never installs', { worker: 'redundant' }, null, 'failed', false],
      ['stale sign-in', {}, () => json({ ok: false, error: 'stale-sign-in' }, 403), 'stale', true],
      ['a session that ended', {}, () => json({ error: 'Session ended' }, 401), 'stale', true],
      ['has a chat', {}, () => json({ ok: false, error: 'has-chat' }, 409), 'refused', true],
      ['push is off', {}, () => json({ ok: false, error: 'push-off' }, 503), 'failed', true],
      ['bad input', {}, () => json({ error: 'bad-input' }, 400), 'failed', true],
      ['suspended', {}, () => json({ error: 'Account suspended' }, 403), 'failed', true],
      ['no answer', {}, () => { throw new TypeError('Failed to fetch'); }, 'failed', true],
    ];
    for (const [what, device, answer, reason, posted] of cases) {
      reset(device);
      if (answer) server.add = answer;
      const result = await turnOnPush(7, KEY);
      assert(show(result) === show({ ok: false, reason }), `${what}: ${show(result)}, want ${reason}`);
      assert(callsTo('/api/push/devices', 'POST').length === (posted ? 1 : 0), `${what}: posted ${callsTo('/api/push/devices', 'POST').length}`);
      if (posted) assert(current === null && steps.includes('unsubscribe'), `${what}: the browser still holds the subscription: ${show(steps)}`);
      assert(appLogs.some((l) => l.startsWith('[web-push]')), `${what}: not logged`);
      noLeak(what);
    }
    reset({ permission: 'denied' });
    await turnOnPush(7, KEY);
    assert(steps.length === 0, `blocked before: asked ${show(steps)}`);
    reset({ subscribeError: 'NotAllowedError' });
    await turnOnPush(7, KEY);
    assert(!steps.includes('subscribe') || calls.length === 0, 'a tap of its own posts nothing');
  });

  await check('W4 turnOffPush and currentPushEndpoint: unsubscribe, then DELETE /api/push/devices?user_id=7 with { endpoint }; with no user id no DELETE; nothing held: no request; a failed DELETE still leaves the browser off; a browser that kept its subscription and a failed DELETE is not off; neither ever installs the worker', async () => {
    reset({ registered: true, subscribed: true, permission: 'granted' });
    assert((await currentPushEndpoint()) === ENDPOINT, 'the endpoint');
    steps.length = 0;
    assert((await turnOffPush(7)) === true, 'off');
    assert(show(steps) === show(['getRegistration /', 'getSubscription', 'unsubscribe', 'DELETE /api/push/devices']), `the steps ${show(steps)}`);
    const [del] = callsTo('/api/push/devices', 'DELETE');
    assert(del.url === '/api/push/devices?user_id=7' && del.credentials === 'same-origin' && show(del.body) === show({ endpoint: ENDPOINT }), `the DELETE ${show(del)}`);
    assert(current === null && (await currentPushEndpoint()) === null, 'nothing held after');

    reset({ registered: true, subscribed: true });
    assert((await turnOffPush(null)) === true && callsTo('/api/push/devices').length === 0 && current === null, 'no user id: the browser only');

    reset({ registered: true });
    assert((await turnOffPush(7)) === true && calls.length === 0, 'nothing held: no request');
    reset();
    assert((await turnOffPush(7)) === true && show(steps) === show(['getRegistration /']), `no worker: ${show(steps)}`);

    reset({ registered: true, subscribed: true });
    server.remove = () => json({}, 500);
    assert((await turnOffPush(7)) === true && current === null, 'a failed DELETE still leaves the browser off');
    assert(appLogs.some((l) => l.startsWith('[web-push]')), 'the failed DELETE is logged');

    reset({ registered: true, subscribed: true, unsubscribeOk: false });
    server.remove = () => json({}, 500);
    assert((await turnOffPush(7)) === false, 'kept by the browser and not deleted: not off');
    reset({ registered: true, subscribed: true, unsubscribeOk: false });
    assert((await turnOffPush(7)) === true, 'kept by the browser but deleted on the server: off');
    assert(!steps.some((s) => s.startsWith('register')), 'never installs');
    noLeak('W4');
  });

  await check('W5 checkPushOnOpen: no worker: off, nothing installed, no request; this account\'s: on (POST /api/push/devices/check?user_id=7 with { endpoint }); another account\'s: undone and off; no answer or a 500: off and nothing undone; a browser that can\'t: off, nothing asked', async () => {
    reset();
    assert((await checkPushOnOpen(7)) === 'off' && show(steps) === show(['getRegistration /']), `no worker: ${show(steps)}`);
    reset({ registered: true, subscribed: true });
    assert((await checkPushOnOpen(7)) === 'on', 'mine');
    const [call] = callsTo('/api/push/devices/check');
    assert(call.url === '/api/push/devices/check?user_id=7' && call.method === 'POST' && show(call.body) === show({ endpoint: ENDPOINT }) && current !== null, `the check ${show(call)}`);
    reset({ registered: true, subscribed: true });
    server.check = () => json({ ok: true, mine: false });
    assert((await checkPushOnOpen(7)) === 'off' && current === null && steps.includes('unsubscribe'), 'another account\'s is undone');
    for (const [what, answer] of [['500', () => json({}, 500)], ['no answer', () => { throw new TypeError('Failed to fetch'); }]] as [string, () => Response][]) {
      reset({ registered: true, subscribed: true });
      server.check = answer;
      assert((await checkPushOnOpen(7)) === 'off' && current !== null && !steps.includes('unsubscribe'), `${what}: nothing undone`);
    }
    reset({ serviceWorker: false });
    assert((await checkPushOnOpen(7)) === 'off' && steps.length === 0, 'a browser that can\'t');
    noLeak('W5');
  });

  await check('W6 Settings, off to on and back (en, he, ru): the card right above Sign in on the web; "Turn on notifications" with its line; the tap turns it on; the rows a notification can honour come back (the summary switch with its push hint and no count, the hours and days, the alerts with the push hint and their rows, the pause), voice, weather, the week ahead, 7 days and voice input stay hidden, the note card goes; off again deletes the device and the page is as before', async () => {
    for (const locale of LOCALES) {
      reset();
      const m = mountIn(locale, Settings, settingsProps(locale));
      await settle();
      try {
        const plain = [at(locale, 'settings.sections.place'), p(locale, 'title'), at(locale, 'settings.signIn.title')];
        assert(show(sectionLabels(m)) === show(plain), `${locale}: the sections ${show(sectionLabels(m))}`);
        assert(show(steps) === show(['getRegistration /', 'GET /api/signin-methods']) || show(steps) === show(['GET /api/signin-methods', 'getRegistration /']), `${locale}: the open asked ${show(steps)}`);
        const off = pushSwitch(m, locale);
        assert(off && off.getAttribute('aria-checked') === 'false' && flat(off) === `${p(locale, 'switchOff')}${p(locale, 'offHint')}`, `${locale}: the switch ${off && flat(off)}`);
        assert(page(m).includes(p(locale, 'noteTitle')) && page(m).includes(p(locale, 'noteBody')) && !page(m).includes(at(locale, 'settings.noChat.title')), `${locale}: the note card's words with push set up`);
        assert(!switchTexts(m).some((s) => s.startsWith(at(locale, 'settings.pause.label'))), `${locale}: the pause shows before a device is on`);

        m.click(off);
        await settle();
        const on = pushSwitch(m, locale);
        assert(on && on.getAttribute('aria-checked') === 'true' && flat(on) === `${p(locale, 'switchOn')}${p(locale, 'onHint')}`, `${locale}: on ${on && flat(on)}`);
        assert(callsTo('/api/push/devices', 'POST').length === 1, `${locale}: one POST`);
        const full = ['place', 'summaries', 'timing', 'events'].map((k) => at(locale, `settings.sections.${k}`)).concat(p(locale, 'title'), at(locale, 'settings.signIn.title'));
        assert(show(sectionLabels(m)) === show(full), `${locale}: the rows back ${show(sectionLabels(m))}`);
        const texts = switchTexts(m);
        assert(texts.includes(`${at(locale, 'settings.text.label')}${p(locale, 'textHint')}`), `${locale}: the summary switch with the push hint and no count: ${show(texts)}`);
        assert(texts.some((s) => s.startsWith(at(locale, 'settings.pause.label'))), `${locale}: the pause`);
        assert(texts.some((s) => s === `${at(locale, 'settings.alerts.label')}${p(locale, 'alertsHint')}`), `${locale}: the alerts with the push hint: ${show(texts)}`);
        assert(texts.some((s) => s.startsWith(at(locale, 'settings.pickup.label'))), `${locale}: pickups (alerts are on)`);
        for (const key of ['voice.label', 'weather.label', 'weekAhead.label', 'sevenDays.label', 'voiceInput.label']) {
          assert(!texts.some((s) => s.startsWith(at(locale, `settings.${key}`))), `${locale}: ${key} shows`);
        }
        assert(page(m).includes(at(locale, 'settings.morning.label')) && page(m).includes(at(locale, 'settings.defaultAlert.label')), `${locale}: the hours and the default alert`);
        assert(!page(m).includes(p(locale, 'noteTitle')) && buttonsNamed(m.container, at(locale, 'telegramConnect.action')).length === 1, `${locale}: the note card is gone; Connect Telegram stays in Sign in on the web`);

        m.click(on);
        await settle();
        assert(pushSwitch(m, locale)?.getAttribute('aria-checked') === 'false', `${locale}: off again`);
        assert(callsTo('/api/push/devices', 'DELETE').length === 1 && current === null, `${locale}: the device deleted and the browser unsubscribed`);
        assert(show(sectionLabels(m)) === show(plain) && page(m).includes(p(locale, 'noteTitle')), `${locale}: as before ${show(sectionLabels(m))}`);
        noLeak(locale);
      } finally {
        m.unmount();
      }
    }
  });

  await check('W7 a stale sign-in: no switch; "Sign in again to turn on notifications" and the hour\'s note; nothing asked of the browser but the open\'s read; its press signs out and opens /signin; a stale answer from the server turns the switch into Sign in again and leaves no subscription', async () => {
    for (const locale of LOCALES) {
      reset();
      const m = mountIn(locale, Settings, settingsProps(locale, { push: { ...PUSH, recentSignIn: false } }));
      await settle();
      try {
        assert(!pushSwitch(m, locale), `${locale}: a switch`);
        const again = buttonsNamed(m.container, p(locale, 'signInAgain'));
        assert(again.length === 1 && notices(m).includes(p(locale, 'staleNote')), `${locale}: Sign in again and the note: ${show(buttonsOf(m.container).map(flat))}`);
        m.click(again[0]);
        await settle();
        assert(callsTo('/api/auth/signout').length === 1 && show(assigned) === show([signInPath(locale)]), `${locale}: signed out and /signin: ${show(assigned)}`);
        assert(!steps.includes('requestPermission') && !steps.some((s) => s.startsWith('register')) && callsTo('/api/push/devices').length === 0, `${locale}: the browser was asked ${show(steps)}`);
      } finally {
        m.unmount();
      }
    }
    reset();
    server.add = () => json({ ok: false, error: 'stale-sign-in' }, 403);
    const m = mountIn('en', Settings, settingsProps('en'));
    await settle();
    try {
      m.click(pushSwitch(m, 'en') as FakeElement);
      await settle();
      assert(buttonsNamed(m.container, p('en', 'signInAgain')).length === 1 && !pushSwitch(m, 'en') && current === null, 'the server\'s stale answer');
    } finally {
      m.unmount();
    }
  });

  await check('W8 a second tap: a browser that wants a tap of its own for the subscribe says "Tap again to allow" and posts nothing; the next tap turns it on', async () => {
    for (const locale of LOCALES) {
      reset({ subscribeError: 'NotAllowedError' });
      const m = mountIn(locale, Settings, settingsProps(locale));
      await settle();
      try {
        m.click(pushSwitch(m, locale) as FakeElement);
        await settle();
        const again = pushSwitch(m, locale);
        assert(again && flat(again).startsWith(p(locale, 'again')) && again.getAttribute('aria-checked') === 'false', `${locale}: ${again && flat(again)}`);
        assert(callsTo('/api/push/devices', 'POST').length === 0, `${locale}: posted`);
        dev.subscribeError = null;
        m.click(again);
        await settle();
        assert(pushSwitch(m, locale)?.getAttribute('aria-checked') === 'true' && callsTo('/api/push/devices', 'POST').length === 1, `${locale}: on after the second tap`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('W9 the lines, the switch staying off: not answered and blocked as notes, refused and failed as alerts; blocked shows at the open, and its tap asks nothing; a failed turn off keeps the switch on with its alert', async () => {
    const cases: [string, Partial<Device>, (() => Response) | null, string, boolean][] = [
      ['not answered', { answer: 'default' }, null, 'dismissed', false],
      ['blocked at the prompt', { answer: 'denied' }, null, 'denied', false],
      ['refused (a chat now)', {}, () => json({ ok: false, error: 'has-chat' }, 409), 'refused', true],
      ['failed', {}, () => json({}, 500), 'failed', true],
    ];
    for (const locale of LOCALES) {
      for (const [what, device, answer, key, problem] of cases) {
        reset(device);
        if (answer) server.add = answer;
        const m = mountIn(locale, Settings, settingsProps(locale));
        await settle();
        try {
          m.click(pushSwitch(m, locale) as FakeElement);
          await settle();
          assert(pushSwitch(m, locale)?.getAttribute('aria-checked') === 'false', `${locale} ${what}: the switch is on`);
          const line = elements(m.container).find((e) => e.className.split(' ').includes('ch-notice') && flat(e) === p(locale, key));
          assert(line && (line.getAttribute('role') === 'alert') === problem, `${locale} ${what}: the line ${show(notices(m))}`);
        } finally {
          m.unmount();
        }
      }
    }
    reset({ permission: 'denied' });
    const blocked = mountIn('he', Settings, settingsProps('he'));
    await settle();
    try {
      assert(notices(blocked).includes(p('he', 'denied')), `blocked at the open: ${show(notices(blocked))}`);
      blocked.click(pushSwitch(blocked, 'he') as FakeElement);
      await settle();
      assert(!steps.includes('requestPermission') && notices(blocked).includes(p('he', 'denied')), 'its tap asks nothing');
    } finally {
      blocked.unmount();
    }
    reset({ registered: true, subscribed: true, permission: 'granted', unsubscribeOk: false });
    server.remove = () => json({}, 500);
    const stuck = mountIn('ru', Settings, settingsProps('ru', { push: { ...PUSH, devices: 1 } }));
    await settle();
    try {
      stuck.click(pushSwitch(stuck, 'ru') as FakeElement);
      await settle();
      assert(pushSwitch(stuck, 'ru')?.getAttribute('aria-checked') === 'true' && notices(stuck).includes(p('ru', 'offFailed')), `a failed turn off: ${show(notices(stuck))}`);
    } finally {
      stuck.unmount();
    }
  });

  await check('W10 at the open: this account\'s subscription shows on, with the rows back from the page\'s count; another account\'s (a shared browser) is undone, shows off, and the page\'s count of other devices still brings the rows', async () => {
    reset({ registered: true, subscribed: true, permission: 'granted' });
    const mine = mountIn('en', Settings, settingsProps('en', { push: { ...PUSH, devices: 1 } }));
    await settle();
    try {
      assert(pushSwitch(mine, 'en')?.getAttribute('aria-checked') === 'true' && sectionLabels(mine).includes(at('en', 'settings.sections.summaries')), 'on, the rows back');
      assert(!steps.some((s) => s.startsWith('register')) && callsTo('/api/push/devices/check').length === 1, `the open never installs: ${show(steps)}`);
    } finally {
      mine.unmount();
    }
    reset({ registered: true, subscribed: true, permission: 'granted' });
    server.check = () => json({ ok: true, mine: false });
    const other = mountIn('en', Settings, settingsProps('en', { push: { ...PUSH, devices: 2 } }));
    await settle();
    try {
      assert(pushSwitch(other, 'en')?.getAttribute('aria-checked') === 'false' && current === null && callsTo('/api/push/devices', 'POST').length === 0, 'another account\'s is undone, nothing added');
      assert(sectionLabels(other).includes(at('en', 'settings.sections.summaries')), 'the account\'s other devices keep the rows');
    } finally {
      other.unmount();
    }
  });

  await check('W11 iPhone and iPad in a tab: the three Home Screen steps and no switch, nothing asked of the browser; a browser that can\'t: one line; push off (key null) and no push (null): no card, and the note card as before', async () => {
    for (const locale of LOCALES) {
      reset({ ua: UA.iphone });
      const m = mountIn(locale, Settings, settingsProps(locale));
      await settle();
      try {
        assert(sectionLabels(m).includes(p(locale, 'title')) && !pushSwitch(m, locale), `${locale}: the card with no switch`);
        const items = elements(m.container).filter((e) => e.localName === 'li').map(flat);
        assert(show(items) === show(['ios.step1', 'ios.step2', 'ios.step3'].map((k) => p(locale, k))), `${locale}: the steps ${show(items)}`);
        assert(page(m).includes(p(locale, 'ios.title')) && page(m).includes(p(locale, 'ios.body')), `${locale}: the title and the line`);
        assert(!steps.some((s) => s.startsWith('getRegistration') || s.startsWith('register')), `${locale}: asked ${show(steps)}`);
      } finally {
        m.unmount();
      }
    }
    reset({ ua: UA.mac, touch: 5 });
    const ipad = mountIn('en', Settings, settingsProps('en'));
    await settle();
    try {
      assert(page(ipad).includes(p('en', 'ios.title')) && !pushSwitch(ipad, 'en'), 'an iPad is an iPhone here');
    } finally {
      ipad.unmount();
    }
    reset({ serviceWorker: false });
    const cant = mountIn('ru', Settings, settingsProps('ru'));
    await settle();
    try {
      assert(page(cant).includes(p('ru', 'unsupported')) && !pushSwitch(cant, 'ru') && steps.every((s) => s.startsWith('GET ')), 'a browser that can\'t');
    } finally {
      cant.unmount();
    }
    for (const push of [{ ...PUSH, key: null }, null]) {
      reset();
      const none = mountIn('en', Settings, settingsProps('en', { push }));
      await settle();
      try {
        assert(!sectionLabels(none).includes(p('en', 'title')) && page(none).includes(at('en', 'settings.noChat.title')) && page(none).includes(at('en', 'settings.noChat.body')), `${show(push)}: a card, or the new note`);
        assert(!steps.some((s) => s.startsWith('getRegistration')), `${show(push)}: Settings read the browser`);
      } finally {
        none.unmount();
      }
    }
  });

  await check('W12 the home banner: "Get reminders on this device" with Turn on, Connect Telegram and the close; Turn on turns this device on and the banner goes; on at the open it never shows; a stale sign-in reads Sign in again with the hour\'s note; the iPhone steps with no Turn on; a browser that can\'t and push off keep Connect Telegram; closed stays closed; not answered is a line under it; its Connect Telegram asks for the bot link; a chat account\'s open undoes another account\'s subscription; inside Telegram nothing is read', async () => {
    for (const locale of LOCALES) {
      reset();
      const m = mountIn(locale, BannersHost, bannerProps(locale));
      await settle();
      try {
        const b = banner(m);
        assert(b && b.getAttribute('data-push') === 'offer', `${locale}: no push banner`);
        assert(flat(b).includes(at(locale, 'calendarHome.banner.pushTitle')) && flat(b).includes(at(locale, 'calendarHome.banner.pushBody')), `${locale}: the words ${flat(b)}`);
        const names = buttonsOf(b).map(flat);
        assert(names.includes(at(locale, 'calendarHome.banner.pushAction')) && names.includes(at(locale, 'telegramConnect.action')), `${locale}: the actions ${show(names)}`);
        assert(buttonsOf(b).some((x) => x.getAttribute('aria-label') === at(locale, 'calendarHome.banner.close')), `${locale}: the close`);
        m.click(buttonsNamed(b, at(locale, 'calendarHome.banner.pushAction'))[0]);
        await settle();
        assert(banner(m) === null && callsTo('/api/push/devices', 'POST').length === 1, `${locale}: on, the banner gone`);
      } finally {
        m.unmount();
      }
    }
    reset({ registered: true, subscribed: true, permission: 'granted' });
    const on = mountIn('en', BannersHost, bannerProps('en', { push: { ...PUSH, devices: 1 } }));
    await settle();
    try {
      assert(banner(on) === null, 'on at the open: no banner');
    } finally {
      on.unmount();
    }
    reset();
    const stale = mountIn('he', BannersHost, bannerProps('he', { push: { ...PUSH, recentSignIn: false } }));
    await settle();
    try {
      const b = banner(stale) as FakeElement;
      assert(buttonsNamed(b, p('he', 'signInAgain')).length === 1 && page(stale).includes(p('he', 'staleNote')), `stale: ${show(buttonsOf(b).map(flat))}`);
      stale.click(buttonsNamed(b, p('he', 'signInAgain'))[0]);
      await settle();
      assert(show(assigned) === show(['/he/signin']) && !steps.includes('requestPermission'), 'stale: signs in again, asks the browser nothing');
    } finally {
      stale.unmount();
    }
    reset({ ua: UA.iphone });
    const ios = mountIn('ru', BannersHost, bannerProps('ru'));
    await settle();
    try {
      const b = banner(ios) as FakeElement;
      assert(b.getAttribute('data-push') === 'offer' && elements(b).filter((e) => e.localName === 'li').length === 3, 'the iPhone steps');
      assert(buttonsNamed(b, at('ru', 'calendarHome.banner.pushAction')).length === 0 && buttonsNamed(b, at('ru', 'telegramConnect.action')).length === 1, 'no Turn on; Connect Telegram');
    } finally {
      ios.unmount();
    }
    for (const [what, device, over] of [
      ['a browser that can\'t', { serviceWorker: false }, {}],
      ['push off', {}, { push: { ...PUSH, key: null } }],
    ] as [string, Partial<Device>, Row][]) {
      reset(device);
      const old = mountIn('en', BannersHost, bannerProps('en', over));
      await settle();
      try {
        const b = banner(old);
        assert(b && b.getAttribute('data-push') === null && flat(b).includes(at('en', 'telegramConnect.action')) && flat(b).includes(at('en', 'calendarHome.banner.connectTelegramBody')), `${what}: the Connect Telegram banner ${b && flat(b)}`);
      } finally {
        old.unmount();
      }
    }
    reset();
    const closed = mountIn('en', BannersHost, bannerProps('en', { connectClosed: true }));
    await settle();
    try {
      assert(banner(closed) === null, 'closed stays closed');
    } finally {
      closed.unmount();
    }
    reset({ answer: 'default' });
    const unanswered = mountIn('en', BannersHost, bannerProps('en'));
    await settle();
    try {
      unanswered.click(buttonsNamed(banner(unanswered) as FakeElement, at('en', 'calendarHome.banner.pushAction'))[0]);
      await settle();
      assert(banner(unanswered) !== null && elements(unanswered.container).some((e) => e.className.startsWith('ch-banner-line') && flat(e) === p('en', 'dismissed')), 'not answered: a line under the banner');
      unanswered.click(buttonsNamed(banner(unanswered) as FakeElement, at('en', 'telegramConnect.action'))[0]);
      await settle();
      assert(callsTo('/api/telegram-connect').length === 1, 'its Connect Telegram asks for the link');
    } finally {
      unanswered.unmount();
    }
    reset({ registered: true, subscribed: true, permission: 'granted' });
    server.check = () => json({ ok: true, mine: false });
    const chat = mountIn('en', BannersHost, bannerProps('en', { hasChat: true, hasTelegram: true, push: null }));
    await settle();
    try {
      assert(banner(chat) === null && callsTo('/api/push/devices/check').length === 1 && current === null, 'a chat account\'s open undoes another account\'s subscription');
    } finally {
      chat.unmount();
    }
    reset({ registered: true, subscribed: true });
    fakeWindow.Telegram = { WebApp: fakeTelegram([], '7.7') };
    const inside = mountIn('en', BannersHost, bannerProps('en', { inTelegram: true, push: null }));
    await settle();
    try {
      assert(steps.length === 0 && calls.length === 0, `inside Telegram: ${show(steps)}`);
    } finally {
      inside.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('W13 the pure parts: pushBannerOf (no push or no key: none; a browser that can\'t: none; not read yet, checking, on or turning off: hidden; the iPhone steps and off, busy or stale: offer) and homeBanners with it', () => {
    const P = PUSH;
    const cases: [Row | null, string | null, string, string | undefined][] = [
      [null, 'supported', 'off', undefined],
      [{ ...P, key: null }, 'supported', 'off', undefined],
      [P, 'unsupported', 'checking', undefined],
      [P, null, 'checking', 'hidden'],
      [P, 'supported', 'checking', 'hidden'],
      [P, 'supported', 'on', 'hidden'],
      [P, 'supported', 'stopping', 'hidden'],
      [P, 'supported', 'off', 'offer'],
      [P, 'supported', 'busy', 'offer'],
      [P, 'supported', 'stale', 'offer'],
      [P, 'ios-install', 'checking', 'offer'],
    ];
    for (const [push, support, phase, want] of cases) {
      const got = pushBannerOf(push as never, { support, phase } as never);
      assert(got === want, `${show([push?.key ?? null, support, phase])}: ${got}, want ${want}`);
    }
    const base = { googleState: 'none' as const, googleConnected: false, reconnect: null, inTelegram: false, hasTelegram: false, hasChat: false };
    const ids = (over: Row) => show(homeBanners({ ...base, ...over } as never));
    assert(ids({}) === show(['connectTelegram']) && ids({ pushBanner: 'offer' }) === show(['connectTelegram']), 'shown');
    assert(ids({ pushBanner: 'hidden' }) === show([]), 'hidden while on');
    assert(ids({ pushBanner: 'offer', connectClosed: true }) === show([]) && ids({ pushBanner: 'offer', inTelegram: true }) === show([]), 'closed, or inside Telegram');
  });

  await check('W14 sign-outs on this device unsubscribe first: Sign out deletes this device then signs out and opens /signin; a failed DELETE still signs out; with nothing held only the sign-out; Sign out on all devices the same before signout-all; signInAgain unsubscribes (no user id: no DELETE) before its sign-out', async () => {
    const tail = (mark: number) => steps.slice(mark).filter((s) => s !== 'GET /api/signin-methods');
    for (const [what, device, removeAnswer] of [
      ['held', { registered: true, subscribed: true, permission: 'granted' }, () => json({ ok: true })],
      ['a failed DELETE', { registered: true, subscribed: true, permission: 'granted' }, () => json({}, 500)],
    ] as [string, Partial<Device>, () => Response][]) {
      reset(device);
      server.remove = removeAnswer;
      const m = mountIn('en', Settings, settingsProps('en', { push: { ...PUSH, devices: 1 } }));
      await settle();
      try {
        const mark = steps.length;
        m.click(buttonsNamed(m.container, at('en', 'settings.signIn.signOut'))[0]);
        await settle();
        assert(show(tail(mark)) === show(['getRegistration /', 'getSubscription', 'unsubscribe', 'DELETE /api/push/devices', 'POST /api/auth/signout']), `${what}: ${show(tail(mark))}`);
        assert(show(assigned) === show(['/signin']) && current === null, `${what}: signed out and off`);
      } finally {
        m.unmount();
      }
    }
    reset();
    const bare = mountIn('en', Settings, settingsProps('en'));
    await settle();
    try {
      const mark = steps.length;
      bare.click(buttonsNamed(bare.container, at('en', 'settings.signIn.signOut'))[0]);
      await settle();
      assert(show(tail(mark)) === show(['getRegistration /', 'POST /api/auth/signout']), `nothing held: ${show(tail(mark))}`);
    } finally {
      bare.unmount();
    }
    reset({ registered: true, subscribed: true, permission: 'granted' });
    const all = mountIn('en', Settings, settingsProps('en', { push: { ...PUSH, devices: 1 } }));
    await settle();
    try {
      const mark = steps.length;
      all.click(buttonsNamed(all.container, at('en', 'settings.signIn.signOutAll'))[0]);
      await settle();
      assert(show(tail(mark)) === show(['getRegistration /', 'getSubscription', 'unsubscribe', 'DELETE /api/push/devices', 'POST /api/auth/signout-all']), `all devices: ${show(tail(mark))}`);
    } finally {
      all.unmount();
    }
    reset({ registered: true, subscribed: true });
    assert((await signInAgain('he')) === true, 'signInAgain');
    assert(show(steps) === show(['getRegistration /', 'getSubscription', 'unsubscribe', 'POST /api/auth/signout']) && show(assigned) === show(['/he/signin']), `signInAgain: ${show(steps)}`);
    noLeak('W14');
  });

  await check('W15 the wiring: the home reads push, calls usePushDevice(userId, push, locale) and hands the banners pushBannerOf(push, pushDevice) and the device; PageGate hands the home push; Settings shows the card right above Sign in on the web; signOutHere, signOutAll and signInAgain call turnOffPush before their request', () => {
    const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const home = src('app/[locale]/(app)/dashboard/CalendarHome.tsx');
    assert(/const \{ user, locale, sources,[^}]*\bpush\b[^}]*\} = props;/.test(home), 'CalendarHome reads push');
    assert(home.includes('const pushDevice = usePushDevice(userId, push, locale);'), 'CalendarHome: the hook');
    assert(home.includes('pushBanner={pushBannerOf(push, pushDevice)}') && home.includes('pushDevice={pushDevice}'), 'CalendarHome: the banners');
    assert(src('app/[locale]/(app)/PageGate.tsx').includes('push: p.push ?? null,'), 'PageGate: the home gets push');
    assert(/\{noChat && push\?\.key \? <PushCard userId=\{userId\} push=\{push\} onDevices=\{setPushDevices\} \/> : null\}\s*<SignInMethods userId=\{userId\}/.test(src('app/[locale]/(app)/settings/SettingsClient.tsx')), 'Settings: the card right above Sign in on the web');
    const methods = src('app/[locale]/(app)/settings/signin-methods-client.ts');
    const body = (name: string) => {
      const start = methods.indexOf(`export async function ${name}(`);
      return methods.slice(start, methods.indexOf('\n}\n', start));
    };
    assert(body('signOutHere').indexOf('await turnOffPush(userId);') >= 0 && body('signOutHere').indexOf('await turnOffPush(userId);') < body('signOutHere').indexOf("post('/api/auth/signout'"), 'signOutHere unsubscribes first');
    assert(body('signOutAll').indexOf('await turnOffPush(userId);') >= 0 && body('signOutAll').indexOf('await turnOffPush(userId);') < body('signOutAll').indexOf("post('/api/auth/signout-all'"), 'signOutAll unsubscribes first');
    const again = src('src/lib/sign-in-again.ts');
    assert(again.indexOf('await turnOffPush(null);') >= 0 && again.indexOf('await turnOffPush(null);') < again.indexOf("fetch('/api/auth/signout'"), 'signInAgain unsubscribes first');
  });

  await check('W16 the words: every settings.push key and the banner\'s three in en, he and ru, none empty, no emoji, Hebrew and Russian in their own letters; in Russian no one-letter word before a plain space and no plain space before a dash; every settings.push key is read by a screen or the hook', () => {
    const leaves = (node: unknown, prefix: string): string[] =>
      typeof node === 'string' ? [prefix] : Object.entries(node as Row).flatMap(([k, v]) => leaves(v, `${prefix}.${k}`));
    const keys = [...leaves(messages.en.settings.push, 'settings.push'), ...BANNER_KEYS];
    assert(keys.length >= 28, `only ${keys.length} keys`);
    for (const locale of LOCALES) {
      assert(show(leaves(messages[locale].settings.push, 'settings.push')) === show(leaves(messages.en.settings.push, 'settings.push')), `${locale}: settings.push differs from en`);
      for (const key of keys) {
        const value = at(locale, key);
        assert(value.trim() !== '' && !/\p{Extended_Pictographic}/u.test(value), `${locale}: ${key} is empty or has an emoji`);
        if (locale === 'he') assert(/[֐-׿]/.test(value), `he: ${key} has no Hebrew: ${value}`);
        if (locale === 'ru') {
          assert(/[А-Яа-яЁё]/.test(value), `ru: ${key} has no Russian: ${value}`);
          const loose = value.match(/(?<![^\s«(„"—*])[вскоуиая] /giu);
          assert(!loose && !value.includes(' —'), `ru: ${key} needs a no-break space: ${show(loose)} in ${value}`);
        }
      }
    }
    const sources = ['app/[locale]/(app)/settings/PushCard.tsx', 'app/[locale]/(app)/settings/SettingsClient.tsx', 'app/[locale]/(app)/dashboard/HomeBanners.tsx', 'src/lib/use-push-device.ts']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .join('\n');
    for (const key of leaves(messages.en.settings.push, 'push')) assert(sources.includes(`'${key}'`), `settings.${key} is read by nothing`);
    for (const key of BANNER_KEYS) assert(sources.includes(`'${key.replace('calendarHome.', '')}'`), `${key} is read by nothing`);
  });

  await check('W17 the look: the iPhone steps are a numbered <ol> (card and banner) with the Share icon in step 1 only; the switch carries the bell at rest and aria-busy with a disabled row while turning on', async () => {
    const svgs = (node: FakeNode) => elements(node).filter((e) => e.localName === 'svg');
    reset({ ua: UA.iphone });
    const card = mountIn('en', Settings, settingsProps('en'));
    await settle();
    try {
      const lists = elements(card.container).filter((e) => e.localName === 'ol');
      const items = lists.length === 1 ? elements(lists[0]).filter((e) => e.localName === 'li') : [];
      assert(items.length === 3 && svgs(items[0]).length === 1 && svgs(items[1]).length === 0 && svgs(items[2]).length === 0, `the card's steps: ${lists.length} lists`);
    } finally {
      card.unmount();
    }
    reset({ ua: UA.iphone });
    const home = mountIn('en', BannersHost, bannerProps('en'));
    await settle();
    try {
      const b = banner(home) as FakeElement;
      const lists = elements(b).filter((e) => e.localName === 'ol');
      assert(lists.length === 1 && elements(lists[0]).filter((e) => e.localName === 'li').length === 3 && svgs(lists[0]).length === 1, 'the banner\'s steps');
    } finally {
      home.unmount();
    }
    reset();
    let release: (r: Response) => void = () => undefined;
    server.add = () => new Promise<Response>((resolve) => (release = resolve));
    const m = mountIn('en', Settings, settingsProps('en'));
    await settle();
    try {
      const off = pushSwitch(m, 'en') as FakeElement;
      assert(svgs(off).length === 1 && off.getAttribute('aria-busy') === null, 'the bell at rest');
      m.click(off);
      await settle();
      const busy = pushSwitch(m, 'en') as FakeElement;
      assert(busy.getAttribute('aria-busy') === 'true' && busy.getAttribute('aria-disabled') === 'true' && flat(busy).startsWith(p('en', 'turningOn')), `busy: ${flat(busy)}`);
      assert(elements(busy).some((e) => e.localName === 'svg' && e.className.includes('ch-spin')), 'a spinner in the row');
      m.click(busy);
      await settle();
      assert(callsTo('/api/push/devices', 'POST').length === 1, 'a second tap while busy does nothing');
      release(json({ ok: true, count: 1 }));
      await settle();
      assert(pushSwitch(m, 'en')?.getAttribute('aria-checked') === 'true' && pushSwitch(m, 'en')?.getAttribute('aria-busy') === null, 'on, not busy');
    } finally {
      m.unmount();
    }
  });

  await check('W18 React logged no warning', () => {
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
  // console.error is the warning collector above: a crash is written to stderr itself
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
