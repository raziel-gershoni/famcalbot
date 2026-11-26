// Smoke test for the one Month screen's month pane (responsive home, release 2; spec
// §2–§4; plan docs/superpowers/plans/2026-11-26-responsive-home-layouts.md, Tasks 3 and 4).
//
// The squares part (Task 3): app/[locale]/(app)/dashboard/MonthSquares.tsx, a month's grid of
// size-aware day squares. Its models come from E5's buildMonth over range answers that go
// through D3's real reducer, as smoke-calendar-month-browse.ts feeds them, and it renders in
// en, he and ru through next-intl with the real messages. It checks:
//  - the markup: dir, the rows (grid-template-rows: repeat(<weeks>, 1fr)) for 4-, 5- and
//    6-week months, one button per day of the month and a blank, aria-hidden span for the
//    rest, browse's labels ("Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa", the
//    holidays), aria-current on today only and aria-pressed="true" on the selected day only;
//  - small squares: the day, the Hebrew day (with the month's short name on Hebrew day 1 and
//    the month's first day) and picked's dots (filled for the viewer's, a ring for the
//    partner's, "+N" past 3), no chips and no holiday line; medium adds the holiday line
//    (browse's rule: the brief, a yom tov in the accent, the portion never over the month
//    name); large draws browse's head line, the line and fitRow's chips ("+N more" last,
//    bars joined and titled once per week row), and is-big; daily reminders in none (R11);
//  - loading and failed days never look free, and the month's pills (Ruling 1): busy, an
//    error, calendars gone, partial;
//  - the calendar colours on dots and chips, and the anniversary count pill;
//  - the CSS: lintCss clean (nothing under 11 px, logical properties, no hover, tokens), the
//    44 px tap floor waived for the square alone, the heights adding up to month-layout.ts's
//    (the large head and slots, the small square's tiers from 48 px down to 30 px);
//  - in real React (scripts/lib/fake-dom.ts): a tap on a square, Retry and Choose again;
//  - client-safe imports; React logs no warning. No network, no DB, no Redis.
//
// Run with the fake env (no dotenv):
//   TZ=UTC npx tsx scripts/smoke-month-pane.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-month-pane.ts

// The view first: the import-rule check walks what it loads.
import { MONTH_SQUARES_CSS, MonthSquaresGrid, SquareChip, type MonthSquaresGridProps } from '../app/[locale]/(app)/dashboard/MonthSquares';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import fs from 'fs';
import path from 'path';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { calendarVars } from '../src/lib/calendar-view/colours';
import { monthGrid, type MonthKey } from '../src/lib/calendar-view/grid';
import { holidaysFor } from '../src/lib/calendar-view/holidays-client';
import { buildMonth, type MonthModel, type MonthSlot } from '../src/lib/calendar-view/month';
import { SQUARE_SLOT_BIG_PX, SQUARE_SLOT_PX, SQUARE_USED_BIG_PX, SQUARE_USED_PX, squareSize, type SquareSize } from '../src/lib/calendar-view/month-layout';
import { daysInWindow, emptyStore, reduceStore, type CalendarStore, type GoogleStatus, type StoreAction } from '../src/lib/calendar-view/store';
import { compareItems, type CalendarDTO, type DayKey, type Holiday, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse, type SourceName, type WeekStart } from '../src/lib/calendar-view/types';
import { lintCss } from './lib/css-lint';
import { FakeElement, elements, installWindow, mount, type FakeNode } from './lib/fake-dom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
type Locale = 'en' | 'he' | 'ru';

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

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 (smoke-calendar-month-browse.ts's) ----

const TZ = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';
const SELECTED: DayKey = '2026-10-16';

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
    repeatsEveryDay: false,
    canEdit: true,
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
const CAMP = item('camp', { title: 'Camp', start: '2026-10-21', end: '2026-10-23', allDay: true, tz: null, calendar: NOA_CAL });
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
  '2026-10-21': [CAMP],
  '2026-10-22': [CAMP],
  '2026-10-25': [EILAT],
  '2026-10-26': [EILAT, SNORKEL, SPA, PORT],
  '2026-10-27': [EILAT],
  '2026-10-28': [EILAT],
  '2026-10-29': [EILAT],
};

/** October's holidays in English, as GET /api/calendar/holidays answers them (made up for the rules, not hebcal's). */
const HOLIDAYS: Record<DayKey, Holiday[]> = {
  // The month's first day (20 Tishrei, not Hebrew day 1) with a portion: the month's name keeps the line.
  '2026-10-01': [{ title: 'Parashat Test', brief: 'Test', chag: false, kind: 'parasha' }],
  '2026-10-03': [{ title: 'Shmini Atzeret', brief: 'Shmini Atzeret', chag: true, kind: 'chag' }],
  // Hebrew day 1, Rosh Chodesh (no yom tov): the month's name keeps the line.
  '2026-10-12': [{ title: 'Rosh Chodesh Cheshvan', brief: 'Rosh Chodesh', chag: false, kind: 'roshChodesh' }],
  '2026-10-17': [{ title: 'Parashat Noach', brief: 'Noach', chag: false, kind: 'parasha' }],
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
  canEdit: false,
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

function modelOf(store: CalendarStore, month: MonthKey): MonthModel {
  const model = buildMonth(store, month);
  assert(model, `no model for ${month}`);
  return model;
}

// The sizes, from month-layout.ts's own rule (a 54 px wide phone square, a 120 px laptop one).
const SMALL = squareSize(44, 54);
const MEDIUM = squareSize(70, 54);
const LARGE2 = squareSize(82, 54);
const LARGE3 = squareSize(92, 54);
const BIG = squareSize(300, 120);

// ---- Rendering ----

function inIntl(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}

/** The home's frame around the grid (CalendarHome's root and its tokens). */
function inHome(locale: Locale, el: ReactElement): ReactElement {
  return inIntl(locale, createElement('div', { className: 'ch-app ch-screen ch-home', 'data-theme': 'light' }, createElement('style', null, APP_THEME_CSS), el));
}

function gridProps(store: CalendarStore, month: MonthKey, size: SquareSize, o: Partial<MonthSquaresGridProps> = {}): MonthSquaresGridProps {
  const facts = store.facts;
  assert(facts, 'the fixture pinned no facts');
  return {
    model: modelOf(store, month),
    month,
    today: facts.today,
    selected: SELECTED,
    hebrewDates: facts.hebrewDates,
    size,
    onSelectDay: noop,
    onRetryMonth: noop,
    onChooseCalendars: noop,
    ...o,
  };
}

/** The markup without the style sheets (their class names would match anything). */
const markup = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
const renderGrid = (locale: Locale, props: MonthSquaresGridProps) => markup(renderToString(inHome(locale, createElement(MonthSquaresGrid, props))));

function decode(text: string): string {
  return text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const attrOf = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^| )${name}="([^"]*)"`).exec(attrs);
  return m ? decode(m[1]) : null;
};

type SquareView = { cls: string[]; label: string; pressed: string | null; current: string | null; inner: string };

/** The day squares in a piece of markup, in order. */
function squaresOf(html: string): SquareView[] {
  return [...html.matchAll(/<button ([^>]*class="ch-sq(?: [^"]*)?"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    cls: (attrOf(m[1], 'class') ?? '').split(' '),
    label: attrOf(m[1], 'aria-label') ?? '',
    pressed: attrOf(m[1], 'aria-pressed'),
    current: attrOf(m[1], 'aria-current'),
    inner: m[2],
  }));
}

function squareOf(html: string, labelStart: string): SquareView {
  const found = squaresOf(html).filter((s) => s.label.startsWith(`${labelStart},`));
  assert(found.length === 1, `one square labelled ${show(labelStart)}: ${show(squaresOf(html).map((s) => s.label).slice(0, 8))}`);
  return found[0];
}

/** A small or medium square's top: its day and Hebrew day. */
const topOf = (sq: SquareView) => {
  const m = /<span class="ch-sq-top" aria-hidden="true"><span class="ch-sq-num" dir="ltr">(\d+)<\/span>(?:<span class="ch-sq-heb">([^<]*)<\/span>)?<\/span>/.exec(sq.inner);
  assert(m, `no top in ${show(sq.inner.slice(0, 300))}`);
  return { day: m[1], hebrew: m[2] === undefined ? null : decode(m[2]) };
};
/** A large square's head line: its day and Hebrew day. */
const headOf = (sq: SquareView) => {
  const m = /^<span class="ch-sq-head" aria-hidden="true"><span class="ch-sq-num" dir="ltr">(\d+)<\/span>(?:<span class="ch-sq-hday">([^<]*)<\/span>)?<\/span>/.exec(sq.inner);
  assert(m, `no head line in ${show(sq.inner.slice(0, 300))}`);
  return { day: m[1], hebrew: m[2] === undefined ? null : decode(m[2]) };
};
/** The holiday line: its text, whether in the accent, its dir; null without one. */
const lineOf = (sq: SquareView) => {
  const m = /<span class="ch-sq-line( has-chag)?"( dir="auto")? aria-hidden="true">([^<]*)<\/span>/.exec(sq.inner);
  return m ? { text: decode(m[3]), chag: !!m[1], auto: !!m[2] } : null;
};
/** Picked's dots: is-mine / is-partner, each with its calendar colour, then "+N". */
const dotsOf = (sq: SquareView) => {
  const marks = /<span class="ch-sq-marks" aria-hidden="true">([\s\S]*?)<\/span>(?=<\/button>|$)/.exec(sq.inner)?.[1] ?? null;
  assert(marks !== null, `no marks in ${show(sq.inner.slice(0, 300))}`);
  const dots = [...marks.matchAll(/<span class="ch-sq-dot (is-mine|is-partner)( has-cal)?"(?: style="([^"]*)")?><\/span>/g)].map((d) => ({ whose: d[1], cal: !!d[2], style: d[3] ?? null }));
  const plus = /<span class="ch-sq-plus" dir="ltr">([^<]*)<\/span>/.exec(marks)?.[1] ?? null;
  return { dots, plus, ghost: marks.includes('ch-sq-dot-ghost') };
};
/** A large square's chips: their classes (has-cal aside), their text, their calendar colour. */
const chipsOf = (sq: SquareView) =>
  [...sq.inner.matchAll(/<span class="(ch-sq-chip[^"]*?)( has-cal)?"(?: style="([^"]*)")?>(?:<bdi>([^<]*)<\/bdi>)?<\/span>/g)].map((m) => ({
    cls: m[1],
    text: decode(m[4] ?? ''),
    cal: !!m[2],
    style: m[3] ?? null,
  }));
const moreOf = (sq: SquareView) => /<span class="ch-sq-more">([^<]*)<\/span>/.exec(sq.inner)?.[1] ?? null;

// ---- The CSS, as rules ----

type Rule = { selector: string; body: string };
/** The innermost rules: a rule inside @media, @container or @keyframes comes out with its own selector. */
const cssRules = (css: string): Rule[] => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const ruleOf = (css: string, selector: string) => {
  const found = cssRules(css).filter((r) => r.selector === selector);
  assert(found.length === 1, `one ${selector} rule: ${found.length}`);
  return found[0].body;
};
const declOf = (body: string, prop: string) => new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;
const px = (value: unknown) => Number.parseFloat(String(value ?? '')) || 0;
/** A @container block's body, by its condition. */
const containerBlock = (css: string, condition: string) => {
  const at = css.indexOf(`@container ${condition} {`);
  assert(at >= 0, `no @container ${condition}`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`@container ${condition} is not closed`);
};

async function main() {
  // October's holidays in English land in the client cache before any render; any other month or language answers none.
  (globalThis as Row).fetch = async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ days: String(url).includes('from=2026-10-01') && String(url).includes('lang=en') ? HOLIDAYS : {} }),
  });
  await holidaysFor('2026-10', 'en');

  await check('#1 the squares are client-safe: MonthSquares loads no server module (DB, Redis, services, date-fns-tz, @hebcal/core), no home-client and no Telegram code; it reads month.ts, hebrew-date.ts and format.ts', () => {
    const root = path.join(ROOT, 'app/[locale]/(app)/dashboard/MonthSquares.tsx');
    assert(require.cache[root] !== undefined, 'MonthSquares is not in require.cache: the check would be empty');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    for (const want of ['src/lib/calendar-view/month.ts', 'src/lib/calendar-view/hebrew-date.ts', 'src/lib/calendar-view/format.ts']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma|telegram-ui|calendar-view[\\/]home-client)/.test(p),
    );
    assert(forbidden.length === 0, `modules the squares must not load: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#2 en: dir="ltr"; the rows as repeat(<weeks>, 1fr); one button per day of the month and a blank aria-hidden span for the rest; browse\'s labels with the holidays; aria-current="date" on today only and aria-pressed="true" on the selected day only, "false" on the rest, in every size', () => {
    const html = renderGrid('en', gridProps(famcalStore(), '2026-10', LARGE3));
    assert(/^<div class="ch-app ch-screen ch-home" data-theme="light"><div class="ch-sq-body" dir="ltr">/.test(html), `the root: ${html.slice(0, 200)}`);
    assert(html.includes('<div class="ch-sq-grid is-large" style="grid-template-rows:repeat(5, 1fr)">'), `the grid: ${show(/<div class="ch-sq-grid[^>]*>/.exec(html)?.[0])}`);
    const squares = squaresOf(html);
    assert(squares.length === 31, `31 day buttons: ${squares.length}`);
    const blanks = html.match(/<span class="ch-sq is-blank"[^>]*>/g) ?? [];
    assert(blanks.length === 4 && blanks.every((b) => b === '<span class="ch-sq is-blank" aria-hidden="true">'), `4 blank days, aria-hidden spans: ${show(blanks)}`);
    const labels = ['Thursday, 15 October', 'Friday, 16 October', 'Saturday, 17 October', 'Monday, 12 October', 'Tuesday, 6 October', 'Thursday, 1 October', 'Saturday, 3 October', 'Monday, 26 October'].map(
      (d) => squareOf(html, d).label,
    );
    assert(
      show(labels) ===
        show([
          'Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa',
          'Friday, 16 October, 5 Cheshvan, 1 item, 1 from Noa',
          'Saturday, 17 October, 6 Cheshvan, Parashat Noach, nothing planned',
          'Monday, 12 October, 1 Cheshvan, Rosh Chodesh Cheshvan, nothing planned',
          'Tuesday, 6 October, 25 Tishrei, 1 item',
          'Thursday, 1 October, 20 Tishrei, Parashat Test, nothing planned',
          'Saturday, 3 October, 22 Tishrei, Shmini Atzeret, nothing planned',
          'Monday, 26 October, 15 Cheshvan, 4 items, 2 from Noa',
        ]),
      `labels: ${show(labels)}`,
    );
    for (const size of [SMALL, MEDIUM, LARGE3, BIG]) {
      const all = size === LARGE3 ? squares : squaresOf(renderGrid('en', gridProps(famcalStore(), '2026-10', size)));
      const tag = `${size.kind}${size.big ? ' big' : ''}`;
      assert(show(all.filter((s) => s.current !== null).map((s) => [s.label.slice(0, 20), s.current])) === show([['Thursday, 15 October', 'date']]), `${tag}: aria-current="date" on today only`);
      assert(show(all.filter((s) => s.pressed === 'true').map((s) => s.label.slice(0, 18))) === show(['Friday, 16 October']), `${tag}: aria-pressed="true" on the selected day only`);
      assert(all.length === 31 && all.every((s) => s.pressed === 'true' || s.pressed === 'false'), `${tag}: every square says whether it is pressed`);
    }
    assert(squareOf(html, 'Thursday, 15 October').cls.includes('is-today') && !squareOf(html, 'Friday, 16 October').cls.includes('is-today'), 'today is marked');
    // A selected day in another month presses none.
    const elsewhere = squaresOf(renderGrid('en', gridProps(famcalStore(), '2026-10', LARGE3, { selected: '2026-12-02' })));
    assert(elsewhere.every((s) => s.pressed === 'false'), 'a selected day of another month presses none');
    // Without Hebrew dates: no Hebrew day or holidays in the labels.
    const plain = renderGrid('en', gridProps(famcalStore({ hebrewDates: false }), '2026-10', LARGE3));
    assert(squareOf(plain, 'Saturday, 3 October').label === 'Saturday, 3 October, nothing planned', `without Hebrew dates: ${squareOf(plain, 'Saturday, 3 October').label}`);
    assert(!/ch-sq-hday|ch-sq-heb|Cheshvan|Chesh\./.test(plain), 'no Hebrew day in the squares');
  });

  await check('#3 the rows: 4-, 5- and 6-week months for week starts 0, 1 and 6, each its own repeat(<weeks>, 1fr) and as many squares as days, in every size', () => {
    for (const ws of [0, 1, 6] as const) {
      const store = famcalStore({ weekStart: ws });
      for (const month of ['2026-02', '2026-08', '2026-10', '2027-01'] as const) {
        for (const size of [SMALL, MEDIUM, LARGE3]) {
          const html = renderGrid('en', gridProps(store, month, size));
          const weeks = monthGrid(month, ws).length;
          assert(html.includes(`<div class="ch-sq-grid is-${size.kind}" style="grid-template-rows:repeat(${weeks}, 1fr)">`), `ws ${ws} ${month} ${size.kind}: ${show(/<div class="ch-sq-grid[^>]*>/.exec(html)?.[0])}`);
          const days = daysInWindow(windowOf(month).from, windowOf(month).to).length;
          const squares = squaresOf(html).length;
          const blanks = (html.match(/<span class="ch-sq is-blank" aria-hidden="true">/g) ?? []).length;
          assert(squares === days && squares + blanks === weeks * 7, `ws ${ws} ${month} ${size.kind}: ${squares} squares, ${blanks} blanks, ${weeks} weeks`);
        }
      }
    }
    const rows = new Set((['2026-02', '2026-08', '2026-10'] as const).map((m) => monthGrid(m, 0).length));
    assert(show([...rows].sort()) === show([4, 5, 6]), `4-, 5- and 6-week months: ${show([...rows])}`);
  });

  await check('#4 small: the day, the Hebrew day with the month\'s short name on Hebrew day 1 and the 1st, picked\'s dots (the viewer\'s filled, the partner\'s a ring, "+N" past 3); no chips and no holiday line; the daily reminder neither dotted nor counted (R11)', () => {
    assert(show(SMALL) === show({ kind: 'small', lines: 0, big: false }), `the small size: ${show(SMALL)}`);
    const html = renderGrid('en', gridProps(famcalStore(), '2026-10', SMALL));
    assert(html.includes('<div class="ch-sq-grid is-small" style="grid-template-rows:repeat(5, 1fr)">'), 'the grid is small');
    const tops = ['Thursday, 15 October', 'Monday, 12 October', 'Thursday, 1 October', 'Tuesday, 13 October'].map((d) => topOf(squareOf(html, d)));
    assert(
      show(tops) === show([{ day: '15', hebrew: '4' }, { day: '12', hebrew: '1 Chesh.' }, { day: '1', hebrew: '20 Tish.' }, { day: '13', hebrew: '2' }]),
      `the tops: ${show(tops)}`,
    );
    const want: [string, string[], string | null][] = [
      ['Thursday, 15 October', ['is-mine', 'is-mine', 'is-partner'], null],
      ['Wednesday, 14 October', ['is-mine', 'is-mine', 'is-partner'], null],
      ['Friday, 16 October', ['is-partner'], null],
      ['Monday, 26 October', ['is-mine', 'is-partner', 'is-partner'], '+1'],
      ['Saturday, 17 October', [], null],
    ];
    for (const [d, dots, plus] of want) {
      const got = dotsOf(squareOf(html, d));
      assert(show(got.dots.map((x) => x.whose)) === show(dots) && got.plus === plus && !got.ghost, `${d}: ${show(got)}`);
    }
    assert(!/ch-sq-chip|ch-sq-slot|ch-sq-more|ch-sq-line|ch-sq-head/.test(html), 'no chips, slots, "+N more", head line or holiday line');
    assert(!html.includes('Take vitamins') && squareOf(html, 'Thursday, 15 October').label.includes('3 items'), 'the daily reminder is not dotted or counted');
    assert(squaresOf(html).every((s) => /^<span class="ch-sq-top" aria-hidden="true">[\s\S]*<span class="ch-sq-marks" aria-hidden="true">/.test(s.inner)), 'the top and the marks are aria-hidden');
  });

  await check('#5 medium: the small square plus the holiday line (browse\'s rule): a yom tov\'s brief in the accent, the portion on a Saturday, nothing where the month\'s name is already on the Hebrew day (the portion never over it, Rosh Chodesh on Hebrew day 1 neither); still dots, no chips', () => {
    assert(show(MEDIUM) === show({ kind: 'medium', lines: 0, big: false }), `the medium size: ${show(MEDIUM)}`);
    const html = renderGrid('en', gridProps(famcalStore(), '2026-10', MEDIUM));
    assert(html.includes('<div class="ch-sq-grid is-medium" style="grid-template-rows:repeat(5, 1fr)">'), 'the grid is medium');
    const lines = ['Saturday, 3 October', 'Saturday, 17 October', 'Thursday, 1 October', 'Monday, 12 October', 'Thursday, 15 October'].map((d) => lineOf(squareOf(html, d)));
    assert(
      show(lines) ===
        show([
          { text: 'Shmini Atzeret', chag: true, auto: true },
          { text: 'Noach', chag: false, auto: true },
          { text: '', chag: false, auto: false },
          { text: '', chag: false, auto: false },
          { text: '', chag: false, auto: false },
        ]),
      `the lines: ${show(lines)}`,
    );
    assert(topOf(squareOf(html, 'Thursday, 1 October')).hebrew === '20 Tish.' && topOf(squareOf(html, 'Monday, 12 October')).hebrew === '1 Chesh.', 'the month\'s name stays on the Hebrew day');
    assert(squaresOf(html).every((s) => lineOf(s) !== null), 'every square keeps its line (so the days line up)');
    const dots = dotsOf(squareOf(html, 'Monday, 26 October'));
    assert(show(dots.dots.map((x) => x.whose)) === show(['is-mine', 'is-partner', 'is-partner']) && dots.plus === '+1', `the dots: ${show(dots)}`);
    assert(!/ch-sq-chip|ch-sq-slot|ch-sq-more|ch-sq-head/.test(html), 'no chips');
    assert(!html.includes('Take vitamins'), 'the daily reminder is not drawn');
  });

  await check('#6 large, 3 lines: browse\'s head line and line; a day of 3 shows 3 chips, a day of 4 shows 2 and "+2 more"; whose (mine filled, the partner\'s outlined), done struck through, titles isolated in <bdi>; 2 lines: 1 and "+2 more"; the line: a yom tov\'s brief in the accent, the month\'s short name over a portion and over Rosh Chodesh', () => {
    assert(show(LARGE3) === show({ kind: 'large', lines: 3, big: false }) && show(LARGE2) === show({ kind: 'large', lines: 2, big: false }), `the large sizes: ${show([LARGE3, LARGE2])}`);
    const html = renderGrid('en', gridProps(famcalStore(), '2026-10', LARGE3));
    const chips = (d: string) => chipsOf(squareOf(html, d)).map((c) => `${c.cls}|${c.text}`);
    assert(
      show(chips('Thursday, 15 October')) ===
        show(['ch-sq-chip is-timed is-mine-timed|Dentist', 'ch-sq-chip is-timed is-mine-timed|Send the school form', 'ch-sq-chip is-timed is-partner-timed|Football practice']),
      `15 Oct: ${show(chips('Thursday, 15 October'))}`,
    );
    assert(moreOf(squareOf(html, 'Thursday, 15 October')) === null, 'a day of 3 has no "+N"');
    assert(
      show(chips('Monday, 26 October')) === show(['ch-sq-chip is-bar is-mine-solid is-before is-after|', 'ch-sq-chip is-timed is-partner-timed|Snorkeling']) && moreOf(squareOf(html, 'Monday, 26 October')) === '+2 more',
      `26 Oct: ${show([chips('Monday, 26 October'), moreOf(squareOf(html, 'Monday, 26 October'))])}`,
    );
    assert(show(chips('Tuesday, 6 October')) === show(['ch-sq-chip is-timed is-mine-timed is-done|Call Mom']), `6 Oct: ${show(chips('Tuesday, 6 October'))}`);
    assert(show(chips('Friday, 16 October')) === show(['ch-sq-chip is-allDay is-partner-solid|Grandma visits']), `16 Oct: ${show(chips('Friday, 16 October'))}`);
    assert(!html.includes('Take vitamins'), 'the daily reminder is not drawn (R11)');
    const heads = ['Thursday, 15 October', 'Monday, 12 October', 'Thursday, 1 October'].map((d) => headOf(squareOf(html, d)));
    assert(show(heads) === show([{ day: '15', hebrew: '4' }, { day: '12', hebrew: '1' }, { day: '1', hebrew: '20' }]), `the head lines: ${show(heads)}`);
    const lines = ['Saturday, 3 October', 'Saturday, 17 October', 'Thursday, 1 October', 'Monday, 12 October', 'Thursday, 15 October'].map((d) => lineOf(squareOf(html, d)));
    assert(
      show(lines) ===
        show([
          { text: 'Shmini Atzeret', chag: true, auto: true },
          { text: 'Noach', chag: false, auto: true },
          { text: 'Tish.', chag: false, auto: false },
          { text: 'Chesh.', chag: false, auto: false },
          { text: '', chag: false, auto: false },
        ]),
      `the lines: ${show(lines)}`,
    );
    assert(squaresOf(html).every((s) => /<span class="ch-sq-slots" aria-hidden="true">/.test(s.inner)), 'every slot list is aria-hidden');
    assert(!/ch-sq-dot|ch-sq-marks|ch-sq-top/.test(html), 'no dots in a large square');
    const two = renderGrid('en', gridProps(famcalStore(), '2026-10', LARGE2));
    assert(
      show(chipsOf(squareOf(two, 'Thursday, 15 October')).map((c) => c.text)) === show(['Dentist']) && moreOf(squareOf(two, 'Thursday, 15 October')) === '+2 more',
      `2 lines, 15 Oct: ${show([chipsOf(squareOf(two, 'Thursday, 15 October')), moreOf(squareOf(two, 'Thursday, 15 October'))])}`,
    );
  });

  await check('#7 bars: joined across days (is-after, then is-before), titled on the first day of each week row only: Camp over Wed–Thu named once; the Eilat trip from Sunday 25 named once from Sunday, twice from Monday (a new row on the 26th); every day of a bar in its calendar\'s colour', () => {
    const html = renderGrid('en', gridProps(famcalStore(), '2026-10', LARGE3));
    const first = (sq: SquareView) => chipsOf(sq).find((c) => c.cls.includes('is-bar'));
    const camp = ['Wednesday, 21 October', 'Thursday, 22 October'].map((d) => first(squareOf(html, d)));
    assert(
      show(camp.map((c) => c && `${c.cls}|${c.text}`)) === show(['ch-sq-chip is-bar is-partner-solid is-after|Camp', 'ch-sq-chip is-bar is-partner-solid is-before|']),
      `Camp: ${show(camp)}`,
    );
    const eilatDays = ['Sunday, 25 October', 'Monday, 26 October', 'Tuesday, 27 October', 'Wednesday, 28 October', 'Thursday, 29 October'];
    const eilat = eilatDays.map((d) => first(squareOf(html, d)));
    assert(
      show(eilat.map((c) => c && `${c.cls}|${c.text}`)) ===
        show([
          'ch-sq-chip is-bar is-mine-solid is-after|Eilat trip',
          'ch-sq-chip is-bar is-mine-solid is-before is-after|',
          'ch-sq-chip is-bar is-mine-solid is-before is-after|',
          'ch-sq-chip is-bar is-mine-solid is-before is-after|',
          'ch-sq-chip is-bar is-mine-solid is-before|',
        ]),
      `the Eilat bar from Sunday: ${show(eilat)}`,
    );
    const styleOf = (color: string | null) => Object.entries(calendarVars(color) ?? {}).map(([k, v]) => `${k}:${v}`).join(';');
    assert(eilat.every((c) => c?.cal && c.style === styleOf(MY_CAL.color)), 'every day of the bar in its calendar\'s colour');
    const ws1 = renderGrid('en', gridProps(famcalStore({ weekStart: 1 }), '2026-10', LARGE3));
    const titled = eilatDays.map((d) => first(squareOf(ws1, d))?.text);
    assert(show(titled) === show(['Eilat trip', 'Eilat trip', '', '', '']), `from Monday, a title at each row's start: ${show(titled)}`);
  });

  await check('#8 big (110 × 100 and more): is-big on the grid, every item named (7 lines), the bar still joined; the CSS draws 13 px chips in 21 px slots', () => {
    assert(show(BIG) === show({ kind: 'large', lines: 7, big: true }), `the big size: ${show(BIG)}`);
    const html = renderGrid('en', gridProps(famcalStore(), '2026-10', BIG));
    assert(html.includes('<div class="ch-sq-grid is-large is-big" style="grid-template-rows:repeat(5, 1fr)">'), `the grid: ${show(/<div class="ch-sq-grid[^>]*>/.exec(html)?.[0])}`);
    const chips = chipsOf(squareOf(html, 'Monday, 26 October')).map((c) => `${c.cls}|${c.text}`);
    assert(
      show(chips) ===
        show(['ch-sq-chip is-bar is-mine-solid is-before is-after|', 'ch-sq-chip is-timed is-partner-timed|Snorkeling', 'ch-sq-chip is-timed is-partner-timed|Spa', 'ch-sq-chip is-timed is-mine-timed|Dinner at the port']) &&
        moreOf(squareOf(html, 'Monday, 26 October')) === null,
      `26 Oct: ${show(chips)}`,
    );
    assert(px(declOf(ruleOf(MONTH_SQUARES_CSS, '.ch-sq-grid.is-big .ch-sq-chip'), 'font-size')) === 13, 'big chips are 13 px');
    assert(px(declOf(ruleOf(MONTH_SQUARES_CSS, '.ch-sq-grid.is-big .ch-sq-slot'), 'block-size')) === SQUARE_SLOT_BIG_PX && SQUARE_SLOT_BIG_PX === 21, 'in 21 px slots');
  });

  await check('#9 he: dir="rtl"; Hebrew labels; the Hebrew day in gematriya (small: with the month on Hebrew day 1 and the 1st; large: the day, the month on the line); "+N" in Hebrew; chips keep the grid\'s direction', () => {
    const small = renderGrid('he', gridProps(famcalStore(), '2026-10', SMALL));
    assert(/<div class="ch-sq-body" dir="rtl">/.test(small), 'the root is dir="rtl"');
    const labels = ['יום חמישי, 15 באוקטובר', 'יום שישי, 16 באוקטובר', 'יום שבת, 17 באוקטובר'].map((d) => squareOf(small, d).label);
    assert(
      show(labels) === show(['יום חמישי, 15 באוקטובר, ד׳ בחשון, 3 אירועים, 1 של Noa', 'יום שישי, 16 באוקטובר, ה׳ בחשון, אירוע אחד, 1 של Noa', 'יום שבת, 17 באוקטובר, ו׳ בחשון, אין אירועים']),
      `labels: ${show(labels)}`,
    );
    const tops = ['יום חמישי, 15 באוקטובר', 'יום שני, 12 באוקטובר', 'יום חמישי, 1 באוקטובר'].map((d) => topOf(squareOf(small, d)));
    assert(show(tops) === show([{ day: '15', hebrew: 'ד׳' }, { day: '12', hebrew: 'א׳ חשון' }, { day: '1', hebrew: 'כ׳ תשרי' }]), `small tops: ${show(tops)}`);
    assert(dotsOf(squareOf(small, 'יום שני, 26 באוקטובר')).plus === '+1', 'the dots\' "+N"');
    const large = renderGrid('he', gridProps(famcalStore(), '2026-10', LARGE3));
    const heads = ['יום חמישי, 15 באוקטובר', 'יום שני, 12 באוקטובר'].map((d) => ({ ...headOf(squareOf(large, d)), line: lineOf(squareOf(large, d))?.text }));
    assert(show(heads) === show([{ day: '15', hebrew: 'ד׳', line: '' }, { day: '12', hebrew: 'א׳', line: 'חשון' }]), `large heads: ${show(heads)}`);
    assert(moreOf(squareOf(large, 'יום שני, 26 באוקטובר')) === 'עוד 2', '"+N more" in Hebrew');
    const tags = large.match(/<span class="ch-sq-chip[^>]*>/g) ?? [];
    assert(tags.length > 10 && tags.every((tag) => !/ dir=/.test(tag)), `a chip with its own direction: ${show(tags.find((tag) => / dir=/.test(tag)))}`);
    assert(/<span class="ch-sq-chip is-bar[^"]*is-after[^"]*"[^>]*><bdi>/.test(large) && /<span class="ch-sq-chip is-bar[^"]*is-before[^"]*"[^>]*><\/span>/.test(large), 'a titled segment isolates its title in <bdi>; an untitled one is empty');
  });

  await check('#10 ru: dir="ltr"; the labels with the genitive Hebrew month (R9) and "Noa: 1"; the short month after a number; "+N more" in Russian', () => {
    const small = renderGrid('ru', gridProps(famcalStore(), '2026-10', SMALL));
    assert(/<div class="ch-sq-body" dir="ltr">/.test(small), 'the root is dir="ltr"');
    const labels = ['четверг, 15 октября', 'пятница, 16 октября', 'суббота, 17 октября'].map((d) => squareOf(small, d).label);
    assert(
      show(labels) === show(['четверг, 15 октября, 4 хешвана, 3 события, Noa: 1', 'пятница, 16 октября, 5 хешвана, 1 событие, Noa: 1', 'суббота, 17 октября, 6 хешвана, ничего не запланировано']),
      `labels: ${show(labels)}`,
    );
    assert(topOf(squareOf(small, 'понедельник, 12 октября')).hebrew === '1 хешв.' && topOf(squareOf(small, 'четверг, 1 октября')).hebrew === '20 тишр.', 'the short months');
    const large = renderGrid('ru', gridProps(famcalStore(), '2026-10', LARGE3));
    assert(moreOf(squareOf(large, 'понедельник, 26 октября')) === 'Ещё 2' && lineOf(squareOf(large, 'понедельник, 12 октября'))?.text === 'хешв.', 'the large square in Russian');
  });

  await check('#11 no free-looking day while a month loads or failed (§5): September loading shows a placeholder in every size and reads "loading"; November busy and December\'s error are dimmed under a centred pill with Retry; an answered month has no pill', () => {
    const store = famcalStore();
    for (const size of [SMALL, MEDIUM, LARGE3]) {
      const september = squaresOf(renderGrid('en', gridProps(store, '2026-09', size)));
      const ghost = size.kind === 'large' ? 'ch-sq-ghost' : 'ch-sq-dot-ghost';
      assert(september.length === 30 && september.every((s) => s.cls.includes('is-loading') && s.inner.includes(ghost) && s.label.endsWith(', loading')), `${size.kind} September: ${show(september.slice(0, 1))}`);
    }
    for (const [month, pill, count] of [
      ['2026-11', 'Busy right now, try again in a minute', 30],
      ['2026-12', 'Couldn’t load this month', 31],
    ] as const) {
      const html = renderGrid('en', gridProps(store, month, LARGE3));
      const squares = squaresOf(html);
      assert(squares.length === count && squares.every((s) => s.cls.includes('is-failed') && s.label.endsWith(', couldn’t load') && !s.inner.includes('ghost')), `${month} dimmed: ${show(squares.slice(0, 1))}`);
      const overlay = /<div class="ch-sq-overlay is-centre"><div class="ch-sq-pill"><span class="ch-sq-pill-text">([^<]*)<\/span><button type="button" class="ch-btn ch-sq-pill-action">([^<]*)<\/button><\/div><\/div>/.exec(html);
      assert(overlay && show([decode(overlay[1]), overlay[2]]) === show([pill, 'Retry']), `${month}'s pill: ${show(overlay?.slice(1))}`);
      assert(html.indexOf('ch-sq-overlay') < html.indexOf('ch-sq-grid'), 'the pill comes before the grid, over it');
    }
    assert(!renderGrid('en', gridProps(store, '2026-10', SMALL)).includes('ch-sq-overlay'), 'an answered month has no pill');
  });

  await check('#12 a Google user (Ruling 1): calendars gone is a centred pill with Choose again; partial a pill at the top over live squares; a reconnect dims the squares with no pill (the banner says it)', () => {
    const store = googleStore();
    const october = renderGrid('en', gridProps(store, '2026-10', SMALL));
    assert(/<div class="ch-sq-overlay is-top"><div class="ch-sq-pill"><span class="ch-sq-pill-text">Some calendars didn’t load<\/span><button type="button" class="ch-btn ch-sq-pill-action">Retry<\/button><\/div><\/div>/.test(october), 'October: the partial pill at the top');
    assert(squaresOf(october).every((s) => !s.cls.includes('is-failed') && !s.cls.includes('is-loading')), 'October\'s squares stay live');
    assert(squareOf(october, 'Thursday, 15 October').label === 'Thursday, 15 October, 4 Cheshvan, 1 item', `no "from" without a partner: ${squareOf(october, 'Thursday, 15 October').label}`);
    const november = renderGrid('en', gridProps(store, '2026-11', SMALL));
    assert(/<div class="ch-sq-overlay is-centre"><div class="ch-sq-pill"><span class="ch-sq-pill-text">Your calendars aren’t available<\/span><button type="button" class="ch-btn ch-sq-pill-action">Choose again<\/button>/.test(november), 'November: calendars gone');
    const december = renderGrid('en', gridProps(store, '2026-12', SMALL));
    assert(!december.includes('ch-sq-overlay') && squaresOf(december).every((s) => s.cls.includes('is-failed')), 'December: dimmed, no pill');
  });

  await check('#13 the calendar colours (spec 2026-10-19 §3.3): every dot and chip has-cal with its calendar\'s tones inline (calendarVars); a masked calendar (color null) or a colour that isn\'t #rrggbb keeps the plain look with no style; the CSS fills the viewer\'s dot in --cal-line and rings the partner\'s in it, and draws chips in --cal-fill, --cal-text and --cal-line', () => {
    const styleOf = (color: string | null) => Object.entries(calendarVars(color) ?? {}).map(([k, v]) => `${k}:${v}`).join(';');
    const small = renderGrid('en', gridProps(famcalStore(), '2026-10', SMALL));
    const dots = dotsOf(squareOf(small, 'Thursday, 15 October')).dots;
    assert(
      show(dots) === show([{ whose: 'is-mine', cal: true, style: styleOf(MY_CAL.color) }, { whose: 'is-mine', cal: true, style: styleOf(MY_CAL.color) }, { whose: 'is-partner', cal: true, style: styleOf(NOA_CAL.color) }]),
      `15 Oct's dots: ${show(dots)}`,
    );
    const large = renderGrid('en', gridProps(famcalStore(), '2026-10', LARGE3));
    const chips = chipsOf(squareOf(large, 'Thursday, 15 October')).map((c) => ({ text: c.text, cal: c.cal, style: c.style }));
    assert(
      show(chips) === show([{ text: 'Dentist', cal: true, style: styleOf(MY_CAL.color) }, { text: 'Send the school form', cal: true, style: styleOf(MY_CAL.color) }, { text: 'Football practice', cal: true, style: styleOf(NOA_CAL.color) }]),
      `15 Oct's chips: ${show(chips)}`,
    );
    const plain = storeOf([
      ok(
        answer('2026-10', {
          '2026-10-21': [timed('masked', 'Masked', '2026-10-21', '10:00', '11:00', { id: null, name: 'Noa', color: null, mine: false, inLegend: false }), timed('named', 'Named', '2026-10-21', '12:00', '13:00', { ...MY_CAL, color: 'red' })],
        }),
      ),
    ]);
    const plainDots = dotsOf(squareOf(renderGrid('en', gridProps(plain, '2026-10', SMALL)), 'Wednesday, 21 October')).dots;
    assert(show(plainDots) === show([{ whose: 'is-partner', cal: false, style: null }, { whose: 'is-mine', cal: false, style: null }]), `21 Oct's plain dots: ${show(plainDots)}`);
    const plainChips = chipsOf(squareOf(renderGrid('en', gridProps(plain, '2026-10', LARGE3)), 'Wednesday, 21 October'));
    assert(
      show(plainChips) === show([{ cls: 'ch-sq-chip is-timed is-partner-timed', text: 'Masked', cal: false, style: null }, { cls: 'ch-sq-chip is-timed is-mine-timed', text: 'Named', cal: false, style: null }]),
      `21 Oct's plain chips: ${show(plainChips)}`,
    );
    const css = MONTH_SQUARES_CSS;
    assert(declOf(ruleOf(css, '.ch-sq-dot.has-cal.is-mine'), 'background') === 'var(--cal-line)', 'the viewer\'s dot: --cal-line');
    assert(declOf(ruleOf(css, '.ch-sq-dot.has-cal.is-partner'), 'border-color') === 'var(--cal-line)', 'the partner\'s ring: --cal-line');
    assert(declOf(ruleOf(css, '.ch-sq-dot.is-mine'), 'background') === 'var(--ch-dot-mine)' && declOf(ruleOf(css, '.ch-sq-dot.is-partner'), 'border') === '1.5px solid var(--ch-dot-partner)', 'without a colour: picked\'s dots');
    const mine = ruleOf(css, '.ch-sq-chip.has-cal.is-mine-timed,\n.ch-sq-chip.has-cal.is-mine-solid');
    const partner = ruleOf(css, '.ch-sq-chip.has-cal.is-partner-timed,\n.ch-sq-chip.has-cal.is-partner-solid');
    assert(show([declOf(mine, 'background'), declOf(mine, 'color')]) === show(['var(--cal-fill)', 'var(--cal-text)']), `the viewer's chips: ${mine}`);
    assert(show([declOf(partner, 'border-color'), declOf(partner, 'background'), declOf(partner, 'color')]) === show(['var(--cal-line)', 'var(--ch-bg)', 'var(--cal-text)']), `the partner's chips: ${partner}`);
  });

  await check('#14 the anniversary count pill: <bdi class="ch-sq-chip-title"> then .ch-sq-count (aria-hidden) on a titled chip with a count; none without a count or on an untitled bar day; the slot is the container and the pill shows from 64 px; a spacer is an empty slot', () => {
    const slot: MonthSlot = {
      kind: 'allDay',
      key: 'famcal|yahrzeit',
      title: 'Grandpa’s yahrzeit',
      showTitle: true,
      mine: true,
      color: MY_CAL.color,
      count: 12,
      done: false,
      continuesBefore: false,
      continuesAfter: false,
      canEdit: true,
      repeatsEveryDay: false,
    };
    const html = renderToString(createElement(SquareChip, { slot, noTitle: '(No title)' }));
    assert(/^<span class="ch-sq-slot"><span class="ch-sq-chip is-allDay is-mine-solid has-count has-cal" style="[^"]*"><bdi class="ch-sq-chip-title">Grandpa’s yahrzeit<\/bdi><span class="ch-sq-count" aria-hidden="true">12<\/span><\/span><\/span>$/.test(html), `the chip: ${html}`);
    assert(!renderToString(createElement(SquareChip, { slot: { ...slot, count: null }, noTitle: '' })).includes('ch-sq-count'), 'no count, no pill');
    assert(!renderToString(createElement(SquareChip, { slot: { ...slot, showTitle: false }, noTitle: '' })).includes('ch-sq-count'), 'an untitled bar day has no pill');
    assert(renderToString(createElement(SquareChip, { slot: { ...slot, title: null }, noTitle: '(No title)' })).includes('<bdi class="ch-sq-chip-title">(No title)</bdi>'), 'no title reads (No title)');
    assert(renderToString(createElement(SquareChip, { slot: { ...slot, kind: 'spacer', key: null }, noTitle: '' })) === '<span class="ch-sq-slot"></span>', 'a spacer is an empty slot');
    const css = MONTH_SQUARES_CSS;
    assert(declOf(ruleOf(css, '.ch-sq-slot'), 'container-type') === 'inline-size', 'the slot is the container');
    const counts = cssRules(css).filter((r) => r.selector === '.ch-sq-count');
    assert(counts.length === 2 && declOf(counts[0].body, 'display') === 'none', `the pill is off by default: ${show(counts)}`);
    assert(/@container \(min-width: 64px\) \{\s*\.ch-sq-count \{\s*display: inline-block;\s*\}\s*\}/.test(css), 'the pill shows from 64 px');
    assert(declOf(ruleOf(css, '.ch-sq-chip-title'), 'text-overflow') === 'ellipsis', 'the title truncates');
  });

  await check('#15 the CSS: lintCss clean (nothing under 11 px, every size in px, logical properties only, no hover, colours only in tokens; browse\'s pill shadow is the one exemption); the 44 px floor waived for .ch-sq alone (no minimum height; the pill and its .ch-btn keep 44); only tokens the theme defines; today on --ch-today, the selected day on --ch-selected, both on --ch-today; failed dimmed; the drop outline left to DRAG_CSS; the placeholders\' pulse stops under reduced motion', () => {
    const css = MONTH_SQUARES_CSS;
    const problems = lintCss(css, { exempt: ['box-shadow: 0 2px 8px rgba(18, 18, 32, 0.12);'] });
    assert(problems.length === 0, `lintCss: ${show(problems)}`);
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 10 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    // The 44 px waiver: the square is as tall as its row (36 px in a short split, about 30 sideways); every other tap keeps 44.
    const square = ruleOf(css, '.ch-sq');
    assert(declOf(square, 'min-height') === '0' && declOf(square, 'min-block-size') === null, `the square has no tap minimum: ${square}`);
    assert(px(declOf(ruleOf(css, '.ch-sq-pill'), 'min-height')) >= 44, 'a pill is at least 44 px');
    assert(/\.ch-btn \{[^}]*min-height: 44px;[^}]*min-width: 44px;/.test(APP_THEME_CSS), 'the pill\'s action is a .ch-btn (44 × 44)');
    const taps = [...renderGrid('en', gridProps(googleStore(), '2026-11', SMALL)).matchAll(/<button [^>]*class="([^"]*)"/g)].map((m) => m[1].split(' ')[0]);
    assert(new Set(taps).size === 2 && taps.includes('ch-sq') && taps.includes('ch-btn'), `the only taps are the squares and the pill's .ch-btn: ${show([...new Set(taps)])}`);
    const used = new Set([...css.matchAll(/var\((--ch-[a-z-]+)/g)].map((m) => m[1]));
    const defined = new Set([...APP_THEME_CSS.matchAll(/(--ch-[a-z-]+)\s*:/g)].map((m) => m[1]));
    const unknown = [...used].filter((v) => !defined.has(v));
    assert(unknown.length === 0, `tokens theme.ts doesn't define: ${show(unknown)}`);
    const fill = (selector: string) => [declOf(ruleOf(css, selector), 'background'), declOf(ruleOf(css, selector), 'color')];
    assert(show(fill('.ch-sq.is-today .ch-sq-num')) === show(['var(--ch-today)', 'var(--ch-today-text)']), 'today on --ch-today');
    assert(show(fill(".ch-sq[aria-pressed='true'] .ch-sq-num")) === show(['var(--ch-selected)', 'var(--ch-selected-text)']), 'the selected day on --ch-selected');
    assert(show(fill(".ch-sq.is-today[aria-pressed='true'] .ch-sq-num")) === show(['var(--ch-today)', 'var(--ch-today-text)']), 'today selected stays on --ch-today');
    const order = ['.ch-sq.is-failed .ch-sq-num {', '.ch-sq.is-today .ch-sq-num {', ".ch-sq[aria-pressed='true'] .ch-sq-num {", ".ch-sq.is-today[aria-pressed='true'] .ch-sq-num {"].map((s) => css.indexOf(s));
    assert(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `the fills cascade in order (failed, today, selected, both): ${show(order)}`);
    assert(declOf(ruleOf(css, '.ch-sq.is-failed'), 'background') === 'var(--ch-surface)', 'a failed day is dimmed');
    assert(!/\.is-drop\b/.test(css), 'the drop outline is DRAG_CSS\'s .is-drop');
    assert(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ch-sq-ghost,\s*\.ch-sq-dot-ghost \{\s*animation: none;/.test(css), 'reduced motion stops the placeholders\' pulse');
    const animated = cssRules(css).filter((r) => /animation\s*:/.test(r.body)).map((r) => r.selector).sort();
    assert(show(animated) === show(['.ch-sq-dot-ghost', '.ch-sq-ghost', '.ch-sq-ghost,\n  .ch-sq-dot-ghost']), `the placeholders are the only animations: ${show(animated)}`);
    assert(!/(?:^|[\s;{])(?:transform|filter|backdrop-filter|perspective|will-change)\s*:/.test(css), 'no transform or filter');
    assert(!/:hover/.test(css), 'no hover');
  });

  await check('#16 the heights add up: the square is a size container that clips; a large square\'s rule, padding, head and line are month-layout\'s SQUARE_USED_PX (35) and SQUARE_USED_BIG_PX (41), its slots SQUARE_SLOT_PX (18) and SQUARE_SLOT_BIG_PX (21); a medium square fits 60 px; a small one 48 px, 42 under 48 (an 18 px day) and 30 under 42 (the day and the Hebrew day on one line)', () => {
    const css = MONTH_SQUARES_CSS;
    const square = ruleOf(css, '.ch-sq');
    assert(declOf(square, 'container-type') === 'size' && declOf(square, 'overflow') === 'hidden', `the square: ${square}`);
    assert(declOf(square, 'border-block-start') === '1px solid var(--ch-separator)', 'its 1 px rule');
    const rule = 1;
    const padStart = (selector: string) => px((declOf(ruleOf(css, selector), 'padding-block') ?? '').split(' ')[0]);
    const block = (selector: string) => px(declOf(ruleOf(css, selector), 'block-size'));
    // Large.
    const large = rule + padStart('.ch-sq-grid.is-large .ch-sq') + block('.ch-sq-head') + block('.ch-sq-line');
    assert(large === SQUARE_USED_PX && block('.ch-sq-slot') === SQUARE_SLOT_PX, `large: ${large} + slots of ${block('.ch-sq-slot')}`);
    const big = rule + padStart('.ch-sq-grid.is-large .ch-sq') + block('.ch-sq-grid.is-big .ch-sq-head') + block('.ch-sq-grid.is-big .ch-sq-line');
    assert(big === SQUARE_USED_BIG_PX && block('.ch-sq-grid.is-big .ch-sq-slot') === SQUARE_SLOT_BIG_PX, `big: ${big}`);
    assert(block('.ch-sq-grid.is-big .ch-sq-chip') + px(declOf(ruleOf(css, '.ch-sq-slot'), 'padding-block-start')) === SQUARE_SLOT_BIG_PX, 'a big chip fills its slot');
    // Small and medium: the top (the day over the Hebrew day), the line (medium), the marks.
    const base = rule + padStart('.ch-sq');
    const num = block('.ch-sq-num');
    const heb = px(declOf(ruleOf(css, '.ch-sq-heb'), 'line-height'));
    const marks = block('.ch-sq-marks') + px(declOf(ruleOf(css, '.ch-sq-marks'), 'margin-block-start'));
    assert(base + num + heb + marks === 48, `small: ${base} + ${num} + ${heb} + ${marks}`);
    assert(base + num + heb + block('.ch-sq-grid.is-medium .ch-sq-line') + marks <= MEDIUM_MIN_PX, `medium: ${base + num + heb + block('.ch-sq-grid.is-medium .ch-sq-line') + marks} within ${MEDIUM_MIN_PX}`);
    const short = containerBlock(css, '(max-height: 47px)');
    const shortNum = px(declOf(ruleOf(short, '.ch-sq-grid.is-small .ch-sq-num'), 'block-size'));
    assert(base + shortNum + heb + marks <= 42, `under 48: ${base + shortNum + heb + marks}`);
    const shorter = containerBlock(css, '(max-height: 41px)');
    assert(declOf(ruleOf(shorter, '.ch-sq-grid.is-small .ch-sq-top'), 'flex-direction') === 'row', 'under 42: the day and the Hebrew day on one line');
    assert(base + Math.max(shortNum, heb) + marks <= 30, `under 42: ${base + Math.max(shortNum, heb) + marks} within 30`);
    assert(squareSize(59, 54).kind === 'small' && squareSize(60, 54).kind === 'medium', 'the medium floor is 60 px');
  });

  installWindow();

  await check('#17 in real React: a tap on a square calls onSelectDay with its day (the selected one too: the grown split collapses on it); Retry on a pill calls onRetryMonth(month, source); Choose again calls onChooseCalendars; a blank day is no button', () => {
    const seen: string[] = [];
    const props = (store: CalendarStore, month: MonthKey) =>
      gridProps(store, month, SMALL, {
        onSelectDay: (day) => void seen.push(`select ${day}`),
        onRetryMonth: (m, source) => void seen.push(`retry ${m} ${source}`),
        onChooseCalendars: () => void seen.push('choose'),
      });
    const squareFor = (node: FakeNode, label: string) => {
      const found = elements(node).filter((e) => e.tagName === 'BUTTON' && (e.getAttribute('aria-label') ?? '').startsWith(`${label},`));
      assert(found.length === 1, `one square for ${label}: ${found.length}`);
      return found[0];
    };
    const october = mount(inIntl('en', createElement(MonthSquaresGrid, props(famcalStore(), '2026-10'))));
    try {
      october.click(squareFor(october.container, 'Tuesday, 20 October'));
      october.click(squareFor(october.container, 'Friday, 16 October'));
      const blank = elements(october.container).find((e) => e.className === 'ch-sq is-blank');
      assert(blank instanceof FakeElement && blank.tagName === 'SPAN', 'a blank day is a span');
    } finally {
      october.unmount();
    }
    const pill = (m: ReturnType<typeof mount>) => elements(m.container).find((e) => e.className === 'ch-btn ch-sq-pill-action');
    const busy = mount(inIntl('en', createElement(MonthSquaresGrid, props(famcalStore(), '2026-11'))));
    try {
      const retry = pill(busy);
      assert(retry, 'no Retry');
      busy.click(retry);
    } finally {
      busy.unmount();
    }
    const gone = mount(inIntl('en', createElement(MonthSquaresGrid, props(googleStore(), '2026-11'))));
    try {
      const choose = pill(gone);
      assert(choose, 'no Choose again');
      gone.click(choose);
    } finally {
      gone.unmount();
    }
    assert(show(seen) === show(['select 2026-10-20', 'select 2026-10-16', 'retry 2026-11 famcal', 'choose']), `the callbacks: ${show(seen)}`);
  });

  await check('#18 React logged no warning', () => {
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

/** squareSize's medium floor (spec §4: small under 60 px). */
const MEDIUM_MIN_PX = 60;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
