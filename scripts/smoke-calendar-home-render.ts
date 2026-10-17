// Smoke test for the calendar home's Agenda view (spec §7.3, §7.5, §7.7, §5 States;
// Rulings R7, R8, R10, R19; Plan D, Task D5): AgendaView and its parts (DayList, ItemRow,
// StillOpenCard, ItemSheet, BottomSheet) in app/[locale]/dashboard/, and the date and
// time helpers in src/lib/calendar-view/format.ts.
//
// The Agenda is built the way CalendarHome (D6) builds it: range answers go through the
// real store (D3's reduceStore) and buildAgenda, and AgendaView renders the model in
// en, he and ru through next-intl with the real messages. It checks:
//  - the copy each language shows: day labels, the Hebrew date (R9's genitive in
//    Russian), the fold line, the "Still open" card with its "since" lines, the rows'
//    times (24-hour, in the user's timezone, whatever the process clock), spans,
//    reminder states and person chips (R7), the Google chip, the empty state's hints
//    (R10), the §5 state rows;
//  - "Empty means answered": no "Nothing planned" and no fold before every source
//    answered, or after an error or a reconnect;
//  - privacy: no calendar id in the markup; a masked partner calendar reads "Noa's calendar";
//  - Plan D's shape (R19): no tab bar; dir="rtl" in Hebrew; no untranslated key;
//  - accessibility: buttons for every tap, icons hidden, times dir="ltr", titles
//    dir="auto", the sheet a modal dialog; the CSS has no text under 11 px, no tap
//    target under 44 px, logical properties only and a reduced-motion rule;
//  - the item sheet's details (§7.5), and, in real React (react-dom/client with act on a
//    small fake DOM), that a tap selects the row through the container's onSelect and
//    the sheet opens, AgendaView never touches Telegram's BackButton (the container's
//    one button, D6), the Close button, Escape and the scrim close it, focus goes back
//    to the row, "Open in Google Calendar" calls openLink, and the buttons call the
//    container's callbacks;
//  - the mockups' day forms: a fold line in one month names it once ("Sat 17 – Sun 18
//    Oct"), and Hebrew labels read "חמישי 15 באוק׳";
//  - a Google user still setting up (setupNeeded) gets no Agenda: no "Nothing planned",
//    no hint, no fold, no placeholders;
//  - the colours: the brand fallbacks are globals.css's tokens, and the page's root takes
//    the theme's background while the home is mounted.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under three clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-home-render.ts

// The view first: the import-rule check walks what these load.
import { AgendaView, AGENDA_CSS, type AgendaViewProps } from '../app/[locale]/dashboard/AgendaView';
import { ItemSheet } from '../app/[locale]/dashboard/ItemSheet';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { buildAgenda, type AgendaModel, type AgendaRow } from '../src/lib/calendar-view/agenda';
import { addDaysToKey, daysInWindow, emptyStore, reduceStore, type CalendarStore, type StoreAction } from '../src/lib/calendar-view/store';
import { compareItems, type CalendarDTO, type DayKey, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse } from '../src/lib/calendar-view/types';
import type { HomeHints } from '../src/lib/calendar-view/home-props';
import { formatDayRange, formatDayShort } from '../src/lib/calendar-view/format';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

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

const show = (value: unknown) => JSON.stringify(value);
const messages: Record<Locale, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

// ---- React must not warn ----

const reactWarnings: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 ----

const TZ = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';
const day = (n: number): DayKey => addDaysToKey(TODAY, n);
/** A wall-clock time in Israel on day n, as UTC ISO (IDT, UTC+3, until 25 October). */
function at(n: number, hhmm: string): string {
  const [y, m, d] = day(n).split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - 3, min)).toISOString();
}

const MY_CAL: ItemCalendarDTO = { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5', mine: true, inLegend: true };
const NOA_CAL: ItemCalendarDTO = { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa', inLegend: true };
/** A partner's private calendar on a reminder-for-me: masked by the route (id null, the partner's name). */
const MASKED: ItemCalendarDTO = { id: null, name: 'Noa', color: null, mine: false, inLegend: false };
const LEGEND: CalendarDTO[] = [
  { id: 'native:cal_me_7f3a', source: 'famcal', name: 'Family', color: '#039BE5', mine: true },
  { id: 'native:cal_noa_91b2', source: 'famcal', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa' },
];

function item(id: string, o: Partial<ItemDTO> & { start: string }): ItemDTO {
  return {
    key: `${o.source ?? 'famcal'}|${id}`,
    source: 'famcal',
    readOnly: false,
    id,
    seriesId: null,
    originalStart: o.start,
    kind: 'event',
    title: id,
    end: o.start,
    allDay: false,
    tz: TZ,
    recurring: false,
    repeatsDaily: false,
    span: null,
    calendar: MY_CAL,
    location: null,
    description: null,
    ...o,
  };
}
function rem(o: Partial<ItemReminderDTO> = {}): ItemReminderDTO {
  return { done: false, doneAt: null, snoozedUntil: null, open: false, openSince: null, ownerIsViewer: true, creatorIsViewer: true, ...o };
}

const VITAMINS = item('vitamins', { kind: 'reminder', title: 'Take vitamins', start: at(0, '08:00'), recurring: true, repeatsDaily: true, reminder: rem({ done: true, doneAt: at(0, '08:10') }) });
const DENTIST = item('dentist', { title: 'Dentist', start: at(0, '09:30'), end: at(0, '10:30'), location: 'Clinic on Herzl St', description: 'Bring the X-rays\nAsk about the night guard' });
const FORM = item('form', { kind: 'reminder', title: 'Send the school form', start: at(0, '13:00'), reminder: rem({ open: true }) });
const SNOOZED = item('snoozed', { kind: 'reminder', title: 'Call the bank', start: at(0, '14:00'), reminder: rem({ open: true, snoozedUntil: at(0, '15:30') }) });
const FOOTBALL = item('football', { title: 'Football practice', start: at(0, '17:00'), end: at(0, '18:00'), calendar: NOA_CAL });
const CONCERT = item('concert', { title: 'Concert', start: at(0, '22:00'), end: at(1, '02:00'), span: 'endsLater' });
const GRANDMA = item('grandma', { title: 'Grandma visits', start: day(1), end: day(2), allDay: true, tz: null, calendar: NOA_CAL });
const CHALLAH = item('challah', { kind: 'reminder', title: 'Buy challah', start: at(1, '10:00'), reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const PARCEL = item('parcel', { kind: 'reminder', title: 'Pick up the parcel', start: at(1, '12:00'), calendar: MASKED, reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const FOR_NOA = item('for-noa', { kind: 'reminder', title: 'Book the plumber', start: at(1, '18:00'), calendar: NOA_CAL, reminder: rem({ ownerIsViewer: false, ownerName: 'Noa' }) });
const MEETING = item('meeting', { title: 'Parent–teacher meeting', start: at(4, '08:15'), end: at(4, '09:00'), calendar: NOA_CAL });
const RECYCLING = item('recycling', { kind: 'reminder', title: 'Take out the recycling', start: at(4, '21:00'), recurring: true, reminder: rem() });
const TRIP = (n: 5 | 6): ItemDTO =>
  item('trip', { title: 'Trip to Eilat', start: day(5), end: day(8), allDay: true, tz: null, span: n === 5 ? 'endsLater' : 'spansDay' });
const SLEEPOVER = (n: 5 | 6): ItemDTO =>
  item('sleepover', { title: 'Sleepover at Dana’s', start: at(5, '20:00'), end: at(6, '10:00'), span: n === 5 ? 'endsLater' : 'continues' });

const CARRY_BILL = item('bill', { kind: 'reminder', title: 'Pay the electricity bill', start: at(-2, '09:00'), reminder: rem({ open: true, openSince: day(-2) }) });
const CARRY_PLUMBER = item('plumber', { kind: 'reminder', title: 'Call the plumber', start: at(-1, '11:00'), reminder: rem({ open: true, openSince: day(-1), creatorIsViewer: false, creatorName: 'Noa' }) });
const CARRY_OLD = item('old', { kind: 'reminder', title: 'Renew the passport', start: at(-9, '10:00'), reminder: rem({ open: true, openSince: day(-9) }) });

const WEEK: Record<DayKey, ItemDTO[]> = {
  [day(0)]: [VITAMINS, DENTIST, FORM, SNOOZED, FOOTBALL, CONCERT],
  [day(1)]: [GRANDMA, CHALLAH, PARCEL, FOR_NOA],
  [day(4)]: [MEETING, RECYCLING],
  [day(5)]: [TRIP(5), SLEEPOVER(5)],
  [day(6)]: [TRIP(6), SLEEPOVER(6)],
};

function answer(o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}): RangeResponse {
  const from = o.from ?? TODAY;
  const to = o.to ?? day(7);
  const items = o.items ?? {};
  const { items: _items, ...rest } = o;
  return {
    tz: TZ,
    today: TODAY,
    weekStart: 0,
    hebrewDates: true,
    from,
    to,
    sources: { famcal: { status: 'ok' } },
    partner: { name: 'Noa' },
    calendars: LEGEND,
    days: daysInWindow(from, to).map((date) => ({ date, items: [...(items[date] ?? [])].sort(compareItems) })),
    ...rest,
  };
}

function storeOf(actions: StoreAction[]): CalendarStore {
  return actions.reduce(reduceStore, emptyStore());
}
const ok = (response: RangeResponse): StoreAction => ({ type: 'response', response, epoch: 0 });
function model(actions: StoreAction[], weeks = 1): AgendaModel {
  const m = buildAgenda(storeOf(actions), weeks);
  assert(m, 'buildAgenda gave null: the fixture pinned no facts');
  return m;
}

const famcalWeek = () => model([ok(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, CARRY_OLD] }))]);

// A Google user: their Family calendar, the birthdays calendar and a spouse-labelled one.
const G_FAMILY: ItemCalendarDTO = { id: 'family-6c1d@group.calendar.google.com', name: 'Family', color: '#7986CB', mine: true, inLegend: true };
const G_BIRTHDAYS: ItemCalendarDTO = { id: 'addressbook#contacts@group.v.calendar.google.com', name: 'Birthdays', color: '#33B679', mine: true, inLegend: true };
const G_NOA: ItemCalendarDTO = { id: 'noa.k@example.com', name: 'Noa', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const HTML_LINK = 'https://www.google.com/calendar/event?eid=ZGlubmVy';
const DINNER = item('dinner', { source: 'google', readOnly: true, tz: null, title: 'Dinner with the Cohens', start: '2026-10-15T19:30:00+03:00', end: '2026-10-15T22:00:00+03:00', calendar: G_FAMILY, htmlLink: HTML_LINK, birthday: false });
const BIRTHDAY = item('bday', { source: 'google', readOnly: true, tz: null, title: 'Noa’s birthday', start: day(1), end: day(2), allDay: true, calendar: G_BIRTHDAYS, birthday: true, htmlLink: null });
const YOGA = item('yoga', { source: 'google', readOnly: true, tz: null, title: 'Yoga', start: '2026-10-16T18:00:00+03:00', end: '2026-10-16T19:00:00+03:00', calendar: G_NOA, htmlLink: 'https://www.google.com/calendar/event?eid=eW9nYQ' });

function googleAnswer(o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}): RangeResponse {
  return answer({
    sources: { google: { status: 'ok' } },
    partner: null,
    calendars: [
      { id: G_FAMILY.id as string, source: 'google', name: 'Family', color: '#7986CB', mine: true },
      { id: G_BIRTHDAYS.id as string, source: 'google', name: 'Birthdays', color: '#33B679', mine: true },
      { id: G_NOA.id as string, source: 'google', name: 'Noa', color: '#E67C73', mine: false, ownerName: 'Noa' },
    ],
    ...o,
  });
}
const googleWeek = () => model([ok(googleAnswer({ items: { [day(0)]: [DINNER], [day(1)]: [BIRTHDAY, YOGA] } }))]);

const HINTS_ALL: HomeHints = { reminders: true, voiceEvents: true };
const noop = () => undefined;

// ---- Rendering ----

/** CalendarHome's frame (D6): the theme root and its tokens, inside next-intl's provider. */
function inHome(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(
    NextIntlClientProvider,
    provider,
    createElement('div', { className: 'ch-home', 'data-theme': 'light' }, createElement('style', null, HOME_THEME_CSS), el),
  );
}

function agendaProps(agenda: AgendaModel | null, o: Partial<AgendaViewProps> = {}): AgendaViewProps {
  return { agenda, hints: HINTS_ALL, setupNeeded: false, selected: null, onSelect: noop, onShowNextWeek: noop, onRetry: noop, onChooseCalendars: noop, ...o };
}

function renderAgenda(locale: Locale, agenda: AgendaModel | null, o: Partial<AgendaViewProps> = {}): string {
  return renderToString(inHome(locale, createElement(AgendaView, agendaProps(agenda, o))));
}

type Interactive = Partial<AgendaViewProps> & { seen?: (string | null)[] };

/**
 * AgendaView as the container holds it (D6 keeps the selected row): a tap opens the sheet.
 * `seen` records each onSelect: the row's key, or null for a close.
 */
function AgendaWithSelection({ seen, ...props }: AgendaViewProps & { seen?: (string | null)[] }) {
  const [selected, setSelected] = React.useState<AgendaRow | null>(props.selected);
  const onSelect = (row: AgendaRow | null) => {
    seen?.push(row ? row.item.key : null);
    setSelected(row);
  };
  return createElement(AgendaView, { ...props, selected, onSelect });
}

/** The Agenda for the real-React checks: in the home's frame, with the selection kept. */
function interactive(locale: Locale, agenda: AgendaModel | null, o: Interactive = {}): ReactElement {
  return inHome(locale, createElement(AgendaWithSelection, agendaProps(agenda, o)));
}

function renderSheet(locale: Locale, row: AgendaRow, today = TODAY): string {
  return renderToString(inHome(locale, createElement(ItemSheet, { row, today, tz: TZ, onClose: noop })));
}

/** The text a reader sees: tags and React's text separators out, entities decoded, spaces collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Intl joins ranges with thin and narrow spaces; textOf turns every space into a plain one. */
const spaces = (s: string) => s.replace(/\s+/g, ' ');

/** The markup without the style sheets (their class names would match anything). */
const markup = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

function assertHas(text: string, wanted: string[], where: string) {
  const missing = wanted.filter((w) => !text.includes(spaces(w)));
  assert(missing.length === 0, `${where}: missing ${show(missing)} in ${show(text.slice(0, 1500))}`);
}
function assertLacks(text: string, unwanted: string[], where: string) {
  const found = unwanted.filter((w) => text.includes(spaces(w)));
  assert(found.length === 0, `${where}: should not show ${show(found)}`);
}

/** The row for a fixture item in a model (first day it is on). */
function rowOf(agenda: AgendaModel, key: string): AgendaRow {
  for (const e of agenda.entries) {
    if (e.type !== 'day') continue;
    const r = e.rows.find((x) => x.item.key === key);
    if (r) return r;
  }
  const open = [...(agenda.stillOpen?.shown ?? []), ...(agenda.stillOpen?.more ?? [])].find((x) => x.item.key === key);
  assert(open, `${key} is not in the model`);
  return open;
}

/** Reference formatting, to compare the view's dates with (the same Intl options the task names). */
const ref = {
  dayShort: (l: string, d: DayKey) => new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)),
  dayMonth: (l: string, d: DayKey) => new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)),
  dayTime: (l: string, iso: string) =>
    new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(new Date(iso)),
  weekdayTime: (l: string, iso: string) =>
    new Intl.DateTimeFormat(l, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(new Date(iso)),
};

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules) ----

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners: Listener[] = [];
  constructor(
    public nodeType: number,
    public nodeName: string,
  ) {}
  get ownerDocument(): Row {
    return fakeDocument;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(String(value)));
  }
  addEventListener(type: string, fn: (event: Row) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, capture, fn });
  }
  removeEventListener(type: string, fn: (event: Row) => void) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3, '#text');
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = String(value);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  style: Row = { setProperty(k: string, v: string) { this[k] = v; }, removeProperty(k: string) { delete this[k]; } };
  constructor(
    public localName: string,
    public namespaceURI: string,
  ) {
    super(1, namespaceURI === HTML_NS ? localName.toUpperCase() : localName);
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_ns: string | null, name: string) {
    this.attributes.delete(name);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
}

const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML' },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
};
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

const openedWindows: string[] = [];
const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
  open: (url: string) => {
    openedWindows.push(url);
    return null;
  },
};
fakeDocument.defaultView = fakeWindow;

function installWindow() {
  const g = globalThis as Row;
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

/** A fake Telegram.WebApp (Bot API 7.0) that records calls and keeps BackButton handlers, as the SDK does. */
function fakeTelegram() {
  const calls: string[] = [];
  const back = new Set<() => void>();
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
    if (typeof a !== 'function') return String(a);
    if (!ids.has(a)) ids.set(a, `fn${ids.size + 1}`);
    return ids.get(a) as string;
  };
  const rec =
    (name: string, effect?: (arg: unknown) => void) =>
    (arg?: unknown) => {
      calls.push(`${name}(${arg === undefined ? '' : label(arg)})`);
      effect?.(arg);
    };
  const webApp: Row = {
    initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc',
    version: '7.0',
    colorScheme: 'light',
    isVersionAtLeast: (v: string) => Number(v) <= 7,
    openLink: rec('openLink'),
    onEvent: rec('onEvent'),
    offEvent: rec('offEvent'),
    BackButton: {
      onClick: rec('BackButton.onClick', (h) => back.add(h as () => void)),
      offClick: rec('BackButton.offClick', (h) => back.delete(h as () => void)),
      show: rec('BackButton.show'),
      hide: rec('BackButton.hide'),
    },
  };
  return { webApp, calls, pressBack: () => [...back].forEach((h) => h()), handlers: () => back.size };
}

type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  key: (el: FakeNode, key: string) => void;
  unmount: () => void;
};

function mount(el: ReactElement): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string, extra: Row) => {
    const event: Row = {
      type,
      target,
      srcElement: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      timeStamp: Date.now(),
      button: 0,
      buttons: 0,
      detail: 1,
      ...extra,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation: noop,
      stopImmediatePropagation: noop,
    };
    React.act(() => {
      fakeWindow.event = event;
      for (const capture of [true, false]) {
        for (const l of container.listeners.filter((x) => x.type === type && x.capture === capture)) l.fn(event);
      }
      fakeWindow.event = undefined;
    });
  };
  return {
    container,
    render: (next) => React.act(() => root.render(next)),
    click: (target) => dispatch(target, 'click', {}),
    key: (target, key) => dispatch(target, 'keydown', { key }),
    unmount: () => React.act(() => root.unmount()),
  };
}

function elements(node: FakeNode, out: FakeElement[] = []): FakeElement[] {
  for (const c of node.childNodes) {
    if (c instanceof FakeElement) {
      out.push(c);
      elements(c, out);
    }
  }
  return out;
}
const byRole = (node: FakeNode, role: string) => elements(node).filter((e) => e.getAttribute('role') === role);
function button(node: FakeNode, text: string): FakeElement {
  const found = elements(node).filter((e) => e.localName === 'button' && e.textContent.includes(text));
  assert(found.length > 0, `no button with ${show(text)} in ${show(node.textContent.slice(0, 600))}`);
  return found[0];
}
const byClass = (node: FakeNode, cls: string) => elements(node).filter((e) => e.className.split(' ').includes(cls));

// ---- The checks ----

/** The markup #15 compares across process zones: the Agenda and two sheets, in each language. */
function dumpMarkup(): string {
  const week = famcalWeek();
  return LOCALES.map((l) => renderAgenda(l, week) + renderSheet(l, rowOf(week, 'famcal|concert')) + renderSheet(l, rowOf(week, 'famcal|trip')) + renderSheet(l, rowOf(week, 'famcal|vitamins'))).join('\n');
}

async function main() {
  if (process.env.SMOKE_HOME_RENDER_DUMP === '1') {
    // #15's child: a digest of the markup (a pipe would cut a long write at exit).
    const html = dumpMarkup();
    process.stdout.write(`${html.length} ${createHash('sha256').update(html).digest('hex')} ${html.includes('Take vitamins')}\n`);
    return;
  }

  await check('#1 the view is client-safe: AgendaView and ItemSheet load no server module (DB, Redis, services, date-fns-tz, @hebcal/core)', () => {
    const roots = [path.join(ROOT, 'app/[locale]/dashboard/AgendaView.tsx'), path.join(ROOT, 'app/[locale]/dashboard/ItemSheet.tsx')];
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    for (const id of roots) {
      assert(require.cache[id] !== undefined, `${id} is not in require.cache: the check would be empty`);
      walk(id);
    }
    for (const want of ['app/[locale]/dashboard/DayList.tsx', 'app/[locale]/dashboard/ItemRow.tsx', 'src/lib/calendar-view/format.ts', 'src/lib/telegram-ui.ts']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the view's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#2 en: day labels, the Hebrew date, the fold line, times in Israel (24-hour), spans, reminder states and the person chips', () => {
    const text = textOf(renderAgenda('en', famcalWeek()));
    assertHas(
      text,
      [
        `Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`,
        `Tomorrow ${ref.dayShort('en-GB', day(1))} 5 Cheshvan`,
        'Nothing planned Sat 17 – Sun 18 Oct',
        `${ref.dayShort('en-GB', day(4))} 8 Cheshvan`,
        '08:00 Take vitamins Reminder · done · every day',
        '09:30 10:30 Dentist Clinic on Herzl St',
        '13:00 Send the school form Open Reminder',
        '14:00 Call the bank Reminder until 15:30 Snoozed until 15:30',
        '17:00 18:00 Football practice Noa',
        `22:00 Concert until ${ref.weekdayTime('en-GB', at(1, '02:00'))}`,
        'All day Grandma visits Noa',
        '10:00 Buy challah Reminder From Noa',
        '12:00 Pick up the parcel Reminder From Noa',
        '18:00 Book the plumber Reminder For Noa',
        '21:00 Take out the recycling Reminder · repeats',
        `All day Trip to Eilat until ${ref.dayShort('en-GB', day(7))}`,
        `20:00 Sleepover at Dana’s until ${ref.weekdayTime('en-GB', at(6, '10:00'))}`,
        'All day Trip to Eilat continues',
        'until 10:00 Sleepover at Dana’s',
        'Show next week',
      ],
      'en',
    );
    assert(ref.dayShort('en-GB', day(0)).includes('15') && ref.dayShort('en-GB', day(0)).includes('Oct'), 'en-GB day label');
    assertLacks(text, ['9:30 AM', '10:00 PM', 'Nothing planned Tomorrow', 'Sat 17 Oct – Sun 18 Oct'], 'en');
    // Spec §7.3 and the mockups: one month is named once; across months, each day has its own.
    const forms = [formatDayRange(day(16), day(17), 'en'), formatDayRange(day(2), day(2), 'en'), formatDayRange('2026-12-31', '2027-01-01', 'en')];
    assert(show(forms) === show(['Sat 31 Oct – Sun 1 Nov', 'Sat 17 Oct', 'Thu 31 Dec – Fri 1 Jan']), `en ranges: ${show(forms)}`);
    const html = markup(renderAgenda('en', famcalWeek()));
    assert(/<button type="button" class="ch-row ch-tap is-done">(?:(?!<\/button>).)*Take vitamins/.test(html), 'a done reminder\'s row is struck through (is-done)');
    assert(!/<button type="button" class="ch-row ch-tap is-done">(?:(?!<\/button>).)*Send the school form/.test(html), 'an open one is not');
  });

  await check('#3 the "Still open" card: today\'s open reminders, then the carry-overs, each with "since", and who set it', () => {
    const agenda = famcalWeek();
    assert(agenda.stillOpen?.shown.length === 5, `5 open: ${show(agenda.stillOpen?.shown.map((r) => r.item.key))}`);
    const expected: Record<Locale, string[]> = {
      en: ['Still open 5 reminders', 'Send the school form Since 13:00', 'Call the bank Since 14:00', 'Call the plumber Since yesterday From Noa', 'Pay the electricity bill Since Tuesday', `Renew the passport Since ${ref.dayMonth('en-GB', day(-9))}`],
      he: ['עדיין פתוחות 5 תזכורות', 'Send the school form מהשעה 13:00', 'Call the plumber מאתמול מאת Noa', 'Pay the electricity bill מיום שלישי', `Renew the passport מ-${ref.dayMonth('he-IL', day(-9))}`],
      ru: ['Невыполненные 5 напоминаний', 'Send the school form С 13:00', 'Call the plumber Со вчерашнего дня От: Noa', 'Pay the electricity bill Со вторника', `Renew the passport С ${ref.dayMonth('ru-RU', day(-9))}`],
    };
    for (const locale of LOCALES) {
      const html = renderAgenda(locale, agenda);
      const card = html.slice(html.indexOf('class="ch-card"'), html.indexOf('class="ch-days"'));
      assert(card.length > 0, `${locale}: no card`);
      assertHas(textOf(card), expected[locale], `${locale} card`);
      assertLacks(textOf(card), ['Take vitamins', 'Book the plumber', 'Buy challah'], `${locale} card (done, the partner's, not due)`);
    }
  });

  await check('#4 he: dir="rtl", the Hebrew mockup\'s labels ("חמישי 15 באוק׳") and fold line ("אין אירועים בשבת 17 – ראשון 18 באוק׳"), Hebrew dates, times set dir="ltr"', () => {
    const html = renderAgenda('he', famcalWeek());
    assert(/<section class="ch-agenda" dir="rtl"/.test(html), 'the Agenda root is dir="rtl"');
    const text = textOf(html);
    assertHas(
      text,
      [
        'היום חמישי 15 באוק׳ ד׳ בחשון',
        'מחר שישי 16 באוק׳ ה׳ בחשון',
        'אין אירועים בשבת 17 – ראשון 18 באוק׳',
        'שני 19 באוק׳ ח׳ בחשון',
        'Take vitamins תזכורת · בוצעה · כל יום',
        'Send the school form פתוחה תזכורת',
        'Buy challah תזכורת מאת Noa',
        'Book the plumber תזכורת בשביל Noa',
        'כל היום Grandma visits Noa',
        'להציג את השבוע הבא',
      ],
      'he',
    );
    assert(html.includes('<span class="ch-time-main" dir="ltr">09:30</span>'), 'a time is dir="ltr"');
    assert(html.includes('<span class="ch-time-sub" dir="ltr">10:30</span>'), 'an end time is dir="ltr"');
    assert(/<span class="ch-time-main">כל היום<\/span>/.test(html), '"All day" follows the text direction');
    assert(html.includes('<span class="ch-title" dir="auto">Dentist</span>'), 'titles are dir="auto"');
    assertLacks(text, ['יום ה׳', 'יום שבת,'], 'he: not he-IL\'s short weekday');
    const forms = [formatDayShort(day(2), 'he'), formatDayRange(day(16), day(17), 'he')];
    assert(show(forms) === show(['שבת 17 באוק׳', 'שבת 31 באוק׳ – ראשון 1 בנוב׳']), `he forms: ${show(forms)}`);
  });

  await check('#5 ru: Russian labels, plural forms and the genitive Hebrew month (Ruling R9)', () => {
    const text = textOf(renderAgenda('ru', famcalWeek()));
    assertHas(
      text,
      [
        `Сегодня ${ref.dayShort('ru-RU', day(0))} 4 хешвана`,
        `Завтра ${ref.dayShort('ru-RU', day(1))} 5 хешвана`,
        'Ничего не запланировано: сб, 17 – вс, 18 окт.',
        'Buy challah Напоминание От: Noa',
        'Book the plumber Напоминание Кому: Noa',
        'Весь день',
        'Показать следующую неделю',
      ],
      'ru',
    );
    assertLacks(text, ['Хешван'], 'ru (the nominative belongs in headers, not day labels)');
  });

  await check('#6 Plan D\'s shape: no tab bar, no Month, no untranslated key, in each language', () => {
    for (const locale of LOCALES) {
      const html = renderAgenda(locale, famcalWeek());
      assertLacks(html, ['role="tablist"', 'role="tab"', 'calendarHome.'], locale);
      if (locale !== 'he') assert(/<section class="ch-agenda" dir="ltr"/.test(html), `${locale}: dir="ltr"`);
    }
    assertLacks(textOf(renderAgenda('en', famcalWeek())), ['Month', 'Agenda'], 'en');
  });

  await check('#7 privacy: no calendar id reaches the markup, and a masked partner calendar reads "Noa\'s calendar"', () => {
    const ids = [MY_CAL.id, NOA_CAL.id, G_FAMILY.id, G_BIRTHDAYS.id, G_NOA.id].map(String);
    for (const locale of LOCALES) {
      const html = renderAgenda(locale, famcalWeek()) + renderAgenda(locale, googleWeek());
      assertLacks(html, [...ids, 'native:', 'cal_'], `${locale} Agenda`);
      for (const key of ['famcal|parcel', 'famcal|football', 'famcal|dentist']) {
        assertLacks(renderSheet(locale, rowOf(famcalWeek(), key)), [...ids, 'native:'], `${locale} sheet ${key}`);
      }
    }
    const masked = textOf(renderSheet('en', rowOf(famcalWeek(), 'famcal|parcel')));
    assertHas(masked, ['Calendar Noa’s calendar', 'From Noa'], 'the masked sheet');
    assertHas(textOf(renderSheet('he', rowOf(famcalWeek(), 'famcal|parcel'))), ['היומן של Noa'], 'he masked sheet');
    assertHas(textOf(renderSheet('en', rowOf(famcalWeek(), 'famcal|football'))), ['Calendar Noa and the kids'], 'a shared partner calendar keeps its name');
    // A FamCal row never names its calendar (the colour and the person chip do the job, R7).
    assertLacks(textOf(renderAgenda('en', famcalWeek())), ['Family', 'Noa and the kids'], 'FamCal rows');
  });

  await check('#8 Google items: "Google · <calendar>", the birthday label, the spouse\'s chip, partial and unavailable rows', () => {
    const store = storeOf([
      ok(
        googleAnswer({
          items: { [day(0)]: [DINNER], [day(1)]: [BIRTHDAY, YOGA] },
          sources: { google: { status: 'ok', partial: { failed: 1, truncated: 0 } } },
          calendars: [
            { id: G_FAMILY.id as string, source: 'google', name: 'Family', color: '#7986CB', mine: true },
            { id: 'gone-1@group.calendar.google.com', source: 'google', name: 'Old', color: null, mine: true, unavailable: true },
            { id: 'gone-2@group.calendar.google.com', source: 'google', name: 'Older', color: null, mine: true, unavailable: true },
          ],
        }),
      ),
    ]);
    const agenda = buildAgenda(store);
    assert(agenda, 'model');
    const text = textOf(renderAgenda('en', agenda));
    assertHas(
      text,
      [
        'Some calendars didn’t load Retry',
        '2 calendars aren’t available Choose again',
        '19:30 22:00 Dinner with the Cohens Google · Family',
        'All day Noa’s birthday Birthday Google · Birthdays',
        '18:00 19:00 Yoga Noa Google · Noa',
      ],
      'en Google',
    );
    assertLacks(text, ['Still open'], 'no FamCal card for a Google user');
    assertHas(textOf(renderAgenda('ru', agenda)), ['2 календаря недоступны Выбрать заново', 'Google · Family'], 'ru Google');
    assertHas(textOf(renderAgenda('he', agenda)), ['שני יומנים לא זמינים לבחור שוב', 'חלק מהיומנים לא נטענו לנסות שוב'], 'he Google');
  });

  await check('#9 "Empty means answered": a FamCal error, a Google reconnect or calendars_gone show no "Nothing planned" and no fold, and the right state row', () => {
    const famcalError = model([ok(answer({ sources: { famcal: { status: 'error' } }, partner: null, calendars: [] }))]);
    const t1 = textOf(renderAgenda('en', famcalError));
    assertHas(t1, ['Couldn’t load your calendar Retry', 'Today', 'Tomorrow'], 'FamCal error');
    assertLacks(t1, ['Nothing planned', 'Still open'], 'FamCal error');

    const reconnect = model([ok(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] }))]);
    const t2 = textOf(renderAgenda('en', reconnect));
    assertLacks(t2, ['Nothing planned', 'Couldn’t load', 'Retry', 'Reconnect'], 'reconnect is the banner\'s (D6), never a row');
    assertHas(t2, ['Today', 'Tomorrow'], 'reconnect');

    const gone = model([ok(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    const t3 = textOf(renderAgenda('en', gone));
    assertHas(t3, ['Your calendars aren’t available Choose again'], 'calendars_gone');
    assertLacks(t3, ['Nothing planned', 'Retry'], 'calendars_gone');

    const googleError = model([ok(googleAnswer({ sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] }))]);
    assertHas(textOf(renderAgenda('he', googleError)), ['לא הצלחנו לטעון את יומן Google לנסות שוב'], 'Google error (he)');
  });

  await check('#10 loading: placeholders and the loading text before the first answer, and for a week still on its way; never free days', () => {
    const before = renderAgenda('en', null);
    assert(before.includes('aria-busy="true"') && before.includes('class="ch-ghost"'), 'placeholders, aria-busy');
    assertHas(textOf(before), ['Loading your calendar…'], 'loading');
    assertLacks(textOf(before), ['Nothing planned', 'Show next week', 'Today'], 'loading');
    // Week 0 answered; "Show next week" asked for week 1, which hasn't answered.
    const twoWeeks = model([ok(answer({ items: WEEK }))], 2);
    const html = renderAgenda('en', twoWeeks);
    const nextWeek = html.slice(html.indexOf(`id="ch-day-${day(7)}"`));
    assert(nextWeek.length > 0 && html.includes(`id="ch-day-${day(13)}"`), 'week 1\'s days are listed');
    assert(/aria-busy="true"/.test(nextWeek) && nextWeek.includes('class="ch-ghost"'), 'week 1 shows placeholders');
    assertLacks(textOf(nextWeek), ['Nothing planned'], 'week 1 is not empty yet');
    // The same week after a 429: the busy row, still no fold.
    const busy = model([ok(answer({ items: WEEK })), { type: 'windowFailed', from: day(7), to: day(14), sources: ['famcal'], kind: 'busy', epoch: 0 }], 2);
    const busyText = textOf(renderAgenda('en', busy));
    assertHas(busyText, ['Busy right now, try again in a minute Retry'], 'busy');
    assert((busyText.match(/Nothing planned/g) ?? []).length === 1, `only week 0's fold: ${busyText}`);
  });

  await check('#11 the empty state (Ruling R10) names only the ways this user can add things; a Google user still setting up (setupNeeded) gets no Agenda at all', () => {
    const empty = model([ok(answer())]);
    assert(empty.empty, 'the fixture week is empty');
    const all = textOf(renderAgenda('en', empty, { hints: { reminders: true, voiceEvents: true } }));
    assertHas(all, ['Nothing planned', 'send the bot a voice message', 'Remind me to call Grandma at 6', 'Show next week'], 'both hints');
    assertLacks(all, ['Today', 'Tomorrow'], 'the empty state replaces the empty days');
    const remindersOnly = textOf(renderAgenda('en', empty, { hints: { reminders: true, voiceEvents: false } }));
    assertHas(remindersOnly, ['Remind me to call Grandma at 6'], 'reminders only');
    assertLacks(remindersOnly, ['voice message'], 'reminders only');
    const none = renderAgenda('ru', empty, { hints: { reminders: false, voiceEvents: false } });
    assertHas(textOf(none), ['Ничего не запланировано'], 'no hints');
    assert(!markup(none).includes('ch-empty-hint'), 'no hint at all when the plan allows neither');
    assertHas(textOf(renderAgenda('he', empty)), ['אין אירועים', 'הודעה קולית', 'תזכיר לי'], 'he hints');
    // Connected to Google with no calendars chosen: the route answers ok with nothing (spec §2.5 step 2).
    const unchosen = model([ok(googleAnswer({ calendars: [] }))]);
    assert(unchosen.empty, 'to the model, an ok answer with nothing chosen is empty');
    const setup = renderAgenda('en', unchosen, { setupNeeded: true });
    assertLacks(textOf(setup), ['Nothing planned', 'voice message', 'Remind me', 'Show next week', 'Today', 'Tomorrow'], 'setup');
    assert(!/ch-(?:fold|ghost|empty|day-head)/.test(markup(setup)), 'setup: no fold, no placeholder, no empty state, no day');
    assertLacks(textOf(renderAgenda('he', unchosen, { setupNeeded: true })), ['אין אירועים', 'היום'], 'he setup');
    assertLacks(textOf(renderAgenda('ru', unchosen, { setupNeeded: true })), ['Ничего не запланировано', 'Сегодня'], 'ru setup');
    const before = renderAgenda('en', null, { setupNeeded: true });
    assert(!before.includes('aria-busy') && !markup(before).includes('ch-ghost'), 'no placeholders before the answer either');
  });

  await check('#12 Hebrew dates show only when the route says so', () => {
    const off = model([ok(answer({ items: WEEK, hebrewDates: false }))]);
    for (const locale of LOCALES) {
      const html = markup(renderAgenda(locale, off));
      assert(!html.includes('ch-day-hebrew'), `${locale}: no Hebrew date`);
    }
    assertLacks(textOf(renderAgenda('en', off)), ['Cheshvan'], 'en off');
  });

  await check('#13 the item sheet (§7.5): title, time range, calendar, location, notes, who set it, the reminder\'s state; Google adds "Open in Google Calendar"', () => {
    const week = famcalWeek();
    const dentist = renderSheet('en', rowOf(week, 'famcal|dentist'));
    assert(/role="dialog" aria-modal="true" aria-label="Details"/.test(dentist), 'a modal dialog labelled Details');
    assertHas(
      textOf(dentist),
      [`Dentist ${ref.dayShort('en-GB', day(0))} 09:30 – 10:30`, 'Calendar Family', 'Location Clinic on Herzl St', 'Notes Bring the X-rays Ask about the night guard', 'Close'],
      'dentist',
    );
    assert(dentist.includes('class="ch-when-time" dir="ltr">09:30 – 10:30<'), 'the time range is dir="ltr"');
    assert(dentist.includes('Bring the X-rays\nAsk about the night guard'), 'the notes keep their line break');
    assertLacks(textOf(dentist), ['Open in Google Calendar', 'Reminder'], 'dentist');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|vitamins'))), ['Reminder · Every day', 'Done at 08:10'], 'done today');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|vitamins'), day(1))), ['Done'], 'done another day');
    assertLacks(textOf(renderSheet('en', rowOf(week, 'famcal|vitamins'), day(1))), ['Done at'], 'done another day');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|snoozed'))), ['Snoozed until 15:30'], 'snoozed');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|form'))), ['Not done yet'], 'open');
    assertHas(textOf(renderSheet('ru', rowOf(week, 'famcal|challah'))), ['Время ещё не пришло', 'От: Noa'], 'later (ru)');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|for-noa'))), ['For Noa'], 'for the partner');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|concert'))), [`${ref.dayTime('en-GB', at(0, '22:00'))} – ${ref.dayTime('en-GB', at(1, '02:00'))}`], 'across midnight');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|trip'))), ['Tue 20 – Thu 22 Oct All day'], 'all-day, three days');
    assertHas(textOf(renderSheet('he', rowOf(week, 'famcal|dentist'))), ['יומן Family', 'מיקום Clinic on Herzl St', 'הערות', 'סגירה'], 'he sheet');
    const dinner = renderSheet('en', rowOf(googleWeek(), 'google|dinner'));
    assertHas(textOf(dinner), ['Calendar Google · Family', 'Open in Google Calendar'], 'Google sheet');
    assertLacks(dinner, [HTML_LINK], 'the link is opened through Telegram, never written into the page');
    assertHas(textOf(renderSheet('ru', rowOf(googleWeek(), 'google|dinner'))), ['Открыть в Google Календаре'], 'ru Google sheet');
    assertLacks(textOf(renderSheet('en', rowOf(googleWeek(), 'google|bday'))), ['Open in Google Calendar'], 'no link, no button');
  });

  await check('#14 accessibility in the markup: every tap a type="button", every icon hidden, no text under 11 px, no tap under 44 px, logical properties only, reduced motion; the colours fall back to globals.css\'s brand tokens, and the page root takes the theme\'s background', () => {
    const html = renderAgenda('en', famcalWeek()) + renderSheet('en', rowOf(famcalWeek(), 'famcal|dentist'));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    assert(buttons.length > 20 && buttons.every((b) => b.includes('type="button"')), `buttons: ${show(buttons.filter((b) => !b.includes('type="button"')))}`);
    const blocks = (html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []).filter((b) => /<(?:div|p|h\d|ul|li|section|dl)[\s>]/.test(b));
    assert(blocks.length === 0, `block elements inside a button (only phrasing content is valid): ${show(blocks.slice(0, 2))}`);
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    assert(svgs.length > 5 && svgs.every((s) => s.includes('aria-hidden="true"')), 'icons are aria-hidden');
    const css = HOME_THEME_CSS + AGENDA_CSS;
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length > 10 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px (so the floor is checkable)');
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    for (const selector of ['.ch-btn', '.ch-row', '.ch-more', '.ch-sheet-close', '.ch-sheet-action']) {
      const min = /min-height:\s*(\d+)px/.exec(rule(selector));
      assert(min && Number(min[1]) >= 44, `${selector} min-height ${min?.[1]}`);
    }
    assert(/min-width:\s*44px/.test(rule('.ch-btn')), '.ch-btn min-width 44px');
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'a reduced-motion rule');
    assert(!/:hover/.test(css), 'no hover styles');
    // §7.1 Look: Telegram's theme params over globals.css's tokens, so the brand palette lives in one place.
    const globals = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
    const defined = new Set([...globals.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
    const read = [...new Set([...HOME_THEME_CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))].filter((n) => !/^--(?:tg|ch)-/.test(n));
    assert(read.length >= 4 && read.every((n) => defined.has(n)), `the fallbacks read ${show(read)}, globals.css defines ${show(read.filter((n) => defined.has(n)))}`);
    for (const [token, brand] of [['--ch-bg', '--bg-white'], ['--ch-text', '--text-primary'], ['--ch-accent', '--brand-primary-dark'], ['--ch-button', '--brand-primary-dark']]) {
      assert(new RegExp(`${token}: var\\(--tg-theme-[\\w-]+, (?:var\\(--tg-theme-[\\w-]+, )?var\\(${brand}\\)\\)`).test(HOME_THEME_CSS), `${token} falls back to ${brand}`);
    }
    assert(/\.ch-home\[data-theme='dark'\] \{[^}]*--ch-button: var\(--tg-theme-button-color, var\(--brand-primary\)\);/.test(HOME_THEME_CSS), 'the dark button falls back to --brand-primary');
    // The home scrolls the document: the root behind an iOS bounce takes the theme's background.
    assert(/\nhtml:has\(\.ch-home\) \{\s*background-color: var\(--tg-theme-bg-color, var\(--bg-white\)\);\s*\}/.test(HOME_THEME_CSS), 'the root, light');
    assert(/\nhtml:has\(\.ch-home\[data-theme='dark'\]\) \{\s*background-color: var\(--tg-theme-bg-color, #15151d\);\s*color-scheme: dark;\s*\}/.test(HOME_THEME_CSS), 'the root, dark');
  });

  await check('#15 every date and time follows the route\'s timezone, never the device clock (the same markup in four process zones, Los Angeles included)', () => {
    // Child processes: Intl formatters take the process zone when they are built, and
    // the view caches them, so switching TZ inside this process would prove nothing.
    const outputs = new Map<string, string>();
    for (const zone of ['UTC', 'Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      const run = spawnSync(process.execPath, [nodeRequire.resolve('tsx/cli'), __filename], {
        cwd: ROOT,
        env: { ...process.env, TZ: zone, SMOKE_HOME_RENDER_DUMP: '1' },
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert(run.status === 0 && /^\d+ [0-9a-f]{64} true\n$/.test(run.stdout), `the ${zone} run failed: ${show((run.stderr || run.stdout).slice(0, 300))}`);
      outputs.set(zone, run.stdout.trim());
    }
    const distinct = new Set(outputs.values());
    assert(distinct.size === 1, `the markup changed with the process zone: ${show([...outputs.entries()])}`);
  });

  // ---- Real React: taps, the sheet, focus ----

  installWindow();

  await check('#16 a tap selects the row through the container\'s onSelect and opens the sheet; closing hands back null and focus returns to the row; AgendaView never touches Telegram\'s BackButton (the container\'s one button)', () => {
    const tg = fakeTelegram();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const seen: (string | null)[] = [];
    const m = mount(interactive('en', famcalWeek(), { seen }));
    try {
      const dentist = button(m.container, 'Dentist');
      dentist.focus();
      m.click(dentist);
      assert(show(seen) === show(['famcal|dentist']), `onSelect: ${show(seen)}`);
      const dialogs = byRole(m.container, 'dialog');
      assert(dialogs.length === 1 && dialogs[0].getAttribute('aria-modal') === 'true', 'one modal dialog');
      assert(dialogs[0].textContent.includes('Clinic on Herzl St'), 'the dentist\'s details');
      assert(fakeDocument.activeElement === dialogs[0], 'focus moved into the sheet');
      m.click(button(dialogs[0], 'Close'));
      assert(show(seen) === show(['famcal|dentist', null]), `closing: ${show(seen)}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the sheet closed');
      assert(fakeDocument.activeElement === dentist, 'focus is back on the row');
      assert(!tg.calls.some((c) => c.startsWith('BackButton')), `AgendaView made BackButton calls: ${show(tg.calls)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#17 in a browser, the Close button, Escape and a tap on the scrim each close the sheet', () => {
    fakeWindow.Telegram = undefined;
    const m = mount(interactive('he', famcalWeek()));
    try {
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1, 'open');
      m.click(button(byRole(m.container, 'dialog')[0], 'סגירה'));
      assert(byRole(m.container, 'dialog').length === 0, 'Close closed it');
      m.click(button(m.container, 'Football practice'));
      m.key(byRole(m.container, 'dialog')[0], 'Escape');
      assert(byRole(m.container, 'dialog').length === 0, 'Escape closed it');
      m.click(button(m.container, 'Send the school form'));
      const scrim = byClass(m.container, 'ch-sheet-backdrop');
      assert(scrim.length === 1, 'a scrim');
      m.click(scrim[0]);
      assert(byRole(m.container, 'dialog').length === 0, 'the scrim closed it');
    } finally {
      m.unmount();
    }
  });

  await check('#18 "Open in Google Calendar" goes through Telegram\'s openLink; outside Telegram, a new tab', () => {
    const tg = fakeTelegram();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const m = mount(interactive('en', googleWeek()));
    try {
      m.click(button(m.container, 'Dinner with the Cohens'));
      m.click(button(byRole(m.container, 'dialog')[0], 'Open in Google Calendar'));
      assert(tg.calls.includes(`openLink(${HTML_LINK})`), `calls: ${show(tg.calls)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    const b = mount(interactive('en', googleWeek()));
    try {
      b.click(button(b.container, 'Yoga'));
      b.click(button(byRole(b.container, 'dialog')[0], 'Open in Google Calendar'));
      assert(show(openedWindows) === show(['https://www.google.com/calendar/event?eid=eW9nYQ']), `window.open: ${show(openedWindows)}`);
    } finally {
      b.unmount();
    }
  });

  await check('#19 the buttons call the container: Show next week, Retry with its source, Choose again; "N more" opens the rest of the card', () => {
    const calls: string[] = [];
    const props = {
      onShowNextWeek: () => calls.push('nextWeek'),
      onRetry: (s: string) => calls.push(`retry:${s}`),
      onChooseCalendars: () => calls.push('choose'),
    };
    const extra = ['a', 'b', 'c', 'd'].map((k, i) =>
      item(`old-${k}`, { kind: 'reminder', title: `Old reminder ${k}`, start: at(-3 - i, '09:00'), reminder: rem({ open: true, openSince: day(-3 - i) }) }),
    );
    const famcalError = model([ok(answer({ sources: { famcal: { status: 'error' } }, partner: null, calendars: [] }))]);
    const m = mount(interactive('en', famcalError, props));
    try {
      m.click(button(m.container, 'Retry'));
      m.click(button(m.container, 'Show next week'));
    } finally {
      m.unmount();
    }
    const gone = model([ok(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    const g = mount(interactive('en', gone, props));
    try {
      g.click(button(g.container, 'Choose again'));
    } finally {
      g.unmount();
    }
    const partial = model([ok(googleAnswer({ items: { [day(0)]: [DINNER] }, sources: { google: { status: 'ok', partial: { failed: 0, truncated: 1 } } } }))]);
    const p = mount(interactive('en', partial, props));
    try {
      p.click(button(p.container, 'Retry'));
    } finally {
      p.unmount();
    }
    assert(show(calls) === show(['retry:famcal', 'nextWeek', 'choose', 'retry:google']), `calls: ${show(calls)}`);

    const seven = model([ok(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, ...extra] }))]);
    assert(seven.stillOpen?.shown.length === 5 && seven.stillOpen.more.length === 3, 'the fixture has 8 open');
    const c = mount(interactive('ru', seven));
    try {
      const card = byClass(c.container, 'ch-card')[0];
      assert(byClass(card, 'ch-row-li').length === 5, '5 shown');
      const more = button(card, 'Ещё 3');
      assert(more.getAttribute('aria-expanded') === 'false', 'aria-expanded');
      c.click(more);
      assert(byClass(card, 'ch-row-li').length === 8, `all 8 after "Ещё 3": ${byClass(card, 'ch-row-li').length}`);
      assert(!card.textContent.includes('Ещё 3'), 'the button is gone');
    } finally {
      c.unmount();
    }
  });

  await check('#20 an open sheet shows the latest copy of its item after a refetch; with no model (a store drop) there is no sheet, whatever the container still holds', () => {
    const week = famcalWeek();
    const form = rowOf(week, 'famcal|form');
    const view = (agenda: AgendaModel | null) => inHome('en', createElement(AgendaView, agendaProps(agenda, { selected: form })));
    const m = mount(view(week));
    try {
      assert(byRole(m.container, 'dialog')[0]?.textContent.includes('Not done yet'), 'open: not done yet');
      // A foreground refetch: the partner ticked it off meanwhile.
      const done = item('form', { ...FORM, reminder: rem({ done: true, doneAt: at(0, '13:20') }) });
      m.render(view(model([ok(answer({ items: { ...WEEK, [day(0)]: [VITAMINS, DENTIST, done, SNOOZED, FOOTBALL, CONCERT] } }))])));
      assert(byRole(m.container, 'dialog')[0]?.textContent.includes('Done at 13:20'), `after the refetch: ${show(byRole(m.container, 'dialog')[0]?.textContent)}`);
      // Midnight, or other facts: the store drops and the model is null until the next answer.
      m.render(view(null));
      assert(byRole(m.container, 'dialog').length === 0, 'no model, no sheet');
    } finally {
      m.unmount();
    }
  });

  await check('#21 React logged no warning in any render (keys, nesting, attributes)', () => {
    assert(reactWarnings.length === 0, `warnings: ${show(reactWarnings.slice(0, 5))}`);
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
