// Smoke test for the Select calendars screen in the app's design (plan docs/superpowers/plans/2026-10-29-w4-2-select-calendars.md;
// spec 2026-10-19-screens-and-colours §4, §5; google-connection spec §3): SelectCalendarsClient on AppScreen and the form kit,
// in real React on the small fake DOM, with a fake Telegram.WebApp, a router stub and a fake fetch. No network, no DB.
//
//  - W1 the screen's words in en, he and ru (the same keys, ICU plurals for the notes and the limit);
//  - S1 the screen's source is made of the kit (no styled-jsx, no Tailwind, no purple, no inline copy, initData only in the header);
//  - S2..S19 the screen itself (light and dark, en / he (RTL) / ru): one compact list (menu revamp 2026-11-24 §4: a shown
//    calendar's row is a text button that opens its sheet beside a sibling switch, a hidden one's whole row is its switch), the
//    notes and the empty state; a switch saves the whole selection at once (the exact body, the credential in the header, the
//    colour from Google); a refused save rolls the switch back and says so; the limit sentence (plurals) and See plans; one
//    request at a time; the primary rules; the "new events will go to" note once; the calendar's sheet and the notes sheet;
//    Back (to Calendars); a browser; no word of the old copy.
//  - S30, S31 the Google account section (Reconnect Google, a full page load of /refresh-token; Disconnect Google, moved here
//    from Settings, whose result goes to Calendars) and the dead-token card (the googleReconnect notice) with Disconnect under it.
//  - R1 the route reads the credential from the header (and, as every route, from the body).
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-select-calendars-screen.ts

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { byRole, elements, fakeTelegram, fakeWindow, FakeElement, FakeText, installWindow, mount, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

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
/** JSON with the keys in order, so two bodies are equal whatever order their keys were written in. */
const canon = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

// ---- React must not warn; what the screen itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[select-calendars]')) return void appLogs.push(text);
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The browser side: a router, a fetch, window.confirm that throws, and Telegram ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
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
}
const calls: Call[] = [];
type Reply = Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const srv = { save: (_c: Call): Reply => json({ success: true }), disconnect: (_c: Call): Reply => json({ status: 'disconnected', leftover: [] }) };
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = new URL(String(input), 'https://famcal.test');
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Row) : null;
  const call: Call = { method, path: url.pathname, query: url.searchParams, headers: Object.fromEntries(new Headers(init.headers).entries()), body };
  calls.push(call);
  if (url.pathname === '/api/select-calendars' && method === 'POST') return srv.save(call);
  // Disconnect Google, in the Google account section (S30, S31)
  if (url.pathname === '/api/google-disconnect' && method === 'POST') return srv.disconnect(call);
  // Sign in again (6c-1): this browser signs out first
  if (url.pathname === '/api/auth/signout' && method === 'POST') return json({ ok: true });
  throw new Error(`an unexpected request: ${method} ${url.pathname}`);
}) as typeof fetch;
const saves = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/select-calendars');
function resetWorld() {
  calls.length = 0;
  pushes.length = 0;
  appLogs.length = 0;
  confirmCalls = 0;
  srv.save = () => json({ success: true });
  srv.disconnect = () => json({ status: 'disconnected', leftover: [] });
  assigned.length = 0;
}

// ---- Fixtures: four Google calendars, two of them chosen ----

const ME = 'me@gmail.com';
const FAMILY = 'family@group.calendar.google.com';
const KIDS = 'kids@group.calendar.google.com';
const NOA = 'noa@gmail.com';
const NAMES: Record<Locale, { me: string; family: string; kids: string; noa: string; familyDesc: string }> = {
  en: { me: 'Dana', family: 'Family', kids: 'Kids and school', noa: 'Noa', familyDesc: 'Shared with the whole family' },
  he: { me: 'דנה', family: 'משפחה', kids: 'ילדים ובית ספר', noa: 'נועה', familyDesc: 'משותף לכל המשפחה' },
  ru: { me: 'Дана', family: 'Семья', kids: 'Дети и школа', noa: 'Ноа', familyDesc: 'Общий для всей семьи' },
};
const availableFor = (l: Locale): Row[] => [
  { id: ME, name: NAMES[l].me, backgroundColor: '#039BE5', primary: true, accessRole: 'owner' },
  { id: FAMILY, name: NAMES[l].family, description: NAMES[l].familyDesc, backgroundColor: '#7986CB', accessRole: 'owner' },
  { id: KIDS, name: NAMES[l].kids, backgroundColor: '#F4511E', accessRole: 'owner' },
  { id: NOA, name: NAMES[l].noa, backgroundColor: '#0B8043', accessRole: 'reader' },
];
const selectionOf = (o: Row = {}): Row => ({
  selectedCalendars: new Set([ME, KIDS]),
  calendarLabels: new Map([[ME, new Set(['yours'])], [KIDS, new Set(['kids'])]]),
  spouseInfo: null,
  calendarRules: new Map([[KIDS, 'Early dismissal']]),
  globalRules: ['Be brief'],
  ...o,
});

/** A chosen calendar Google no longer lists (deleted, unshared or removed from the list), as the page data hands it over: its saved name and colour. */
const GONE = 'old@group.calendar.google.com';
const GONE_NAMES: Record<Locale, string> = { en: 'Last school year', he: 'שנת הלימודים הקודמת', ru: 'Прошлый учебный год' };
const GONE_COLOUR = '#8E24AA';
const unlistedFor = (l: Locale): Row => ({ id: GONE, name: GONE_NAMES[l], backgroundColor: GONE_COLOUR });

// ---- Mounting the screen ----

type Props = Row;
/** The full page loads the screen asked for (window.location.assign): Reconnect Google's /refresh-token. */
const assigned: string[] = [];
let Screen: (props: Props) => ReactElement;
const propsOf = (locale: Locale, o: Props = {}): Props => ({
  userId: 5550001, availableCalendars: availableFor(locale), currentSelections: selectionOf(), locale, famcalPrimaryName: null, ...o,
});
function tree(locale: Locale, props: Props): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Screen, props));
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
  fakeWindow.location = { hash: '', assign: (href: string) => void assigned.push(href), reload: () => undefined };
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
const word = (locale: Locale, key: string, args: Row = {}, ns = 'selectCalendars'): string =>
  Object.entries(args).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), messageAt(locale, `${ns}.${key}`));
const BIDI = /[⁦-⁩]/g;
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
const classes = (e: FakeElement) => e.className.split(' ');
const buttonsOf = (node: FakeNode) => elements(node).filter((e) => e.localName === 'button');
const dialogs = (m: Mounted) => byRole(m.container, 'dialog');
const sheetOf = (m: Mounted) => dialogs(m)[0] as FakeElement | undefined;
const sectionLabels = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'h2' && classes(e).includes('ch-section-label')).map(flat);
const switchesOf = (node: FakeNode) => byRole(node, 'switch');
/** The page's own switches (the calendars), not the sheet's. */
const pageSwitches = (m: Mounted) => switchesOf(m.container).filter((s) => !isInside(s, sheetOf(m)));
/**
 * A calendar switch's name: what its aria-labelledby points to (a shown calendar's switch holds only the track, and is named by
 * the name in its sibling text button; a hidden calendar's switch is the whole row and names itself the same way).
 */
const switchName = (m: Mounted, s: FakeElement) => {
  const by = s.getAttribute('aria-labelledby');
  const named = by ? elements(m.container).find((e) => e.getAttribute('id') === by) : undefined;
  return named ? flat(named) : flat(s);
};
const switchOf = (m: Mounted, name: string) => {
  const s = pageSwitches(m).find((x) => switchName(m, x).startsWith(name));
  assert(s, `no switch for ${name} in ${show(pageSwitches(m).map((x) => switchName(m, x)))}`);
  return s;
};
/** The row a calendar switch sits in (.ch-cal-row): the text button and the switch of a shown calendar, the switch alone of a hidden one. */
const calendarRowOf = (s: FakeElement) => {
  const row = s.parentNode as FakeElement;
  assert(row instanceof FakeElement && classes(row).includes('ch-cal-row'), `the switch is not in a .ch-cal-row: ${row instanceof FakeElement ? row.className : show(row)}`);
  return row;
};
const isOn = (s: FakeElement) => s.getAttribute('aria-checked') === 'true';
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
const tagsOf = (row: FakeNode) => elements(row).filter((e) => classes(e).includes('ch-tag')).map((e) => ({ text: flat(e), tone: classes(e).includes('ch-tag-muted') ? 'muted' : 'accent' }));
const buttonNamed = (node: FakeNode, text: string) => buttonsOf(node).find((b) => flat(b) === text);
const mustButton = (node: FakeNode, text: string) => {
  const b = buttonNamed(node, text);
  assert(b, `no button ${show(text)} in ${show(buttonsOf(node).map(flat))}`);
  return b;
};
const notices = (m: Mounted) => elements(m.container).filter((e) => classes(e).includes('ch-notice') && !isInside(e, sheetOf(m)));
const statusText = (m: Mounted) => notices(m).map(flat);
const alertsOf = (m: Mounted) => byRole(m.container, 'alert').map(flat);
const groupIn = (node: FakeNode, label: string) => {
  const g = byRole(node, 'radiogroup').find((e) => e.getAttribute('aria-label') === label);
  assert(g, `no radio group ${show(label)}`);
  return g;
};
const radiosOf = (group: FakeNode) => byRole(group, 'radio');
const checkedOf = (group: FakeNode) => radiosOf(group).filter((r) => r.getAttribute('aria-checked') === 'true');
const radioNamed = (group: FakeNode, text: string) => {
  const r = radiosOf(group).find((x) => flat(x) === text || flat(x).startsWith(`${text} `));
  assert(r, `no radio ${show(text)} in ${show(radiosOf(group).map(flat))}`);
  return r;
};
const fieldByLabel = (node: FakeNode, label: string) => {
  const f = elements(node).find((e) => (e.localName === 'input' || e.localName === 'textarea') && e.getAttribute('aria-label') === label);
  assert(f, `no field ${show(label)}`);
  return f;
};
/** What a field holds (the fake DOM keeps a textarea's first value in defaultValue, where the platform turns it into text). */
const valueOf = (f: FakeElement) => (f.localName === 'textarea' ? f.value || String((f as unknown as Row).defaultValue ?? '') : f.value);
/** The visible label over a field's card: the muted line right before the card the field sits in (the kit's .ch-form-group-label). */
const labelAbove = (field: FakeElement) => {
  let card: FakeNode | null = field;
  while (card && !(card instanceof FakeElement && classes(card).includes('ch-form-card'))) card = card.parentNode;
  const siblings = card?.parentNode?.childNodes ?? [];
  const before = siblings[siblings.indexOf(card as FakeNode) - 1];
  return before instanceof FakeElement && classes(before).includes('ch-form-group-label') ? flat(before) : null;
};
const saveButton = (m: Mounted) => buttonsOf(sheetOf(m) as FakeNode).find((b) => classes(b).includes('ch-save') && !classes(b).includes('ch-btn-danger')) as FakeElement;
const cancelButton = (m: Mounted) => buttonsOf(sheetOf(m) as FakeNode).find((b) => classes(b).includes('ch-sheet-close')) as FakeElement;
const ui = (locale: Locale, key: string) => messageAt(locale, `ui.${key}`);
/** Disconnect Google's words: its section moved here from Settings with its i18n (settings.googleDisconnect). */
const gdw = (locale: Locale, key: string) => messageAt(locale, `settings.googleDisconnect.${key}`);
/** The section labels after the calendars: the Google account, then Disconnect Google's own. */
const accountLabels = (locale: Locale) => [word(locale, 'account.title'), gdw(locale, 'sectionTitle')];
const cat = (locale: Locale, key: string) => messageAt(locale, `calendars.categories.${key}`);
const hint = (locale: Locale, key: string) => messageAt(locale, `calendarsPage.categoryHint.${key}`);
const calendarsPageText = (locale: Locale, key: string) => messageAt(locale, `calendarsPage.${key}`);
const holdNext = () => {
  let release: (r: Response) => void = () => undefined;
  srv.save = () => new Promise<Response>((resolve) => void (release = resolve));
  return (r: Response) => act(async () => { release(r); await new Promise((res) => setTimeout(res, 0)); });
};
const TELEGRAM = { version: '7.7' };
const bodyOf = (i = -1) => {
  const call = saves().at(i);
  assert(call && call.body, 'no save was sent');
  return call.body as { calendarAssignments: Row[]; globalRules: string[]; initData?: unknown };
};
/** Opens a chosen calendar's sheet by its row. */
const openRow = async (o: Opened, name: string) => {
  o.m.click(rowOf(o.m, name));
  await settle();
  assert(sheetOf(o.m), `no sheet after tapping ${name}`);
};
const notesRow = (m: Mounted) => buttonsOf(m.container).find((b) => b.getAttribute('aria-haspopup') === 'dialog' && !isInside(b, sheetOf(m))) as FakeElement;
const tapAndSettle = async (o: Opened, el: FakeNode) => {
  o.m.click(el);
  await settle();
};

async function main() {
  Screen = (await import('../app/[locale]/(app)/select-calendars/SelectCalendarsClient')).default as unknown as (props: Props) => ReactElement;
  const noComments = (code: string) => code.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
  const source = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const SCREEN_FILE = 'app/[locale]/(app)/select-calendars/SelectCalendarsClient.tsx';

  await check('W1 the screen\'s words: selectCalendars has the same keys in en, he and ru; the limit and notes plurals use each language\'s forms (ru few / many, he two); {name}, {number}, {limit} and {count} are kept; he and ru are their own text with no Latin letter but the product names; no emoji; the categories and the noGoogle notice are still there', () => {
    const leaves = (node: unknown, prefix = ''): [string, string][] =>
      typeof node === 'string' ? [[prefix, node]] : node && typeof node === 'object' ? Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k)) : [];
    const block = (l: Locale) => new Map(leaves(messages[l].selectCalendars));
    const keys = (l: Locale) => [...block(l).keys()].sort();
    for (const l of ['he', 'ru'] as Locale[]) assert(show(keys(l)) === show(keys('en')), `${l}: the keys differ from en`);
    for (const need of ['title', 'intro', 'show', 'account.title', 'account.reconnect', 'account.reconnectHint', 'reconnectCard.title', 'reconnectCard.body', 'category', 'noCategory', 'mainIsYours', 'note', 'notePlaceholder', 'noteHint', 'spouse', 'spouseHint', 'spouseName', 'spouseNamePlaceholder', 'spouseEnglishName', 'spouseGender', 'male', 'female', 'notes', 'notesHint', 'notesPlaceholder', 'notesCount', 'newEventsGoTo', 'errors.save', 'errors.limit', 'errors.noneSelected', 'errors.noYours', 'errors.retry', 'mainHowToChange', 'empty.title', 'empty.body']) assert(block('en').has(need), `en: no ${need}`);
    for (const l of LOCALES) assert(!block(l).has('noNote'), `${l}: the unread key noNote is still there`);
    // The "Chosen calendars" section is gone (menu revamp §4): its title and hint with it
    for (const l of LOCALES) for (const gone of ['chosen', 'chosenHint']) assert(!block(l).has(gone), `${l}: selectCalendars.${gone} is still there`);
    assert(messages.en.selectCalendars.errors.retry === "Couldn't save. Try again." && messages.he.selectCalendars.errors.retry === 'לא הצלחנו לשמור. נסו שוב.' && messages.ru.selectCalendars.errors.retry === 'Не удалось сохранить. Попробуйте ещё раз.', 'the retry sentence');
    assert(messages.en.selectCalendars.mainHowToChange === 'To change the main calendar, turn it on for another one.' && messages.he.selectCalendars.mainHowToChange === 'כדי להחליף את היומן הראשי, מפעילים אותו ביומן אחר.' && messages.ru.selectCalendars.mainHowToChange === 'Чтобы сменить основной календарь, включите этот переключатель у другого календаря.', 'how to change the main calendar');
    assert(messages.en.selectCalendars.errors.noneSelected === 'Keep at least one calendar on. To stop using Google, disconnect it under Google account.' && messages.en.selectCalendars.errors.noYours === 'Keep at least one calendar marked as yours.', 'the English refusals');
    for (const l of LOCALES) {
      for (const [key, text] of block(l)) {
        const english = block('en').get(key) as string;
        for (const arg of ['name', 'number', 'limit', 'count']) assert(english.includes(`{${arg}`) === text.includes(`{${arg}`), `${l} ${key}: {${arg}} differs from en`);
        assert(!/\p{Extended_Pictographic}/u.test(text), `${l} ${key}: an emoji`);
        if (l !== 'en') {
          assert(text !== english, `${l} ${key}: the English text`);
          assert(!/[A-Za-z]/.test(text.replace(/\{[^}]*\}/g, '').replace(/\b(?:plural|one|two|few|many|other)\b/g, '').replace(/Google Calendar|Google|FamCal/g, '')), `${l} ${key}: Latin letters in ${text}`);
        }
      }
    }
    assert(/few \{# календарей\}/.test(messages.ru.selectCalendars.errors.limit) && /many \{# календарей\}/.test(messages.ru.selectCalendars.errors.limit), 'the Russian limit has few and many forms');
    assert(/two \{/.test(messages.he.selectCalendars.notesCount), 'the Hebrew notes count has the dual');
    for (const l of LOCALES) {
      for (const k of ['primary', 'yours', 'spouse', 'kids', 'birthdays']) assert(typeof messages[l].calendars.categories[k] === 'string', `${l}: calendars.categories.${k}`);
      assert(typeof messages[l].calendars.noGoogle.title === 'string' && typeof messages[l].calendars.noGoogle.body === 'string', `${l}: calendars.noGoogle`);
      // What this screen replaced is gone: the old strings, their dead siblings, and the old header's
      const leftovers = Object.keys(messages[l].calendars).filter((k) => !['categories', 'noGoogle'].includes(k));
      assert(leftovers.length === 0, `${l}: calendars.${leftovers.join(', calendars.')} is still there`);
      assert(Object.keys(messages[l].calendars.categories).sort().join() === 'birthdays,kids,primary,spouse,yours', `${l}: calendars.categories ${Object.keys(messages[l].calendars.categories)}`);
      assert(!('header' in messages[l].common), `${l}: common.header is still there`);
    }
  });

  await check('W3 the Google account section and the dead-token card in the plan\'s words (menu revamp, Task 3), in en, he and ru', () => {
    const want: Record<Locale, Record<string, string>> = {
      en: {
        'account.title': 'Google account',
        'account.reconnect': 'Reconnect Google',
        'account.reconnectHint': 'If your Google events stop showing up, connect again.',
        'reconnectCard.title': 'The connection to Google stopped working',
        'reconnectCard.body': 'Google no longer gives FamCal access to this account. Connect again to keep seeing your calendars.',
      },
      he: {
        'account.title': 'חשבון Google',
        'account.reconnect': 'חיבור מחדש ל־Google',
        'account.reconnectHint': 'אם האירועים מ־Google הפסיקו להופיע, אפשר להתחבר מחדש.',
        'reconnectCard.title': 'החיבור ל־Google הפסיק לעבוד',
        'reconnectCard.body': 'Google כבר לא מאפשר ל־FamCal גישה לחשבון הזה. כדי להמשיך לראות את היומנים, צריך להתחבר מחדש.',
      },
      ru: {
        'account.title': 'Аккаунт Google',
        'account.reconnect': 'Переподключить Google',
        'account.reconnectHint': 'Если события из Google перестали появляться, подключите его заново.',
        'reconnectCard.title': 'Подключение к Google перестало работать',
        'reconnectCard.body': 'Google больше не даёт FamCal доступ к этому аккаунту. Чтобы календари снова отображались, подключите его заново.',
      },
    };
    for (const l of LOCALES) for (const [key, text] of Object.entries(want[l])) assert(messageAt(l, `selectCalendars.${key}`) === text, `${l} selectCalendars.${key}: ${messageAt(l, `selectCalendars.${key}`)}`);
  });

  await check('W2 the reviewed wording: the Hebrew spouse hint names the spouse (not "them"), the Hebrew empty state says "in the Google account" with no English product line, the Russian note copy is native (lessons end earlier, not "ранний уход"), the Hebrew limit has its singular and dual', () => {
    assert(messages.he.selectCalendars.spouseHint === 'משמשים לכל יומני בן או בת הזוג, כדי שהסיכומים יזכירו את בן או בת הזוג בשם.', messages.he.selectCalendars.spouseHint);
    assert(messages.he.selectCalendars.empty.body === 'אפשר להוסיף יומן בחשבון Google ולפתוח את הדף הזה שוב.', messages.he.selectCalendars.empty.body);
    assert(messages.ru.selectCalendars.notePlaceholder === 'Например: по пятницам уроки заканчиваются раньше' && messages.ru.selectCalendars.notesHint === 'До трёх заметок, которые ИИ учитывает в каждой сводке, например: в какие дни уроки заканчиваются раньше.', `${messages.ru.selectCalendars.notePlaceholder} / ${messages.ru.selectCalendars.notesHint}`);
    assert(messages.he.selectCalendars.errors.limit === 'בתוכנית שלכם יש מקום {limit, plural, one {ליומן אחד} two {לשני יומנים} other {ל־# יומנים}}, של FamCal ושל Google יחד.', messages.he.selectCalendars.errors.limit);
    for (const l of LOCALES) assert(!/ранний уход|early dismissal/i.test(messages[l].selectCalendars.notePlaceholder + messages[l].selectCalendars.notesHint) || l === 'en', `${l}: the calque is back`);
  });

  await check('S1 the screen is made of the kit: no styled-jsx, Tailwind class, hex colour, emoji, :hover, window.confirm or direct useTelegramBackButton; no old Layout/Forms import, no inline Hebrew or Russian; initData only through initDataHeaders (never window.Telegram or the body); the grouped AppScreen owns Back; the form kit\'s style sheet and the screen\'s own row rules (CALENDAR_ROW_CSS, after it and clean under the kit\'s lint) are the only ones; no "Chosen calendars" key is read', async () => {
    const raw = source(SCREEN_FILE);
    const code = noComments(raw);
    assert(!/<style jsx|styled-jsx/.test(code), 'styled-jsx');
    assert(!/(?:^|[\s"'`])(?:bg-(?:white|gray|blue|rose|indigo)|text-(?:gray|rose|blue|indigo|white|xs|sm|lg|xl|2xl|3xl)\b|rounded(?:-[a-z0-9]+)?\b|px-\d|py-\d|min-h-|min-w-|flex-1|shadow\b|mt-\d|mb-\d|p-\d|gap-\d|max-w|space-[xy]-|animate-|border-(?:gray|rose|blue|t|b)\b|hover:)/.test(code.replace(/aria-[a-z]+="[^"]*"/g, '')), 'a Tailwind class');
    assert(!/#[0-9a-fA-F]{3,8}\b/.test(code.replace(/'#4285f4'/g, '')), `a hex colour: ${code.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]}`);
    assert(!/\p{Extended_Pictographic}/u.test(raw), 'an emoji');
    assert(!/:hover/.test(code), 'a :hover style');
    assert(!/(?<![\w.])(?:window\.)?confirm\(/.test(code), 'confirm()');
    assert(!/useTelegramBackButton\(/.test(code), 'useTelegramBackButton');
    assert(!/[א-ת]|[а-яА-Я]/.test(raw.replace(/\/\/.*$/gm, '')), 'inline Hebrew or Russian');
    assert(!/components\/Layout|components\/Forms|TelegramLayout|CategoryIcon/.test(code), 'an import of the old layout or the category icons');
    assert(!/window\.Telegram|\binitData\b\s*[,}]|initData:/.test(code.replace(/initDataHeaders|readInitData/g, '')), 'initData is read in the screen or put in the body');
    assert(/initDataHeaders\(\)/.test(code), 'the credential does not go through initDataHeaders()');
    assert(!/\bcalendarLimit\b|\buserName\b/.test(code), 'the screen takes a prop it does not use (calendarLimit, userName)');
    assert(/import \{ isolate \} from '@\/src\/lib\/isolate';/.test(code) && !/GoogleCopyRow/.test(code), 'isolate does not come from src/lib/isolate (a component module is no home for a helper)');
    const styles = code.match(/<style[^>]*>/g) ?? [];
    assert(styles.length === 2 && /<style>\{FORM_CSS\}<\/style>\s*<style>\{CALENDAR_ROW_CSS\}<\/style>/.test(code), 'a style sheet but the form kit\'s, then the row rules');
    const { CALENDAR_ROW_CSS } = (await import('../app/[locale]/(app)/select-calendars/SelectCalendarsClient')) as unknown as { CALENDAR_ROW_CSS?: string };
    const { lintCss } = await import('./lib/css-lint');
    assert(typeof CALENDAR_ROW_CSS === 'string' && lintCss(CALENDAR_ROW_CSS).length === 0, `CALENDAR_ROW_CSS lint: ${show(typeof CALENDAR_ROW_CSS === 'string' ? lintCss(CALENDAR_ROW_CSS) : 'missing')}`);
    assert(!/t\('chosen(?:Hint)?'\)/.test(code), 'the screen reads chosen or chosenHint');
    assert(/<AppScreen ground="grouped" onBack=\{back\}>/.test(code) && /<ScreenHeader title=\{t\('title'\)\} backLabel=\{ui\('back'\)\} onBack=\{back\} \/>/.test(code), 'the grouped AppScreen and the header with the same back');
    for (const gone of ['components/Layout/TelegramLayout.tsx', 'components/Layout/Header.tsx', 'components/Layout/index.ts', 'components/Forms/CategoryIcon.tsx']) assert(!fs.existsSync(path.join(ROOT, gone)), `${gone} is still there`);
  });

  await check('S2 the screen in en, he (RTL) and ru, light and dark: the grouped root, the title, the intro, "Show in FamCal" with one row per Google calendar: a shown one is two sibling buttons (a text button with the dot, the name in a <bdi>, its role or "No role" and the Main tag in the accent, then a switch that holds only the track, named by that name), a hidden one is one switch with the dot and the name and no description; no "Chosen calendars" section; "Notes for all calendars" with the count; then the Google account section (Reconnect Google described by its hint) and Disconnect Google; no raw key, no emoji, no Latin letter in he and ru', async () => {
    for (const locale of LOCALES) {
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const n = NAMES[locale];
      const selection = selectionOf({
        selectedCalendars: new Set([ME, KIDS]),
        calendarLabels: new Map([[ME, new Set(['primary', 'yours'])], [KIDS, new Set(['kids'])]]),
      });
      const props = propsOf(locale, { currentSelections: selection });
      const html = renderToString(tree(locale, props));
      assert(html.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the server's root: ${html.slice(0, 140)}`);
      assert(html.includes(`<h1 class="ch-screen-title">${word(locale, 'title')}</h1>`), `${locale}: the title`);
      for (const scheme of ['dark', 'light'] as const) {
        const o = await open(locale, props, { ...TELEGRAM, scheme });
        try {
          const root = elements(o.m.container).find((e) => e.className === 'ch-app ch-screen ch-grouped');
          assert(root && root.getAttribute('data-theme') === scheme && root.getAttribute('dir') === dir && root.getAttribute('lang') === locale, `${locale} ${scheme}: the root`);
          assert(flat(elements(o.m.container).find((e) => e.localName === 'h1') as FakeNode) === word(locale, 'title'), `${locale} ${scheme}: the h1`);
          assert(page(o.m).includes(word(locale, 'intro')) && elements(o.m.container).some((e) => e.localName === 'p' && classes(e).includes('ch-form-fixed') && flat(e) === word(locale, 'intro')), `${locale} ${scheme}: the intro`);
          assert(show(sectionLabels(o.m)) === show([word(locale, 'show'), word(locale, 'notes'), ...accountLabels(locale)]), `${locale} ${scheme}: sections ${show(sectionLabels(o.m))}`);
          // The switches: one per calendar, in Google's order, each in its own row
          const switches = pageSwitches(o.m);
          assert(switches.length === 4 && show(switches.map(isOn)) === show([true, false, true, false]), `${locale} ${scheme}: switches ${show(switches.map((s) => [switchName(o.m, s), isOn(s)]))}`);
          assert(switches.every((s, i) => switchName(o.m, s).startsWith([n.me, n.family, n.kids, n.noa][i])), `${locale} ${scheme}: names ${show(switches.map((s) => switchName(o.m, s)))}`);
          const rowsOf = switches.map(calendarRowOf);
          assert(show(rowsOf.map((r) => dotColour(r))) === show(['#039BE5', '#7986CB', '#F4511E', '#0B8043']), `${locale} ${scheme}: dots ${show(rowsOf.map((r) => dotColour(r)))}`);
          assert(rowsOf.every((r) => elements(r).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto') && elements(r).some((e) => classes(e).includes('ch-switch'))), `${locale} ${scheme}: a row without its <bdi> name or its track`);
          assert(switches.every((s) => !s.hasAttribute('disabled') && !s.hasAttribute('aria-busy')), `${locale} ${scheme}: a switch is off at rest`);
          // A shown calendar: a text button and its switch, siblings in the row, neither inside the other
          for (const i of [0, 2]) {
            const row = rowsOf[i];
            const own = row.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
            assert(own.length === 2 && own[0].localName === 'button' && own[1] === switches[i] && classes(own[0]).includes('ch-list-row'), `${locale} ${scheme}: row ${i} is ${show(own.map((e) => `${e.localName}.${e.className}`))}`);
            assert(buttonsOf(own[0]).length === 0 && buttonsOf(switches[i]).length === 0, `${locale} ${scheme}: a button inside a button in row ${i}`);
            assert(flat(switches[i]) === '' && elements(switches[i]).some((e) => classes(e).includes('ch-switch') && classes(e).includes('is-on')), `${locale} ${scheme}: the shown switch holds ${show(flat(switches[i]))}`);
            assert(own[0].getAttribute('role') === null && !own[0].hasAttribute('aria-haspopup'), `${locale} ${scheme}: the text button reads as a switch or a dialog opener`);
          }
          // A hidden calendar: the whole row is its switch (the dot and the name), no description and no details
          for (const i of [1, 3]) {
            const own = rowsOf[i].childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
            assert(own.length === 1 && own[0] === switches[i] && classes(switches[i]).includes('ch-form-row'), `${locale} ${scheme}: hidden row ${i} is ${show(own.map((e) => `${e.localName}.${e.className}`))}`);
            assert(flat(switches[i]) === [n.me, n.family, n.kids, n.noa][i] && !elements(switches[i]).some((e) => classes(e).includes('ch-form-hint')) && !switches[i].hasAttribute('aria-describedby'), `${locale} ${scheme}: the hidden row holds ${show(flat(switches[i]))}`);
          }
          assert(!page(o.m).includes(n.familyDesc), `${locale} ${scheme}: Google's description is drawn`);
          // The text buttons: the role (or No role) and the Main tag
          const rows = listRows(o.m);
          assert(rows.length === 2 && flat(rows[0]).startsWith(n.me) && flat(rows[1]).startsWith(n.kids), `${locale} ${scheme}: rows ${show(rows.map(flat))}`);
          assert(flat(rows[0]).includes(cat(locale, 'yours')) && show(tagsOf(rows[0])) === show([{ text: cat(locale, 'primary'), tone: 'accent' }]), `${locale} ${scheme}: ${n.me}'s row ${flat(rows[0])} ${show(tagsOf(rows[0]))}`);
          assert(flat(rows[1]).includes(cat(locale, 'kids')) && tagsOf(rows[1]).length === 0, `${locale} ${scheme}: ${n.kids}'s row ${flat(rows[1])}`);
          assert(rows.every((r) => elements(r).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto') && elements(r).some((e) => classes(e).includes('ch-form-hint'))), `${locale} ${scheme}: a text button without its <bdi> name or its role line`);
          // The Google account section, last: Reconnect Google (an accent row described by its hint), then Disconnect Google
          const reconnect = mustButton(o.m.container, word(locale, 'account.reconnect'));
          assert(classes(reconnect).includes('ch-action-row') && classes(reconnect).includes('ch-form-row'), `${locale} ${scheme}: Reconnect is ${reconnect.className}`);
          const hintOf = elements(o.m.container).find((e) => e.getAttribute('id') === reconnect.getAttribute('aria-describedby'));
          assert(hintOf && hintOf.localName === 'p' && flat(hintOf) === word(locale, 'account.reconnectHint'), `${locale} ${scheme}: Reconnect's hint ${hintOf && flat(hintOf)}`);
          const disconnect = mustButton(o.m.container, gdw(locale, 'button'));
          assert(classes(disconnect).includes('ch-danger-row') && page(o.m).includes(gdw(locale, 'sectionHint')), `${locale} ${scheme}: Disconnect Google`);
          const order = buttonsOf(o.m.container);
          assert(order.indexOf(notesRow(o.m)) < order.indexOf(reconnect) && order.indexOf(reconnect) < order.indexOf(disconnect) && order.at(-1) === disconnect, `${locale} ${scheme}: the Google account section is not last`);
          // The notes row
          const notesCount = { en: '1 note', he: 'הערה אחת', ru: '1 заметка' }[locale];
          assert(flat(notesRow(o.m)) === `${word(locale, 'notes')} ${notesCount}`, `${locale} ${scheme}: the notes row ${flat(notesRow(o.m))}`);
          assert(elements(o.m.container).some((e) => e.localName === 'p' && classes(e).includes('ch-form-fixed') && flat(e) === word(locale, 'notesHint')), `${locale} ${scheme}: the notes hint`);
          // No status before any save, nothing stray
          assert(statusText(o.m).length === 0 && alertsOf(o.m).length === 0, `${locale} ${scheme}: a notice at rest`);
          const text = page(o.m);
          assert(!/\b(?:selectCalendars|calendarsPage|calendars\.categories|ui)\.[a-zA-Z]/.test(text), `${locale} ${scheme}: a raw key in ${text}`);
          assert(!/\p{Extended_Pictographic}/u.test(text), `${locale} ${scheme}: an emoji`);
          if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(/Google|FamCal/g, '')), `${locale} ${scheme}: Latin letters in ${text}`);
        } finally {
          close(o);
        }
      }
    }
  });
  await check('S3 nothing chosen: no "Chosen calendars" section and the notes count says None in each language (0 / 1 / 2 / 3 plurals: he dual, ru few); a Google account with no calendars shows the empty state in place of the sections; a chosen calendar Google no longer lists is neither a switch nor a Chosen row, and keeps its place, its labels, its saved name and its saved colour in the saved selection under an unrelated tap', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const none = await open(locale, { currentSelections: selectionOf({ selectedCalendars: new Set(), calendarLabels: new Map(), calendarRules: new Map(), globalRules: [] }) }, TELEGRAM);
      try {
        assert(show(sectionLabels(none.m)) === show([word(locale, 'show'), word(locale, 'notes'), ...accountLabels(locale)]) && listRows(none.m).length === 0, `${locale}: ${show(sectionLabels(none.m))}`);
        assert(flat(notesRow(none.m)) === `${word(locale, 'notes')} ${{ en: 'None', he: 'אין', ru: 'Нет' }[locale]}`, `${locale}: ${flat(notesRow(none.m))}`);
      } finally {
        close(none);
      }
    }
    // The notes count in each plural class, through the notes sheet
    const counts: [Locale, string[], string][] = [
      ['he', ['a', 'b'], 'שתי הערות'], ['he', ['a', 'b', 'c'], '3 הערות'],
      ['ru', ['a', 'b'], '2 заметки'], ['ru', ['a', 'b', 'c'], '3 заметки'], ['ru', ['a'], '1 заметка'],
      ['en', ['a', 'b'], '2 notes'],
    ];
    for (const [locale, rules, expected] of counts) {
      const o = await open(locale, { currentSelections: selectionOf({ globalRules: rules }) }, TELEGRAM);
      try {
        assert(flat(notesRow(o.m)).endsWith(expected), `${locale} ${rules.length}: ${flat(notesRow(o.m))}`);
      } finally {
        close(o);
      }
    }
    // An account with no calendars
    for (const locale of LOCALES) {
      resetWorld();
      const empty = await open(locale, { availableCalendars: [], currentSelections: selectionOf({ selectedCalendars: new Set(), calendarLabels: new Map(), calendarRules: new Map() }) }, TELEGRAM);
      try {
        const text = page(empty.m);
        assert(text.includes(word(locale, 'empty.title')) && text.includes(word(locale, 'empty.body')), `${locale}: the empty state in ${text}`);
        assert(elements(empty.m.container).some((e) => classes(e).includes('ch-home-card') && e.getAttribute('role') === 'status'), `${locale}: the state card`);
        // The Google account section stays: the token is there, so Reconnect and Disconnect still apply
        assert(show(sectionLabels(empty.m)) === show(accountLabels(locale)) && pageSwitches(empty.m).length === 0 && !notesRow(empty.m), `${locale}: sections with no calendars: ${show(sectionLabels(empty.m))}`);
        assert(flat(elements(empty.m.container).find((e) => e.localName === 'h1') as FakeNode) === word(locale, 'title'), `${locale}: the title stays`);
      } finally {
        close(empty);
      }
    }
    // A chosen calendar Google no longer lists: no switch and no Chosen row, still in the saved choices with what was saved for it
    resetWorld();
    const o = await open('en', {
      unlistedCalendars: [unlistedFor('en')],
      currentSelections: selectionOf({ selectedCalendars: new Set([ME, GONE, KIDS]), calendarLabels: new Map([[ME, new Set(['yours'])], [GONE, new Set(['kids'])], [KIDS, new Set(['kids'])]]) }),
    }, TELEGRAM);
    try {
      assert(listRows(o.m).length === 2 && pageSwitches(o.m).length === 4 && !pageSwitches(o.m).some((s) => switchName(o.m, s).startsWith(GONE_NAMES.en)) && !page(o.m).includes('old@group'), 'the calendar Google does not list is a switch or a Chosen row, or shows its id');
      await tapAndSettle(o, switchOf(o.m, 'Family'));
      const ids = bodyOf().calendarAssignments.map((a) => a.calendarId);
      assert(show(ids) === show([ME, GONE, KIDS, FAMILY]), `the saved choices after an unrelated tap: ${show(ids)}`);
      assert(canon(bodyOf().calendarAssignments[1]) === canon({ calendarId: GONE, labels: ['kids'], name: GONE_NAMES.en, color: GONE_COLOUR }), `its entry: ${show(bodyOf().calendarAssignments[1])}`);
    } finally {
      close(o);
    }
  });

  await check('S4 a switch saves the whole selection at once: POST /api/select-calendars?user_id=… with the exact body (every chosen calendar in the order it was chosen, its labels, name, Google\'s colour (#4285f4 when Google gives none), the spouse details on spouse calendars, the rule as rules: [rule]; globalRules without the empty ones), the credential in the X-Telegram-Init-Data header and nowhere in the body; the row reads on, and "Saved" shows', async () => {
    resetWorld();
    const available = availableFor('en');
    delete (available[1] as Row).backgroundColor;
    const o = await open('en', {
      availableCalendars: available,
      currentSelections: selectionOf({
        selectedCalendars: new Set([KIDS, ME]),
        calendarLabels: new Map([[ME, new Set(['yours'])], [KIDS, new Set(['spouse'])]]),
        spouseInfo: { personName: 'Noa', personEnglishName: 'Noa L', personGender: 'female' },
        globalRules: ['Be brief', '', 'Mind the buses'],
      }),
    }, TELEGRAM);
    try {
      await tapAndSettle(o, switchOf(o.m, 'Family'));
      assert(saves().length === 1, `${saves().length} saves`);
      const call = saves()[0];
      assert(call.query.get('user_id') === '5550001' && [...call.query.keys()].join() === 'user_id', `the query: ${call.query.toString()}`);
      assert(call.headers['x-telegram-init-data'] === (o.tg as Row).initData && call.headers['content-type'] === 'application/json', `the headers: ${show(call.headers)}`);
      assert(!('initData' in (call.body as Row)) && !JSON.stringify(call.body).includes('hash=abc'), 'the credential is in the body');
      const want = {
        calendarAssignments: [
          { calendarId: KIDS, labels: ['spouse'], name: 'Kids and school', color: '#F4511E', personName: 'Noa', personEnglishName: 'Noa L', personGender: 'female', rules: ['Early dismissal'] },
          { calendarId: ME, labels: ['yours'], name: 'Dana', color: '#039BE5' },
          { calendarId: FAMILY, labels: [], name: 'Family', color: '#4285f4' },
        ],
        globalRules: ['Be brief', 'Mind the buses'],
      };
      assert(canon(call.body) === canon(want), `the body:\n${canon(call.body)}\nwant\n${canon(want)}`);
      assert(isOn(switchOf(o.m, 'Family')) && listRows(o.m).length === 3, 'the row is on and Chosen lists it');
      assert(show(statusText(o.m)) === show([ui('en', 'saved')]) && elements(o.m.container).some((e) => classes(e).includes('ch-notice') && e.getAttribute('role') === 'status'), `the status: ${show(statusText(o.m))}`);
      // "Saved" goes by itself after a few seconds (S29); before that it is still there
      assert(show(statusText(o.m)) === show(['Saved']), 'Saved went at once');
    } finally {
      close(o);
    }
    // In a browser (a WhatsApp person) there is no header: the cookie is the credential and nothing else is sent
    resetWorld();
    const browser = await open('en', {});
    try {
      await tapAndSettle(browser, switchOf(browser.m, 'Family'));
      assert(saves().length === 1 && !('x-telegram-init-data' in saves()[0].headers) && !('initData' in (saves()[0].body as Row)), `a browser save: ${show(saves()[0]?.headers)}`);
    } finally {
      close(browser);
    }
  });

  await check('S5 turning a chosen calendar off drops its labels and its rule from the saved selection and the row from Chosen; turning the first calendar on gives it "yours" (the server refuses a selection with no calendar of yours, so a first tap would always be undone)', async () => {
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      await tapAndSettle(o, switchOf(o.m, 'Kids and school'));
      // The shown row's switch (beside its text button) sends the whole selection without it, exactly
      assert(canon(bodyOf()) === canon({ calendarAssignments: [{ calendarId: ME, labels: ['yours'], name: 'Dana', color: '#039BE5' }], globalRules: ['Be brief'] }), `after the off tap: ${canon(bodyOf())}`);
      assert(saves().length === 1 && !sheetOf(o.m), 'the switch opened the sheet, or saved twice');
      // Its row is now a hidden one: the whole row is the switch, with no text button and no role line
      const off = switchOf(o.m, 'Kids and school');
      assert(!isOn(off) && listRows(o.m).length === 1 && calendarRowOf(off).childNodes.length === 1 && flat(off) === 'Kids and school', 'the row stays on, or keeps its details');
      // On again: back with no labels and no rule (they were dropped)
      await tapAndSettle(o, switchOf(o.m, 'Kids and school'));
      const again = bodyOf().calendarAssignments.find((a) => a.calendarId === KIDS) as Row;
      assert(show(again.labels) === show([]) && !('rules' in again), `back on: ${show(again)}`);
    } finally {
      close(o);
    }
    resetWorld();
    const first = await open('en', { currentSelections: selectionOf({ selectedCalendars: new Set(), calendarLabels: new Map(), calendarRules: new Map(), globalRules: [] }) }, TELEGRAM);
    try {
      await tapAndSettle(first, switchOf(first.m, 'Kids and school'));
      assert(canon(bodyOf()) === canon({ calendarAssignments: [{ calendarId: KIDS, labels: ['yours'], name: 'Kids and school', color: '#F4511E' }], globalRules: [] }), `the first calendar: ${canon(bodyOf())}`);
      assert(flat(rowOf(first.m, 'Kids and school')).includes(cat('en', 'yours')), 'its row says Yours');
      // The next one needs none: there is a calendar of yours already
      await tapAndSettle(first, switchOf(first.m, 'Family'));
      assert(show(bodyOf().calendarAssignments.find((a) => a.calendarId === FAMILY)?.labels) === show([]), 'a second calendar was given a label');
    } finally {
      close(first);
    }
  });

  await check('S6 a refused save is undone and said: the switch goes back, Chosen and the saved state are as before, "Couldn\'t save, so the change was undone." shows as an alert and is logged; a 429 says too many changes, a 401 or 403 says to reopen the page, a 500, a 502 that is not JSON and no network (the server may have written the change) only say to try again, while the switch still goes back; any other refusal says "so the change was undone"; after the refusal the next tap saves the whole selection as it was plus the new change', async () => {
    const cases: [string, () => Reply, (l: Locale) => string][] = [
      ['500', () => json({ error: 'Failed to update calendars' }, 500), (l) => word(l, 'errors.retry')],
      ['400 with no code', () => json({ error: 'At least one calendar must be marked as "yours"' }, 400), (l) => word(l, 'errors.save')],
      ['400 none_selected', () => json({ error: 'At least one calendar must be selected', code: 'none_selected' }, 400), (l) => word(l, 'errors.noneSelected')],
      ['400 no_yours', () => json({ error: 'At least one calendar must be marked as "yours"', code: 'no_yours' }, 400), (l) => word(l, 'errors.noYours')],
      ['400 another code', () => json({ error: 'Only one calendar can be primary', code: 'multiple_primary' }, 400), (l) => word(l, 'errors.save')],
      ['429', () => json({ error: 'Too many requests. Please wait a minute.' }, 429), (l) => calendarsPageText(l, 'errors.tooMany')],
      ['401', () => json({ error: 'Unauthorized' }, 401), (l) => calendarsPageText(l, 'errors.reopen')],
      ['403 suspended', () => json({ error: 'Account suspended' }, 403), (l) => calendarsPageText(l, 'errors.reopen')],
      ['404', () => json({ error: 'User not found' }, 404), (l) => word(l, 'errors.save')],
      ['no network', () => { throw new TypeError('Failed to fetch'); }, (l) => word(l, 'errors.retry')],
      ['not json', () => new Response('<html>', { status: 502 }), (l) => word(l, 'errors.retry')],
    ];
    for (const locale of LOCALES) {
      for (const [name, reply, text] of cases) {
        resetWorld();
        srv.save = reply as never;
        const o = await open(locale, {}, TELEGRAM);
        try {
          const n = NAMES[locale];
          await tapAndSettle(o, switchOf(o.m, n.family));
          assert(saves().length === 1, `${locale} ${name}: ${saves().length} saves`);
          assert(!isOn(switchOf(o.m, n.family)) && isOn(switchOf(o.m, n.me)) && isOn(switchOf(o.m, n.kids)) && listRows(o.m).length === 2, `${locale} ${name}: the switch did not go back`);
          assert(show(alertsOf(o.m)) === show([text(locale)]), `${locale} ${name}: alerts ${show(alertsOf(o.m))}`);
          assert(statusText(o.m).length === 1 && !page(o.m).includes(ui(locale, 'saved')), `${locale} ${name}: "Saved" with a refusal ${show(statusText(o.m))}`);
          assert(appLogs.some((l) => l.startsWith('[select-calendars]')), `${locale} ${name}: not logged`);
          // The next tap sends the selection without the undone change
          srv.save = () => json({ success: true });
          await tapAndSettle(o, switchOf(o.m, n.noa));
          assert(show(bodyOf().calendarAssignments.map((a) => a.calendarId)) === show([ME, KIDS, NOA]), `${locale} ${name}: the next save ${show(bodyOf().calendarAssignments.map((a) => a.calendarId))}`);
          assert(alertsOf(o.m).length === 0 && show(statusText(o.m)) === show([ui(locale, 'saved')]), `${locale} ${name}: the status after the next save ${show(statusText(o.m))}`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('S7 the calendar limit: a 403 calendar_limit_reached with the limit puts the switch back and says it as a sentence with the plan\'s room (en 1 / 3, he, ru one / few / many: 1, 3, 5, 21) and a See plans button to /<locale>/subscription?user_id=…; a tap the server would allow is never blocked by the page itself (a limit of 3 with three chosen still sends the tap)', async () => {
    const sentences: Record<Locale, [number, string][]> = {
      en: [[1, 'Your plan has room for 1 calendar, FamCal and Google together.'], [3, 'Your plan has room for 3 calendars, FamCal and Google together.']],
      he: [[1, 'בתוכנית שלכם יש מקום ליומן אחד, של FamCal ושל Google יחד.'], [2, 'בתוכנית שלכם יש מקום לשני יומנים, של FamCal ושל Google יחד.'], [3, 'בתוכנית שלכם יש מקום ל־3 יומנים, של FamCal ושל Google יחד.'], [5, 'בתוכנית שלכם יש מקום ל־5 יומנים, של FamCal ושל Google יחד.']],
      ru: [[1, 'В вашем тарифе есть место для 1 календаря FamCal и Google вместе.'], [3, 'В вашем тарифе есть место для 3 календарей FamCal и Google вместе.'], [5, 'В вашем тарифе есть место для 5 календарей FamCal и Google вместе.'], [21, 'В вашем тарифе есть место для 21 календаря FamCal и Google вместе.']],
    };
    for (const locale of LOCALES) {
      for (const [limit, sentence] of sentences[locale]) {
        resetWorld();
        srv.save = () => json({ error: 'calendar_limit_reached', limit, current: limit + 1 }, 403);
        // Three chosen and a limit of 3 on the server's side: the page does not guess, it sends the tap
        const o = await open(locale, {
          currentSelections: selectionOf({ selectedCalendars: new Set([ME, KIDS, NOA]), calendarLabels: new Map([[ME, new Set(['yours'])], [KIDS, new Set(['kids'])], [NOA, new Set(['spouse'])]]) }),
        }, TELEGRAM);
        try {
          await tapAndSettle(o, switchOf(o.m, NAMES[locale].family));
          assert(saves().length === 1, `${locale} ${limit}: the page blocked the tap (${saves().length} saves)`);
          assert(!isOn(switchOf(o.m, NAMES[locale].family)) && listRows(o.m).length === 3, `${locale} ${limit}: the switch stayed on`);
          const alert = byRole(o.m.container, 'alert')[0];
          assert(alert && flat(alert).startsWith(sentence), `${locale} ${limit}: ${show(alertsOf(o.m))} (want ${sentence})`);
          const plans = mustButton(alert, calendarsPageText(locale, 'seePlans'));
          o.m.click(plans);
          assert(show(pushes) === show([`/${locale}/subscription?user_id=5550001`]), `${locale} ${limit}: See plans pushed ${show(pushes)}`);
        } finally {
          close(o);
        }
      }
    }
    // A limit answer with no number is the generic refusal, not a sentence with a hole in it
    resetWorld();
    srv.save = () => json({ error: 'calendar_limit_reached' }, 403);
    const o = await open('en', {}, TELEGRAM);
    try {
      await tapAndSettle(o, switchOf(o.m, 'Family'));
      assert(show(alertsOf(o.m)) === show([word('en', 'errors.save')]), `no limit: ${show(alertsOf(o.m))}`);
    } finally {
      close(o);
    }
  });

  await check('S8 one request at a time: while a save runs the tapped switch shows it (spinner, aria-busy) and every other switch, row and the notes row are off and tapping them sends nothing; two taps on two switches in one frame send one request; the final state on screen is the server\'s; a tap while a sheet\'s save runs does nothing either', async () => {
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      const release = holdNext();
      o.m.click(switchOf(o.m, 'Family'));
      await settle();
      const family = switchOf(o.m, 'Family');
      assert(family.getAttribute('aria-busy') === 'true' && elements(family).some((e) => classes(e).includes('ch-form-spinner')), 'the tapped switch does not show it works');
      const others = pageSwitches(o.m).filter((s) => s !== family);
      assert(others.every((s) => s.hasAttribute('disabled') && !s.hasAttribute('aria-busy')), 'another switch is on while a save runs');
      assert(listRows(o.m).every((r) => r.hasAttribute('disabled')), 'a row is on while a save runs');
      assert(notesRow(o.m).hasAttribute('disabled'), 'the notes row is on while a save runs');
      assert(isOn(family), 'the tapped switch does not read on while it saves');
      o.m.click(switchOf(o.m, 'Noa'));
      o.m.click(switchOf(o.m, 'Kids and school'));
      o.m.click(listRows(o.m)[0]);
      o.m.click(notesRow(o.m));
      assert(saves().length === 1 && !sheetOf(o.m), `something was sent or opened while a save ran: ${saves().length}, ${dialogs(o.m).length}`);
      await release(json({ success: true }));
      await settle();
      assert(pageSwitches(o.m).every((s) => !s.hasAttribute('disabled') && !s.hasAttribute('aria-busy')) && show(pageSwitches(o.m).map(isOn)) === show([true, true, true, false]), 'the controls stay off, or the state is not the server\'s');
      // Two taps in one frame (no render between them, so nothing is disabled yet): still one request
      const frame = holdNext();
      await act(async () => {
        o.m.click(switchOf(o.m, 'Noa'));
        o.m.click(switchOf(o.m, 'Family'));
      });
      await settle();
      assert(saves().length === 2 && show(bodyOf().calendarAssignments.map((a) => a.calendarId)) === show([ME, KIDS, FAMILY, NOA]), `two taps in one frame sent ${saves().length - 1} request(s): ${show(bodyOf().calendarAssignments.map((a) => a.calendarId))}`);
      await frame(json({ success: true }));
      await settle();
      assert(show(pageSwitches(o.m).map(isOn)) === show([true, true, true, true]), `the final state: ${show(pageSwitches(o.m).map(isOn))}`);
      // A sheet's save in flight: the page behind it takes no tap either
      await openRow(o, 'Dana');
      // Two Saves in one frame (the button is not disabled yet): one request
      const sheetFrame = holdNext();
      await act(async () => {
        o.m.click(saveButton(o.m));
        o.m.click(saveButton(o.m));
      });
      await settle();
      assert(saves().length === 3, `two Saves in one frame sent ${saves().length - 2} request(s)`);
      await sheetFrame(json({ success: true }));
      await settle();
      assert(!sheetOf(o.m), 'the sheet stays after the first answer');
      await openRow(o, 'Dana');
      const sheetRelease = holdNext();
      o.m.click(saveButton(o.m));
      await settle();
      assert(saveButton(o.m).hasAttribute('disabled') && saveButton(o.m).getAttribute('aria-busy') === 'true' && cancelButton(o.m).hasAttribute('disabled'), 'the sheet does not show the request');
      o.m.click(saveButton(o.m));
      o.m.click(switchOf(o.m, 'Noa'));
      assert(saves().length === 4, `a tap while the sheet saved sent ${saves().length - 3} more`);
      await sheetRelease(json({ success: true }));
      await settle();
      assert(!sheetOf(o.m), 'the sheet stays after the answer');
    } finally {
      close(o);
    }
    // The undone change of a refused save is the state from before it, even when a request failed in flight
    resetWorld();
    const f = await open('en', {}, TELEGRAM);
    try {
      const release = holdNext();
      f.m.click(switchOf(f.m, 'Family'));
      await settle();
      await release(json({ error: 'x' }, 500));
      await settle();
      assert(show(pageSwitches(f.m).map(isOn)) === show([true, false, true, false]) && pageSwitches(f.m).every((s) => !s.hasAttribute('disabled')), 'the state after a refused save in flight');
    } finally {
      close(f);
    }
  });

  await check('S9 a calendar\'s sheet (a tap on its row): named for the calendar, with the Primary switch and its hint, the Category radios (No category, Yours, Spouse, Kids, Birthdays, each with its meaning), the Note field (200 characters) with its hint; the spouse details only for a spouse calendar; it shows the saved values and Cancel closes it without a request', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const n = NAMES[locale];
      const o = await open(locale, {
        currentSelections: selectionOf({
          selectedCalendars: new Set([ME, KIDS, NOA]),
          calendarLabels: new Map([[ME, new Set(['primary', 'yours'])], [KIDS, new Set(['kids'])], [NOA, new Set(['spouse'])]]),
          spouseInfo: { personName: n.noa, personEnglishName: 'Noa', personGender: 'female' },
          calendarRules: new Map([[KIDS, 'Early dismissal']]),
        }),
      }, { ...TELEGRAM, scheme: locale === 'he' ? 'dark' : 'light' });
      try {
        await openRow(o, n.kids);
        const sheet = sheetOf(o.m) as FakeElement;
        assert(sheet.getAttribute('aria-label') === n.kids, `${locale}: the sheet's name ${sheet.getAttribute('aria-label')}`);
        const primary = switchesOf(sheet);
        assert(primary.length === 1 && flat(primary[0]).startsWith(cat(locale, 'primary')) && flat(primary[0]).includes(hint(locale, 'primary')) && !isOn(primary[0]), `${locale}: the primary switch ${show(primary.map(flat))}`);
        const group = groupIn(sheet, word(locale, 'category'));
        assert(show(radiosOf(group).map((r) => r.getAttribute('data-value'))) === show(['none', 'yours', 'spouse', 'kids', 'birthdays']), `${locale}: the options`);
        assert(radiosOf(group).map((r) => flat(r)).join('|').startsWith(`${word(locale, 'noCategory')}|${cat(locale, 'yours')}`), `${locale}: ${radiosOf(group).map(flat)}`);
        for (const k of ['yours', 'spouse', 'kids', 'birthdays']) assert(flat(radioNamed(group, cat(locale, k))).includes(hint(locale, k)), `${locale}: ${k}'s meaning`);
        assert(show(checkedOf(group).map((r) => r.getAttribute('data-value'))) === show(['kids']), `${locale}: the saved category`);
        assert(radiosOf(group).every((r) => !r.hasAttribute('disabled')), `${locale}: an option is off without primary`);
        assert(!flat(sheet).includes(word(locale, 'mainIsYours')), `${locale}: the main-is-yours note without primary`);
        const note = fieldByLabel(sheet, word(locale, 'note'));
        assert(note.localName === 'textarea' && valueOf(note) === 'Early dismissal' && note.getAttribute('maxLength') === '200' && note.getAttribute('placeholder') === word(locale, 'notePlaceholder'), `${locale}: the note field`);
        assert(flat(sheet).includes(word(locale, 'noteHint')), `${locale}: the note hint`);
        assert(!flat(sheet).includes(word(locale, 'spouseHint')) && !elements(sheet).some((e) => e.getAttribute('aria-label') === word(locale, 'spouseName')), `${locale}: spouse details on a kids calendar`);
        assert(saveButton(o.m) && flat(saveButton(o.m)) === ui(locale, 'save') && flat(cancelButton(o.m)) === ui(locale, 'cancel'), `${locale}: Save and Cancel`);
        // Cancel: no request, nothing changed
        o.m.click(cancelButton(o.m));
        assert(!sheetOf(o.m) && saves().length === 0, `${locale}: Cancel`);
        // A spouse calendar shows the details, one set
        await openRow(o, n.noa);
        const sp = sheetOf(o.m) as FakeElement;
        assert(flat(sp).includes(word(locale, 'spouse')) && flat(sp).includes(word(locale, 'spouseHint')), `${locale}: the spouse section`);
        const name = fieldByLabel(sp, word(locale, 'spouseName'));
        const english = fieldByLabel(sp, word(locale, 'spouseEnglishName'));
        // Each field has its label on screen (a placeholder is gone once something is typed), the gender pair too
        assert(labelAbove(name) === word(locale, 'spouseName') && labelAbove(english) === word(locale, 'spouseEnglishName'), `${locale}: the spouse fields' labels: ${show([labelAbove(name), labelAbove(english)])}`);
        assert(elements(sp).some((e) => classes(e).includes('ch-form-group-label') && flat(e) === word(locale, 'spouseGender')), `${locale}: no visible gender label`);
        assert(name.value === n.noa && name.getAttribute('maxLength') === '50' && name.getAttribute('placeholder') === word(locale, 'spouseNamePlaceholder') && english.value === 'Noa' && english.getAttribute('maxLength') === '50', `${locale}: the spouse fields`);
        const gender = groupIn(sp, word(locale, 'spouseGender'));
        assert(show(radiosOf(gender).map(flat)) === show([word(locale, 'male'), word(locale, 'female')]) && show(checkedOf(gender).map(flat)) === show([word(locale, 'female')]), `${locale}: the gender control`);
        assert(saves().length === 0, `${locale}: a request from opening a sheet`);
        o.m.click(cancelButton(o.m));
        // The primary calendar: its switch is on and only Yours can be chosen
        await openRow(o, n.me);
        const sh = sheetOf(o.m) as FakeElement;
        assert(isOn(switchesOf(sh)[0]) && switchesOf(sh)[0].getAttribute('aria-disabled') === 'true' && flat(switchesOf(sh)[0]).includes(word(locale, 'mainHowToChange')) && !flat(switchesOf(sh)[0]).includes(hint(locale, 'primary')), `${locale}: the main calendar's switch is on, off for taps, and says how to change it: ${flat(switchesOf(sh)[0])}`);
        const g = groupIn(sh, word(locale, 'category'));
        assert(show(radiosOf(g).filter((r) => r.hasAttribute('disabled')).map((r) => r.getAttribute('data-value'))) === show(['none', 'spouse', 'kids', 'birthdays']) && show(checkedOf(g).map((r) => r.getAttribute('data-value'))) === show(['yours']), `${locale}: primary's category options`);
        assert(flat(sh).includes(word(locale, 'mainIsYours')), `${locale}: the main-is-yours note`);
      } finally {
        close(o);
      }
    }
  });

  await check('S10 the calendar sheet\'s Save sends the whole selection with this calendar\'s category, rule and (for a spouse calendar) the one set of spouse details, trimmed; success closes the sheet and shows Saved; a refusal keeps the sheet open with the typed values and the error, and the page behind it is unchanged', async () => {
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      // Kids -> Spouse, a new note, the spouse details
      await openRow(o, 'Kids and school');
      const sheet = () => sheetOf(o.m) as FakeElement;
      o.m.click(radioNamed(groupIn(sheet(), word('en', 'category')), cat('en', 'spouse')));
      assert(flat(sheet()).includes(word('en', 'spouseHint')), 'choosing Spouse does not show the details');
      o.m.input(fieldByLabel(sheet(), word('en', 'note')), '  Pickup at four  ');
      o.m.input(fieldByLabel(sheet(), word('en', 'spouseName')), ' Noa ');
      o.m.input(fieldByLabel(sheet(), word('en', 'spouseEnglishName')), 'Noa L');
      o.m.click(radioNamed(groupIn(sheet(), word('en', 'spouseGender')), word('en', 'female')));
      srv.save = () => json({ error: 'nope' }, 500);
      o.m.click(saveButton(o.m));
      await settle();
      assert(sheetOf(o.m), 'the sheet closed on a refusal');
      assert(valueOf(fieldByLabel(sheet(), word('en', 'note'))) === '  Pickup at four  ' && fieldByLabel(sheet(), word('en', 'spouseName')).value === ' Noa ' && show(checkedOf(groupIn(sheet(), word('en', 'category'))).map((r) => r.getAttribute('data-value'))) === show(['spouse']), 'the typed values did not stay');
      assert(show(byRole(sheet(), 'alert').map(flat)) === show([word('en', 'errors.retry')]), `the sheet's error ${show(byRole(sheet(), 'alert').map(flat))}`);
      assert(flat(rowOf(o.m, 'Kids and school')).includes(cat('en', 'kids')) && !page(o.m).includes(ui('en', 'saved')), 'the page behind changed');
      // Retry
      srv.save = () => json({ success: true });
      o.m.click(saveButton(o.m));
      await settle();
      assert(!sheetOf(o.m), 'the sheet stayed after a good save');
      const want = {
        calendarAssignments: [
          { calendarId: ME, labels: ['yours'], name: 'Dana', color: '#039BE5' },
          { calendarId: KIDS, labels: ['spouse'], name: 'Kids and school', color: '#F4511E', personName: 'Noa', personEnglishName: 'Noa L', personGender: 'female', rules: ['Pickup at four'] },
        ],
        globalRules: ['Be brief'],
      };
      assert(saves().length === 2 && canon(bodyOf()) === canon(want), `the body:\n${canon(bodyOf())}\nwant\n${canon(want)}`);
      assert(flat(rowOf(o.m, 'Kids and school')).includes(cat('en', 'spouse')) && show(statusText(o.m)) === show(['Saved']), `after: ${flat(rowOf(o.m, 'Kids and school'))} ${show(statusText(o.m))}`);
      // The spouse details are one set: another spouse calendar gets them too (on the next save)
      await tapAndSettle(o, switchOf(o.m, 'Noa'));
      await openRow(o, 'Noa');
      o.m.click(radioNamed(groupIn(sheetOf(o.m) as FakeElement, word('en', 'category')), cat('en', 'spouse')));
      assert(fieldByLabel(sheetOf(o.m) as FakeElement, word('en', 'spouseName')).value === 'Noa', 'the second spouse calendar does not show the one set');
      o.m.click(saveButton(o.m));
      await settle();
      const spouses = bodyOf().calendarAssignments.filter((a) => (a.labels as string[]).includes('spouse'));
      assert(spouses.length === 2 && spouses.every((a) => a.personName === 'Noa' && a.personGender === 'female'), `both spouse calendars carry the details: ${show(spouses)}`);
      // An emptied note drops the rule; Category "none" drops the category and keeps nothing else of it
      await openRow(o, 'Kids and school');
      o.m.input(fieldByLabel(sheetOf(o.m) as FakeElement, word('en', 'note')), '   ');
      o.m.click(radioNamed(groupIn(sheetOf(o.m) as FakeElement, word('en', 'category')), word('en', 'noCategory')));
      o.m.click(saveButton(o.m));
      await settle();
      const kids = bodyOf().calendarAssignments.find((a) => a.calendarId === KIDS) as Row;
      assert(show(kids.labels) === show([]) && !('rules' in kids) && !('personName' in kids), `the emptied calendar: ${show(kids)}`);
      assert(flat(rowOf(o.m, 'Kids and school')).includes(word('en', 'noCategory')), 'its row says No category');
    } finally {
      close(o);
    }
  });

  await check('S11 the primary rules: Primary on in a sheet adds Yours (and replaces another category), disables the other categories and shows the main-is-yours note; Save clears primary on every other calendar and the row gets the primary tag while the other loses it; turning primary off keeps Yours and frees the options; "Yours" can\'t be removed while primary is on (the option is the only one left)', async () => {
    resetWorld();
    const sel = selectionOf({
      selectedCalendars: new Set([ME, KIDS, FAMILY]),
      calendarLabels: new Map([[ME, new Set(['primary', 'yours'])], [KIDS, new Set(['kids'])], [FAMILY, new Set(['yours'])]]),
    });
    const o = await open('en', { currentSelections: sel }, TELEGRAM);
    try {
      // Kids (category kids) takes primary: it becomes yours + primary, Dana loses primary
      await openRow(o, 'Kids and school');
      const sheet = () => sheetOf(o.m) as FakeElement;
      o.m.click(switchesOf(sheet())[0]);
      const group = () => groupIn(sheet(), word('en', 'category'));
      assert(isOn(switchesOf(sheet())[0]) && show(checkedOf(group()).map((r) => r.getAttribute('data-value'))) === show(['yours']), 'Primary on does not make it Yours');
      assert(radiosOf(group()).filter((r) => r.hasAttribute('disabled')).length === 4 && !radioNamed(group(), cat('en', 'yours')).hasAttribute('disabled') && flat(sheet()).includes(word('en', 'mainIsYours')), 'the other categories are not off, or the note is missing');
      o.m.click(radioNamed(group(), cat('en', 'kids')));
      assert(show(checkedOf(group()).map((r) => r.getAttribute('data-value'))) === show(['yours']), 'a disabled category took a tap');
      o.m.click(saveButton(o.m));
      await settle();
      const kids = bodyOf().calendarAssignments.find((a) => a.calendarId === KIDS) as Row;
      const dana = bodyOf().calendarAssignments.find((a) => a.calendarId === ME) as Row;
      assert(canon(kids.labels.slice().sort()) === canon(['primary', 'yours']) && show(dana.labels) === show(['yours']), `labels: ${show(kids.labels)} / ${show(dana.labels)}`);
      assert(bodyOf().calendarAssignments.filter((a) => (a.labels as string[]).includes('primary')).length === 1, 'more than one primary in the body');
      assert(show(tagsOf(rowOf(o.m, 'Kids and school'))) === show([{ text: cat('en', 'primary'), tone: 'accent' }]) && tagsOf(rowOf(o.m, 'Dana')).length === 0, 'the primary tag did not move');
      // Primary is one-way, as it was: once saved, its switch is off for good (it says how to change the main calendar), and a tap changes nothing
      await openRow(o, 'Kids and school');
      const main = switchesOf(sheet())[0];
      assert(isOn(main) && main.getAttribute('aria-disabled') === 'true', 'the saved main calendar\'s switch can be turned off');
      assert(flat(main).includes(word('en', 'mainHowToChange')) && !flat(main).includes(hint('en', 'primary')), `the main calendar's hint: ${flat(main)}`);
      o.m.click(main);
      assert(isOn(switchesOf(sheet())[0]) && radiosOf(group()).filter((r) => r.hasAttribute('disabled')).length === 4 && flat(sheet()).includes(word('en', 'mainIsYours')), 'a tap on the saved main calendar\'s switch turned primary off');
      o.m.click(saveButton(o.m));
      await settle();
      const after = bodyOf().calendarAssignments.find((a) => a.calendarId === KIDS) as Row;
      assert(canon(after.labels.slice().sort()) === canon(['primary', 'yours']), `primary is kept: ${show(after.labels)}`);
      // Before the save the switch is free: on, then off again, brings the options back (Family is not the main calendar)
      await openRow(o, 'Family');
      const family = () => switchesOf(sheet())[0];
      assert(!isOn(family()) && family().getAttribute('aria-disabled') !== 'true' && flat(family()).includes(hint('en', 'primary')), `a calendar that is not the main one: ${flat(family())}`);
      o.m.click(family());
      assert(isOn(family()) && family().getAttribute('aria-disabled') !== 'true' && flat(family()).includes(hint('en', 'primary')), 'the switch is off before the save, or its hint changed already');
      o.m.click(family());
      assert(!isOn(family()) && radiosOf(group()).every((r) => !r.hasAttribute('disabled')) && !flat(sheet()).includes(word('en', 'mainIsYours')), 'on and off again before the save');
      o.m.click(cancelButton(o.m));
    } finally {
      close(o);
    }
    // A refused primary change leaves the other calendar its primary (the saved state is untouched)
    resetWorld();
    const p = await open('en', { currentSelections: sel }, TELEGRAM);
    try {
      await openRow(p, 'Family');
      p.m.click(switchesOf(sheetOf(p.m) as FakeElement)[0]);
      srv.save = () => json({ error: 'Too many requests' }, 429);
      p.m.click(saveButton(p.m));
      await settle();
      assert(sheetOf(p.m) && tagsOf(rowOf(p.m, 'Dana')).length === 1 && tagsOf(rowOf(p.m, 'Family')).length === 0, 'a refused primary change moved the tag');
    } finally {
      close(p);
    }
  });

  await check('S12 "New events will go to <name>": the first time primary is turned on here while a FamCal calendar holds it, the status says it (in each language, with the name isolated) in place of Saved, once; with no FamCal primary, or on a calendar that already was primary, it says Saved', async () => {
    const lines: Record<Locale, string> = {
      en: 'New events will go to Family',
      he: 'מעכשיו אירועים חדשים יירשמו ב־משפחה',
      ru: 'Новые события теперь будут попадать в «Семья»',
    };
    const sel = (primary: boolean) => selectionOf({
      selectedCalendars: new Set([ME, FAMILY]),
      calendarLabels: new Map([[ME, new Set(primary ? ['primary', 'yours'] : ['yours'])], [FAMILY, new Set(['yours'])]]),
    });
    for (const locale of LOCALES) {
      resetWorld();
      const o = await open(locale, { famcalPrimaryName: 'Home', currentSelections: sel(false) }, TELEGRAM);
      try {
        await openRow(o, NAMES[locale].family);
        o.m.click(switchesOf(sheetOf(o.m) as FakeElement)[0]);
        o.m.click(saveButton(o.m));
        await settle();
        assert(show(statusText(o.m)) === show([lines[locale]]), `${locale}: ${show(statusText(o.m))}`);
        // Once: the next primary change here says Saved
        await openRow(o, NAMES[locale].me);
        o.m.click(switchesOf(sheetOf(o.m) as FakeElement)[0]);
        o.m.click(saveButton(o.m));
        await settle();
        assert(show(statusText(o.m)) === show([ui(locale, 'saved')]), `${locale}: the second time ${show(statusText(o.m))}`);
      } finally {
        close(o);
      }
    }
    resetWorld();
    const none = await open('en', { famcalPrimaryName: null, currentSelections: sel(false) }, TELEGRAM);
    try {
      await openRow(none, 'Family');
      none.m.click(switchesOf(sheetOf(none.m) as FakeElement)[0]);
      none.m.click(saveButton(none.m));
      await settle();
      assert(show(statusText(none.m)) === show(['Saved']), `no FamCal primary: ${show(statusText(none.m))}`);
    } finally {
      close(none);
    }
    const same = await open('en', { famcalPrimaryName: 'Home', currentSelections: sel(true) }, TELEGRAM);
    try {
      await openRow(same, 'Dana');
      same.m.input(fieldByLabel(sheetOf(same.m) as FakeElement, word('en', 'note')), 'Hello');
      same.m.click(saveButton(same.m));
      await settle();
      assert(show(statusText(same.m)) === show(['Saved']), `already primary: ${show(statusText(same.m))}`);
    } finally {
      close(same);
    }
    // A refused save does not use the note up: the next good one says it
    resetWorld();
    srv.save = () => json({ error: 'x' }, 500);
    const refused = await open('en', { famcalPrimaryName: 'Home', currentSelections: sel(false) }, TELEGRAM);
    try {
      await openRow(refused, 'Family');
      refused.m.click(switchesOf(sheetOf(refused.m) as FakeElement)[0]);
      refused.m.click(saveButton(refused.m));
      await settle();
      srv.save = () => json({ success: true });
      refused.m.click(saveButton(refused.m));
      await settle();
      assert(show(statusText(refused.m)) === show([lines.en]), `after a refusal: ${show(statusText(refused.m))}`);
    } finally {
      close(refused);
    }
  });

  await check('S13 the notes for all calendars: a row with the count opens a sheet with three fields (Note 1..3, 200 characters, the saved ones filled), the hint and Save; Save sends the non-empty notes as globalRules with the whole selection and shows Saved; a refusal keeps the sheet with the typed notes and the error; the count follows', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const o = await open(locale, {}, TELEGRAM);
      try {
        o.m.click(notesRow(o.m));
        await settle();
        const sheet = sheetOf(o.m) as FakeElement;
        assert(sheet && sheet.getAttribute('aria-label') === word(locale, 'notes'), `${locale}: the sheet's name`);
        const fields = [1, 2, 3].map((i) => fieldByLabel(sheet, word(locale, 'notesPlaceholder', { number: i })));
        assert(show(fields.map((f) => f.value)) === show(['Be brief', '', '']) && fields.every((f) => f.getAttribute('maxLength') === '200' && f.getAttribute('placeholder') === word(locale, 'notesPlaceholder', { number: fields.indexOf(f) + 1 })), `${locale}: the fields`);
        assert(flat(sheet).includes(word(locale, 'notesHint')), `${locale}: the hint`);
        o.m.input(fields[1], '  Mind the buses ');
        o.m.input(fields[2], 'x'.repeat(5));
        srv.save = () => json({ error: 'nope' }, 500);
        o.m.click(saveButton(o.m));
        await settle();
        assert(sheetOf(o.m) && fieldByLabel(sheetOf(o.m) as FakeElement, word(locale, 'notesPlaceholder', { number: 2 })).value === '  Mind the buses ' && show(byRole(sheetOf(o.m) as FakeElement, 'alert').map(flat)) === show([word(locale, 'errors.retry')]), `${locale}: a refusal kept nothing`);
        srv.save = () => json({ success: true });
        o.m.input(fieldByLabel(sheetOf(o.m) as FakeElement, word(locale, 'notesPlaceholder', { number: 3 })), '');
        o.m.click(saveButton(o.m));
        await settle();
        assert(!sheetOf(o.m) && show(bodyOf().globalRules) === show(['Be brief', 'Mind the buses']) && saves().length === 2, `${locale}: ${show(bodyOf().globalRules)}`);
        assert(show(bodyOf().calendarAssignments.map((a) => a.calendarId)) === show([ME, KIDS]), `${locale}: the whole selection travels with the notes`);
        assert(show(statusText(o.m)) === show([ui(locale, 'saved')]) && flat(notesRow(o.m)).endsWith({ en: '2 notes', he: 'שתי הערות', ru: '2 заметки' }[locale]), `${locale}: after ${show(statusText(o.m))} ${flat(notesRow(o.m))}`);
        // All notes emptied
        o.m.click(notesRow(o.m));
        await settle();
        for (const i of [1, 2, 3]) o.m.input(fieldByLabel(sheetOf(o.m) as FakeElement, word(locale, 'notesPlaceholder', { number: i })), '');
        o.m.click(saveButton(o.m));
        await settle();
        assert(show(bodyOf().globalRules) === show([]) && flat(notesRow(o.m)).endsWith({ en: 'None', he: 'אין', ru: 'Нет' }[locale]), `${locale}: emptied: ${show(bodyOf().globalRules)}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S14 Back has one owner (AppScreen): it closes an open sheet first, never while a request runs, else goes to the Calendars screen (its parent, whoever opened this one); Cancel, Escape and the scrim do the same and are off while a save runs; in a browser the header\'s own back (once, mirrored in he) does the same; a swipe down in a sheet is held off', async () => {
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      assert(!buttonsOf(o.m.container).some((b) => b.getAttribute('aria-label') === ui('en', 'back')), 'an in-page back inside Telegram 7.7');
      const swipes = () => o.tgCalls.filter((c) => /VerticalSwipes/.test(c)).at(-1);
      assert(swipes() === 'enableVerticalSwipes()', `swipes ${swipes()}`);
      await openRow(o, 'Dana');
      assert(swipes() === 'disableVerticalSwipes()', `a sheet open: ${swipes()}`);
      await back(o);
      assert(!sheetOf(o.m) && pushes.length === 0 && swipes() === 'enableVerticalSwipes()', 'Back with the sheet open');
      o.m.click(notesRow(o.m));
      await settle();
      await back(o);
      assert(!sheetOf(o.m) && pushes.length === 0, 'Back with the notes sheet open');
      await back(o);
      assert(show(pushes) === show(['/en/calendars?user_id=5550001']), `Back with no sheet: ${show(pushes)}`);
      // While a request runs nothing closes the sheet or leaves the page
      pushes.length = 0;
      await openRow(o, 'Dana');
      const release = holdNext();
      o.m.click(saveButton(o.m));
      await settle();
      await back(o);
      o.m.key(sheetOf(o.m) as FakeNode, 'Escape');
      o.m.click(elements(o.m.container).find((e) => e.className === 'ch-sheet-backdrop') as FakeNode);
      o.m.click(cancelButton(o.m));
      assert(dialogs(o.m).length === 1 && pushes.length === 0, `closed while it works: ${dialogs(o.m).length} dialogs, pushes ${show(pushes)}`);
      await release(json({ success: true }));
      await settle();
      // With no sheet, a switch save running holds Back too
      const hold = holdNext();
      o.m.click(switchOf(o.m, 'Family'));
      await settle();
      await back(o);
      assert(pushes.length === 0, `Back went on while a save ran: ${show(pushes)}`);
      await hold(json({ success: true }));
      await settle();
      await back(o);
      assert(show(pushes) === show(['/en/calendars?user_id=5550001']), `Back after it: ${show(pushes)}`);
    } finally {
      close(o);
    }
    for (const locale of ['en', 'he'] as Locale[]) {
      resetWorld();
      const b = await open(locale, {});
      try {
        const buttons = buttonsOf(b.m.container).filter((x) => x.getAttribute('aria-label') === ui(locale, 'back'));
        assert(buttons.length === 1, `${locale}: ${buttons.length} header back buttons`);
        await openRow(b, NAMES[locale].me);
        b.m.click(buttons[0]);
        assert(!sheetOf(b.m) && pushes.length === 0, `${locale}: the header back with a sheet open`);
        b.m.click(buttons[0]);
        assert(show(pushes) === show([`/${locale}/calendars?user_id=5550001`]), `${locale}: the header back: ${show(pushes)}`);
        assert(elements(buttons[0]).some((e) => e.localName === 'svg' && classes(e).includes('ch-flip')), `${locale}: the back arrow does not flip in RTL`);
      } finally {
        close(b);
      }
    }
  });

  await check('S15 he and ru show none of the old copy (Select Your Calendars, Custom Rule, Spouse Information, Global Rules, added to, removed from, Saving, Failed to save) and no English title= or aria-label=, on the page, the calendar sheet, the notes sheet and a status line', async () => {
    const OLD = ['Select Your Calendars', 'Custom Rule', 'Spouse Information', 'Global Rules', 'added to', 'removed from', 'Saving', 'Failed to save', 'calendars selected', 'set as primary', 'Select gender', 'English Name'];
    for (const locale of ['he', 'ru'] as Locale[]) {
      resetWorld();
      const n = NAMES[locale];
      const o = await open(locale, {
        currentSelections: selectionOf({
          selectedCalendars: new Set([ME, NOA]),
          calendarLabels: new Map([[ME, new Set(['primary', 'yours'])], [NOA, new Set(['spouse'])]]),
        }),
      }, { ...TELEGRAM, scheme: 'dark' });
      try {
        const seen: string[] = [];
        const labelsSeen: string[] = [];
        const note = () => {
          seen.push(page(o.m));
          for (const e of elements(o.m.container)) for (const attr of ['title', 'aria-label']) if (e.getAttribute(attr)) labelsSeen.push(e.getAttribute(attr) as string);
        };
        note();
        await tapAndSettle(o, switchOf(o.m, n.family));
        note();
        await openRow(o, n.noa);
        note();
        o.m.click(cancelButton(o.m));
        o.m.click(notesRow(o.m));
        await settle();
        note();
        o.m.click(cancelButton(o.m));
        srv.save = () => json({ error: 'calendar_limit_reached', limit: 3 }, 403);
        await tapAndSettle(o, switchOf(o.m, n.kids));
        note();
        const text = seen.join(' | ');
        for (const old of OLD) assert(!text.includes(old), `${locale}: "${old}" in ${text.slice(0, 200)}`);
        assert(!/[A-Za-z]/.test(text.replace(/Google|FamCal/g, '')), `${locale}: Latin letters in ${text}`);
        const english = labelsSeen.filter((l) => /[A-Za-z]/.test(l.replace(/Google|FamCal/g, '')));
        assert(english.length === 0, `${locale}: English title or aria-label: ${show(english)}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S16 a long Google name (a link, no spaces) stays inside its row, shown or hidden: the name is isolated in a <bdi>, the text button takes the room and can shrink (CALENDAR_ROW_CSS), the switch never does; the description is never drawn', async () => {
    resetWorld();
    const long = 'https://calendar.example.com/ical/very-long-unbroken-calendar-address-for-the-school-parents-committee@group.calendar.google.com';
    const o = await open('he', { availableCalendars: [{ id: ME, name: long, description: long, backgroundColor: '#039BE5' }, { id: FAMILY, name: long, description: long, backgroundColor: '#7986CB' }, ...availableFor('he').slice(2)] }, { ...TELEGRAM, scheme: 'dark' });
    try {
      const [shown, hidden] = pageSwitches(o.m);
      assert(switchName(o.m, shown) === long && flat(hidden) === long, 'the long name is not shown');
      assert(page(o.m).split(long).length === 3, 'the description is drawn');
      for (const row of [calendarRowOf(shown), calendarRowOf(hidden)]) assert(elements(row).some((e) => e.localName === 'bdi' && flat(e) === long), 'the long name is not isolated');
    } finally {
      close(o);
    }
    const { CALENDAR_ROW_CSS } = (await import('../app/[locale]/(app)/select-calendars/SelectCalendarsClient')) as unknown as { CALENDAR_ROW_CSS: string };
    // A rule's body by one of the selectors it lists
    const rowRule = (selector: string) => [...CALENDAR_ROW_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((r) => r[1].split(',').map((x) => x.trim()).includes(selector))?.[2] ?? '';
    assert(/flex:\s*1 1 0/.test(rowRule('.ch-cal-row > .ch-cal-open')) && /min-inline-size:\s*0/.test(rowRule('.ch-cal-row > .ch-cal-open')), `the text button does not take the room or cannot shrink: ${rowRule('.ch-cal-row > .ch-cal-open')}`);
    assert(/flex:\s*none/.test(rowRule('button.ch-cal-switch')) && /min-inline-size:\s*44px/.test(rowRule('button.ch-cal-switch')), `the switch can be squeezed or is under 44 px: ${rowRule('button.ch-cal-switch')}`);
    // The kit lets a person's own unbroken text in a hint wrap (the <bdi> in it), and only that: a hint that wraps "anywhere" itself
    // shrinks its label column to one letter and breaks the words of the editor's Repeat row in Russian
    const { FORM_CSS } = await import('../components/app-ui/form-kit');
    const ruleBody = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`).exec(FORM_CSS)?.[1] ?? '';
    assert(/overflow-wrap:\s*anywhere/.test(ruleBody('.ch-form-hint > bdi')), 'FORM_CSS: the free text in a hint does not wrap an unbroken word');
    assert(ruleBody('.ch-form-hint') !== '' && !/overflow-wrap/.test(ruleBody('.ch-form-hint')), `FORM_CSS: .ch-form-hint itself wraps anywhere: ${ruleBody('.ch-form-hint')}`);
    assert(!/\.ch-form-label\s*\{[^}]*overflow-wrap/.test(FORM_CSS), 'FORM_CSS: a label wraps anywhere');
    const { lintCss } = await import('./lib/css-lint');
    assert(lintCss(FORM_CSS).length === 0, `FORM_CSS lint: ${show(lintCss(FORM_CSS))}`);
  });

  await check('S17 the kit\'s RadioCard: an option can carry a hint and be off by itself (the card\'s own disabled still turns every option off); a disabled option takes no tap; SwitchRow takes a label that is more than text', async () => {
    const { ButtonRow, FORM_CSS, RadioCard, SwitchRow } = await import('../components/app-ui/form-kit');
    installWindow();
    const taken: string[] = [];
    const radio = (disabled?: boolean) => createElement(NextIntlClientProvider, { locale: 'en', messages: messages.en } as never, createElement(RadioCard, {
      label: 'Category', value: 'a', onChange: (v: string) => void taken.push(v), disabled,
      options: [{ value: 'a', text: 'A', hint: 'About A' }, { value: 'b', text: 'B', hint: 'About B', disabled: true }, { value: 'c', text: 'C' }],
    } as never));
    const m = mount(radio());
    const rs = byRole(m.container, 'radio');
    assert(flat(rs[0]) === 'A About A' && flat(rs[2]) === 'C' && elements(rs[0]).some((e) => classes(e).includes('ch-form-hint')), `the options: ${show(rs.map(flat))}`);
    assert(!rs[0].hasAttribute('disabled') && rs[1].hasAttribute('disabled') && !rs[2].hasAttribute('disabled'), 'the options\' disabled');
    m.click(rs[1]);
    m.click(rs[2]);
    assert(show(taken) === show(['c']), `taps: ${show(taken)}`);
    m.unmount();
    const all = mount(radio(true));
    assert(byRole(all.container, 'radio').every((r) => r.hasAttribute('disabled')), 'the card\'s disabled turns every option off');
    all.unmount();
    // The chosen option is bold; what it means under it is not
    assert(/\.ch-choice\[aria-checked='true'\] \{\s*font-weight:\s*600;/.test(FORM_CSS) && /\.ch-choice \.ch-form-hint \{\s*font-weight:\s*400;/.test(FORM_CSS), 'the chosen option\'s hint is bold with it');
    // A button row can be off (its screen is working): the platform's disabled, so a tap does nothing and the kit dims it; without it nothing changes
    const opened: number[] = [];
    const rowOf = (disabled?: boolean) => createElement(ButtonRow, { label: 'Notes', value: '2 notes', onClick: () => void opened.push(1), disabled } as never);
    const off = mount(rowOf(true));
    const offButton = byRole(off.container, 'button')[0] ?? elements(off.container).find((e) => e.localName === 'button');
    assert(offButton && offButton.hasAttribute('disabled'), 'a disabled ButtonRow is not disabled');
    off.click(offButton);
    off.unmount();
    const on = mount(rowOf());
    const onButton = elements(on.container).find((e) => e.localName === 'button') as FakeElement;
    assert(!onButton.hasAttribute('disabled'), 'a ButtonRow is disabled by default');
    on.click(onButton);
    on.unmount();
    assert(opened.length === 1, `taps: ${opened.length} (a disabled row took one, or an enabled one none)`);
    assert(renderToString(rowOf()) === renderToString(createElement(ButtonRow, { label: 'Notes', value: '2 notes', onClick: () => undefined })), 'a ButtonRow without disabled changed its markup');
    const html = renderToString(createElement(SwitchRow, { label: createElement('span', { className: 'x' }, 'Rich'), checked: true, onChange: () => undefined }));
    assert(html.includes('<span class="x">Rich</span>') && /role="switch"/.test(html), `a node as the label: ${html.slice(0, 160)}`);
  });

  await check('S19 the pure rules (selection.ts): a change never touches the selection it started from (a refused save puts it back); primary is always also yours and only yours; a category leaves the other categories out; turning a calendar on gives yours only to a selection with none; edits to the spouse details of a calendar that is not a spouse calendar are dropped; the notes are trimmed and padded to three', async () => {
    const sel = await import('../app/[locale]/(app)/select-calendars/selection');
    const set = (...l: string[]) => new Set(l) as Set<never>;
    const names = (labels: Iterable<string>) => [...labels].sort().join();
    assert(names(sel.withCategory(set('primary', 'yours'), 'kids')) === 'primary,yours', 'a category replaced yours under primary');
    assert(names(sel.withCategory(set('kids'), 'spouse')) === 'spouse' && names(sel.withCategory(set('primary', 'yours'), null)) === 'primary,yours' && names(sel.withCategory(set('spouse'), null)) === '', 'withCategory');
    assert(names(sel.withPrimary(set('kids'), true)) === 'primary,yours' && names(sel.withPrimary(set('primary', 'yours'), false)) === 'yours', 'withPrimary');
    assert(sel.categoryOf(set('primary', 'kids', 'birthdays')) === 'kids' && sel.categoriesOf(set('primary', 'kids', 'birthdays')).join() === 'kids,birthdays' && sel.categoryOf(set('primary')) === null, 'categoryOf');
    const start = sel.selectionFrom({
      selectedCalendars: new Set([ME, KIDS]),
      calendarLabels: new Map([[ME, set('primary', 'yours')], [KIDS, set('kids')]]),
      spouseInfo: { personName: 'Noa' },
      calendarRules: new Map([[KIDS, 'rule']]),
      globalRules: ['a'],
    });
    const frozen = () => JSON.stringify({ s: [...start.selected], l: [...start.labels].map(([k, v]) => [k, [...v]]), r: [...start.rules], sp: start.spouse, g: start.globalRules });
    const before = frozen();
    const draft = { labels: set('primary', 'yours'), note: ' x ', spouse: { name: 'Dana', englishName: '', gender: '' as const } };
    const applied = sel.applyCalendar(start, KIDS, draft);
    sel.toggleShown(start, ME);
    sel.toggleShown(start, FAMILY);
    sel.withNotes(start, ['q', 'w']);
    assert(frozen() === before, `a change touched the selection it started from:\n${before}\n${frozen()}`);
    assert(applied.labels.get(ME)?.has('primary') === false && applied.labels.get(KIDS)?.has('primary') === true && applied.rules.get(KIDS) === 'x', 'applyCalendar');
    assert(applied.spouse?.personName === 'Noa', 'the spouse details of a calendar that is not a spouse calendar changed the set');
    const asSpouse = sel.applyCalendar(start, KIDS, { ...draft, labels: set('spouse') });
    assert(asSpouse.spouse?.personName === 'Dana' && asSpouse.spouse?.personEnglishName === undefined && asSpouse.spouse?.personGender === undefined, `the spouse details: ${show(asSpouse.spouse)}`);
    assert(sel.applyCalendar(start, KIDS, { ...draft, labels: set('spouse'), spouse: { name: ' ', englishName: '', gender: '' } }).spouse === null, 'emptied spouse details are none');
    assert(names(sel.toggleShown(start, FAMILY).labels.get(FAMILY) ?? []) === '' && names(sel.toggleShown(sel.toggleShown(start, ME), KIDS).selected) === '' && names(sel.toggleShown(sel.toggleShown(sel.toggleShown(start, ME), KIDS), FAMILY).labels.get(FAMILY) ?? []) === 'yours', 'yours goes to the first calendar only');
    const noYours = sel.selectionFrom({ selectedCalendars: new Set([KIDS]), calendarLabels: new Map([[KIDS, set('kids')]]), spouseInfo: null, calendarRules: new Map(), globalRules: [] });
    assert(names(sel.toggleShown(noYours, FAMILY).labels.get(FAMILY) ?? []) === 'yours', 'a selection with no yours: the new calendar is yours');
    assert(show(sel.withNotes(start, [' a ', '', 'c', 'd']).globalRules) === show(['a', '', 'c']) && show(sel.withNotes(start, ['a']).globalRules) === show(['a', '', '']) && sel.noteCount(sel.withNotes(start, ['a', ' ', 'c'])) === 2, 'the notes');
  });

  await check('S20 the status line is a bar fixed to the bottom of the screen (the kit\'s sticky save-bar container with no button of its own): a tap anywhere on the list shows its result there; it is not on the page, is absent at rest, keeps role status for Saved and the new-events note and role alert for a refusal (with See plans for the limit), and each save replaces it', async () => {
    const { FORM_CSS } = await import('../components/app-ui/form-kit');
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(FORM_CSS)?.[1] ?? '';
    assert(/position:\s*sticky/.test(rule('.ch-save-bar-sticky')) && /inset-block-end:\s*0/.test(rule('.ch-save-bar-sticky')), 'the kit\'s sticky bar is not sticky to the bottom');
    const barOf = (m: Mounted) => elements(m.container).filter((e) => classes(e).includes('ch-save-bar') && classes(e).includes('ch-save-bar-sticky') && !isInside(e, sheetOf(m)));
    for (const locale of LOCALES) {
      resetWorld();
      const o = await open(locale, {}, { ...TELEGRAM, scheme: 'dark' });
      try {
        assert(barOf(o.m).length === 0, `${locale}: a bar at rest`);
        await tapAndSettle(o, switchOf(o.m, NAMES[locale].family));
        const [bar] = barOf(o.m);
        assert(barOf(o.m).length === 1 && bar, `${locale}: ${barOf(o.m).length} bars after a save`);
        const root = elements(o.m.container).find((e) => classes(e).includes('ch-app')) as FakeElement;
        const pageEl = elements(o.m.container).find((e) => classes(e).includes('ch-form-page')) as FakeElement;
        assert(bar.parentNode === root && root.childNodes.indexOf(bar) > root.childNodes.indexOf(pageEl) && !isInside(bar, pageEl), `${locale}: the bar is not the screen's last child, after the page`);
        assert(show(statusText(o.m)) === show([ui(locale, 'saved')]) && isInside(notices(o.m)[0], bar) && notices(o.m)[0].getAttribute('role') === 'status' && buttonsOf(bar).length === 0, `${locale}: the bar: ${flat(bar)} ${show(buttonsOf(bar).map(flat))}`);
        // A refusal replaces it, as an alert
        srv.save = () => json({ error: 'x' }, 500);
        await tapAndSettle(o, switchOf(o.m, NAMES[locale].noa));
        assert(barOf(o.m).length === 1 && show(statusText(o.m)) === show([word(locale, 'errors.retry')]) && notices(o.m)[0].getAttribute('role') === 'alert' && isInside(notices(o.m)[0], barOf(o.m)[0]), `${locale}: the refusal's bar: ${show(statusText(o.m))}`);
        // The limit keeps its way on in the bar
        srv.save = () => json({ error: 'calendar_limit_reached', limit: 3 }, 403);
        await tapAndSettle(o, switchOf(o.m, NAMES[locale].noa));
        const plans = mustButton(barOf(o.m)[0], calendarsPageText(locale, 'seePlans'));
        o.m.click(plans);
        assert(show(pushes) === show([`/${locale}/subscription?user_id=5550001`]), `${locale}: See plans in the bar: ${show(pushes)}`);
        // A save made in a sheet says its result in the bar too, once the sheet is closed
        srv.save = () => json({ success: true });
        await openRow(o, NAMES[locale].me);
        o.m.click(saveButton(o.m));
        await settle();
        assert(!sheetOf(o.m) && barOf(o.m).length === 1 && show(statusText(o.m)) === show([ui(locale, 'saved')]), `${locale}: after a sheet's save: ${show(statusText(o.m))}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S21 a refusal in a sheet says what it is in the sheet\'s own words: the generic one is "Couldn\'t save. Try again." (nothing was applied there, so neither "the change was undone" nor "the calendar"; the notes sheet says it too), a selection with no calendar of yours says so (the only calendar of yours moved to another category), and the typed values stay; the instant-save rollback keeps "so the change was undone"', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const o = await open(locale, {}, TELEGRAM);
      try {
        await openRow(o, NAMES[locale].me);
        const sheet = () => sheetOf(o.m) as FakeElement;
        // Dana is the only calendar of yours: moving her to Kids leaves the selection with none
        o.m.click(radioNamed(groupIn(sheet(), word(locale, 'category')), cat(locale, 'kids')));
        o.m.input(fieldByLabel(sheet(), word(locale, 'note')), 'Typed');
        srv.save = () => json({ error: 'At least one calendar must be marked as "yours"', code: 'no_yours' }, 400);
        o.m.click(saveButton(o.m));
        await settle();
        assert(sheetOf(o.m) && show(byRole(sheet(), 'alert').map(flat)) === show([word(locale, 'errors.noYours')]), `${locale}: no_yours in the sheet: ${show(byRole(sheetOf(o.m) as FakeNode, 'alert').map(flat))}`);
        assert(valueOf(fieldByLabel(sheet(), word(locale, 'note'))) === 'Typed' && show(checkedOf(groupIn(sheet(), word(locale, 'category'))).map((r) => r.getAttribute('data-value'))) === show(['kids']), `${locale}: the typed values went`);
        srv.save = () => json({ error: 'x' }, 500);
        o.m.click(saveButton(o.m));
        await settle();
        assert(show(byRole(sheet(), 'alert').map(flat)) === show([word(locale, 'errors.retry')]), `${locale}: the generic refusal in a sheet: ${show(byRole(sheet(), 'alert').map(flat))}`);
        assert(!flat(sheet()).includes(word(locale, 'errors.save')) && !flat(sheet()).includes(calendarsPageText(locale, 'errors.save')), `${locale}: "the change was undone" (or "the calendar") in a sheet`);
        // A refusal (4xx) with no word of its own says the same there
        srv.save = () => json({ error: 'Bad request' }, 400);
        o.m.click(saveButton(o.m));
        await settle();
        assert(show(byRole(sheet(), 'alert').map(flat)) === show([word(locale, 'errors.retry')]), `${locale}: a plain refusal in a sheet: ${show(byRole(sheet(), 'alert').map(flat))}`);
        // A refusal in the notes sheet says the same, not "the calendar"
        o.m.click(cancelButton(o.m));
        o.m.click(notesRow(o.m));
        await settle();
        o.m.click(saveButton(o.m));
        await settle();
        assert(show(byRole(sheet(), 'alert').map(flat)) === show([word(locale, 'errors.retry')]), `${locale}: the notes sheet's refusal: ${show(byRole(sheet(), 'alert').map(flat))}`);
        o.m.click(cancelButton(o.m));
        // The instant-save rollback after a refusal (4xx: the server wrote nothing) keeps "so the change was undone"; after a 5xx or no answer (it may have written) it only says to try again
        srv.save = () => json({ error: 'Bad request' }, 400);
        await tapAndSettle(o, switchOf(o.m, NAMES[locale].family));
        assert(show(statusText(o.m)) === show([word(locale, 'errors.save')]) && !isOn(switchOf(o.m, NAMES[locale].family)), `${locale}: the rollback's words after a refusal: ${show(statusText(o.m))}`);
        srv.save = () => json({ error: 'x' }, 500);
        await tapAndSettle(o, switchOf(o.m, NAMES[locale].family));
        assert(show(statusText(o.m)) === show([word(locale, 'errors.retry')]) && !isOn(switchOf(o.m, NAMES[locale].family)), `${locale}: the rollback's words after a 5xx: ${show(statusText(o.m))}`);
      } finally {
        close(o);
      }
    }
  });

  await check('R2 validateCalendarAssignments returns a stable code beside each message (multiple_primary, primary_not_yours, none_selected, multiple_categories, no_yours), the messages are as they were, and the route answers { error: <the first message>, code: <its code> }', async () => {
    const { validateCalendarAssignments } = await import('../src/utils/calendar-helpers');
    const a = (calendarId: string, labels: string[]) => ({ calendarId, labels, name: calendarId, color: '#4285f4' }) as never;
    const cases: [string, ReturnType<typeof a>[], string[], string[]][] = [
      ['two primaries', [a('x', ['primary', 'yours']), a('y', ['primary', 'yours'])], ['multiple_primary'], ['Only one calendar can be primary']],
      ['primary not yours', [a('x', ['primary']), a('y', ['yours'])], ['primary_not_yours'], ['Primary calendar must be in "yours" category']],
      ['nothing selected', [], ['none_selected'], ['At least one calendar must be selected']],
      ['two categories', [a('x', ['yours']), a('y', ['kids', 'spouse'])], ['multiple_categories'], ['Calendar "y" cannot be in multiple categories (except primary+yours)']],
      ['no yours', [a('x', ['kids'])], ['no_yours'], ['At least one calendar must be marked as "yours"']],
      ['a valid one', [a('x', ['primary', 'yours']), a('y', ['kids'])], [], []],
    ];
    for (const [name, input, codes, errors] of cases) {
      const got = validateCalendarAssignments(input);
      assert(show(got.codes) === show(codes) && show(got.errors) === show(errors) && got.valid === (errors.length === 0), `${name}: ${show(got)}`);
    }
    const route = noComments(source('app/api/select-calendars/route.ts'));
    assert(/\{ error: validation\.errors\[0\], code: validation\.codes\[0\] \}/.test(route), 'the route does not answer with the first message and its code');
  });

  await check('S22 in a browser (no Telegram) a save refused because the sign-in ended (401) is undone and says "Your sign-in has ended. Sign in again." on the status bar, with Sign in, which signs this browser out and opens /signin in the page\'s language (inside Telegram it still says to open the page again: S6)', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      srv.save = () => json({ error: 'Unauthorized' }, 401);
      const o = await open(locale);
      const went: string[] = [];
      fakeWindow.location = { hash: '', assign: (u: string) => void went.push(u), reload: () => undefined };
      try {
        await tapAndSettle(o, switchOf(o.m, NAMES[locale].family));
        // The alert holds the words and, under them, the Sign in button: the words are the notice's text element
        const said = byRole(o.m.container, 'alert').flatMap((a) => elements(a).filter((e) => classes(e).includes('ch-notice-text')).map(flat));
        assert(show(said) === show([calendarsPageText(locale, 'errors.reopenBrowser')]), `${locale}: ${show(alertsOf(o.m))}`);
        const signIn = buttonsOf(o.m.container).find((b) => classes(b).includes('ch-notice-action'));
        assert(signIn && flat(signIn) === messageAt(locale, 'pageGate.signIn'), `${locale}: Sign in ${signIn && flat(signIn)}`);
        await tapAndSettle(o, signIn);
        assert(calls.filter((c) => c.method === 'POST' && c.path === '/api/auth/signout').length === 1 && show(went) === show([locale === 'en' ? '/signin' : `/${locale}/signin`]), `${locale}: ${show(went)}`);
      } finally {
        close(o);
      }
    }
  });

  // ---- Calendars Google no longer lists (the home's "N calendars aren't available · Choose again" lands here) ----

  // The unlisted calendars' Remove rows: the danger rows but Disconnect Google's (the Google account section, S30)
  const removeButtons = (m: Mounted) => buttonsOf(m.container).filter((b) => classes(b).includes('ch-danger-row') && !LOCALES.some((l) => flat(b) === gdw(l, 'button')));
  const goneSelection = (o: Row = {}) => selectionOf({
    selectedCalendars: new Set([ME, GONE, KIDS]),
    calendarLabels: new Map([[ME, new Set(['yours'])], [GONE, new Set(['primary', 'yours'])], [KIDS, new Set(['kids'])]]),
    calendarRules: new Map([[GONE, 'Old timetable'], [KIDS, 'Early dismissal']]),
    ...o,
  });

  await check('S23 a chosen calendar Google no longer lists (en, he RTL, ru; light and dark): "Not in your Google list" is the first section, above "Show in FamCal", with the calendar\'s saved name in a <bdi> and its saved colour, a Remove row in the danger colour described by that name, and the hint (deleted, unshared or removed from the list; removing changes nothing in Google); it is no switch and no Chosen row; a calendar Google lists that is handed over as unlisted is not drawn twice; none of it shows when nothing is unlisted', async () => {
    for (const locale of LOCALES) {
      for (const scheme of ['light', 'dark'] as const) {
        resetWorld();
        const o = await open(locale, { unlistedCalendars: [unlistedFor(locale)], currentSelections: goneSelection() }, { ...TELEGRAM, scheme });
        try {
          const n = NAMES[locale];
          assert(show(sectionLabels(o.m)) === show([word(locale, 'unavailable.title'), word(locale, 'show'), word(locale, 'notes'), ...accountLabels(locale)]), `${locale} ${scheme}: sections ${show(sectionLabels(o.m))}`);
          const removes = removeButtons(o.m);
          assert(removes.length === 1 && flat(removes[0]) === word(locale, 'unavailable.remove'), `${locale} ${scheme}: Remove ${show(removes.map(flat))}`);
          const describedBy = removes[0].getAttribute('aria-describedby');
          const named = elements(o.m.container).find((e) => describedBy && e.getAttribute('id') === describedBy);
          assert(named && flat(named) === GONE_NAMES[locale] && elements(named).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto'), `${locale} ${scheme}: Remove is not described by the calendar's name (${describedBy})`);
          assert(dotColour(named) === GONE_COLOUR, `${locale} ${scheme}: the dot ${dotColour(named)}`);
          assert(!removes[0].hasAttribute('disabled') && !removes[0].hasAttribute('aria-busy'), `${locale} ${scheme}: Remove is off at rest`);
          assert(elements(o.m.container).some((e) => e.localName === 'p' && classes(e).includes('ch-form-fixed') && flat(e) === word(locale, 'unavailable.hint')), `${locale} ${scheme}: the hint`);
          assert(pageSwitches(o.m).length === 4 && !pageSwitches(o.m).some((s) => switchName(o.m, s).startsWith(GONE_NAMES[locale])), `${locale} ${scheme}: a switch for the unlisted calendar`);
          assert(listRows(o.m).length === 2 && flat(listRows(o.m)[0]).startsWith(n.me) && flat(listRows(o.m)[1]).startsWith(n.kids), `${locale} ${scheme}: Chosen ${show(listRows(o.m).map(flat))}`);
          const text = page(o.m);
          assert(!text.includes('old@group') && !/\b(?:selectCalendars)\.[a-zA-Z]/.test(text), `${locale} ${scheme}: an id or a raw key in ${text}`);
          if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(/Google|FamCal/g, '')), `${locale} ${scheme}: Latin letters in ${text}`);
        } finally {
          close(o);
        }
      }
    }
    // Handed over as unlisted but in Google's list after all: drawn once, as its switch
    resetWorld();
    const twice = await open('en', { unlistedCalendars: [{ id: KIDS, name: 'Kids and school', backgroundColor: '#F4511E' }], currentSelections: selectionOf() }, TELEGRAM);
    try {
      assert(removeButtons(twice.m).length === 0 && !sectionLabels(twice.m).includes(word('en', 'unavailable.title')), `a listed calendar drawn as unlisted: ${show(sectionLabels(twice.m))}`);
    } finally {
      close(twice);
    }
    // Nothing unlisted, or an unlisted calendar no longer chosen: no section
    for (const o of [{}, { unlistedCalendars: [unlistedFor('en')] }]) {
      resetWorld();
      const none = await open('en', o, TELEGRAM);
      try {
        assert(removeButtons(none.m).length === 0 && show(sectionLabels(none.m)) === show([word('en', 'show'), word('en', 'notes'), ...accountLabels('en')]), `${show(Object.keys(o))}: ${show(sectionLabels(none.m))}`);
      } finally {
        close(none);
      }
    }
  });

  await check('S24 Remove saves at once, as a switch does: the whole selection without that calendar (its labels and its rule gone too, the rest exactly as before), the credential in the header; the section goes and "Saved" shows; a switch save before it keeps the unlisted calendar with its labels, rule, saved name and saved colour', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const o = await open(locale, { unlistedCalendars: [unlistedFor(locale)], currentSelections: goneSelection() }, TELEGRAM);
      try {
        const n = NAMES[locale];
        await tapAndSettle(o, switchOf(o.m, n.family));
        const kept = bodyOf().calendarAssignments.find((a) => a.calendarId === GONE);
        assert(canon(kept) === canon({ calendarId: GONE, labels: ['primary', 'yours'], name: GONE_NAMES[locale], color: GONE_COLOUR, rules: ['Old timetable'] }), `${locale}: the unlisted calendar under a switch save: ${show(kept)}`);
        await tapAndSettle(o, removeButtons(o.m)[0]);
        assert(saves().length === 2, `${locale}: ${saves().length} saves`);
        assert(saves()[1].headers['x-telegram-init-data'] === (o.tg as Row).initData && !('initData' in (saves()[1].body as Row)), `${locale}: the credential`);
        const want = {
          calendarAssignments: [
            { calendarId: ME, labels: ['yours'], name: n.me, color: '#039BE5' },
            { calendarId: KIDS, labels: ['kids'], name: n.kids, color: '#F4511E', rules: ['Early dismissal'] },
            { calendarId: FAMILY, labels: [], name: n.family, color: '#7986CB' },
          ],
          globalRules: ['Be brief'],
        };
        assert(canon(bodyOf()) === canon(want), `${locale}: the body after Remove:\n${canon(bodyOf())}\nwant\n${canon(want)}`);
        assert(removeButtons(o.m).length === 0 && !sectionLabels(o.m).includes(word(locale, 'unavailable.title')) && !page(o.m).includes(GONE_NAMES[locale]), `${locale}: the section stays: ${show(sectionLabels(o.m))}`);
        assert(show(statusText(o.m)) === show([ui(locale, 'saved')]) && alertsOf(o.m).length === 0, `${locale}: the status ${show(statusText(o.m))}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S25 Remove while it runs and when it is refused: the Remove row shows the spinner and aria-busy and every switch, row and the notes row are off (a tap sends nothing); a refusal (the server\'s no_yours, a 500) puts the calendar back with its labels, says why and is logged, and the next save sends it again as it was', async () => {
    const cases: [string, () => Response, string][] = [
      ['400 no_yours', () => json({ error: 'At least one calendar must be marked as "yours"', code: 'no_yours' }, 400), word('en', 'errors.noYours')],
      ['400 none_selected', () => json({ error: 'At least one calendar must be selected', code: 'none_selected' }, 400), word('en', 'errors.noneSelected')],
      ['500', () => json({ error: 'Failed to update calendars' }, 500), word('en', 'errors.retry')],
    ];
    for (const [name, reply, text] of cases) {
      resetWorld();
      const o = await open('en', { unlistedCalendars: [unlistedFor('en')], currentSelections: goneSelection() }, TELEGRAM);
      try {
        const release = holdNext();
        o.m.click(removeButtons(o.m)[0]);
        await settle();
        const running = removeButtons(o.m)[0];
        assert(running && running.getAttribute('aria-busy') === 'true' && elements(running).some((e) => classes(e).includes('ch-form-spinner')), `${name}: Remove does not show that it runs`);
        assert(pageSwitches(o.m).every((s) => s.hasAttribute('disabled')) && listRows(o.m).every((r) => r.hasAttribute('disabled')) && notesRow(o.m).hasAttribute('disabled'), `${name}: a control is on while Remove runs`);
        o.m.click(switchOf(o.m, 'Family'));
        o.m.click(running);
        await settle();
        assert(saves().length === 1, `${name}: a tap while Remove runs sent ${saves().length - 1} more`);
        await release(reply());
        await settle();
        assert(removeButtons(o.m).length === 1 && page(o.m).includes(GONE_NAMES.en), `${name}: the calendar did not come back`);
        assert(show(alertsOf(o.m)) === show([text]), `${name}: alerts ${show(alertsOf(o.m))}`);
        assert(appLogs.some((l) => l.startsWith('[select-calendars]')), `${name}: not logged`);
        srv.save = () => json({ success: true });
        await tapAndSettle(o, switchOf(o.m, 'Family'));
        const back = bodyOf().calendarAssignments.find((a) => a.calendarId === GONE);
        assert(canon(back) === canon({ calendarId: GONE, labels: ['primary', 'yours'], name: GONE_NAMES.en, color: GONE_COLOUR, rules: ['Old timetable'] }), `${name}: the next save: ${show(back)}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S26 an unlisted calendar never counts as "yours" for a calendar turned on: with the only "yours" unlisted, the calendar turned on is yours, so Remove then passes the server\'s rule; the same in the pure rule (toggleShown\'s unlisted set)', async () => {
    resetWorld();
    const o = await open('en', {
      unlistedCalendars: [unlistedFor('en')],
      currentSelections: selectionOf({ selectedCalendars: new Set([GONE]), calendarLabels: new Map([[GONE, new Set(['primary', 'yours'])]]), calendarRules: new Map() }),
    }, TELEGRAM);
    try {
      await tapAndSettle(o, switchOf(o.m, 'Family'));
      assert(show(bodyOf().calendarAssignments.find((a) => a.calendarId === FAMILY)?.labels) === show(['yours']), `the calendar turned on: ${show(bodyOf().calendarAssignments)}`);
      await tapAndSettle(o, removeButtons(o.m)[0]);
      assert(canon(bodyOf()) === canon({ calendarAssignments: [{ calendarId: FAMILY, labels: ['yours'], name: 'Family', color: '#7986CB' }], globalRules: ['Be brief'] }), `after Remove: ${canon(bodyOf())}`);
    } finally {
      close(o);
    }
    const sel = await import('../app/[locale]/(app)/select-calendars/selection');
    const start = sel.selectionFrom({ selectedCalendars: new Set([GONE]), calendarLabels: new Map([[GONE, new Set(['yours']) as Set<never>]]), spouseInfo: null, calendarRules: new Map(), globalRules: [] });
    assert(show([...(sel.toggleShown(start, FAMILY, new Set([GONE])).labels.get(FAMILY) ?? [])]) === show(['yours']), 'an unlisted yours counted');
    assert(show([...(sel.toggleShown(start, FAMILY).labels.get(FAMILY) ?? [])]) === show([]), 'with no unlisted set, a chosen yours still counts');
    assert(sel.toggleShown(start, GONE, new Set([GONE])).selected.size === 0 && !sel.toggleShown(start, GONE, new Set([GONE])).labels.has(GONE), 'turning the unlisted calendar off');
  });

  await check('S27 an account whose Google lists no calendar at all, with a chosen calendar it no longer has: "Not in your Google list" and Remove show above the empty state', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const o = await open(locale, { availableCalendars: [], unlistedCalendars: [unlistedFor(locale)], currentSelections: selectionOf({ selectedCalendars: new Set([GONE]), calendarLabels: new Map([[GONE, new Set(['yours'])]]), calendarRules: new Map() }) }, TELEGRAM);
      try {
        const text = page(o.m);
        assert(show(sectionLabels(o.m)) === show([word(locale, 'unavailable.title'), ...accountLabels(locale)]) && removeButtons(o.m).length === 1, `${locale}: ${show(sectionLabels(o.m))}`);
        assert(text.includes(word(locale, 'empty.title')) && text.indexOf(word(locale, 'unavailable.title')) < text.indexOf(word(locale, 'empty.title')), `${locale}: the order in ${text}`);
      } finally {
        close(o);
      }
    }
  });

  await check('S28 unlistedChoices (selection.ts), what the page data hands over: the chosen calendars Google\'s list does not have, once each, in the order chosen, with the saved name (the id when there is none) and the saved colour (#4285f4 when there is none); a listed one and an entry with no id are left out; the page data passes it as unlistedCalendars and logs only a count', async () => {
    const sel = await import('../app/[locale]/(app)/select-calendars/selection');
    const listed = availableFor('en') as never[];
    const a = (calendarId: string, extra: Row = {}) => ({ calendarId, labels: [], name: '', color: '', ...extra }) as never;
    const got = sel.unlistedChoices([a(ME, { name: 'Dana' }), a(GONE, { name: 'Old', color: GONE_COLOUR }), a('x@group.calendar.google.com'), a(GONE, { name: 'Again' }), a('')], listed);
    assert(canon(got) === canon([{ id: GONE, name: 'Old', backgroundColor: GONE_COLOUR }, { id: 'x@group.calendar.google.com', name: 'x@group.calendar.google.com', backgroundColor: '#4285f4' }]), `unlistedChoices: ${canon(got)}`);
    assert(sel.unlistedChoices([], listed).length === 0 && sel.unlistedChoices([a(ME)], listed).length === 0, 'unlistedChoices with nothing unlisted');
    const data = noComments(source('src/lib/page-data.ts'));
    assert(/unlistedChoices\(chosen, availableCalendars\)/.test(data) && /unlistedCalendars[,\s}]/.test(data), 'the page data does not hand over unlistedChoices(chosen, availableCalendars) as unlistedCalendars');
    const logged = data.match(/console\.\w+\(`\[select-calendars\][^`]*`\)/g) ?? [];
    assert(logged.length >= 1 && logged.every((l) => !/name|calendarId|\.id\b(?!\})/.test(l.replace(/user\.id/g, ''))), `the page data's log line: ${show(logged)}`);
  });

  await check('S29 "Saved" and the new-events note go by themselves after NOTE_MS, like a toast (the bar goes with them); a refusal stays until the next save (it may carry See plans or Sign in); a new save starts the wait again and clears the old one', async () => {
    const { NOTE_MS } = (await import('../app/[locale]/(app)/select-calendars/SelectCalendarsClient')) as unknown as { NOTE_MS: number };
    assert(typeof NOTE_MS === 'number' && NOTE_MS >= 2000 && NOTE_MS <= 6000, `NOTE_MS ${NOTE_MS}`);
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const waiting = new Map<unknown, () => void>();
    let nextTimer = 0;
    (globalThis as Row).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== NOTE_MS) return realSet(fn, ms, ...rest);
      const id = { note: ++nextTimer };
      waiting.set(id, fn);
      return id;
    };
    (globalThis as Row).clearTimeout = (id: unknown) => (waiting.has(id) ? void waiting.delete(id) : realClear(id as never));
    const elapse = () => act(async () => {
      for (const [id, fn] of [...waiting]) {
        waiting.delete(id);
        fn();
      }
    });
    /** The waits pending (a call, so a narrowing by an earlier assert does not stick). */
    const waits = () => waiting.size;
    const bars = (m: Mounted) => elements(m.container).filter((e) => classes(e).includes('ch-save-bar-sticky') && !isInside(e, sheetOf(m)));
    try {
      for (const locale of LOCALES) {
        resetWorld();
        waiting.clear();
        const n = NAMES[locale];
        const o = await open(locale, { famcalPrimaryName: 'Home', currentSelections: selectionOf({ selectedCalendars: new Set([ME, FAMILY]), calendarLabels: new Map([[ME, new Set(['yours'])], [FAMILY, new Set(['yours'])]]) }) }, TELEGRAM);
        try {
          // Saved, then gone
          await tapAndSettle(o, switchOf(o.m, n.kids));
          assert(show(statusText(o.m)) === show([ui(locale, 'saved')]) && waits() === 1, `${locale}: Saved ${show(statusText(o.m))}, ${waits()} waits`);
          await elapse();
          assert(statusText(o.m).length === 0 && bars(o.m).length === 0, `${locale}: Saved stayed: ${show(statusText(o.m))}`);
          // A second save before the first has gone: one wait, the newest
          await tapAndSettle(o, switchOf(o.m, n.noa));
          await tapAndSettle(o, switchOf(o.m, n.noa));
          assert(waits() === 1 && show(statusText(o.m)) === show([ui(locale, 'saved')]), `${locale}: ${waits()} waits after two saves`);
          await elapse();
          assert(statusText(o.m).length === 0, `${locale}: the second Saved stayed`);
          // A refusal stays, with no wait
          srv.save = () => json({ error: 'calendar_limit_reached', limit: 3 }, 403);
          await tapAndSettle(o, switchOf(o.m, n.noa));
          assert(waits() === 0 && alertsOf(o.m).length === 1, `${locale}: the refusal: ${waits()} waits, ${show(alertsOf(o.m))}`);
          await elapse();
          assert(alertsOf(o.m).length === 1 && bars(o.m).length === 1, `${locale}: the refusal went by itself`);
          // The new-events note goes too
          srv.save = () => json({ success: true });
          await openRow(o, n.family);
          o.m.click(switchesOf(sheetOf(o.m) as FakeElement)[0]);
          o.m.click(saveButton(o.m));
          await settle();
          assert(statusText(o.m).length === 1 && !statusText(o.m)[0].startsWith(ui(locale, 'saved')) && alertsOf(o.m).length === 0 && waits() === 1, `${locale}: the note ${show(statusText(o.m))}`);
          await elapse();
          assert(statusText(o.m).length === 0 && bars(o.m).length === 0, `${locale}: the note stayed`);
        } finally {
          close(o);
        }
      }
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  await check('S30 the Google account section, last: Reconnect Google is a full page load of /refresh-token?user_id=<id> (window.location.assign, never a client route; off while a save runs); Disconnect Google (moved here from Settings) opens its sheet, which Back closes first, with a swipe down held off while it is open; the request is POST /api/google-disconnect; once disconnected, the result\'s Done or Back goes to /<locale>/calendars?user_id=<id>', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const o = await open(locale, {}, TELEGRAM);
      try {
        o.m.click(mustButton(o.m.container, word(locale, 'account.reconnect')));
        await settle();
        assert(show(assigned) === show(['/refresh-token?user_id=5550001']) && pushes.length === 0 && calls.length === 0, `${locale}: Reconnect ${show({ assigned, pushes, calls: calls.length })}`);
        // Off while a save runs
        assigned.length = 0;
        const hold = holdNext();
        o.m.click(switchOf(o.m, NAMES[locale].family));
        await settle();
        const reconnect = mustButton(o.m.container, word(locale, 'account.reconnect'));
        assert(reconnect.hasAttribute('disabled'), `${locale}: Reconnect is on while a save runs`);
        o.m.click(reconnect);
        assert(assigned.length === 0, `${locale}: Reconnect went while a save ran`);
        await hold(json({ success: true }));
        await settle();
        // Disconnect: its sheet, which Back closes without leaving the page
        const swipes = () => o.tgCalls.filter((c) => /VerticalSwipes/.test(c)).at(-1);
        o.m.click(mustButton(o.m.container, gdw(locale, 'button')));
        await settle();
        assert(sheetOf(o.m) && flat(sheetOf(o.m) as FakeNode).includes(gdw(locale, 'confirmTitle')) && swipes() === 'disableVerticalSwipes()', `${locale}: the disconnect sheet, swipes ${swipes()}`);
        await back(o);
        assert(!sheetOf(o.m) && pushes.length === 0 && swipes() === 'enableVerticalSwipes()', `${locale}: Back with the disconnect sheet open: ${show(pushes)}, swipes ${swipes()}`);
        // Confirm: the request, the result, and Done goes to Calendars
        o.m.click(mustButton(o.m.container, gdw(locale, 'button')));
        await settle();
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, gdw(locale, 'confirm')));
        await settle();
        const sent = calls.filter((c) => c.path === '/api/google-disconnect');
        assert(sent.length === 1 && sent[0].method === 'POST' && sent[0].query.get('user_id') === '5550001' && canon(sent[0].body) === canon({ deleteCopies: true }) && sent[0].headers['x-telegram-init-data'] === (o.tg as Row).initData, `${locale}: the disconnect request ${show(sent.map((c) => [c.query.toString(), c.body]))}`);
        assert(flat(sheetOf(o.m) as FakeNode).includes(gdw(locale, 'doneTitle')) && pushes.length === 0, `${locale}: the result`);
        o.m.click(mustButton(sheetOf(o.m) as FakeNode, gdw(locale, 'close')));
        await settle();
        assert(show(pushes) === show([`/${locale}/calendars?user_id=5550001`]), `${locale}: Done after a disconnect: ${show(pushes)}`);
      } finally {
        close(o);
      }
    }
    // Back on the result does the same
    resetWorld();
    const o = await open('en', {}, TELEGRAM);
    try {
      o.m.click(mustButton(o.m.container, gdw('en', 'button')));
      await settle();
      o.m.click(mustButton(sheetOf(o.m) as FakeNode, gdw('en', 'confirm')));
      await settle();
      assert(flat(sheetOf(o.m) as FakeNode).includes(gdw('en', 'doneTitle')), 'no result');
      await back(o);
      await settle();
      assert(show(pushes) === show(['/en/calendars?user_id=5550001']), `Back on the result: ${show(pushes)}`);
    } finally {
      close(o);
    }
    // A tap on a shown calendar's text opens its sheet and saves nothing
    resetWorld();
    const t = await open('en', {}, TELEGRAM);
    try {
      await openRow(t, 'Dana');
      assert(saves().length === 0 && flat(sheetOf(t.m) as FakeNode).includes('Dana'), 'the text button saved, or opened another sheet');
    } finally {
      close(t);
    }
  });

  await check('S31 the dead-token card (page-data\'s googleReconnect notice), en, he (RTL), ru: the screen\'s title and its own Back, a card that says the connection stopped working, Reconnect Google as a link to /refresh-token?user_id=<id> (a full page load), and Disconnect Google under it; never the generic retry card; Back closes the disconnect sheet first, else goes to Calendars, and so does the result once disconnected; select-calendars/page.tsx hands it over as the googleReconnect notice', async () => {
    const Notice = (await import('../app/[locale]/(app)/select-calendars/GoogleReconnectNotice')).default as unknown as (props: Props) => ReactElement;
    const noticeTree = (locale: Locale) =>
      createElement(AppRouterContext.Provider, { value: router }, createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Notice, { userId: 5550001, locale })));
    for (const locale of LOCALES) {
      resetWorld();
      const html = renderToString(noticeTree(locale));
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      assert(html.startsWith(`<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the root ${html.slice(0, 140)}`);
      installWindow();
      const tgCalls: string[] = [];
      const tg = fakeTelegram(tgCalls, '7.7');
      fakeWindow.Telegram = { WebApp: tg };
      fakeWindow.location = { hash: '', assign: (href: string) => void assigned.push(href), reload: () => undefined };
      const m = mount(noticeTree(locale));
      await settle();
      try {
        const text = page(m);
        assert(flat(elements(m.container).find((e) => e.localName === 'h1') as FakeNode) === word(locale, 'title'), `${locale}: the title`);
        const card = elements(m.container).find((e) => classes(e).includes('ch-home-card'));
        assert(card && flat(card).includes(word(locale, 'reconnectCard.title')) && flat(card).includes(word(locale, 'reconnectCard.body')), `${locale}: the card ${card && flat(card)}`);
        const link = elements(card as FakeNode).find((e) => e.localName === 'a');
        assert(link && link.getAttribute('href') === '/refresh-token?user_id=5550001' && flat(link) === word(locale, 'account.reconnect') && classes(link).includes('ch-btn-primary'), `${locale}: the Reconnect link ${link && [link.getAttribute('href'), flat(link)]}`);
        assert(text.includes(gdw(locale, 'sectionTitle')) && mustButton(m.container, gdw(locale, 'button')), `${locale}: no Disconnect section`);
        assert(!text.includes(messageAt(locale, 'pageGate.errorTitle')) && !text.includes(messageAt(locale, 'pageGate.retry')), `${locale}: the generic retry card`);
        if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(/Google|FamCal/g, '')), `${locale}: Latin letters in ${text}`);
        // Back: the disconnect sheet first, else Calendars
        const backOf = () => act(() => void (tg as Row as { backHandlers: (() => void)[] }).backHandlers[0]());
        m.click(mustButton(m.container, gdw(locale, 'button')));
        await settle();
        assert(dialogs(m).length === 1, `${locale}: no disconnect sheet`);
        await backOf();
        assert(dialogs(m).length === 0 && pushes.length === 0, `${locale}: Back with the sheet open ${show(pushes)}`);
        await backOf();
        assert(show(pushes) === show([`/${locale}/calendars?user_id=5550001`]), `${locale}: Back ${show(pushes)}`);
        // Disconnected: the result's Done goes to Calendars too
        pushes.length = 0;
        m.click(mustButton(m.container, gdw(locale, 'button')));
        await settle();
        m.click(mustButton(dialogs(m)[0], gdw(locale, 'confirm')));
        await settle();
        m.click(mustButton(dialogs(m)[0], gdw(locale, 'close')));
        await settle();
        assert(calls.filter((c) => c.path === '/api/google-disconnect').length === 1 && show(pushes) === show([`/${locale}/calendars?user_id=5550001`]), `${locale}: after the disconnect ${show(pushes)}`);
      } finally {
        m.unmount();
        fakeWindow.Telegram = undefined;
      }
    }
    const pageCode = noComments(source('app/[locale]/(app)/select-calendars/page.tsx'));
    assert(/googleReconnect:\s*<GoogleReconnectNotice userId=\{userId\} locale=\{locale\} \/>/.test(pageCode), 'select-calendars/page.tsx does not hand over the googleReconnect notice');
    const gateCode = source('src/lib/page-data.ts');
    assert(/export type PageNotice = 'noGoogleToken' \| 'googleReconnect' \| 'error';/.test(gateCode), 'PageNotice does not name googleReconnect');
  });

  await check('S18 window.confirm was never called on any path above, and React logged no warning (keys, nesting, attributes, act)', () => {
    assert(confirmCalls === 0, `window.confirm was called ${confirmCalls} time(s)`);
    assert(reactWarnings.length === 0, `React warned: ${show(reactWarnings.slice(0, 3))}`);
  });

  await check('R1 the route reads the credential from the X-Telegram-Init-Data header, else from the body\'s initData (as every route does), through requestInitData', () => {
    const route = noComments(source('app/api/select-calendars/route.ts'));
    assert(/requestInitData\(request, body\)/.test(route) && /verifyUserAuth\(request, userId, requestInitData\(request, body\),/.test(route), 'the route does not read the credential through requestInitData(request, body)');
    assert(!/const \{ calendarAssignments, globalRules, initData \} = body/.test(route), 'the route still reads initData out of the body only');
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
