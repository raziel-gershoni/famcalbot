// Smoke test for the one Month screen's month pane (responsive home, release 2; spec
// §2–§4; plan docs/superpowers/plans/2026-11-26-responsive-home-layouts.md, Tasks 3 and 4).
//
// The squares part (Task 3): app/[locale]/(app)/dashboard/MonthSquares.tsx, a month's grid of
// size-aware day squares. Its models come from E5's buildMonth over range answers that go
// through D3's real reducer, as release 1's All months smoke fed them, and it renders in
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
// The pane part (Task 4): app/[locale]/(app)/dashboard/MonthPane.tsx, the bar, the weekday row
// and a scroller of whole months, each one scroller tall and snapping, so a scroll position is
// index × height. Its fake window (scripts/lib/fake-dom.ts) lays the scroller out at 390 × 400,
// runs frames by hand, answers prefers-reduced-motion and has a ResizeObserver a check triggers.
// It checks (ported from release 1's All months smoke, #2, #7, #8, #11, #15–#18, #22, #26b,
// #26c, and the tapped-day screen's #2–#3 and model guard, plus the pane's own):
//  - the bar: ‹ title › at the start, an empty gap, Today at the end (shown while the selected
//    day or the month in view isn't today's; it calls onToday only); the title with its Hebrew
//    months, the jump to a date; the bar row and the weekday row add up to monthBarPx; dir; the
//    weekday row in week-start order; the CSS (the snapping scroller, the 44 px taps, lintCss);
//  - the mount at the month sought (scrollTop 12 × h), one measure a frame, the month under the
//    middle reported once per change with its neighbours as the near months, the squares drawn
//    for those three only; the span asked to grow ('after' at once, 'before' after 150 ms with no
//    scroll), 12 months added above keeping the month in view;
//  - seek (smooth to a neighbour, else instant), step and the chevrons (a month, never a
//    selection; the reach's ends; past the span's end the months asked for first);
//  - a resize put back at once in the observer with no render, the squares' size after 220 ms,
//    scrollerPx standing in for the height; the holidays asked again; unmount lets go of all.
//
// Run with the fake env (no dotenv):
//   TZ=UTC npx tsx scripts/smoke-month-pane.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-month-pane.ts

// The view first: the import-rule check walks what it loads.
import { MONTH_SQUARES_CSS, MonthSquaresGrid, SquareChip, type MonthSquaresGridProps } from '../app/[locale]/(app)/dashboard/MonthSquares';
import { AGENDA_CSS } from '../app/[locale]/(app)/dashboard/AgendaView';
import { DAY_PANEL_CSS, DayPanel } from '../app/[locale]/(app)/dashboard/DayPanel';
import { SPLIT_HANDLE_CSS, SplitHandle } from '../app/[locale]/(app)/dashboard/SplitHandle';
import { MONTH_PANE_CSS, MonthPane, SCROLL_IDLE_MS, type MonthPaneHandle, type MonthPaneProps } from '../app/[locale]/(app)/dashboard/MonthPane';
import { DRAG_AUTO_SCROLL, autoScrollable } from '../app/[locale]/(app)/dashboard/DragSurface';
import { APP_THEME_CSS } from '../components/app-ui/theme';
import fs from 'fs';
import path from 'path';
import React, { Profiler, createElement, createRef, type ComponentProps, type ReactElement, type RefObject } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { calendarVars } from '../src/lib/calendar-view/colours';
import { monthGrid, monthSpan, spanMonths, type MonthKey } from '../src/lib/calendar-view/grid';
import { holidaysFor } from '../src/lib/calendar-view/holidays-client';
import { buildMonth, dayRows, monthBarPx, monthModels, type MonthModel, type MonthSlot } from '../src/lib/calendar-view/month';
import { HANDLE_PX, HANDLE_TAP_PX, HANDLE_TOUCH_PX, SETTLE_MS, SQUARE_SLOT_BIG_PX, SQUARE_SLOT_PX, SQUARE_USED_BIG_PX, SQUARE_USED_PX, squareSize, type SquareSize } from '../src/lib/calendar-view/month-layout';
import { dayStatus, daysInWindow, emptyStore, reduceStore, type CalendarStore, type GoogleStatus, type StoreAction } from '../src/lib/calendar-view/store';
import { compareItems, type CalendarDTO, type DayKey, type Holiday, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse, type SourceName, type WeekStart } from '../src/lib/calendar-view/types';
import { lintCss } from './lib/css-lint';
import { FakeElement, FakeResizeObserver, elements, fakeWindow, fireScroll, installWindow, mount, type FakeNode, type Mounted } from './lib/fake-dom';

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

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 (release 1's All months smoke's) ----

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

// ---- The pane part (Task 4): a scroller with a size, frames, a media query and a ResizeObserver ----

/** The pane's scroller as the fake lays it out (FakeElement.layout): a phone's month pane, 390 px wide (54 px squares). */
const PANE = { height: 400, width: 390, exact: null as number | null };
/** The frames requested and not run yet. */
const frames = new Map<number, () => void>();
let nextFrameId = 1;
/** The media queries' answers (read when the pane asks; it subscribes to none). */
const media = new Map<string, boolean>();
const REDUCED = '(prefers-reduced-motion: reduce)';
/** October 2026's index in monthSpan(TODAY) (12 months back to 18 ahead). */
const OCT = 12;

/** The window a pane needs: frames, matchMedia, a ResizeObserver, and the scroller's size. */
function installPane() {
  fakeWindow.requestAnimationFrame = (fn: () => void) => {
    const id = nextFrameId++;
    frames.set(id, fn);
    return id;
  };
  fakeWindow.cancelAnimationFrame = (id: number) => void frames.delete(id);
  fakeWindow.matchMedia = (query: string) => ({
    media: query,
    get matches() {
      return media.get(query) === true;
    },
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
  });
  fakeWindow.ResizeObserver = FakeResizeObserver;
  FakeElement.layout = (el) => (el.className.split(' ').includes('ch-pane-scroller') ? { clientHeight: PANE.height, clientWidth: PANE.width, height: PANE.exact ?? PANE.height } : null);
}

/** A clean start: no frames, motion allowed, no observers, the phone's size. */
function resetPane() {
  frames.clear();
  media.clear();
  FakeResizeObserver.all = [];
  PANE.height = 400;
  PANE.width = 390;
  PANE.exact = null;
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

/** Real time passes inside act, as the page's own timers would. */
const wait = (ms: number) => React.act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

function paneProps(store: CalendarStore, o: Partial<MonthPaneProps> = {}): MonthPaneProps {
  const facts = store.facts;
  assert(facts, 'the fixture pinned no facts');
  return {
    months: monthSpan(TODAY),
    today: facts.today,
    weekStart: facts.weekStart,
    hebrewDates: facts.hebrewDates,
    getMonth: monthModels(store),
    selected: TODAY,
    seek: { month: '2026-10', seq: 0 },
    scrollerPx: null,
    onSelectDay: noop,
    onMonthInView: noop,
    onNearMonths: noop,
    onNeedMonths: noop,
    onToday: noop,
    onJump: noop,
    onRetryMonth: noop,
    onChooseCalendars: noop,
    ...o,
  };
}

/** The pane's callbacks, recording. */
function paneRecorder() {
  const seen = { inView: [] as MonthKey[], near: [] as MonthKey[][], need: [] as string[], selected: [] as DayKey[], today: 0, jumps: 0, retried: [] as string[], chosen: 0 };
  const callbacks: Partial<MonthPaneProps> = {
    onMonthInView: (month) => void seen.inView.push(month),
    onNearMonths: (months) => void seen.near.push(months),
    onNeedMonths: (edge) => void seen.need.push(edge),
    onSelectDay: (day) => void seen.selected.push(day),
    onToday: () => void seen.today++,
    onJump: () => void seen.jumps++,
    onRetryMonth: (month, source) => void seen.retried.push(`${month}:${source}`),
    onChooseCalendars: () => void seen.chosen++,
  };
  return { seen, callbacks };
}

const paneIn = (locale: Locale, props: MonthPaneProps, ref?: RefObject<MonthPaneHandle | null>) => inIntl(locale, createElement(MonthPane, ref ? { ...props, ref } : props));
const renderPane = (locale: Locale, props: MonthPaneProps) => renderToString(inHome(locale, createElement(MonthPane, props)));

const hasClass = (el: FakeNode, cls: string) => el instanceof FakeElement && el.className.split(' ').includes(cls);
const byClass = (node: FakeNode, cls: string) => elements(node).filter((e) => hasClass(e, cls));
function scrollerOf(m: Mounted): FakeElement {
  const found = byClass(m.container, 'ch-pane-scroller');
  assert(found.length === 1, `one scroller: ${found.length}`);
  return found[0];
}
function monthEl(m: Mounted, month: MonthKey): FakeElement {
  const found = byClass(m.container, 'ch-pane-month').find((e) => e.getAttribute('data-month') === month);
  assert(found, `no month box for ${month}`);
  return found;
}
/** The months that draw their squares (the rest are empty boxes). */
const drawnMonths = (m: Mounted) =>
  byClass(m.container, 'ch-pane-month')
    .filter((e) => e.childNodes.length > 0)
    .map((e) => e.getAttribute('data-month') ?? '');
const squareButtons = (m: Mounted, month: MonthKey) => elements(monthEl(m, month)).filter((e) => e.localName === 'button' && hasClass(e, 'ch-sq'));
function squareButton(m: Mounted, month: MonthKey, labelStart: string): FakeElement {
  const found = squareButtons(m, month).filter((b) => (b.getAttribute('aria-label') ?? '').startsWith(`${labelStart},`));
  assert(found.length === 1, `one square ${show(labelStart)} in ${month}: ${found.length}`);
  return found[0];
}
const gridClassOf = (m: Mounted, month: MonthKey) => elements(monthEl(m, month)).find((e) => hasClass(e, 'ch-sq-grid'))?.className ?? null;
const paneTitle = (m: Mounted) => byClass(m.container, 'ch-pane-title-month')[0]?.textContent ?? null;
const paneHebrew = (m: Mounted) => byClass(m.container, 'ch-pane-title-hebrew')[0]?.textContent ?? null;
const todayOf = (m: Mounted) => byClass(m.container, 'ch-pane-today')[0] ?? null;
const chevronsOf = (m: Mounted) => byClass(m.container, 'ch-pane-chev');
/** The bar's own children, by their first class: the chevrons, the title, the gap, Today. */
const barParts = (m: Mounted) => (byClass(m.container, 'ch-pane-bar')[0]?.childNodes ?? []).map((c) => (c as FakeElement).className.split(' ')[0]);

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

  // ---- The pane (Task 4) ----

  await check('#18 the pane is client-safe: MonthPane loads no server module (DB, Redis, services, date-fns-tz, @hebcal/core), no home-client and no Telegram code; it reads month-layout.ts; its chevrons are useNavDrop targets', () => {
    const root = path.join(ROOT, 'app/[locale]/(app)/dashboard/MonthPane.tsx');
    assert(require.cache[root] !== undefined, 'MonthPane is not in require.cache: the check would be empty');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    assert(loaded.has(path.join(ROOT, 'src/lib/calendar-view/month-layout.ts')), 'month-layout.ts not among the loaded modules: the check would be empty');
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma|telegram-ui|calendar-view[\\/]home-client)/.test(p),
    );
    assert(forbidden.length === 0, `modules the pane must not load: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
    const source = fs.readFileSync(root, 'utf8');
    assert(/useNavDrop\(side\)/.test(source) && /is-drop-nav/.test(source), 'the chevrons take a lifted item (useNavDrop) and show it (is-drop-nav)');
    assert(SCROLL_IDLE_MS === 150, `SCROLL_IDLE_MS: ${SCROLL_IDLE_MS}`);
  });

  await check('#19 the server render: section.ch-pane with dir and the bar\'s row height; each style sheet once (the squares\' and the pane\'s); one box per month of the span in order, the squares drawn for the month sought and its neighbours only, small until measured; the scroller fills, or is scrollerPx tall', () => {
    const raw = renderPane('en', paneProps(famcalStore()));
    assert(raw.includes('<section class="ch-pane" dir="ltr" style="--ch-pane-bar:52px">'), `the root: ${show(/<section[^>]*>/.exec(raw)?.[0])}`);
    assert(raw.split('.ch-pane-scroller {').length === 2 && raw.split('.ch-sq-grid {').length === 2, 'MONTH_PANE_CSS and MONTH_SQUARES_CSS once each');
    const html = markup(raw);
    const boxes = [...html.matchAll(/<div class="ch-pane-month" data-month="(\d{4}-\d{2})">/g)].map((m) => m[1]);
    assert(show(boxes) === show(monthSpan(TODAY)), `one box per month, oldest first: ${boxes.length}`);
    const drawn = [...html.matchAll(/<div class="ch-pane-month" data-month="(\d{4}-\d{2})"><div class="ch-sq-body"/g)].map((m) => m[1]);
    assert(show(drawn) === show(['2026-09', '2026-10', '2026-11']), `drawn: ${show(drawn)}`);
    assert(html.includes('<div class="ch-pane-month" data-month="2026-08"></div>') && html.includes('<div class="ch-pane-month" data-month="2026-12"></div>'), 'the rest are empty boxes');
    assert(html.includes('<div class="ch-pane-scroller">'), 'no scrollerPx: the scroller fills (no inline size)');
    assert((html.match(/class="ch-sq-grid is-small"/g) ?? []).length === 3, 'small squares until the pane measures');
    const split = markup(renderPane('en', paneProps(famcalStore(), { scrollerPx: 300 })));
    assert(split.includes('<div class="ch-pane-scroller" style="block-size:300px;flex:none">'), `scrollerPx: ${show(/<div class="ch-pane-scroller"[^>]*>/.exec(split)?.[0])}`);
    const he = renderPane('he', paneProps(famcalStore()));
    assert(he.includes('<section class="ch-pane" dir="rtl"'), 'he: dir="rtl"');
    const off = renderPane('en', paneProps(storeOf([ok(answer('2026-10', OCTOBER, { hebrewDates: false }))])));
    assert(off.includes('style="--ch-pane-bar:48px"'), 'without Hebrew dates the bar row is 48 px');
  });

  installPane();

  await check('#20 the bar (en, he, ru): ‹ title › at the start, an empty gap, Today at the end; the chevrons named; the title the month in view with its year and, with Hebrew dates, its Hebrew months under it, the jump to a date; the bar row and the weekday row add up to monthBarPx', () => {
    for (const [locale, want] of [
      ['en', { title: 'October 2026', hebrew: 'Tishrei – Cheshvan 5787', jump: 'October 2026, go to a date', prev: 'Previous month', next: 'Next month', today: 'Today' }],
      ['he', { title: 'אוקטובר 2026', hebrew: 'תשרי – חשון תשפ״ז', jump: 'אוקטובר 2026, מעבר לתאריך', prev: 'החודש הקודם', next: 'החודש הבא', today: 'היום' }],
      ['ru', { title: 'Октябрь 2026', hebrew: 'Тишрей – Хешван 5787', jump: 'Октябрь 2026, перейти к дате', prev: 'Предыдущий месяц', next: 'Следующий месяц', today: 'Сегодня' }],
    ] as const) {
      resetPane();
      const m = mount(paneIn(locale, paneProps(famcalStore(), { selected: '2026-10-16' })));
      try {
        const root = byClass(m.container, 'ch-pane')[0];
        assert(root.getAttribute('dir') === (locale === 'he' ? 'rtl' : 'ltr'), `${locale}: dir ${root.getAttribute('dir')}`);
        assert(show(barParts(m)) === show(['ch-pane-chev', 'ch-pane-title', 'ch-pane-chev', 'ch-pane-gap', 'ch-pane-today']), `${locale}: the bar ${show(barParts(m))}`);
        const [prev, next] = chevronsOf(m);
        assert(prev.getAttribute('aria-label') === want.prev && next.getAttribute('aria-label') === want.next && prev.getAttribute('type') === 'button', `${locale}: chevrons ${prev.getAttribute('aria-label')} / ${next.getAttribute('aria-label')}`);
        const title = byClass(m.container, 'ch-pane-title')[0];
        assert(title.localName === 'button' && title.getAttribute('aria-label') === want.jump && title.getAttribute('aria-haspopup') === 'dialog', `${locale}: the title ${title.getAttribute('aria-label')}`);
        assert(paneTitle(m) === want.title && paneHebrew(m) === want.hebrew, `${locale}: ${paneTitle(m)} / ${paneHebrew(m)}`);
        assert(todayOf(m)?.textContent === want.today, `${locale}: Today ${todayOf(m)?.textContent}`);
        assert(byClass(m.container, 'ch-pane-gap')[0].childNodes.length === 0, 'the gap is empty');
        assert(px(root.style['--ch-pane-bar']) + WEEKDAYS_PX === monthBarPx(true), `the bar row ${root.style['--ch-pane-bar']} + ${WEEKDAYS_PX} = ${monthBarPx(true)}`);
      } finally {
        m.unmount();
      }
    }
    resetPane();
    const off = mount(paneIn('en', paneProps(storeOf([ok(answer('2026-10', OCTOBER, { hebrewDates: false }))]))));
    try {
      assert(paneTitle(off) === 'October 2026' && paneHebrew(off) === null, 'no Hebrew line without Hebrew dates');
      assert(px(byClass(off.container, 'ch-pane')[0].style['--ch-pane-bar']) + WEEKDAYS_PX === monthBarPx(false), 'without Hebrew dates: monthBarPx(false)');
    } finally {
      off.unmount();
    }
  });

  await check('#21 the weekday row in week-start order for week starts 0, 1 and 6 in en, he and ru, aria-hidden', () => {
    const want: Record<Locale, Record<0 | 1 | 6, string>> = {
      en: { 0: 'S M T W T F S', 1: 'M T W T F S S', 6: 'S S M T W T F' },
      he: { 0: 'א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳', 1: 'ב׳ ג׳ ד׳ ה׳ ו׳ ש׳ א׳', 6: 'ש׳ א׳ ב׳ ג׳ ד׳ ה׳ ו׳' },
      ru: { 0: 'Вс Пн Вт Ср Чт Пт Сб', 1: 'Пн Вт Ср Чт Пт Сб Вс', 6: 'Сб Вс Пн Вт Ср Чт Пт' },
    };
    for (const ws of [0, 1, 6] as const) {
      const store = famcalStore({ weekStart: ws });
      for (const locale of ['en', 'he', 'ru'] as const) {
        const html = markup(renderPane(locale, paneProps(store)));
        const row = /<div class="ch-pane-weekdays" aria-hidden="true">((?:<span>[^<]*<\/span>)+)<\/div>/.exec(html)?.[1];
        assert(row, `${locale} ws ${ws}: no aria-hidden weekday row`);
        const days = [...row.matchAll(/<span>([^<]*)<\/span>/g)].map((d) => d[1]).join(' ');
        assert(days === want[locale][ws], `${locale} ws ${ws}: ${days}`);
      }
    }
  });

  await check('#22 the CSS: the scroller (overflow-y auto, overscroll-behavior contain, scroll-snap-type y mandatory, no scroll anchoring) fills; each month block-size 100% and scroll-snap-align start; the bar row is --ch-pane-bar and the weekday row 24 px; lintCss clean; the chevrons 44 × 44, the title and Today at least 44 tall; a chevron under a lifted item outlined; only the theme\'s tokens; no hover', () => {
    const css = MONTH_PANE_CSS;
    const problems = lintCss(css);
    assert(problems.length === 0, `lintCss: ${show(problems)}`);
    const scroller = ruleOf(css, '.ch-pane-scroller');
    const want = { 'overflow-y': 'auto', 'overscroll-behavior': 'contain', 'scroll-snap-type': 'y mandatory', 'overflow-anchor': 'none', flex: '1 1 0', 'min-block-size': '0' };
    for (const [prop, value] of Object.entries(want)) assert(declOf(scroller, prop) === value, `the scroller's ${prop}: ${declOf(scroller, prop)}`);
    const month = ruleOf(css, '.ch-pane-month');
    assert(declOf(month, 'block-size') === '100%' && declOf(month, 'scroll-snap-align') === 'start', `a month: ${month}`);
    const pane = ruleOf(css, '.ch-pane');
    assert(declOf(pane, 'display') === 'flex' && declOf(pane, 'flex-direction') === 'column' && declOf(pane, 'min-block-size') === '0', `the pane is a column: ${pane}`);
    assert(declOf(ruleOf(css, '.ch-pane-bar'), 'block-size') === 'var(--ch-pane-bar)', 'the bar row is --ch-pane-bar');
    const weekdays = ruleOf(css, '.ch-pane-weekdays');
    assert(px(declOf(weekdays, 'block-size')) === WEEKDAYS_PX && declOf(weekdays, 'flex') === 'none', `the weekday row: ${weekdays}`);
    assert(declOf(ruleOf(css, '.ch-pane-gap'), 'flex') === '1', 'the gap takes the free space');
    const chev = ruleOf(css, '.ch-pane-chev');
    assert(px(declOf(chev, 'inline-size')) === 44 && px(declOf(chev, 'block-size')) === 44 && px(declOf(chev, 'min-width')) === 44 && px(declOf(chev, 'min-height')) === 44, `the chevrons: ${chev}`);
    assert(px(declOf(ruleOf(css, '.ch-pane-title'), 'min-height')) >= 44, 'the title is at least 44 px');
    const today = ruleOf(css, '.ch-pane-today');
    assert(px(declOf(today, 'min-height')) >= 44 && px(declOf(today, 'min-width')) >= 44, `Today: ${today}`);
    const drop = ruleOf(css, '.ch-pane-chev.is-drop-nav');
    assert(declOf(drop, 'outline') === '2px solid var(--ch-accent)', `a chevron under a lifted item: ${drop}`);
    assert(declOf(ruleOf(css, '.ch-pane-chev:disabled'), 'color') === 'var(--ch-disabled)', 'a disabled chevron is muted');
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 3 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    const used = new Set([...css.matchAll(/var\((--ch-[a-z-]+)/g)].map((m) => m[1]));
    const defined = new Set([...APP_THEME_CSS.matchAll(/(--ch-[a-z-]+)\s*:/g)].map((m) => m[1]));
    const unknown = [...used].filter((v) => !defined.has(v) && v !== '--ch-pane-bar');
    assert(unknown.length === 0, `tokens theme.ts doesn't define: ${show(unknown)}`);
    assert(!/:hover/.test(css), 'no hover');
  });

  await check('#23 the mount in real React: seek October puts scrollTop at 12 × h at once (no animated scroll); the squares measured at once (400 / 5 weeks, 54 px wide: medium); nothing reported before the first frame, then October in view and Sep–Nov near; one passive scroll listener on the scroller, one ResizeObserver on it', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const m = mount(paneIn('en', paneProps(famcalStore(), callbacks)));
    try {
      const el = scrollerOf(m);
      assert(el.scrollTop === OCT * PANE.height && el.scrollCalls.length === 0, `scrollTop ${el.scrollTop}, calls ${show(el.scrollCalls)}`);
      assert(gridClassOf(m, '2026-10') === 'ch-sq-grid is-medium' && gridClassOf(m, '2026-09') === 'ch-sq-grid is-medium', `measured at once: ${gridClassOf(m, '2026-10')}`);
      assert(show(drawnMonths(m)) === show(['2026-09', '2026-10', '2026-11']), `drawn: ${show(drawnMonths(m))}`);
      assert(seen.inView.length === 0 && seen.near.length === 0, 'nothing reported before the first frame');
      flushFrames();
      assert(show(seen.inView) === show(['2026-10']) && show(seen.near) === show([['2026-09', '2026-10', '2026-11']]), `reported: ${show(seen)}`);
      const scroll = el.listeners.filter((l) => l.type === 'scroll');
      assert(scroll.length === 1 && (scroll[0].options as Row)?.passive === true, `one passive scroll listener: ${show(scroll.map((l) => l.options))}`);
      assert(FakeResizeObserver.all.length === 1 && FakeResizeObserver.all[0].observed.size === 1 && FakeResizeObserver.all[0].observed.has(el), 'one ResizeObserver, on the scroller');
      assert(seen.selected.length === 0 && seen.need.length === 0, `no selection, no growth: ${show(seen)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#24 scrolling: one measure a frame however many scroll events; 13.6 × h reports December once (the month under the middle), near Nov–Jan, the title following, the squares drawn for Nov–Jan only; the same month again reports nothing; the top is the span\'s first month', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const m = mount(paneIn('en', paneProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      const el = scrollerOf(m);
      el.scrollTop = 13.6 * PANE.height;
      fireScroll(el);
      fireScroll(el);
      fireScroll(el);
      assert(frames.size === 1, `three scroll events, one frame: ${frames.size}`);
      flushFrames();
      assert(show(seen.inView) === show(['2026-10', '2026-12']), `in view: ${show(seen.inView)}`);
      assert(show(seen.near.at(-1)) === show(['2026-11', '2026-12', '2027-01']) && seen.near.length === 2, `near: ${show(seen.near)}`);
      assert(paneTitle(m) === 'December 2026', `the title: ${paneTitle(m)}`);
      assert(show(drawnMonths(m)) === show(['2026-11', '2026-12', '2027-01']), `drawn: ${show(drawnMonths(m))}`);
      fireScroll(el, 13.9 * PANE.height);
      flushFrames();
      assert(seen.inView.length === 2 && seen.near.length === 2, 'the same month: no report');
      fireScroll(el, 0);
      flushFrames();
      assert(seen.inView.at(-1) === '2025-10' && show(seen.near.at(-1)) === show(['2025-10', '2025-11']) && paneTitle(m) === 'October 2025', `at the top: ${show(seen.inView)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#25 Today: hidden while today is selected and its month in view; shown when another day is selected or another month is in view; it calls onToday only (no scroll, no selection); far from today (a span around June 2018) the same', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const base = paneProps(famcalStore(), callbacks);
    const m = mount(paneIn('en', base));
    try {
      flushFrames();
      assert(todayOf(m) === null, 'today selected, October in view: no Today');
      m.render(paneIn('en', { ...base, selected: '2026-10-16' }));
      assert(todayOf(m) !== null, 'another day selected: Today');
      m.render(paneIn('en', base));
      assert(todayOf(m) === null, 'today again: no Today');
      const el = scrollerOf(m);
      fireScroll(el, (OCT + 1) * PANE.height);
      flushFrames();
      const button = todayOf(m);
      assert(button && paneTitle(m) === 'November 2026', 'November in view: Today');
      el.scrollCalls.length = 0;
      const top = el.scrollTop;
      m.click(button);
      assert(seen.today === 1 && el.scrollCalls.length === 0 && el.scrollTop === top && seen.selected.length === 0, `onToday only: ${show(seen)} ${show(el.scrollCalls)}`);
    } finally {
      m.unmount();
    }
    resetPane();
    const far = paneRecorder();
    const f = mount(paneIn('en', paneProps(famcalStore(), { ...far.callbacks, months: spanMonths({ first: '2017-06', last: '2019-12' }), seek: { month: '2018-06', seq: 0 } })));
    try {
      flushFrames();
      assert(paneTitle(f) === 'June 2018' && far.seen.inView.at(-1) === '2018-06', `the title: ${paneTitle(f)}`);
      const button = todayOf(f);
      assert(button, 'Today shows: today\'s month is not in the span');
      f.click(button);
      assert(far.seen.today === 1 && scrollerOf(f).scrollCalls.length === 0, `onToday, no scroll: ${show(far.seen)}`);
    } finally {
      f.unmount();
    }
  });

  await check('#26 the title opens onJump (and scrolls nothing); with Hebrew dates the Hebrew months follow the month in view', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const m = mount(paneIn('en', paneProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      m.click(byClass(m.container, 'ch-pane-title')[0]);
      assert(seen.jumps === 1 && scrollerOf(m).scrollCalls.length === 0 && seen.selected.length === 0, `onJump: ${show(seen)}`);
      fireScroll(scrollerOf(m), (OCT + 3) * PANE.height);
      flushFrames();
      assert(paneTitle(m) === 'January 2027' && paneHebrew(m) === 'Tevet – Sh\'vat 5787', `${paneTitle(m)} / ${paneHebrew(m)}`);
      assert(byClass(m.container, 'ch-pane-title')[0].getAttribute('aria-label') === 'January 2027, go to a date', 'the jump\'s label follows');
    } finally {
      m.unmount();
    }
  });

  await check('#27 step(1) and the chevrons scroll the pane a month (smooth), never selecting; a second step before the scroll lands goes one further; ‹ goes back; under reduced motion an instant scroll', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const handle = createRef<MonthPaneHandle>();
    const m = mount(paneIn('en', paneProps(famcalStore(), callbacks), handle));
    try {
      flushFrames();
      const el = scrollerOf(m);
      assert(handle.current, 'the handle');
      React.act(() => handle.current?.step(1));
      assert(show(el.scrollCalls) === show([{ top: (OCT + 1) * PANE.height, behavior: 'smooth' }]), `step(1): ${show(el.scrollCalls)}`);
      React.act(() => handle.current?.step(1));
      assert(show(el.scrollCalls.at(-1)) === show({ top: (OCT + 2) * PANE.height, behavior: 'smooth' }), `a second step: ${show(el.scrollCalls)}`);
      fireScroll(el, (OCT + 2) * PANE.height);
      flushFrames();
      assert(paneTitle(m) === 'December 2026', `landed: ${paneTitle(m)}`);
      const [prev, next] = chevronsOf(m);
      m.click(prev);
      assert(show(el.scrollCalls.at(-1)) === show({ top: (OCT + 1) * PANE.height, behavior: 'smooth' }), `‹: ${show(el.scrollCalls)}`);
      fireScroll(el, (OCT + 1) * PANE.height);
      flushFrames();
      m.click(next);
      assert(show(el.scrollCalls.at(-1)) === show({ top: (OCT + 2) * PANE.height, behavior: 'smooth' }), `›: ${show(el.scrollCalls)}`);
      fireScroll(el, (OCT + 2) * PANE.height);
      flushFrames();
      media.set(REDUCED, true);
      const calls = el.scrollCalls.length;
      React.act(() => handle.current?.step(-1));
      assert(el.scrollCalls.length === calls && el.scrollTop === (OCT + 1) * PANE.height, `reduced motion: instant (${el.scrollTop}, ${show(el.scrollCalls.slice(calls))})`);
      assert(seen.selected.length === 0, `no selection: ${show(seen.selected)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#28 the reach: at January 1900 ‹ is disabled and step(-1) does nothing; at December 2100 › is disabled and step(1) does nothing', () => {
    for (const [span, seek, disabled, delta] of [
      [{ first: '1900-01', last: '1902-07' }, '1900-01', 0, -1],
      [{ first: '2098-06', last: '2100-12' }, '2100-12', 1, 1],
    ] as const) {
      resetPane();
      const { seen, callbacks } = paneRecorder();
      const handle = createRef<MonthPaneHandle>();
      const months = spanMonths(span);
      const m = mount(paneIn('en', paneProps(famcalStore(), { ...callbacks, months, seek: { month: seek, seq: 0 } }), handle));
      try {
        flushFrames();
        const chevrons = chevronsOf(m);
        assert(chevrons[disabled].hasAttribute('disabled') && !chevrons[1 - disabled].hasAttribute('disabled'), `${seek}: ${show(chevrons.map((c) => c.hasAttribute('disabled')))}`);
        const el = scrollerOf(m);
        const top = el.scrollTop;
        const asked = seen.need.length;
        React.act(() => handle.current?.step(delta));
        assert(el.scrollCalls.length === 0 && el.scrollTop === top && seen.need.length === asked, `${seek}: step(${delta}) does nothing: ${show(el.scrollCalls)} ${show(seen.need)}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#29 a step past the span\'s end asks onNeedMonths first and scrolls once the months come: › at April 2028 asks "after", then scrolls to May 2028; ‹ at October 2025 asks "before", the 12 months added above keep October 2025 in view, then it scrolls to September 2025', () => {
    resetPane();
    const after = paneRecorder();
    const handle = createRef<MonthPaneHandle>();
    const base = paneProps(famcalStore(), { ...after.callbacks, seek: { month: '2028-04', seq: 0 } });
    const m = mount(paneIn('en', base, handle));
    try {
      flushFrames();
      assert(show(after.seen.need) === show(['after']), `near the end at once: ${show(after.seen.need)}`);
      const el = scrollerOf(m);
      React.act(() => handle.current?.step(1));
      assert(show(after.seen.need) === show(['after', 'after']) && el.scrollCalls.length === 0, `asked first: ${show(after.seen.need)} ${show(el.scrollCalls)}`);
      const grown = spanMonths({ first: '2025-10', last: '2029-04' });
      m.render(paneIn('en', { ...base, months: grown }, handle));
      assert(show(el.scrollCalls) === show([{ top: grown.indexOf('2028-05') * PANE.height, behavior: 'smooth' }]), `then scrolls: ${show(el.scrollCalls)}`);
    } finally {
      m.unmount();
    }
    resetPane();
    const before = paneRecorder();
    const back = paneProps(famcalStore(), { ...before.callbacks, seek: { month: '2025-10', seq: 0 } });
    const b = mount(paneIn('en', back, handle));
    try {
      flushFrames();
      assert(show(before.seen.need) === show([]), `"before" waits for an idle scroll: ${show(before.seen.need)}`);
      const el = scrollerOf(b);
      assert(el.scrollTop === 0, `October 2025 is the first: ${el.scrollTop}`);
      React.act(() => handle.current?.step(-1));
      assert(show(before.seen.need) === show(['before']) && el.scrollCalls.length === 0, `asked first: ${show(before.seen.need)}`);
      const grown = spanMonths({ first: '2024-10', last: '2028-04' });
      const sets: number[] = [];
      const own = Object.getOwnPropertyDescriptor(el, 'scrollTop');
      let value = el.scrollTop;
      Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => value, set: (v: number) => void sets.push((value = v)) });
      try {
        b.render(paneIn('en', { ...back, months: grown }, handle));
      } finally {
        Object.defineProperty(el, 'scrollTop', own ?? { configurable: true, writable: true, value });
        el.scrollTop = value;
      }
      assert(sets[0] === 12 * PANE.height, `October 2025 kept in view first (12 months above): ${show(sets)}`);
      assert(show(el.scrollCalls) === show([{ top: grown.indexOf('2025-09') * PANE.height, behavior: 'smooth' }]), `then scrolls to September 2025: ${show(el.scrollCalls)}`);
    } finally {
      b.unmount();
    }
  });

  await check('#30 seek: a new seq scrolls to its month, smooth to the next or previous month, instant (the title and the squares at once) to any other or under reduced motion; the same seq again does nothing; a month outside the span waits for the span', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const base = paneProps(famcalStore(), callbacks);
    const m = mount(paneIn('en', base));
    try {
      flushFrames();
      const el = scrollerOf(m);
      m.render(paneIn('en', { ...base, seek: { month: '2026-11', seq: 1 } }));
      assert(show(el.scrollCalls) === show([{ top: (OCT + 1) * PANE.height, behavior: 'smooth' }]), `the next month, smooth: ${show(el.scrollCalls)}`);
      fireScroll(el, (OCT + 1) * PANE.height);
      flushFrames();
      m.render(paneIn('en', { ...base, seek: { month: '2027-06', seq: 2 } }));
      assert(el.scrollCalls.length === 1 && el.scrollTop === (OCT + 8) * PANE.height, `far: instant ${el.scrollTop} ${show(el.scrollCalls)}`);
      assert(paneTitle(m) === 'June 2027' && show(drawnMonths(m)) === show(['2027-05', '2027-06', '2027-07']) && seen.inView.at(-1) === '2027-06', `at once: ${paneTitle(m)} ${show(drawnMonths(m))}`);
      media.set(REDUCED, true);
      m.render(paneIn('en', { ...base, seek: { month: '2027-05', seq: 3 } }));
      assert(el.scrollCalls.length === 1 && el.scrollTop === (OCT + 7) * PANE.height, `reduced motion: instant ${el.scrollTop}`);
      el.scrollTop = 0;
      m.render(paneIn('en', { ...base, selected: '2026-10-16', seek: { month: '2027-05', seq: 3 } }));
      assert(el.scrollTop === 0 && el.scrollCalls.length === 1, 'the same seq: nothing');
      el.scrollTop = (OCT + 7) * PANE.height;
      m.render(paneIn('en', { ...base, seek: { month: '2030-01', seq: 4 } }));
      assert(el.scrollTop === (OCT + 7) * PANE.height, 'outside the span: it waits');
      const wide = spanMonths({ first: '2025-10', last: '2031-07' });
      m.render(paneIn('en', { ...base, months: wide, seek: { month: '2030-01', seq: 4 } }));
      assert(el.scrollTop === wide.indexOf('2030-01') * PANE.height && paneTitle(m) === 'January 2030', `the span came: ${el.scrollTop} ${paneTitle(m)}`);
      assert(seen.selected.length === 0, 'a seek selects nothing');
    } finally {
      m.unmount();
    }
  });

  await check('#31 the span grows: within 6 months of its last onNeedMonths("after") at once, once per span; within 6 of its first onNeedMonths("before") only once no scroll has come for SCROLL_IDLE_MS, once per span; 12 months added above keep the month in view (scrollTop grows by 12 × h), and it is not reported again', async () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const base = paneProps(famcalStore(), callbacks);
    const m = mount(paneIn('en', base));
    const idle = () => wait(SCROLL_IDLE_MS + 40);
    try {
      flushFrames();
      await idle();
      assert(show(seen.need) === show([]), `nothing near an end at the opening: ${show(seen.need)}`);
      const el = scrollerOf(m);
      fireScroll(el, 24 * PANE.height);
      flushFrames();
      assert(show(seen.need) === show([]), `October 2027 is 6 months from April 2028: ${show(seen.need)}`);
      fireScroll(el, 25 * PANE.height);
      flushFrames();
      assert(show(seen.need) === show(['after']), `November 2027: at once: ${show(seen.need)}`);
      fireScroll(el, 28 * PANE.height);
      flushFrames();
      assert(show(seen.need) === show(['after']), `once per span: ${show(seen.need)}`);
      for (const at of [8, 6, 5]) {
        fireScroll(el, at * PANE.height);
        flushFrames();
        await wait(SCROLL_IDLE_MS / 3);
      }
      assert(show(seen.need) === show(['after']) && paneTitle(m) === 'March 2026', `while scrolling, nothing above: ${show(seen.need)}`);
      await idle();
      assert(show(seen.need) === show(['after', 'before']), `stopped: before: ${show(seen.need)}`);
      fireScroll(el, 5 * PANE.height + 40);
      flushFrames();
      await idle();
      assert(show(seen.need) === show(['after', 'before']), `once per span: ${show(seen.need)}`);
      const top = el.scrollTop;
      const reports = seen.inView.length;
      m.render(paneIn('en', { ...base, months: spanMonths({ first: '2024-10', last: '2028-04' }) }));
      assert(el.scrollTop === top + 12 * PANE.height && el.scrollCalls.length === 0, `scrollTop grew by 12 × h: ${top} → ${el.scrollTop}`);
      assert(paneTitle(m) === 'March 2026' && show(drawnMonths(m)) === show(['2026-02', '2026-03', '2026-04']), `March 2026 stays: ${paneTitle(m)} ${show(drawnMonths(m))}`);
      fireScroll(el);
      flushFrames();
      await idle();
      assert(seen.inView.length === reports && show(seen.need) === show(['after', 'before']), `no new report, the grown span is not near an end: ${show(seen.inView.slice(reports))} ${show(seen.need)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#32 a resize: each ResizeObserver callback puts the month in view back at index × the new height at once, with no React render; the squares\' size follows only SETTLE_MS (220 ms) after the last resize; with scrollerPx the squares size from it (a split mid-animation), at once when it changes', async () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    let commits = 0;
    const props = paneProps(famcalStore(), { ...callbacks, seek: { month: '2026-02', seq: 0 } });
    const m = mount(createElement(Profiler, { id: 'pane', onRender: () => void commits++ }, paneIn('en', props)));
    try {
      flushFrames();
      const el = scrollerOf(m);
      const feb = monthSpan(TODAY).indexOf('2026-02');
      assert(el.scrollTop === feb * 400 && gridClassOf(m, '2026-02') === 'ch-sq-grid is-large', `400 / 4 weeks: large (${gridClassOf(m, '2026-02')})`);
      const ro = FakeResizeObserver.all[0];
      PANE.height = 300;
      const before = commits;
      ro.trigger();
      assert(commits === before, `no render in the callback: ${commits - before}`);
      assert(el.scrollTop === feb * 300, `realigned at once: ${el.scrollTop}`);
      assert(gridClassOf(m, '2026-02') === 'ch-sq-grid is-large', 'the squares wait');
      await wait(100);
      ro.trigger();
      await wait(150);
      assert(gridClassOf(m, '2026-02') === 'ch-sq-grid is-large', 'another resize restarts the wait');
      await wait(SETTLE_MS - 150 + 40);
      assert(gridClassOf(m, '2026-02') === 'ch-sq-grid is-medium', `settled: 300 / 4 weeks is medium (${gridClassOf(m, '2026-02')})`);
      fireScroll(el);
      flushFrames();
      assert(paneTitle(m) === 'February 2026' && show(seen.inView) === show(['2026-02']), `February stays in view: ${show(seen.inView)}`);
    } finally {
      m.unmount();
    }
    resetPane();
    PANE.height = 300;
    const split = paneProps(famcalStore(), { scrollerPx: 600 });
    const s = mount(paneIn('en', split));
    try {
      const el = scrollerOf(s);
      assert(el.style.blockSize === '600px' && el.style.flex === 'none', `the scroller: ${show([el.style.blockSize, el.style.flex])}`);
      assert(gridClassOf(s, '2026-10') === 'ch-sq-grid is-large', `600 / 5 weeks (not the 300 measured): ${gridClassOf(s, '2026-10')}`);
      assert(el.scrollTop === OCT * 300, `the scroll uses the real height: ${el.scrollTop}`);
      s.render(paneIn('en', { ...split, scrollerPx: 260 }));
      assert(gridClassOf(s, '2026-10') === 'ch-sq-grid is-small' && el.style.blockSize === '260px', `260 / 5 weeks, at once: ${gridClassOf(s, '2026-10')}`);
    } finally {
      s.unmount();
    }
  });

  await check('#33 a tap on a square calls onSelectDay with its day (the neighbours\' too); Retry on a failed pill calls onRetryMonth(month, source), on a month drawn after a scroll too; Choose again calls onChooseCalendars; partial\'s Retry names its source', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const m = mount(paneIn('en', paneProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      m.click(squareButton(m, '2026-10', 'Tuesday, 20 October'));
      m.click(squareButton(m, '2026-11', 'Sunday, 1 November'));
      assert(show(seen.selected) === show(['2026-10-20', '2026-11-01']), `selected: ${show(seen.selected)}`);
      const retry = (mo: MonthKey) => elements(monthEl(m, mo)).find((e) => hasClass(e, 'ch-sq-pill-action'));
      m.click(retry('2026-11') as FakeElement);
      assert(retry('2026-12') === undefined, 'December is not drawn yet');
      fireScroll(scrollerOf(m), (OCT + 1) * PANE.height);
      flushFrames();
      m.click(retry('2026-12') as FakeElement);
      assert(show(seen.retried) === show(['2026-11:famcal', '2026-12:famcal']), `retried: ${show(seen.retried)}`);
    } finally {
      m.unmount();
    }
    resetPane();
    const google = paneRecorder();
    const g = mount(paneIn('en', paneProps(googleStore(), { ...google.callbacks, seek: { month: '2026-11', seq: 0 } })));
    try {
      const action = (mo: MonthKey) => elements(monthEl(g, mo)).find((e) => hasClass(e, 'ch-sq-pill-action')) as FakeElement;
      g.click(action('2026-11'));
      g.click(action('2026-10'));
      assert(google.seen.chosen === 1 && show(google.seen.retried) === show(['2026-10:google']), `google: ${show(google.seen)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#34 a month whose holidays failed is asked again when the month in view changes (the second report on), not on the first', async () => {
    resetPane();
    const calls: string[] = [];
    const savedFetch = (globalThis as Row).fetch;
    (globalThis as Row).fetch = async (url: string) => {
      calls.push(String(url));
      return String(url).includes('from=2030-04-01') ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ days: {} }) };
    };
    const april = () => calls.filter((u) => u.includes('from=2030-04-01')).length;
    const m = mount(paneIn('he', paneProps(famcalStore(), { months: spanMonths({ first: '2029-05', last: '2031-11' }), seek: { month: '2030-05', seq: 0 } })));
    try {
      await wait(0);
      assert(april() === 1, `April 2030 asked once: ${april()}`);
      flushFrames();
      await wait(0);
      assert(april() === 1, `the first report asks nothing again: ${april()}`);
      fireScroll(scrollerOf(m), 13 * PANE.height);
      flushFrames();
      await wait(0);
      assert(april() === 2, `the next month in view asks April again: ${april()}`);
    } finally {
      m.unmount();
      (globalThis as Row).fetch = savedFetch;
      // The failures' own lines (holidays-client logs each one) aren't React's.
      for (let i = reactWarnings.length - 1; i >= 0; i--) if (reactWarnings[i].startsWith('[holidays] 2030-04')) reactWarnings.splice(i, 1);
    }
  });

  await check('#35 unmount lets go of everything: the scroll listener, the ResizeObserver, the idle and settle timers and a pending frame; nothing is asked after it', async () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const pending = new Set<unknown>();
    const g = globalThis as Row;
    const realSet = g.setTimeout;
    const realClear = g.clearTimeout;
    g.setTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = realSet(() => {
        pending.delete(id);
        fn(...args);
      }, ms);
      if (ms === SCROLL_IDLE_MS || ms === SETTLE_MS) pending.add(id);
      return id;
    };
    g.clearTimeout = (id: unknown) => {
      pending.delete(id);
      realClear(id);
    };
    try {
      const m = mount(paneIn('en', paneProps(famcalStore(), { ...callbacks, seek: { month: '2026-01', seq: 0 } })));
      flushFrames();
      const el = scrollerOf(m);
      fireScroll(el, el.scrollTop);
      PANE.height = 350;
      FakeResizeObserver.all[0].trigger();
      fireScroll(el, el.scrollTop);
      // Read through a call: an assert on .size would narrow it for the one after unmount.
      const left = () => ({ frames: frames.size, timers: pending.size });
      assert(show(left()) === show({ frames: 1, timers: 2 }), `a frame, the idle and the settle timers pending: ${show(left())}`);
      m.unmount();
      assert(el.listeners.filter((l) => l.type === 'scroll').length === 0, 'the scroll listener is gone');
      assert(FakeResizeObserver.all[0].disconnected, 'the observer is disconnected');
      assert(show(left()) === show({ frames: 0, timers: 0 }), `left after unmount: ${show(left())}`);
    } finally {
      g.setTimeout = realSet;
      g.clearTimeout = realClear;
    }
    await wait(SETTLE_MS + 40);
    assert(seen.need.length === 0, `nothing asked after unmount: ${show(seen.need)}`);
  });

  FakeElement.layout = null;


  // ---- The day panel and the handle (Task 5) ----

  const panelProps = (store: CalendarStore, day: DayKey, o: Partial<ComponentProps<typeof DayPanel>> = {}): ComponentProps<typeof DayPanel> => ({
    day,
    today: TODAY,
    tz: TZ,
    hebrewDates: true,
    dafYomi: false,
    rows: dayRows(store, day),
    status: dayStatus(store, day),
    onOpenItem: noop,
    ...o,
  });
  const renderPanel = (locale: Locale, props: ComponentProps<typeof DayPanel>) => markup(renderToString(inHome(locale, createElement(DayPanel, props))));
  const heading = (html: string) => {
    const m = /<h3 class="ch-dp-day" id="ch-dp-day">([\s\S]*?)<\/h3>/.exec(html);
    assert(m, `no h3#ch-dp-day: ${html.slice(0, 300)}`);
    return m[1];
  };
  const plain = (html: string) => decode(html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ''));

  await check('#36 the day panel: h3#ch-dp-day with "Today · …" on today (the weekday and date otherwise) and the Hebrew date; the holiday line (chag in the accent); the rows in order, one li each; dir; top first in the scroller', () => {
    const store = famcalStore();
    const today = renderPanel('en', panelProps(store, TODAY));
    assert(plain(heading(today)).startsWith('Today · Thursday, 15 October'), `today: ${plain(heading(today))}`);
    assert(heading(today).includes('class="ch-dp-day-hebrew"'), 'the Hebrew date');
    assert(/<section class="ch-dp" dir="ltr" aria-labelledby="ch-dp-day"/.test(today), `root: ${today.slice(0, 200)}`);
    const rows = dayRows(store, TODAY);
    assert(rows.length > 1, 'fixture has rows');
    assert((today.match(/<li /g) ?? []).length === rows.length, `one li per row: ${(today.match(/<li /g) ?? []).length} of ${rows.length}`);
    const titles = rows.map((r) => r.item.title).filter(Boolean) as string[];
    let at = -1;
    for (const title of titles) {
      const i = today.indexOf(title.replace(/'/g, '&#x27;'), at + 1);
      assert(i > at, `rows in order: ${title}`);
      at = i;
    }
    const other = renderPanel('en', panelProps(store, '2026-10-17'));
    assert(plain(heading(other)).startsWith('Saturday, 17 October'), `other day: ${plain(heading(other))}`);
    assert(heading(other).includes('class="ch-day-holiday"') && heading(other).includes('Noach'), `the holiday line: ${heading(other)}`);
    const chag = renderPanel('en', panelProps(store, '2026-10-03'));
    assert(heading(chag).includes('ch-day-holiday is-chag'), 'chag in the accent');
    const off = renderPanel('en', panelProps(store, '2026-10-17', { hebrewDates: false }));
    assert(!heading(off).includes('ch-dp-day-hebrew') && !heading(off).includes('ch-day-holiday'), 'no Hebrew date or holiday with Hebrew dates off');
    const he = renderPanel('he', panelProps(store, TODAY));
    assert(he.includes('dir="rtl"'), 'he rtl');
    const withTop = renderPanel('en', panelProps(store, TODAY, { top: createElement('div', { className: 'probe-top' }, 'banner') }));
    const scroller = withTop.indexOf('class="ch-dp-scroller');
    assert(scroller >= 0 && withTop.indexOf('probe-top') > scroller && withTop.indexOf('probe-top') < withTop.indexOf('id="ch-dp-day"'), 'top first inside the scroller');
  });

  await check('#37 Daf Yomi line right after the day header and before the rows (en, he, ru); none without the prop (ported from picked #16)', () => {
    const want: Record<string, string> = { en: 'Daf Yomi · Bechorot 28', he: 'דף יומי · בכורות כ״ח', ru: 'Даф йоми · Бехорот 28' };
    const store = famcalStore();
    for (const locale of ['en', 'he', 'ru'] as const) {
      const html = renderPanel(locale, panelProps(store, '2026-10-16', { dafYomi: true }));
      const after = html.slice(html.indexOf('id="ch-dp-day"'));
      const rest = after.slice(after.indexOf('</h3>') + 5);
      assert(rest.startsWith('<p class="ch-daf">'), `${locale}: right after the header: ${rest.slice(0, 80)}`);
      assert(plain(rest.slice(0, rest.indexOf('</p>') + 4)) === want[locale], `${locale}: ${plain(rest.slice(0, rest.indexOf('</p>') + 4))}`);
      assert(rest.indexOf('class="ch-daf"') < rest.indexOf('<ul'), `${locale}: before the rows`);
      assert(!renderPanel(locale, panelProps(store, '2026-10-16')).includes('ch-daf"'), `${locale}: none without the prop`);
    }
  });

  await check('#38 nothing planned only when answered and empty; placeholders while loading (aria-busy); neither when failed; the AGENDA_CSS once', () => {
    const store = famcalStore();
    const empty = renderToString(inHome('en', createElement(DayPanel, panelProps(store, '2026-10-02', { rows: [], status: 'answered' }))));
    assert(markup(empty).includes('<p class="ch-dp-nothing">Nothing planned</p>'), 'nothing planned');
    assert(!markup(empty).includes('ch-ghosts'), 'no ghosts');
    assert(empty.split(AGENDA_CSS.slice(0, 200)).length === 2, 'AGENDA_CSS once');
    const loading = renderPanel('en', panelProps(store, '2026-10-02', { rows: [], status: 'loading' }));
    assert(loading.includes('class="ch-ghosts"') && !loading.includes('ch-dp-nothing') && loading.includes('aria-busy="true"'), 'ghosts while loading');
    assert((loading.match(/class="ch-ghost"/g) ?? []).length === 2, 'two ghosts with no rows');
    const more = renderPanel('en', panelProps(store, TODAY, { status: 'loading' }));
    assert((more.match(/class="ch-ghost"/g) ?? []).length === 1, 'one ghost under rows');
    const failed = renderPanel('en', panelProps(store, '2026-10-02', { rows: [], status: 'failed' }));
    assert(!failed.includes('ch-dp-nothing') && !failed.includes('ch-ghosts'), 'failed: nothing');
  });

  await check('#39 peek: the scroller cannot scroll and one full-size button (aria-label "Show the month smaller") calls onPeek; without peek there is none', () => {
    const store = famcalStore();
    const off = renderPanel('en', panelProps(store, TODAY));
    assert(!off.includes('ch-dp-peek') && !off.includes('is-peek'), 'no peek by default');
    const html = renderPanel('en', panelProps(store, TODAY, { peek: true, onPeek: noop }));
    assert(html.includes('ch-dp-scroller is-peek'), 'is-peek scroller');
    assert(/<button type="button" class="ch-dp-peek" aria-label="Show the month smaller">/.test(html), `the button: ${/<button[^>]*ch-dp-peek[^>]*>/.exec(html)?.[0]}`);
    const calls: number[] = [];
    const m = mount(inIntl('en', createElement(DayPanel, panelProps(store, TODAY, { peek: true, onPeek: () => void calls.push(1) }))));
    try {
      const btn = elements(m.container).find((e) => e.className === 'ch-dp-peek');
      assert(btn, 'the peek button mounted');
      m.click(btn);
      assert(calls.length === 1, `onPeek once: ${calls.length}`);
    } finally {
      m.unmount();
    }
    const css = DAY_PANEL_CSS;
    assert(/\.ch-dp-scroller\.is-peek \{[^}]*overflow: hidden/.test(css), 'peek scroller overflow hidden');
    assert(/\.ch-dp-peek \{[^}]*position: absolute;[^}]*inset: 0/.test(css), 'the button covers the panel');
    assert(lintCss(css + '\n' + SPLIT_HANDLE_CSS).length === 0, `lint: ${show(lintCss(css + '\n' + SPLIT_HANDLE_CSS))}`);
  });

  const handleIn = (grown: boolean, onToggle: (next: 'split' | 'grown') => void) => inIntl('en', createElement(SplitHandle, { grown, onToggle }));

  await check('#40 the handle: a real button, aria-expanded and its label both ways (en, he, ru), touch-action none on it only, never a drag source', () => {
    for (const [locale, bigger, smaller] of [['en', 'Show the month bigger', 'Show the month smaller'], ['he', 'הגדלת החודש', 'הקטנת החודש'], ['ru', 'Увеличить месяц', 'Уменьшить месяц']] as const) {
      const a = markup(renderToString(inHome(locale, createElement(SplitHandle, { grown: false, onToggle: noop }))));
      assert(a.includes('<button type="button" class="ch-handle" aria-expanded="false"') && a.includes(`aria-label="${bigger}"`), `${locale} collapsed: ${a.slice(0, 250)}`);
      const b = markup(renderToString(inHome(locale, createElement(SplitHandle, { grown: true, onToggle: noop }))));
      assert(b.includes('aria-expanded="true"') && b.includes(`aria-label="${smaller}"`), `${locale} grown`);
    }
    assert(/\.ch-handle \{[^}]*touch-action: none/.test(SPLIT_HANDLE_CSS), 'touch-action none');
    assert((SPLIT_HANDLE_CSS.match(/touch-action/g) ?? []).length === 1, 'touch-action only on the handle');
    const src = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/dashboard/SplitHandle.tsx'), 'utf8');
    assert(!/useItemDrag|DragSurface/.test(src), 'no drag source');
  });

  await check('#41 the handle\'s geometry: the bar is 22 px (HANDLE_PX), its tap area 22 + 2 × 11 = 44 px by padding and negative margins, a 36 × 5 pill, logical properties, lint clean', () => {
    assert(HANDLE_PX === 22 && HANDLE_TOUCH_PX === 11 && HANDLE_TAP_PX === 12, 'constants');
    const rule = /\.ch-handle \{([^}]*)\}/.exec(SPLIT_HANDLE_CSS)?.[1] ?? '';
    assert(/block-size: 22px/.test(rule) && /box-sizing: content-box/.test(rule), `22 px content box: ${rule}`);
    assert(/padding-block: 11px/.test(rule) && /margin-block: -11px/.test(rule), `11 px extension: ${rule}`);
    const pill = /\.ch-handle-pill \{([^}]*)\}/.exec(SPLIT_HANDLE_CSS)?.[1] ?? '';
    assert(/inline-size: 36px/.test(pill) && /block-size: 5px/.test(pill), `pill: ${pill}`);
    const problems = lintCss(SPLIT_HANDLE_CSS);
    assert(problems.length === 0, show(problems));
  });

  await check('#42 the handle\'s pointer: a 5 px move toggles; 30 px down grows; 30 px up shrinks; a pointer tap fires onToggle once (the click after it is swallowed); a keyboard click toggles; a cancelled gesture does nothing', () => {
    const seen: string[] = [];
    const down = (m: Mounted, btn: FakeNode, y: number) => m.fire(btn, 'pointerdown', { pointerId: 1, clientY: y, button: 0, isPrimary: true });
    const up = (m: Mounted, btn: FakeNode, y: number) => m.fire(btn, 'pointerup', { pointerId: 1, clientY: y, button: 0, isPrimary: true });
    const run = (grown: boolean, fn: (m: Mounted, btn: FakeElement) => void) => {
      seen.length = 0;
      const m = mount(handleIn(grown, (next) => void seen.push(next)));
      try {
        const btn = elements(m.container).find((e) => e.className === 'ch-handle');
        assert(btn, 'handle mounted');
        fn(m, btn);
      } finally {
        m.unmount();
      }
    };
    run(false, (m, btn) => {
      down(m, btn, 100);
      up(m, btn, 105);
      m.click(btn);
      assert(show(seen) === '["grown"]', `a 5 px tap collapsed->grown once: ${show(seen)}`);
    });
    run(true, (m, btn) => {
      down(m, btn, 100);
      up(m, btn, 95);
      m.click(btn);
      assert(show(seen) === '["split"]', `a tap when grown shrinks: ${show(seen)}`);
    });
    run(false, (m, btn) => {
      down(m, btn, 100);
      up(m, btn, 130);
      m.click(btn);
      assert(show(seen) === '["grown"]', `30 px down grows: ${show(seen)}`);
    });
    run(true, (m, btn) => {
      down(m, btn, 100);
      up(m, btn, 70);
      m.click(btn);
      assert(show(seen) === '["split"]', `30 px up shrinks: ${show(seen)}`);
    });
    run(false, (m, btn) => {
      m.click(btn);
      assert(show(seen) === '["grown"]', `keyboard click: ${show(seen)}`);
      m.click(btn);
      assert(seen.length === 2, 'a second keyboard click toggles again');
    });
    run(false, (m, btn) => {
      down(m, btn, 100);
      up(m, btn, 101);
      m.click(btn);
      m.click(btn);
      assert(seen.length === 2, `after a gesture's click is swallowed the next click counts: ${show(seen)}`);
    });
    run(false, (m, btn) => {
      down(m, btn, 100);
      m.fire(btn, 'pointercancel', { pointerId: 1 });
      m.click(btn);
      assert(seen.length === 1, `a cancelled gesture leaves the click to the keyboard path: ${show(seen)}`);
    });
  });

  await check('#43 the title is a polite live region (a chevron or a step is announced), and the chevrons are drawn flipped in RTL (.ch-flip); ported from the tapped-day screen\'s #2–#3', () => {
    const html = markup(renderPane('en', paneProps(famcalStore())));
    assert(/<span class="ch-pane-title-text" aria-live="polite">/.test(html), `the live title: ${show(/<span class="ch-pane-title-text"[^>]*>/.exec(html)?.[0])}`);
    const chevrons = [...html.matchAll(/<button[^>]*class="ch-pane-chev[^"]*"[^>]*><svg class="([^"]*)"/g)].map((m) => m[1]);
    assert(show(chevrons) === show(['ch-flip', 'ch-flip']), `both chevrons flip in RTL: ${show(chevrons)}`);
  });

  await check('#44 a month whose model was drawn under another week start (a store drop with a new week start, the model not yet rebuilt) draws as loading, never free; ported from All months\' #11 and the tapped-day screen\'s model guard', () => {
    const store = famcalStore();
    const html = markup(renderPane('en', paneProps(store, { weekStart: 1 })));
    const october = /<div class="ch-pane-month" data-month="2026-10">([\s\S]*?)<\/div><div class="ch-pane-month" data-month="2026-11">/.exec(html)?.[1] ?? '';
    assert(october.length > 0, 'October is drawn');
    const labels = [...october.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    assert(labels.length === 31 && labels.every((l) => l.endsWith('loading')), `every day reads loading: ${show(labels.slice(0, 3))}`);
    assert(!/nothing planned|class="ch-sq-dot /.test(october), 'nothing free, no dots');
    const same = markup(renderPane('en', paneProps(store)));
    assert(/aria-label="Thursday, 15 October[^"]*items/.test(same), 'under its own week start the model draws');
  });

  // ---- The final review's fixes (.superpowers/sdd/2026-11-26-responsive-home-layouts/final-review.md) ----

  installPane();

  await check('#46 C1: while an item is lifted, auto-scroll moves the day list and the page at their edges but never the month pane (its months snap, so each 5 ms scrollBy would turn a whole month under a finger at rest; a chevron dwell turns it, Ruling 5): autoScrollable refuses .ch-pane-scroller only, and DragLayer hands dnd-kit { canScroll: autoScrollable } while lifted, false otherwise', () => {
    const box = (cls: string) => ({ classList: { contains: (c: string) => cls.split(' ').includes(c) } }) as unknown as Element;
    assert(typeof autoScrollable === 'function', 'DragSurface exports autoScrollable');
    assert(autoScrollable(box('ch-pane-scroller')) === false, 'the month pane never auto-scrolls');
    assert(autoScrollable(box('ch-dp-scroller')) === true && autoScrollable(box('')) === true, 'the day list and the page (document.scrollingElement) do');
    assert(DRAG_AUTO_SCROLL?.canScroll === autoScrollable, `the options dnd-kit gets: ${show(DRAG_AUTO_SCROLL)}`);
    const source = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/dashboard/DragSurface.tsx'), 'utf8');
    const uses = source.match(/autoScroll=\{[^}]*\}/g) ?? [];
    assert(show(uses) === show(['autoScroll={lifted !== null ? DRAG_AUTO_SCROLL : false}']), `DndContext's autoScroll: ${show(uses)}`);
  });

  await check('#47 I1: a height change that a scroll event sees before the ResizeObserver runs (the split animating, a window resized) keeps the month in view: October at 400 px, the scroller made 380 px and a scroll event first (scrollTop still 12 × 400, which reads November) → October stays, nothing new reported, scrollTop 12 × 380; the observer and a later scroll keep it; 420 px the same; a real scroll at the settled height still reads its month', () => {
    resetPane();
    const { seen, callbacks } = paneRecorder();
    const m = mount(paneIn('en', paneProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      const el = scrollerOf(m);
      assert(el.scrollTop === OCT * 400 && show(seen.inView) === show(['2026-10']), `the opening: ${el.scrollTop} ${show(seen.inView)}`);
      const near = seen.near.length;
      PANE.height = 380;
      fireScroll(el);
      flushFrames();
      assert(paneTitle(m) === 'October 2026' && show(seen.inView) === show(['2026-10']) && seen.near.length === near, `October stays: ${paneTitle(m)} ${show(seen.inView)} ${show(seen.near.slice(near))}`);
      assert(el.scrollTop === OCT * 380, `put back at 12 × 380 at once: ${el.scrollTop}`);
      FakeResizeObserver.all[0].trigger();
      fireScroll(el);
      flushFrames();
      assert(el.scrollTop === OCT * 380 && show(seen.inView) === show(['2026-10']), `the observer and a later scroll keep it: ${el.scrollTop} ${show(seen.inView)}`);
      PANE.height = 420;
      fireScroll(el);
      flushFrames();
      assert(el.scrollTop === OCT * 420 && show(seen.inView) === show(['2026-10']), `420 px: ${el.scrollTop} ${show(seen.inView)}`);
      fireScroll(el, (OCT + 1) * 420);
      flushFrames();
      assert(show(seen.inView) === show(['2026-10', '2026-11']) && paneTitle(m) === 'November 2026', `a real scroll reads its month: ${show(seen.inView)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#48 M4: scroll positions use the scroller\'s exact height, not clientHeight (a whole number): a 424.6 px scroller (clientHeight 425) opens October at 12 × 424.6, not 12 × 425 (4.8 px into the next month); a step goes to 13 × 424.6; a resize to 380.5 px puts November at 13 × 380.5, and a scroll event after it reads November without re-aligning', () => {
    resetPane();
    PANE.height = 425;
    PANE.exact = 424.6;
    const { seen, callbacks } = paneRecorder();
    const ref = createRef<MonthPaneHandle>();
    const m = mount(paneIn('en', paneProps(famcalStore(), callbacks), ref));
    const at = (top: number, index: number, h: number) => Math.abs(top - index * h) < 1e-6;
    try {
      flushFrames();
      const el = scrollerOf(m);
      assert(at(el.scrollTop, OCT, 424.6), `the opening at 12 × 424.6 (${OCT * 424.6}): ${el.scrollTop}`);
      assert(show(seen.inView) === show(['2026-10']), `October: ${show(seen.inView)}`);
      media.set(REDUCED, true);
      React.act(() => ref.current?.step(1));
      assert(at(el.scrollTop, OCT + 1, 424.6) && paneTitle(m) === 'November 2026', `a step to 13 × 424.6: ${el.scrollTop} ${paneTitle(m)}`);
      PANE.height = 381;
      PANE.exact = 380.5;
      FakeResizeObserver.all[0].trigger();
      assert(at(el.scrollTop, OCT + 1, 380.5), `the resize to 13 × 380.5: ${el.scrollTop}`);
      const set = el.scrollTop;
      fireScroll(el);
      flushFrames();
      assert(el.scrollTop === set && paneTitle(m) === 'November 2026' && show(seen.inView) === show(['2026-10', '2026-11']), `November read as it is: ${el.scrollTop} ${show(seen.inView)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#99 React logged no warning', () => {
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
/** The pane's weekday row under its bar: monthBarPx is the bar's row and this. */
const WEEKDAYS_PX = 24;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
