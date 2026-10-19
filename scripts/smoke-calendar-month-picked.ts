// Smoke test for the Month's picked layout (Plan E, Task E7; spec §7.4 "Tap a day →
// picked", §7.7, §7.8; Rulings R11 and R12; Plan E Rulings 4, 5, 6 and 8):
// MonthPicked (app/[locale]/dashboard/MonthPicked.tsx), fed the way MonthView (E8) feeds
// it: range answers go through the real store (reduceStore), and the model, the rows,
// the day's status and the chevrons come from month.ts (monthModels, dayRows,
// dayStatus, canStep). It checks:
//  - client-safe imports: no server module, no @hebcal/core, no date-fns-tz;
//  - en, he and ru: the bar ("All months", the Today pill), the nav (the chevrons'
//    labels, the title with its year and Hebrew months in aria-live="polite"), the
//    weekday row from the week start, the blanks, one button per day with browse's label
//    (E1's parts), aria-pressed and aria-current, the Hebrew day at 11 px with the short
//    month on Hebrew day 1 and the 1st, the day header and D's rows; RTL in Hebrew;
//  - the dots: filled for the viewer's, a ring for the partner's, at most 3, then
//    month.moreShort's "+N";
//  - daily reminders listed under the day but never dotted or counted (Ruling 5);
//  - the chevrons at the window's ends (12 months back, 18 ahead);
//  - the Today pill only while the selected day isn't today;
//  - the notices as rows (failed, busy, calendars gone, partial; never a reconnect), and
//    the day's states: "Nothing planned" only when answered and empty, placeholders while
//    loading, nothing when failed; cells never look free unless answered;
//  - in real React (react-dom/client with act on a small fake DOM): every callback; on
//    mount the page scrolls to the top and focus goes to the selected day without a
//    scroll; when the Today pill or a chevron goes away or is disabled, focus moves to
//    the selected day;
//  - a short screen (Ruling 6): entering picked scrolls only as far down as shows the
//    day's header and first row, never past the bar, from E7's fixed heights for 6 rows
//    with and without two banners on 375 × 667 and 320 × 568, and in real React from
//    where the layout and the day header measure;
//  - the CSS: nothing under 11 px, taps of 44 px, PICKED_CELL_PX cells, logical
//    properties only, no hover, the bottom safe area, only defined tokens.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-month-picked.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-month-picked.ts

// The view first: the import check walks what it loads.
import { MONTH_PICKED_CSS, MonthPicked, type MonthPickedProps } from '../app/[locale]/dashboard/MonthPicked';
import { AGENDA_CSS } from '../app/[locale]/dashboard/AgendaView';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import { HOME_SHELL_CSS } from '../app/[locale]/dashboard/home-shell';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import {
  PICKED_CELL_PX,
  PICKED_DOTS,
  PICKED_FIRST_ROW_PX,
  canStep,
  dayRows,
  initialMonthUi,
  monthModels,
  pickDay,
  pickToday,
  pickedScrollTop,
  stepMonth,
  type MonthCell,
  type MonthUi,
} from '../src/lib/calendar-view/month';
import { monthWindow } from '../src/lib/calendar-view/grid';
import { formatDayLong } from '../src/lib/calendar-view/format';
import { hebrewDayLabel } from '../src/lib/calendar-view/hebrew-date';
import { daysInWindow, dayStatus, emptyStore, reduceStore, type CalendarStore, type StoreAction } from '../src/lib/calendar-view/store';
import { calendarVars } from '../src/lib/calendar-view/colours';
import { compareItems, type CalendarDTO, type DayKey, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse, type WeekStart } from '../src/lib/calendar-view/types';

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
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 ----

const TZ = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';
const OCTOBER = '2026-10';
/** A wall-clock time in Israel on an October day, as UTC ISO (IDT, UTC+3, until 25 October; then IST, UTC+2). */
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

/** The daily reminder, listed on its day (Ruling 5: listed, never dotted or counted). */
const vitamins = (day: DayKey, done = false): ItemDTO =>
  item(`vitamins-${day}`, { kind: 'reminder', title: 'Take vitamins', start: at(day, '08:00'), recurring: true, repeatsDaily: true, reminder: rem({ done, doneAt: done ? at(day, '08:10') : null }) });

const PILATES = item('pilates', { title: 'Pilates', start: at('2026-10-05', '19:00'), end: at('2026-10-05', '20:00'), calendar: NOA_CAL });
const HAIRCUT = item('haircut', { title: 'Haircut', start: at('2026-10-06', '12:00'), end: at('2026-10-06', '12:45') });
const CALL_MOM = item('call-mom', { kind: 'reminder', title: 'Call Mom', start: at('2026-10-06', '20:00'), reminder: rem({ done: true, doneAt: at('2026-10-06', '20:05') }) });
const DENTIST = item('dentist', { title: 'Dentist', start: at(TODAY, '09:30'), end: at(TODAY, '10:30'), location: 'Clinic on Herzl St' });
const FORM = item('form', { kind: 'reminder', title: 'Send the school form', start: at(TODAY, '13:00'), reminder: rem({ open: true }) });
const FOOTBALL = item('football', { title: 'Football practice', start: at(TODAY, '17:00'), end: at(TODAY, '18:00'), calendar: NOA_CAL });
const MOVIE = item('movie', { title: 'Movie night', start: at(TODAY, '20:30'), end: at(TODAY, '22:30') });
const GRANDMA = item('grandma', { title: 'Grandma visits', start: '2026-10-16', end: '2026-10-17', allDay: true, tz: null, calendar: NOA_CAL });
const CHALLAH = item('challah', { kind: 'reminder', title: 'Buy challah', start: at('2026-10-16', '10:00'), reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const BUSY_DAY = ['Standup', 'Review', 'Swim class', 'Lunch', 'Call the bank'].map((title, i) =>
  item(`busy-${i}`, { title, start: at('2026-10-20', `${String(8 + i).padStart(2, '0')}:00`), end: at('2026-10-20', `${String(8 + i).padStart(2, '0')}:30`), calendar: i === 2 ? NOA_CAL : MY_CAL }),
);
/** Snoozed until later the same day: its row reads the time alone on that day ("until 15:30"), not a weekday and time. */
const BANK = item('bank', { kind: 'reminder', title: 'Call the bank', start: at('2026-10-21', '14:00'), reminder: rem({ snoozedUntil: at('2026-10-21', '15:30') }) });
const TRIP = (span: ItemDTO['span']): ItemDTO => item('trip', { title: 'Eilat trip', start: '2026-10-22', end: '2026-10-25', allDay: true, tz: null, span });

/** October 2026's days with items (the rest are answered and empty). */
const OCTOBER_ITEMS: Record<DayKey, ItemDTO[]> = {
  '2026-10-05': [PILATES],
  '2026-10-06': [HAIRCUT, CALL_MOM],
  [TODAY]: [vitamins(TODAY, true), DENTIST, FORM, FOOTBALL, MOVIE],
  '2026-10-16': [GRANDMA, vitamins('2026-10-16'), CHALLAH],
  '2026-10-17': [vitamins('2026-10-17')],
  '2026-10-20': BUSY_DAY,
  '2026-10-21': [BANK],
  '2026-10-22': [TRIP('endsLater')],
  '2026-10-23': [TRIP('spansDay')],
  '2026-10-24': [TRIP('spansDay')],
};

function answer(o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}): RangeResponse {
  const { from, to } = monthWindow(OCTOBER);
  const window = { from: o.from ?? from, to: o.to ?? to };
  const items = o.items ?? {};
  const { items: _items, ...rest } = o;
  return {
    tz: TZ,
    today: TODAY,
    weekStart: 0,
    hebrewDates: true,
    sources: { famcal: { status: 'ok' } },
    partner: { name: 'Noa' },
    calendars: LEGEND,
    ...rest,
    ...window,
    days: daysInWindow(window.from, window.to).map((date) => ({ date, items: [...(items[date] ?? [])].sort(compareItems) })),
  };
}

const storeOf = (actions: StoreAction[]): CalendarStore => actions.reduce(reduceStore, emptyStore());
const ok = (response: RangeResponse): StoreAction => ({ type: 'response', response, epoch: 0 });
/** October answered, as a month window's answer. */
const octoberStore = (o: Partial<RangeResponse> = {}) => storeOf([ok(answer({ items: OCTOBER_ITEMS, ...o }))]);
/** Only the Agenda's first week answered ([today, today+7)): the rest of October still loading. */
const AGENDA_WEEK = { from: TODAY, to: '2026-10-22' };
const weekItems = Object.fromEntries(Object.entries(OCTOBER_ITEMS).filter(([d]) => d >= AGENDA_WEEK.from && d < AGENDA_WEEK.to));
const weekOnlyStore = () => storeOf([ok(answer({ ...AGENDA_WEEK, items: weekItems }))]);
/** The Agenda's week answered, then October's window failed (500 or 429). */
const failedStore = (kind: 'busy' | 'error') =>
  storeOf([ok(answer({ ...AGENDA_WEEK, items: weekItems })), { type: 'windowFailed', ...monthWindow(OCTOBER), sources: ['famcal'], kind, epoch: 0 }]);
/** A Google user (no partner in the store), October answered with `google`. */
const googleStore = (google: NonNullable<RangeResponse['sources']['google']>) =>
  storeOf([ok(answer({ sources: { google }, partner: null, calendars: [{ id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: null, mine: true }] }))]);

/** Picked on `day`, as a tap in browse leaves it. */
const picked = (day: DayKey): MonthUi => pickDay(initialMonthUi(null, TODAY), day);

/** MonthPicked's props for a store and a UI, as MonthView (E8) computes them. */
function propsFor(store: CalendarStore, ui: MonthUi, o: Partial<MonthPickedProps> = {}): MonthPickedProps {
  const facts = store.facts;
  assert(facts, 'the store has no facts');
  const model = monthModels(store)(ui.month);
  assert(model && ui.selected, `no model for ${ui.month}`);
  return {
    model,
    selected: ui.selected,
    today: facts.today,
    tz: facts.tz,
    weekStart: facts.weekStart,
    hebrewDates: facts.hebrewDates,
    canPrev: canStep(ui, -1, facts.today),
    canNext: canStep(ui, 1, facts.today),
    rows: dayRows(store, ui.selected),
    dayStatus: dayStatus(store, ui.selected),
    onSelectDay: noop,
    onPrev: noop,
    onNext: noop,
    onToday: noop,
    onAllMonths: noop,
    onOpenItem: noop,
    onRetryMonth: noop,
    onChooseCalendars: noop,
    ...o,
  };
}

// ---- Rendering ----

/** CalendarHome's frame: the theme root with its tokens and the shell's styles, inside next-intl's provider. */
function inHome(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(
    NextIntlClientProvider,
    provider,
    createElement(
      'div',
      { className: 'ch-home', 'data-theme': 'light', dir: locale === 'he' ? 'rtl' : 'ltr' },
      createElement('style', null, HOME_THEME_CSS),
      createElement('style', null, HOME_SHELL_CSS),
      el,
    ),
  );
}

const render = (locale: Locale, props: MonthPickedProps) => renderToString(inHome(locale, createElement(MonthPicked, props)));

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The text a reader sees: style sheets, tags and React's text separators out, entities decoded, spaces collapsed. */
const textOf = (html: string) =>
  decode(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

/** The markup without the style sheets (their class names would match anything). */
const markup = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

/** An attribute of one opening tag, decoded, or null. */
const attr = (tag: string, name: string) => {
  const m = new RegExp(` ${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};

/** dots: whose (is-mine, is-partner); colours: each dot's ' has-cal' and inline style (null without). */
type CellHtml = { label: string | null; pressed: string | null; current: string | null; className: string; num: string; heb: string | null; dots: string[]; colours: { cal: boolean; style: string | null }[]; more: string | null; ghost: boolean };

/** The grid's cells in order: blanks as null, each day's button parsed. */
function gridOf(html: string): (CellHtml | null)[] {
  const body = markup(html);
  const start = body.indexOf('<div class="ch-mp-grid">');
  const end = body.indexOf('<section class="ch-mp-list"', start);
  assert(start >= 0 && end > start, 'no grid in the markup');
  const grid = body.slice(start, end);
  const out: (CellHtml | null)[] = [];
  for (const m of grid.matchAll(/<span class="ch-mp-cell ch-mp-blank" aria-hidden="true"><\/span>|<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (!m[1]) {
      out.push(null);
      continue;
    }
    const open = m[1];
    const inner = m[2];
    out.push({
      label: attr(open, 'aria-label'),
      pressed: attr(open, 'aria-pressed'),
      current: attr(open, 'aria-current'),
      className: attr(open, 'class') ?? '',
      num: /<span class="ch-mp-num" aria-hidden="true">(\d+)<\/span>/.exec(inner)?.[1] ?? '',
      heb: /<span class="ch-mp-heb" aria-hidden="true">([^<]*)<\/span>/.exec(inner)?.[1] ?? null,
      dots: [...inner.matchAll(/class="ch-mp-dot (is-mine|is-partner)(?: has-cal)?"/g)].map((d) => d[1]),
      colours: [...inner.matchAll(/class="ch-mp-dot (?:is-mine|is-partner)( has-cal)?"(?: style="([^"]*)")?/g)].map((d) => ({ cal: !!d[1], style: d[2] ?? null })),
      more: /<span class="ch-mp-more" dir="ltr">([^<]*)<\/span>/.exec(inner)?.[1] ?? null,
      ghost: inner.includes('class="ch-mp-ghost"'),
    });
  }
  return out;
}
const days = (html: string) => gridOf(html).filter((c): c is CellHtml => c !== null);
const cellOn = (html: string, day: number) => {
  const cell = days(html).find((c) => Number(c.num) === day);
  assert(cell, `no cell for day ${day}`);
  return cell;
};

/** Browse's label recipe (E1's top note), from the copy itself: the weekday and date, the Hebrew day, then the counts or the state. */
function expectedLabel(locale: Locale, cell: MonthCell, partner: string | null, hebrewDates: boolean): string {
  const t = nodeRequire('next-intl').createTranslator({ locale, messages: messages[locale], namespace: 'calendarHome' });
  const genitive = locale === 'ru' ? messages.ru.calendarHome.hebrewMonthGenitive : undefined;
  const parts = [formatDayLong(cell.day, locale)];
  if (hebrewDates) parts.push(hebrewDayLabel(cell.day, locale, genitive));
  if (cell.count > 0) {
    parts.push(t('month.cellItems', { count: cell.count }));
    if (cell.fromPartner > 0 && partner) parts.push(t('month.cellFromPartner', { count: cell.fromPartner, name: partner }));
  }
  if (cell.status !== 'answered') parts.push(t(cell.status === 'loading' ? 'month.cellLoading' : 'month.cellFailed'));
  else if (cell.count === 0) parts.push(t('month.cellNothing'));
  return parts.join(', ');
}

/** The day header's text, the Today pill and the chevrons, from the markup. */
function chrome(html: string) {
  const body = markup(html);
  const buttons = [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
  const byClass = (cls: string) => buttons.filter((b) => attr(b[1], 'class') === cls);
  const chevrons = byClass('ch-mp-chev').map((b) => ({ label: attr(b[1], 'aria-label'), disabled: / disabled=""/.test(b[1]), flip: /<svg class="ch-flip"[^>]*aria-hidden="true"/.test(b[2]) }));
  const back = byClass('ch-mp-back').map((b) => ({ text: textOf(b[2]), flip: /<svg class="ch-flip"[^>]*aria-hidden="true"/.test(b[2]) }));
  const today = byClass('ch-mp-today').map((b) => textOf(b[2]));
  const title = /<h2 class="ch-mp-title" aria-live="polite">([\s\S]*?)<\/h2>/.exec(body);
  const month = title ? /<span class="ch-mp-month">([^<]*)<\/span>/.exec(title[1])?.[1] ?? null : null;
  const range = title ? /<span class="ch-mp-range">([^<]*)<\/span>/.exec(title[1])?.[1] ?? null : null;
  const weekdays = /<div class="ch-mp-weekdays" aria-hidden="true">([\s\S]*?)<\/div>/.exec(body);
  const head = /<h3 class="ch-mp-day" id="ch-mp-day">([\s\S]*?)<\/h3>/.exec(body);
  const dayLabel = head ? textOf(/<span class="ch-mp-day-label">([\s\S]*?)<\/span>/.exec(head[1])?.[1] ?? '') : null;
  const dayHebrew = head ? /<span class="ch-mp-day-hebrew">([^<]*)<\/span>/.exec(head[1])?.[1] ?? null : null;
  const list = body.slice(body.indexOf('<section class="ch-mp-list"'));
  const rows = [...list.matchAll(/<span class="ch-title" dir="auto">([^<]*)<\/span>/g)].map((m) => decode(m[1]));
  const notices = [...body.matchAll(/<div class="ch-state" role="status">([\s\S]*?)<\/div>/g)].map((m) => textOf(m[1]));
  return {
    chevrons,
    back,
    today,
    month: month && decode(month),
    range: range && decode(range),
    weekdays: weekdays ? [...weekdays[1].matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]) : null,
    dayLabel,
    dayHebrew,
    rows,
    notices,
    nothing: list.includes('class="ch-mp-nothing"'),
    ghosts: list.includes('class="ch-ghosts"'),
    busy: / aria-busy="true"/.test(list.slice(0, list.indexOf('>') + 1)),
  };
}

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules), as in smoke-calendar-home-render.ts ----

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };
/** What the page did, in order: scrollTo calls and focus calls (with their options). */
const pageLog: string[] = [];

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
  focus(options?: { preventScroll?: boolean }) {
    pageLog.push(`focus ${this.getAttribute('aria-label') ?? this.getAttribute('class')} ${show(options ?? null)}`);
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

const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
  scrollTo: (...args: unknown[]) => void pageLog.push(`scrollTo ${show(args)}`),
};
fakeDocument.defaultView = fakeWindow;

function installWindow() {
  const g = globalThis as Row;
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

type Mounted = {
  container: FakeElement;
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
const byClass = (node: FakeNode, cls: string) => elements(node).filter((e) => e.className.split(' ').includes(cls));
const one = (node: FakeNode, cls: string) => {
  const found = byClass(node, cls);
  assert(found.length === 1, `${found.length} elements with class ${cls}`);
  return found[0];
};
/** The day's button, by its date (the first part of its label). */
const cellFor = (m: Mounted, day: DayKey, locale: Locale = 'en') => {
  const date = formatDayLong(day, locale);
  const cell = byClass(m.container, 'ch-mp-cell').find((e) => e.tagName === 'BUTTON' && (e.getAttribute('aria-label') ?? '').startsWith(`${date},`));
  assert(cell, `no cell for ${day}`);
  return cell;
};
const pressedDays = (m: Mounted) => byClass(m.container, 'ch-mp-cell').filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.getAttribute('aria-label'));
const titleOf = (m: Mounted) => one(m.container, 'ch-mp-month').textContent;

/**
 * MonthPicked as MonthView (E8) holds it: the UI in state, moved with month.ts's
 * helpers; `seen` records each callback.
 */
function PickedHost({ store, start, seen }: { store: CalendarStore; start: MonthUi; seen: string[] }) {
  const [ui, setUi] = React.useState<MonthUi>(start);
  const today = store.facts?.today ?? TODAY;
  return createElement(
    MonthPicked,
    propsFor(store, ui, {
      onSelectDay: (day) => {
        seen.push(`select ${day}`);
        setUi((u) => pickDay(u, day));
      },
      onPrev: () => {
        seen.push('prev');
        setUi((u) => stepMonth(u, -1, today));
      },
      onNext: () => {
        seen.push('next');
        setUi((u) => stepMonth(u, 1, today));
      },
      onToday: () => {
        seen.push('today');
        setUi((u) => pickToday(u, today));
      },
      onAllMonths: () => void seen.push('allMonths'),
      onOpenItem: (row) => void seen.push(`open ${row.item.key}`),
      onRetryMonth: (month, source) => void seen.push(`retry ${month} ${source}`),
      onChooseCalendars: () => void seen.push('choose'),
    }),
  );
}

// ---- The checks ----

async function main() {
  // The holidays hook asks the holidays route from a mounted view with Hebrew dates; there is no network here, so it answers none.
  (globalThis as Row).fetch = async () => ({ ok: true, status: 200, json: async () => ({ days: {} }) });

  await check('#1 the view is client-safe: MonthPicked loads no server module (DB, Redis, services, date-fns-tz, @hebcal/core), and it does load the model, the Hebrew dates and D\'s rows', () => {
    const root = path.join(ROOT, 'app/[locale]/dashboard/MonthPicked.tsx');
    assert(require.cache[root] !== undefined, `${root} is not in require.cache: the check would be empty`);
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    for (const want of ['src/lib/calendar-view/month.ts', 'src/lib/calendar-view/grid.ts', 'src/lib/calendar-view/hebrew-date.ts', 'src/lib/calendar-view/format.ts', 'app/[locale]/dashboard/ItemRow.tsx', 'app/[locale]/dashboard/DayList.tsx']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the view's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#2 en (week from Sunday, 16 October picked): the bar, the nav and its live title, the weekday row, the blanks, one button per day with browse\'s label, aria-pressed and aria-current, the Hebrew day with the short month on Hebrew day 1 and the 1st, the day header and D\'s rows; no Hebrew at all when the route says so', () => {
    const store = octoberStore();
    const props = propsFor(store, picked('2026-10-16'));
    const html = render('en', props);
    const c = chrome(html);
    assert(/<section class="ch-mp" dir="ltr">/.test(html), 'the section is dir="ltr"');
    assert(show(c.back) === show([{ text: 'All months', flip: true }]), `All months: ${show(c.back)}`);
    assert(show(c.today) === show(['Today']), `the Today pill: ${show(c.today)}`);
    assert(
      show(c.chevrons) === show([{ label: 'Previous month', disabled: false, flip: true }, { label: 'Next month', disabled: false, flip: true }]),
      `the chevrons: ${show(c.chevrons)}`,
    );
    assert(c.month === 'October 2026' && c.range === 'Tishrei – Cheshvan 5787', `the title: ${c.month} / ${c.range}`);
    assert(show(c.weekdays) === show(['S', 'M', 'T', 'W', 'T', 'F', 'S']), `the weekday row: ${show(c.weekdays)}`);
    const grid = gridOf(html);
    // 1 October 2026 is a Thursday: four blanks, then 31 days, and 31 October is a Saturday.
    assert(grid.length === 35 && grid.slice(0, 4).every((x) => x === null) && grid.slice(4).every((x) => x !== null), `the grid: ${show(grid.map((x) => x?.num ?? '·'))}`);
    const cells = days(html);
    assert(show(cells.map((x) => Number(x.num))) === show(Array.from({ length: 31 }, (_, i) => i + 1)), 'one button per day, 1 … 31');
    assert(show(cells.filter((x) => x.pressed === 'true').map((x) => x.num)) === show(['16']) && cells.every((x) => x.pressed === 'true' || x.pressed === 'false'), 'aria-pressed on the 16th only, false on the rest');
    assert(show(cells.filter((x) => x.current !== null).map((x) => [x.num, x.current])) === show([['15', 'date']]), 'aria-current="date" on today only');
    assert(cellOn(html, 15).className === 'ch-mp-cell is-today' && cellOn(html, 16).className === 'ch-mp-cell', `classes: ${cellOn(html, 15).className} / ${cellOn(html, 16).className}`);
    const literal: [number, string][] = [
      [15, 'Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa'],
      [16, 'Friday, 16 October, 5 Cheshvan, 2 items, 1 from Noa'],
      [17, 'Saturday, 17 October, 6 Cheshvan, nothing planned'],
      [6, 'Tuesday, 6 October, 25 Tishrei, 2 items'],
      [22, 'Thursday, 22 October, 11 Cheshvan, 1 item'],
    ];
    for (const [day, want] of literal) assert(cellOn(html, day).label === want, `day ${day}: ${cellOn(html, day).label}`);
    const modelCells = props.model.weeks.flat().filter((x) => x.inMonth);
    const wrong = modelCells.filter((x, i) => cells[i].label !== expectedLabel('en', x, 'Noa', true));
    assert(wrong.length === 0, `labels off the recipe: ${show(wrong.map((x) => x.day))}`);
    const heb = cells.map((x) => x.heb);
    assert(heb[0] === '20 Tish.' && heb[11] === '1 Chesh.' && heb[14] === '4' && heb[10] === '30', `the Hebrew days: ${show(heb)}`);
    assert(heb.filter((h) => /\D/.test(h ?? '')).length === 2, `the short month only on the 1st and Hebrew day 1: ${show(heb)}`);
    assert(c.dayLabel === 'Friday, 16 October' && c.dayHebrew === '5 Cheshvan', `the day header: ${c.dayLabel} / ${c.dayHebrew}`);
    assert(show(c.rows) === show(['Grandma visits', 'Take vitamins', 'Buy challah']), `the rows: ${show(c.rows)}`);
    assert(!c.nothing && !c.ghosts && c.notices.length === 0, 'no "Nothing planned", placeholders or notices');
    const text = textOf(html);
    assert(text.includes('From Noa') && text.includes('Reminder · every day') && text.includes('All day'), `D's rows: ${text.slice(0, 600)}`);
    assert(!/calendarHome\.|month\.|agenda\./.test(text), 'an untranslated key');
    // The rows are read for the selected day: a snooze that ends that day reads its time alone.
    const snoozed = textOf(render('en', propsFor(store, picked('2026-10-21'))));
    assert(snoozed.includes('Snoozed until 15:30') && !snoozed.includes('Wed 15:30'), `the 21st's snooze: ${snoozed.slice(-200)}`);
    // Hebrew dates off (the route says so): no range, no Hebrew line, no Hebrew in the labels or the header.
    const plain = render('en', propsFor(octoberStore({ hebrewDates: false }), picked('2026-10-16')));
    const p = chrome(plain);
    assert(p.range === null && p.dayHebrew === null && days(plain).every((x) => x.heb === null), 'no Hebrew when hebrewDates is off');
    assert(cellOn(plain, 15).label === 'Thursday, 15 October, 4 items, 1 from Noa', `the label without Hebrew: ${cellOn(plain, 15).label}`);
  });

  await check('#3 he: RTL, the Hebrew title and months, the weekday row "א׳ … ש׳", Hebrew labels with their plural forms, the Hebrew day in gematriya with the month on Hebrew day 1, the chevrons flipped, and "היום · …" on today', () => {
    const html = render('he', propsFor(octoberStore(), picked('2026-10-16')));
    const c = chrome(html);
    assert(/<section class="ch-mp" dir="rtl">/.test(html), 'the section is dir="rtl"');
    assert(c.back[0]?.text === 'כל החודשים' && c.back[0].flip && show(c.today) === show(['היום']), `the bar: ${show(c.back)} ${show(c.today)}`);
    assert(show(c.chevrons.map((x) => [x.label, x.flip])) === show([['החודש הקודם', true], ['החודש הבא', true]]), `the chevrons: ${show(c.chevrons)}`);
    assert(c.month === 'אוקטובר 2026' && c.range === 'תשרי – חשון תשפ״ז', `the title: ${c.month} / ${c.range}`);
    assert(show(c.weekdays) === show(['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']), `the weekday row: ${show(c.weekdays)}`);
    assert(cellOn(html, 15).label === 'יום חמישי, 15 באוקטובר, ד׳ בחשון, 4 אירועים, 1 של Noa', `day 15: ${cellOn(html, 15).label}`);
    assert(cellOn(html, 5).label === 'יום שני, 5 באוקטובר, כ״ד בתשרי, אירוע אחד, 1 של Noa', `day 5: ${cellOn(html, 5).label}`);
    assert(cellOn(html, 6).label === 'יום שלישי, 6 באוקטובר, כ״ה בתשרי, שני אירועים', `day 6: ${cellOn(html, 6).label}`);
    assert(cellOn(html, 1).heb === 'כ׳ תשרי' && cellOn(html, 12).heb === 'א׳ חשון' && cellOn(html, 15).heb === 'ד׳', `the Hebrew days: ${cellOn(html, 1).heb} ${cellOn(html, 12).heb} ${cellOn(html, 15).heb}`);
    assert(c.dayLabel === 'יום שישי, 16 באוקטובר' && c.dayHebrew === 'ה׳ בחשון', `the day header: ${c.dayLabel} / ${c.dayHebrew}`);
    const onToday = chrome(render('he', propsFor(octoberStore(), picked(TODAY))));
    assert(onToday.dayLabel === 'היום · יום חמישי, 15 באוקטובר' && onToday.today.length === 0, `today: ${onToday.dayLabel} ${show(onToday.today)}`);
    assert(!/calendarHome\.|month\./.test(textOf(html)), 'an untranslated key');
  });

  await check('#4 ru (week from Monday): the nominative title and months, "Пн … Вс", the blanks, labels with the genitive Hebrew month and every plural form, the short month after a number, and "Сегодня · …" on today', () => {
    const store = octoberStore({ weekStart: 1 as WeekStart });
    const props = propsFor(store, picked('2026-10-16'));
    const html = render('ru', props);
    const c = chrome(html);
    assert(c.month === 'Октябрь 2026' && c.range === 'Тишрей – Хешван 5787', `the title: ${c.month} / ${c.range}`);
    assert(show(c.weekdays) === show(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']), `the weekday row: ${show(c.weekdays)}`);
    const grid = gridOf(html);
    // From Monday: three blanks (Mon–Wed), 31 days, and one blank after Saturday the 31st.
    assert(grid.length === 35 && grid.slice(0, 3).every((x) => x === null) && grid[3] !== null && grid[34] === null, `the grid: ${show(grid.map((x) => x?.num ?? '·'))}`);
    assert(c.back[0]?.text === 'Все месяцы' && show(c.today) === show(['Сегодня']), `the bar: ${show(c.back)} ${show(c.today)}`);
    assert(show(c.chevrons.map((x) => x.label)) === show(['Предыдущий месяц', 'Следующий месяц']), `the chevrons: ${show(c.chevrons)}`);
    const literal: [number, string][] = [
      [15, 'четверг, 15 октября, 4 хешвана, 4 события, Noa: 1'],
      [5, 'понедельник, 5 октября, 24 тишрея, 1 событие, Noa: 1'],
      [6, 'вторник, 6 октября, 25 тишрея, 2 события'],
      [20, 'вторник, 20 октября, 9 хешвана, 5 событий, Noa: 1'],
      [17, 'суббота, 17 октября, 6 хешвана, ничего не запланировано'],
    ];
    for (const [day, want] of literal) assert(cellOn(html, day).label === want, `day ${day}: ${cellOn(html, day).label}`);
    const modelCells = props.model.weeks.flat().filter((x) => x.inMonth);
    const wrong = modelCells.filter((x, i) => days(html)[i].label !== expectedLabel('ru', x, 'Noa', true));
    assert(wrong.length === 0, `labels off the recipe: ${show(wrong.map((x) => x.day))}`);
    assert(cellOn(html, 1).heb === '20 тишр.' && cellOn(html, 12).heb === '1 хешв.', `the short months: ${cellOn(html, 1).heb} ${cellOn(html, 12).heb}`);
    assert(c.dayLabel === 'пятница, 16 октября' && c.dayHebrew === '5 хешвана', `the day header: ${c.dayLabel} / ${c.dayHebrew}`);
    const onToday = chrome(render('ru', propsFor(store, picked(TODAY))));
    assert(onToday.dayLabel === 'Сегодня · четверг, 15 октября' && onToday.dayHebrew === '4 хешвана', `today: ${onToday.dayLabel} / ${onToday.dayHebrew}`);
    assert(/\.ch-mp-day-label::first-letter \{\s*text-transform: uppercase;\s*\}/.test(MONTH_PICKED_CSS), 'the day header starts with a capital ("Пятница")');
  });

  await check(`#5 the dots: filled for the viewer's items, a ring for the partner's, in slot order (bars, then all-day, then by time), at most ${PICKED_DOTS}, then "+N" (month.moreShort) in each language; a day with nothing drawn has none`, () => {
    const store = octoberStore();
    const want: [number, string[], string | null][] = [
      [5, ['is-partner'], null],
      [6, ['is-mine', 'is-mine'], null],
      [15, ['is-mine', 'is-mine', 'is-partner'], '+1'],
      [16, ['is-partner', 'is-mine'], null],
      [20, ['is-mine', 'is-mine', 'is-partner'], '+2'],
      [22, ['is-mine'], null],
      [23, ['is-mine'], null],
      [3, [], null],
    ];
    for (const locale of LOCALES) {
      const html = render(locale, propsFor(store, picked('2026-10-16')));
      for (const [day, dots, more] of want) {
        const cell = cellOn(html, day);
        assert(show(cell.dots) === show(dots) && cell.more === more && !cell.ghost, `${locale} day ${day}: ${show(cell.dots)} ${cell.more}`);
      }
    }
  });

  await check('#6 Ruling 5: a daily reminder is listed under its day but never dotted or counted: the 17th (only the daily reminder) has no dot and reads "nothing planned", yet its list shows the reminder and no "Nothing planned"; the 16th counts 2 and lists 3', () => {
    const store = octoberStore();
    const html17 = render('en', propsFor(store, picked('2026-10-17')));
    const cell17 = cellOn(html17, 17);
    assert(cell17.dots.length === 0 && cell17.more === null && cell17.label === 'Saturday, 17 October, 6 Cheshvan, nothing planned', `the 17th: ${show(cell17)}`);
    const c17 = chrome(html17);
    assert(show(c17.rows) === show(['Take vitamins']) && !c17.nothing, `the 17th's list: ${show(c17.rows)} nothing=${c17.nothing}`);
    assert(textOf(html17).includes('Reminder · every day'), 'the daily reminder reads "Reminder · every day"');
    const html16 = render('en', propsFor(store, picked('2026-10-16')));
    assert(cellOn(html16, 16).dots.length === 2 && cellOn(html16, 16).label?.includes('2 items'), `the 16th: ${show(cellOn(html16, 16))}`);
    assert(chrome(html16).rows.length === 3, 'the 16th lists 3 rows');
    const html15 = render('en', propsFor(store, picked(TODAY)));
    assert(cellOn(html15, 15).label?.includes('4 items') && chrome(html15).rows[0] === 'Take vitamins' && chrome(html15).rows.length === 5, `today: ${show(chrome(html15).rows)}`);
  });

  await check('#7 the chevrons at the window\'s ends (12 months back, 18 ahead): October 2025 has no previous month and April 2028 no next one; in real React a tap that reaches an end disables that chevron, a second tap calls nothing, and focus moves to the selected day', () => {
    const store = octoberStore();
    const first = chrome(render('en', propsFor(store, picked('2025-10-01'))));
    assert(first.month === 'October 2025' && show(first.chevrons.map((x) => x.disabled)) === show([true, false]), `October 2025: ${show(first.chevrons)}`);
    const last = chrome(render('en', propsFor(store, picked('2028-04-01'))));
    assert(last.month === 'April 2028' && show(last.chevrons.map((x) => x.disabled)) === show([false, true]), `April 2028: ${show(last.chevrons)}`);
    installWindow();
    for (const [start, cls, call, wantTitle, wantDay] of [
      ['2025-11-03', 0, 'prev', 'October 2025', '2025-10-01'],
      ['2028-03-31', 1, 'next', 'April 2028', '2028-04-01'],
    ] as const) {
      const seen: string[] = [];
      const m = mount(inHome('en', createElement(PickedHost, { store, start: picked(start), seen })));
      try {
        const chevron = byClass(m.container, 'ch-mp-chev')[cls];
        chevron.focus();
        pageLog.length = 0;
        m.click(chevron);
        assert(show(seen) === show([call]) && titleOf(m) === wantTitle, `${call}: ${show(seen)} ${titleOf(m)}`);
        assert(chevron.hasAttribute('disabled'), `the ${call} chevron is disabled at the end`);
        const selected = cellFor(m, wantDay);
        assert(selected.getAttribute('aria-pressed') === 'true' && fakeDocument.activeElement === selected, `focus after the end: ${fakeDocument.activeElement?.getAttribute?.('aria-label')}`);
        assert(show(pageLog) === show([`focus ${selected.getAttribute('aria-label')} {"preventScroll":true}`]), `no scroll, one focus: ${show(pageLog)}`);
        m.click(chevron);
        assert(show(seen) === show([call]), `a tap on the disabled chevron: ${show(seen)}`);
      } finally {
        m.unmount();
      }
    }
    // A chevron that stays enabled keeps the focus.
    const seen: string[] = [];
    const m = mount(inHome('en', createElement(PickedHost, { store, start: picked('2026-10-16'), seen })));
    try {
      const next = byClass(m.container, 'ch-mp-chev')[1];
      next.focus();
      m.click(next);
      assert(titleOf(m) === 'November 2026' && fakeDocument.activeElement === next, `November: ${titleOf(m)} ${fakeDocument.activeElement?.getAttribute?.('aria-label')}`);
      assert(cellFor(m, '2026-11-01').getAttribute('aria-pressed') === 'true', 'a step selects the 1st');
    } finally {
      m.unmount();
    }
  });

  await check('#8 the Today pill shows only while the selected day isn\'t today, and the day header reads "Today · …" only on today; in real React a tap on it calls onToday, the pill goes, and focus moves to today\'s cell, also from another month', () => {
    const store = octoberStore();
    const on = chrome(render('en', propsFor(store, picked(TODAY))));
    assert(on.today.length === 0 && on.dayLabel === 'Today · Thursday, 15 October' && on.dayHebrew === '4 Cheshvan', `on today: ${show(on.today)} ${on.dayLabel}`);
    const off = chrome(render('en', propsFor(store, picked('2026-10-03'))));
    assert(show(off.today) === show(['Today']) && off.dayLabel === 'Saturday, 3 October', `off today: ${show(off.today)} ${off.dayLabel}`);
    const away = chrome(render('en', propsFor(store, picked('2026-12-10'))));
    assert(show(away.today) === show(['Today']) && away.month === 'December 2026', 'in another month');
    installWindow();
    for (const start of ['2026-10-03', '2026-12-10']) {
      const seen: string[] = [];
      const m = mount(inHome('en', createElement(PickedHost, { store, start: picked(start), seen })));
      try {
        const pill = one(m.container, 'ch-mp-today');
        pill.focus();
        pageLog.length = 0;
        m.click(pill.childNodes[0]);
        assert(show(seen) === show(['today']) && byClass(m.container, 'ch-mp-today').length === 0, `${start}: ${show(seen)}`);
        assert(titleOf(m) === 'October 2026' && show(pressedDays(m)) === show(['Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa']), `${start}: ${titleOf(m)} ${show(pressedDays(m))}`);
        const todayCell = cellFor(m, TODAY);
        assert(fakeDocument.activeElement === todayCell && show(pageLog) === show([`focus ${todayCell.getAttribute('aria-label')} {"preventScroll":true}`]), `${start}: focus ${show(pageLog)}`);
        assert(one(m.container, 'ch-mp-day-label').textContent === 'Today · Thursday, 15 October', 'the header moves to today');
      } finally {
        m.unmount();
      }
    }
  });

  await check('#9 the notices as rows above the grid, and the day\'s states: a failed month ("Couldn\'t load this month · Retry"), busy, calendars gone (Choose again), partial (Retry), never a reconnect; failed cells dimmed with no dots, loading cells a placeholder, never "nothing planned" in a label unless answered; under the day "Nothing planned" only when answered and empty, placeholders while loading, nothing when failed', () => {
    // A FamCal 500 on October, after the Agenda's week answered: the week's days are live, the rest failed.
    const failed = render('en', propsFor(failedStore('error'), picked('2026-10-03')));
    const f = chrome(failed);
    assert(show(f.notices) === show(['Couldn’t load this month Retry']), `the failed notice: ${show(f.notices)}`);
    const nav = markup(failed).indexOf('class="ch-mp-nav"');
    const notice = markup(failed).indexOf('class="ch-states ch-mp-states"');
    const weekdays = markup(failed).indexOf('class="ch-mp-weekdays"');
    assert(nav < notice && notice < weekdays, 'the notices sit between the nav and the grid');
    const cell3 = cellOn(failed, 3);
    assert(cell3.className === 'ch-mp-cell is-failed' && cell3.dots.length === 0 && !cell3.ghost && cell3.label === 'Saturday, 3 October, 22 Tishrei, couldn’t load', `a failed cell: ${show(cell3)}`);
    assert(cellOn(failed, 15).className === 'ch-mp-cell is-today' && cellOn(failed, 15).dots.length === 3, 'the Agenda week\'s days stay live');
    assert(!f.nothing && !f.ghosts && f.rows.length === 0 && !f.busy, 'a failed day: nothing under its header');
    // 429: busy.
    const busy = chrome(render('en', propsFor(failedStore('busy'), picked('2026-10-03'))));
    assert(show(busy.notices) === show(['Busy right now, try again in a minute Retry']), `busy: ${show(busy.notices)}`);
    // Loading: only the Agenda's week answered.
    const loading = render('en', propsFor(weekOnlyStore(), picked('2026-10-03')));
    const l = chrome(loading);
    assert(l.notices.length === 0, `no notice while loading: ${show(l.notices)}`);
    const cellL = cellOn(loading, 3);
    assert(cellL.className === 'ch-mp-cell is-loading' && cellL.ghost && cellL.dots.length === 0 && cellL.label === 'Saturday, 3 October, 22 Tishrei, loading', `a loading cell: ${show(cellL)}`);
    assert(l.ghosts && !l.nothing && l.busy, `a loading day: placeholders ${l.ghosts}, nothing ${l.nothing}, aria-busy ${l.busy}`);
    const labels = days(loading).map((x) => x.label ?? '');
    assert(labels.filter((x) => x.endsWith('nothing planned')).every((x) => /1[5-9] October|2[01] October/.test(x)), 'only answered days read "nothing planned"');
    // A day with items while Google failed or hasn't answered: the label says so after the items, as browse's does.
    const mixed = (google: NonNullable<RangeResponse['sources']['google']>) => storeOf([ok(answer({ items: OCTOBER_ITEMS, sources: { famcal: { status: 'ok' }, google } }))]);
    const mixedFailed = cellOn(render('en', propsFor(mixed({ status: 'error', reason: 'transient' }), picked('2026-10-03'))), 15).label;
    assert(mixedFailed === 'Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa, couldn’t load', `items, then couldn't load: ${mixedFailed}`);
    const mixedLoading = cellOn(render('en', propsFor(mixed({ status: 'pending' }), picked('2026-10-03'))), 15).label;
    assert(mixedLoading === 'Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa, loading', `items, then loading: ${mixedLoading}`);
    // Answered and empty.
    const empty = chrome(render('en', propsFor(octoberStore(), picked('2026-10-03'))));
    assert(empty.nothing && !empty.ghosts && empty.rows.length === 0 && textOf(render('en', propsFor(octoberStore(), picked('2026-10-03')))).includes('Nothing planned'), 'an answered empty day: "Nothing planned"');
    // Google: calendars gone, partial, reconnect.
    const gone = render('en', propsFor(googleStore({ status: 'error', reason: 'calendars_gone' }), picked('2026-10-03')));
    assert(show(chrome(gone).notices) === show(['Your calendars aren’t available Choose again']), `calendars gone: ${show(chrome(gone).notices)}`);
    const partial = render('en', propsFor(googleStore({ status: 'ok', partial: { failed: 1, truncated: 0 } }), picked('2026-10-03')));
    assert(show(chrome(partial).notices) === show(['Some calendars didn’t load Retry']) && chrome(partial).nothing, `partial: ${show(chrome(partial).notices)}`);
    const reconnect = render('en', propsFor(googleStore({ status: 'reconnect', reason: 'token' }), picked('2026-10-03')));
    assert(chrome(reconnect).notices.length === 0 && !/class="ch-states/.test(markup(reconnect)), `a reconnect makes no row: ${show(chrome(reconnect).notices)}`);
    assert(cellOn(reconnect, 3).className === 'ch-mp-cell is-failed' && !chrome(reconnect).nothing, 'a reconnect still never looks free');
    // month.ts never makes a reconnect notice; the view drops one anyway (MonthNotice's type allows it).
    const base = propsFor(googleStore({ status: 'reconnect', reason: 'scopes' }), picked('2026-10-03'));
    const forged = { ...base.model, notices: [{ source: 'google' as const, kind: 'failed' as const, failure: { kind: 'reconnect' as const, source: 'google' as const, reason: 'scopes' as const } }] };
    assert(chrome(render('en', { ...base, model: forged })).notices.length === 0, 'a reconnect notice never makes a row');
    for (const locale of ['he', 'ru'] as const) {
      const text = chrome(render(locale, propsFor(failedStore('error'), picked('2026-10-03')))).notices[0];
      const copy = messages[locale].calendarHome;
      assert(text === `${copy.month.failed} ${copy.actions.retry}`, `${locale}: ${text}`);
    }
  });

  await check('#10 every callback, in real React: a tap on a day selects it (and a tap on the selected day calls nothing), the chevrons, Today, All months, a row opens its item, Retry asks the month again for its source, Choose again', () => {
    installWindow();
    const seen: string[] = [];
    const m = mount(inHome('en', createElement(PickedHost, { store: octoberStore(), start: picked('2026-10-16'), seen })));
    try {
      m.click(cellFor(m, '2026-10-20').childNodes[0]);
      assert(show(seen) === show(['select 2026-10-20']) && show(pressedDays(m)) === show(['Tuesday, 20 October, 9 Cheshvan, 5 items, 1 from Noa']), `a tap: ${show(seen)}`);
      m.click(cellFor(m, '2026-10-20'));
      assert(seen.length === 1, `a tap on the selected day: ${show(seen)}`);
      assert(show(byClass(m.container, 'ch-title').map((e) => e.textContent)) === show(BUSY_DAY.map((x) => x.title)), 'the 20th\'s rows');
      m.click(byClass(m.container, 'ch-row')[2]);
      assert(seen[1] === 'open famcal|busy-2', `a row: ${show(seen)}`);
      m.click(one(m.container, 'ch-mp-today'));
      m.click(one(m.container, 'ch-mp-back').childNodes[1]);
      assert(show(seen.slice(2)) === show(['today', 'allMonths']) && show(pressedDays(m)) === show(['Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa']), `Today and All months: ${show(seen)}`);
      const [prev, next] = byClass(m.container, 'ch-mp-chev');
      m.click(next);
      assert(titleOf(m) === 'November 2026', `next: ${titleOf(m)}`);
      m.click(prev);
      assert(show(seen.slice(4)) === show(['next', 'prev']) && titleOf(m) === 'October 2026', `the chevrons: ${show(seen)}`);
    } finally {
      m.unmount();
    }
    for (const [store, want] of [
      [failedStore('error'), 'retry 2026-10 famcal'],
      [failedStore('busy'), 'retry 2026-10 famcal'],
      [googleStore({ status: 'ok', partial: { failed: 0, truncated: 2 } }), 'retry 2026-10 google'],
      [googleStore({ status: 'error', reason: 'transient' }), 'retry 2026-10 google'],
      [googleStore({ status: 'error', reason: 'calendars_gone' }), 'choose'],
    ] as const) {
      const got: string[] = [];
      const n = mount(inHome('en', createElement(PickedHost, { store, start: picked('2026-10-03'), seen: got })));
      try {
        n.click(one(n.container, 'ch-state-action'));
        assert(show(got) === show([want]), `the notice's action: ${show(got)}, want ${want}`);
      } finally {
        n.unmount();
      }
    }
  });

  await check('#11 on mount the page scrolls to the top, then focus goes to the selected day without a scroll (Ruling 6); later taps neither scroll nor move focus; each mount does it again', () => {
    installWindow();
    pageLog.length = 0;
    const seen: string[] = [];
    const m = mount(inHome('en', createElement(PickedHost, { store: octoberStore(), start: picked('2026-10-16'), seen })));
    try {
      const sixteenth = cellFor(m, '2026-10-16');
      assert(show(pageLog) === show(['scrollTo [0,0]', `focus ${sixteenth.getAttribute('aria-label')} {"preventScroll":true}`]), `on mount: ${show(pageLog)}`);
      assert(fakeDocument.activeElement === sixteenth, 'focus on the selected day');
      pageLog.length = 0;
      m.click(cellFor(m, '2026-10-20'));
      m.click(byClass(m.container, 'ch-mp-chev')[1]);
      m.click(cellFor(m, '2026-11-05'));
      assert(pageLog.length === 0 && fakeDocument.activeElement === sixteenth, `later taps: ${show(pageLog)}`);
    } finally {
      m.unmount();
    }
    pageLog.length = 0;
    const again = mount(inHome('ru', createElement(PickedHost, { store: octoberStore(), start: picked(TODAY), seen })));
    try {
      const today = cellFor(again, TODAY, 'ru');
      assert(show(pageLog) === show(['scrollTo [0,0]', `focus ${today.getAttribute('aria-label')} {"preventScroll":true}`]), `a new mount: ${show(pageLog)}`);
    } finally {
      again.unmount();
    }
  });

  await check(`#12 the CSS: nothing under 11 px (the Hebrew day and "+N" at 11), every size in px; All months, Today and the chevrons at least 44 × 44; cells PICKED_CELL_PX (${PICKED_CELL_PX}) tall, within 46–48; logical properties only; no hover; overflow: hidden only on the Hebrew line; the bottom safe area; dots filled or a 1.5 px ring; today, selected and disabled colours; only tokens the theme defines; the markup's buttons, icons and style sheets`, () => {
    const css = MONTH_PICKED_CSS;
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 8 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px');
    assert(/font-size: 11px/.test(rule('.ch-mp-heb')) && /font-size: 11px/.test(rule('.ch-mp-more')), 'the Hebrew day and "+N" at 11 px');
    for (const selector of ['.ch-mp-back', '.ch-mp-today', '.ch-mp-chev']) {
      const r = rule(selector);
      assert(/min-height: 44px/.test(r) && /min-width: 44px/.test(r), `${selector}: ${r}`);
    }
    assert(/inline-size: 44px/.test(rule('.ch-mp-chev')) && /block-size: 44px/.test(rule('.ch-mp-chev')), 'the chevrons are 44 × 44');
    const cell = rule('.ch-mp-cell');
    assert(PICKED_CELL_PX >= 46 && PICKED_CELL_PX <= 48 && cell.includes(`block-size: ${PICKED_CELL_PX}px`) && /min-height: 44px/.test(cell), `the cell: ${cell}`);
    const physical = css.match(/(?:margin|padding|border)-(?:left|right|top|bottom)|(?:^|[\s;{])(?:left|right|top|bottom)\s*:|text-align:\s*(?:left|right)|float:|(?:^|[\s;{])(?:width|height)\s*:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    const hidden = [...css.matchAll(/\n([^\n{]+) \{[^}]*overflow:\s*hidden/g)].map((m) => m[1]);
    assert(show(hidden) === show(['.ch-mp-heb']), `overflow: hidden on ${show(hidden)}`);
    assert(rule('.ch-mp').includes('var(--tg-safe-area-inset-bottom, 0px)') && /padding-block-end:/.test(rule('.ch-mp')), `the bottom safe area: ${rule('.ch-mp')}`);
    assert(/background: var\(--ch-dot-mine\)/.test(rule('.ch-mp-dot.is-mine')) && /border: 1\.5px solid var\(--ch-dot-partner\)/.test(rule('.ch-mp-dot.is-partner')), 'filled dots and rings');
    assert(/color: var\(--ch-accent\)/.test(rule('.ch-mp-cell.is-today .ch-mp-num')), 'today\'s number as text reads --ch-accent (E4 note 3)');
    assert(/background: var\(--ch-selected\)/.test(rule(".ch-mp-cell[aria-pressed='true'] .ch-mp-num")) && /background: var\(--ch-today\)/.test(rule(".ch-mp-cell.is-today[aria-pressed='true'] .ch-mp-num")), 'the selected day and today selected');
    assert(/color: var\(--ch-disabled\)/.test(rule('.ch-mp-chev:disabled')) && /color: var\(--ch-muted\)/.test(rule('.ch-mp-cell.is-failed .ch-mp-num')), 'disabled and dimmed');
    assert(/background: var\(--ch-pill-bg\)/.test(rule('.ch-mp-today-pill')) && /color: var\(--ch-pill-text\)/.test(rule('.ch-mp-today-pill')), 'the pill');
    assert(/outline: 2px solid var\(--ch-accent\)/.test(css), 'a focus ring');
    assert(/\.ch-home\[dir='rtl'\] \.ch-flip \{\s*transform: scaleX\(-1\);/.test(HOME_SHELL_CSS), 'the shell flips .ch-flip in RTL');
    const defined = new Set([...(HOME_THEME_CSS + HOME_SHELL_CSS + AGENDA_CSS).matchAll(/(--(?:ch|cal)-[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    const undefinedTokens = used.filter((n) => !n.startsWith('--tg-') && !defined.has(n));
    assert(used.length >= 15 && undefinedTokens.length === 0, `tokens read but not defined: ${show(undefinedTokens)}`);
    assert(/@keyframes ch-pulse/.test(AGENDA_CSS) && /prefers-reduced-motion: reduce/.test(HOME_THEME_CSS), 'the placeholder pulse is D\'s, and reduced motion stops it');
    const html = render('en', propsFor(octoberStore(), picked('2026-10-16')));
    const buttons = markup(html).match(/<button[^>]*>/g) ?? [];
    assert(buttons.length > 35 && buttons.every((b) => b.includes('type="button"')), `buttons: ${show(buttons.filter((b) => !b.includes('type="button"')))}`);
    const blocks = (markup(html).match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []).filter((b) => /<(?:div|p|h\d|ul|li|section)[\s>]/.test(b));
    assert(blocks.length === 0, `block elements inside a button: ${show(blocks.slice(0, 2))}`);
    const svgs = markup(html).match(/<svg[^>]*>/g) ?? [];
    assert(svgs.length >= 3 && svgs.every((s) => s.includes('aria-hidden="true"')), 'icons are aria-hidden');
    assert(html.includes('.ch-row {') && html.includes('.ch-mp-cell {'), 'D\'s AGENDA_CSS and the picked CSS are both rendered');
  });

  await check('#13 a short screen (Ruling 6): entering picked goes to the top while the header, the tabs, the bar, the month and the day\'s first row fit; else only as far down as shows the day\'s header and its first row, never past the bar (pickedScrollTop): E7\'s fixed heights for 6 rows, with and without the trial and location banners, on 390 × 844, 375 × 667 and 320 × 568; in real React, one scroll to where the layout and its day header measure, less the layout\'s scroll margin (the safe areas)', () => {
    const css = MONTH_PICKED_CSS;
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    const decl = (selector: string, prop: string) => (new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+);`).exec(rule(selector))?.[1] ?? '').trim().split(/\s+/).map((v) => Number.parseFloat(v) || 0);
    // The layout's fixed heights down to the end of the day's header, from its CSS.
    const bar = decl('.ch-mp-bar', 'margin-block')[0] + decl('.ch-mp-back', 'min-height')[0];
    const nav = decl('.ch-mp-chev', 'block-size')[0] + decl('.ch-mp-nav', 'margin-block')[1];
    const weekdays = decl('.ch-mp-weekdays', 'padding-block').reduce((a, b) => a + b, 0) + decl('.ch-mp-weekdays', 'line-height')[0] + 1;
    const dayHead = decl('.ch-mp-day', 'margin-block').reduce((a, b) => a + b, 0) + Math.ceil(decl('.ch-mp-day', 'font-size')[0] * decl('.ch-mp-day', 'line-height')[0]);
    assert(show([bar, nav, weekdays, dayHead]) === show([50, 46, 27, 37]), `the bar, the nav, the weekday row and the day's header: ${show([bar, nav, weekdays, dayHead])}`);
    const head = (rows: number) => bar + nav + weekdays + rows * PICKED_CELL_PX + dayHead;
    // Above the layout (D's and E4's CSS): the header with its Hebrew line (16 + 27.5 + 19 + 12),
    // the tab bar (44 + 4), and the trial and location banners (4 + 56 + 8 + 56).
    const above = (banners: boolean) => 75 + 48 + (banners ? 124 : 0);
    const cases: [string, number, number, boolean, number][] = [
      ['390 × 844 (the mockups\' phone), 6 rows', 740, 6, false, 0],
      ['390 × 844, 6 rows, two banners', 740, 6, true, 19],
      ['375 × 667, 5 rows', 560, 5, false, 27],
      ['375 × 667, 6 rows', 560, 6, false, 75],
      ['375 × 667, 6 rows, two banners', 560, 6, true, 199],
      ['320 × 568, 6 rows', 470, 6, false, 123],
      ['320 × 568, 6 rows, two banners', 470, 6, true, 247],
    ];
    for (const [label, viewport, rows, banners, want] of cases) {
      const layoutTop = above(banners);
      const end = layoutTop + head(rows);
      const top = pickedScrollTop(layoutTop, end, viewport);
      assert(top === want, `${label}: ${top} (want ${want})`);
      assert(top <= layoutTop, `${label}: scrolled past the bar`);
      assert(end - top <= viewport, `${label}: the day's header is off screen`);
      if (top < layoutTop) assert(end + PICKED_FIRST_ROW_PX - top <= viewport, `${label}: the day's first row is off screen`);
    }
    // The layout stops under the safe areas when it goes to the top of the screen.
    assert(/scroll-margin-block-start: calc\(var\(--tg-safe-area-inset-top, 0px\) \+ var\(--tg-content-safe-area-inset-top, 0px\)\);/.test(rule('.ch-mp')), `the layout's scroll margin: ${rule('.ch-mp')}`);
    // In real React: the layout and its day header measure where the banners left them.
    installWindow();
    const proto = FakeElement.prototype as unknown as Row;
    const saved = { innerHeight: fakeWindow.innerHeight, scrollY: fakeWindow.scrollY, getComputedStyle: fakeWindow.getComputedStyle };
    const at = { layout: 0, dayHead: 0, margin: 0 };
    proto.getBoundingClientRect = function (this: FakeElement) {
      const y = Number(fakeWindow.scrollY) || 0;
      const top = this.className.split(' ').includes('ch-mp') ? at.layout : this.getAttribute('id') === 'ch-mp-day' ? at.dayHead - 37 : 0;
      const height = this.getAttribute('id') === 'ch-mp-day' ? 37 : 0;
      return { top: top - y, bottom: top - y + height, left: 0, right: 0, width: 0, height, x: 0, y: top - y };
    };
    fakeWindow.getComputedStyle = (el: FakeElement) => ({ scrollMarginBlockStart: el.className.split(' ').includes('ch-mp') ? `${at.margin}px` : '0px', scrollMarginTop: '0px' });
    try {
      const run = (layout: number, dayHeadBottom: number, viewport: number, margin: number) => {
        Object.assign(at, { layout, dayHead: dayHeadBottom, margin });
        fakeWindow.innerHeight = viewport;
        fakeWindow.scrollY = 0;
        pageLog.length = 0;
        const m = mount(inHome('en', createElement(PickedHost, { store: octoberStore(), start: picked('2026-10-16'), seen: [] })));
        try {
          return pageLog.filter((l) => l.startsWith('scrollTo'));
        } finally {
          m.unmount();
        }
      };
      const sixRows = 75 + 48 + 124 + head(6);
      assert(show(run(247, sixRows, 560, 0)) === show(['scrollTo [0,199]']), `375 × 667 with two banners: ${show(pageLog)}`);
      assert(show(run(247, sixRows, 470, 20)) === show(['scrollTo [0,227]']), `320 × 568 with two banners, a 20 px safe area: ${show(pageLog)}`);
      assert(show(run(247, sixRows, 800, 0)) === show(['scrollTo [0,0]']), `a tall screen: ${show(pageLog)}`);
    } finally {
      delete proto.getBoundingClientRect;
      Object.assign(fakeWindow, saved);
      if (!saved.getComputedStyle) delete fakeWindow.getComputedStyle;
    }
  });

  await check('#14 each dot in its calendar\'s colour (spec 2026-10-19 §3.3): filled or a ring as before, with has-cal and the calendar\'s tones for both looks inline (calendarVars); a masked calendar (color null) or a colour that isn\'t #rrggbb keeps today\'s dot, with no style', () => {
    const styleOf = (color: string) => Object.entries(calendarVars(color) ?? {}).map(([k, v]) => `${k}:${v}`).join(';');
    const html = render('en', propsFor(octoberStore(), picked('2026-10-16')));
    const mine = new Set<string>();
    const partner = new Set<string>();
    for (const cell of days(html)) {
      cell.dots.forEach((whose, i) => {
        const c = cell.colours[i];
        assert(c.cal && c.style !== null, `day ${cell.num} dot ${i}: no colour`);
        (whose === 'is-mine' ? mine : partner).add(c.style);
      });
    }
    const known = [styleOf(MY_CAL.color ?? ''), styleOf(NOA_CAL.color ?? '')];
    assert(mine.size > 0 && partner.size > 0 && [...mine, ...partner].every((s) => known.includes(s)), `the dots' styles: ${show([...mine, ...partner])}`);
    assert(cellOn(html, 15).colours[2].style === styleOf(NOA_CAL.color ?? ''), 'the 15th\'s ring is Noa\'s calendar\'s');
    const plain = storeOf([ok(answer({ items: { '2026-10-21': [
      item('masked', { start: at('2026-10-21', '10:00'), end: at('2026-10-21', '11:00'), calendar: { id: null, name: 'Noa', color: null, mine: false, inLegend: false } }),
      item('named', { start: at('2026-10-21', '12:00'), end: at('2026-10-21', '13:00'), calendar: { ...MY_CAL, color: 'red' } }),
    ] } }))]);
    const cell21 = cellOn(render('en', propsFor(plain, picked('2026-10-16'))), 21);
    assert(show(cell21.dots) === show(['is-partner', 'is-mine']) && show(cell21.colours) === show([{ cal: false, style: null }, { cal: false, style: null }]), `the 21st: ${show(cell21)}`);
  });

  await check('#15 React logged no warning in any render (keys, nesting, attributes, act)', () => {
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
