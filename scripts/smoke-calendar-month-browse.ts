// Smoke test for the Month's browse layout (Plan E, Task E6; spec §7.4 Browse, §5's month
// windows, §7.7, §7.8; Rulings R11 and R12; Plan E Rulings 3, 4, 6, 7 and 8):
// app/[locale]/dashboard/MonthBrowse.tsx.
//
// The months get their data the way the container (E8) will feed them: range answers for
// month windows go through D3's real reducer, and E5's monthModels builds each month.
// MonthBrowse renders in en, he and ru through next-intl with the real messages. It checks:
//  - the markup: the sticky bar (the month in view with its year and Hebrew months, the
//    Today button, the weekday row in week-start order for 0, 1 and 6), Ruling 8's titles
//    with each month's Hebrew range, the cells (Ruling 3's head line and Hebrew month line,
//    the chips coloured by whose, done ones struck, daily reminders left out, bars with
//    their continuation shapes, "+N"), the cell labels ("Thursday, 15 October, 4 Cheshvan,
//    3 items, 1 from Noa"), aria-current and aria-hidden, dir="rtl" in Hebrew;
//  - no free-looking cell while a month loads or failed (§5), and the notices as overlays
//    (Ruling 4): busy, an error, calendars gone, partial, and a reconnect with no pill;
//  - the block sizes: every month at monthBlockPx, near and far alike, for 4-, 5- and
//    6-row months, with and without the Hebrew line;
//  - the CSS: nothing under 11 px, the 44 px Today button, logical properties only, the
//    sticky top under the safe areas, overflow-x: clip on the root and overflow: hidden
//    only on text leaves, no transform or filter, the reduced-motion rule, no hover, and
//    only the theme's tokens;
//  - in real React (react-dom/client with act on a small fake DOM that lays the months out
//    from their rendered block sizes, with a fake IntersectionObserver, a fake scroll, fake
//    frames and a fake matchMedia): the opening scroll calls, with and without the peek;
//    the grids near the start before any observer fires; the near months, coalesced; the
//    month in view as the page scrolls, one measure a frame; the Today button and its
//    smooth or instant scroll; a tap on a day; Retry and Choose again; the narrow screen's
//    chips, three overlapping bars included; the re-anchoring when the window's first
//    month, the week start or the Hebrew line changes, and when the list moves in the page
//    (a row coming above it); a sticky region above the bar (E8's --ch-top-h); the
//    fallback without IntersectionObserver; and the clean-up on unmount;
//  - client-safe imports: no server module, no @hebcal/core, no home-client, no Telegram.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-month-browse.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-month-browse.ts

// The view first: the import-rule check walks what it loads.
import { MonthBrowse, MONTH_BROWSE_CSS, type MonthBrowseProps } from '../app/[locale]/dashboard/MonthBrowse';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { BROWSE_CELL_PX, monthBarPx, monthBlockPx, monthModels, monthTitlePx } from '../src/lib/calendar-view/month';
import { monthGrid, monthSpan, type MonthKey } from '../src/lib/calendar-view/grid';
import { daysInWindow, emptyStore, reduceStore, type CalendarStore, type GoogleStatus, type StoreAction } from '../src/lib/calendar-view/store';
import { compareItems, type CalendarDTO, type DayKey, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse, type SourceName, type WeekStart } from '../src/lib/calendar-view/types';

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
const noop = () => undefined;
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
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 ----

const TZ = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';

/** A wall-clock time in Israel on a day, as UTC ISO (IDT, UTC+3, until 25 October; IST, UTC+2, from then). */
function at(day: DayKey, hhmm: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - (day < '2026-10-25' ? 3 : 2), min)).toISOString();
}

const MY_CAL: ItemCalendarDTO = { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5', mine: true, inLegend: true };
const NOA_CAL: ItemCalendarDTO = { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa', inLegend: true };
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
const timed = (id: string, title: string, day: DayKey, from: string, to: string, calendar = MY_CAL) => item(id, { title, start: at(day, from), end: at(day, to), calendar });

const CALL_MOM = item('call-mom', { kind: 'reminder', title: 'Call Mom', start: at('2026-10-06', '20:00'), reminder: rem({ done: true, doneAt: at('2026-10-06', '20:05') }) });
const GYM = timed('gym', 'Gym', '2026-10-14', '07:00', '08:00');
const PLUMBER = item('plumber', { kind: 'reminder', title: 'Call the plumber', start: at('2026-10-14', '11:00'), reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const PILATES = timed('pilates', 'Pilates', '2026-10-14', '19:00', '20:00', NOA_CAL);
const VITAMINS = item('vitamins', { kind: 'reminder', title: 'Take vitamins', start: at(TODAY, '08:00'), recurring: true, repeatsDaily: true, reminder: rem({ done: true, doneAt: at(TODAY, '08:10') }) });
const DENTIST = timed('dentist', 'Dentist', TODAY, '09:30', '10:30');
const FORM = item('form', { kind: 'reminder', title: 'Send the school form', start: at(TODAY, '13:00'), reminder: rem({ open: true }) });
const FOOTBALL = timed('football', 'Football practice', TODAY, '17:00', '18:00', NOA_CAL);
const GRANDMA = item('grandma', { title: 'Grandma visits', start: '2026-10-16', end: '2026-10-17', allDay: true, tz: null, calendar: NOA_CAL });
const BIRTHDAY = item('birthday', { title: 'Noa’s birthday', start: '2026-10-20', end: '2026-10-21', allDay: true, tz: null });
const EILAT = item('eilat', { title: 'Eilat trip', start: '2026-10-25', end: '2026-10-30', allDay: true, tz: null });
const SNORKEL = timed('snorkel', 'Snorkeling', '2026-10-26', '10:00', '12:00', NOA_CAL);
const SPA = timed('spa', 'Spa', '2026-10-26', '16:00', '17:30', NOA_CAL);
const PORT = timed('port', 'Dinner at the port', '2026-10-26', '20:00', '21:30');

const OCTOBER: Record<DayKey, ItemDTO[]> = {
  '2026-10-06': [CALL_MOM],
  '2026-10-14': [GYM, PLUMBER, PILATES],
  [TODAY]: [VITAMINS, DENTIST, FORM, FOOTBALL],
  '2026-10-16': [GRANDMA],
  '2026-10-20': [BIRTHDAY],
  '2026-10-25': [EILAT],
  '2026-10-26': [EILAT, SNORKEL, SPA, PORT],
  '2026-10-27': [EILAT],
  '2026-10-28': [EILAT],
  '2026-10-29': [EILAT],
};

/** A month's own days, [1st, 1st of the next month), worked out here rather than with grid.ts. */
function windowOf(month: MonthKey): { from: DayKey; to: DayKey } {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
}

type AnswerOpts = { weekStart?: WeekStart; hebrewDates?: boolean; google?: GoogleStatus };

/** A range answer for one month window: FamCal ok, or (with `google`) a Google user's answer. */
function answer(month: MonthKey, items: Record<DayKey, ItemDTO[]>, o: AnswerOpts = {}): RangeResponse {
  const { from, to } = windowOf(month);
  return {
    tz: TZ,
    today: TODAY,
    weekStart: o.weekStart ?? 0,
    hebrewDates: o.hebrewDates ?? true,
    from,
    to,
    sources: o.google ? { google: o.google } : { famcal: { status: 'ok' } },
    partner: o.google ? null : { name: 'Noa' },
    calendars: o.google ? [{ id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true }] : LEGEND,
    days: daysInWindow(from, to).map((date) => ({ date, items: [...(items[date] ?? [])].sort(compareItems) })),
  };
}

const ok = (response: RangeResponse): StoreAction => ({ type: 'response', response, epoch: 0 });
const windowFailed = (month: MonthKey, kind: 'busy' | 'error', sources: SourceName[] = ['famcal']): StoreAction => ({ type: 'windowFailed', ...windowOf(month), sources, kind, epoch: 0 });
const storeOf = (actions: StoreAction[]): CalendarStore => actions.reduce(reduceStore, emptyStore());

/** October answered, September not asked yet (loading), November busy (429), December an error (500). */
function famcalStore(o: AnswerOpts = {}): CalendarStore {
  return storeOf([ok(answer('2026-10', OCTOBER, o)), windowFailed('2026-11', 'busy'), windowFailed('2026-12', 'error')]);
}

const DINNER: ItemDTO = item('dinner', {
  source: 'google',
  readOnly: true,
  tz: null,
  title: 'Dinner with the Cohens',
  start: '2026-10-15T19:30:00+03:00',
  end: '2026-10-15T22:00:00+03:00',
  calendar: { id: 'family@group.calendar.google.com', name: 'Family', color: '#7986CB', mine: true, inLegend: true },
  htmlLink: null,
  birthday: false,
});

/** A Google user: October partial, November's calendars gone, December asking for a reconnect. */
function googleStore(): CalendarStore {
  return storeOf([
    ok(answer('2026-10', { [TODAY]: [DINNER] }, { google: { status: 'ok', partial: { failed: 1, truncated: 0 } } })),
    ok(answer('2026-11', {}, { google: { status: 'error', reason: 'calendars_gone' } })),
    ok(answer('2026-12', {}, { google: { status: 'reconnect', reason: 'token' } })),
  ]);
}

// ---- Rendering ----

function inIntl(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}

/** The home's frame around the view (CalendarHome's root and its tokens), for the static markup. */
function inHome(locale: Locale, el: ReactElement): ReactElement {
  return inIntl(locale, createElement('div', { className: 'ch-home', 'data-theme': 'light' }, createElement('style', null, HOME_THEME_CSS), el));
}

function browseProps(store: CalendarStore, o: Partial<MonthBrowseProps> = {}): MonthBrowseProps {
  const facts = store.facts;
  assert(facts, 'the fixture pinned no facts');
  return {
    months: monthSpan(facts.today),
    today: facts.today,
    weekStart: facts.weekStart,
    hebrewDates: facts.hebrewDates,
    getMonth: monthModels(store),
    start: { month: '2026-10', peek: true },
    onNearMonths: noop,
    onMonthInView: noop,
    onPickDay: noop,
    onRetryMonth: noop,
    onChooseCalendars: noop,
    ...o,
  };
}

const renderBrowse = (locale: Locale, props: MonthBrowseProps) => renderToString(inHome(locale, createElement(MonthBrowse, props)));

/** The markup without the style sheets (their class names would match anything). */
const markup = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

function decode(text: string): string {
  return text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** A month's block in the markup: from its opening tag to the next month's. */
function monthHtml(html: string, month: MonthKey): string {
  const open = `<div class="ch-mb-month" data-month="${month}"`;
  const start = html.indexOf(open);
  assert(start >= 0, `no block for ${month}`);
  const next = html.indexOf('<div class="ch-mb-month" data-month="', start + open.length);
  return html.slice(start, next < 0 ? undefined : next);
}

type CellView = { cls: string[]; label: string; today: boolean; inner: string };

/** The day buttons in a piece of markup, in order. */
function cellsOf(html: string): CellView[] {
  return [...html.matchAll(/<button type="button" class="(ch-mb-cell[^"]*)" aria-label="([^"]*)"( aria-current="date")?>([\s\S]*?)<\/button>/g)].map((m) => ({
    cls: m[1].split(' '),
    label: decode(m[2]),
    today: !!m[3],
    inner: m[4],
  }));
}

function cellOf(html: string, labelStart: string): CellView {
  const found = cellsOf(html).filter((c) => c.label.startsWith(labelStart));
  assert(found.length === 1, `one cell labelled ${show(labelStart)}: ${show(cellsOf(html).map((c) => c.label).slice(0, 8))}`);
  return found[0];
}

/** A cell's chips: their classes and their text. */
const chipsOf = (cell: CellView) => [...cell.inner.matchAll(/<span class="(ch-mb-chip[^"]*)" dir="auto">([^<]*)<\/span>/g)].map((m) => ({ cls: m[1], text: decode(m[2]) }));
const headOf = (cell: CellView) => {
  const m = /<span class="ch-mb-head" aria-hidden="true"><span class="ch-mb-day" dir="ltr">(\d+)<\/span>(?:<span class="ch-mb-hday">([^<]*)<\/span>)?<\/span><span class="ch-mb-hmonth" aria-hidden="true">([^<]*)<\/span>/.exec(cell.inner);
  assert(m, `no head line in ${show(cell.inner.slice(0, 300))}`);
  return { day: m[1], hebrewDay: m[2] ?? '', hebrewMonth: m[3] };
};
const moreOf = (cell: CellView) => /<span class="ch-mb-more">([^<]*)<\/span>/.exec(cell.inner)?.[1] ?? null;

function titleOf(html: string, month: MonthKey) {
  const m = /<h2 class="ch-mb-title"><span class="ch-mb-title-month">([^<]*)<\/span>(?:<span class="ch-visually-hidden">, <\/span><span class="ch-mb-title-hebrew">([^<]*)<\/span>)?<\/h2>/.exec(monthHtml(html, month));
  assert(m, `no title for ${month}`);
  return { month: decode(m[1]), hebrew: m[2] === undefined ? null : decode(m[2]) };
}

function barOf(html: string) {
  const m = /<div class="ch-mb-bar"><div class="ch-mb-bar-row"><p class="ch-mb-bar-text" aria-hidden="true"><span class="ch-mb-bar-month">([^<]*)<\/span>(?:<span class="ch-mb-bar-hebrew">([^<]*)<\/span>)?<\/p>(<button type="button" class="ch-mb-today">([^<]*)<\/button>)?<\/div><div class="ch-mb-weekdays" aria-hidden="true">((?:<span class="ch-mb-weekday">[^<]*<\/span>)*)<\/div><\/div>/.exec(html);
  assert(m, `no sticky bar in ${show(markup(html).slice(0, 600))}`);
  return { month: m[1], hebrew: m[2] ?? null, today: m[4] ?? null, weekdays: [...m[5].matchAll(/<span class="ch-mb-weekday">([^<]*)<\/span>/g)].map((w) => w[1]) };
}

/** Each month's block-size in the markup, and its body's. */
function blockSizes(html: string): { month: MonthKey; block: number; body: number; far: boolean }[] {
  return [...html.matchAll(/<div class="ch-mb-month" data-month="(\d{4}-\d{2})" style="block-size:(\d+)px">/g)].map((m) => {
    const body = /<div class="ch-mb-body( ch-mb-far)?" style="block-size:(\d+)px"/.exec(monthHtml(html, m[1]));
    assert(body, `no body for ${m[1]}`);
    return { month: m[1], block: Number(m[2]), body: Number(body[2]), far: !!body[1] };
  });
}

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules), as in smoke-calendar-home-render.ts ----
// It also lays the browse out: the list of months starts LAYOUT.listTop px down the
// document, each month is as tall as its rendered block-size, the sticky bar sticks at
// LAYOUT.safeTop plus LAYOUT.topH (what sticks above it: E8's header and tab bar,
// --ch-top-h; 0 unless a check says so), and each title's scroll-margin-top is those plus
// the bar, as the CSS says (#12 checks the CSS).

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };

const LAYOUT = { listTop: 300, safeTop: 20, topH: 0, width: 390 };

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
  getBoundingClientRect() {
    return layoutRect(this);
  }
}

const hasClass = (el: FakeNode, cls: string) => el instanceof FakeElement && el.className.split(' ').includes(cls);
function closest(el: FakeNode | null, cls: string): FakeElement | null {
  for (let n = el; n; n = n.parentNode) if (hasClass(n, cls)) return n as FakeElement;
  return null;
}
const px = (value: unknown) => Number.parseFloat(String(value ?? '')) || 0;
/** The bar's height, as MonthBrowse sets it on its root (--ch-mb-bar). */
const barPxOf = (el: FakeNode) => px(closest(el, 'ch-mb')?.style['--ch-mb-bar']);

function rect(top: number, height: number) {
  return { top, bottom: top + height, left: 0, right: LAYOUT.width, width: LAYOUT.width, height, x: 0, y: top };
}

/** A month block's top in the list, from the block sizes rendered above it. */
function sectionTop(section: FakeNode): number {
  let y = 0;
  for (const sibling of section.parentNode?.childNodes ?? []) {
    if (sibling === section) break;
    y += px((sibling as FakeElement).style?.blockSize);
  }
  return y;
}

function layoutRect(el: FakeElement) {
  const scrollY = fakeWindow.scrollY as number;
  if (hasClass(el, 'ch-mb-months')) {
    const height = el.childNodes.reduce((sum, s) => sum + px((s as FakeElement).style?.blockSize), 0);
    return rect(LAYOUT.listTop - scrollY, height);
  }
  if (hasClass(el, 'ch-mb-bar')) {
    const bar = barPxOf(el);
    return rect(Math.max(LAYOUT.safeTop + LAYOUT.topH, LAYOUT.listTop - bar - scrollY), bar);
  }
  if (hasClass(el, 'ch-mb-title') && el.parentNode) {
    return rect(LAYOUT.listTop + sectionTop(el.parentNode) - scrollY, px(closest(el, 'ch-mb')?.style['--ch-mb-title']));
  }
  return rect(0, 0);
}

const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML', clientHeight: 800 },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
};
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

/** window.addEventListener's listeners (scroll and resize), with their options. */
type WindowListener = { type: string; fn: () => void; options: unknown };
const windowListeners: WindowListener[] = [];
/** Every window.scrollTo call: the top and the behaviour ('plain' for the two-number form). */
const scrollCalls: { top: number; behavior: string }[] = [];
/** The frames requested and not run yet. */
const frames = new Map<number, () => void>();
let nextFrameId = 1;
/** The media queries' answers, and their change listeners. */
const media = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<() => void>>();

const NARROW = '(max-width: 360px)';
const REDUCED = '(prefers-reduced-motion: reduce)';

function fakeMediaList(query: string): Row {
  const set = () => {
    if (!mediaListeners.has(query)) mediaListeners.set(query, new Set());
    return mediaListeners.get(query) as Set<() => void>;
  };
  return {
    media: query,
    get matches() {
      return media.get(query) === true;
    },
    addEventListener: (_type: string, fn: () => void) => void set().add(fn),
    removeEventListener: (_type: string, fn: () => void) => void set().delete(fn),
    addListener: (fn: () => void) => void set().add(fn),
    removeListener: (fn: () => void) => void set().delete(fn),
  };
}

/** A fake IntersectionObserver: it records what it observes; a check fires its entries. */
class FakeIO {
  static all: FakeIO[] = [];
  observed = new Set<FakeElement>();
  disconnected = false;
  constructor(
    public callback: (entries: Row[], observer: FakeIO) => void,
    public options: Row = {},
  ) {
    FakeIO.all.push(this);
  }
  observe(el: FakeElement) {
    this.observed.add(el);
  }
  unobserve(el: FakeElement) {
    this.observed.delete(el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  /** One callback with an entry for each observed month named in `states`. */
  fire(states: Record<MonthKey, boolean>) {
    const entries = [...this.observed]
      .filter((el) => (el.getAttribute('data-month') ?? '') in states)
      .map((el) => ({ target: el, isIntersecting: states[el.getAttribute('data-month') ?? ''] }));
    React.act(() => this.callback(entries, this));
  }
}

const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  location: { hash: '' },
  scrollY: 0,
  innerHeight: 800,
  addEventListener: (type: string, fn: () => void, options?: unknown) => void windowListeners.push({ type, fn, options }),
  removeEventListener: (type: string, fn: () => void) => {
    const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) windowListeners.splice(i, 1);
  },
  scrollTo: (a: Row | number, b?: number) => {
    const call = typeof a === 'number' ? { top: b ?? 0, behavior: 'plain' } : { top: Number(a.top), behavior: String(a.behavior ?? 'auto') };
    scrollCalls.push(call);
    fakeWindow.scrollY = Math.max(0, call.top);
  },
  getComputedStyle: (el: FakeElement) => ({
    scrollMarginTop: hasClass(el, 'ch-mb-title') ? `${LAYOUT.safeTop + LAYOUT.topH + barPxOf(el)}px` : '0px',
  }),
  matchMedia: (query: string) => fakeMediaList(query),
  requestAnimationFrame: (fn: () => void) => {
    const id = nextFrameId++;
    frames.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id: number) => void frames.delete(id),
  setTimeout,
  clearTimeout,
  IntersectionObserver: FakeIO,
};
fakeDocument.defaultView = fakeWindow;

function installWindow() {
  const g = globalThis as Row;
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

/** A clean page: scrolled to the top, no calls, no frames, wide, motion allowed, a fresh observer class. */
function resetPage() {
  fakeWindow.scrollY = 0;
  scrollCalls.length = 0;
  frames.clear();
  media.clear();
  FakeIO.all = [];
  fakeWindow.IntersectionObserver = FakeIO;
}

/** Runs the frames requested so far (and any they request), inside act. */
function flushFrames() {
  React.act(() => {
    for (let round = 0; round < 5 && frames.size > 0; round++) {
      const batch = [...frames.values()];
      frames.clear();
      for (const run of batch) run();
    }
  });
}

/** The user scrolls to `top`: the page moves and the window gets a scroll event. */
function scrollPageTo(top: number) {
  fakeWindow.scrollY = top;
  fireScroll();
}
function fireScroll() {
  React.act(() => {
    for (const l of windowListeners.filter((x) => x.type === 'scroll')) l.fn();
  });
}

function setMedia(query: string, matches: boolean) {
  media.set(query, matches);
  React.act(() => {
    for (const fn of mediaListeners.get(query) ?? []) fn();
  });
}

type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  unmount: () => void;
};

function mount(el: ReactElement): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string) => {
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
    click: (target) => dispatch(target, 'click'),
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
const byClass = (node: FakeNode, cls: string) => elements(node).filter((e) => hasClass(e, cls));
function sectionEl(m: Mounted, month: MonthKey): FakeElement {
  const found = byClass(m.container, 'ch-mb-month').find((e) => e.getAttribute('data-month') === month);
  assert(found, `no block for ${month}`);
  return found;
}
/** The day buttons a month draws (0 for a far month). */
const dayButtons = (m: Mounted, month: MonthKey) => elements(sectionEl(m, month)).filter((e) => e.localName === 'button' && hasClass(e, 'ch-mb-cell'));
function dayButton(m: Mounted, month: MonthKey, labelStart: string): FakeElement {
  const found = dayButtons(m, month).filter((b) => (b.getAttribute('aria-label') ?? '').startsWith(labelStart));
  assert(found.length === 1, `one day button ${show(labelStart)} in ${month}`);
  return found[0];
}
const barText = (m: Mounted) => byClass(m.container, 'ch-mb-bar-month')[0]?.textContent ?? null;
const todayButton = (m: Mounted) => byClass(m.container, 'ch-mb-today')[0] ?? null;
/** The month's top in the list, from the block sizes the view rendered above it. */
const topOf = (m: Mounted, month: MonthKey) => sectionTop(sectionEl(m, month));
/** The bar's bottom, in the list's coordinates (where the reader's view starts). */
function bandTop(m: Mounted): number {
  const bar = byClass(m.container, 'ch-mb-bar')[0];
  const list = byClass(m.container, 'ch-mb-months')[0];
  return bar.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
}
/** The page offset that puts `month`'s title just under the stuck bar. */
const titleUnderBar = (m: Mounted, month: MonthKey) => LAYOUT.listTop + topOf(m, month) - (LAYOUT.safeTop + LAYOUT.topH + barPxOf(byClass(m.container, 'ch-mb-bar')[0]));

/** MonthBrowse with recording callbacks. */
function recorder() {
  const seen = { inView: [] as MonthKey[], near: [] as MonthKey[][], picked: [] as DayKey[], retried: [] as string[], chosen: 0 };
  const callbacks: Partial<MonthBrowseProps> = {
    onMonthInView: (month) => void seen.inView.push(month),
    onNearMonths: (months) => void seen.near.push(months),
    onPickDay: (day) => void seen.picked.push(day),
    onRetryMonth: (month, source) => void seen.retried.push(`${month}:${source}`),
    onChooseCalendars: () => void seen.chosen++,
  };
  return { seen, callbacks };
}

const browseIn = (locale: Locale, props: MonthBrowseProps) => inIntl(locale, createElement(MonthBrowse, props));

// ---- The CSS, as rules ----

type Rule = { selector: string; body: string };
/** The innermost rules: a rule inside @media or @keyframes comes out with its own selector. */
const cssRules = (css: string): Rule[] => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const ruleOf = (css: string, selector: string) => {
  const found = cssRules(css).filter((r) => r.selector === selector);
  assert(found.length === 1, `one ${selector} rule: ${found.length}`);
  return found[0].body;
};
const declOf = (body: string, prop: string) => new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;

async function main() {
  await check('#1 the view is client-safe: MonthBrowse loads no server module (DB, Redis, services, date-fns-tz, @hebcal/core), no home-client and no Telegram code; it reads month.ts, grid.ts, hebrew-date.ts and format.ts', () => {
    const root = path.join(ROOT, 'app/[locale]/dashboard/MonthBrowse.tsx');
    assert(require.cache[root] !== undefined, 'MonthBrowse is not in require.cache: the check would be empty');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    for (const want of ['src/lib/calendar-view/month.ts', 'src/lib/calendar-view/grid.ts', 'src/lib/calendar-view/hebrew-date.ts', 'src/lib/calendar-view/format.ts']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma|telegram-ui|calendar-view[\\/]home-client)/.test(p),
    );
    assert(forbidden.length === 0, `modules the view must not load: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#2 en: the sticky bar names the month in view with its year and Hebrew months; the titles follow Ruling 8 (the year only off today\'s year) with each month\'s Hebrew range; dir="ltr"', () => {
    const html = renderBrowse('en', browseProps(famcalStore()));
    assert(/<section class="ch-mb" dir="ltr" style="--ch-mb-bar:76px;--ch-mb-title:58px;--ch-mb-cell:92px">/.test(html), 'the root: dir="ltr" and the heights');
    const bar = barOf(html);
    assert(show([bar.month, bar.hebrew, bar.today]) === show(['October 2026', 'Tishrei – Cheshvan 5787', null]), `bar: ${show(bar)}`);
    const titles = (['2025-10', '2026-09', '2026-10', '2026-11', '2027-01', '2028-04'] as const).map((m) => titleOf(html, m));
    assert(
      show(titles) ===
        show([
          { month: 'October 2025', hebrew: 'Tishrei – Cheshvan 5786' },
          { month: 'September', hebrew: 'Elul 5786 – Tishrei 5787' },
          { month: 'October', hebrew: 'Tishrei – Cheshvan 5787' },
          { month: 'November', hebrew: 'Cheshvan – Kislev 5787' },
          { month: 'January 2027', hebrew: 'Tevet – Sh\'vat 5787' },
          { month: 'April 2028', hebrew: 'Nisan – Iyyar 5788' },
        ]),
      `titles: ${show(titles)}`,
    );
    assert((html.match(/<h2 class="ch-mb-title">/g) ?? []).length === 31, 'one h2 per month of the window (31)');
  });

  await check('#3 en cells: the labels ("Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa"), aria-current on today only, the head line\'s Hebrew day and the month line on Hebrew day 1 and the first cell (Ruling 3)', () => {
    const html = monthHtml(renderBrowse('en', browseProps(famcalStore())), '2026-10');
    const cells = cellsOf(html);
    assert(cells.length === 31, `31 day buttons: ${cells.length}`);
    const labels = ['Thursday, 15 October', 'Friday, 16 October', 'Saturday, 17 October', 'Monday, 12 October', 'Tuesday, 6 October', 'Tuesday, 20 October', 'Thursday, 1 October'].map((d) => cellOf(html, d).label);
    assert(
      show(labels) ===
        show([
          'Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa',
          'Friday, 16 October, 5 Cheshvan, 1 item, 1 from Noa',
          'Saturday, 17 October, 6 Cheshvan, nothing planned',
          'Monday, 12 October, 1 Cheshvan, nothing planned',
          'Tuesday, 6 October, 25 Tishrei, 1 item',
          'Tuesday, 20 October, 9 Cheshvan, 1 item',
          'Thursday, 1 October, 20 Tishrei, nothing planned',
        ]),
      `labels: ${show(labels)}`,
    );
    assert(show(cells.filter((c) => c.today).map((c) => c.label.slice(0, 20))) === show(['Thursday, 15 October']), 'aria-current="date" on today only');
    assert(cellOf(html, 'Thursday, 15 October').cls.includes('is-today'), 'today is marked');
    const heads = ['Thursday, 15 October', 'Monday, 12 October', 'Thursday, 1 October', 'Tuesday, 13 October'].map((d) => headOf(cellOf(html, d)));
    assert(
      show(heads) ===
        show([
          { day: '15', hebrewDay: '4', hebrewMonth: '' },
          { day: '12', hebrewDay: '1', hebrewMonth: 'Chesh.' },
          { day: '1', hebrewDay: '20', hebrewMonth: 'Tish.' },
          { day: '13', hebrewDay: '2', hebrewMonth: '' },
        ]),
      `head lines: ${show(heads)}`,
    );
    assert(cells.every((c) => /<span class="ch-mb-head" aria-hidden="true">/.test(c.inner) && /<span class="ch-mb-slots" aria-hidden="true">/.test(c.inner)), 'every head line and slot list is aria-hidden');
    const blanks = html.match(/<div class="ch-mb-cell is-blank"[^>]*>/g) ?? [];
    assert(blanks.length === 4 && blanks.every((b) => b === '<div class="ch-mb-cell is-blank" aria-hidden="true">'), `4 blank cells, aria-hidden, no button: ${show(blanks)}`);
  });

  await check('#4 en chips: whose (E4: mine filled, the partner\'s outlined), done struck through, the daily reminder left out (R11), the Eilat bar\'s shapes with its title on its first day, "+2 more" in the third slot, dir="auto"', () => {
    const html = monthHtml(renderBrowse('en', browseProps(famcalStore())), '2026-10');
    const chips = (d: string) => chipsOf(cellOf(html, d)).map((c) => `${c.cls}|${c.text}`);
    assert(
      show(chips('Thursday, 15 October')) ===
        show(['ch-mb-chip is-timed is-mine-timed|Dentist', 'ch-mb-chip is-timed is-mine-timed|Send the school form', 'ch-mb-chip is-timed is-partner-timed|Football practice']),
      `15 Oct: ${show(chips('Thursday, 15 October'))}`,
    );
    assert(!html.includes('Take vitamins'), 'the daily reminder is not drawn');
    assert(show(chips('Friday, 16 October')) === show(['ch-mb-chip is-allDay is-partner-solid|Grandma visits']), `16 Oct: ${show(chips('Friday, 16 October'))}`);
    assert(show(chips('Tuesday, 20 October')) === show(['ch-mb-chip is-allDay is-mine-solid|Noa’s birthday']), `20 Oct: ${show(chips('Tuesday, 20 October'))}`);
    assert(show(chips('Tuesday, 6 October')) === show(['ch-mb-chip is-timed is-mine-timed is-done|Call Mom']), `6 Oct: ${show(chips('Tuesday, 6 October'))}`);
    const eilat = ['Sunday, 25 October', 'Monday, 26 October', 'Tuesday, 27 October', 'Wednesday, 28 October', 'Thursday, 29 October'].map((d) => chips(d)[0]);
    assert(
      show(eilat) ===
        show([
          'ch-mb-chip is-bar is-mine-solid is-after|Eilat trip',
          'ch-mb-chip is-bar is-mine-solid is-before is-after|',
          'ch-mb-chip is-bar is-mine-solid is-before is-after|',
          'ch-mb-chip is-bar is-mine-solid is-before is-after|',
          'ch-mb-chip is-bar is-mine-solid is-before|',
        ]),
      `the Eilat bar: ${show(eilat)}`,
    );
    const busy = cellOf(html, 'Monday, 26 October');
    assert(show(chips('Monday, 26 October')) === show(['ch-mb-chip is-bar is-mine-solid is-before is-after|', 'ch-mb-chip is-timed is-partner-timed|Snorkeling']), `26 Oct: ${show(chips('Monday, 26 October'))}`);
    assert(moreOf(busy) === '+2 more' && busy.label === 'Monday, 26 October, 15 Cheshvan, 4 items, 2 from Noa', `26 Oct: ${show([moreOf(busy), busy.label])}`);
    assert(show(chips('Wednesday, 14 October').map((c) => c.split('|')[1])) === show(['Gym', 'Call the plumber', 'Pilates']) && moreOf(cellOf(html, 'Wednesday, 14 October')) === null, 'a day of 3 shows 3 chips on a wide screen');
    // Under week start 1 the trip crosses a row: its title shows again at the second row's start.
    const ws1 = monthHtml(renderBrowse('en', browseProps(famcalStore({ weekStart: 1 }))), '2026-10');
    assert(show(chipsOf(cellOf(ws1, 'Monday, 26 October'))[0]) === show({ cls: 'ch-mb-chip is-bar is-mine-solid is-before is-after', text: 'Eilat trip' }), 'the bar\'s title at a week row\'s start');
  });

  await check('#5 he: dir="rtl"; the bar, the titles and the Hebrew ranges in Hebrew with gematriya years; the labels in Hebrew; the Hebrew day in gematriya and the month line', () => {
    const html = renderBrowse('he', browseProps(famcalStore()));
    assert(/<section class="ch-mb" dir="rtl"/.test(html), 'the root is dir="rtl"');
    const bar = barOf(html);
    assert(show([bar.month, bar.hebrew]) === show(['אוקטובר 2026', 'תשרי – חשון תשפ״ז']), `bar: ${show(bar)}`);
    const titles = (['2026-09', '2026-10', '2027-01'] as const).map((m) => titleOf(html, m));
    assert(
      show(titles) === show([{ month: 'ספטמבר', hebrew: 'אלול תשפ״ו – תשרי תשפ״ז' }, { month: 'אוקטובר', hebrew: 'תשרי – חשון תשפ״ז' }, { month: 'ינואר 2027', hebrew: 'טבת – שבט תשפ״ז' }]),
      `titles: ${show(titles)}`,
    );
    const october = monthHtml(html, '2026-10');
    const labels = ['יום חמישי, 15 באוקטובר', 'יום שישי, 16 באוקטובר', 'יום שבת, 17 באוקטובר'].map((d) => cellOf(october, d).label);
    assert(
      show(labels) === show(['יום חמישי, 15 באוקטובר, ד׳ בחשון, 3 אירועים, 1 של Noa', 'יום שישי, 16 באוקטובר, ה׳ בחשון, אירוע אחד, 1 של Noa', 'יום שבת, 17 באוקטובר, ו׳ בחשון, אין אירועים']),
      `labels: ${show(labels)}`,
    );
    const heads = ['יום חמישי, 15 באוקטובר', 'יום שני, 12 באוקטובר', 'יום חמישי, 1 באוקטובר'].map((d) => headOf(cellOf(october, d)));
    assert(
      show(heads) === show([{ day: '15', hebrewDay: 'ד׳', hebrewMonth: '' }, { day: '12', hebrewDay: 'א׳', hebrewMonth: 'חשון' }, { day: '1', hebrewDay: 'כ׳', hebrewMonth: 'תשרי' }]),
      `head lines: ${show(heads)}`,
    );
    assert(moreOf(cellOf(october, 'יום שני, 26 באוקטובר')) === 'עוד 2', '"+N" in Hebrew');
  });

  await check('#6 ru: the titles in the capitalised nominative without "г." (Ruling 8), the Hebrew ranges in the nominative and the labels in the genitive (R9), "Noa: 1", the month line', () => {
    const html = renderBrowse('ru', browseProps(famcalStore()));
    const bar = barOf(html);
    assert(show([bar.month, bar.hebrew]) === show(['Октябрь 2026', 'Тишрей – Хешван 5787']), `bar: ${show(bar)}`);
    const titles = (['2026-09', '2026-10', '2027-01'] as const).map((m) => titleOf(html, m));
    assert(
      show(titles) === show([{ month: 'Сентябрь', hebrew: 'Элул 5786 – Тишрей 5787' }, { month: 'Октябрь', hebrew: 'Тишрей – Хешван 5787' }, { month: 'Январь 2027', hebrew: 'Тевет – Шват 5787' }]),
      `titles: ${show(titles)}`,
    );
    const october = monthHtml(html, '2026-10');
    const labels = ['четверг, 15 октября', 'пятница, 16 октября', 'суббота, 17 октября'].map((d) => cellOf(october, d).label);
    assert(
      show(labels) === show(['четверг, 15 октября, 4 хешвана, 3 события, Noa: 1', 'пятница, 16 октября, 5 хешвана, 1 событие, Noa: 1', 'суббота, 17 октября, 6 хешвана, ничего не запланировано']),
      `labels: ${show(labels)}`,
    );
    assert(show(headOf(cellOf(october, 'понедельник, 12 октября'))) === show({ day: '12', hebrewDay: '1', hebrewMonth: 'хешв.' }), 'the month line on Hebrew day 1');
    assert(show(headOf(cellOf(october, 'четверг, 1 октября'))) === show({ day: '1', hebrewDay: '20', hebrewMonth: 'тишр.' }), 'the month line on the first cell');
    assert(moreOf(cellOf(october, 'понедельник, 26 октября')) === 'Ещё 2', '"+N" in Russian');
  });

  await check('#7 the weekday row in week-start order (Ruling 8) for week starts 0, 1 and 6 in en, he and ru, aria-hidden; each month\'s first row starts on the week start', () => {
    const want: Record<Locale, Record<0 | 1 | 6, string>> = {
      en: { 0: 'S M T W T F S', 1: 'M T W T F S S', 6: 'S S M T W T F' },
      he: { 0: 'א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳', 1: 'ב׳ ג׳ ד׳ ה׳ ו׳ ש׳ א׳', 6: 'ש׳ א׳ ב׳ ג׳ ד׳ ה׳ ו׳' },
      ru: { 0: 'Вс Пн Вт Ср Чт Пт Сб', 1: 'Пн Вт Ср Чт Пт Сб Вс', 6: 'Сб Вс Пн Вт Ср Чт Пт' },
    };
    for (const ws of [0, 1, 6] as const) {
      const store = famcalStore({ weekStart: ws });
      for (const locale of LOCALES) {
        const html = renderBrowse(locale, browseProps(store));
        const row = barOf(html).weekdays.join(' ');
        assert(row === want[locale][ws], `${locale} ws ${ws}: ${row}`);
        // October 2026 starts on a Thursday: its first row has (4 - ws + 7) % 7 blank cells.
        const firstRow = /<div class="ch-mb-row">([\s\S]*?)<\/div><div class="ch-mb-row">/.exec(monthHtml(html, '2026-10'))?.[1] ?? '';
        const blanks = (firstRow.match(/is-blank/g) ?? []).length;
        assert(blanks === (4 - ws + 7) % 7, `${locale} ws ${ws}: ${blanks} blanks before the 1st`);
      }
    }
  });

  await check('#8 no free-looking cell while a month loads or failed (§5): September loading shows placeholders, a model-less month too; November busy and December\'s error are dimmed under a centred pill with Retry; none reads "nothing planned"', () => {
    const html = renderBrowse('en', browseProps(famcalStore(), { start: { month: '2026-11', peek: false } }));
    const september = cellsOf(monthHtml(renderBrowse('en', browseProps(famcalStore())), '2026-09'));
    assert(september.length === 30 && september.every((c) => c.cls.includes('is-loading') && c.inner.includes('ch-mb-ghost') && c.label.endsWith(', loading')), `September: ${show(september.slice(0, 2))}`);
    const modelLess = cellsOf(monthHtml(renderBrowse('en', browseProps(famcalStore(), { getMonth: () => null })), '2026-10'));
    assert(modelLess.length === 31 && modelLess.every((c) => c.cls.includes('is-loading') && c.inner.includes('ch-mb-ghost') && !c.inner.includes('ch-mb-chip')), 'with no model, every day of the month is loading');
    assert(modelLess.filter((c) => c.today).length === 1, 'today is still marked');
    for (const [month, pill, count] of [
      ['2026-11', 'Busy right now, try again in a minute', 30],
      ['2026-12', 'Couldn’t load this month', 31],
    ] as const) {
      const block = monthHtml(html, month);
      const cells = cellsOf(block);
      assert(cells.length === count && cells.every((c) => c.cls.includes('is-failed') && c.label.endsWith(', couldn’t load') && !c.inner.includes('ch-mb-ghost')), `${month} dimmed: ${show(cells.slice(0, 1))}`);
      const overlay = /<div class="ch-mb-overlay is-centre"><div class="ch-mb-pill"><span class="ch-mb-pill-text">([^<]*)<\/span><button type="button" class="ch-btn ch-mb-pill-action">([^<]*)<\/button><\/div><\/div>/.exec(block);
      assert(overlay && show([decode(overlay[1]), overlay[2]]) === show([pill, 'Retry']), `${month}'s pill: ${show(overlay?.slice(1))}`);
    }
    const all = [...september, ...cellsOf(monthHtml(html, '2026-11')), ...cellsOf(monthHtml(html, '2026-12'))];
    assert(!all.some((c) => c.label.includes('nothing planned')), 'no loading or failed day reads "nothing planned"');
    assert(!monthHtml(html, '2026-10').includes('ch-mb-overlay'), 'an answered month has no pill');
  });

  await check('#9 a Google user (Ruling 4): calendars gone is a centred pill with Choose again; partial is a pill at the top over live cells; a reconnect dims the cells with no pill (the banner says it)', () => {
    const html = renderBrowse('en', browseProps(googleStore(), { start: { month: '2026-11', peek: false } }));
    const october = monthHtml(html, '2026-10');
    assert(/<div class="ch-mb-overlay is-top"><div class="ch-mb-pill"><span class="ch-mb-pill-text">Some calendars didn’t load<\/span><button type="button" class="ch-btn ch-mb-pill-action">Retry<\/button><\/div><\/div>/.test(october), 'October: the partial pill at the top');
    assert(cellsOf(october).every((c) => !c.cls.includes('is-failed') && !c.cls.includes('is-loading')), 'October\'s cells stay live');
    assert(cellOf(october, 'Thursday, 15 October').label === 'Thursday, 15 October, 4 Cheshvan, 1 item', `no "from" without a partner: ${cellOf(october, 'Thursday, 15 October').label}`);
    const november = monthHtml(html, '2026-11');
    assert(/<div class="ch-mb-overlay is-centre"><div class="ch-mb-pill"><span class="ch-mb-pill-text">Your calendars aren’t available<\/span><button type="button" class="ch-btn ch-mb-pill-action">Choose again<\/button>/.test(november), 'November: calendars gone');
    const december = monthHtml(html, '2026-12');
    assert(!december.includes('ch-mb-overlay') && cellsOf(december).every((c) => c.cls.includes('is-failed') && c.label.endsWith('couldn’t load')), 'December: dimmed, no pill');
  });

  await check('#10 with Hebrew dates off: no Hebrew line in the bar, the titles or the cells, and the shorter heights (bar 72, title 42)', () => {
    const store = famcalStore({ hebrewDates: false });
    const html = renderBrowse('en', browseProps(store));
    assert(/<section class="ch-mb" dir="ltr" style="--ch-mb-bar:72px;--ch-mb-title:42px;--ch-mb-cell:92px">/.test(html), 'the heights without the Hebrew line');
    assert(barOf(html).hebrew === null && titleOf(html, '2026-10').hebrew === null, 'no Hebrew months in the bar or the titles');
    const october = monthHtml(html, '2026-10');
    assert(!/ch-mb-hday|Cheshvan|Chesh\./.test(october), 'no Hebrew day in the cells');
    assert(cellOf(october, 'Thursday, 15 October').label === 'Thursday, 15 October, 3 items, 1 from Noa', 'the label without the Hebrew date');
    assert(cellsOf(october).every((c) => c.inner.includes('<span class="ch-mb-hmonth" aria-hidden="true"></span>')), 'the month line stays, empty (the line kept for holidays)');
  });

  await check('#11 the block sizes: every month at monthBlockPx(rows, hebrewDates), near or far, for 4-, 5- and 6-row months; a body is rows × 92; a far month is its title and an empty aria-hidden box; a model from another week start draws as loading at the new height', () => {
    for (const [ws, hd] of [
      [0, true],
      [0, false],
      [1, true],
      [6, true],
    ] as const) {
      const html = markup(renderBrowse('en', browseProps(famcalStore({ weekStart: ws, hebrewDates: hd }))));
      const sizes = blockSizes(html);
      assert(show(sizes.map((s) => s.month)) === show(monthSpan(TODAY)), `ws ${ws}: the window's 31 months in order`);
      for (const s of sizes) {
        const rows = monthGrid(s.month, ws).length;
        assert(s.block === monthBlockPx(rows, hd) && s.body === rows * BROWSE_CELL_PX && s.block === monthTitlePx(hd) + s.body, `ws ${ws} hd ${hd} ${s.month}: ${show(s)}`);
      }
      assert(show(sizes.filter((s) => !s.far).map((s) => s.month)) === show(['2026-09', '2026-10', '2026-11']), `ws ${ws}: only the start month and its neighbours drawn: ${show(sizes.filter((s) => !s.far).map((s) => s.month))}`);
      if (ws === 0) {
        const rowCounts = new Set(sizes.map((s) => s.body / BROWSE_CELL_PX));
        assert(show([...rowCounts].sort()) === show([4, 5, 6]), `4-, 5- and 6-row months: ${show([...rowCounts])}`);
        const known = Object.fromEntries(sizes.map((s) => [s.month, s.block]));
        // Arithmetic from the spec's heights: title 58 (42 without the Hebrew line) + rows × 92.
        assert(show([known['2026-02'], known['2026-10'], known['2026-08']]) === show(hd ? [426, 518, 610] : [410, 502, 594]), `Feb, Oct and Aug 2026: ${show([known['2026-02'], known['2026-10'], known['2026-08']])}`);
      }
      const far = monthHtml(html, '2027-03');
      assert(/<div class="ch-mb-body ch-mb-far" style="block-size:\d+px" aria-hidden="true"><\/div>/.test(far) && !far.includes('<button'), 'a far month: an empty, aria-hidden box');
    }
    assert(monthBarPx(true) === 76 && monthBarPx(false) === 72 && monthTitlePx(true) === 58 && monthTitlePx(false) === 42 && BROWSE_CELL_PX === 92, 'E5\'s heights');
    // Mid-change: the week start moved to 1 (March 2026 goes from 5 rows to 6) while the models are still week start 0's.
    const html = markup(renderBrowse('en', browseProps(famcalStore(), { weekStart: 1, start: { month: '2026-03', peek: false } })));
    const march = blockSizes(html).find((s) => s.month === '2026-03');
    assert(march && monthGrid('2026-03', 0).length === 5 && march.block === monthBlockPx(6, true) && march.body === 6 * BROWSE_CELL_PX, `March at week start 1: ${show(march)}`);
    const cells = cellsOf(monthHtml(html, '2026-03'));
    assert(cells.length === 31 && cells.every((c) => c.cls.includes('is-loading')), 'a model from another week start draws as loading, at the new height');
    const october = cellsOf(monthHtml(markup(renderBrowse('en', browseProps(famcalStore(), { weekStart: 1 }))), '2026-10'));
    assert(october.every((c) => c.cls.includes('is-loading')), 'October too, though its rows are as many');
  });

  await check('#12 the CSS: nothing under 11 px; the 44 px Today button and pill; logical properties only; the sticky top under both safe areas and what sticks above the bar (--ch-top-h); overflow-x: clip on the root and overflow: hidden only on text leaves; no transform or filter; the reduced-motion rule; no hover; the heights add up; E4\'s tokens only', () => {
    const css = MONTH_BROWSE_CSS;
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 8 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px (so the floor is checkable)');
    const today = ruleOf(css, '.ch-mb-today');
    assert(px(declOf(today, 'min-height')) >= 44 && px(declOf(today, 'min-width')) >= 44, `the Today button: ${today}`);
    assert(px(declOf(ruleOf(css, '.ch-mb-pill'), 'min-height')) >= 44, 'a pill is at least 44 px');
    assert(/\.ch-btn \{[^}]*min-height: 44px;[^}]*min-width: 44px;/.test(HOME_THEME_CSS), 'the pill\'s action is a .ch-btn (44 × 44)');
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    const bar = ruleOf(css, '.ch-mb-bar');
    assert(declOf(bar, 'position') === 'sticky' && declOf(bar, 'top') === 'calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px))', `the sticky bar: ${bar}`);
    assert(declOf(bar, 'background') === 'var(--ch-bg)' && declOf(bar, 'block-size') === 'var(--ch-mb-bar)', 'the bar is opaque and exactly --ch-mb-bar tall');
    assert((css.match(/(?:^|[\s;{])top\s*:/g) ?? []).length === 1, 'the bar\'s top is the only top');
    assert(declOf(ruleOf(css, '.ch-mb-title'), 'scroll-margin-top') === 'calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px) + var(--ch-mb-bar))', 'titles stop under the bar');
    // Overflow: the root clips sideways only, and only text leaves hide their overflow (their ellipsis).
    const overflows = cssRules(css).flatMap((r) => [...r.body.matchAll(/(?:^|[\s;])(overflow(?:-[xy])?)\s*:\s*([^;]+);/g)].map((m) => ({ selector: r.selector, decl: `${m[1]}: ${m[2].trim()}` })));
    assert(show(overflows.filter((o) => o.selector === '.ch-mb').map((o) => o.decl)) === show(['overflow-x: clip']), `the root: ${show(overflows.filter((o) => o.selector === '.ch-mb'))}`);
    const leaves = overflows.filter((o) => o.selector !== '.ch-mb');
    assert(leaves.every((o) => o.decl === 'overflow: hidden' && /^\.ch-mb-[a-z-]+$/.test(o.selector)), `other overflows: ${show(leaves)}`);
    const html = markup(renderBrowse('en', browseProps(famcalStore())));
    for (const { selector } of leaves) {
      const cls = selector.slice(1);
      const found = [...html.matchAll(new RegExp(`<(\\w+) class="${cls}(?: [^"]*)?"[^>]*>([\\s\\S]*?)</\\1>`, 'g'))];
      assert(found.length > 0, `${cls} is in the markup`);
      assert(found.every((m) => !m[2].replace(/<!-- -->/g, '').includes('<')), `${cls} holds text only: ${show(found.find((m) => m[2].includes('<'))?.[0].slice(0, 200))}`);
    }
    assert(/<section class="ch-mb"[^>]*><style>[\s\S]*?<\/style><div class="ch-mb-bar">/.test(renderBrowse('en', browseProps(famcalStore()))), 'the bar is the root\'s child: its only ancestor here is the root');
    assert(!/(?:^|[\s;{])(?:transform|filter|backdrop-filter|perspective|will-change|contain)\s*:/.test(css), 'no transform or filter (sticky, and D\'s fixed sheets)');
    assert(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ch-mb-ghost \{\s*animation: none;/.test(css), 'reduced motion stops the placeholder\'s pulse');
    assert(show(cssRules(css).filter((r) => /animation\s*:/.test(r.body)).map((r) => r.selector)) === show(['.ch-mb-ghost', '.ch-mb-ghost']), 'the placeholder is the only animation');
    assert(!/scroll-behavior/.test(css), 'no CSS smooth scrolling: the Today button picks smooth or instant in JS');
    // The fixed heights add up to month.ts's.
    assert(px(declOf(ruleOf(css, '.ch-mb-weekdays'), 'block-size')) === 24 && monthBarPx(false) - 24 >= 44 && monthBarPx(true) - 24 >= 44, 'the bar\'s row holds the 44 px button above the 24 px weekday row');
    const title = ruleOf(css, '.ch-mb-title');
    const pad = (declOf(title, 'padding-block') ?? '').split(' ').map(px);
    const line = px(declOf(ruleOf(css, '.ch-mb-title-month'), 'line-height'));
    const hebrewLine = px(declOf(ruleOf(css, '.ch-mb-title-hebrew'), 'line-height'));
    assert(pad[0] + line + pad[1] === monthTitlePx(false) && pad[0] + line + hebrewLine + pad[1] === monthTitlePx(true) && declOf(title, 'block-size') === 'var(--ch-mb-title)', `the title: ${show([pad, line, hebrewLine])}`);
    const cell = ruleOf(css, '.ch-mb-cell');
    const inside = 1 + px((declOf(cell, 'padding-block') ?? '').split(' ')[0]) + px(declOf(ruleOf(css, '.ch-mb-head'), 'block-size')) + px(declOf(ruleOf(css, '.ch-mb-hmonth'), 'block-size')) + 3 * px(declOf(ruleOf(css, '.ch-mb-slot'), 'block-size'));
    assert(declOf(cell, 'block-size') === 'var(--ch-mb-cell)' && inside <= BROWSE_CELL_PX, `a cell's lines (${inside} px) fit its ${BROWSE_CELL_PX} px`);
    // Colours: E4's tokens, mine filled, the partner's outlined.
    const look = (sel: string) => ['background', 'color', 'border-color'].map((p) => declOf(ruleOf(css, sel), p));
    assert(show(look('.ch-mb-chip.is-mine-timed')) === show(['var(--ch-mine-soft)', 'var(--ch-mine-soft-text)', null]), 'mine, timed');
    assert(show(look('.ch-mb-chip.is-mine-solid')) === show(['var(--ch-mine-solid)', 'var(--ch-mine-solid-text)', null]), 'mine, all-day and bars');
    assert(show(look('.ch-mb-chip.is-partner-timed')) === show(['var(--ch-bg)', 'var(--ch-partner-line-text)', 'var(--ch-partner-line)']), 'the partner\'s, timed: outlined');
    assert(show(look('.ch-mb-chip.is-partner-solid')) === show(['var(--ch-partner-soft)', 'var(--ch-partner-soft-text)', 'var(--ch-partner-line)']), 'the partner\'s, all-day and bars: outlined too');
    assert(show(look('.ch-mb-cell.is-today .ch-mb-day').slice(0, 2)) === show(['var(--ch-today)', 'var(--ch-today-text)']), 'today on the --ch-today fill');
    const used = new Set([...css.matchAll(/var\((--ch-[a-z-]+)/g)].map((m) => m[1]));
    const defined = new Set([...HOME_THEME_CSS.matchAll(/(--ch-[a-z-]+)\s*:/g)].map((m) => m[1]));
    // The view's own three, and --ch-top-h, which E8's container sets on .ch-home (0px without it).
    const own = new Set(['--ch-mb-bar', '--ch-mb-title', '--ch-mb-cell', '--ch-top-h']);
    const unknown = [...used].filter((v) => !defined.has(v) && !own.has(v));
    assert(unknown.length === 0, `tokens home-theme.ts doesn't define: ${show(unknown)}`);
  });

  installWindow();

  await check('#13 in real React, the opening position: one instant scroll puts October\'s title under the bar with half a week row of September above it; Sep–Nov draw before any observer fires; then the month in view is October, with no Today button; one observer, rootMargin "100% 0px", on all 31 months; passive listeners', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      assert(show(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'].map((mo) => dayButtons(m, mo).length)) === show([0, 30, 31, 30, 0]), 'the start month and its neighbours draw before any observer fires');
      const want = titleUnderBar(m, '2026-10') - BROWSE_CELL_PX / 2;
      assert(show(scrollCalls) === show([{ top: want, behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)} (want ${want})`);
      assert(topOf(m, '2026-10') === [...monthSpan(TODAY).slice(0, 12)].reduce((sum, mo) => sum + monthBlockPx(monthGrid(mo, 0).length, true), 0), 'October\'s top is the blocks above it');
      assert(seen.inView.length === 0, 'nothing reported before the first frame');
      flushFrames();
      assert(show(seen.inView) === show(['2026-10']), `in view: ${show(seen.inView)}`);
      assert(bandTop(m) === topOf(m, '2026-10') - BROWSE_CELL_PX / 2, 'half a week row of September shows under the bar');
      assert(barText(m) === 'October 2026' && todayButton(m) === null, `the bar: ${barText(m)}, Today: ${todayButton(m) !== null}`);
      assert(seen.near.length === 0, 'the observer reports the near months (not yet fired)');
      assert(FakeIO.all.length === 1 && FakeIO.all[0].options.rootMargin === '100% 0px' && FakeIO.all[0].observed.size === 31, `one observer: ${show(FakeIO.all.map((io) => [io.options, io.observed.size]))}`);
      const scroll = windowListeners.filter((l) => l.type === 'scroll');
      assert(scroll.length === 1 && (scroll[0].options as Row)?.passive === true, `one passive scroll listener: ${show(scroll.map((l) => l.options))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#14 the opening without peek (start December): December\'s title just under the bar, the month in view December, and the Today button shown (October is off screen)', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), { ...callbacks, start: { month: '2026-12', peek: false } })));
    try {
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-12'), behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)}`);
      assert(todayButton(m)?.textContent === 'Today', 'the Today button shows from the first render');
      flushFrames();
      assert(show(seen.inView) === show(['2026-12']) && bandTop(m) === topOf(m, '2026-12'), `in view: ${show(seen.inView)}`);
      assert(barText(m) === 'December 2026' && todayButton(m) !== null, 'the bar names December, and Today stays');
      assert(show(['2026-11', '2026-12', '2027-01'].map((mo) => dayButtons(m, mo).length)) === show([30, 31, 31]), 'December and its neighbours draw');
    } finally {
      m.unmount();
    }
  });

  await check('#15 the near months: the observer\'s reports gathered into one onNearMonths a frame, oldest first, only when they change; a month that comes near draws its grid', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      const io = FakeIO.all[0];
      io.fire({ '2026-10': true, '2026-11': true, '2026-09': true });
      io.fire({ '2026-12': true });
      assert(show([seen.near.length, frames.size]) === show([0, 1]), `one frame for two reports: ${frames.size}`);
      assert(dayButtons(m, '2026-12').length === 0, 'December is far until the frame');
      flushFrames();
      assert(show(seen.near) === show([['2026-09', '2026-10', '2026-11', '2026-12']]), `near: ${show(seen.near)}`);
      assert(dayButtons(m, '2026-12').length === 31, 'December draws once near');
      io.fire({ '2026-09': false });
      flushFrames();
      assert(show(seen.near.at(-1)) === show(['2026-10', '2026-11', '2026-12']), `September left: ${show(seen.near)}`);
      io.fire({ '2026-10': true });
      flushFrames();
      assert(seen.near.length === 2, 'the same months again: no call');
      assert(dayButtons(m, '2026-09').length === 30, 'the month in view\'s neighbours stay drawn');
      assert(dayButtons(m, '2027-05').length === 0, 'a far month stays an empty box');
    } finally {
      m.unmount();
    }
  });

  await check('#16 scrolling: one measure a frame however many scroll events; the month under the bar reported as it changes, the bar following; the Today button while no part of October is on screen, gone when its last row comes back', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      const november = titleUnderBar(m, '2026-11');
      fakeWindow.scrollY = november;
      fireScroll();
      fireScroll();
      fireScroll();
      assert(frames.size === 1, `three scroll events, one frame: ${frames.size}`);
      flushFrames();
      assert(show(seen.inView) === show(['2026-10', '2026-11']) && barText(m) === 'November 2026', `in view: ${show(seen.inView)}, bar ${barText(m)}`);
      assert(todayButton(m) !== null, 'October is all above the bar: Today shows');
      scrollPageTo(november - 10);
      flushFrames();
      assert(todayButton(m) === null && show(seen.inView) === show(['2026-10', '2026-11']), 'October\'s last 10 px are on screen: no Today button, November still in view');
      scrollPageTo(titleUnderBar(m, '2027-06') + 200);
      flushFrames();
      assert(seen.inView.at(-1) === '2027-06' && barText(m) === 'June 2027' && todayButton(m) !== null, `far away: ${show(seen.inView)}`);
      scrollPageTo(0);
      flushFrames();
      assert(seen.inView.at(-1) === '2025-10' && barText(m) === 'October 2025', 'at the top: the window\'s first month');
    } finally {
      m.unmount();
    }
  });

  await check('#17 the Today button (Ruling 6): a smooth scroll that puts October\'s title under the bar; under prefers-reduced-motion an instant one', () => {
    resetPage();
    const m = mount(browseIn('en', browseProps(famcalStore(), { start: { month: '2027-06', peek: false } })));
    try {
      flushFrames();
      const button = todayButton(m);
      assert(button, 'the Today button shows in June 2027');
      scrollCalls.length = 0;
      m.click(button);
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-10'), behavior: 'smooth' }]), `smooth: ${show(scrollCalls)}`);
      setMedia(REDUCED, true);
      scrollCalls.length = 0;
      scrollPageTo(titleUnderBar(m, '2027-06'));
      flushFrames();
      m.click(todayButton(m) as FakeElement);
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-10'), behavior: 'instant' }]), `reduced motion: ${show(scrollCalls)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#18 a tap on a day calls onPickDay with its day; Retry on a failed or partial pill calls onRetryMonth(month, source); Choose again calls onChooseCalendars', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      m.click(dayButton(m, '2026-10', 'Tuesday, 20 October'));
      m.click(dayButton(m, '2026-11', 'Sunday, 1 November'));
      assert(show(seen.picked) === show(['2026-10-20', '2026-11-01']), `picked: ${show(seen.picked)}`);
      const retry = (mo: MonthKey) => elements(sectionEl(m, mo)).find((e) => hasClass(e, 'ch-mb-pill-action')) as FakeElement;
      m.click(retry('2026-11'));
      flushFrames();
      FakeIO.all[0].fire({ '2026-12': true });
      flushFrames();
      m.click(retry('2026-12'));
      assert(show(seen.retried) === show(['2026-11:famcal', '2026-12:famcal']), `retried: ${show(seen.retried)}`);
    } finally {
      m.unmount();
    }
    resetPage();
    const google = recorder();
    const g = mount(browseIn('en', browseProps(googleStore(), { ...google.callbacks, start: { month: '2026-11', peek: false } })));
    try {
      const action = (mo: MonthKey) => elements(sectionEl(g, mo)).find((e) => hasClass(e, 'ch-mb-pill-action')) as FakeElement;
      g.click(action('2026-10'));
      g.click(action('2026-11'));
      assert(show(google.seen.retried) === show(['2026-10:google']) && google.seen.chosen === 1, `google: ${show(google.seen)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#19 a narrow screen, (max-width: 360px) (Ruling 3): a day of 3 shows 2 chips and "+1 more", and 3 again once the screen is wide; a day of 4 shows "+2 more" either way', () => {
    resetPage();
    media.set(NARROW, true);
    const m = mount(browseIn('en', browseProps(famcalStore())));
    try {
      const chips = (label: string) => byClass(dayButton(m, '2026-10', label), 'ch-mb-chip').map((c) => c.textContent);
      const more = (label: string) => byClass(dayButton(m, '2026-10', label), 'ch-mb-more').map((c) => c.textContent);
      assert(show([chips('Wednesday, 14 October'), more('Wednesday, 14 October')]) === show([['Gym', 'Call the plumber'], ['+1 more']]), `narrow: ${show([chips('Wednesday, 14 October'), more('Wednesday, 14 October')])}`);
      assert(show(more('Monday, 26 October')) === show(['+2 more']), 'narrow: "+2 more"');
      setMedia(NARROW, false);
      assert(show([chips('Wednesday, 14 October'), more('Wednesday, 14 October')]) === show([['Gym', 'Call the plumber', 'Pilates'], []]), `wide: ${show(chips('Wednesday, 14 October'))}`);
      assert(show(more('Monday, 26 October')) === show(['+2 more']), 'wide: "+2 more"');
    } finally {
      m.unmount();
    }
  });

  await check('#20 re-anchoring: when the window\'s first month moves (2025-10 → 2025-11), the week start changes (0 → 6) or the Hebrew line goes, one instant scroll keeps the month in view where it was under the bar', () => {
    resetPage();
    const store0 = famcalStore();
    // Week start 6, not 1: the twelve months above November have as many rows at 0 as at 1 (62), so 1 would move nothing.
    const store6 = famcalStore({ weekStart: 6 });
    const storeOff = famcalStore({ weekStart: 6, hebrewDates: false });
    const { seen, callbacks } = recorder();
    const base = browseProps(store0, { ...callbacks, start: { month: '2026-11', peek: false } });
    const m = mount(browseIn('en', base));
    try {
      flushFrames();
      scrollPageTo(fakeWindow.scrollY + 100);
      flushFrames();
      assert(seen.inView.at(-1) === '2026-11' && bandTop(m) - topOf(m, '2026-11') === 100, 'November in view, 100 px into it');
      const shifted = monthSpan('2026-11-01');
      const steps: { label: string; props: MonthBrowseProps }[] = [
        { label: 'the first month', props: { ...base, months: shifted } },
        { label: 'the week start', props: { ...base, months: shifted, weekStart: 6, getMonth: monthModels(store6) } },
        { label: 'the Hebrew line', props: { ...base, months: shifted, weekStart: 6, hebrewDates: false, getMonth: monthModels(storeOff) } },
      ];
      for (const step of steps) {
        const before = topOf(m, '2026-11');
        scrollCalls.length = 0;
        m.render(browseIn('en', step.props));
        const moved = topOf(m, '2026-11') - before;
        assert(moved !== 0, `${step.label}: November's offset moved (the check would be empty)`);
        assert(scrollCalls.length === 1 && scrollCalls[0].behavior === 'instant', `${step.label}: one instant scroll: ${show(scrollCalls)}`);
        assert(bandTop(m) - topOf(m, '2026-11') === 100, `${step.label}: November still 100 px under the bar (${bandTop(m) - topOf(m, '2026-11')})`);
        flushFrames();
        assert(seen.inView.at(-1) === '2026-11', `${step.label}: in view ${show(seen.inView)}`);
      }
      scrollCalls.length = 0;
      m.render(browseIn('en', { ...steps[2].props, onPickDay: noop }));
      assert(scrollCalls.length === 0, 'a re-render with the same layout scrolls nothing');
    } finally {
      m.unmount();
    }
  });

  await check('#21 without IntersectionObserver (Ruling 7): the near months are the month in view and its two neighbours, from the scroll measure', () => {
    resetPage();
    fakeWindow.IntersectionObserver = undefined;
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      assert(show(seen.near) === show([['2026-09', '2026-10', '2026-11']]), `near: ${show(seen.near)}`);
      scrollPageTo(titleUnderBar(m, '2026-12'));
      flushFrames();
      assert(show(seen.near.at(-1)) === show(['2026-11', '2026-12', '2027-01']) && dayButtons(m, '2027-01').length === 31, `after a scroll: ${show(seen.near)}`);
      scrollPageTo(0);
      flushFrames();
      assert(show(seen.near.at(-1)) === show(['2025-10', '2025-11']), `the window's first month has one neighbour: ${show(seen.near.at(-1))}`);
    } finally {
      m.unmount();
      fakeWindow.IntersectionObserver = FakeIO;
    }
  });

  await check('#22 unmount lets go of everything: the scroll and resize listeners, the observer, the media listener and a pending frame', () => {
    resetPage();
    const m = mount(browseIn('en', browseProps(famcalStore())));
    flushFrames();
    assert(show([windowListeners.map((l) => l.type), mediaListeners.get(NARROW)?.size]) === show([['scroll', 'resize'], 1]), `mounted: ${show(windowListeners.map((l) => l.type))}`);
    fireScroll();
    assert(show(frames.size) === show(1), 'a frame is pending');
    m.unmount();
    assert(windowListeners.length === 0, `listeners left: ${show(windowListeners.map((l) => l.type))}`);
    assert(FakeIO.all[0].disconnected, 'the observer is disconnected');
    assert((mediaListeners.get(NARROW)?.size ?? 0) === 0, 'the media listener is gone');
    assert(frames.size === 0, 'the pending frame is cancelled');
  });

  await check('#23 the list moves in the page while scrolled into it (a banner or the unavailable row comes or goes above the Month, the header\'s zone line): one instant scroll by as much keeps January where it was under the bar (iOS has no scroll anchoring); at the page\'s top, nothing scrolls; nothing moved, nothing scrolls', () => {
    resetPage();
    const store = famcalStore();
    const listTop = LAYOUT.listTop;
    const base = browseProps(store, { start: { month: '2027-01', peek: false } });
    const m = mount(browseIn('en', base));
    try {
      flushFrames();
      scrollPageTo(fakeWindow.scrollY + 40);
      flushFrames();
      assert(bandTop(m) - topOf(m, '2027-01') === 40, `January 40 px under the bar: ${bandTop(m) - topOf(m, '2027-01')}`);
      let answered = store;
      for (const [label, delta] of [['the Reconnect banner comes', 62], ['the unavailable row comes', 56], ['both go', -118]] as const) {
        const y = Number(fakeWindow.scrollY);
        scrollCalls.length = 0;
        LAYOUT.listTop += delta;
        answered = reduceStore(answered, ok(answer('2027-01', {})));
        m.render(browseIn('en', { ...base, getMonth: monthModels(answered) })); // a month's answer: the store, and the rows above, changed
        assert(show(scrollCalls) === show([{ top: y + delta, behavior: 'instant' }]), `${label}: ${show(scrollCalls)}`);
        assert(bandTop(m) - topOf(m, '2027-01') === 40, `${label}: January ${bandTop(m) - topOf(m, '2027-01')} px under the bar`);
        flushFrames();
      }
      scrollCalls.length = 0;
      m.render(browseIn('en', { ...base, getMonth: monthModels(answered), onPickDay: noop }));
      assert(scrollCalls.length === 0, `nothing moved: ${show(scrollCalls)}`);
      scrollPageTo(0);
      flushFrames();
      scrollCalls.length = 0;
      LAYOUT.listTop += 62;
      m.render(browseIn('en', { ...base, getMonth: monthModels(answered), onRetryMonth: noop }));
      assert(scrollCalls.length === 0, `at the page's top the banner shows where it comes: ${show(scrollCalls)}`);
    } finally {
      m.unmount();
      LAYOUT.listTop = listTop;
    }
  });

  await check('#24 a sticky region above the bar (E8\'s header and tab bar, --ch-top-h): the bar sticks under it, and the opening scroll, the month in view and the Today button all read the bar where it sticks', () => {
    resetPage();
    const topH = LAYOUT.topH;
    LAYOUT.topH = 126;
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), { ...callbacks, start: { month: '2026-12', peek: false } })));
    try {
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-12'), behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)} (want ${titleUnderBar(m, '2026-12')})`);
      flushFrames();
      const bar = byClass(m.container, 'ch-mb-bar')[0].getBoundingClientRect();
      assert(bar.top === LAYOUT.safeTop + 126, `the bar sticks at ${bar.top}`);
      assert(seen.inView.at(-1) === '2026-12' && bandTop(m) === topOf(m, '2026-12'), `in view ${show(seen.inView)}, ${bandTop(m) - topOf(m, '2026-12')} px into December`);
      const today = todayButton(m);
      assert(today !== null, 'the Today button (October is off screen)');
      scrollCalls.length = 0;
      m.click(today);
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-10'), behavior: 'smooth' }]), `Today: ${show(scrollCalls)}`);
    } finally {
      m.unmount();
      LAYOUT.topH = topH;
    }
  });

  await check('#25 a narrow screen with three overlapping bars, Alpha 5–7, Beta 6–8 and Gamma 7–9 October (E5\'s limitRow): the 9th shows Gamma, named, not "+1 more" under two empty lines; the 8th Beta and Gamma, both named; wide, the bars keep their lanes, and a bar hidden behind "+2 more" on the 12th is named on the 13th, back in its lane', () => {
    const bar = (id: string, title: string, start: DayKey, end: DayKey) => item(id, { title, start, end, allDay: true, tz: null });
    const days: Record<DayKey, ItemDTO[]> = {};
    for (const it of [
      bar('alpha', 'Alpha', '2026-10-05', '2026-10-08'),
      bar('beta', 'Beta', '2026-10-06', '2026-10-09'),
      bar('gamma', 'Gamma', '2026-10-07', '2026-10-10'),
      bar('delta', 'Delta', '2026-10-12', '2026-10-14'),
      bar('echo', 'Echo', '2026-10-12', '2026-10-14'),
      bar('foxtrot', 'Foxtrot', '2026-10-12', '2026-10-14'),
      timed('lunch', 'Lunch', '2026-10-12', '12:00', '13:00'),
    ]) {
      for (const d of it.allDay ? daysInWindow(it.start, it.end) : ['2026-10-12']) (days[d] ??= []).push(it);
    }
    const store = storeOf([ok(answer('2026-10', days))]);
    resetPage();
    media.set(NARROW, true);
    const m = mount(browseIn('en', browseProps(store)));
    try {
      /** A cell's slots: [title] for a chip or a bar, "_" for an empty line, or the "+N" text. */
      const slots = (label: string) =>
        byClass(dayButton(m, '2026-10', label), 'ch-mb-slot').map((s) => {
          const chip = byClass(s, 'ch-mb-chip')[0];
          const more = byClass(s, 'ch-mb-more')[0];
          return chip ? `[${chip.textContent}]` : more ? more.textContent : '_';
        });
      const week = ['Monday, 5 October', 'Tuesday, 6 October', 'Wednesday, 7 October', 'Thursday, 8 October', 'Friday, 9 October'];
      assert(show(week.map(slots)) === show([['[Alpha]'], ['[]', '[Beta]'], ['[]', '[]', '+1 more'], ['[Beta]', '[Gamma]'], ['[Gamma]']]), `narrow: ${show(week.map(slots))}`);
      setMedia(NARROW, false);
      assert(show(week.map(slots)) === show([['[Alpha]'], ['[]', '[Beta]'], ['[]', '[]', '[Gamma]'], ['_', '[]', '[]'], ['_', '_', '[]']]), `wide: ${show(week.map(slots))}`);
      const next = ['Monday, 12 October', 'Tuesday, 13 October'];
      assert(show(next.map(slots)) === show([['[Delta]', '[Echo]', '+2 more'], ['[]', '[]', '[Foxtrot]']]), `wide, Foxtrot hidden then back: ${show(next.map(slots))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#26 React logged no warning', () => {
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
