// Smoke test for the Subscription screen (plan docs/superpowers/plans/2026-10-27-app-ui-W1b-subscription-feedback-story.md,
// Task 2; spec 2026-10-19-screens-and-colours §4, §5): SubscriptionClient on AppScreen and the kit, in real React on the
// small fake DOM, with a fake Telegram.WebApp (showAlert, close), a router stub and a fake fetch. No network, no DB.
//  - U1 the render in en, he and ru, light (server) and dark (Telegram): the grouped root, the title, the current plan and the
//    plans in order, no raw key, no emoji, no Latin in he and ru beyond the brands, counts and prices left to right, the Stars
//    price as the locale writes it ("2,500", "2 500") beside a hidden sentence for a screen reader, the star icon hidden from
//    assistive tech, and the screen's own CSS clean under lintCss;
//  - U2 the state matrix: which Choose buttons each state gets (Free, trial, Basic, Pro, comped Pro, early access, and a user
//    with no Telegram), the Current tag, the one status line, the plural trial line, and that the prices are the plan's;
//  - U3 the meters: 0 to 100%, near from 80%, over the limit, unlimited rows with no meter;
//  - U4 the upgrade: one request with the body the route has always read, a tap while one is in flight sends nothing and every
//    button waits, the outcome in Telegram (a pop-up, then close) and in a browser (on the page), an error in the user's
//    language and never the server's, a throw logged;
//  - U5 Back: AppScreen is the only BackButton caller, and both backs go to the calendar;
//  - U6 React logs no warning; U7 the messages: every key of the screen is read, the bot's keys are all still there;
//  - U9 the terms before paying (the legal review of 2026-10-29, issue 4): the seller, one month that never renews, the
//    14-day full refund and the Terms before the first pay button, wherever there is one; the button agrees to the Terms;
//    the Terms open in the person's language through Telegram's openLink, or a new tab in a browser;
//  - U8 a plan card's head wraps and the plan's name keeps its words whole (a Basic user in Russian at 320 px read "Базов / ый");
//  - L1 the page loader hands the screen the calendar count (the count that enforces the limit) and whether Telegram is linked.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-subscription-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-subscription-render.ts

import fs from 'fs';
import path from 'path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { PLAN_CONFIGS } from '../src/config/plans';
import { policyUrl } from '../src/lib/plan-disclosure';
import { SELLER } from '../src/lib/seller';
import { SUBSCRIPTION_CSS } from '../app/[locale]/(app)/subscription/subscription-css';
import { lintCss } from './lib/css-lint';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

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

// ---- React must not warn; what the page itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[subscription]') || text.startsWith('[telegram-ui]')) return void appLogs.push(text);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's, and
    // neither is Redis saying it has no config (the loader check imports the real page-data, whose services build a client).
    if (text.startsWith('(node:') || text.startsWith('[Upstash Redis]')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Stubs for the loader check (L1): the services page-data reads, as scripts/smoke-activity-log.ts fakes them ----

const SRC = path.resolve(ROOT, 'src');
const loaderCalls: string[] = [];
let calendarCount = { famcal: 1, google: 2 };
const sub = {
  subscription: { plan: 'FREE', status: 'EXPIRED', currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEndsAt: null },
  effectivePlan: 'FREE',
  usage: { textSummariesUsed: 1, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0, cycleStartDate: new Date('2026-10-20T00:00:00Z') },
};
const stubs: Record<string, Record<string, unknown>> = {
  [`${SRC}/utils/prisma.ts`]: { prisma: { userActivity: { create: async ({ data }: { data: unknown }) => data }, adminSettings: { findUnique: async () => ({ remindersEnabled: true }) } } },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => undefined, captureWarning: () => undefined, captureInfo: () => undefined },
  [`${SRC}/services/subscription-service.ts`]: {
    getSubscriptionWithUsage: async () => sub,
    getTrialStatus: async () => ({ isTrialing: false, trialEndsAt: null, daysRemaining: 0 }),
    checkEarlyAdopterAccess: async () => false,
    peekFeatureAccess: async () => ({ allowed: true }),
    // Two different numbers that only the right call turns into the right one: calendarTotal(own FamCal, Google) is 100 * the first + the second here
    countCalendars: async (userId: number) => {
      loaderCalls.push(`countCalendars(${userId})`);
      return calendarCount;
    },
    calendarTotal: (ownFamcal: number, google: number) => ownFamcal * 100 + google,
  },
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: true }), canReceiveReminderPings: async () => true },
  [`${SRC}/services/calendar/index.ts`]: { listUserCalendars: async () => [], scrubbedGoogleError: () => '' },
  [`${SRC}/services/calendar-read/index.ts`]: { sourcesFor: () => ['famcal'] },
  [`${SRC}/services/native-calendar/event-store.ts`]: { listVisibleCalendars: async () => [] },
  [`${SRC}/services/native-calendar/onboarding.ts`]: { ensurePrimaryNativeCalendar: async () => undefined },
  [`${SRC}/services/pairing-service.ts`]: { getActivePartner: async () => null, getActiveInvite: async () => null },
};
// A require of a stubbed file gets the stub (CommonJS), an import of it gets a module made of the stub's names (ESM)
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
(globalThis as { subscriptionSmokeStubs?: typeof stubs }).subscriptionSmokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map((n) => `export const ${n} = fake[${JSON.stringify(n)}];`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.subscriptionSmokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- The world: a router and a fetch ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
const router = { push: (href: string) => void pushes.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };

interface FetchCall {
  url: string;
  init: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const world = {
  /** What /api/subscription/upgrade answers: a Response, or a promise that settles when the test lets it. */
  upgrade: (): Response | Promise<Response> => json({ success: true, message: 'Invoice sent for Pro plan' }),
};
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url === '/api/subscription/upgrade') return world.upgrade();
  throw new Error(`an unexpected request: ${url}`);
}) as typeof fetch;
const reset = () => {
  pushes.length = 0;
  fetchCalls.length = 0;
  appLogs.length = 0;
  world.upgrade = () => json({ success: true, message: 'Invoice sent for Pro plan' });
};
const posts = () => fetchCalls.filter((c) => c.url === '/api/subscription/upgrade');

// ---- Fixtures ----

const PERIOD_END = '2026-11-20T10:00:00.000Z';
type State = 'free' | 'trial' | 'basic' | 'pro' | 'comped' | 'early' | 'whatsapp';
function propsOf(state: State, over: Row = {}): Row {
  const base: Row = {
    userId: 1,
    locale: 'en',
    subscription: { plan: 'FREE', status: 'EXPIRED', effectivePlan: 'FREE', currentPeriodEnd: null, cancelAtPeriodEnd: false },
    usage: { textSummaries: 7, voiceSummaries: 3, voiceEvents: 4, reminders: 9, cycleStartDate: '2026-10-20T00:00:00.000Z' },
    trial: { isTrialing: false, daysRemaining: 0, trialEndsAt: null },
    isEarlyAdopter: false,
    calendarsUsed: 2,
    telegramLinked: true,
  };
  const paid = (plan: string, periodEnd: string | null): Row => ({ plan, status: 'ACTIVE', effectivePlan: plan, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false });
  switch (state) {
    case 'free':
      break;
    case 'trial':
      base.subscription = { plan: 'FREE', status: 'TRIALING', effectivePlan: 'PRO', currentPeriodEnd: null, cancelAtPeriodEnd: false };
      base.trial = { isTrialing: true, daysRemaining: 9, trialEndsAt: '2026-11-05T10:00:00.000Z' };
      break;
    case 'basic':
      base.subscription = paid('BASIC', PERIOD_END);
      base.calendarsUsed = 4;
      break;
    case 'pro':
      base.subscription = paid('PRO', PERIOD_END);
      break;
    case 'comped':
      base.subscription = paid('PRO', null);
      break;
    case 'early':
      base.subscription = { plan: 'FREE', status: 'TRIALING', effectivePlan: 'PRO', currentPeriodEnd: null, cancelAtPeriodEnd: false };
      base.trial = { isTrialing: true, daysRemaining: 9, trialEndsAt: '2026-11-05T10:00:00.000Z' };
      base.isEarlyAdopter = true;
      break;
    case 'whatsapp':
      base.telegramLinked = false;
      break;
  }
  return { ...base, ...over };
}

let Subscription: (props: Row) => ReactElement;
function tree(locale: Locale, props: Row): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Subscription, { ...props, locale }));
  return createElement(AppRouterContext.Provider, { value: router }, intl);
}

/** What the strings of a language say, by key ('screen.title' in the subscription namespace). */
const word = (locale: Locale, key: string, ns = 'subscription'): string => {
  const value = `${ns}.${key}`.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${ns}.${key} in ${locale}`);
  return value;
};
const planName = (locale: Locale, id: 'basic' | 'pro' | 'free') => word(locale, `plans.${id}.name`);
/** What every pay button says (both cards' the same): agreeing to the Terms, never "I have read" (Standard Contracts Law s.4(12)). */
const payLabel = (locale: Locale) => word(locale, 'screen.agreeAndPay');

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

/** The text under a node of the mounted tree, without the style sheets. */
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
const flat = (node: FakeNode) => visible(node).replace(/\s+/g, ' ').trim();
const page = (m: Mounted) => flat(m.container);
const buttonsOf = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'button');
const classes = (e: FakeElement) => e.className.split(' ');
const chooseButtons = (m: Mounted) => buttonsOf(m).filter((b) => classes(b).includes('ch-plan-choose'));
const chooseLabels = (m: Mounted) => chooseButtons(m).map(flat);
/** A plan card's pay button in the mounted tree, found by its card (the card is labelled by `<id>-<PLAN>`). */
const cardButton = (m: Mounted, id: 'basic' | 'pro') =>
  chooseButtons(m).find((b) => {
    for (let up: FakeNode | null = b; up instanceof FakeElement; up = up.parentNode) if (up.localName === 'section') return (up.getAttribute('aria-labelledby') ?? '').endsWith(`-${id.toUpperCase()}`);
    return false;
  });

/** The choose buttons of a server render, by their text. */
const chooseOf = (html: string) => [...html.matchAll(/<button type="button" class="[^"]*\bch-plan-choose\b[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1]));

interface MeterRow {
  near: boolean;
  label: string;
  text: string;
  /** Present when the row has a track. */
  track: { max: number; now: number; valuetext: string; fill: string } | null;
}
/** The meters of a server render, in order. */
const metersOf = (html: string): MeterRow[] =>
  [...html.matchAll(/<div class="ch-meter( is-near)?"><div class="ch-meter-head"><span class="ch-meter-label">([^<]*)<\/span><span class="ch-meter-value"><bdi>([^<]*)<\/bdi><\/span><\/div>(?:<div class="ch-meter-track" role="meter" aria-label="[^"]*" aria-valuemin="0" aria-valuemax="(\d+)" aria-valuenow="(\d+)" aria-valuetext="([^"]*)"><div class="ch-meter-fill" style="inline-size:([^"]*)"><\/div><\/div>)?<\/div>/g)].map((m) => ({
    near: m[1] !== undefined,
    label: m[2],
    text: m[3],
    track: m[4] === undefined ? null : { max: Number(m[4]), now: Number(m[5]), valuetext: m[6], fill: m[7] },
  }));

/** The cards of the plans section (the sections with an h3: the current plan's has an h2): [name, html] in order. */
const cardsOf = (html: string) =>
  [...html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)]
    .filter((m) => m[0].includes('<h3'))
    .map((m) => [textOf(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(m[0])?.[1] ?? ''), m[0]] as const);

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

interface Opened {
  m: Mounted;
  tg: Row | null;
  calls: string[];
  alerts: { message: string; done?: () => void }[];
}
/** Mount in a browser (no Telegram) or in Telegram `version`; the caller closes it. */
function open(locale: Locale, props: Row, telegram?: { version: string; scheme?: 'light' | 'dark' }): Opened {
  installWindow();
  const calls: string[] = [];
  const alerts: Opened['alerts'] = [];
  const tg = telegram ? fakeTelegram(calls, telegram.version) : null;
  if (tg) {
    tg.initData = 'fake-init-data';
    tg.showAlert = (message: string, done?: () => void) => void alerts.push({ message, done });
    if (telegram?.scheme) tg.colorScheme = telegram.scheme;
  }
  fakeWindow.Telegram = tg ? { WebApp: tg } : undefined;
  const m = mount(tree(locale, props));
  return { m, tg, calls, alerts };
}
const close = (opened: Opened) => {
  opened.m.unmount();
  fakeWindow.Telegram = undefined;
};

async function main() {
  Subscription = (await import('../app/[locale]/(app)/subscription/SubscriptionClient')).default as unknown as (props: Row) => ReactElement;

  await check('U1 render in en, he and ru, light (server) and dark (Telegram): a grouped AppScreen root with its direction and language, the title, the current plan, then Plans with Basic and Pro; no raw key, no emoji, no Latin in he and ru beyond the brands; the Stars prices alone left to right in <bdi dir="ltr"> (the prices as the locale writes them) while the meters\' counts, translated sentences, sit in a bare <bdi> and take their own direction; the star icon hidden from assistive tech beside a hidden sentence; the screen\'s own CSS clean', () => {
    for (const locale of LOCALES) {
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const w = (key: string) => word(locale, key);
      const html = renderToString(tree(locale, propsOf('free')));
      assert(html.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the root: ${html.slice(0, 140)}`);
      assert(html.includes(`<h1 class="ch-screen-title">${w('screen.title')}</h1>`), `${locale}: the title`);
      const text = textOf(html);
      assert(!/subscription\.|screen\.|ui\./.test(text), `${locale}: a raw key in ${text}`);
      assert(!/\p{Extended_Pictographic}/u.test(text), `${locale}: an emoji`);
      assert(!html.includes('[object Object]'), `${locale}: an object printed`);
      // The order: the current plan, the Plans label, the terms before paying, Basic, Pro, the Stars note
      const at = (needle: string) => html.indexOf(needle);
      const order = [at('ch-plan-current'), at(`<h2 class="ch-section-label">${w('screen.plansLabel')}</h2>`), at(textOf(w('screen.oneMonth'))), at(`>${planName(locale, 'basic')}</h3>`), at(`>${planName(locale, 'pro')}</h3>`), at(textOf(w('screen.starsNote')))];
      assert(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), `${locale}: the order ${show(order)}`);
      assert(html.includes(`<h2 id=`) && html.includes(`${planName(locale, 'free')}</h2>`), `${locale}: the current plan's name is a heading`);
      if (locale !== 'en') {
        const bare = text.replace(/Telegram|WhatsApp|FamCal|Pro/g, '');
        assert(!/[A-Za-z]/.test(bare), `${locale}: Latin letters in ${bare.match(/\S*[A-Za-z]\S*/g)?.slice(0, 5)}`);
      }
      // Counts and prices are left to right; the price is the locale's number, and a hidden sentence says it for a screen reader
      const bdis = [...html.matchAll(/<bdi dir="ltr">([^<]*)<\/bdi>/g)].map((m) => m[1].replace(/\u00a0/g, ' '));
      const price = (n: number) => new Intl.NumberFormat(locale).format(n).replace(/\u00a0/g, ' ');
      const of = (used: number, limit: number) => w('screen.usageOf').replace('{used}', String(used)).replace('{limit}', String(limit));
      assert(show(bdis) === show([price(2500), price(5000)]), `${locale}: the left-to-right parts (the prices alone) ${show(bdis)}`);
      // The meters' counts are translated sentences ("7 מתוך 10"): each sits in a bare <bdi> and takes its own direction
      assert(show(metersOf(html).slice(0, 3).map((r) => r.text)) === show([of(7, 10), of(3, 3), of(2, 3)]), `${locale}: the meters' counts ${show(metersOf(html).map((r) => r.text))}`);
      assert(price(2500) === (locale === 'ru' ? '2 500' : '2,500') && price(5000) === (locale === 'ru' ? '5 000' : '5,000'), `${locale}: the number format ${price(2500)}`);
      const svgs = [...html.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
      assert(svgs.length >= 1 && svgs.every((s) => /aria-hidden="true"/.test(s)), `${locale}: an icon is not hidden from assistive tech: ${show(svgs)}`);
      const hidden = [...html.matchAll(/<span class="ch-visually-hidden">([^<]*)<\/span>/g)].map((m) => m[1].replace(/\u00a0/g, ' '));
      assert(show(hidden) === show([2500, 5000].map((n) => w('screen.priceA11y').replace('{price, number}', price(n)))), `${locale}: the hidden sentences ${show(hidden)}`);
      // Dark, as Telegram says it: the same root with its scheme
      const dark = open(locale, propsOf('free'), { version: '7.7', scheme: 'dark' });
      try {
        const root = elements(dark.m.container).find((e) => e.className === 'ch-app ch-screen ch-grouped');
        assert(root && root.getAttribute('data-theme') === 'dark' && root.getAttribute('dir') === dir && root.getAttribute('lang') === locale, `${locale}: the dark root`);
        assert(dark.calls.includes('setHeaderColor(bg_color)') && dark.calls.includes('setBackgroundColor(bg_color)'), `${locale}: dark colours: ${show(dark.calls)}`);
        assert(!dark.calls.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), 'no colour of ours on Telegram');
        assert(show(chooseLabels(dark.m)) === show([payLabel(locale), payLabel(locale)]) && cardButton(dark.m, 'basic') && cardButton(dark.m, 'pro'), `${locale}: the dark buttons ${show(chooseLabels(dark.m))}`);
        // In the mounted tree: no element a meter's count sits in, up to the root, forces left to right (it would read "10 of 7" in Hebrew)
        const counts = elements(dark.m.container).filter((e) => e.className === 'ch-meter-value');
        assert(counts.length === 3, `${locale}: ${counts.length} meter counts`);
        for (const count of counts) {
          for (let up: FakeNode | null = count; up instanceof FakeElement; up = up.parentNode) assert(up.getAttribute('dir') !== 'ltr' || up.className.startsWith('ch-app'), `${locale}: a meter count is inside a dir="ltr" ${up.localName}.${up.className}`);
          const bdi = count.childNodes[0];
          assert(bdi instanceof FakeElement && bdi.localName === 'bdi' && !bdi.hasAttribute('dir'), `${locale}: the count is a bare bdi`);
        }
      } finally {
        close(dark);
      }
    }
    // A light Telegram theme paints Telegram's header with the ground the cards sit on
    const light = open('en', propsOf('free'), { version: '7.7', scheme: 'light' });
    try {
      assert(light.calls.includes('setHeaderColor(secondary_bg_color)') && light.calls.includes('setBackgroundColor(secondary_bg_color)'), `light colours: ${show(light.calls)}`);
    } finally {
      close(light);
    }
    // The screen's own CSS: the same lint as the kit's, no !important, and every class the page uses is defined
    assert(show(lintCss(SUBSCRIPTION_CSS)) === show([]), `lintCss: ${show(lintCss(SUBSCRIPTION_CSS))}`);
    assert(!/!important/.test(SUBSCRIPTION_CSS), 'no !important: a winner is settled by order');
    const used = new Set<string>();
    for (const state of ['free', 'trial', 'basic', 'pro', 'early'] as State[]) for (const m of renderToString(tree('en', propsOf(state))).matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(' ')) if (c.startsWith('ch-plan-')) used.add(c);
    const undefinedClasses = [...used].filter((c) => !new RegExp(`\\.${c}\\b`).test(SUBSCRIPTION_CSS));
    assert(used.size >= 8 && undefinedClasses.length === 0, `classes with no rule: ${show(undefinedClasses)} (of ${used.size})`);
  });

  await check('U2 the state matrix: Free gets Basic and Pro; a trial gets both and a day count in the language\'s plural forms (the home\'s banner line: 1 and 2 days in he); Basic gets Pro and a Current tag on its own card; Pro and a comped Pro get no button (a Pro user is never offered Basic); a comped Pro has no "active until"; early access has no Plans section at all; a user with no Telegram gets no button and the note that paying needs it; the prices are the plan\'s', () => {
    assert(PLAN_CONFIGS.BASIC.priceStars === 2500 && PLAN_CONFIGS.PRO.priceStars === 5000, `the prices are ${PLAN_CONFIGS.BASIC.priceStars} and ${PLAN_CONFIGS.PRO.priceStars} Stars`);
    for (const locale of LOCALES) {
      const w = (key: string) => word(locale, key);
      // The markup, without the style sheets (their rules name the classes too)
      const render = (state: State, over: Row = {}) => renderToString(tree(locale, propsOf(state, over))).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
      const both = [planName(locale, 'basic'), planName(locale, 'pro')];
      // Which cards have a pay button, and what else each state says
      const cases: [State, string[]][] = [['free', both], ['trial', both], ['basic', [planName(locale, 'pro')]], ['pro', []], ['comped', []], ['early', []], ['whatsapp', []]];
      for (const [state, want] of cases) {
        const html = render(state);
        const paying = cardsOf(html).filter(([, card]) => chooseOf(card).length > 0).map(([name]) => name);
        assert(show(paying) === show(want) && chooseOf(html).every((label) => label === payLabel(locale)), `${locale} ${state}: the cards with a button ${show(paying)} (${show(chooseOf(html))}), want ${show(want)}`);
        const text = textOf(html);
        const note = textOf(w('screen.starsNote'));
        assert(text.includes(note) === (want.length > 0), `${locale} ${state}: the Stars note ${want.length > 0 ? 'is missing' : 'shows with no button'}`);
        assert(text.includes(textOf(w('screen.needsTelegram'))) === (state === 'whatsapp'), `${locale} ${state}: the needs-Telegram note`);
        // The d1b90de fix: the reminders row is its own translated label, never the bot's reminders object
        assert(!text.includes('[object Object]') && !/subscription\.reminders/.test(text), `${locale} ${state}: the reminders key`);
        // The current plan's tag: one, by state
        const tags = [...html.matchAll(/<span class="ch-tag">([^<]*)<\/span>/g)].map((m) => m[1]);
        const tag = { free: w('screen.badge.current'), trial: w('screen.badge.trial'), basic: w('screen.badge.current'), pro: w('screen.badge.current'), comped: w('screen.badge.current'), early: w('screen.badge.earlyAccess'), whatsapp: w('screen.badge.current') }[state];
        const planTag = state === 'basic' || state === 'pro' || state === 'comped' ? [w('screen.badge.current')] : [];
        assert(show(tags) === show([tag, ...planTag]), `${locale} ${state}: the tags ${show(tags)}`);
      }
      // The current plan: the effective plan's name
      for (const [state, id] of [['free', 'free'], ['trial', 'pro'], ['basic', 'basic'], ['pro', 'pro'], ['early', 'pro']] as const) {
        assert(new RegExp(`<h2 id="[^"]*" class="ch-plan-title">${planName(locale, id)}</h2>`).test(render(state)), `${locale} ${state}: the plan name`);
      }
      // The Current tag sits on the card of the paid plan, and only there
      const cards = (state: State) => Object.fromEntries(cardsOf(render(state)).map(([name, card]) => [name, /ch-tag/.test(card)]));
      assert(show(cards('basic')) === show({ [planName(locale, 'basic')]: true, [planName(locale, 'pro')]: false }), `${locale} basic: the card tags ${show(cards('basic'))}`);
      assert(show(cards('pro')) === show({ [planName(locale, 'basic')]: false, [planName(locale, 'pro')]: true }), `${locale} pro: the card tags ${show(cards('pro'))}`);
      assert(show(cards('free')) === show({ [planName(locale, 'basic')]: false, [planName(locale, 'pro')]: false }), `${locale} free: the card tags`);
      assert(show(cards('trial')) === show({ [planName(locale, 'basic')]: false, [planName(locale, 'pro')]: false }), `${locale} trial: the card tags`);
      // Early access: the whole Plans section goes, and the trial's line gives way to the early-access one
      const early = render('early');
      assert(cardsOf(early).length === 0 && !early.includes(w('screen.plansLabel')) && !early.includes('ch-section-label'), `${locale} early: the Plans section shows`);
      assert(textOf(early).includes(textOf(w('screen.earlyAccessNote'))) && !textOf(early).includes({ en: '9 days left in your trial', he: 'נשארו 9 ימים לתקופת הניסיון', ru: 'До конца пробного периода 9 дней' }[locale]), `${locale} early: the line`);
      // Pro: both cards, one Pro ring; the cards carry the plan's price
      const pro = render('pro');
      assert((pro.match(/ch-panel-ring/g) ?? []).length === 1 && cardsOf(pro).length === 2, `${locale} pro: the cards`);
      // The status line: one at most
      const dateOf = (iso: string) => new Date(iso).toLocaleDateString({ en: 'en-US', he: 'he-IL', ru: 'ru-RU' }[locale], { day: 'numeric', month: 'long', year: 'numeric' });
      const until = textOf(w('screen.activeUntil').replace('{date}', dateOf(PERIOD_END)));
      assert(textOf(render('basic')).includes(until) && textOf(render('pro')).includes(until), `${locale}: active until ${until}`);
      const untilWords = textOf(w('screen.activeUntil').replace('{date}', '')).trim();
      for (const state of ['comped', 'free', 'whatsapp', 'trial', 'early'] as State[]) assert(!textOf(render(state)).includes(untilWords), `${locale} ${state}: an "active until" line`);
      // The label of the reminders row is the screen's own, in a state that has it
      const labels = (state: State) => metersOf(render(state)).map((r) => r.label);
      assert(labels('pro').includes(w('screen.reminders')) && labels('pro').includes(w('screen.voiceEvents')) && !labels('free').includes(w('screen.reminders')) && !labels('basic').includes(w('screen.reminders')), `${locale}: the reminders row`);
    }
    // The en text of the lines, spelled out
    const en = (state: State, over: Row = {}) => textOf(renderToString(tree('en', propsOf(state, over))));
    assert(en('basic').includes('Active until November 20, 2026'), `the date: ${en('basic').match(/Active until[^.]*/)}`);
    assert(en('early').includes('Every feature is open to you as one of our first users.') && !en('early').includes('days left in your trial'), 'early access');
    // A trial's days, in each language's plural forms
    const trialWith = (locale: Locale, days: number) => textOf(renderToString(tree(locale, propsOf('trial', { trial: { isTrialing: true, daysRemaining: days, trialEndsAt: null } }))));
    const lines: [Locale, number, string][] = [
      ['en', 1, '1 day left in your trial'],
      ['en', 2, '2 days left in your trial'],
      ['en', 9, '9 days left in your trial'],
      ['he', 1, 'נשאר יום אחד לתקופת הניסיון'],
      ['he', 2, 'נשארו יומיים לתקופת הניסיון'],
      ['he', 9, 'נשארו 9 ימים לתקופת הניסיון'],
      ['ru', 1, 'До конца пробного периода 1 день'],
      ['ru', 2, 'До конца пробного периода 2 дня'],
      ['ru', 5, 'До конца пробного периода 5 дней'],
      ['ru', 22, 'До конца пробного периода 22 дня'],
    ];
    for (const [locale, days, line] of lines) assert(trialWith(locale, days).includes(line), `${locale} ${days}: ${trialWith(locale, days).match(/(?:до конца|נשאר|day)[^.]*/i)}`);
  });

  await check('U3 the meters: Free shows 7 of 10, 3 of 3 (near) and 2 of 3; 12 of 10 is over (the value capped at the limit, the bar full, near, the text as it is); Basic shows its calendars 4 of 5 (near) and unlimited summaries with no meter; Pro and a trial show five unlimited rows and no meter at all; the voice-events and reminders rows only where the plan has them', () => {
    for (const locale of LOCALES) {
      const w = (key: string) => word(locale, key);
      const of = (used: number, limit: number) => w('screen.usageOf').replace('{used}', String(used)).replace('{limit}', String(limit));
      const rows = (state: State, over: Row = {}) => metersOf(renderToString(tree(locale, propsOf(state, over))));
      const free = rows('free');
      assert(show(free.map((r) => r.label)) === show([w('screen.textSummaries'), w('screen.voiceSummaries'), w('screen.calendars')]), `${locale}: the rows ${show(free.map((r) => r.label))}`);
      assert(show(free.map((r) => r.track && [r.track.now, r.track.max, r.track.valuetext, r.track.fill, r.near])) === show([[7, 10, of(7, 10), '70%', false], [3, 3, of(3, 3), '100%', true], [2, 3, of(2, 3), '66.66666666666666%', false]]), `${locale}: free: ${show(free)}`);
      const zero = rows('free', { usage: { ...propsOf('free').usage, textSummaries: 0, voiceSummaries: 0 }, calendarsUsed: 0 });
      assert(show(zero.map((r) => r.track && [r.track.now, r.track.fill, r.near])) === show([[0, '0%', false], [0, '0%', false], [0, '0%', false]]), `${locale}: empty: ${show(zero)}`);
      // Over the limit: the value is capped, the bar is full, and the count says what it is
      const over = rows('free', { usage: { ...propsOf('free').usage, textSummaries: 12 } });
      assert(over[0].track?.now === 10 && over[0].track.max === 10 && over[0].track.fill === '100%' && over[0].near && over[0].text === of(12, 10) && over[0].track.valuetext === of(12, 10), `${locale}: over: ${show(over[0])}`);
      // The edge of near: 8 of 10 is near, 7 is not
      assert(rows('free', { usage: { ...propsOf('free').usage, textSummaries: 8 } })[0].near && !rows('free', { usage: { ...propsOf('free').usage, textSummaries: 7 } })[0].near, `${locale}: the edge of near`);
      // Basic: summaries unlimited (no track), calendars 4 of 5 is near
      const basic = rows('basic');
      assert(show(basic.map((r) => r.label)) === show([w('screen.textSummaries'), w('screen.voiceSummaries'), w('screen.calendars')]), `${locale}: basic rows`);
      assert(basic[0].track === null && basic[0].text === w('screen.unlimited') && basic[1].track === null && basic[2].track?.now === 4 && basic[2].track.max === 5 && basic[2].near, `${locale}: basic: ${show(basic)}`);
      // Pro and a trial: five unlimited rows, nothing to measure
      for (const state of ['pro', 'trial', 'comped', 'early'] as State[]) {
        const pro = rows(state);
        assert(show(pro.map((r) => r.label)) === show([w('screen.textSummaries'), w('screen.voiceSummaries'), w('screen.calendars'), w('screen.voiceEvents'), w('screen.reminders')]), `${locale} ${state}: rows ${show(pro.map((r) => r.label))}`);
        assert(pro.every((r) => r.track === null && !r.near && r.text === w('screen.unlimited')), `${locale} ${state}: ${show(pro)}`);
        assert(!renderToString(tree(locale, propsOf(state))).includes('role="meter"'), `${locale} ${state}: a meter`);
      }
    }
  });

  await check('U4 the upgrade: a tap posts once, to /api/subscription/upgrade, with the body the route reads ({ user_id: the page\'s, plan, initData from the SDK, recurring: false }); a second tap on either button while it is in flight sends nothing, every Choose button is disabled and the tapped one is busy; a success in Telegram is a pop-up and the window closes only after it; in a browser it is a notice on the page; a refusal or a throw is a notice in the page\'s language, a pop-up in Telegram, never the server\'s English, and logged; the buttons come back', async () => {
    const button = (o: Opened, id: 'basic' | 'pro') => {
      const b = cardButton(o.m, id);
      assert(b, `no ${id} button in ${show(chooseLabels(o.m))}`);
      return b;
    };
    // --- In Telegram: the request, the guard, the success
    reset();
    let release: (r: Response) => void = () => undefined;
    world.upgrade = () => new Promise<Response>((resolve) => (release = resolve));
    const tg = open('en', propsOf('free'), { version: '7.7' });
    try {
      tg.m.click(button(tg, 'pro'));
      assert(posts().length === 1, `a tap posts: ${posts().length}`);
      const call = posts()[0];
      assert(call.init.method === 'POST' && (call.init.headers as Row)['Content-Type'] === 'application/json', `method and header: ${show(call.init)}`);
      assert(show(JSON.parse(String(call.init.body))) === show({ user_id: 1, plan: 'PRO', initData: 'fake-init-data', recurring: false }), `the body: ${call.init.body}`);
      // In flight: every button waits, the tapped one is busy with a spinner
      const waiting = chooseButtons(tg.m);
      assert(waiting.length === 2 && waiting.every((b) => b.hasAttribute('disabled')), 'every Choose button is disabled while a request is in flight');
      const tapped = button(tg, 'pro');
      assert(tapped.getAttribute('aria-busy') === 'true' && elements(tapped).some((e) => e.className === 'ch-form-spinner'), 'the tapped button is busy, with a spinner');
      assert(chooseButtons(tg.m).filter((b) => b.getAttribute('aria-busy') === 'true').length === 1, 'only the tapped button is busy');
      // Taps while it is in flight: on the same button and on the other one
      tg.m.click(button(tg, 'pro'));
      tg.m.click(button(tg, 'basic'));
      assert(posts().length === 1, `taps in flight: ${posts().length} requests`);
      // The answer: a pop-up, and the window closes only once it is dismissed
      release(json({ success: true }));
      await settle();
      assert(show(tg.alerts.map((a) => a.message)) === show([word('en', 'screen.invoiceSent')]), `the pop-up: ${show(tg.alerts)}`);
      assert(!tg.calls.includes('close()'), 'the window closes before the pop-up is dismissed');
      tg.alerts[0].done?.();
      assert(tg.calls.filter((c) => c === 'close()').length === 1, 'the window closes after OK');
      assert(!page(tg.m).includes(word('en', 'screen.invoiceSent')), 'in Telegram the pop-up is the message, not a second copy on the page');
      assert(chooseButtons(tg.m).every((b) => !b.hasAttribute('disabled') && b.getAttribute('aria-busy') === null), 'the buttons come back');
    } finally {
      close(tg);
    }
    // --- Two taps before React re-renders: still one request
    reset();
    world.upgrade = () => new Promise<Response>(() => undefined);
    const twice = open('en', propsOf('free'), { version: '7.7' });
    try {
      const b = button(twice, 'pro');
      const other = button(twice, 'basic');
      act(() => {
        twice.m.click(b);
        twice.m.click(b);
        twice.m.click(other);
      });
      assert(posts().length === 1, `a double tap in one batch: ${posts().length} requests`);
    } finally {
      close(twice);
    }
    // --- In a browser: the body has no init data, and the answer is on the page
    reset();
    const browser = open('en', propsOf('free'));
    try {
      browser.m.click(button(browser, 'basic'));
      await settle();
      assert(show(JSON.parse(String(posts()[0].init.body))) === show({ user_id: 1, plan: 'BASIC', initData: '', recurring: false }), `the browser's body: ${posts()[0]?.init.body}`);
      const notice = byRole(browser.m.container, 'status').find((e) => classes(e).includes('ch-notice'));
      assert(notice && flat(notice) === word('en', 'screen.invoiceSent'), `the notice: ${notice && flat(notice)}`);
      assert(show(appLogs) === show([]), `nothing to log: ${show(appLogs)}`);
      // A new tap takes the old notice away while it is in flight
      let again: (r: Response) => void = () => undefined;
      world.upgrade = () => new Promise<Response>((resolve) => (again = resolve));
      browser.m.click(button(browser, 'pro'));
      assert(byRole(browser.m.container, 'status').every((e) => !classes(e).includes('ch-notice')), 'the old notice is gone while the next request runs');
      again(json({ success: true }));
      await settle();
    } finally {
      close(browser);
    }
    // --- A refusal: the server's text is not shown, in any language; it is logged; a pop-up in Telegram too
    for (const locale of LOCALES) {
      reset();
      world.upgrade = () => json({ error: 'Failed to send invoice' }, 500);
      const refused = open(locale, propsOf('free'), { version: '7.7' });
      try {
        refused.m.click(button(refused, 'pro'));
        await settle();
        const alert = byRole(refused.m.container, 'alert').find((e) => classes(e).includes('ch-notice-error'));
        assert(alert && flat(alert) === word(locale, 'screen.upgradeFailed'), `${locale}: the error notice: ${alert && flat(alert)}`);
        assert(show(refused.alerts.map((a) => a.message)) === show([word(locale, 'screen.upgradeFailed')]), `${locale}: the pop-up: ${show(refused.alerts)}`);
        assert(!page(refused.m).includes('Failed to send invoice') && !refused.alerts.some((a) => a.message.includes('Failed to send invoice')), `${locale}: the server's text is shown`);
        assert(show(appLogs) === show(['[subscription] upgrade refused: 500']), `${locale}: the log: ${show(appLogs)}`);
        assert(chooseButtons(refused.m).every((b) => !b.hasAttribute('disabled')), `${locale}: the buttons stay stuck`);
        assert(!tgClosed(refused), `${locale}: the window closed on a failure`);
      } finally {
        close(refused);
      }
    }
    // --- 200 with no success: the same
    reset();
    world.upgrade = () => json({ success: false, error: 'Cannot upgrade to free plan' });
    const unsuccessful = open('en', propsOf('free'));
    try {
      unsuccessful.m.click(button(unsuccessful, 'pro'));
      await settle();
      assert(page(unsuccessful.m).includes(word('en', 'screen.upgradeFailed')) && !page(unsuccessful.m).includes('Cannot upgrade') && show(appLogs) === show(['[subscription] upgrade refused: 200']), `no success: ${show(appLogs)}`);
    } finally {
      close(unsuccessful);
    }
    // --- A throw: the same notice, and the error is logged
    reset();
    world.upgrade = () => Promise.reject(new Error('network down'));
    const thrown = open('he', propsOf('free'), { version: '7.7' });
    try {
      thrown.m.click(button(thrown, 'pro'));
      await settle();
      assert(byRole(thrown.m.container, 'alert').some((e) => flat(e) === word('he', 'screen.upgradeFailed')), 'the error notice');
      assert(show(thrown.alerts.map((a) => a.message)) === show([word('he', 'screen.upgradeFailed')]), 'the pop-up');
      assert(appLogs.length === 1 && appLogs[0].startsWith('[subscription] upgrade failed:') && appLogs[0].includes('network down'), `the log: ${show(appLogs)}`);
      assert(chooseButtons(thrown.m).every((b) => !b.hasAttribute('disabled')), 'the buttons come back after a throw');
    } finally {
      close(thrown);
    }
    // --- An answer that is not JSON: logged too, never raised
    reset();
    world.upgrade = () => new Response('<html>', { status: 200 });
    const broken = open('en', propsOf('free'));
    try {
      broken.m.click(button(broken, 'pro'));
      await settle();
      assert(page(broken.m).includes(word('en', 'screen.upgradeFailed')) && appLogs.length === 1 && appLogs[0].startsWith('[subscription] upgrade failed:'), `not JSON: ${show(appLogs)}`);
    } finally {
      close(broken);
    }
    // --- A client with no pop-up: the success is told on the page, and the failure to show one is logged
    reset();
    const noPopUp = open('en', propsOf('free'), { version: '7.7' });
    try {
      (noPopUp.tg as Row).showAlert = () => {
        throw new Error('WebAppMethodUnsupported');
      };
      noPopUp.m.click(button(noPopUp, 'pro'));
      await settle();
      assert(byRole(noPopUp.m.container, 'status').some((e) => classes(e).includes('ch-notice') && flat(e) === word('en', 'screen.invoiceSent')), 'the success is on the page when the pop-up fails');
      assert(appLogs.some((l) => l.startsWith('[telegram-ui] showAlert failed:')) && !noPopUp.calls.includes('close()'), `the log: ${show(appLogs)}`);
    } finally {
      close(noPopUp);
    }
  });

  await check('U5 Back: AppScreen is the only BackButton caller (the screen never calls useTelegramBackButton); in Telegram 7.7 the BackButton shows and goes to /<locale>/dashboard?user_id=<id>, with no second back on the page; in a browser the header\'s own back goes to the same place', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/subscription/SubscriptionClient.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/useTelegramBackButton\(/.test(source), 'SubscriptionClient calls useTelegramBackButton');
    for (const locale of LOCALES) {
      reset();
      const tg = open(locale, propsOf('free'), { version: '7.7' });
      try {
        assert(tg.calls.includes('BackButton.show()') && tg.tg?.backHandlers.length === 1, `${locale}: the BackButton: ${show(tg.calls.filter((c) => c.startsWith('Back')))}`);
        assert(!buttonsOf(tg.m).some((b) => b.getAttribute('aria-label') === word(locale, 'back', 'ui')), `${locale}: a second back in Telegram`);
        tg.tg?.backHandlers[0]();
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=1`]), `${locale}: Back goes to ${show(pushes)}`);
      } finally {
        close(tg);
      }
      reset();
      const browser = open(locale, propsOf('free'));
      try {
        const back = buttonsOf(browser.m).find((b) => b.getAttribute('aria-label') === word(locale, 'back', 'ui'));
        assert(back, `${locale}: no back in a browser`);
        browser.m.click(back);
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=1`]), `${locale}: the page's back goes to ${show(pushes)}`);
      } finally {
        close(browser);
      }
    }
  });

  await check('U7 the messages: every key of subscription.screen is read by the screen and none is left over (the trial days left are calendarHome.banner.trial, the home line, read with { count }, not a copy of it); the keys the bot reads are all still there; the screen-only keys of the old page are gone; the old page\'s parts (TelegramLayout, Header, Section, styled-jsx, hard-coded English) are gone', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/subscription/SubscriptionClient.tsx'), 'utf8');
    const code = source.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    const leaves = (node: Row, prefix = ''): string[] => Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? leaves(v as Row, `${prefix}${k}.`) : [`${prefix}${k}`]));
    for (const locale of LOCALES) {
      const screen = messages[locale].subscription.screen as Row;
      const keys = leaves(screen);
      assert(keys.length === 31, `${locale}: ${keys.length} keys in subscription.screen`);
      // The trial's days left is the home's banner line, said once: the screen has no copy of it, and reads the home's with { count }
      assert(!('trialLeft' in screen), `${locale}: subscription.screen.trialLeft is back (the home's calendarHome.banner.trial says it)`);
      assert(typeof (messages[locale].calendarHome as Row).banner.trial === 'string' && (messages[locale].calendarHome as Row).banner.trial.includes('{count, plural'), `${locale}: calendarHome.banner.trial`);
      const unread = keys.filter((k) => !code.includes(`'${k}'`));
      assert(unread.length === 0, `${locale}: keys nothing reads: ${show(unread)}`);
      const sub = messages[locale].subscription as Row;
      for (const gone of ['page', 'currentPlan', 'usage', 'textSummaries', 'voiceSummaries', 'voiceEvents', 'usageReminders', 'calendars', 'unlimited', 'of', 'usageDisplay', 'trialBanner', 'trialEndsIn', 'earlyAdopterBanner', 'earlyAdopterDescription', 'planFeatures', 'cancelPlan']) assert(!(gone in sub), `${locale}: subscription.${gone} is still there`);
      for (const id of ['free', 'basic', 'pro']) assert(show(Object.keys(sub.plans[id])) === show(['name']), `${locale}: subscription.plans.${id}: ${show(Object.keys(sub.plans[id]))}`);
      // The bot's keys (payment-handler, subscription-reminders, text-limit, notifications): all there, in this language (the voice-events message lives in bot.subscription, where the voice handlers read it)
      for (const key of ['reminders', 'upgradeButton', 'paymentSuccess', 'paymentError', 'viewSubscription', 'invoiceTitle', 'invoiceDescription', 'invoiceLabel', 'textLimitReached', 'voiceLimitReached', 'remindersRequired', 'plans']) assert(key in sub, `${locale}: the bot's subscription.${key} is missing`);
      // The invoice and the confirmation carry the disclosure (src/lib/plan-disclosure.ts), not a feature list: the old one listed every feature, Pro's too, to a Basic payer
      assert(!('features' in sub), `${locale}: subscription.features is back, and nothing reads it`);
      for (const key of ['expiringSoon', 'lastDay', 'expired']) assert(typeof sub.reminders[key] === 'object', `${locale}: subscription.reminders.${key}`);
    }
    assert(code.includes("useTranslations('calendarHome')") && code.includes("home('banner.trial', { count: trial.daysRemaining })"), "the screen does not read the home's banner.trial with { count: trial.daysRemaining }");
    assert(!/TelegramLayout|@\/components\/Layout|@\/components\/UI|styled-jsx|<style jsx|Crown|Sparkles|Clock/.test(code), 'a part of the old page is still imported');
    assert(!/Unable to identify|Failed to send invoice|An error occurred|Invoice sent|'\.\.\.'|\/mo\b/.test(code), 'hard-coded English is still there');
    assert(!fs.existsSync(path.join(ROOT, 'components/UI')), 'components/UI (the Section, whose last user this screen was) is still there');
  });

  await check('U9 the terms before paying (Consumer Protection Law s.14C, Telegram\'s Stars checklist): wherever a pay button shows, the seller (src/lib/seller.ts), one month that never renews, the 14-day full refund and the Terms come before the first button, as static text (no live region); every pay button says the language\'s "I agree to the Terms, pay", never "I have read"; with no pay button there is no block; the Terms open in the person\'s language through Telegram\'s openLink (the Mini App stays: no navigation, no close, no invoice) or in a new tab in a browser', async () => {
    for (const locale of LOCALES) {
      const w = (key: string) => word(locale, key);
      assert(!/\bread\b|прочит|קראתי|קראנו|שקראתי/i.test(w('screen.agreeAndPay')), `${locale}: the button says it was read: ${w('screen.agreeAndPay')}`);
      for (const state of ['free', 'trial', 'basic', 'pro', 'comped', 'early', 'whatsapp'] as State[]) {
        const html = renderToString(tree(locale, propsOf(state))).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
        const buttons = chooseOf(html);
        const block = html.indexOf(textOf(w('screen.oneMonth')));
        if (buttons.length === 0) {
          assert(block < 0, `${locale} ${state}: the terms with no pay button`);
          continue;
        }
        const firstButton = html.search(/<button type="button" class="[^"]*\bch-plan-choose\b/);
        assert(block > 0 && block < firstButton, `${locale} ${state}: the terms (${block}) are not before the first pay button (${firstButton})`);
        const start = html.lastIndexOf('<div class="ch-notice', block);
        assert(start > 0 && html.slice(start, html.indexOf('>', start) + 1) === '<div class="ch-notice">', `${locale} ${state}: the terms are not a static notice: ${html.slice(start, start + 60)}`);
        const notice = textOf(html.slice(start, html.indexOf('</div>', start)));
        const lines = [w('screen.seller').replace('{name}', SELLER.name[locale]), w('screen.oneMonth'), w('screen.refund'), w('screen.termsLink')].map(textOf);
        assert(show(lines.filter((line) => !notice.includes(line))) === show([]), `${locale} ${state}: the notice ${show(notice)} lacks ${show(lines.filter((line) => !notice.includes(line)))}`);
        assert(buttons.every((label) => label === w('screen.agreeAndPay')), `${locale} ${state}: the buttons ${show(buttons)}`);
      }
    }
    // Inside Telegram: Telegram's openLink with the Terms in the page's language; the Mini App stays where it is
    for (const locale of LOCALES) {
      reset();
      pushes.length = 0;
      const tg = open(locale, propsOf('free'), { version: '7.7' });
      try {
        (tg.tg as Row).openLink = (url: string) => void tg.calls.push(`openLink(${url})`);
        const terms = buttonsOf(tg.m).find((b) => flat(b) === word(locale, 'screen.termsLink'));
        assert(terms && classes(terms).includes('ch-notice-action') && terms.getAttribute('type') === 'button', `${locale}: no Terms action`);
        tg.m.click(terms);
        assert(show(tg.calls.filter((c) => c.startsWith('openLink'))) === show([`openLink(${policyUrl('terms', locale)})`]), `${locale}: ${show(tg.calls.filter((c) => c.startsWith('openLink')))}`);
        assert(policyUrl('terms', locale) === (locale === 'en' ? 'https://famcal.bot/terms' : `https://famcal.bot/${locale}/terms`), `${locale}: ${policyUrl('terms', locale)}`);
        assert(pushes.length === 0 && !tg.calls.includes('close()') && posts().length === 0, `${locale}: the Mini App moved: ${show({ pushes, calls: tg.calls, posts: posts().length })}`);
      } finally {
        close(tg);
      }
    }
    // In a browser: a new tab
    const opened: unknown[][] = [];
    const browser = open('ru', propsOf('basic'));
    fakeWindow.open = (...args: unknown[]) => void opened.push(args);
    try {
      const terms = buttonsOf(browser.m).find((b) => flat(b) === word('ru', 'screen.termsLink'));
      assert(terms, 'no Terms action in a browser');
      browser.m.click(terms);
      assert(show(opened) === show([['https://famcal.bot/ru/terms', '_blank', 'noopener,noreferrer']]), `the tab: ${show(opened)}`);
      assert(show(appLogs) === show([]), `logged: ${show(appLogs)}`);
    } finally {
      close(browser);
      delete fakeWindow.open;
    }
  });

  await check('U8 a plan card\'s head wraps (the price and the Current tag drop to a second line when there is no room) and the plan\'s name keeps its words whole: it sizes to its text, may shrink no narrower than its longest word, and has no break-anywhere (a Basic user in Russian at 320 px read "Базов / ый")', () => {
    const rule = (selector: string): string => {
      const found = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(SUBSCRIPTION_CSS);
      assert(found, `no rule for ${selector}`);
      return found[1];
    };
    const head = rule('.ch-plan-head');
    assert(/flex-wrap:\s*wrap\s*;/.test(head) && /display:\s*flex\s*;/.test(head), `.ch-plan-head: ${head.trim()}`);
    const name = rule('.ch-plan-name');
    assert(/(?:^|\s)flex:\s*1 1 auto\s*;/.test(name), `.ch-plan-name sizes to its text, not from a zero basis: ${name.trim()}`);
    assert(/min-inline-size:\s*min-content\s*;/.test(name), `.ch-plan-name stops at its longest word: ${name.trim()}`);
    assert(!/overflow-wrap|word-break|hyphens/.test(name), `.ch-plan-name breaks inside a word: ${name.trim()}`);
  });

  await check('L1 the page loader hands the screen the calendar count (calendarTotal of the user\'s FamCal and Google calendars, by the DB id: the count that enforces the limit) and whether Telegram is linked; the other props are as they were', async () => {
    const { loadPageData } = await import('../src/lib/page-data');
    const user = (telegramId: number | null) =>
      ({ id: 7, name: 'Dana', language: 'en', location: 'Tel Aviv', culture: 'default', messagingPlatform: 'telegram', isAdmin: false, telegramId, googleRefreshToken: '', calendarAssignments: [] }) as never;
    loaderCalls.length = 0;
    calendarCount = { famcal: 1, google: 2 };
    const linked = await loadPageData('subscription', user(4242), 5550001, 'en');
    assert(linked.kind === 'props', `kind ${linked.kind}`);
    const props = linked.props as Row;
    assert(props.calendarsUsed === 102, `calendarsUsed ${props.calendarsUsed}: calendarTotal(famcal, google) is the count`);
    assert(show(loaderCalls) === show(['countCalendars(7)']), `the count is asked once, by the DB id: ${show(loaderCalls)}`);
    assert(props.telegramLinked === true && props.userId === 5550001 && props.locale === 'en' && props.isEarlyAdopter === false, `props: ${show(props)}`);
    assert(props.subscription.effectivePlan === 'FREE' && props.trial.isTrialing === false && props.usage.textSummaries === 1, 'the other props are as they were');
    const whatsapp = await loadPageData('subscription', user(null), 5550001, 'en');
    assert(whatsapp.kind === 'props' && (whatsapp.props as Row).telegramLinked === false, `a user with no Telegram: ${show((whatsapp as Row).props?.telegramLinked)}`);
    calendarCount = { famcal: 0, google: 0 };
    const none = await loadPageData('subscription', user(4242), 5550001, 'en');
    assert(none.kind === 'props' && (none.props as Row).calendarsUsed === 0, 'no calendars is 0');
  });

  await check('U6 React logged no warning', () => {
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

/** Whether the Mini App was told to close. */
function tgClosed(opened: Opened): boolean {
  return opened.calls.includes('close()');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
