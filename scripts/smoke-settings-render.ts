// Smoke test for the Settings screen (plan docs/superpowers/plans/2026-10-27-app-ui-W1a-settings.md, Task 3;
// spec 2026-10-19-screens-and-colours §4, §5): SettingsClient on AppScreen and the form kit, in real React on
// the small fake DOM, with a fake Telegram.WebApp, a router stub and a fake fetch. No network, no DB.
//  - S1 the render in en, he and ru, light and dark: the grouped root, the four sections in order, no raw key,
//    no emoji, no English in he and ru beyond the brands and the endonyms, the times left to right;
//  - S2 the state matrix: what the alerts rows show for the saved platform, the plan and the global switch, the
//    reminder time, the Google section, the usage lines, and that the platform list changes the section only once saved;
//  - S3 buildSettingsBody against the JSON the page has always posted;
//  - S4 saving on the page: Save only while something differs, one request, "Saved", the error that leaves the
//    controls usable, a changed language reloading the page in it;
//  - S5 the location: the check after the sheet closes (asked again for a place that carries a problem, however the
//    sheet is closed), Save waiting for it and refusing a place that is not one, the sheet showing a problem only for
//    the place it was about, the device's place filling the field, and no window.alert anywhere;
//  - S6 Back: AppScreen is the only BackButton caller; a sheet's Back closes only that sheet; otherwise the calendar
//    in the saved language, even after an unsaved language pick;
//  - S7 the day chips: toggling, the last day pinned and explained, a culture resetting the days;
//  - S7b the day chips start on the person's week start (Monday, Saturday, Sunday), each chip keeping its own day number;
//  - S8 the header's own back in a browser, none in Telegram 7.7;
//  - S9 React logs no warning; S10 every message the screen reads is there, and none is left over.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-settings-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-settings-render.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { buildSettingsBody, defaultsForCulture, toggleSummaryDay, type SettingsValues } from '../app/[locale]/(app)/settings/settings-body';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// The wheel library (the reminder time's sheet) runs on touch events and animation frames, which the fake DOM has none of:
// a stub with the same props stands in for it, as in smoke-calendar-home-render.ts, before the screen is loaded. The
// library's own markup and ARIA are checked in smoke-date-picker-render.ts.
{
  const wheelLib = nodeRequire.resolve('@ncdai/react-wheel-picker');
  const StubWheel = (p: { options: { value: string; label: unknown }[]; value: string }) =>
    createElement('div', { 'data-stub-wheel': '', 'data-value': p.value, tabIndex: 0 }, p.options.map((o) => createElement('span', { key: o.value }, String(o.label))));
  const StubWrapper = (p: { className?: string; children?: ReactElement }) => createElement('div', { className: p.className }, p.children);
  nodeRequire.cache[wheelLib] = { id: wheelLib, filename: wheelLib, loaded: true, exports: { WheelPicker: StubWheel, WheelPickerWrapper: StubWrapper } } as unknown as NodeJS.Module;
}
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
    if (text.startsWith('[settings]')) return void appLogs.push(text);
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: a router, a fetch and what Nominatim and /api/settings answer ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
const replaces: string[] = [];
const router = { push: (href: string) => void pushes.push(href), replace: (href: string) => void replaces.push(href), prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };

interface FetchCall {
  url: string;
  init: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const world = {
  /** What /api/settings answers: a status, or a function that decides (a hanging request is a promise that never settles until released). */
  settings: (): Response | Promise<Response> => new Response('{"success":true}', { status: 200 }),
  search: (): Response | Promise<Response> => json([{ place_rank: 16, addresstype: 'city' }]),
  reverse: (): Response | Promise<Response> => json({ address: { city: 'Haifa', country: 'Israel' } }),
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url.startsWith('/api/settings')) return world.settings();
  if (url.includes('nominatim.openstreetmap.org/search')) return world.search();
  if (url.includes('nominatim.openstreetmap.org/reverse')) return world.reverse();
  throw new Error(`an unexpected request: ${url}`);
}) as typeof fetch;
const posts = () => fetchCalls.filter((c) => c.url.startsWith('/api/settings'));
const reset = () => {
  pushes.length = 0;
  replaces.length = 0;
  fetchCalls.length = 0;
  appLogs.length = 0;
  world.settings = () => new Response('{"success":true}', { status: 200 });
  world.search = () => json([{ place_rank: 16, addresstype: 'city' }]);
  world.reverse = () => json({ address: { city: 'Haifa', country: 'Israel' } });
};

// ---- Fixtures ----

const settings = (over: Partial<Omit<SettingsValues, 'defaultReminderMinutes'>> & { defaultReminderMinutes?: number | null } = {}) => ({
  language: 'en',
  gender: 'male' as SettingsValues['gender'],
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
  defaultReminderMinutes: 15 as number | null,
  reminderTime: '09:15',
  pickupRemindersEnabled: false,
  voiceInputEnabled: false,
  pauseOnShabbat: true,
  zmanimCommunity: 'sephardi',
  ...over,
});
const subscription = (over: Row = {}) => ({ effectivePlan: 'pro', textSummariesUsed: 3, textSummariesLimit: 10, voiceSummariesUsed: 1, voiceSummariesLimit: -1, remindersAllowed: true, isTrialing: false, ...over });
const propsOf = (over: Row = {}, current: Parameters<typeof settings>[0] = {}) => ({
  userId: 1,
  currentSettings: settings(current),
  weekStart: 0,
  remindersGloballyEnabled: true,
  googleConnected: false,
  nativeRemindersSupported: true,
  subscriptionInfo: subscription(),
  bothChannels: true,
  ...over,
});

let Settings: (props: Row) => ReactElement;
function tree(locale: Locale, props: Row): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Settings, props));
  return createElement(AppRouterContext.Provider, { value: router }, intl);
}

/** What the strings of a language say, by the key of its settings namespace ('alerts.label'). */
const word = (locale: Locale, key: string, ns = 'settings'): string => {
  const value = `${ns}.${key}`.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${ns}.${key} in ${locale}`);
  return value;
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
const sectionLabels = (html: string) => [...html.matchAll(/<h2 class="ch-section-label">([\s\S]*?)<\/h2>/g)].map((m) => textOf(m[1]));

/** The text under a node of the mounted tree, without the style sheets. */
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
const flat = (node: FakeNode) => visible(node).replace(/\s+/g, ' ').trim();
const page = (m: Mounted) => flat(m.container);
const buttonsOf = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'button');
const rowOf = (m: Mounted, label: string) => elements(m.container).find((e) => (e.localName === 'button' || e.localName === 'label') && e.className.split(' ').includes('ch-form-row') && flat(e).startsWith(label));
const switchOf = (m: Mounted, label: string) => byRole(m.container, 'switch').find((e) => flat(e).startsWith(label));
const selectOf = (m: Mounted, label: string) => {
  const row = rowOf(m, label);
  return row && elements(row).find((e) => e.localName === 'select');
};
const saveButton = (m: Mounted) => buttonsOf(m).find((e) => e.className.split(' ').includes('ch-save'));
const dialogs = (m: Mounted) => byRole(m.container, 'dialog');
const chipsOf = (m: Mounted, group: number) => elements(m.container).filter((e) => e.className === 'ch-daychip').slice(group * 7, group * 7 + 7);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** Mount in a browser (no Telegram) or in Telegram `version`; the caller unmounts. */
function open(locale: Locale, props: Row, telegram?: { version: string; scheme?: 'light' | 'dark' }) {
  installWindow();
  const calls: string[] = [];
  const tg = telegram ? fakeTelegram(calls, telegram.version) : null;
  if (tg && telegram?.scheme) tg.colorScheme = telegram.scheme;
  fakeWindow.Telegram = tg ? { WebApp: tg } : undefined;
  const m = mount(tree(locale, props));
  return { m, tg, calls };
}
const close = (opened: ReturnType<typeof open>) => {
  opened.m.unmount();
  fakeWindow.Telegram = undefined;
};

async function main() {
  Settings = (await import('../app/[locale]/(app)/settings/SettingsClient')).default as unknown as (props: Row) => ReactElement;

  await check('S1 render in en, he and ru, light (server) and dark (Telegram): a grouped AppScreen root with its direction and language, the four sections in order, no raw key, no emoji, no English in he and ru beyond the brands and the endonyms, the times left to right', async () => {
    const places: Record<Locale, string> = { en: 'Tel Aviv', he: 'תל אביב', ru: 'Тель-Авив' };
    for (const locale of LOCALES) {
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const p = propsOf({}, { language: locale, location: places[locale] });
      const html = renderToString(tree(locale, p));
      assert(html.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the root: ${html.slice(0, 140)}`);
      const sections = ['place', 'summaries', 'timing', 'events'].map((k) => word(locale, `sections.${k}`));
      assert(show(sectionLabels(html)) === show(sections), `${locale}: the sections: ${show(sectionLabels(html))}`);
      const text = textOf(html);
      assert(!/settings\.|ui\.|calendarHome\./.test(text), `${locale}: a raw key in ${text}`);
      assert(!/\p{Extended_Pictographic}/u.test(text), `${locale}: an emoji`);
      assert(html.includes(`<h1 class="ch-screen-title">${word(locale, 'title')}</h1>`), `${locale}: the title`);
      for (const time of ['07:00', '20:00', '09:15']) assert(html.includes(`<bdi dir="ltr">${time}</bdi>`), `${locale}: ${time} is not left to right`);
      if (locale !== 'en') {
        // The brands and the language endonyms are fixed; the place is the user's, so the fixtures give it in the page's language.
        const bare = text.replace(/Telegram|WhatsApp|Google|FamCal|Pro|English/g, '');
        assert(!/[A-Za-z]/.test(bare), `${locale}: Latin letters in ${bare.match(/\S*[A-Za-z]\S*/g)?.slice(0, 5)}`);
      }
      // Dark, as Telegram says it: the same root with its scheme, and the colours of a dark grouped screen
      const dark = open(locale, p, { version: '7.7', scheme: 'dark' });
      try {
        const root = elements(dark.m.container).find((e) => e.className === 'ch-app ch-screen ch-grouped');
        assert(root && root.getAttribute('data-theme') === 'dark' && root.getAttribute('dir') === dir && root.getAttribute('lang') === locale, `${locale}: the dark root`);
        assert(dark.calls.includes('setHeaderColor(bg_color)') && dark.calls.includes('setBackgroundColor(bg_color)'), `${locale}: dark colours: ${show(dark.calls)}`);
        assert(!dark.calls.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), 'no colour of ours on Telegram');
        assert(show(elements(dark.m.container).filter((e) => e.className === 'ch-section-label').map(flat)) === show(sections), `${locale}: the dark sections`);
      } finally {
        close(dark);
      }
    }
    // A light Telegram theme paints Telegram's header with the ground the cards sit on
    const light = open('en', propsOf(), { version: '7.7', scheme: 'light' });
    try {
      assert(light.calls.includes('setHeaderColor(secondary_bg_color)') && light.calls.includes('setBackgroundColor(secondary_bg_color)'), `light colours: ${show(light.calls)}`);
    } finally {
      close(light);
    }
  });

  await check('S2 the state matrix: alerts (and the default alert and pickup) for Telegram and a plan that allows them; Pro Only with See plans, which goes to the plans, when the plan does not; Coming soon, disabled, when the global switch is off; a WhatsApp-saved user sees only voice input and the reminder time; no reminder time without FamCal reminders; the Google section when connected; usage lines only above a limit of 0; the platform list changes the section only once saved', async () => {
    for (const locale of LOCALES) {
      const w = (key: string) => word(locale, key);
      const full = textOf(renderToString(tree(locale, propsOf({}, { language: locale }))));
      for (const key of ['alerts.label', 'defaultAlert.label', 'pickup.label', 'reminderTime', 'voiceInput.label']) assert(full.includes(w(key)), `${locale}: ${key} is missing`);
      assert(!full.includes(w('alerts.proOnly')) && !full.includes(w('alerts.comingSoon')), `${locale}: a notice that should not show`);
      // Not allowed by the plan
      const noPlan = textOf(renderToString(tree(locale, propsOf({ subscriptionInfo: subscription({ remindersAllowed: false }) }, { language: locale }))));
      assert(noPlan.includes(w('alerts.proOnly')) && noPlan.includes(w('alerts.seePlans')) && noPlan.includes(w('alerts.label')), `${locale}: the plan notice`);
      assert(!noPlan.includes(w('defaultAlert.label')) && !noPlan.includes(w('pickup.label')), `${locale}: the alert rows show without a plan`);
      // Not on for everyone yet
      const soon = textOf(renderToString(tree(locale, propsOf({ remindersGloballyEnabled: false }, { language: locale }))));
      assert(soon.includes(w('alerts.comingSoon')) && !soon.includes(w('alerts.proOnly')) && !soon.includes(w('alerts.seePlans')) && !soon.includes(w('defaultAlert.label')), `${locale}: coming soon`);
      // Saved for WhatsApp only
      const wa = textOf(renderToString(tree(locale, propsOf({}, { language: locale, messagingPlatform: 'whatsapp' }))));
      assert(wa.includes(w('voiceInput.label')) && wa.includes(w('reminderTime')), `${locale}: WhatsApp keeps voice input and the reminder time`);
      for (const key of ['alerts.label', 'alerts.hint', 'defaultAlert.label', 'pickup.label', 'alerts.proOnly']) assert(!wa.includes(w(key)), `${locale}: ${key} shows for a WhatsApp user`);
      // ... and the plan that would not give alerts to a Telegram user says nothing to a WhatsApp one
      const waNoPlan = textOf(renderToString(tree(locale, propsOf({ subscriptionInfo: subscription({ remindersAllowed: false }) }, { language: locale, messagingPlatform: 'whatsapp' }))));
      assert(!waNoPlan.includes(w('alerts.proOnly')) && !waNoPlan.includes(w('alerts.seePlans')), `${locale}: the plan notice shows for a WhatsApp user`);
      // No FamCal reminders: no reminder time
      const none =textOf(renderToString(tree(locale, propsOf({ nativeRemindersSupported: false }, { language: locale }))));
      assert(!none.includes(w('reminderTime')) && none.includes(w('alerts.label')), `${locale}: the reminder time without FamCal reminders`);
      // Google
      const google = renderToString(tree(locale, propsOf({ googleConnected: true }, { language: locale })));
      assert(show(sectionLabels(google)) === show([...['place', 'summaries', 'timing', 'events'].map((k) => w(`sections.${k}`)), w('googleDisconnect.sectionTitle')]), `${locale}: the Google section: ${show(sectionLabels(google))}`);
      assert(!textOf(renderToString(tree(locale, propsOf({}, { language: locale })))).includes(w('googleDisconnect.sectionTitle')), `${locale}: Google shows when not connected`);
    }
    // The usage lines: text has a limit of 10, voice is unlimited (-1), and a limit of 0 shows none
    const en = (over: Row) => textOf(renderToString(tree('en', propsOf({ subscriptionInfo: subscription(over) }))));
    assert(en({}).includes('3 of 10 used this month') && !en({}).includes('1 of -1') && !/of -?1 used/.test(en({})), `usage: ${en({}).match(/\d+ of -?\d+ used this month/g)}`);
    assert(!/of 0 used/.test(en({ textSummariesLimit: 0 })) && !en({ textSummariesLimit: 0 }).includes('used this month'), 'a limit of 0 shows no usage');
    assert(en({ voiceSummariesLimit: 5, voiceSummariesUsed: 2 }).includes('2 of 5 used this month'), 'voice usage');
    // The plan notice goes to the plans, in the saved language
    reset();
    const plan = open('en', propsOf({ subscriptionInfo: subscription({ remindersAllowed: false }) }, { language: 'ru' }));
    try {
      const action = buttonsOf(plan.m).find((b) => b.className === 'ch-notice-action');
      assert(action && flat(action) === word('en', 'alerts.seePlans'), 'the See plans button');
      // The language picked in the list and not saved does not count: the plans open in the saved one
      plan.m.change(selectOf(plan.m, word('en', 'language.label')) as FakeElement, 'he');
      plan.m.click(action);
      assert(show(pushes) === show(['/ru/subscription?user_id=1']), `See plans: ${show(pushes)}`);
      assert(switchOf(plan.m, word('en', 'alerts.label'))?.getAttribute('aria-disabled') === 'true', 'the alerts switch is disabled');
    } finally {
      close(plan);
    }
    const soon = open('en', propsOf({ remindersGloballyEnabled: false }));
    try {
      assert(switchOf(soon.m, word('en', 'alerts.label'))?.getAttribute('aria-disabled') === 'true', 'coming soon: the alerts switch is disabled');
      assert(page(soon.m).includes(word('en', 'alerts.comingSoon')), 'coming soon');
    } finally {
      close(soon);
    }
    // The platform list follows the save: telegram saved, whatsapp picked: the alerts stay until it is saved, then go
    reset();
    const toWhatsApp = open('en', propsOf());
    try {
      const platform = selectOf(toWhatsApp.m, word('en', 'platform.label'));
      assert(platform, 'the platform list');
      toWhatsApp.m.change(platform, 'whatsapp');
      assert(page(toWhatsApp.m).includes(word('en', 'alerts.label')), 'picked WhatsApp, not saved: the alerts rows stay');
      toWhatsApp.m.click(saveButton(toWhatsApp.m) as FakeElement);
      await settle();
      assert(posts().length === 1 && !page(toWhatsApp.m).includes(word('en', 'alerts.label')) && page(toWhatsApp.m).includes(word('en', 'reminderTime')), 'saved: the section follows the saved platform');
    } finally {
      close(toWhatsApp);
    }
    reset();
    const toTelegram = open('en', propsOf({}, { messagingPlatform: 'whatsapp' }));
    try {
      toTelegram.m.change(selectOf(toTelegram.m, word('en', 'platform.label')) as FakeElement, 'telegram');
      assert(!page(toTelegram.m).includes(word('en', 'alerts.label')), 'picked Telegram, not saved: still no alerts rows');
      toTelegram.m.click(saveButton(toTelegram.m) as FakeElement);
      await settle();
      assert(page(toTelegram.m).includes(word('en', 'alerts.label')), 'saved: the alerts rows come');
    } finally {
      close(toTelegram);
    }
  });

  await check('S2b the platform list shows only for a person with both Telegram and WhatsApp: with one channel there is nothing to choose', async () => {
    for (const locale of LOCALES) {
      const label = word(locale, 'platform.label');
      const both = textOf(renderToString(tree(locale, propsOf({ bothChannels: true }, { language: locale }))));
      assert(both.includes(label), `${locale}: both channels: the platform list is missing`);
      for (const platform of ['telegram', 'whatsapp']) {
        const one = textOf(renderToString(tree(locale, propsOf({ bothChannels: false }, { language: locale, messagingPlatform: platform }))));
        assert(!one.includes(label), `${locale}: one channel (${platform}): the platform list shows`);
        assert(one.includes(word(locale, 'language.label')) && one.includes(word(locale, 'culture.label')), `${locale}: one channel: the rest of the card went with it`);
      }
    }
  });

  await check("S3 buildSettingsBody is the JSON the page has always posted, written out here for two fixtures (alerts on with a reminder time; alerts off without FamCal reminders), and the page posts it", async () => {
    const values: SettingsValues = {
      language: 'he',
      gender: 'female',
      location: 'Haifa, Israel',
      messagingPlatform: 'all',
      culture: 'jewish',
      textSummaryEnabled: true,
      voiceSummaryEnabled: true,
      weatherEnabled: false,
      includeLookaheadInTomorrow: true,
      lookaheadAlways7Days: false,
      preferredMorningHour: 6,
      preferredEveningHour: 21,
      dailySummaryDays: [0, 1, 2, 3, 4, 5],
      tomorrowSummaryDays: [0, 1, 2, 3, 4, 6],
      remindersEnabled: true,
      defaultReminderMinutes: 30,
      reminderTime: '08:30',
      pickupRemindersEnabled: true,
      voiceInputEnabled: true,
      pauseOnShabbat: true,
      zmanimCommunity: 'ashkenazi',
    };
    const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
    assert(
      show(wire(buildSettingsBody(values, true, 'init-data'))) ===
        show({
          language: 'he',
          gender: 'female',
          location: 'Haifa, Israel',
          messagingPlatform: 'all',
          culture: 'jewish',
          textSummaryEnabled: true,
          voiceSummaryEnabled: true,
          weatherEnabled: false,
          includeLookaheadInTomorrow: true,
          lookaheadAlways7Days: false,
          preferredMorningHour: 6,
          preferredEveningHour: 21,
          dailySummaryDays: [0, 1, 2, 3, 4, 5],
          tomorrowSummaryDays: [0, 1, 2, 3, 4, 6],
          remindersEnabled: true,
          defaultReminderMinutes: 30,
          reminderTime: '08:30',
          pickupRemindersEnabled: true,
          voiceInputEnabled: true,
          pauseOnShabbat: true,
          zmanimCommunity: 'ashkenazi',
          initData: 'init-data',
        }),
      `alerts on: ${show(wire(buildSettingsBody(values, true, 'init-data')))}`,
    );
    const off = { ...values, remindersEnabled: false, pickupRemindersEnabled: false };
    assert(
      show(wire(buildSettingsBody(off, false, undefined))) ===
        show({
          language: 'he',
          gender: 'female',
          location: 'Haifa, Israel',
          messagingPlatform: 'all',
          culture: 'jewish',
          textSummaryEnabled: true,
          voiceSummaryEnabled: true,
          weatherEnabled: false,
          includeLookaheadInTomorrow: true,
          lookaheadAlways7Days: false,
          preferredMorningHour: 6,
          preferredEveningHour: 21,
          dailySummaryDays: [0, 1, 2, 3, 4, 5],
          tomorrowSummaryDays: [0, 1, 2, 3, 4, 6],
          remindersEnabled: false,
          defaultReminderMinutes: null,
          pickupRemindersEnabled: false,
          voiceInputEnabled: true,
          pauseOnShabbat: true,
          zmanimCommunity: 'ashkenazi',
        }),
      `alerts off: ${show(wire(buildSettingsBody(off, false, undefined)))}`,
    );
    // And the page posts that: one change (the weather off) on the fixture of the other tests, in a Telegram session
    reset();
    const opened = open('en', propsOf(), { version: '7.7' });
    try {
      opened.m.click(switchOf(opened.m, word('en', 'weather.label')) as FakeElement);
      opened.m.click(saveButton(opened.m) as FakeElement);
      await settle();
      assert(posts().length === 1, `${posts().length} requests`);
      const call = posts()[0];
      assert(call.url === '/api/settings?user_id=1' && call.init.method === 'POST' && new Headers(call.init.headers).get('content-type') === 'application/json', `the request: ${call.url} ${call.init.method}`);
      assert(
        show(JSON.parse(String(call.init.body))) ===
          show({
            language: 'en',
            gender: 'male',
            location: 'Tel Aviv',
            messagingPlatform: 'telegram',
            culture: 'jewish',
            textSummaryEnabled: true,
            voiceSummaryEnabled: false,
            weatherEnabled: false,
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
            initData: opened.tg?.initData,
          }),
        `the body: ${String(call.init.body)}`,
      );
    } finally {
      close(opened);
    }
    // A WhatsApp user (no Telegram, the session cookie is the credential) sends no initData; a user with no alert lead yet sends the list's 15
    reset();
    const browser = open('en', propsOf({}, { defaultReminderMinutes: null }));
    try {
      browser.m.click(switchOf(browser.m, word('en', 'weather.label')) as FakeElement);
      browser.m.click(saveButton(browser.m) as FakeElement);
      await settle();
      const body = JSON.parse(String(posts()[0]?.init.body));
      assert(!('initData' in body), `initData in a browser: ${show(body.initData)}`);
      assert(body.defaultReminderMinutes === 15, `the default lead: ${show(body.defaultReminderMinutes)}`);
    } finally {
      close(browser);
    }
  });

  await check('S4 saving on the page: Save is off while nothing differs and on after a change; one tap posts once; an OK answer shows "Saved" and turns Save off; a change takes "Saved" away; a 500 and a failed request show the error as an alert, log it, and leave the controls usable; a saved change of language reloads the page in it, and one that keeps it does not', async () => {
    reset();
    const o = open('en', propsOf());
    try {
      assert(saveButton(o.m)?.hasAttribute('disabled'), 'Save is off while clean');
      assert(!elements(o.m.container).some((e) => e.className === 'ch-save-status'), 'no status yet');
      o.m.click(switchOf(o.m, word('en', 'weather.label')) as FakeElement);
      assert(!saveButton(o.m)?.hasAttribute('disabled'), 'a change turns Save on');
      // A hanging request: two taps, one request, the button busy
      let release: (r: Response) => void = () => undefined;
      world.settings = () => new Promise<Response>((resolve) => void (release = resolve));
      o.m.click(saveButton(o.m) as FakeElement);
      o.m.click(saveButton(o.m) as FakeElement);
      await settle();
      assert(posts().length === 1 && saveButton(o.m)?.getAttribute('aria-busy') === 'true', `a busy save: ${posts().length} requests`);
      await act(async () => {
        release(new Response('{"success":true}', { status: 200 }));
        await new Promise((r) => setTimeout(r, 0));
      });
      const status = elements(o.m.container).find((e) => e.className === 'ch-save-status');
      assert(status && status.getAttribute('role') === 'status' && flat(status) === word('en', 'saved', 'ui') && saveButton(o.m)?.hasAttribute('disabled') && !saveButton(o.m)?.hasAttribute('aria-busy'), 'Saved, and Save is off again');
      assert(replaces.length === 0 && pushes.length === 0, `a save that keeps the language goes nowhere: ${show([replaces, pushes])}`);
      o.m.click(switchOf(o.m, word('en', 'weather.label')) as FakeElement);
      assert(!elements(o.m.container).some((e) => e.className === 'ch-save-status') && !saveButton(o.m)?.hasAttribute('disabled'), 'a change takes Saved away and Save back');
      // A 500: the error as an alert, logged, and the switches still work
      world.settings = () => new Response('{"error":"nope"}', { status: 500 });
      appLogs.length = 0;
      o.m.click(saveButton(o.m) as FakeElement);
      await settle();
      const alerts = byRole(o.m.container, 'alert');
      assert(alerts.length === 1 && flat(alerts[0]) === word('en', 'saveFailed'), `the error: ${show(alerts.map(flat))}`);
      assert(appLogs.some((l) => l.includes('save failed')), `logged: ${show(appLogs)}`);
      assert(!saveButton(o.m)?.hasAttribute('disabled') && !switchOf(o.m, word('en', 'weather.label'))?.hasAttribute('aria-disabled'), 'the controls stay usable');
      // A request that fails outright
      world.settings = () => {
        throw new TypeError('Failed to fetch');
      };
      appLogs.length = 0;
      o.m.click(saveButton(o.m) as FakeElement);
      await settle();
      assert(byRole(o.m.container, 'alert').length === 1 && appLogs.some((l) => l.includes('save failed')), 'a network failure says so too');
      // It works again: the error goes
      world.settings = () => new Response('{"success":true}', { status: 200 });
      o.m.click(saveButton(o.m) as FakeElement);
      await settle();
      assert(byRole(o.m.container, 'alert').length === 0 && page(o.m).includes(word('en', 'saved', 'ui')), 'saved after all');
    } finally {
      close(o);
    }
    // A language change reloads the page in the new one (and only that does)
    reset();
    const lang = open('en', propsOf());
    try {
      lang.m.change(selectOf(lang.m, word('en', 'language.label')) as FakeElement, 'ru');
      lang.m.click(saveButton(lang.m) as FakeElement);
      await settle();
      assert(show(replaces) === show(['/ru/settings?user_id=1']), `the reload: ${show(replaces)}`);
      assert(JSON.parse(String(posts()[0].init.body)).language === 'ru', 'the language was posted');
    } finally {
      close(lang);
    }
  });

  await check('S5 the location: a place checked after the sheet closes; an invalid one gives the error under the row, Save stays off and nothing is sent; while it is checked Save is off; an over-specific one is stored as its city; the device\'s place fills the field with no second question; no device location says so; window.alert is never called, and no source calls it', async () => {
    const alerts: string[] = [];
    (fakeWindow as Row).alert = (message: string) => void alerts.push(message);
    (globalThis as Row).alert = (fakeWindow as Row).alert;
    const type = (o: ReturnType<typeof open>, place: string) => {
      const field = elements(o.m.container).find((e) => e.localName === 'input');
      assert(field, 'the location field');
      o.m.input(field, place);
    };
    const doneButton = (o: ReturnType<typeof open>) => buttonsOf(o.m).find((b) => flat(b) === word('en', 'done', 'ui'));
    reset();
    const o = open('en', propsOf());
    try {
      o.m.click(rowOf(o.m, word('en', 'location.label')) as FakeElement);
      assert(dialogs(o.m).length === 1 && flat(dialogs(o.m)[0]).includes(word('en', 'location.useCurrent')), 'the sheet opens');
      // An invalid place
      world.search = () => json([]);
      type(o, 'Nowhereville');
      o.m.click(doneButton(o) as FakeElement);
      assert(dialogs(o.m).length === 0 && page(o.m).includes('Nowhereville'), 'closing shows the place as typed at once');
      await settle();
      const error = byRole(o.m.container, 'alert');
      assert(error.length === 1 && flat(error[0]) === word('en', 'location.notFound'), `the error under the row: ${show(error.map(flat))}`);
      assert(saveButton(o.m)?.hasAttribute('disabled'), 'Save is off for a place that is not one');
      o.m.click(saveButton(o.m) as FakeElement);
      await settle();
      assert(posts().length === 0, `nothing was sent: ${posts().length}`);
      // Fixing it: while it is checked Save is off, and the check shows
      let answer: (r: Response) => void = () => undefined;
      world.search = () => new Promise<Response>((resolve) => void (answer = resolve));
      o.m.click(rowOf(o.m, word('en', 'location.label')) as FakeElement);
      type(o, 'Haifa');
      o.m.click(doneButton(o) as FakeElement);
      assert(saveButton(o.m)?.hasAttribute('disabled') && page(o.m).includes(word('en', 'location.checking')) && byRole(o.m.container, 'alert').length === 0, 'checking: Save is off, the check is said, the old error is gone');
      await act(async () => {
        answer(json([{ place_rank: 30, addresstype: 'building', address: { city: 'Haifa', country: 'Israel' } }]));
        await new Promise((r) => setTimeout(r, 0));
      });
      await settle();
      assert(page(o.m).includes('Haifa, Israel') && !saveButton(o.m)?.hasAttribute('disabled'), `an over-specific place is stored as its city: ${page(o.m).match(/Haifa[^ ]*( Israel)?/)}`);
      o.m.click(saveButton(o.m) as FakeElement);
      await settle();
      assert(posts().length === 1 && JSON.parse(String(posts()[0].init.body)).location === 'Haifa, Israel', `posted: ${String(posts()[0]?.init.body).slice(0, 120)}`);
      // The check that cannot be made is its own error
      world.search = () => json({}, 503);
      o.m.click(rowOf(o.m, word('en', 'location.label')) as FakeElement);
      type(o, 'Eilat');
      o.m.click(doneButton(o) as FakeElement);
      await settle();
      assert(flat(byRole(o.m.container, 'alert')[0]) === word('en', 'location.checkFailed') && appLogs.some((l) => l.includes('location check')), `the check failed: ${show(appLogs)}`);
    } finally {
      close(o);
    }
    // A check that could not be made is retried by closing the sheet again, and Save waits for it
    const searches = () => fetchCalls.filter((c) => c.url.includes('nominatim.openstreetmap.org/search')).length;
    const openLocation = (r: ReturnType<typeof open>) => r.m.click(rowOf(r.m, word('en', 'location.label')) as FakeElement);
    const sheetAlerts = (r: ReturnType<typeof open>) => (dialogs(r.m)[0] ? byRole(dialogs(r.m)[0], 'alert').map(flat) : []);
    const invalid = (r: ReturnType<typeof open>) => elements(r.m.container).find((e) => e.localName === 'input')?.getAttribute('aria-invalid');
    const cityAnswer = () => json([{ place_rank: 16, addresstype: 'city' }]);
    reset();
    const retry = open('en', propsOf());
    try {
      world.search = () => json({}, 503);
      openLocation(retry);
      type(retry, 'Eilat');
      retry.m.click(doneButton(retry) as FakeElement);
      await settle();
      assert(searches() === 1 && flat(byRole(retry.m.container, 'alert')[0]) === word('en', 'location.checkFailed') && saveButton(retry.m)?.hasAttribute('disabled'), `a failed check: ${searches()} search(es)`);
      retry.m.click(switchOf(retry.m, word('en', 'weather.label')) as FakeElement);
      assert(saveButton(retry.m)?.hasAttribute('disabled'), 'while the place has failed its check, Save stays off for any change');
      // Nominatim recovers: the sheet closed again, unchanged, asks again
      world.search = cityAnswer;
      openLocation(retry);
      retry.m.click(doneButton(retry) as FakeElement);
      await settle();
      assert(searches() === 2 && byRole(retry.m.container, 'alert').length === 0 && !saveButton(retry.m)?.hasAttribute('disabled'), `retried: ${searches()} search(es), ${byRole(retry.m.container, 'alert').length} alert(s)`);
      // Reopened while a check is running: the sheet says "Checking" of the place it holds, and not of what is typed since
      let answer: (r: Response) => void = () => undefined;
      world.search = () => new Promise<Response>((resolve) => void (answer = resolve));
      openLocation(retry);
      type(retry, 'Acre');
      retry.m.click(doneButton(retry) as FakeElement);
      openLocation(retry);
      const checking = () => (dialogs(retry.m)[0] ? elements(dialogs(retry.m)[0]).filter((e) => e.getAttribute('role') === 'status').map(flat) : []);
      assert(show(checking()) === show([word('en', 'location.checking')]), `reopened mid-check: ${show(checking())}`);
      type(retry, 'Ac');
      assert(checking().length === 0, `typing hides it: ${show(checking())}`);
      retry.m.click(doneButton(retry) as FakeElement);
      await act(async () => {
        answer(cityAnswer());
        await new Promise((r) => setTimeout(r, 0));
      });
      await settle();
      assert(!page(retry.m).includes(word('en', 'location.checking')) && !saveButton(retry.m)?.hasAttribute('disabled'), 'the last check answered');
    } finally {
      close(retry);
    }
    // A place that is not one: closing the sheet on it again, or typing the same name again, asks again and never lets it through
    reset();
    const again = open('en', propsOf());
    const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      world.search = () => json([]);
      openLocation(again);
      type(again, 'Nowhere');
      again.m.click(doneButton(again) as FakeElement);
      await settle();
      assert(searches() === 1 && saveButton(again.m)?.hasAttribute('disabled'), `not found: ${searches()} search(es)`);
      openLocation(again);
      assert(show(sheetAlerts(again)) === show([word('en', 'location.notFound')]) && invalid(again) === 'true', `the sheet says what the check said of the place it holds: ${show(sheetAlerts(again))}, aria-invalid ${invalid(again)}`);
      // Typing hides it: it was said of the old value
      type(again, 'Now');
      assert(sheetAlerts(again).length === 0 && invalid(again) === null, `typing hides the old error: ${show(sheetAlerts(again))}, aria-invalid ${invalid(again)}`);
      // The same name typed again: checked again (not dropped, not let through)
      type(again, 'Nowhere');
      again.m.click(doneButton(again) as FakeElement);
      await settle();
      assert(searches() === 2 && flat(byRole(again.m.container, 'alert')[0]) === word('en', 'location.notFound') && saveButton(again.m)?.hasAttribute('disabled'), `the same name again: ${searches()} search(es)`);
      // Closed unchanged, with nothing typed: checked again too
      openLocation(again);
      again.m.click(doneButton(again) as FakeElement);
      await settle();
      assert(searches() === 3 && saveButton(again.m)?.hasAttribute('disabled') && byRole(again.m.container, 'alert').length === 1, `closed unchanged: ${searches()} search(es)`);
      // A place the device finds hides the old error as typing does, and is checked on closing
      Object.defineProperty(globalThis, 'navigator', { value: { geolocation: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 32.8, longitude: 34.99 } }) } }, configurable: true });
      world.search = cityAnswer;
      openLocation(again);
      assert(sheetAlerts(again).length === 1, 'the old error shows on the place it was about');
      again.m.click(buttonsOf(again.m).find((b) => flat(b) === word('en', 'location.useCurrent')) as FakeElement);
      await settle();
      assert(sheetAlerts(again).length === 0 && invalid(again) === null && (elements(again.m.container).find((e) => e.localName === 'input') as FakeElement).value === 'Haifa, Israel', `a device fill hides it: ${show(sheetAlerts(again))}`);
      again.m.click(doneButton(again) as FakeElement);
      await settle();
      assert(searches() === 4 && byRole(again.m.container, 'alert').length === 0 && !saveButton(again.m)?.hasAttribute('disabled'), `checked and let through: ${searches()} search(es)`);
    } finally {
      if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
      close(again);
    }
    // The device's place
    reset();
    const here = open('en', propsOf());
    const navigatorNow = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const useCurrent = () => buttonsOf(here.m).find((b) => flat(b) === word('en', 'location.useCurrent')) as FakeElement;
    try {
      here.m.click(rowOf(here.m, word('en', 'location.label')) as FakeElement);
      // No geolocation at all
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
      here.m.click(useCurrent());
      await settle();
      assert(flat(byRole(here.m.container, 'alert')[0]) === word('en', 'location.noDeviceLocation'), `no device location: ${show(byRole(here.m.container, 'alert').map(flat))}`);
      // A position, a place
      Object.defineProperty(globalThis, 'navigator', { value: { geolocation: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 32.8, longitude: 34.99 } }) } }, configurable: true });
      here.m.click(useCurrent());
      await settle();
      const field = elements(here.m.container).find((e) => e.localName === 'input') as FakeElement;
      assert(field.value === 'Haifa, Israel' && byRole(here.m.container, 'alert').length === 0, `the field: ${field.value}`);
      assert(!page(here.m).includes('Is this your location'), 'no second question');
      assert(fetchCalls.some((c) => c.url.includes('reverse?lat=32.8&lon=34.99')), `the reverse lookup: ${show(fetchCalls.map((c) => c.url))}`);
      // A refused position
      Object.defineProperty(globalThis, 'navigator', { value: { geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error('denied')) } }, configurable: true });
      appLogs.length = 0;
      here.m.click(useCurrent());
      await settle();
      assert(flat(byRole(here.m.container, 'alert')[0]) === word('en', 'location.deviceFailed') && appLogs.some((l) => l.includes('current location failed')), `refused: ${show(appLogs)}`);
    } finally {
      if (navigatorNow) Object.defineProperty(globalThis, 'navigator', navigatorNow);
      close(here);
    }
    assert(alerts.length === 0, `window.alert was called: ${show(alerts)}`);
    for (const file of fs.readdirSync(path.join(ROOT, 'app/[locale]/(app)/settings')).filter((f) => /\.tsx?$/.test(f))) {
      const code = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/settings', file), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      assert(!/(?<![\w.])(?:window\.)?alert\(/.test(code), `${file} calls alert()`);
    }
  });

  await check("S6 Back: AppScreen is the only BackButton caller on Settings; Telegram's Back closes only the sheet that is open (time, location, Google) and does nothing while the disconnect is in flight; with none open it returns to the calendar in the saved language, even after an unsaved language pick", async () => {
    for (const file of fs.readdirSync(path.join(ROOT, 'app/[locale]/(app)/settings')).filter((f) => /\.tsx?$/.test(f))) {
      const code = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/settings', file), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      assert(!/useTelegramBackButton\(/.test(code), `${file} calls useTelegramBackButton`);
    }
    reset();
    const o = open('en', propsOf({ googleConnected: true }), { version: '7.7' });
    const back = () => act(() => void (o.tg as Row).backHandlers[0]());
    // A sheet that is open locks Telegram's swipe down; closing it lets it go
    const swipes = () => o.calls.filter((c) => /VerticalSwipes/.test(c)).at(-1);
    try {
      assert((o.tg as Row).backHandlers.length === 1, `one BackButton handler: ${(o.tg as Row).backHandlers.length}`);
      assert(swipes() === 'enableVerticalSwipes()', `swipes at the start: ${swipes()}`);
      // The reminder time sheet
      o.m.click(rowOf(o.m, word('en', 'reminderTime')) as FakeElement);
      assert(dialogs(o.m).length === 1 && swipes() === 'disableVerticalSwipes()', `the time sheet opens, swipes ${swipes()}`);
      back();
      assert(dialogs(o.m).length === 0 && pushes.length === 0 && swipes() === 'enableVerticalSwipes()', `Back closes the time sheet only: ${dialogs(o.m).length} dialog(s), ${show(pushes)}, swipes ${swipes()}`);
      // The location sheet
      o.m.click(rowOf(o.m, word('en', 'location.label')) as FakeElement);
      assert(dialogs(o.m).length === 1 && swipes() === 'disableVerticalSwipes()', `the location sheet opens, swipes ${swipes()}`);
      back();
      assert(dialogs(o.m).length === 0 && pushes.length === 0 && swipes() === 'enableVerticalSwipes()', `Back closes the location sheet only: ${show(pushes)}, swipes ${swipes()}`);
      // The Google sheet, and not while it works
      o.m.click(elements(o.m.container).find((e) => e.localName === 'button' && e.className.includes('ch-danger-row')) as FakeElement);
      assert(dialogs(o.m).length === 1 && swipes() === 'disableVerticalSwipes()', `the Google sheet opens, swipes ${swipes()}`);
      let release: (r: Response) => void = () => undefined;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (() => new Promise<Response>((resolve) => void (release = resolve))) as typeof fetch;
      o.m.click(elements(o.m.container).find((e) => e.className.includes('ch-btn-danger')) as FakeElement);
      back();
      assert(dialogs(o.m).length === 1 && pushes.length === 0, `Back does nothing while the disconnect is in flight: ${dialogs(o.m).length} dialog(s), ${show(pushes)}`);
      await act(async () => {
        release(json({ status: 'disconnected', leftover: [] }));
        await new Promise((r) => setTimeout(r, 0));
      });
      globalThis.fetch = origFetch;
      back();
      assert(dialogs(o.m).length === 0 && pushes.length === 0 && !page(o.m).includes(word('en', 'googleDisconnect.sectionTitle')), `Back closes the result, and Google is gone: ${show(pushes)}`);
      // None open: the calendar, in the saved language (a language picked and not saved does not count)
      o.m.change(selectOf(o.m, word('en', 'language.label')) as FakeElement, 'ru');
      back();
      assert(show(pushes) === show(['/en/dashboard?user_id=1']), `Back with nothing open: ${show(pushes)}`);
    } finally {
      close(o);
    }
    // After a saved change of language, Back goes to the new one
    reset();
    const saved = open('en', propsOf(), { version: '7.7' });
    try {
      saved.m.change(selectOf(saved.m, word('en', 'language.label')) as FakeElement, 'he');
      saved.m.click(saveButton(saved.m) as FakeElement);
      await settle();
      act(() => void (saved.tg as Row).backHandlers[0]());
      assert(show(pushes) === show(['/he/dashboard?user_id=1']), `Back after saving Hebrew: ${show(pushes)}`);
    } finally {
      close(saved);
    }
  });

  await check('S7 the day chips: they are the editor\'s chips, Sunday first, named in full; a tap turns a day on or off; the last day that is on is pinned (aria-disabled, described by "at least one day stays on", which shows only then); choosing a culture resets the days', async () => {
    reset();
    const o = open('en', propsOf({}, { culture: 'default', dailySummaryDays: [0, 1, 2], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6] }));
    try {
      const morning = () => chipsOf(o.m, 0);
      const evening = () => chipsOf(o.m, 1);
      const on = (chips: FakeElement[]) => chips.map((c, i) => (c.getAttribute('aria-pressed') === 'true' ? i : null)).filter((i) => i !== null);
      assert(show(morning().map(flat)) === show(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) && show(morning().map((c) => c.getAttribute('aria-label'))) === show(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']), 'seven days, Sunday first, named in full');
      assert(show(byRole(o.m.container, 'group').map((g) => g.getAttribute('aria-label'))) === show([word('en', 'morning.days'), word('en', 'evening.days')]), 'the two groups');
      assert(show(on(morning())) === show([0, 1, 2]) && show(on(evening())) === show([0, 1, 2, 3, 4, 5, 6]), 'the days that are on');
      o.m.click(morning()[5]);
      o.m.click(evening()[6]);
      assert(show(on(morning())) === show([0, 1, 2, 5]) && show(on(evening())) === show([0, 1, 2, 3, 4, 5]), `after a tap each: ${show([on(morning()), on(evening())])}`);
      assert(!page(o.m).includes(word('en', 'oneDayStays')) && morning().every((c) => !c.hasAttribute('aria-disabled')), 'no hint while several days are on');
      // Down to one day: it is pinned and described
      for (const index of [0, 1, 5]) o.m.click(morning()[index]);
      assert(show(on(morning())) === show([2]), `one left: ${show(on(morning()))}`);
      const pinned = morning()[2];
      const hint = elements(o.m.container).find((e) => e.getAttribute('id') === pinned.getAttribute('aria-describedby'));
      assert(pinned.getAttribute('aria-disabled') === 'true' && hint && flat(hint) === word('en', 'oneDayStays'), 'the last day is pinned and described');
      o.m.click(pinned);
      assert(show(on(morning())) === show([2]), 'a tap on the last day does nothing');
      o.m.click(morning()[3]);
      assert(show(on(morning())) === show([2, 3]) && !page(o.m).includes(word('en', 'oneDayStays')), 'a second day unpins it');
      // The culture resets the days: Jewish skips Shabbat in the morning and Friday in the evening; the other keeps all
      o.m.change(selectOf(o.m, word('en', 'culture.label')) as FakeElement, 'jewish');
      assert(show(on(morning())) === show([0, 1, 2, 3, 4, 5]) && show(on(evening())) === show([0, 1, 2, 3, 4, 6]), `Jewish: ${show([on(morning()), on(evening())])}`);
      o.m.change(selectOf(o.m, word('en', 'culture.label')) as FakeElement, 'default');
      assert(show(on(morning())) === show([0, 1, 2, 3, 4, 5, 6]) && show(on(evening())) === show([0, 1, 2, 3, 4, 5, 6]), `General: ${show([on(morning()), on(evening())])}`);
    } finally {
      close(o);
    }
    // The rules themselves: the last day cannot go, a day comes in its place in the week, the Jewish culture skips Shabbat and Friday
    assert(show(toggleSummaryDay([2], 2)) === show([2]) && show(toggleSummaryDay([2, 3], 2)) === show([3]) && show(toggleSummaryDay([4, 1], 3)) === show([1, 3, 4]), 'toggleSummaryDay');
    assert(show(defaultsForCulture('jewish')) === show({ dailySummaryDays: [0, 1, 2, 3, 4, 5], tomorrowSummaryDays: [0, 1, 2, 3, 4, 6], pauseOnShabbat: true }) && show(defaultsForCulture('default')) === show({ dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6], pauseOnShabbat: false }), 'defaultsForCulture');
    // Hebrew: the same days, named in Hebrew, in the order that mirrors on its own
    const he = renderToString(tree('he', propsOf({}, { language: 'he' })));
    const heChips = [...he.matchAll(/<button type="button" class="ch-daychip" data-day="(\d)"[^>]*>([^<]*)<\/button>/g)].map((m) => m[2]);
    assert(show(heChips.slice(0, 7)) === show(['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'שבת']), `Hebrew chips: ${show(heChips)}`);
  });

  await check('S7b the day chips start on the person\'s week start: a Monday-start person sees Mon..Sun, a Saturday-start person Sat..Fri, a Sunday-start person is unchanged; every chip keeps its own day number (data-day, 0 = Sunday), so what is on, what is pinned and what Save posts follow the day and not the position, in en, he and ru', async () => {
    const dayIds = (chips: FakeElement[]) => chips.map((c) => c.getAttribute('data-day'));
    const on = (chips: FakeElement[]) => chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => Number(c.getAttribute('data-day')));
    const cases: [number, string[], string[], string[]][] = [
      [0, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], ['0', '1', '2', '3', '4', '5', '6'], ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']],
      [1, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ['1', '2', '3', '4', '5', '6', '0'], ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']],
      [6, ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'], ['6', '0', '1', '2', '3', '4', '5'], ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']],
    ];
    for (const [weekStart, shorts, ids, fulls] of cases) {
      reset();
      const o = open('en', propsOf({ weekStart }, { culture: 'default', dailySummaryDays: [0, 1, 2], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6] }));
      try {
        for (const group of [0, 1]) {
          const chips = chipsOf(o.m, group);
          assert(show(chips.map(flat)) === show(shorts), `week start ${weekStart}, group ${group}, labels: ${show(chips.map(flat))}`);
          assert(show(dayIds(chips)) === show(ids), `week start ${weekStart}, group ${group}, data-day: ${show(dayIds(chips))}`);
          assert(show(chips.map((c) => c.getAttribute('aria-label'))) === show(fulls), `week start ${weekStart}, group ${group}, full names`);
        }
        // What is on follows the day, whatever the position
        assert(show(on(chipsOf(o.m, 0)).sort()) === show([0, 1, 2]) && show(on(chipsOf(o.m, 1)).sort()) === show([0, 1, 2, 3, 4, 5, 6]), `week start ${weekStart}: the days that are on`);
      } finally {
        close(o);
      }
    }

    // A tap on the first chip of a Monday-start row turns Monday (1) off, and on the last chip Sunday (0): Save posts the day numbers
    reset();
    const monday = open('en', propsOf({ weekStart: 1 }, { culture: 'default', dailySummaryDays: [0, 1, 2], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6] }));
    try {
      monday.m.click(chipsOf(monday.m, 0)[0]);
      monday.m.click(chipsOf(monday.m, 1)[6]);
      assert(show(on(chipsOf(monday.m, 0)).sort()) === show([0, 2]) && show(on(chipsOf(monday.m, 1)).sort()) === show([1, 2, 3, 4, 5, 6]), `after the taps: ${show([on(chipsOf(monday.m, 0)), on(chipsOf(monday.m, 1))])}`);
      monday.m.click(saveButton(monday.m) as FakeElement);
      await settle();
      const body = JSON.parse(String(posts()[0]?.init.body));
      assert(show(body.dailySummaryDays) === show([0, 2]) && show(body.tomorrowSummaryDays) === show([1, 2, 3, 4, 5, 6]), `Save posts the day numbers: ${show([body.dailySummaryDays, body.tomorrowSummaryDays])}`);
    } finally {
      close(monday);
    }

    // The last day left is the pinned one wherever it sits: Sunday is the last chip of a Monday-start row
    reset();
    const pinned = open('en', propsOf({ weekStart: 1 }, { culture: 'default', dailySummaryDays: [0], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6] }));
    try {
      const chips = chipsOf(pinned.m, 0);
      const flagged = chips.filter((c) => c.getAttribute('aria-disabled') === 'true');
      assert(flagged.length === 1 && flagged[0] === chips[6] && flagged[0].getAttribute('data-day') === '0', `the pinned chip: ${show(flagged.map((c) => c.getAttribute('data-day')))}`);
      pinned.m.click(chips[6]);
      assert(show(on(chipsOf(pinned.m, 0))) === show([0]), 'a tap on the pinned Sunday does nothing');
    } finally {
      close(pinned);
    }

    // Hebrew and Russian: the same order in the markup (the row mirrors on its own in Hebrew)
    const orderOf = (locale: Locale, weekStart: number) => {
      const html = renderToString(tree(locale, propsOf({ weekStart }, { language: locale })));
      return [...html.matchAll(/<button type="button" class="ch-daychip" data-day="(\d)"[^>]*>([^<]*)<\/button>/g)].slice(0, 7).map((m) => [m[1], m[2]]);
    };
    assert(show(orderOf('he', 1).map((m) => m[0])) === show(['1', '2', '3', '4', '5', '6', '0']) && show(orderOf('he', 1).map((m) => m[1])) === show(['ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'שבת', 'א׳']), `Hebrew, Monday first: ${show(orderOf('he', 1))}`);
    assert(show(orderOf('he', 0).map((m) => m[0])) === show(['0', '1', '2', '3', '4', '5', '6']) && show(orderOf('he', 0).map((m) => m[1])) === show(['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'שבת']), `Hebrew, Sunday first, unchanged: ${show(orderOf('he', 0))}`);
    assert(show(orderOf('ru', 1).map((m) => m[0])) === show(['1', '2', '3', '4', '5', '6', '0']), `Russian, Monday first: ${show(orderOf('ru', 1))}`);
    assert(show(orderOf('ru', 6).map((m) => m[0])) === show(['6', '0', '1', '2', '3', '4', '5']), `Russian, Saturday first: ${show(orderOf('ru', 6))}`);
  });

  await check('S11 the pause switch (Task 2): in the Language and place card right under the calendar, in en, he and ru, in its language, on as saved; a tap changes it and Save posts it; picking a calendar sets it the way it sets the days (Jewish on, General off) and the person can change it after; saved off it stays off', async () => {
    for (const locale of LOCALES) {
      const html = renderToString(tree(locale, propsOf({}, { language: locale })));
      const text = textOf(html);
      const label = word(locale, 'pause.label');
      const hint = word(locale, 'pause.hint');
      assert(text.includes(label) && text.includes(hint), `${locale}: the label and the hint`);
      // In the first card, after the calendar row and before the platform row
      assert(text.indexOf(word(locale, 'culture.label')) < text.indexOf(label) && text.indexOf(label) < text.indexOf(word(locale, 'platform.label')), `${locale}: the switch sits between the calendar and the platform`);
      assert(sectionLabels(html)[0] === word(locale, 'sections.place') && html.indexOf(label) < html.indexOf(`<h2 class="ch-section-label">${word(locale, 'sections.summaries')}`), `${locale}: in the first card`);
    }
    assert(word('en', 'pause.label') === 'Pause messages on Shabbat and Yom Tov' && word('he', 'pause.label') === 'השהיית הודעות בשבת ובחג' && word('ru', 'pause.label') === 'Пауза в Шаббат и праздники', 'the owner\'s labels');
    assert(word('en', 'pause.hint') === 'Nothing is sent from sunset until nightfall' && word('he', 'pause.hint') === 'לא נשלחות הודעות מהשקיעה ועד צאת השבת או החג' && word('ru', 'pause.hint') === 'С заката до выхода звёзд ничего не приходит', 'the owner\'s hints (the pause begins at sunset, not candle lighting: 2026-10-28)');

    const label = word('en', 'pause.label');
    const checked = (m: Mounted) => switchOf(m, label)?.getAttribute('aria-checked');
    // As saved: on for the Jewish calendar, off when saved off
    reset();
    const on = open('en', propsOf());
    try {
      assert(checked(on.m) === 'true' && saveButton(on.m)?.hasAttribute('disabled'), 'on as saved, Save off');
      on.m.click(switchOf(on.m, label) as FakeElement);
      assert(checked(on.m) === 'false' && !saveButton(on.m)?.hasAttribute('disabled'), 'a tap turns it off and Save comes on');
      on.m.click(saveButton(on.m) as FakeElement);
      await settle();
      const body = JSON.parse(String(posts()[0].init.body));
      assert(posts().length === 1 && body.pauseOnShabbat === false && body.culture === 'jewish', `the request: ${show(body)}`);
    } finally {
      close(on);
    }
    reset();
    const off = open('en', propsOf({}, { pauseOnShabbat: false }));
    try {
      assert(checked(off.m) === 'false', 'saved off stays off');
      // Picking the other calendar and back: each sets the switch the way it sets the days
      const culture = () => selectOf(off.m, word('en', 'culture.label')) as FakeElement;
      off.m.change(culture(), 'default');
      assert(checked(off.m) === 'false', 'General: off');
      off.m.change(culture(), 'jewish');
      assert(checked(off.m) === 'true', 'Jewish: on');
      off.m.click(switchOf(off.m, label) as FakeElement);
      assert(checked(off.m) === 'false', 'and the person can turn it off after');
      off.m.change(culture(), 'default');
      off.m.click(switchOf(off.m, label) as FakeElement);
      assert(checked(off.m) === 'true', 'and on under General');
      off.m.click(saveButton(off.m) as FakeElement);
      await settle();
      const body = JSON.parse(String(posts()[0].init.body));
      assert(body.pauseOnShabbat === true && body.culture === 'default', `General with the switch on is posted as picked: ${show(body)}`);
    } finally {
      close(off);
    }
  });

  await check('S12 the zmanim community (Task 3): a "Zmanim" row in the Language and place card right under Location, with Sephardi (as in Zmanei Yosef), Ashkenazi and Chabad in the person\'s language, the saved one selected; a pick enables Save and is posted; it does not touch the pause switch or the days', async () => {
    const options: Record<string, string[]> = {
      en: ['Sephardi (as in Zmanei Yosef)', 'Ashkenazi (Israel)', 'Chabad'],
      he: ['ספרדי (כמו בזמני יוסף)', 'אשכנזי (ישראל)', 'חב״ד'],
      ru: ['Сефардский (как в «Зманей Йосеф»)', 'Ашкеназский (Израиль)', 'Хабад'],
    };
    for (const locale of LOCALES) {
      const html = renderToString(tree(locale, propsOf({}, { language: locale })));
      const text = textOf(html);
      const label = word(locale, 'zmanim.label');
      assert(text.includes(label) && text.includes(word(locale, 'zmanim.hint')), `${locale}: the label and the hint`);
      assert(text.indexOf(word(locale, 'location.label')) < text.indexOf(label) && text.indexOf(label) < text.indexOf(word(locale, 'culture.label')), `${locale}: the row sits between the location and the calendar`);
      assert(sectionLabels(html)[0] === word(locale, 'sections.place') && html.indexOf(label) < html.indexOf(`<h2 class="ch-section-label">${word(locale, 'sections.summaries')}`), `${locale}: in the first card`);
      assert(show(['sephardi', 'ashkenazi', 'chabad'].map((c) => word(locale, `zmanim.${c}`))) === show(options[locale]), `${locale}: ${show(['sephardi', 'ashkenazi', 'chabad'].map((c) => word(locale, `zmanim.${c}`)))}`);
    }
    reset();
    const a = open('en', propsOf({}, { zmanimCommunity: 'ashkenazi' }));
    try {
      const select = () => selectOf(a.m, 'Zmanim') as FakeElement;
      const optionTexts = elements(select()).filter((e) => e.localName === 'option').map((o) => o.textContent);
      assert(show(optionTexts) === show(options.en), `the options: ${show(optionTexts)}`);
      assert((rowOf(a.m, 'Zmanim')?.textContent ?? '').includes(options.en[1]), 'the saved community is shown');
      assert(saveButton(a.m)?.hasAttribute('disabled'), 'Save off while nothing differs');
      a.m.change(select(), 'chabad');
      assert((rowOf(a.m, 'Zmanim')?.textContent ?? '').includes('Chabad') && !saveButton(a.m)?.hasAttribute('disabled'), 'a pick shows and enables Save');
      a.m.click(saveButton(a.m) as FakeElement);
      await settle();
      const body = JSON.parse(String(posts()[0].init.body));
      assert(posts().length === 1 && body.zmanimCommunity === 'chabad' && body.pauseOnShabbat === true && show(body.dailySummaryDays) === show([0, 1, 2, 3, 4, 5]), `the request: ${show(body)}`);
    } finally {
      close(a);
    }
    // The default for a person who never chose is Sephardi, and the page posts it as it is.
    reset();
    const b = open('en', propsOf({}, {}));
    try {
      assert((rowOf(b.m, 'Zmanim')?.textContent ?? '').includes(options.en[0]), 'Sephardi by default');
    } finally {
      close(b);
    }
  });

  await check('S13 "Address me as" (the gender row): a row in the Language and place card right under Language, labelled in the person\'s language with two options (male, female) in it, the saved one shown; a pick enables Save and is posted as "male" or "female"; picking it back before saving leaves Save off; once saved the new value is the baseline', async () => {
    // Written out, so a change of wording is seen here: the label and the two options of each language
    const copy: Record<Locale, { label: string; male: string; female: string }> = {
      en: { label: 'Address me as', male: 'Male', female: 'Female' },
      he: { label: 'לשון פנייה', male: 'זכר', female: 'נקבה' },
      ru: { label: 'Как к вам обращаться', male: 'В мужском роде', female: 'В женском роде' },
    };
    for (const locale of LOCALES) {
      const want = copy[locale];
      assert(word(locale, 'gender.label') === want.label && word(locale, 'gender.male') === want.male && word(locale, 'gender.female') === want.female, `${locale}: the messages: ${word(locale, 'gender.label')} / ${word(locale, 'gender.male')} / ${word(locale, 'gender.female')}`);
      for (const gender of ['male', 'female'] as const) {
        const html = renderToString(tree(locale, propsOf({}, { language: locale, gender })));
        const text = textOf(html);
        assert(!/settings\./.test(text), `${locale}: a raw key in ${text}`);
        assert(html.indexOf(want.label) < html.indexOf(`<h2 class="ch-section-label">${word(locale, 'sections.summaries')}`), `${locale}: in the first card`);
        // The row shows the saved choice and the select holds both, in the language of the page
        const m = open(locale, propsOf({}, { language: locale, gender }));
        try {
          const row = rowOf(m.m, want.label);
          assert(row, `${locale}: no row ${want.label}`);
          // The rows of the page, in order: Language, then this one, then Location
          const rows = elements(m.m.container).filter((e) => (e.localName === 'button' || e.localName === 'label') && e.className.split(' ').includes('ch-form-row'));
          const firstThree = rows.slice(0, 3).map((r) => flat(r));
          assert(firstThree[0].startsWith(word(locale, 'language.label')) && firstThree[1].startsWith(want.label) && firstThree[2].startsWith(word(locale, 'location.label')), `${locale}: the first rows are ${show(firstThree)}`);
          const shown = elements(row).find((e) => e.className.split(' ').includes('ch-form-value-text'));
          assert(shown && flat(shown) === want[gender], `${locale} ${gender}: the row shows ${shown ? flat(shown) : '(nothing)'}`);
          const select = selectOf(m.m, want.label) as FakeElement;
          const options = elements(select).filter((e) => e.localName === 'option');
          assert(show(options.map((o) => [o.getAttribute('value'), o.textContent])) === show([['male', want.male], ['female', want.female]]), `${locale}: the options ${show(options.map((o) => [o.getAttribute('value'), o.textContent]))}`);
          assert(saveButton(m.m)?.hasAttribute('disabled'), `${locale}: Save is off while nothing differs`);
        } finally {
          close(m);
        }
      }
    }
    // A pick enables Save and is posted; the old value is no longer the baseline once saved
    reset();
    const a = open('en', propsOf());
    try {
      const select = () => selectOf(a.m, 'Address me as') as FakeElement;
      a.m.change(select(), 'female');
      assert((rowOf(a.m, 'Address me as')?.textContent ?? '').includes('Female') && !saveButton(a.m)?.hasAttribute('disabled'), 'a pick shows and enables Save');
      // ... and picking the saved value back, before saving, is no change
      a.m.change(select(), 'male');
      assert(saveButton(a.m)?.hasAttribute('disabled'), 'back to the saved value: Save is off again');
      a.m.change(select(), 'female');
      a.m.click(saveButton(a.m) as FakeElement);
      await settle();
      const body = JSON.parse(String(posts()[0].init.body));
      assert(posts().length === 1 && body.gender === 'female' && body.language === 'en' && body.culture === 'jewish', `the request: ${show(body)}`);
      assert(saveButton(a.m)?.hasAttribute('disabled'), 'saved: Save is off');
      a.m.change(select(), 'male');
      assert(!saveButton(a.m)?.hasAttribute('disabled'), 'female is the baseline now: male differs');
      a.m.click(saveButton(a.m) as FakeElement);
      await settle();
      assert(posts().length === 2 && JSON.parse(String(posts()[1].init.body)).gender === 'male', `the second request: ${posts().map((c) => String(c.init.body).slice(0, 60))}`);
    } finally {
      close(a);
    }
    // A saved female shows female, and saving something else posts her choice as it is
    reset();
    const b = open('he', propsOf({}, { language: 'he', gender: 'female' }));
    try {
      b.m.click(switchOf(b.m, word('he', 'weather.label')) as FakeElement);
      b.m.click(saveButton(b.m) as FakeElement);
      await settle();
      assert(JSON.parse(String(posts()[0].init.body)).gender === 'female', `a female user's other save: ${String(posts()[0].init.body).slice(0, 80)}`);
    } finally {
      close(b);
    }
  });

  await check("S8 the header's own back: in a browser there is a button named Back that goes where Telegram's Back goes; in Telegram 7.7 there is none (the BackButton is Telegram's)", () => {
    reset();
    const browser = open('en', propsOf());
    try {
      const back = buttonsOf(browser.m).filter((b) => b.getAttribute('aria-label') === word('en', 'back', 'ui'));
      assert(back.length === 1, `the in-page back: ${back.length}`);
      browser.m.click(back[0]);
      assert(show(pushes) === show(['/en/dashboard?user_id=1']), `its tap: ${show(pushes)}`);
    } finally {
      close(browser);
    }
    const telegram = open('en', propsOf(), { version: '7.7' });
    try {
      assert(!buttonsOf(telegram.m).some((b) => b.getAttribute('aria-label') === word('en', 'back', 'ui')), 'no in-page back in Telegram 7.7');
    } finally {
      close(telegram);
    }
  });

  await check('S10 the messages: every key the screen reads exists in en, he and ru, and no key of the settings namespace is left unread (googleDisconnect is its own section\'s)', () => {
    const dir = path.join(ROOT, 'app/[locale]/(app)/settings');
    // The Google section reads its own namespace (settings.googleDisconnect), which its own smoke holds.
    const source = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && f !== 'GoogleDisconnect.tsx').map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const keysOf = (node: Row, prefix = ''): string[] => Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keysOf(v as Row, `${prefix}${k}.`) : [`${prefix}${k}`]));
    const own = keysOf(messages.en.settings as Row).filter((k) => !k.startsWith('googleDisconnect.'));
    for (const locale of LOCALES) assert(show(keysOf(messages[locale].settings as Row).sort()) === show(keysOf(messages.en.settings as Row).sort()), `${locale}: a different set of keys than en`);
    const unread = own.filter((key) => !source.includes(`'${key}'`) && !source.includes(`'${key.split('.').at(-1)}'`) && !source.includes(`\`${key.split('.').slice(0, -1).join('.')}.`));
    assert(unread.length === 0, `keys nothing reads: ${show(unread)}`);
    const read = [...source.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]);
    for (const key of read) assert(own.includes(key) || key.startsWith('googleDisconnect.'), `${key} is read but is not a message`);
    for (const key of ['back', 'save', 'saved', 'done']) for (const locale of LOCALES) assert(typeof (messages[locale].ui as Row)[key] === 'string', `${locale}: ui.${key}`);
  });

  await check('S9 React logged no warning', () => {
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
