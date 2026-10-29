// Smoke test for the Select calendars screen in the app's design (plan docs/superpowers/plans/2026-10-29-w4-2-select-calendars.md;
// spec 2026-10-19-screens-and-colours §4, §5; google-connection spec §3): SelectCalendarsClient on AppScreen and the form kit,
// in real React on the small fake DOM, with a fake Telegram.WebApp, a router stub and a fake fetch. No network, no DB.
//
//  - W1 the screen's words in en, he and ru (the same keys, ICU plurals for the notes and the limit);
//  - S1 the screen's source is made of the kit (no styled-jsx, no Tailwind, no purple, no inline copy, initData only in the header);
//  - S2..S19 the screen itself (light and dark, en / he (RTL) / ru): the three sections and the empty state; a switch saves the
//    whole selection at once (the exact body, the credential in the header, the colour from Google); a refused save rolls the
//    switch back and says so; the limit sentence (plurals) and See plans; one request at a time; the primary rules; the
//    "new events will go to" note once; the calendar's sheet and the notes sheet; Back; a browser; no word of the old copy.
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
const srv = { save: (_c: Call): Reply => json({ success: true }) };
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = new URL(String(input), 'https://famcal.test');
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Row) : null;
  const call: Call = { method, path: url.pathname, query: url.searchParams, headers: Object.fromEntries(new Headers(init.headers).entries()), body };
  calls.push(call);
  if (url.pathname === '/api/select-calendars' && method === 'POST') return srv.save(call);
  throw new Error(`an unexpected request: ${method} ${url.pathname}`);
}) as typeof fetch;
const saves = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/select-calendars');
function resetWorld() {
  calls.length = 0;
  pushes.length = 0;
  appLogs.length = 0;
  confirmCalls = 0;
  srv.save = () => json({ success: true });
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

// ---- Mounting the screen ----

type Props = Row;
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
  fakeWindow.location = { hash: '', assign: () => undefined, reload: () => undefined };
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
const switchOf = (m: Mounted, name: string) => {
  const s = pageSwitches(m).find((x) => flat(x).startsWith(name));
  assert(s, `no switch for ${name} in ${show(pageSwitches(m).map(flat))}`);
  return s;
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
    for (const need of ['title', 'intro', 'show', 'chosen', 'chosenHint', 'category', 'noCategory', 'mainIsYours', 'note', 'notePlaceholder', 'noteHint', 'spouse', 'spouseHint', 'spouseName', 'spouseNamePlaceholder', 'spouseEnglishName', 'spouseGender', 'male', 'female', 'notes', 'notesHint', 'notesPlaceholder', 'notesCount', 'newEventsGoTo', 'errors.save', 'errors.limit', 'errors.noneSelected', 'errors.noYours', 'errors.retry', 'mainHowToChange', 'empty.title', 'empty.body']) assert(block('en').has(need), `en: no ${need}`);
    for (const l of LOCALES) assert(!block(l).has('noNote'), `${l}: the unread key noNote is still there`);
    assert(messages.en.selectCalendars.errors.retry === "Couldn't save. Try again." && messages.he.selectCalendars.errors.retry === 'לא הצלחנו לשמור. נסו שוב.' && messages.ru.selectCalendars.errors.retry === 'Не удалось сохранить. Попробуйте ещё раз.', 'the retry sentence');
    assert(messages.en.selectCalendars.mainHowToChange === 'To change the main calendar, turn it on for another one.' && messages.he.selectCalendars.mainHowToChange === 'כדי להחליף את היומן הראשי, מפעילים אותו ביומן אחר.' && messages.ru.selectCalendars.mainHowToChange === 'Чтобы сменить основной календарь, включите этот переключатель у другого календаря.', 'how to change the main calendar');
    assert(messages.en.selectCalendars.errors.noneSelected === 'Keep at least one calendar on. To stop using Google, disconnect it in Settings.' && messages.en.selectCalendars.errors.noYours === 'Keep at least one calendar marked as yours.', 'the English refusals');
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

  await check('W2 the reviewed wording: the Hebrew spouse hint names the spouse (not "them"), the Hebrew empty state says "in the Google account" with no English product line, the Russian note copy is native (lessons end earlier, not "ранний уход"), the Hebrew limit has its singular and dual', () => {
    assert(messages.he.selectCalendars.spouseHint === 'משמשים לכל יומני בן או בת הזוג, כדי שהסיכומים יזכירו את בן או בת הזוג בשם.', messages.he.selectCalendars.spouseHint);
    assert(messages.he.selectCalendars.empty.body === 'אפשר להוסיף יומן בחשבון Google ולפתוח את הדף הזה שוב.', messages.he.selectCalendars.empty.body);
    assert(messages.ru.selectCalendars.notePlaceholder === 'Например: по пятницам уроки заканчиваются раньше' && messages.ru.selectCalendars.notesHint === 'До трёх заметок, которые ИИ учитывает в каждой сводке, например: в какие дни уроки заканчиваются раньше.', `${messages.ru.selectCalendars.notePlaceholder} / ${messages.ru.selectCalendars.notesHint}`);
    assert(messages.he.selectCalendars.errors.limit === 'בתוכנית שלכם יש מקום {limit, plural, one {ליומן אחד} two {לשני יומנים} other {ל־# יומנים}}, של FamCal ושל Google יחד.', messages.he.selectCalendars.errors.limit);
    for (const l of LOCALES) assert(!/ранний уход|early dismissal/i.test(messages[l].selectCalendars.notePlaceholder + messages[l].selectCalendars.notesHint) || l === 'en', `${l}: the calque is back`);
  });

  await check('S1 the screen is made of the kit: no styled-jsx, Tailwind class, hex colour, emoji, :hover, window.confirm or direct useTelegramBackButton; no old Layout/Forms import, no inline Hebrew or Russian; initData only through initDataHeaders (never window.Telegram or the body); the grouped AppScreen owns Back and the form kit\'s style sheet is the only one', () => {
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
    assert(styles.length === 1 && /<style>\{FORM_CSS\}<\/style>/.test(code), 'a style sheet but the form kit\'s');
    assert(/<AppScreen ground="grouped" onBack=\{back\}>/.test(code) && /<ScreenHeader title=\{t\('title'\)\} backLabel=\{ui\('back'\)\} onBack=\{back\} \/>/.test(code), 'the grouped AppScreen and the header with the same back');
    for (const gone of ['components/Layout/TelegramLayout.tsx', 'components/Layout/Header.tsx', 'components/Layout/index.ts', 'components/Forms/CategoryIcon.tsx']) assert(!fs.existsSync(path.join(ROOT, gone)), `${gone} is still there`);
  });

  await check('S2 the screen in en, he (RTL) and ru, light and dark: the grouped root, the title, the intro, "Show in FamCal" with one switch per Google calendar (on for the chosen ones, a dot in Google\'s colour, the name in a <bdi>, the description as its hint), "Chosen calendars" with a row per chosen calendar (category or "No category", primary in the accent tag, a chevron) and the hint, and "Notes for all calendars" with the count; no raw key, no emoji, no Latin letter in he and ru', async () => {
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
          assert(show(sectionLabels(o.m)) === show([word(locale, 'show'), word(locale, 'chosen'), word(locale, 'notes')]), `${locale} ${scheme}: sections ${show(sectionLabels(o.m))}`);
          // The switches
          const switches = pageSwitches(o.m);
          assert(switches.length === 4 && show(switches.map(isOn)) === show([true, false, true, false]), `${locale} ${scheme}: switches ${show(switches.map((s) => [flat(s), isOn(s)]))}`);
          assert(show(switches.map((s) => dotColour(s))) === show(['#039BE5', '#7986CB', '#F4511E', '#0B8043']), `${locale} ${scheme}: dots ${show(switches.map((s) => dotColour(s)))}`);
          assert(switches.every((s, i) => flat(s).startsWith([n.me, n.family, n.kids, n.noa][i])), `${locale} ${scheme}: names`);
          assert(switches.every((s) => elements(s).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto') && elements(s).some((e) => classes(e).includes('ch-switch'))), `${locale} ${scheme}: a switch without its <bdi> name or its track`);
          assert(flat(switches[1]).includes(n.familyDesc) && !flat(switches[0]).includes(n.familyDesc), `${locale} ${scheme}: the description is Family's hint`);
          assert(switches.every((s) => !s.hasAttribute('disabled') && !s.hasAttribute('aria-busy')), `${locale} ${scheme}: a switch is off at rest`);
          // The chosen rows
          const rows = listRows(o.m);
          assert(rows.length === 2 && flat(rows[0]).startsWith(n.me) && flat(rows[1]).startsWith(n.kids), `${locale} ${scheme}: rows ${show(rows.map(flat))}`);
          assert(flat(rows[0]).includes(cat(locale, 'yours')) && show(tagsOf(rows[0])) === show([{ text: cat(locale, 'primary'), tone: 'accent' }]), `${locale} ${scheme}: ${n.me}'s row ${flat(rows[0])} ${show(tagsOf(rows[0]))}`);
          assert(flat(rows[1]).includes(cat(locale, 'kids')) && tagsOf(rows[1]).length === 0, `${locale} ${scheme}: ${n.kids}'s row ${flat(rows[1])}`);
          assert(show(rows.map((r) => dotColour(r))) === show(['#039BE5', '#F4511E']), `${locale} ${scheme}: row dots`);
          assert(rows.every((r) => elements(r).some((e) => classes(e).includes('ch-form-chevron')) && elements(r).some((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'auto')), `${locale} ${scheme}: a row without its chevron or <bdi> name`);
          assert(elements(o.m.container).some((e) => e.localName === 'p' && classes(e).includes('ch-form-fixed') && flat(e) === word(locale, 'chosenHint')), `${locale} ${scheme}: the chosen hint`);
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
  await check('S3 nothing chosen: no "Chosen calendars" section and the notes count says None in each language (0 / 1 / 2 / 3 plurals: he dual, ru few); a Google account with no calendars shows the empty state in place of the sections; a chosen calendar Google no longer lists keeps its place in the saved selection under an unrelated tap', async () => {
    for (const locale of LOCALES) {
      resetWorld();
      const none = await open(locale, { currentSelections: selectionOf({ selectedCalendars: new Set(), calendarLabels: new Map(), calendarRules: new Map(), globalRules: [] }) }, TELEGRAM);
      try {
        assert(show(sectionLabels(none.m)) === show([word(locale, 'show'), word(locale, 'notes')]) && listRows(none.m).length === 0, `${locale}: ${show(sectionLabels(none.m))}`);
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
        assert(sectionLabels(empty.m).length === 0 && pageSwitches(empty.m).length === 0 && !notesRow(empty.m), `${locale}: sections with no calendars: ${show(sectionLabels(empty.m))}`);
        assert(flat(elements(empty.m.container).find((e) => e.localName === 'h1') as FakeNode) === word(locale, 'title'), `${locale}: the title stays`);
      } finally {
        close(empty);
      }
    }
    // A chosen calendar Google no longer lists: not on the screen, still in the saved choices
    resetWorld();
    const GONE = 'old@group.calendar.google.com';
    const o = await open('en', { currentSelections: selectionOf({ selectedCalendars: new Set([ME, GONE, KIDS]), calendarLabels: new Map([[ME, new Set(['yours'])], [GONE, new Set(['kids'])], [KIDS, new Set(['kids'])]]) }) }, TELEGRAM);
    try {
      assert(listRows(o.m).length === 2 && !page(o.m).includes('old@group'), 'the calendar Google does not list is on the page');
      await tapAndSettle(o, switchOf(o.m, 'Family'));
      const ids = bodyOf().calendarAssignments.map((a) => a.calendarId);
      assert(show(ids) === show([ME, GONE, KIDS, FAMILY]), `the saved choices after an unrelated tap: ${show(ids)}`);
      assert(bodyOf().calendarAssignments[1].name === GONE && show(bodyOf().calendarAssignments[1].labels) === show(['kids']), `its entry: ${show(bodyOf().calendarAssignments[1])}`);
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
      // The status stays until the next save, and a save that fails replaces it
      assert(show(statusText(o.m)) === show(['Saved']), 'Saved stays');
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
      assert(show(bodyOf().calendarAssignments.map((a) => a.calendarId)) === show([ME]) && !JSON.stringify(bodyOf()).includes('Early dismissal'), `after the off tap: ${show(bodyOf())}`);
      assert(!isOn(switchOf(o.m, 'Kids and school')) && listRows(o.m).length === 1, 'the row stays on');
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
      ru: [[1, 'В вашем плане есть место для 1 календаря FamCal и Google вместе.'], [3, 'В вашем плане есть место для 3 календарей FamCal и Google вместе.'], [5, 'В вашем плане есть место для 5 календарей FamCal и Google вместе.'], [21, 'В вашем плане есть место для 21 календаря FamCal и Google вместе.']],
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

  await check('S14 Back has one owner (AppScreen): it closes an open sheet first, never while a request runs, else goes to the dashboard; Cancel, Escape and the scrim do the same and are off while a save runs; in a browser the header\'s own back (once, mirrored in he) does the same; a swipe down in a sheet is held off', async () => {
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
      assert(show(pushes) === show(['/en/dashboard?user_id=5550001']), `Back with no sheet: ${show(pushes)}`);
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
      assert(show(pushes) === show(['/en/dashboard?user_id=5550001']), `Back after it: ${show(pushes)}`);
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
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=5550001`]), `${locale}: the header back: ${show(pushes)}`);
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

  await check('S16 a long Google name and description (a link, no spaces) stay inside the row: the name is isolated in a <bdi>, the row\'s label can shrink; the dot, the chevron and the switch are never squeezed out', async () => {
    resetWorld();
    const long = 'https://calendar.example.com/ical/very-long-unbroken-calendar-address-for-the-school-parents-committee@group.calendar.google.com';
    const o = await open('he', { availableCalendars: [{ id: ME, name: long, description: long, backgroundColor: '#039BE5' }, ...availableFor('he').slice(1)] }, { ...TELEGRAM, scheme: 'dark' });
    try {
      const s = pageSwitches(o.m)[0];
      assert(flat(s).includes(long), 'the long name is not shown');
      const hintEl = elements(s).find((e) => classes(e).includes('ch-form-hint')) as FakeElement;
      assert(hintEl && elements(hintEl).some((e) => e.localName === 'bdi'), 'the description is not isolated');
    } finally {
      close(o);
    }
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
