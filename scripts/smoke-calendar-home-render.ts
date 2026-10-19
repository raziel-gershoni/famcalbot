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
//
// CalendarHome (Task D6, #21-#39), the container around the Agenda, in real React with
// a fake fetch (spec §5, §7.1, §7.2, §7.6; Rulings R5, R6, R19): one range request per
// applicable source, with no dates and the init data in the header only; the header
// (the server's today, its Hebrew date, "Times in <zone>" only when the device is
// elsewhere); RTL; "Show next week", the foreground refetch, ⋯ → Refresh with fresh=1,
// the stale re-request and the Google error retry; midnight, also when the app comes
// back after a night with its timers suspended, and with a device clock that runs ahead;
// a range request that never settles timing out;
// 401/403/404 on PageGate's card; the busy and retry cards; the send sheet's answers
// (R5); the menu (R6); the banners (§7.2), with no Agenda under a Google setup banner;
// Telegram's BackButton for the item, send and menu sheets; the shell's CSS; the error
// boundary.
//
// PageGate's boundary around the home's chunk (Task D7, #40), in real React: an import
// that rejects with a ChunkLoadError, as after a deploy, reloads once behind the loader;
// within the guard, or for any other error, the gate's error card.
//
// The midnight reset with a refetch in flight (Plan E, Task E3, #42): when that refetch
// fails after the reset, no retry card flashes before the new day's answer.
//
// The tabs and the Month through the container (Plan E, Task E8, #43-#60), in real React
// on a laid-out fake page (a fake scroll, frames, matchMedia, IntersectionObserver and
// localStorage): the Month's views in a chunk of their own; the tab bar under the header
// and above the banners, its tab kept for the session, and the header and tab bar
// sticking above browse; the Month opening on today's month with a peek; its windows, a month's own
// days, at most 2 in flight and each asked once; Telegram's swipes off in browse on a 7.7
// client and never touched on a 7.0 one; picked and its BackButton, with the item sheet
// over it closing first; the layout kept on the device, a restored picked opening on
// today; the foreground and Refresh asking the Month's windows; a failed month's Retry;
// midnight on the Month; no tab bar while a Google user sets up; no clipping ancestor above the Month; the unavailable-calendars row
// once above the Month; a tab switch from picked and back; Telegram's activated on the
// Month; the item sheet keeping focus over picked.
//
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under three clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-home-render.ts

// The views first: the import-rule checks walk what these load.
import CalendarHome, { CalendarHomeContainer, GONE_NOTE_MS, HOME_TOP_CSS, type HomeDeps } from '../app/[locale]/dashboard/CalendarHome';
import { AgendaView, AGENDA_CSS, type AgendaViewProps } from '../app/[locale]/dashboard/AgendaView';
import { ItemSheet, type SheetActions } from '../app/[locale]/dashboard/ItemSheet';
import { SendSheet } from '../app/[locale]/dashboard/SendSheet';
import { BottomSheet } from '../app/[locale]/dashboard/BottomSheet';

/** BottomSheet with its children passed as createElement arguments (the lint rule forbids the prop). */
const SheetProbe = BottomSheet as unknown as (props: Omit<ComponentProps<typeof BottomSheet>, 'children'>) => ReactElement;
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
import { compareItems, type CalendarDTO, type DayKey, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse, type WeekStart } from '../src/lib/calendar-view/types';
import type { CalendarHomeProps, HomeHints } from '../src/lib/calendar-view/home-props';
import { formatDayRange, formatDayShort } from '../src/lib/calendar-view/format';
import { CHUNK_RELOAD_KEY, HomeErrorBoundary } from '../app/[locale]/dashboard/HomeErrorBoundary';
import { HomeChunkBoundary } from '../app/[locale]/PageGate';
import { homeBanners, type BannerFacts } from '../app/[locale]/dashboard/HomeBanners';
import { HOME_SHELL_CSS } from '../app/[locale]/dashboard/home-shell';
import { menuEntries } from '../app/[locale]/dashboard/MenuSheet';
import { isChunkLoadError, isPastDay, msUntilAheadCheck, msUntilDayCheck, zoneDiffers } from '../src/lib/calendar-view/home-client';
import { ERROR_RETRY_MS, MONTH_INFLIGHT_MAX, RANGE_TIMEOUT_MS, STALE_RETRY_MS } from '../src/lib/calendar-view/home-loader';
import { PANEL_IDS, TAB_IDS } from '../app/[locale]/dashboard/HomeTabs';
import { MONTH_BROWSE_CSS } from '../app/[locale]/dashboard/MonthBrowse';
import { homeTabKey, monthLayoutKey } from '../src/lib/calendar-view/home-storage';
import { monthSpan, monthWindow, type MonthKey } from '../src/lib/calendar-view/grid';
import { BROWSE_CELL_PX, monthBarPx, monthOffsets } from '../src/lib/calendar-view/month';
import { formatDayLong } from '../src/lib/calendar-view/format';
import { calendarVars } from '../src/lib/calendar-view/colours';
import { postReminderAction } from '../src/lib/calendar-view/reminder-client';

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
/** The app's own log lines (sendToChat's, the error boundary's): some checks expect them; they are never React's. */
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    if (text.startsWith('[command-client]') || text.startsWith('[calendar-home]')) {
      appLogs.push(text.slice(0, 300));
      return;
    }
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
  // React sets an input's type as a property; a browser reflects it as the attribute
  get type(): string {
    return this.getAttribute('type') ?? '';
  }
  set type(value: string) {
    this.setAttribute('type', value);
  }
  /** The selector forms BottomSheet's TABBABLE uses: a comma list of tag, [attr], [attr^="v"], :not([attr]) and :not([attr="v"]). */
  querySelectorAll(selector: string): FakeElement[] {
    const attr = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/;
    const test = (el: FakeElement, sel: string, wanted: boolean): boolean => {
      const m = attr.exec(sel);
      if (!m) throw new Error(`fake querySelectorAll: ${sel}`);
      const have = el.getAttribute(m[1]);
      const hit = have !== null && (m[2] === undefined || (m[2] === '=' ? have === m[3] : have.startsWith(m[3])));
      return hit === wanted;
    };
    const matchers = selector.split(',').map((part) => {
      let rest = part.trim();
      const tag = /^[a-z]+/.exec(rest)?.[0];
      rest = rest.slice(tag?.length ?? 0);
      const rules: ((el: FakeElement) => boolean)[] = [];
      if (tag) rules.push((el) => el.localName === tag);
      while (rest) {
        const not = /^:not\((\[[^\]]*\])\)/.exec(rest);
        const pos = attr.exec(rest);
        const piece = not ? not[1] : pos ? pos[0] : '';
        if (!piece) throw new Error(`fake querySelectorAll: ${rest}`);
        rules.push((el) => test(el, piece, !not));
        rest = rest.slice(not ? not[0].length : piece.length);
      }
      return (el: FakeElement) => rules.every((r) => r(el));
    });
    const out: FakeElement[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (matchers.some((m) => m(child))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
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

// The Month's page (Task E8): MonthBrowse measures it. The list of months starts
// LAYOUT.listTop px down the document (under the header, the tab bar and the sticky
// bar); the bar sticks at the top once the page scrolls past it (no safe area here);
// each month's title sits at its block's top, from the block sizes the view rendered.
// The header and tab bar's wrapper is LAYOUT.topH tall (0 unless a check says so).
// Everything else sits at the document's top, 0 px tall.
const LAYOUT = { listTop: 400, width: 390, topH: 0 };
const px = (value: unknown) => Number.parseFloat(String(value ?? '')) || 0;
function closestClass(el: FakeNode | null, cls: string): FakeElement | null {
  for (let n = el; n; n = n.parentNode) if (n instanceof FakeElement && n.className.split(' ').includes(cls)) return n;
  return null;
}
function rectAt(top: number, height: number) {
  return { top, bottom: top + height, left: 0, right: LAYOUT.width, width: LAYOUT.width, height, x: 0, y: top };
}
/** A month block's top in the list: the blocks rendered above it. */
function blockTop(section: FakeNode): number {
  let y = 0;
  for (const sibling of section.parentNode?.childNodes ?? []) {
    if (sibling === section) break;
    y += px((sibling as FakeElement).style?.blockSize);
  }
  return y;
}
function layoutRect(el: FakeElement) {
  const scrollY = Number(fakeWindow.scrollY) || 0;
  const classes = el.className.split(' ');
  if (classes.includes('ch-mb-months')) {
    return rectAt(LAYOUT.listTop - scrollY, el.childNodes.reduce((sum, s) => sum + px((s as FakeElement).style?.blockSize), 0));
  }
  if (classes.includes('ch-mb-bar')) {
    const bar = px(closestClass(el, 'ch-mb')?.style['--ch-mb-bar']);
    return rectAt(Math.max(0, LAYOUT.listTop - bar - scrollY), bar);
  }
  if (classes.includes('ch-mb-title') && el.parentNode) {
    return rectAt(LAYOUT.listTop + blockTop(el.parentNode) - scrollY, px(closestClass(el, 'ch-mb')?.style['--ch-mb-title']));
  }
  if (classes.includes('ch-home-top')) return rectAt(classes.includes('is-sticky') ? 0 : -scrollY, LAYOUT.topH);
  return rectAt(-scrollY, 0);
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

/** window.addEventListener's listeners (MonthBrowse's scroll and resize), with their options. */
const windowListeners: { type: string; fn: () => void; options: unknown }[] = [];
/** Every window.scrollTo: the top and the behaviour ('plain' for the two-number form). */
const scrollCalls: { top: number; behavior: string }[] = [];
/** The animation frames requested and not run yet. */
const frames = new Map<number, () => void>();
let nextFrameId = 1;
/** The media queries' answers (none match unless a check says so), and their listeners. */
const media = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<() => void>>();

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

/** A Storage over a Map (sessionStorage, localStorage). */
function fakeStorage(): Row {
  const saved = new Map<string, string>();
  return {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, String(v)),
    removeItem: (k: string) => void saved.delete(k),
  };
}

const openedWindows: string[] = [];
const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: (type: string, fn: () => void, options?: unknown) => void windowListeners.push({ type, fn, options }),
  removeEventListener: (type: string, fn: () => void) => {
    const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) windowListeners.splice(i, 1);
  },
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
  localStorage: fakeStorage(),
  scrollY: 0,
  innerHeight: 800,
  scrollTo: (a: Row | number, b?: number) => {
    const call = typeof a === 'number' ? { top: b ?? 0, behavior: 'plain' } : { top: Number(a.top), behavior: String(a.behavior ?? 'auto') };
    scrollCalls.push(call);
    fakeWindow.scrollY = Math.max(0, call.top);
  },
  matchMedia: (query: string) => fakeMediaList(query),
  requestAnimationFrame: (fn: () => void) => {
    const id = nextFrameId++;
    frames.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id: number) => void frames.delete(id),
  IntersectionObserver: FakeIO,
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
  key: (el: FakeNode, key: string, extra?: Row) => void;
  unmount: () => void;
};

function mount(el: ReactElement, rootOptions?: Row): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container, rootOptions);
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
    key: (target, key, extra = {}) => dispatch(target, 'keydown', { key, ...extra }),
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

// ---- CalendarHome (D6): a fake fetch, a fake clock, a fake Telegram, the fake DOM as HTML ----

/** One request the home made: the range route or execute-command. */
type FetchCall = {
  url: string;
  path: string;
  query: URLSearchParams;
  method: string;
  headers: Record<string, string>;
  body: Row | null;
  credentials?: string;
  cache?: string;
  /** The request's AbortSignal (fetchRange's time limit). */
  signal?: { aborted: boolean };
};
type FetchAnswer = { status: number; body?: unknown } | 'throw';
const fetchCalls: FetchCall[] = [];
/** What the fake fetch answers; each check sets it. A promise holds the answer back. */
let answerFetch: (call: FetchCall) => FetchAnswer | Promise<FetchAnswer> = () => ({ status: 500, body: { error: 'no answer set' } });

async function fakeFetch(input: unknown, init: Row = {}): Promise<Row> {
  const url = String(input);
  const parsed = new URL(url, 'https://famcal.test');
  const call: FetchCall = {
    url,
    path: parsed.pathname,
    query: parsed.searchParams,
    method: String(init.method ?? 'GET'),
    headers: { ...(init.headers ?? {}) },
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    credentials: init.credentials,
    cache: init.cache,
    signal: init.signal,
  };
  fetchCalls.push(call);
  const reply = await answerFetch(call);
  if (reply === 'throw') throw new TypeError('Failed to fetch (smoke)');
  return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body };
}
const rangeCalls = () => fetchCalls.filter((c) => c.path === '/api/calendar/range');
const sendCalls = () => fetchCalls.filter((c) => c.path === '/api/execute-command');
/** A range call as "<source> <from>→<to>[ fresh]", or "<source> default" with no dates. */
const describeRange = (c: FetchCall) =>
  `${c.query.get('sources')} ${c.query.has('from') ? `${c.query.get('from')}→${c.query.get('to')}` : 'default'}${c.query.get('fresh') === '1' ? ' fresh' : ''}`;
const ranges = () => rangeCalls().map(describeRange);
const ok200 = (body: unknown): FetchAnswer => ({ status: 200, body });
/** The answer to a range call for its own window (the no-dates one is week 0). */
const answerFor = (c: FetchCall, o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}) =>
  ok200(answer({ from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7), ...o }));

/** Lets every pending promise, and the renders and effects they cause, run inside act. */
async function settle() {
  await React.act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}

/** A clock for CalendarHomeContainer's deps: its timers run only on advance(). */
function fakeClock(startIso: string, deviceZone: string | null = TZ) {
  let now = Date.parse(startIso);
  let seq = 0;
  const timers: { id: number; at: number; run: () => void }[] = [];
  const deps: HomeDeps = {
    now: () => now,
    setTimer: (run, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, run });
      return () => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    deviceTimeZone: () => deviceZone,
    reminderAction: postReminderAction,
  };
  return {
    deps,
    /** Moves the clock on, running each timer that falls due, in order. */
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        await React.act(async () => next.run());
        await settle();
      }
      now = end;
    },
    /** Moves the clock on without running any timer, as iOS does while the app is suspended. */
    jump: (ms: number) => {
      now += ms;
    },
    /** The pending timers' delays from now, shortest first. */
    pending: () => timers.map((t) => t.at - now).sort((a, b) => a - b),
  };
}

/** A fake Telegram.WebApp for the home (Bot API 8.0 by default, so `activated` exists). BackButton handlers ride on backButtonClicked, as the SDK's do; the vertical swipes are recorded. */
function fakeTelegramHome(o: { version?: string; scheme?: 'light' | 'dark'; closeThrows?: boolean } = {}) {
  const calls: string[] = [];
  const events = new Map<string, Set<() => void>>();
  const version = o.version ?? '8.0';
  const webApp: Row = {
    initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc',
    version,
    colorScheme: o.scheme ?? 'light',
    isVersionAtLeast: (v: string) => Number(v) <= Number(version),
    setHeaderColor: (c: string) => calls.push(`setHeaderColor(${c})`),
    setBackgroundColor: (c: string) => calls.push(`setBackgroundColor(${c})`),
    onEvent: (e: string, h: () => void) => {
      calls.push(`onEvent(${e})`);
      if (!events.has(e)) events.set(e, new Set());
      events.get(e)?.add(h);
    },
    offEvent: (e: string, h: () => void) => {
      calls.push(`offEvent(${e})`);
      events.get(e)?.delete(h);
    },
    openLink: (url: string) => calls.push(`openLink(${url})`),
    HapticFeedback: { notificationOccurred: (type: string) => calls.push(`haptic(${type})`) },
    close: () => {
      calls.push('close()');
      if (o.closeThrows) throw new Error('close() failed in the smoke');
    },
    // Bot API 7.7 (Task E8): recorded on every fake, called only where isVersionAtLeast('7.7') holds.
    enableVerticalSwipes: () => calls.push('enableVerticalSwipes()'),
    disableVerticalSwipes: () => calls.push('disableVerticalSwipes()'),
    BackButton: {
      onClick: (h: () => void) => {
        calls.push('BackButton.onClick');
        if (!events.has('backButtonClicked')) events.set('backButtonClicked', new Set());
        events.get('backButtonClicked')?.add(h);
      },
      offClick: (h: () => void) => {
        calls.push('BackButton.offClick');
        events.get('backButtonClicked')?.delete(h);
      },
      show: () => calls.push('BackButton.show()'),
      hide: () => calls.push('BackButton.hide()'),
    },
  };
  return {
    webApp,
    calls,
    fire: (e: string) => [...(events.get(e) ?? [])].forEach((h) => h()),
    /** BackButton handlers still registered. */
    backHandlers: () => events.get('backButtonClicked')?.size ?? 0,
  };
}

/** The fake DOM as HTML, so textOf and the markup checks read it as they read renderToString's. */
function htmlOf(node: FakeNode): string {
  if (node instanceof FakeText) return node.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inner = node.childNodes.map(htmlOf).join('');
  if (!(node instanceof FakeElement)) return inner;
  const attrs = [...node.attributes].map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  return `<${node.localName}${attrs}>${inner}</${node.localName}>`;
}
/** A mounted root's markup: its children, as renderToString would give them. */
const innerHtml = (node: FakeNode) => node.childNodes.map(htmlOf).join('');
function byLabel(node: FakeNode, label: string): FakeElement {
  const found = elements(node).filter((e) => e.getAttribute('aria-label') === label);
  assert(found.length > 0, `nothing labelled ${show(label)}`);
  return found[0];
}
function byData(node: FakeNode, name: string, value: string): FakeElement {
  const found = elements(node).filter((e) => e.getAttribute(`data-${name}`) === value);
  assert(found.length > 0, `no data-${name}=${show(value)}`);
  return found[0];
}
const dialogText = (node: FakeNode) => textOf(htmlOf(byRole(node, 'dialog')[0] ?? new FakeElement('div', HTML_NS)));
/** The header's day line as Intl writes it (the server's today, formatted as UTC noon). */
const dayLong = (l: string, d: DayKey) =>
  new Intl.DateTimeFormat(l, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

const pushes: string[] = [];
const fakeRouter = { push: (href: string) => pushes.push(href), replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };

/** What PageGate gives the home: the app router and next-intl. CalendarHome makes its own .ch-home root. */
function inApp(locale: Locale, el: ReactElement): ReactElement {
  const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(AppRouterContext.Provider, { value: fakeRouter }, createElement(NextIntlClientProvider, provider, el));
}

/** A FamCal user on Telegram (the page's user_id is their Telegram id), and a Google admin. */
const FAMCAL_HOME: CalendarHomeProps = {
  user: { id: 5550001, name: 'Dana', isAdmin: false },
  locale: 'en',
  calendarSource: 'NATIVE',
  needsOAuth: false,
  needsCalendars: false,
  hints: HINTS_ALL,
};
const GOOGLE_HOME: CalendarHomeProps = { ...FAMCAL_HOME, user: { id: 5550002, name: 'Avi', isAdmin: true }, calendarSource: 'GOOGLE' };

/** Mounts the home (the default export, or the container on a fake clock) and lets its first effects run. */
async function mountHome(locale: Locale, props: Partial<CalendarHomeProps> = {}, clock?: ReturnType<typeof fakeClock>) {
  const all: CalendarHomeProps = { ...FAMCAL_HOME, ...props, locale };
  const el = clock ? createElement(CalendarHomeContainer, { ...all, deps: clock.deps }) : createElement(CalendarHome, all);
  const m = mount(inApp(locale, el));
  await settle();
  return { ...m, html: () => innerHtml(m.container), text: () => textOf(innerHtml(m.container)) };
}

/** document's own listeners (visibilitychange), which the fake DOM dropped until now. */
const docListeners: { type: string; fn: (event: Row) => void }[] = [];
fakeDocument.addEventListener = (type: string, fn: (event: Row) => void) => docListeners.push({ type, fn });
fakeDocument.removeEventListener = (type: string, fn: (event: Row) => void) => {
  const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
  if (i >= 0) docListeners.splice(i, 1);
};
const fireDocument = (type: string) => React.act(() => docListeners.filter((l) => l.type === type).forEach((l) => l.fn({ type })));

const reloads: string[] = [];
/**
 * A fresh slate for a home check: the fake fetch, no calls or pushes, an empty
 * sessionStorage and localStorage, reload() recorded, no Telegram; the page at the top,
 * no scroll call, no frame, no media query matching, a fresh observer class.
 */
function resetHome() {
  (globalThis as Row).fetch = fakeFetch;
  fetchCalls.length = 0;
  pushes.length = 0;
  reloads.length = 0;
  fakeWindow.sessionStorage = fakeStorage();
  fakeWindow.localStorage = fakeStorage();
  fakeWindow.location = { hash: '', reload: () => reloads.push('reload') };
  fakeWindow.Telegram = undefined;
  fakeWindow.scrollY = 0;
  fakeWindow.IntersectionObserver = FakeIO;
  fakeDocument.visibilityState = 'visible';
  scrollCalls.length = 0;
  frames.clear();
  media.clear();
  FakeIO.all = [];
}

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
    // A calendar's tones are set inline on the mark that draws them (calendarVars), not by the theme.
    const inline = new Set(Object.keys(calendarVars('#000000') ?? {}));
    const read = [...new Set([...HOME_THEME_CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))].filter((n) => !/^--(?:tg|ch)-/.test(n) && !inline.has(n));
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
      assert(!byClass(card, 'ch-row-li').some((li) => elements(li).includes(fakeDocument.activeElement as FakeElement)), 'no row has focus before the tap');
      c.click(more);
      const sixth = elements(byClass(card, 'ch-row-li')[5]).find((e) => e.localName === 'button');
      assert(sixth && fakeDocument.activeElement === sixth, `focus goes to the first revealed row, not the body: ${String((fakeDocument.activeElement as FakeElement)?.textContent)}`);
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

  // ---- CalendarHome (Task D6): the container, in real React with a fake fetch ----

  await check('#21 the container is client-safe: CalendarHome and its parts load no server module', () => {
    const root = path.join(ROOT, 'app/[locale]/dashboard/CalendarHome.tsx');
    assert(require.cache[root] !== undefined, 'CalendarHome is not in require.cache: the check would be empty');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    const parts = ['HomeHeader.tsx', 'HomeBanners.tsx', 'SendSheet.tsx', 'MenuSheet.tsx', 'HomeErrorBoundary.tsx', 'home-shell.ts', 'AgendaView.tsx'].map((f) => `app/[locale]/dashboard/${f}`);
    for (const want of [...parts, 'app/[locale]/PageGate.tsx', 'src/lib/calendar-view/home-loader.ts', 'src/lib/calendar-view/home-client.ts', 'src/lib/command-client.ts']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the home's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#22 CalendarHome (en, FamCal, in Telegram): one range request, no dates, the init data in the header only; placeholders, then the server\'s today, its Hebrew date and the Agenda; Telegram\'s theme and a hidden BackButton on mount; the tab bar (Plan E), with the Agenda selected', async () => {
    resetHome();
    const tg = fakeTelegramHome({ scheme: 'dark' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    let release: (a: FetchAnswer) => void = noop;
    answerFetch = () => new Promise<FetchAnswer>((resolve) => (release = resolve));
    const m = await mountHome('en');
    try {
      const [first, ...more] = rangeCalls();
      assert(first && more.length === 0 && first.url === '/api/calendar/range?user_id=5550001&sources=famcal', `requests: ${show(rangeCalls().map((c) => c.url))}`);
      assert(first.headers['X-Telegram-Init-Data'] === tg.webApp.initData && !/hash=|auth_date|query_id/.test(first.url), 'the init data in the header, never in the URL');
      assert(first.method === 'GET' && first.credentials === 'same-origin' && first.cache === 'no-store', `request: ${show({ method: first.method, credentials: first.credentials, cache: first.cache })}`);
      const before = m.html();
      assert(/^<div class="ch-home" data-theme="dark" dir="ltr" lang="en">/.test(before), `the root: ${before.slice(0, 120)}`);
      assert(before.includes('class="ch-head-ghost"') && before.includes('aria-busy="true"') && !before.includes('<h1'), 'placeholders until the answer, no made-up day');
      byLabel(m.container, 'Send to chat');
      byLabel(m.container, 'Menu');
      for (const call of ['BackButton.hide()', 'setHeaderColor(bg_color)', 'setBackgroundColor(bg_color)', 'onEvent(themeChanged)']) {
        assert(tg.calls.includes(call), `no ${call} on mount: ${show(tg.calls)}`);
      }
      await React.act(async () => release(ok200(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, CARRY_OLD] }))));
      await settle();
      const after = m.html();
      assert(after.includes('<h1 class="ch-head-title">Thursday, 15 October</h1><p class="ch-head-sub">4 Cheshvan 5787</p>'), `the header: ${textOf(after).slice(0, 120)}`);
      assertHas(textOf(after), [`Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`, 'Still open 5 reminders', '09:30 10:30 Dentist', 'Show next week'], 'the Agenda');
      // Plan E: the tab bar under the header, the Agenda selected and its panel shown.
      assert(/<div class="ch-tabs" role="tablist" aria-label="Calendar view" dir="ltr">/.test(after), 'the tablist, named');
      const tabs = byRole(m.container, 'tab').map((e) => [e.getAttribute('id'), e.getAttribute('aria-selected'), e.textContent]);
      assert(show(tabs) === show([['ch-tab-agenda', 'true', 'Agenda'], ['ch-tab-month', 'false', 'Month']]), `the tabs: ${show(tabs)}`);
      const panels = byRole(m.container, 'tabpanel').map((e) => [e.getAttribute('id'), e.hasAttribute('hidden')]);
      assert(show(panels) === show([['ch-panel-agenda', false], ['ch-panel-month', true]]), `the panels: ${show(panels)}`);
      assert(after.indexOf('class="ch-head"') < after.indexOf('role="tablist"') && after.indexOf('role="tablist"') < after.indexOf('class="ch-agenda"'), 'the header, the tab bar, then the Agenda');
      assertLacks(after, ['calendarHome.'], 'no untranslated key');
      assertLacks(textOf(after), ['Open FamCal in Telegram'], 'inside Telegram, no Telegram banner');
      assert(show(ranges()) === show(['famcal default']), `one request in all: ${show(ranges())}`);
    } finally {
      m.unmount();
    }
  });

  await check('#23 he and ru: the root dir="rtl" and the Hebrew header and labels; the Russian header with the genitive Hebrew month (R9); the send icon flips in RTL', async () => {
    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK }));
    const he = await mountHome('he');
    try {
      const html = he.html();
      assert(/^<div class="ch-home" data-theme="light" dir="rtl" lang="he">/.test(html), `the he root: ${html.slice(0, 120)}`);
      assertHas(textOf(html), [`${dayLong('he-IL', TODAY)} ד׳ בחשון תשפ״ז`, 'היום חמישי 15 באוק׳', 'להציג את השבוע הבא'], 'he');
      byLabel(he.container, 'שליחה לצ׳אט');
      byLabel(he.container, 'תפריט');
      assert(html.includes('<svg class="ch-flip"') && /\.ch-home\[dir='rtl'\] \.ch-flip \{\s*transform: scaleX\(-1\);/.test(HOME_SHELL_CSS), 'the send icon flips in RTL');
    } finally {
      he.unmount();
    }
    const ru = await mountHome('ru');
    try {
      const text = ru.text();
      assertHas(text, [`${dayLong('ru-RU', TODAY)} 4 хешвана 5787`, `Сегодня ${ref.dayShort('ru-RU', day(0))}`, 'Показать следующую неделю'], 'ru');
      assertLacks(text, ['Хешван'], 'ru: the genitive, not the nominative');
      byLabel(ru.container, 'Отправить в чат');
      byLabel(ru.container, 'Меню');
    } finally {
      ru.unmount();
    }
    answerFetch = () => ok200(answer({ items: WEEK, hebrewDates: false }));
    const off = await mountHome('en');
    try {
      assert(off.html().includes('<h1 class="ch-head-title">Thursday, 15 October</h1>') && !markup(off.html()).includes('class="ch-head-sub"'), 'no Hebrew date when the route says hebrewDates false');
      assertLacks(off.text(), ['Cheshvan'], 'en, Hebrew dates off');
    } finally {
      off.unmount();
    }
  });

  await check('#24 privacy through the container: no calendar id anywhere in the home, sheet open or not, and a masked partner calendar reads as the partner\'s', async () => {
    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, CARRY_OLD] }));
    const m = await mountHome('en');
    try {
      const ids = [MY_CAL.id, NOA_CAL.id].map(String);
      assertLacks(m.html(), [...ids, 'native:', 'cal_'], 'the home');
      m.click(button(m.container, 'Pick up the parcel'));
      assertLacks(m.html(), [...ids, 'native:', 'cal_'], 'the masked item\'s sheet');
      assertHas(dialogText(m.container), ['Calendar Noa’s calendar', 'From Noa'], 'the masked sheet');
    } finally {
      m.unmount();
    }
  });

  await check('#25 Google (fake clock): sources=google with the page\'s user_id; a stale answer asks that window once more after about 3 s, once; a Google error retries once after about 5 s; calendars_gone never retries', async () => {
    const google = (status: NonNullable<RangeResponse['sources']['google']>) => googleAnswer({ items: { [day(0)]: [DINNER] }, sources: { google: status } });
    resetHome();
    const clock = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => ok200(google({ status: 'ok', stale: true }));
    const m = await mountHome('en', GOOGLE_HOME, clock);
    try {
      assert(show(ranges()) === show(['google default']) && rangeCalls()[0].query.get('user_id') === '5550002', `first: ${show(rangeCalls().map((c) => c.url))}`);
      assertHas(m.text(), ['Dinner with the Cohens'], 'the stale data shows meanwhile');
      await clock.advance(STALE_RETRY_MS - 100);
      assert(ranges().length === 1, 'not before about 3 s');
      await clock.advance(200);
      assert(show(ranges()) === show(['google default', `google ${day(0)}→${day(7)}`]), `the stale re-request: ${show(ranges())}`);
      await clock.advance(60_000);
      assert(ranges().length === 2, `stale again: it waits for the foreground or Refresh: ${show(ranges())}`);
    } finally {
      m.unmount();
    }

    resetHome();
    const c2 = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => ok200(google({ status: 'error', reason: 'transient' }));
    const e = await mountHome('en', GOOGLE_HOME, c2);
    try {
      assertHas(e.text(), ['Couldn’t load Google Calendar Retry'], 'the error row');
      await c2.advance(ERROR_RETRY_MS - 100);
      assert(ranges().length === 1, 'not before about 5 s');
      await c2.advance(200);
      assert(show(ranges()) === show(['google default', `google ${day(0)}→${day(7)}`]), `one automatic retry: ${show(ranges())}`);
      await c2.advance(60_000);
      assert(ranges().length === 2, `and only one: ${show(ranges())}`);
      e.click(button(e.container, 'Retry'));
      await settle();
      assert(show(ranges().slice(2)) === show([`google ${day(0)}→${day(7)}`]), `Retry asks again: ${show(ranges())}`);
    } finally {
      e.unmount();
    }

    resetHome();
    const c3 = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => ok200(google({ status: 'error', reason: 'calendars_gone' }));
    const g = await mountHome('en', GOOGLE_HOME, c3);
    try {
      await c3.advance(60_000);
      assert(ranges().length === 1, `calendars_gone: no retry: ${show(ranges())}`);
      assertHas(g.text(), ['Your calendars aren’t available Choose again'], 'its row');
      g.click(button(g.container, 'Choose again'));
      assert(show(pushes) === show(['/en/select-calendars?user_id=5550002']), `Choose again: ${show(pushes)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#26 "Show next week" asks [today+7, today+14); a return to the foreground (visibilitychange, Telegram\'s activated) asks every visible window once; ⋯ → Refresh sends fresh=1 on each and closes the menu', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    // The fixtures' Thursday: a return to the foreground first checks whether that day has ended (#39).
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    const both = [`famcal ${day(0)}→${day(7)}`, `famcal ${day(7)}→${day(14)}`];
    try {
      assert(tg.calls.includes('onEvent(activated)'), `activated is watched on an 8.0 client: ${show(tg.calls)}`);
      m.click(button(m.container, 'Show next week'));
      await settle();
      assert(show(ranges()) === show(['famcal default', both[1]]), `next week: ${show(ranges())}`);
      assertHas(m.text(), ['Nothing planned Thu 22 – Wed 28 Oct'], 'the second week, answered and empty, folds');
      assert(!m.html().includes('class="ch-ghost"'), 'no placeholders left');

      const held: ((a: FetchAnswer) => void)[] = [];
      answerFetch = () => new Promise<FetchAnswer>((resolve) => held.push(resolve));
      /** Answers the held requests, then forgets every call so far. */
      const release = async () => {
        const calls = rangeCalls();
        await React.act(async () => held.splice(0).forEach((resolve, i) => resolve(answerFor(calls[i], { items: WEEK }))));
        await settle();
        fetchCalls.length = 0;
      };
      fetchCalls.length = 0;
      fakeDocument.visibilityState = 'hidden';
      fireDocument('visibilitychange');
      assert(ranges().length === 0, 'going to the background asks nothing');
      fakeDocument.visibilityState = 'visible';
      fireDocument('visibilitychange');
      assert(show(ranges()) === show(both), `visibilitychange: every visible window: ${show(ranges())}`);
      await release();
      React.act(() => tg.fire('activated'));
      assert(show(ranges()) === show(both), `Telegram's activated: every visible window: ${show(ranges())}`);
      await release();
      fireDocument('visibilitychange');
      React.act(() => tg.fire('activated'));
      assert(show(ranges()) === show(both), `both at once: each window once: ${show(ranges())}`);
      await release();

      fetchCalls.length = 0;
      answerFetch = (c) => answerFor(c, { items: WEEK });
      m.click(byLabel(m.container, 'Menu'));
      assert(byRole(m.container, 'dialog').length === 1, 'the menu is open');
      m.click(byData(m.container, 'menu', 'refresh'));
      await settle();
      assert(show(ranges()) === show(both.map((w) => `${w} fresh`)), `Refresh: ${show(ranges())}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the menu closed');
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    assert(tg.calls.includes('offEvent(activated)'), 'activated is let go on unmount');
  });

  await check('#27 midnight in the user\'s timezone: the store starts over with a no-dates request and the header moves to the new day; a stale re-request for the day that ended is dropped; a device clock that runs ahead resets once, then the timer refetches (after 1, 2, 4... minutes, at most 15) until the server\'s new day moves the header on; the day check never waits more than an hour, and lands after a midnight that DST skips', async () => {
    resetHome();
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    let serverToday = TODAY;
    answerFetch = () => ok200(serverToday === TODAY ? answer({ items: WEEK }) : answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }));
    const m = await mountHome('en', {}, clock);
    try {
      assert(m.html().includes('<h1 class="ch-head-title">Thursday, 15 October</h1>'), 'Thursday');
      const wait = clock.pending()[0];
      assert(wait > 30_000 && wait <= 31_000, `the check waits until just after midnight: ${wait} ms`);
      serverToday = day(1);
      await clock.advance(31_000);
      assert(show(ranges()) === show(['famcal default', 'famcal default']), `after midnight: ${show(ranges())}`);
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header moved on: ${m.text().slice(0, 80)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(1))}`, 'All day Grandma visits'], 'the new today');
      assert(clock.pending().length > 0 && clock.pending().every((ms) => ms <= 3_600_000), `pending: ${show(clock.pending())}`);
    } finally {
      m.unmount();
    }
    // A stale Google answer two seconds before midnight: its re-request is for a day that has gone, so it is dropped.
    resetHome();
    const late = fakeClock('2026-10-15T20:59:58Z');
    let googleToday = TODAY;
    answerFetch = () =>
      ok200(googleToday === TODAY ? googleAnswer({ sources: { google: { status: 'ok', stale: true } } }) : googleAnswer({ today: day(1), from: day(1), to: day(8) }));
    const g = await mountHome('en', GOOGLE_HOME, late);
    try {
      googleToday = day(1);
      await late.advance(STALE_RETRY_MS + 1000);
      assert(show(ranges()) === show(['google default', 'google default']), `only the new day's request: ${show(ranges())}`);
    } finally {
      g.unmount();
    }
    // A device clock that runs ahead of the server's: the reset's no-dates request still gets Thursday,
    // so the timer asks the visible windows again a minute later, then two, four... (at most 15), and the
    // server's Friday moves the header on. The store drops once, never in a loop.
    const fast = async (aheadMs: number) => {
      resetHome();
      const clock = fakeClock('2026-10-15T20:59:30Z'); // the device's 23:59:30, Thursday
      answerFetch = (c) => {
        const today = isPastDay(clock.deps.now() - aheadMs, TZ, TODAY) ? day(1) : TODAY;
        const from = c.query.get('from') ?? today;
        return ok200(answer({ today, from, to: c.query.get('to') ?? addDaysToKey(from, 7), items: today === TODAY ? WEEK : { [day(1)]: [GRANDMA] } }));
      };
      const m = await mountHome('en', {}, clock);
      await clock.advance(31_000); // the device's midnight: the reset
      return { clock, m };
    };
    const a = await fast(10_000);
    try {
      assert(show(ranges()) === show(['famcal default', 'famcal default']), `the reset: ${show(ranges())}`);
      assertHas(a.m.text(), ['Thursday, 15 October', 'Dentist'], 'the server\'s Thursday stands for now');
      assert(a.clock.pending()[0] <= 60_000, `the next check within a minute, not an hour: ${show(a.clock.pending())}`);
      await a.clock.advance(60_000);
      assert(show(ranges().slice(0, 3)) === show(['famcal default', 'famcal default', `famcal ${day(0)}→${day(7)}`]), `then a plain refetch, no second reset: ${show(ranges())}`);
      assert(a.m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header reached Friday: ${a.m.text().slice(0, 80)}`);
      assertHas(a.m.text(), [`Today ${ref.dayShort('en-GB', day(1))}`, 'All day Grandma visits'], 'the new Today');
      assertLacks(a.m.text(), ['Dentist'], 'nothing of Thursday\'s as Today');
      const asked = ranges().length;
      await a.clock.advance(3 * 3_600_000);
      assert(ranges().length === asked, `then nothing more is asked: ${show(ranges())}`);
      assert(a.clock.pending().length === 1 && a.clock.pending()[0] <= 3_600_000, `one day check, an hour at most: ${show(a.clock.pending())}`);
    } finally {
      a.m.unmount();
    }
    const b = await fast(10 * 60_000);
    try {
      const waits: number[] = [];
      while (b.m.text().includes('Thursday, 15 October') && waits.length < 10) {
        const wait = b.clock.pending()[0];
        waits.push(Math.round(wait / 1000));
        await b.clock.advance(wait);
      }
      assert(show(waits) === show([60, 120, 240, 480]), `ten minutes ahead: re-checks after ${show(waits)} s`);
      assert(b.m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `Friday at last: ${b.m.text().slice(0, 80)}`);
      assert(ranges().filter((r) => r === 'famcal default').length === 2, `one reset only: ${show(ranges())}`);
    } finally {
      b.m.unmount();
    }
    assert(msUntilDayCheck(Date.parse('2026-10-15T07:00:00Z'), TZ) === 3_600_000, 'at 10:00 the check waits an hour');
    assert(msUntilAheadCheck(0) === 60_000 && msUntilAheadCheck(3) === 480_000 && msUntilAheadCheck(4) === 900_000 && msUntilAheadCheck(60) === 900_000, 'the ahead re-check: a minute, doubling, at most 15');
    assert(isPastDay(Date.parse('2026-10-15T21:00:01Z'), TZ, TODAY) && !isPastDay(Date.parse('2026-10-15T20:59:59Z'), TZ, TODAY), 'midnight in Israel');
    // Chile skips 00:00 on 6 September 2026: from 23:30 the check lands at 01:00, the new day.
    const santiago = Date.parse('2026-09-06T03:30:00Z');
    const delay = msUntilDayCheck(santiago, 'America/Santiago');
    assert(delay > 30 * 60_000 && delay <= 31 * 60_000 && isPastDay(santiago + delay, 'America/Santiago', '2026-09-05'), `Santiago: ${delay} ms`);
  });

  await check('#28 401, 403 and any 404 show PageGate\'s card and nothing more is asked', async () => {
    for (const [status, error] of [[401, 'Unauthorized'], [403, 'Account suspended'], [404, 'User not found']] as const) {
      resetHome();
      const tg = fakeTelegramHome();
      fakeWindow.Telegram = { WebApp: tg.webApp };
      answerFetch = () => ({ status, body: { error } });
      const m = await mountHome('en');
      try {
        assertHas(m.text(), ['Please open this from the bot', 'Back to the chat'], `${status} in Telegram`);
        assertLacks(m.text(), ['Show next week', 'Today'], `${status}: no Agenda`);
        m.click(button(m.container, 'Back to the chat'));
        assert(tg.calls.includes('close()'), `${status}: its button closes the Mini App`);
        fireDocument('visibilitychange');
        React.act(() => tg.fire('activated'));
        await settle();
        assert(ranges().length === 1 && reloads.length === 0, `${status}: nothing more is asked: ${show(ranges())}`);
      } finally {
        m.unmount();
      }
    }
    resetHome();
    answerFetch = () => ({ status: 401, body: { error: 'Unauthorized' } });
    const web = await mountHome('he');
    try {
      const html = web.html();
      assert(html.includes('href="https://wa.me/972548524687?text=settings"') && html.includes('href="https://t.me/family_calendar_telegram_bot?start=dashboard"'), `the browser card's links: ${textOf(html).slice(0, 160)}`);
    } finally {
      web.unmount();
    }
  });

  await check('#29 before any answer, a 429 shows the busy card and a 500, no answer or a body that isn\'t a RangeResponse the retry card, with no loop; Retry asks again. Once the facts are pinned, a 429 on the next week is that window\'s busy row', async () => {
    const cases: [string, FetchAnswer, string][] = [
      ['429', { status: 429, body: { error: 'Too many requests. Please wait a minute.' } }, 'Busy right now, try again in a minute Retry'],
      ['500', { status: 500, body: { error: 'internal_error' } }, 'Something went wrong Your calendar didn’t load. Try again. Retry'],
      ['no answer', 'throw', 'Something went wrong Your calendar didn’t load. Try again. Retry'],
      ['not a RangeResponse', { status: 200, body: { hello: 'world' } }, 'Something went wrong Your calendar didn’t load. Try again. Retry'],
    ];
    for (const [name, failure, card] of cases) {
      resetHome();
      answerFetch = () => failure;
      const m = await mountHome('en');
      try {
        assertHas(m.text(), [card], name);
        assertLacks(m.text(), ['Show next week', 'Loading your calendar'], `${name}: the card, not placeholders`);
        assert(ranges().length === 1, `${name}: asked once, no loop: ${show(ranges())}`);
        answerFetch = () => ok200(answer({ items: WEEK }));
        m.click(button(m.container, 'Retry'));
        await settle();
        assert(show(ranges()) === show(['famcal default', 'famcal default']), `${name}: Retry: ${show(ranges())}`);
        assertHas(m.text(), ['Today', 'Dentist'], `${name}: then the Agenda`);
      } finally {
        m.unmount();
      }
    }
    resetHome();
    answerFetch = (c) => (c.query.has('from') ? { status: 429, body: {} } : ok200(answer({ items: WEEK })));
    const m = await mountHome('en');
    try {
      m.click(button(m.container, 'Show next week'));
      await settle();
      assertHas(m.text(), ['Busy right now, try again in a minute Retry', 'Dentist'], 'the busy row above the days');
    } finally {
      m.unmount();
    }
  });

  await check('#30 the send sheet (R5): five options in order; a tap posts its command for the page\'s user_id; in Telegram a 2xx closes the app with the spinner kept, one send at a time; in a browser "Sent to WhatsApp"; 429, 403, no answer and a 500 each say why, and the sheet stays', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    let hold: (a: FetchAnswer) => void = noop;
    answerFetch = (c) => (c.path === '/api/execute-command' ? new Promise<FetchAnswer>((resolve) => (hold = resolve)) : ok200(answer({ items: WEEK })));
    const m = await mountHome('en');
    try {
      m.click(byLabel(m.container, 'Send to chat'));
      const dialog = byRole(m.container, 'dialog')[0];
      assert(dialog?.getAttribute('aria-label') === 'Send to chat' && dialog.getAttribute('aria-modal') === 'true', 'a modal dialog labelled Send to chat');
      assertHas(
        dialogText(m.container),
        ['Send to chat FamCal sends it to your chat', 'Today’s summary Events and reminders for today', 'Tomorrow’s summary What’s coming up tomorrow', 'This week Coming up this week', `Next week · ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).formatRange(new Date('2026-10-18T12:00:00Z'), new Date('2026-10-24T12:00:00Z'))} Coming up next week`, 'Weather Today’s forecast', 'Close'],
        'the options',
      );
      const order = elements(dialog).filter((e) => e.hasAttribute('data-send')).map((e) => e.getAttribute('data-send'));
      assert(show(order) === show(['today', 'tomorrow', 'thisWeek', 'nextWeek', 'weather']), `order: ${show(order)}`);
      m.click(byData(dialog, 'send', 'today'));
      const [sent, ...extra] = sendCalls();
      assert(sent && extra.length === 0 && sent.method === 'POST' && sent.body?.user_id === 5550001 && sent.body?.command === 'summary', `the call: ${show(sendCalls().map((c) => c.body))}`);
      assert(sent.headers['X-Telegram-Init-Data'] === tg.webApp.initData && sent.body?.initData === tg.webApp.initData, 'the init data header, and the body copy as the fallback');
      assertHas(dialogText(m.container), ['Today’s summary Sending…'], 'the spinner');
      assert(byData(dialog, 'send', 'weather').getAttribute('aria-disabled') === 'true', 'the other options wait');
      m.click(byData(dialog, 'send', 'weather'));
      assert(sendCalls().length === 1, 'one send at a time');
      await React.act(async () => hold({ status: 200, body: { success: true } }));
      await settle();
      assert(tg.calls.includes('close()'), 'a 2xx closes the Mini App');
      assertHas(dialogText(m.container), ['Today’s summary Sending…'], 'the spinner stays while it closes');
    } finally {
      m.unmount();
    }

    const replies: [string, FetchAnswer, 'today' | 'tomorrow' | 'weather', string, Row][] = [
      ['browser 200', { status: 200, body: { success: true } }, 'tomorrow', 'Sent to WhatsApp', { command: 'summary', args: 'tmrw' }],
      ['429', { status: 429, body: {} }, 'weather', 'Lots of requests right now. Try again in a minute.', { command: 'weather' }],
      ['403', { status: 403, body: {} }, 'today', 'Please reopen FamCal from the chat and try again.', { command: 'summary' }],
      ['no answer', 'throw', 'today', 'No connection. Check your internet and try again.', { command: 'summary' }],
      ['500', { status: 500, body: {} }, 'today', 'Couldn’t send it. Try again.', { command: 'summary' }],
    ];
    for (const [name, reply, item, line, body] of replies) {
      resetHome();
      answerFetch = (c) => (c.path === '/api/execute-command' ? reply : ok200(answer({ items: WEEK })));
      const b = await mountHome('en');
      try {
        b.click(byLabel(b.container, 'Send to chat'));
        b.click(byData(b.container, 'send', item));
        await settle();
        const call = sendCalls()[0];
        assert(call && call.body?.command === body.command && call.body?.args === body.args && call.body?.user_id === 5550001 && !('initData' in (call.body ?? {})), `${name}: ${show(call?.body)}`);
        assert(byRole(b.container, 'dialog').length === 1, `${name}: the sheet stays open`);
        assertHas(dialogText(b.container), [line], name);
        assert(byData(b.container, 'send', 'today').getAttribute('aria-disabled') === null, `${name}: ready for another try`);
      } finally {
        b.unmount();
      }
    }

    resetHome();
    const stuck = fakeTelegramHome({ closeThrows: true });
    fakeWindow.Telegram = { WebApp: stuck.webApp };
    answerFetch = (c) => (c.path === '/api/execute-command' ? { status: 200, body: { success: true } } : ok200(answer({ items: WEEK })));
    const s = await mountHome('he');
    try {
      s.click(byLabel(s.container, 'שליחה לצ׳אט'));
      s.click(byData(s.container, 'send', 'nextWeek'));
      await settle();
      assert(sendCalls()[0]?.body?.command === 'nextweek', 'nextweek');
      assertHas(dialogText(s.container), ['נשלח. אפשר להציץ בצ׳אט'], 'Telegram couldn\'t close the app: the answer is in the chat');
    } finally {
      s.unmount();
    }
  });

  await check('#31 the ⋯ menu (R6): FamCal users get Calendars and Partner, Google users Choose calendars and Reconnect Google, admins the Admin panel; each opens its page with the page\'s user_id, and the sheet closes', async () => {
    const famcal = menuEntries({ calendarSource: 'NATIVE', isAdmin: false, locale: 'en', userId: 5550001 });
    assert(show(famcal.map((e) => e.id)) === show(['settings', 'calendars', 'partner', 'subscription', 'refresh', 'feedback']), `FamCal: ${show(famcal)}`);
    const google = menuEntries({ calendarSource: 'GOOGLE', isAdmin: true, locale: 'ru', userId: 5550002 });
    const want = [
      ['settings', '/ru/settings?user_id=5550002'],
      ['chooseCalendars', '/ru/select-calendars?user_id=5550002'],
      ['reconnectGoogle', '/refresh-token?user_id=5550002'],
      ['subscription', '/ru/subscription?user_id=5550002'],
      ['refresh', null],
      ['feedback', '/ru/feedback?user_id=5550002'],
      ['admin', '/ru/admin-panel?user_id=5550002'],
    ];
    assert(show(google.map((e) => [e.id, e.href])) === show(want), `Google admin: ${show(google)}`);

    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK }));
    const m = await mountHome('en');
    try {
      m.click(byLabel(m.container, 'Menu'));
      assert(byRole(m.container, 'dialog')[0]?.getAttribute('aria-label') === 'Menu', 'a dialog labelled Menu');
      assertHas(dialogText(m.container), ['Settings Calendars Partner Subscription Refresh Feedback Close'], 'the FamCal menu');
      assertLacks(dialogText(m.container), ['Choose calendars', 'Reconnect Google', 'Admin panel'], 'no Google entry, no admin entry');
      m.click(byData(m.container, 'menu', 'partner'));
      assert(show(pushes) === show(['/en/pair?user_id=5550001']), `push: ${show(pushes)}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the menu closed');
    } finally {
      m.unmount();
    }
    resetHome();
    answerFetch = () => ok200(googleAnswer({ items: { [day(0)]: [DINNER] } }));
    const g = await mountHome('ru', GOOGLE_HOME);
    try {
      g.click(byLabel(g.container, 'Меню'));
      assertHas(dialogText(g.container), ['Настройки Выбрать календари Переподключить Google Подписка Обновить Обратная связь Панель администратора'], 'the Google admin\'s menu (ru)');
      g.click(byData(g.container, 'menu', 'admin'));
      assert(show(pushes) === show(['/ru/admin-panel?user_id=5550002']), `push: ${show(pushes)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#32 the banners (§7.2), in order: trial, location, the Google setup card, Reconnect (token or scopes; never with Connect, never for FamCal) and, in a browser, Open FamCal in Telegram; each opens its page', async () => {
    const base: BannerFacts = { calendarSource: 'NATIVE', needsOAuth: false, needsCalendars: false, reconnect: null, inTelegram: true };
    const cases: [Partial<BannerFacts>, string[]][] = [
      [{}, []],
      [{ trialDaysLeft: 5, hasLocation: false, inTelegram: false }, ['trial', 'location', 'openInTelegram']],
      [{ trialDaysLeft: 0, hasLocation: true }, []],
      [{ trialDaysLeft: null }, []],
      [{ reconnect: 'token' }, []],
      [{ calendarSource: 'GOOGLE', hasLocation: false }, []],
      [{ calendarSource: 'GOOGLE', needsOAuth: true, needsCalendars: true, hasLocation: false, reconnect: 'token' }, ['location', 'connectGoogle']],
      [{ calendarSource: 'GOOGLE', needsCalendars: true }, ['chooseCalendars']],
      [{ calendarSource: 'GOOGLE', reconnect: 'token' }, ['reconnect']],
      [{ calendarSource: 'GOOGLE', reconnect: 'scopes', inTelegram: false }, ['reconnectScopes', 'openInTelegram']],
    ];
    for (const [facts, want] of cases) {
      const got = homeBanners({ ...base, ...facts });
      assert(show(got) === show(want), `${show(facts)}: ${show(got)}, want ${show(want)}`);
    }

    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK }));
    const m = await mountHome('en', { trialDaysLeft: 5, hasLocation: false });
    try {
      assertHas(m.text(), ['5 days left in your trial See plans Set your location for the right times Set location Open FamCal in Telegram Reminders, voice summaries and more are waiting there.'], 'en, in a browser');
      const link = byData(m.container, 'banner', 'openInTelegram');
      assert(link.localName === 'a' && link.getAttribute('href') === 'https://t.me/family_calendar_telegram_bot?start=connect' && link.getAttribute('target') === '_blank', `the Telegram link: ${htmlOf(link).slice(0, 160)}`);
      m.click(byData(m.container, 'banner', 'trial'));
      m.click(byData(m.container, 'banner', 'location'));
      assert(show(pushes) === show(['/en/subscription?user_id=5550001', '/en/settings?user_id=5550001']), `pushes: ${show(pushes)}`);
    } finally {
      m.unmount();
    }
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = () => ok200(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'scopes' } }, calendars: [] }));
    const g = await mountHome('he', { ...GOOGLE_HOME, trialDaysLeft: 2 });
    try {
      assertHas(g.text(), ['נשארו יומיים לתקופת הניסיון', 'FamCal צריך הרשאה לקרוא את היומן צריך להתחבר מחדש ל-Google ולאשר גישה ליומן. חיבור מחדש ל-Google'], 'he: the trial (two days) and the scopes banner');
      assertLacks(g.text(), ['לפתוח את FamCal בטלגרם', 'Nothing planned'], 'inside Telegram: no Telegram banner; a reconnect is never "nothing planned"');
      g.click(byData(g.container, 'banner', 'reconnectScopes'));
      assert(show(pushes) === show(['/refresh-token?user_id=5550002']), `pushes: ${show(pushes)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#33 "Times in <zone>" shows only when the device is in another zone than the route\'s (an alias is the same zone)', async () => {
    const cases: [Locale, string | null, string | null][] = [
      ['en', 'Europe/London', 'Times in Israel Time'],
      ['he', 'America/New_York', 'השעות לפי שעון ישראל'],
      ['ru', 'Europe/Moscow', 'Часовой пояс: Израиль'],
      ['en', 'Asia/Jerusalem', null],
      ['en', 'Asia/Tel_Aviv', null],
      ['en', null, null],
    ];
    for (const [locale, device, want] of cases) {
      resetHome();
      answerFetch = () => ok200(answer({ items: WEEK }));
      const m = await mountHome(locale, {}, fakeClock('2026-10-15T07:00:00Z', device));
      try {
        if (want) assertHas(m.text(), [want], `${locale} on ${device}`);
        else assert(!markup(m.html()).includes('class="ch-head-zone"'), `${device}: no zone line`);
      } finally {
        m.unmount();
      }
    }
    assert(!zoneDiffers('Asia/Kolkata', 'Asia/Calcutta') && zoneDiffers('UTC', TZ) && !zoneDiffers(null, TZ), 'zoneDiffers');
  });

  await check('#34 the shell\'s CSS (§7.1): nothing under 11 px, taps at least 44 px, logical properties only, no hover, overflow-x: clip (never hidden), the stable viewport height, both safe-area families with 0 fallbacks, no transform or filter on the frame', () => {
    const css = HOME_SHELL_CSS;
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length > 10 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px');
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    for (const selector of ['.ch-icon-btn', '.ch-banner', '.ch-option', '.ch-option-compact', '.ch-home-card-action']) {
      const min = /min-height:\s*(\d+)px/.exec(rule(selector));
      assert(min && Number(min[1]) >= 44, `${selector} min-height ${min?.[1]}`);
    }
    assert(/min-width:\s*44px/.test(rule('.ch-icon-btn')), '.ch-icon-btn min-width 44px');
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    const frame = rule('.ch-home');
    assert(!/overflow:\s*hidden/.test(css) && /overflow-x:\s*clip/.test(frame), 'overflow-x: clip, never overflow: hidden');
    assert(frame.includes('min-height: var(--tg-viewport-stable-height, 100dvh)'), 'the stable viewport height');
    for (const v of ['--tg-safe-area-inset-top, 0px', '--tg-content-safe-area-inset-top, 0px', '--tg-safe-area-inset-left, 0px', '--tg-content-safe-area-inset-left, 0px', '--tg-safe-area-inset-right, 0px', '--tg-content-safe-area-inset-right, 0px']) {
      assert(frame.includes(`var(${v})`), `no var(${v}) on the frame`);
    }
    assert(!/\b(?:transform|filter)\s*:/.test(frame), 'no transform or filter on the frame (the sheets are position: fixed)');
  });

  await check('#35 the error boundary (§5): a render error shows the Reload card in the home\'s look and language; a chunk-load error reloads once by itself, never twice in a minute', async () => {
    assert(
      isChunkLoadError(Object.assign(new Error('Loading chunk 123 failed.'), { name: 'ChunkLoadError' })) &&
        isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://famcal.bot/_next/static/chunks/x.js')) &&
        isChunkLoadError(new TypeError('Importing a module script failed.')) &&
        !isChunkLoadError(new TypeError('x is undefined')),
      'isChunkLoadError',
    );
    const el = CalendarHome(FAMCAL_HOME) as ReactElement;
    assert(el.type === HomeErrorBoundary, 'the default export wraps the home in the boundary');
    const crash = (locale: Locale, error: Error) => {
      const Thrower = () => {
        throw error;
      };
      return mount(inApp(locale, createElement(HomeErrorBoundary, null, createElement(Thrower))), { onCaughtError: noop, onUncaughtError: noop });
    };
    resetHome();
    appLogs.length = 0;
    const a = crash('he', new TypeError('x is undefined'));
    try {
      const html = innerHtml(a.container);
      assert(/^<div class="ch-home" data-theme="light" dir="rtl" lang="he">/.test(html), `the card's root: ${html.slice(0, 120)}`);
      assertHas(textOf(html), ['משהו השתבש היומן נתקע. טעינה מחדש בדרך כלל עוזרת. לטעון מחדש'], 'the he card');
      assert(reloads.length === 0, 'a plain error never reloads by itself');
      a.click(button(a.container, 'לטעון מחדש'));
      assert(show(reloads) === show(['reload']), 'Reload reloads');
      assert(appLogs.some((l) => l.startsWith('[calendar-home] The home failed to render')), `logged: ${show(appLogs)}`);
    } finally {
      a.unmount();
    }
    resetHome();
    const chunk = Object.assign(new Error('Loading chunk 77 failed.'), { name: 'ChunkLoadError' });
    crash('en', chunk).unmount();
    assert(show(reloads) === show(['reload']) && fakeWindow.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null, `a chunk-load error reloads once: ${show(reloads)}`);
    const c = crash('en', chunk);
    try {
      assert(show(reloads) === show(['reload']), `not twice within a minute: ${show(reloads)}`);
      assertHas(textOf(innerHtml(c.container)), ['Something went wrong The calendar ran into a problem. Reloading usually fixes it. Reload'], 'the card instead');
    } finally {
      c.unmount();
    }
    appLogs.length = 0;
  });

  await check('#36 a range request that never settles is aborted after about 15 s and counts as no answer: before any answer, the retry card, and the next return to the foreground asks again; once the facts are pinned, a hung refetch no longer holds back the next one', async () => {
    resetHome();
    const clock = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => new Promise<FetchAnswer>(() => undefined);
    const m = await mountHome('en', {}, clock);
    try {
      assert(show(ranges()) === show(['famcal default']), `first: ${show(ranges())}`);
      assert(clock.pending().includes(RANGE_TIMEOUT_MS), `a ${RANGE_TIMEOUT_MS} ms limit on the request: ${show(clock.pending())}`);
      await clock.advance(RANGE_TIMEOUT_MS - 1000);
      assertHas(m.text(), ['Loading your calendar…'], 'still loading after 14 s');
      await clock.advance(6000);
      assert(rangeCalls()[0].signal?.aborted === true, 'the request was aborted');
      assertHas(m.text(), ['Something went wrong Your calendar didn’t load. Try again. Retry'], 'after 20 s, the retry card');
      assert(ranges().length === 1, `no loop: ${show(ranges())}`);
      answerFetch = (c) => answerFor(c, { items: WEEK });
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show(['famcal default', 'famcal default']), `the foreground asks again: ${show(ranges())}`);
      assertHas(m.text(), ['Today', 'Dentist'], 'then the Agenda');
      // The facts are pinned: a refetch that hangs is let go too.
      answerFetch = () => new Promise<FetchAnswer>(() => undefined);
      fireDocument('visibilitychange');
      fireDocument('visibilitychange');
      assert(show(ranges().slice(2)) === show([`famcal ${day(0)}→${day(7)}`]), `in flight, a second return is deduped: ${show(ranges())}`);
      await clock.advance(20_000);
      answerFetch = (c) => answerFor(c, { items: WEEK });
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges().slice(2)) === show([`famcal ${day(0)}→${day(7)}`, `famcal ${day(0)}→${day(7)}`]), `past the limit, the next return asks again: ${show(ranges())}`);
      assertHas(m.text(), ['Dentist'], 'the data stays meanwhile');
      assertLacks(m.text(), ['Something went wrong'], 'no card once the facts are pinned');
    } finally {
      m.unmount();
    }
  });

  await check('#37 Telegram\'s BackButton is the container\'s one (§7.6): hidden on mount; shown while the item sheet, the Send sheet or the ⋯ menu is open; a tap (also Android\'s back gesture) closes only that sheet, then offClick and hide; a store drop closes the item sheet for good', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    let serverToday = TODAY;
    answerFetch = () => ok200(serverToday === TODAY ? answer({ items: WEEK }) : answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }));
    const m = await mountHome('en', {}, clock);
    const back = () => tg.calls.filter((c) => c.startsWith('BackButton'));
    try {
      assert(show(back()) === show(['BackButton.hide()']), `on mount: ${show(back())}`);
      const dentist = button(m.container, 'Dentist');
      dentist.focus();
      const sheets: [string, () => FakeElement][] = [
        ['the item sheet', () => dentist],
        ['the Send sheet', () => byLabel(m.container, 'Send to chat')],
        ['the menu', () => byLabel(m.container, 'Menu')],
      ];
      for (const [name, opener] of sheets) {
        const target = opener();
        target.focus();
        tg.calls.length = 0;
        m.click(target);
        assert(byRole(m.container, 'dialog').length === 1, `${name} is open`);
        assert(show(back()) === show(['BackButton.onClick', 'BackButton.show()']), `${name} open: ${show(back())}`);
        tg.calls.length = 0;
        React.act(() => tg.fire('backButtonClicked'));
        assert(byRole(m.container, 'dialog').length === 0, `the BackButton closed ${name}`);
        assert(show(back()) === show(['BackButton.offClick', 'BackButton.hide()']), `${name} closed: ${show(back())}`);
        assert(tg.backHandlers() === 0, `${name}: no handler left`);
        assert(fakeDocument.activeElement === target, `${name}: focus is back where it was`);
        assertHas(m.text(), ['Thursday, 15 October', 'Dentist', 'Show next week'], `only ${name} closed`);
      }
      // Midnight with the sheet open: the store drops, the sheet closes for good, the button goes.
      m.click(button(m.container, 'Send the school form'));
      tg.calls.length = 0;
      serverToday = day(1);
      await clock.advance(31_000);
      assert(show(back()) === show(['BackButton.offClick', 'BackButton.hide()']), `the drop let the button go: ${show(back())}`);
      assertHas(m.text(), ['Friday, 16 October', 'Grandma visits'], 'the new day');
      assert(byRole(m.container, 'dialog').length === 0 && tg.backHandlers() === 0, 'the next answer does not open it again');
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#38 a Google user who connected but hasn\'t chosen calendars (the route answers ok with 7 empty days): the Choose your calendars banner, and under it no "Nothing planned", no hint, no fold, no "Show next week"; before connecting, the Connect banner the same way', async () => {
    const cases: [Locale, Partial<CalendarHomeProps>, RangeResponse, string, string, string[]][] = [
      ['en', { needsCalendars: true }, googleAnswer({ calendars: [] }), 'chooseCalendars', 'Choose your calendars Pick the Google calendars to show here and in your summaries.', ['Nothing planned', 'voice message', 'Remind me', 'Show next week', 'Today', 'Tomorrow']],
      ['he', { needsCalendars: true }, googleAnswer({ calendars: [] }), 'chooseCalendars', 'בחירת יומנים אילו יומני Google להציג כאן ובסיכומים?', ['אין אירועים', 'הודעה קולית', 'תזכיר לי', 'להציג את השבוע הבא', 'היום', 'מחר']],
      ['en', { needsOAuth: true, needsCalendars: true }, googleAnswer({ sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] }), 'connectGoogle', 'Connect Google Calendar Your calendar shows up here once it’s connected.', ['Nothing planned', 'Reconnect', 'Show next week', 'Today', 'Tomorrow']],
    ];
    for (const [locale, setup, reply, banner, title, absent] of cases) {
      resetHome();
      answerFetch = () => ok200(reply);
      const m = await mountHome(locale, { ...GOOGLE_HOME, ...setup });
      try {
        assertHas(m.text(), [title], `${locale} ${banner}`);
        assert(m.html().includes(`data-banner="${banner}"`), `${locale}: the ${banner} banner`);
        assertLacks(m.text(), absent, `${locale} ${banner}: no Agenda under the banner`);
        assert(!/class="ch-(?:fold|ghost|empty|day-head|more)\b/.test(markup(m.html())), `${locale} ${banner}: no fold, placeholder, empty state, day or button`);
        assert(show(ranges()) === show(['google default']), `${locale}: one request: ${show(ranges())}`);
        m.click(byData(m.container, 'banner', banner));
        const want = banner === 'chooseCalendars' ? `/${locale}/select-calendars?user_id=5550002` : '/refresh-token?user_id=5550002';
        assert(show(pushes) === show([want]), `${banner} opens ${want}: ${show(pushes)}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#39 back in the foreground after the night, the midnight timer not yet run (iOS suspends timers): the store starts over at once with a no-dates request, the header and Today move to the new day, yesterday\'s items are never labelled Today, and the late timer resets nothing; a device clock that runs ahead resets once, then only refetches; with init data over a day old the route answers 401 and the home shows PageGate\'s card', async () => {
    const overnight = async (reply: (today: DayKey) => FetchAnswer | Promise<FetchAnswer>) => {
      resetHome();
      const tg = fakeTelegramHome();
      fakeWindow.Telegram = { WebApp: tg.webApp };
      const clock = fakeClock('2026-10-15T18:00:00Z'); // 21:00 Thursday in Israel
      answerFetch = () => ok200(answer({ items: WEEK }));
      const m = await mountHome('en', {}, clock);
      assert(m.html().includes('<h1 class="ch-head-title">Thursday, 15 October</h1>'), 'Thursday');
      assert(clock.pending().some((ms) => ms <= 3_600_000), `the day check is armed: ${show(clock.pending())}`);
      clock.jump(10 * 3_600_000); // 07:00 Friday in Israel; the timer never ran
      answerFetch = () => reply(day(1));
      fetchCalls.length = 0;
      return { tg, clock, m };
    };

    let release: (a: FetchAnswer) => void = noop;
    const { tg, clock, m } = await overnight(() => new Promise<FetchAnswer>((resolve) => (release = resolve)));
    try {
      React.act(() => tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show(['famcal default']), `one no-dates request, not yesterday's window: ${show(ranges())}`);
      assertLacks(m.text(), ['Thursday, 15 October', 'Dentist', 'Today'], 'until the answer: placeholders, never yesterday as Today');
      await React.act(async () => release(ok200(answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }))));
      await settle();
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header: ${m.text().slice(0, 80)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(1))}`, 'All day Grandma visits'], 'the new Today');
      assertLacks(m.text(), ['Dentist', 'Send the school form'], 'nothing of Thursday\'s');
      // The suspended timer is due now; it was dropped with the old day and resets nothing.
      await clock.advance(0);
      assert(clock.pending().every((ms) => ms > 0), `no timer left overdue: ${show(clock.pending())}`);
      assert(show(ranges()) === show(['famcal default']) && m.text().includes('Friday, 16 October'), `no second reset: ${show(ranges())}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }

    // A device clock that runs ahead (the server still says Thursday): one reset, then plain refetches.
    const ahead = await overnight(() => ok200(answer({ items: WEEK })));
    try {
      React.act(() => ahead.tg.fire('activated'));
      await settle();
      React.act(() => ahead.tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show(['famcal default', `famcal ${day(0)}→${day(7)}`]), `one reset, then a refetch: ${show(ranges())}`);
      assertHas(ahead.m.text(), ['Thursday, 15 October', 'Dentist'], 'the server\'s day stands');
    } finally {
      ahead.m.unmount();
      fakeWindow.Telegram = undefined;
    }

    // Init data older than a day: the route proves no one (401), and the home shows PageGate's card, asking nothing more.
    const stale = await overnight(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    try {
      React.act(() => stale.tg.fire('activated'));
      await settle();
      assertHas(stale.m.text(), ['Please open this from the bot', 'Back to the chat'], '401: PageGate\'s card');
      assertLacks(stale.m.text(), ['Dentist', 'Today'], '401: no stale Agenda');
      React.act(() => stale.tg.fire('activated'));
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show(['famcal default']), `401: nothing more is asked: ${show(ranges())}`);
    } finally {
      stale.m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#40 PageGate\'s boundary around the home\'s chunk (spec §5): an import that rejects with a ChunkLoadError reloads the page once, with the home\'s guard, behind the loader; within the guard, the gate\'s error card, whose button reloads; any other error, the card and no reload; never an empty tree', async () => {
    assert(typeof HomeChunkBoundary === 'function', 'PageGate exports no HomeChunkBoundary');
    const gate = messages.he.pageGate;
    /** What next/dynamic is in the app router: React.lazy inside Suspense, here with an import that rejects. */
    const failing = (error: Error) => {
      const Home = React.lazy(() => Promise.reject(error));
      const loading = createElement('p', null, 'loading the chunk');
      const el = inApp('he', createElement(HomeChunkBoundary, null, createElement(React.Suspense, { fallback: loading }, createElement(Home))));
      return mount(el, { onCaughtError: noop, onUncaughtError: noop });
    };
    const chunkError = () => Object.assign(new Error('Loading chunk 4471 failed.'), { name: 'ChunkLoadError' });
    resetHome();
    appLogs.length = 0;
    const a = failing(chunkError());
    await settle();
    try {
      assert(show(reloads) === show(['reload']) && fakeWindow.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null, `one reload, with the home's guard key: ${show(reloads)}`);
      assert(innerHtml(a.container).includes('pagegate-spin'), `the loader while the page reloads: ${textOf(innerHtml(a.container)).slice(0, 120)}`);
      assert(appLogs.some((l) => l.startsWith('[calendar-home] The home did not load')), `logged: ${show(appLogs)}`);
    } finally {
      a.unmount();
    }
    const b = failing(chunkError());
    await settle();
    try {
      assert(show(reloads) === show(['reload']), `not twice within a minute: ${show(reloads)}`);
      assertHas(textOf(innerHtml(b.container)), [gate.errorTitle, gate.errorBody, gate.retry], 'within the guard, the gate\'s error card');
      b.click(button(b.container, gate.retry));
      assert(show(reloads) === show(['reload', 'reload']), 'its button reloads');
    } finally {
      b.unmount();
    }
    resetHome();
    const c = failing(new TypeError('x is undefined'));
    await settle();
    try {
      assert(reloads.length === 0, 'another error never reloads by itself');
      assertHas(textOf(innerHtml(c.container)), [gate.errorTitle, gate.retry], 'the card');
    } finally {
      c.unmount();
    }
    appLogs.length = 0;
  });

  await check('#41 React logged no warning in any render, CalendarHome\'s included (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === 0, `warnings: ${show(reactWarnings.slice(0, 5))}`);
  });

  await check('#42 the midnight reset with a refetch in flight that then fails (500): no retry card, only the placeholders until the new day\'s answer, which then shows; React logs no warning', async () => {
    resetHome();
    const warned = reactWarnings.length;
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    answerFetch = () => ok200(answer({ items: WEEK }));
    const m = await mountHome('en', {}, clock);
    try {
      await clock.advance(25_000); // 23:59:55: the day check is still 5.5 s away
      let failOld: (a: FetchAnswer) => void = noop;
      answerFetch = () => new Promise<FetchAnswer>((resolve) => (failOld = resolve));
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show(['famcal default', `famcal ${day(0)}→${day(7)}`]), `the refetch is in flight: ${show(ranges())}`);
      let answerNew: (a: FetchAnswer) => void = noop;
      answerFetch = () => new Promise<FetchAnswer>((resolve) => (answerNew = resolve));
      await clock.advance(6_000); // past midnight: the store starts over
      assert(show(ranges().slice(2)) === show(['famcal default']), `the new day's no-dates request: ${show(ranges())}`);
      await React.act(async () => failOld({ status: 500, body: { error: 'internal_error' } }));
      await settle();
      assertLacks(m.text(), ['Something went wrong', 'Retry'], 'the old refetch\'s 500');
      assertHas(m.text(), ['Loading your calendar…'], 'the placeholders until the new answer');
      await React.act(async () => answerNew(ok200(answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }))));
      await settle();
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header: ${m.text().slice(0, 80)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(1))}`, 'All day Grandma visits'], 'the new Today');
      assertLacks(m.text(), ['Something went wrong'], 'no card after the answer');
      assert(ranges().length === 3, `nothing more was asked: ${show(ranges())}`);
    } finally {
      m.unmount();
    }
    assert(reactWarnings.length === warned, `warnings: ${show(reactWarnings.slice(warned, warned + 5))}`);
  });

  // ---- The tabs and the Month through the container (Plan E, Task E8) ----

  const warnedBeforeMonth = reactWarnings.length;
  /** The fixtures' window and each month's top in the browse list (Hebrew dates on, Sunday weeks). */
  const WINDOW = monthSpan(TODAY);
  const OFFSETS = monthOffsets(WINDOW, 0, true);
  const topOfMonth = (month: MonthKey) => OFFSETS[WINDOW.indexOf(month)];
  /** The page offset that puts `month`'s title just under the stuck bar, less `peek`. */
  const underBar = (month: MonthKey, peek = 0) => LAYOUT.listTop + topOfMonth(month) - monthBarPx(true) - peek;
  /** A scroll that reads `month` as the one in view (browse reads it half a week row under the bar). */
  const inViewAt = (month: MonthKey) => underBar(month, BROWSE_CELL_PX / 2) + 10;
  /** A month's window as ranges() writes it: "famcal 2026-10-01→2026-11-01". */
  const monthAsk = (month: MonthKey, o: { fresh?: boolean } = {}) => `famcal ${monthWindow(month).from}→${monthWindow(month).to}${o.fresh ? ' fresh' : ''}`;
  /** Runs the frames requested so far (and any they request), inside act. */
  const flushFrames = () =>
    React.act(() => {
      for (let round = 0; round < 5 && frames.size > 0; round++) {
        const batch = [...frames.values()];
        frames.clear();
        for (const run of batch) run();
      }
    });
  /** The user scrolls the page to `top`: the window gets a scroll event, and the next frame measures. */
  const scrollPageTo = (top: number) => {
    fakeWindow.scrollY = top;
    React.act(() => windowListeners.filter((l) => l.type === 'scroll').forEach((l) => l.fn()));
    flushFrames();
  };
  type Home = Awaited<ReturnType<typeof mountHome>>;
  const tabButton = (m: Home, id: 'agenda' | 'month') => {
    const found = elements(m.container).find((e) => e.getAttribute('id') === TAB_IDS[id]);
    assert(found, `no ${id} tab`);
    return found;
  };
  const panel = (m: Home, id: 'agenda' | 'month') => {
    const found = elements(m.container).find((e) => e.getAttribute('id') === PANEL_IDS[id]);
    assert(found, `no ${id} panel`);
    return found;
  };
  const browseShown = (m: Home) => byClass(m.container, 'ch-mb').length === 1;
  const pickedShown = (m: Home) => byClass(m.container, 'ch-mp').length === 1;
  const barMonth = (m: Home) => byClass(m.container, 'ch-mb-bar-month')[0]?.textContent ?? null;
  /** A day's button in browse (inside its month's block) or in picked, by its label's start. */
  const dayButton = (m: Home, dayKey: DayKey) => {
    const where = browseShown(m) ? byClass(byData(m.container, 'month', dayKey.slice(0, 7)), 'ch-mb-cell') : byClass(m.container, 'ch-mp-cell');
    const found = where.filter((e) => (e.getAttribute('aria-label') ?? '').startsWith(formatDayLong(dayKey, 'en')));
    assert(found.length === 1, `no day button for ${dayKey}`);
    return found[0];
  };
  /** A tap on the Month tab, then what follows: the answers, the first frame's measure, their effects. */
  const openMonth = async (m: Home) => {
    m.click(tabButton(m, 'month'));
    await settle();
    flushFrames();
    await settle();
  };
  const tap = async (m: Home, el: FakeNode) => {
    m.click(el);
    await settle();
    flushFrames();
    await settle();
  };
  const swipeCalls = (calls: string[]) => calls.filter((c) => /VerticalSwipes/.test(c));
  const backCalls = (calls: string[]) => calls.filter((c) => c.startsWith('BackButton'));

  await check('#43 the Month\'s parts are client-safe, and its views are a chunk of their own (every /dashboard open preloads CalendarHome\'s chunk, the users the switch doesn\'t cover included): CalendarHome loads HomeTabs, month.ts, grid.ts, home-storage.ts and hebrew-date.ts, and reaches MonthView only through one import(), never MonthBrowse or MonthPicked; MonthView loads both; neither graph has a server module or @hebcal/core', () => {
    const graph = (id: string) => {
      const loaded = new Set<string>();
      const walk = (at: string) => {
        for (const child of require.cache[at]?.children ?? []) {
          if (loaded.has(child.id)) continue;
          loaded.add(child.id);
          walk(child.id);
        }
      };
      walk(id);
      return loaded;
    };
    const dashboard = (f: string) => path.join(ROOT, 'app/[locale]/dashboard', f);
    const root = dashboard('CalendarHome.tsx');
    const home = graph(root);
    for (const want of [dashboard('HomeTabs.tsx'), ...['month.ts', 'grid.ts', 'home-storage.ts', 'hebrew-date.ts'].map((f) => path.join(ROOT, 'src/lib/calendar-view', f))]) {
      assert(home.has(want), `${path.relative(ROOT, want)} not among CalendarHome's modules`);
    }
    const views = ['MonthView.tsx', 'MonthBrowse.tsx', 'MonthPicked.tsx'].map(dashboard);
    assert(views.every((v) => !home.has(v)), `in CalendarHome's own chunk: ${show(views.filter((v) => home.has(v)).map((v) => path.relative(ROOT, v)))}`);
    const source = fs.readFileSync(root, 'utf8');
    assert((source.match(/import\('\.\/MonthView'\)/g) ?? []).length === 1, 'one import() of ./MonthView');
    assert(!/^import (?!type )[^;]*from '\.\/Month(?:View|Browse|Picked)';/m.test(source), 'a static import of a Month view');
    nodeRequire(views[0]);
    const view = graph(views[0]);
    assert(view.has(views[1]) && view.has(views[2]), 'MonthView loads MonthBrowse and MonthPicked');
    const forbidden = [...home, ...view].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the home's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#44 the tab bar (Rulings 1 and 2): under the header and above the banners; a tap on Month shows the Month panel, closes the item sheet and is kept for the session; back on the Agenda the page goes to the top; a remount in the session opens on the Month, a new session or another user on the Agenda; in Hebrew the bar runs right to left', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const clock = fakeClock('2026-10-15T07:00:00Z');
    const m = await mountHome('en', { trialDaysLeft: 5, hasLocation: true }, clock);
    try {
      const html = m.html();
      const order = ['class="ch-head"', 'role="tablist"', 'data-banner="trial"', 'role="tabpanel"'].map((s) => html.indexOf(s));
      assert(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `the header, the tab bar, the banners, then the panel: ${show(order)}`);
      assert(panel(m, 'agenda').getAttribute('aria-labelledby') === TAB_IDS.agenda && panel(m, 'month').getAttribute('aria-labelledby') === TAB_IDS.month, 'each panel is labelled by its tab');
      assert(panel(m, 'month').hasAttribute('hidden') && panel(m, 'month').childNodes.length === 0, 'the Month panel is there for aria-controls, hidden and empty');
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1, 'the item sheet is open');
      await openMonth(m);
      assert(byRole(m.container, 'dialog').length === 0, 'the switch closed the item sheet');
      assert(tabButton(m, 'month').getAttribute('aria-selected') === 'true' && tabButton(m, 'agenda').getAttribute('aria-selected') === 'false', 'Month is selected');
      assert(!panel(m, 'month').hasAttribute('hidden') && panel(m, 'agenda').hasAttribute('hidden') && panel(m, 'agenda').childNodes.length === 0, 'the Month panel shows; the Agenda is unmounted');
      assert(browseShown(m) && byClass(m.container, 'ch-agenda').length === 0, 'MonthBrowse in the Month panel');
      assert(fakeWindow.sessionStorage.getItem(homeTabKey(5550001)) === 'month', 'the tab is kept for the session');
      assert(tg.backHandlers() === 0, `no BackButton in browse: ${show(backCalls(tg.calls))}`);
      m.click(byLabel(m.container, 'Menu'));
      assert(byRole(m.container, 'dialog').length === 1, 'the menu is open');
      scrollCalls.length = 0;
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(byRole(m.container, 'dialog').length === 0, 'the switch closed the menu');
      assert(show(scrollCalls) === show([{ top: 0, behavior: 'plain' }]), `the Agenda opens at the top: ${show(scrollCalls)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`, 'Show next week'], 'the Agenda again');
      assert(fakeWindow.sessionStorage.getItem(homeTabKey(5550001)) === 'agenda', 'the Agenda is kept');
      m.click(tabButton(m, 'month'));
      await settle();
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    const again = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(tabButton(again, 'month').getAttribute('aria-selected') === 'true' && browseShown(again), 'a remount in the same session opens on the Month');
    } finally {
      again.unmount();
    }
    const other = await mountHome('en', GOOGLE_HOME, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(tabButton(other, 'agenda').getAttribute('aria-selected') === 'true', 'another user on the device keeps their own tab');
    } finally {
      other.unmount();
    }
    resetHome();
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const fresh = await mountHome('he', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(tabButton(fresh, 'agenda').getAttribute('aria-selected') === 'true' && !browseShown(fresh), 'a new session opens on the Agenda');
      assert(/<div class="ch-tabs" role="tablist" aria-label="תצוגת היומן" dir="rtl">/.test(fresh.html()), 'he: the tablist reads right to left');
      assertHas(textOf(htmlOf(byRole(fresh.container, 'tablist')[0])), ['סדר יום חודש'], 'he: the tab labels');
    } finally {
      fresh.unmount();
    }
  });

  await check('#45 the Month opens on today\'s month with a peek: placeholders and swipes off before the first answer; then one instant scroll puts October\'s title under the bar with half a week row of September above it; its windows are a month\'s own days ([2026-10-01, 2026-11-01) first), at most 2 in flight, each asked once; a month coming near is asked at once', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
    let first: (a: FetchAnswer) => void = noop;
    answerFetch = (c) =>
      new Promise<FetchAnswer>((resolve) => {
        if (c.query.has('from')) held.push({ call: c, resolve });
        else first = resolve;
      });
    const answerOne = async (month: MonthKey) => {
      const at = held.findIndex((h) => h.call.query.get('from') === monthWindow(month).from);
      assert(at >= 0, `${month} is not in flight: ${show(held.map((h) => h.call.query.get('from')))}`);
      const [h] = held.splice(at, 1);
      await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
      await settle();
      flushFrames();
      await settle();
    };
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assertHas(textOf(htmlOf(panel(m, 'month'))), ['Loading your calendar…'], 'before the first answer: the Month\'s placeholders');
      assert(!browseShown(m) && !/class="ch-mb-cell/.test(m.html()), 'no grid, so no free-looking day, before the facts');
      assert(show(swipeCalls(tg.calls)) === show(['disableVerticalSwipes()']), `swipes off while browse loads: ${show(swipeCalls(tg.calls))}`);
      await React.act(async () => first(answerFor({ query: new URLSearchParams() } as FetchCall, { items: WEEK })));
      await settle();
      assert(browseShown(m), 'the Month tab, kept for the session, opens in browse');
      assert(show(scrollCalls) === show([{ top: underBar('2026-10', BROWSE_CELL_PX / 2), behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)} (want ${underBar('2026-10', BROWSE_CELL_PX / 2)})`);
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11')]), `October, then November; September waits: ${show(ranges())}`);
      flushFrames();
      await settle();
      assert(barMonth(m) === 'October 2026', `the bar: ${barMonth(m)}`);
      assert(dayButton(m, TODAY).getAttribute('aria-current') === 'date', 'today\'s cell');
      FakeIO.all[0].fire({ '2026-08': false, '2026-09': true, '2026-10': true, '2026-11': true, '2026-12': true });
      flushFrames();
      await settle();
      assert(ranges().length === 3 && held.length === MONTH_INFLIGHT_MAX, `still 2 in flight: ${show(ranges())}`);
      await answerOne('2026-10');
      assert(show(ranges().slice(3)) === show([monthAsk('2026-09')]), `a slot frees: September, the nearest one waiting: ${show(ranges())}`);
      assert(held.length <= MONTH_INFLIGHT_MAX, `in flight: ${held.length}`);
      await answerOne('2026-11');
      assert(show(ranges().slice(3)) === show([monthAsk('2026-09'), monthAsk('2026-12')]), `then December: ${show(ranges())}`);
      await answerOne('2026-09');
      await answerOne('2026-12');
      FakeIO.all[0].fire({ '2026-09': true, '2026-12': false });
      flushFrames();
      await settle();
      scrollPageTo(fakeWindow.scrollY + 30);
      await settle();
      const asked = ranges();
      assert(new Set(asked).size === asked.length && asked.length === 5, `each window once: ${show(asked)}`);
      assert(!asked.some((r) => r.startsWith(`famcal ${day(0)}`)), 'the Agenda\'s week isn\'t asked again on the Month');
      const october = textOf(htmlOf(byData(m.container, 'month', '2026-10')));
      assertHas(october, ['October', 'Dentist', 'Grandma visits', 'Trip to Eilat'], 'October\'s chips');
      assert(!/loading/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? ''), 'an answered day reads answered');
      // January comes near (no answer has changed the store): it is asked at once.
      FakeIO.all[0].fire({ '2027-01': true });
      flushFrames();
      await settle();
      assert(show(ranges().slice(5)) === show([monthAsk('2027-01')]), `a month coming near: ${show(ranges())}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#46 swipes (Ruling 9): on a 7.7 client they go off in browse and on in picked, on the Agenda and on unmount, enabled on mount, isVerticalSwipesEnabled never read; a 7.0 client gets no swipe call', async () => {
    for (const version of ['7.7', '7.0']) {
      resetHome();
      const tg = fakeTelegramHome({ version });
      let reads = 0;
      Object.defineProperty(tg.webApp, 'isVerticalSwipesEnabled', {
        get() {
          reads++;
          throw new Error('isVerticalSwipesEnabled must never be read');
        },
      });
      fakeWindow.Telegram = { WebApp: tg.webApp };
      answerFetch = (c) => answerFor(c, { items: WEEK });
      const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
      const steps: string[][] = [];
      const step = () => {
        steps.push(swipeCalls(tg.calls));
        tg.calls.length = 0;
      };
      try {
        step(); // mount, on the Agenda
        await openMonth(m);
        step(); // browse
        await tap(m, dayButton(m, '2026-10-20'));
        assert(pickedShown(m), `${version}: picked`);
        step(); // picked
        React.act(() => tg.fire('backButtonClicked'));
        await settle();
        flushFrames();
        step(); // back in browse
        m.click(tabButton(m, 'agenda'));
        await settle();
        step(); // the Agenda
        await openMonth(m);
        tg.calls.length = 0;
      } finally {
        m.unmount();
        fakeWindow.Telegram = undefined;
      }
      step(); // unmount
      const want =
        version === '7.7'
          ? [['enableVerticalSwipes()'], ['disableVerticalSwipes()'], ['enableVerticalSwipes()'], ['disableVerticalSwipes()'], ['enableVerticalSwipes()'], ['enableVerticalSwipes()']]
          : [[], [], [], [], [], []];
      assert(show(steps) === show(want), `${version}: ${show(steps)}`);
      assert(reads === 0, `${version}: isVerticalSwipesEnabled was read ${reads} times`);
    }
  });

  await check('#47 picked (spec §7.4, §7.6): a tap on a day opens it, shows the BackButton and keeps "picked" on the device; with the item sheet over it one tap closes only the sheet, the next goes back to browse with the picked month under the bar; a tab switch brings browse back on the month that was in view', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await openMonth(m);
      tg.calls.length = 0;
      scrollCalls.length = 0;
      await tap(m, dayButton(m, TODAY));
      assert(pickedShown(m) && !browseShown(m), 'picked');
      assert(show(backCalls(tg.calls)) === show(['BackButton.onClick', 'BackButton.show()']), `the BackButton shows: ${show(backCalls(tg.calls))}`);
      assert(fakeWindow.localStorage.getItem(monthLayoutKey(5550001)) === 'picked', 'the layout is kept on the device');
      assert(show(scrollCalls) === show([{ top: 0, behavior: 'plain' }]), `picked starts at the top: ${show(scrollCalls)}`);
      assertHas(m.text(), ['All months', 'October 2026', 'Today · Thursday, 15 October', '09:30 10:30 Dentist'], 'the picked day and its rows');
      // The item sheet over picked: the button stays; one tap closes only the sheet.
      tg.calls.length = 0;
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1 && dialogText(m.container).includes('Clinic on Herzl St'), 'the item sheet over picked');
      assert(backCalls(tg.calls).length === 0 && tg.backHandlers() === 1, `the button was already there: ${show(backCalls(tg.calls))}`);
      // A refetch meanwhile: the sheet shows the row as the latest answer has it.
      const moved = item('dentist', { ...DENTIST, location: 'Clinic on Jaffa Rd' });
      answerFetch = (c) => answerFor(c, { items: { ...WEEK, [day(0)]: [VITAMINS, moved, FORM, SNOOZED, FOOTBALL, CONCERT] } });
      fireDocument('visibilitychange');
      await settle();
      assert(dialogText(m.container).includes('Clinic on Jaffa Rd'), `the sheet after a refetch: ${dialogText(m.container).slice(0, 200)}`);
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(byRole(m.container, 'dialog').length === 0 && pickedShown(m), 'one tap closed only the sheet');
      assert(backCalls(tg.calls).length === 0 && tg.backHandlers() === 1, `the button stays for picked: ${show(backCalls(tg.calls))}`);
      // The next tap: browse, on the picked month. A chevron moves it to November first: the
      // same MonthPicked (no scroll to the top), December asked at once, and an item sheet
      // still open when the day changes (the check taps the chevron behind it; the sheet keeps
      // a keyboard's focus, #59) closes with the day it showed.
      answerFetch = (c) => answerFor(c, { items: WEEK });
      assert(!ranges().includes(monthAsk('2026-12')), 'December not asked yet');
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1, 'the sheet again');
      const picked = byClass(m.container, 'ch-mp')[0];
      scrollCalls.length = 0;
      m.click(byLabel(m.container, 'Next month'));
      await settle();
      assertHas(m.text(), ['November 2026'], 'the next month');
      assert(byClass(m.container, 'ch-mp')[0] === picked && scrollCalls.length === 0, `one MonthPicked, not keyed by month: ${show(scrollCalls)}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the sheet closed with its day');
      assert(ranges().includes(monthAsk('2026-12')), `the chevron asks the month after November: ${show(ranges())}`);
      tg.calls.length = 0;
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(browseShown(m) && !pickedShown(m), 'back in browse');
      assert(show(backCalls(tg.calls)) === show(['BackButton.offClick', 'BackButton.hide()']) && tg.backHandlers() === 0, `the button goes: ${show(backCalls(tg.calls))}`);
      assert(fakeWindow.localStorage.getItem(monthLayoutKey(5550001)) === 'browse', 'browse is kept');
      assert(show(scrollCalls) === show([{ top: underBar('2026-11'), behavior: 'instant' }]), `November under the bar, no peek: ${show(scrollCalls)}`);
      // Before browse's first frame reports, the Month's windows centre on November, not on what was in view before picked.
      const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
      answerFetch = (c) => new Promise<FetchAnswer>((resolve) => held.push({ call: c, resolve }));
      fetchCalls.length = 0;
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show([monthAsk('2026-11'), monthAsk('2026-12')]), `centred on November: ${show(ranges())}`);
      for (const h of held.splice(0)) await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
      await settle();
      for (const h of held.splice(0)) await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
      answerFetch = (c) => answerFor(c, { items: WEEK });
      await settle();
      flushFrames();
      await settle();
      assert(barMonth(m) === 'November 2026', `the bar: ${barMonth(m)}`);
      // "All months" does the same.
      await tap(m, dayButton(m, '2026-11-03'));
      m.click(button(m.container, 'All months'));
      await settle();
      flushFrames();
      assert(browseShown(m) && barMonth(m) === 'November 2026', 'All months: browse on November');
      // The month in view is kept across a tab switch.
      scrollPageTo(inViewAt('2027-01'));
      await settle();
      assert(barMonth(m) === 'January 2027', `scrolled to January: ${barMonth(m)}`);
      m.click(tabButton(m, 'agenda'));
      await settle();
      scrollCalls.length = 0;
      await openMonth(m);
      assert(show(scrollCalls) === show([{ top: underBar('2027-01'), behavior: 'instant' }]), `browse comes back on January, no peek: ${show(scrollCalls)}`);
      assert(barMonth(m) === 'January 2027', `the bar: ${barMonth(m)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#48 a restored picked layout opens on today with the BackButton shown, and asks the picked month, the one after, then the one before; its BackButton goes to browse on October', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    fakeWindow.localStorage.setItem(monthLayoutKey(5550001), 'picked');
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(pickedShown(m), 'picked');
      assert(dayButton(m, TODAY).getAttribute('aria-pressed') === 'true', 'today is the selected day');
      assertHas(m.text(), ['Today · Thursday, 15 October', 'Dentist'], 'today\'s list');
      assert(show(backCalls(tg.calls)) === show(['BackButton.hide()', 'BackButton.onClick', 'BackButton.show()']), `hidden on mount, then shown for picked: ${show(backCalls(tg.calls))}`);
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the picked month, then its neighbours: ${show(ranges())}`);
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      flushFrames();
      assert(browseShown(m) && barMonth(m) === 'October 2026', `browse on October: ${barMonth(m)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    // Opened on the Agenda, with the Month not seen yet when midnight passes: it still opens on the new today.
    resetHome();
    fakeWindow.localStorage.setItem(monthLayoutKey(5550001), 'picked');
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    let serverToday = TODAY;
    answerFetch = (c) => (serverToday === TODAY ? answerFor(c, { items: WEEK }) : answerFor(c, { today: day(1), from: c.query.get('from') ?? day(1), to: c.query.get('to') ?? day(8), items: { [day(1)]: [GRANDMA] } }));
    const n = await mountHome('en', {}, clock);
    try {
      serverToday = day(1);
      await clock.advance(31_000);
      assert(n.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), 'the new day');
      await openMonth(n);
      assert(pickedShown(n) && dayButton(n, day(1)).getAttribute('aria-pressed') === 'true', 'picked opens on the new today');
      assertHas(n.text(), ['Today · Friday, 16 October', 'Grandma visits'], 'the new today\'s list');
    } finally {
      n.unmount();
    }
  });

  await check('#49 on the Month, a return to the foreground asks its windows again, not the Agenda\'s week, two at a time; ⋯ → Refresh sends fresh=1 on each; on the Agenda the same return asks only its week', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the first asks: ${show(ranges())}`);
      const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
      answerFetch = (c) => new Promise<FetchAnswer>((resolve) => held.push({ call: c, resolve }));
      const releaseAll = async () => {
        while (held.length > 0) {
          const h = held.shift() as (typeof held)[number];
          await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
          await settle();
        }
      };
      fetchCalls.length = 0;
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11')]) && held.length === 2, `the foreground: the Month's windows, two in flight: ${show(ranges())}`);
      await releaseAll();
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `then the third: ${show(ranges())}`);
      fetchCalls.length = 0;
      m.click(byLabel(m.container, 'Menu'));
      m.click(byData(m.container, 'menu', 'refresh'));
      await settle();
      assert(byRole(m.container, 'dialog').length === 0, 'the menu closed');
      await releaseAll();
      assert(show(ranges()) === show(['2026-10', '2026-11', '2026-09'].map((mo) => monthAsk(mo, { fresh: true }))), `Refresh: fresh=1 on each: ${show(ranges())}`);
      fetchCalls.length = 0;
      answerFetch = (c) => answerFor(c, { items: WEEK });
      m.click(tabButton(m, 'agenda'));
      await settle();
      fetchCalls.length = 0;
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show([`famcal ${day(0)}→${day(7)}`]), `on the Agenda, only its week: ${show(ranges())}`);
    } finally {
      m.unmount();
    }
  });

  await check('#50 a month that fails (500) shows "Couldn\'t load this month · Retry" over dimmed cells that never look free; Retry asks that month\'s window again, and the answer clears it', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    let october: FetchAnswer = { status: 500, body: { error: 'internal_error' } };
    answerFetch = (c) => (c.query.get('from') === '2026-10-01' ? october : answerFor(c, { items: WEEK }));
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      const block = () => byData(m.container, 'month', '2026-10');
      assertHas(textOf(htmlOf(block())), ['Couldn’t load this month Retry'], 'the pill');
      assert(/couldn’t load/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? '') && dayButton(m, '2026-10-02').className.includes('is-failed'), 'a failed day reads failed, dimmed');
      assert(!/nothing planned/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? ''), 'never free');
      assert(/nothing planned/.test(dayButton(m, '2026-10-17').getAttribute('aria-label') ?? ''), 'the Agenda\'s answered week stays answered');
      october = answerFor({ query: new URLSearchParams('from=2026-10-01&to=2026-11-01') } as FetchCall, { items: WEEK });
      fetchCalls.length = 0;
      await tap(m, button(block(), 'Retry'));
      assert(show(ranges()) === show([monthAsk('2026-10')]), `Retry: ${show(ranges())}`);
      assertLacks(textOf(htmlOf(block())), ['Couldn’t load this month'], 'the pill goes');
      assert(/nothing planned/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? ''), 'then the day is answered');
    } finally {
      m.unmount();
    }
  });

  await check('#51 midnight on the Month: browse stays where it is (no new opening scroll), its cells loading and never free until the new day\'s answer; then today moves to the 16th and the windows are asked again in the new epoch', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, clock);
    try {
      flushFrames();
      await settle();
      const browse = byClass(m.container, 'ch-mb')[0];
      assert(browse && scrollCalls.length === 1, `browse, opened once: ${show(scrollCalls)}`);
      let release: (a: FetchAnswer) => void = noop;
      answerFetch = (c) =>
        c.query.has('from') ? answerFor(c, { today: day(1), items: { [day(1)]: [GRANDMA] } }) : new Promise<FetchAnswer>((resolve) => (release = resolve));
      fetchCalls.length = 0;
      await clock.advance(31_000);
      flushFrames();
      assert(show(ranges()) === show(['famcal default']), `the new day's no-dates request: ${show(ranges())}`);
      assert(byClass(m.container, 'ch-mb')[0] === browse && scrollCalls.length === 1, 'browse stayed mounted, no new opening scroll');
      assert(/loading/.test(dayButton(m, '2026-10-17').getAttribute('aria-label') ?? ''), 'the cells read loading');
      assertLacks(textOf(htmlOf(byData(m.container, 'month', '2026-10'))), ['Dentist', 'nothing planned'], 'nothing of Thursday\'s, no free day');
      await React.act(async () => release(answerFor({ query: new URLSearchParams() } as FetchCall, { today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } })));
      await settle();
      flushFrames();
      await settle();
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header: ${m.text().slice(0, 80)}`);
      assert(dayButton(m, day(1)).getAttribute('aria-current') === 'date' && dayButton(m, TODAY).getAttribute('aria-current') === null, 'today moved to the 16th');
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the windows again: ${show(ranges())}`);
      assert(byClass(m.container, 'ch-mb')[0] === browse && scrollCalls.length === 1, 'still the same browse, still one opening scroll');
    } finally {
      m.unmount();
    }
    // Picked on Tuesday 20 October at midnight: picked stays on that day (clampMonthUi), mounted, loading, then answered.
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const late = fakeClock('2026-10-15T20:59:30Z');
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const p = await mountHome('en', {}, late);
    try {
      flushFrames();
      await tap(p, dayButton(p, '2026-10-20'));
      const picked = byClass(p.container, 'ch-mp')[0];
      assert(picked && dayButton(p, '2026-10-20').getAttribute('aria-pressed') === 'true', 'picked on the 20th');
      let release: (a: FetchAnswer) => void = noop;
      answerFetch = (c) =>
        c.query.has('from') ? answerFor(c, { today: day(1), items: { [day(1)]: [GRANDMA] } }) : new Promise<FetchAnswer>((resolve) => (release = resolve));
      scrollCalls.length = 0;
      await late.advance(31_000);
      assert(byClass(p.container, 'ch-mp')[0] === picked && scrollCalls.length === 0, 'picked stayed mounted, no scroll to the top');
      assert(/loading/.test(dayButton(p, '2026-10-21').getAttribute('aria-label') ?? '') && dayButton(p, '2026-10-20').getAttribute('aria-pressed') === 'true', 'loading, the 20th still picked');
      assertLacks(textOf(htmlOf(picked)), ['Nothing planned'], 'never free while loading');
      await React.act(async () => release(answerFor({ query: new URLSearchParams() } as FetchCall, { today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } })));
      await settle();
      assert(dayButton(p, '2026-10-20').getAttribute('aria-pressed') === 'true' && dayButton(p, day(1)).getAttribute('aria-current') === 'date', 'the 20th stays picked; today is the 16th');
      assertHas(p.text(), ['Tuesday, 20 October', 'Nothing planned', 'Today'], 'the 20th answered, and the Today pill');
    } finally {
      p.unmount();
    }
  });

  await check('#52 a Google user still setting up (Ruling 1): no tab bar and no tab panel even with the Month remembered, which is left as it is; the Agenda\'s setup shape as in D, no month request, and swipes stay on', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550002), 'month');
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = () => ok200(googleAnswer({ calendars: [] }));
    const m = await mountHome('en', { ...GOOGLE_HOME, needsCalendars: true });
    try {
      assertLacks(m.html(), ['role="tablist"', 'role="tab"', 'role="tabpanel"', 'class="ch-mb', 'class="ch-mp'], 'no tabs, no Month');
      assert(m.html().includes('data-banner="chooseCalendars"') && byClass(m.container, 'ch-agenda').length === 1, 'the banner and the (empty) Agenda');
      assert(show(ranges()) === show(['google default']), `one request: ${show(ranges())}`);
      assert(fakeWindow.sessionStorage.getItem(homeTabKey(5550002)) === 'month', 'the stored tab is left as it is');
      assert(show(swipeCalls(tg.calls)) === show(['enableVerticalSwipes()']), `swipes on: ${show(swipeCalls(tg.calls))}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    // The busy card before any answer: no tab bar either.
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    answerFetch = () => ({ status: 429, body: {} });
    const b = await mountHome('en');
    try {
      assertHas(b.text(), ['Busy right now, try again in a minute Retry'], 'the busy card');
      assertLacks(b.html(), ['role="tablist"', 'role="tabpanel"', 'Loading your calendar'], 'no tab bar over a card');
    } finally {
      b.unmount();
    }
  });

  await check('#54 no ancestor of the Month clips or transforms (spec §7.1): from the sticky bar and from picked up to the root, no rule or style sets overflow hidden, auto or scroll, a transform or a filter', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', { trialDaysLeft: 5 }, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      const css = elements(m.container)
        .filter((e) => e.localName === 'style')
        .map((e) => e.textContent)
        .join('\n');
      const bad = /(?:^|;|\{)\s*(?:overflow(?:-[xy])?\s*:\s*(?:hidden|auto|scroll)|transform\s*:|filter\s*:)/;
      // The last compound of each selector (".ch-home[dir='rtl'] .ch-flip" → ".ch-flip"), as tag and classes.
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((r) => bad.test(`{${r[2]}`))
        .flatMap((r) => r[1].split(',').map((sel) => sel.trim().split(/[\s>+~]+/).pop() ?? ''))
        .map((last) => ({ last, tag: /^[a-z][\w-]*/.exec(last)?.[0] ?? null, classes: [...last.matchAll(/\.([\w-]+)/g)].map((x) => x[1]) }))
        .filter((r) => r.tag !== null || r.classes.length > 0);
      assert(rules.some((r) => r.classes.includes('ch-visually-hidden')), `the rule scan reads the sheets: ${show(rules.map((r) => r.last).slice(0, 8))}`);
      const ancestorsOf = (el: FakeElement) => {
        const out: FakeElement[] = [];
        for (let n = el.parentNode; n && n !== m.container; n = n.parentNode) if (n instanceof FakeElement) out.push(n);
        return out;
      };
      const offenders = (el: FakeElement) =>
        ancestorsOf(el).flatMap((a) => {
          const classes = a.className.split(' ').filter(Boolean);
          const byRule = rules.filter((r) => (r.tag === null || r.tag === a.localName) && r.classes.every((c) => classes.includes(c)) && (r.classes.length > 0 || r.tag === a.localName));
          const inline = ['overflow', 'overflowX', 'overflowY', 'transform', 'filter'].filter((k) => a.style[k] && !(k.startsWith('overflow') && a.style[k] === 'clip'));
          return [...byRule.map((r) => `${a.localName}.${classes.join('.')} ← ${r.last}`), ...inline.map((k) => `${a.localName}.${classes.join('.')} style.${k}`)];
        });
      const bar = byClass(m.container, 'ch-mb-bar')[0];
      assert(bar && ancestorsOf(bar).some((a) => a.className.includes('ch-home')) && ancestorsOf(bar).some((a) => a.getAttribute('role') === 'tabpanel'), 'the bar sits in the tab panel, in the home');
      assert(offenders(bar).length === 0, `browse: ${show(offenders(bar))}`);
      await tap(m, dayButton(m, '2026-10-20'));
      const picked = byClass(m.container, 'ch-mp')[0];
      assert(picked && offenders(picked).length === 0, `picked: ${show(picked ? offenders(picked) : 'no picked')}`);
    } finally {
      m.unmount();
    }
  });

  await check('#55 a Google user\'s calendars that are gone (Ruling 4): "2 calendars aren\'t available · Choose again" once, above the Month, in browse and in picked; Choose again opens select-calendars; the Month asks Google for its windows', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550002), 'month');
    const calendars: CalendarDTO[] = [
      { id: G_FAMILY.id as string, source: 'google', name: 'Family', color: '#7986CB', mine: true },
      { id: 'gone-1@group.calendar.google.com', source: 'google', name: 'Old', color: null, mine: true, unavailable: true },
      { id: 'gone-2@group.calendar.google.com', source: 'google', name: 'Older', color: null, mine: true, unavailable: true },
    ];
    answerFetch = (c) => ok200(googleAnswer({ from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7), items: { [day(0)]: [DINNER] }, calendars }));
    const m = await mountHome('en', GOOGLE_HOME, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      const once = (where: string) => {
        const html = m.html();
        assert((textOf(html).match(/2 calendars aren’t available Choose again/g) ?? []).length === 1, `${where}: the row once: ${textOf(html).slice(0, 300)}`);
        assert(html.indexOf('2 calendars aren’t available') < html.indexOf(where === 'browse' ? 'class="ch-mb"' : 'class="ch-mp"'), `${where}: above the Month`);
      };
      assert(browseShown(m), 'browse');
      once('browse');
      assert(show(ranges()) === show(['google default', 'google 2026-10-01→2026-11-01', 'google 2026-11-01→2026-12-01', 'google 2026-09-01→2026-10-01']), `Google's month windows: ${show(ranges())}`);
      await tap(m, dayButton(m, TODAY));
      assert(pickedShown(m), 'picked');
      once('picked');
      m.click(button(m.container, 'Choose again'));
      assert(show(pushes) === show(['/en/select-calendars?user_id=5550002']), `Choose again: ${show(pushes)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#56 browse keeps the header and the tab bar on screen, as the approved MonthFlow does: they sit in .ch-home-top, which sticks under the safe areas in browse only, above the Month\'s bar and under the sheets, and whose height goes on .ch-home as --ch-top-h for the bar\'s top and the titles\' scroll-margin-top; 6,400 px down at today\'s month, ⋯ → Refresh is a tap away and asks the months near October; on the Agenda and in picked it scrolls with the page', async () => {
    resetHome();
    const topH = LAYOUT.topH;
    LAYOUT.topH = 126;
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', { trialDaysLeft: 5 }, fakeClock('2026-10-15T07:00:00Z'));
    const top = () => {
      const found = closestClass(byRole(m.container, 'tablist')[0] ?? null, 'ch-home-top');
      assert(found, 'the tab bar is not in .ch-home-top');
      return found;
    };
    const sticky = () => top().className.split(' ').includes('is-sticky');
    const rule = (css: string, selector: string) => {
      const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((r) => r[1].trim() === selector);
      assert(found.length === 1, `${found.length} ${selector} rules`);
      return found[0][2];
    };
    const decl = (body: string, prop: string) => new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;
    try {
      assert(byClass(top(), 'ch-head').length === 1 && byRole(top(), 'tablist').length === 1 && byClass(top(), 'ch-banners').length === 0, 'the header and the tab bar, not the banners');
      assert(!sticky(), 'on the Agenda it scrolls with the page');
      await openMonth(m);
      assert(sticky(), 'browse: it sticks');
      const home = byClass(m.container, 'ch-home')[0];
      assert(home.style['--ch-top-h'] === '126px', `--ch-top-h on .ch-home: ${home.style['--ch-top-h']}`);
      const stuck = rule(HOME_TOP_CSS, '.ch-home-top.is-sticky');
      assert(decl(stuck, 'position') === 'sticky' && decl(stuck, 'top') === 'calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px))' && decl(stuck, 'background') === 'var(--ch-bg)', `the sticky rule: ${stuck}`);
      const z = Number(decl(stuck, 'z-index'));
      assert(z > Number(decl(rule(MONTH_BROWSE_CSS, '.ch-mb-bar'), 'z-index')) && z < Number(decl(rule(HOME_THEME_CSS, '.ch-sheet-layer'), 'z-index')), `z-index ${z}: above the Month's bar, under the sheets`);
      assert((decl(rule(MONTH_BROWSE_CSS, '.ch-mb-bar'), 'top') ?? '').includes('var(--ch-top-h, 0px)') && (decl(rule(MONTH_BROWSE_CSS, '.ch-mb-title'), 'scroll-margin-top') ?? '').includes('var(--ch-top-h, 0px)'), 'the bar\'s top and the titles\' scroll margin add --ch-top-h');
      assert(elements(m.container).some((e) => e.localName === 'style' && e.textContent === HOME_TOP_CSS), 'its styles are rendered');
      scrollPageTo(inViewAt('2026-10'));
      await settle();
      assert(barMonth(m) === 'October 2026' && Number(fakeWindow.scrollY) > 6000, `October, ${fakeWindow.scrollY} px down`);
      fetchCalls.length = 0;
      m.click(byLabel(m.container, 'Menu'));
      m.click(byData(m.container, 'menu', 'refresh'));
      await settle();
      assert(show(ranges()) === show(['2026-10', '2026-11', '2026-09'].map((mo) => monthAsk(mo, { fresh: true }))), `Refresh at October: ${show(ranges())}`);
      await tap(m, dayButton(m, '2026-10-20'));
      assert(pickedShown(m) && !sticky(), 'picked: it scrolls with the page');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      flushFrames();
      assert(browseShown(m) && sticky(), 'back in browse: it sticks again');
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(!sticky(), 'the Agenda: in the page again');
    } finally {
      m.unmount();
      LAYOUT.topH = topH;
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#57 a tab switch from picked and back (spec §7.1, §7.6): the Agenda lets the BackButton go (offClick, hide) and leaves swipes on; back on the Month, picked on the same day, the button again (onClick, show), one scroll to the top and focus on the selected day; its BackButton still goes to browse', async () => {
    resetHome();
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await openMonth(m);
      await tap(m, dayButton(m, '2026-10-20'));
      assert(pickedShown(m) && tg.backHandlers() === 1 && swipeCalls(tg.calls).at(-1) === 'enableVerticalSwipes()', `picked: ${show(backCalls(tg.calls))} ${show(swipeCalls(tg.calls))}`);
      tg.calls.length = 0;
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(show(backCalls(tg.calls)) === show(['BackButton.offClick', 'BackButton.hide()']) && tg.backHandlers() === 0, `the Agenda: ${show(backCalls(tg.calls))}`);
      assert(!swipeCalls(tg.calls).includes('disableVerticalSwipes()'), `swipes stay on: ${show(swipeCalls(tg.calls))}`);
      tg.calls.length = 0;
      scrollCalls.length = 0;
      await openMonth(m);
      assert(pickedShown(m) && dayButton(m, '2026-10-20').getAttribute('aria-pressed') === 'true', 'picked on the 20th again');
      assert(show(backCalls(tg.calls)) === show(['BackButton.onClick', 'BackButton.show()']) && tg.backHandlers() === 1, `back on the Month: ${show(backCalls(tg.calls))}`);
      assert(!swipeCalls(tg.calls).includes('disableVerticalSwipes()'), `swipes stay on in picked: ${show(swipeCalls(tg.calls))}`);
      assert(show(scrollCalls) === show([{ top: 0, behavior: 'plain' }]), `one scroll to the top: ${show(scrollCalls)}`);
      assert(fakeDocument.activeElement === dayButton(m, '2026-10-20'), 'focus on the selected day');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      flushFrames();
      assert(browseShown(m) && barMonth(m) === 'October 2026', `the BackButton goes to browse: ${barMonth(m)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#58 Telegram\'s activated on an 8.0 client, as visibilitychange in #49 (spec §5 lists both): on the Month a return asks its windows again, not the Agenda\'s week, two at a time, then the third; on the Agenda only its week', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const tg = fakeTelegramHome({ version: '8.0' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      assert(tg.calls.includes('onEvent(activated)'), `listening for activated: ${show(tg.calls.filter((c) => c.startsWith('onEvent')))}`);
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the first asks: ${show(ranges())}`);
      const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
      answerFetch = (c) => new Promise<FetchAnswer>((resolve) => held.push({ call: c, resolve }));
      fetchCalls.length = 0;
      React.act(() => tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11')]) && held.length === 2, `activated: the Month's windows, two in flight: ${show(ranges())}`);
      while (held.length > 0) {
        const h = held.shift() as (typeof held)[number];
        await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
        await settle();
      }
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `then the third: ${show(ranges())}`);
      answerFetch = (c) => answerFor(c, { items: WEEK });
      m.click(tabButton(m, 'agenda'));
      await settle();
      fetchCalls.length = 0;
      React.act(() => tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show([`famcal ${day(0)}→${day(7)}`]), `on the Agenda, only its week: ${show(ranges())}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#59 the item sheet over picked keeps focus (aria-modal, spec §7.7): Tab from its last control (Close) goes to its first ("Open in Google Calendar"), Shift+Tab from its first (or the panel) to its last; focus that lands behind it, on a day of the month, comes back to the sheet and picks nothing; Escape closes it wherever focus is; then focus goes back to the row and the trap lets go', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => ok200(googleAnswer({ from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7), items: { [day(0)]: [DINNER] } }));
    const m = await mountHome('en', GOOGLE_HOME, fakeClock('2026-10-15T07:00:00Z'));
    const trap = () => docListeners.filter((l) => l.type === 'focusin' || l.type === 'keydown');
    const focusIn = (target: FakeNode) => React.act(() => docListeners.filter((l) => l.type === 'focusin').forEach((l) => l.fn({ type: 'focusin', target })));
    const docKey = (key: string, target: FakeNode) => React.act(() => docListeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn({ type: 'keydown', key, target, preventDefault: noop })));
    const name = (n: unknown) => (n instanceof FakeElement ? `${n.localName}.${n.className} ${n.textContent.slice(0, 40)}` : String(n));
    try {
      await openMonth(m);
      await tap(m, dayButton(m, TODAY));
      assert(trap().length === 0, `listeners before any sheet: ${trap().length}`);
      const row = button(m.container, 'Dinner with the Cohens');
      row.focus();
      m.click(row);
      const dialog = byRole(m.container, 'dialog')[0];
      assert(dialog && fakeDocument.activeElement === dialog, `the sheet has focus: ${name(fakeDocument.activeElement)}`);
      const controls = elements(dialog).filter((e) => (e.localName === 'button' && !e.hasAttribute('disabled')) || (e.localName === 'a' && e.hasAttribute('href')));
      assert(controls.length >= 2 && controls[0].textContent === 'Open in Google Calendar' && controls[controls.length - 1].textContent === 'Close', `the sheet's controls: ${show(controls.map((c) => c.textContent))}`);
      const first = controls[0];
      const last = controls[controls.length - 1];
      last.focus();
      m.key(last, 'Tab');
      assert(fakeDocument.activeElement === first, `Tab from the last control: ${name(fakeDocument.activeElement)}`);
      m.key(first, 'Tab', { shiftKey: true });
      assert(fakeDocument.activeElement === last, `Shift+Tab from the first control: ${name(fakeDocument.activeElement)}`);
      dialog.focus();
      m.key(dialog, 'Tab', { shiftKey: true });
      assert(fakeDocument.activeElement === last, `Shift+Tab from the panel: ${name(fakeDocument.activeElement)}`);
      const behind = dayButton(m, '2026-10-20');
      behind.focus();
      focusIn(behind);
      assert(fakeDocument.activeElement === dialog, `focus behind the sheet: ${name(fakeDocument.activeElement)}`);
      assert(byRole(m.container, 'dialog').length === 1 && dayButton(m, TODAY).getAttribute('aria-pressed') === 'true', 'the sheet and the picked day stay');
      docKey('Escape', fakeDocument.body);
      await settle();
      assert(byRole(m.container, 'dialog').length === 0 && pickedShown(m), 'Escape from outside closed only the sheet');
      assert(fakeDocument.activeElement === row, `focus back on the row: ${name(fakeDocument.activeElement)}`);
      assert(trap().length === 0, `the trap's listeners left: ${trap().length}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#59b the sheet\'s Tab loop is the tabbable selector: a disabled button, a hidden input and a tabindex=-1 element are skipped; a tabindex=0 div and a link with an href are in', () => {
    resetHome();
    const m = mount(
      createElement(SheetProbe, { label: 'Probe', closeLabel: 'Close', onClose: noop }, [
        createElement('button', { key: 'd', disabled: true }, 'Disabled'),
        createElement('input', { key: 'h', type: 'hidden' }),
        createElement('div', { key: 'n', tabIndex: -1 }, 'Skipped'),
        createElement('div', { key: 'z', tabIndex: 0 }, 'Zero'),
        createElement('a', { key: 'a', href: '#x' }, 'Link'),
      ]),
    );
    try {
      const all = elements(m.container);
      const zero = all.find((e) => e.textContent === 'Zero') as FakeElement;
      const link = all.find((e) => e.localName === 'a') as FakeElement;
      const close = all.find((e) => e.localName === 'button' && e.textContent === 'Close') as FakeElement;
      assert(zero && link && close, 'the probe controls render');
      close.focus();
      m.key(close, 'Tab');
      assert(fakeDocument.activeElement === zero, `Tab from Close: ${String((fakeDocument.activeElement as FakeElement)?.textContent)}`);
      m.key(zero, 'Tab', { shiftKey: true });
      assert(fakeDocument.activeElement === close, 'Shift+Tab from the first control goes to Close');
      const found = (elements(m.container).find((e) => e.getAttribute('role') === 'dialog') as FakeElement).querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex^="-"])',
      );
      assert(show(found.map((e) => e.textContent)) === show(['Zero', 'Link', 'Close']), `tabbables: ${show(found.map((e) => e.textContent))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#59c two sheets at once: only the top one traps focus and answers an outside Escape (no ping-pong); when it goes, the lower one\'s trap works again', () => {
    resetHome();
    const closed: string[] = [];
    const sheet = (label: string) => createElement(SheetProbe, { label, closeLabel: 'Close', onClose: () => void closed.push(label) }, createElement('button', { type: 'button' }, `In ${label}`));
    const focusIn = (target: FakeNode) => React.act(() => docListeners.filter((l) => l.type === 'focusin').forEach((l) => l.fn({ type: 'focusin', target })));
    const docKey = (key: string, target: FakeNode) => React.act(() => docListeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn({ type: 'keydown', key, target, preventDefault: noop })));
    const lower = mount(sheet('lower'));
    const upper = mount(sheet('upper'));
    try {
      const panelOf = (m: Mounted) => elements(m.container).find((e) => e.getAttribute('role') === 'dialog') as FakeElement;
      const lowerPanel = panelOf(lower);
      const upperPanel = panelOf(upper);
      const pulls = new Map<FakeElement, number>();
      for (const p of [lowerPanel, upperPanel]) {
        const focus = p.focus.bind(p);
        p.focus = () => {
          pulls.set(p, (pulls.get(p) ?? 0) + 1);
          focus();
        };
      }
      const inLower = elements(lowerPanel).find((e) => e.localName === 'button' && e.textContent === 'In lower') as FakeElement;
      inLower.focus();
      focusIn(inLower);
      assert((pulls.get(lowerPanel) ?? 0) === 0 && (pulls.get(upperPanel) ?? 0) <= 1, `pulls: lower ${pulls.get(lowerPanel) ?? 0}, upper ${pulls.get(upperPanel) ?? 0}`);
      assert(fakeDocument.activeElement === upperPanel, 'focus went to the top sheet');
      docKey('Escape', fakeDocument.body);
      assert(show(closed) === show(['upper']), `Escape from outside closed: ${show(closed)}`);
      upper.unmount();
      pulls.clear();
      inLower.focus();
      const body = fakeDocument.body as FakeNode;
      focusIn(body);
      assert(pulls.get(lowerPanel) === 1 && fakeDocument.activeElement === lowerPanel, 'the lower sheet\'s trap works once the top one is gone');
      closed.length = 0;
      docKey('Escape', body);
      assert(show(closed) === show(['lower']), `Escape then: ${show(closed)}`);
    } finally {
      lower.unmount();
    }
  });

  await check('#60 React logged no warning in #43-#59 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeMonth, `warnings: ${show(reactWarnings.slice(warnedBeforeMonth, warnedBeforeMonth + 5))}`);
  });

  await check('#61 each row starts with a stripe in its calendar\'s colour (spec 2026-10-19 §3.3): solid for the viewer\'s item, hollow (is-partner) for the partner\'s, with has-cal and the calendar\'s tones for both looks inline (calendarVars); a masked calendar (color null) keeps today\'s tones, with no style; the "Still open" rows have one too; decorative', () => {
    const week = famcalWeek();
    const html = renderAgenda('en', week);
    const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripeOf = (markup: string, title: string) => {
      const m = new RegExp(`<button type="button" class="ch-row ch-tap[^"]*"><span class="(ch-stripe[^"]*)"(?: style="([^"]*)")? aria-hidden="true"></span>(?:(?!</button>).)*?<span class="ch-title" dir="auto">${escaped(title)}</span>`).exec(markup);
      assert(m, `no stripe on ${show(title)}`);
      return { cls: m[1], style: m[2] ?? null };
    };
    const styleOf = (vars: Readonly<Record<string, string>>) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
    const seen = new Set<string>();
    const wanted = (row: AgendaRow) => {
      const vars = calendarVars(row.item.calendar.color);
      return { cls: `ch-stripe${row.whose.mine ? '' : ' is-partner'}${vars ? ' has-cal' : ''}`, style: vars ? styleOf(vars) : null };
    };
    for (const key of ['famcal|dentist', 'famcal|football', 'famcal|parcel']) {
      const row = rowOf(week, key);
      const want = wanted(row);
      const got = stripeOf(html, row.item.title ?? '');
      assert(show(got) === show(want), `${key}: ${show(got)}, wanted ${show(want)}`);
      seen.add(want.cls);
    }
    // A partner's event on a masked calendar: hollow in today's partner tone, no style.
    const masked = model([ok(answer({ items: { [day(0)]: [item('private', { title: 'Private appointment', start: at(0, '15:00'), end: at(0, '16:00'), calendar: MASKED })] } }))]);
    const maskedRow = rowOf(masked, 'famcal|private');
    const maskedWant = wanted(maskedRow);
    assert(show(maskedWant) === show({ cls: 'ch-stripe is-partner', style: null }), `the masked case: ${show(maskedWant)}`);
    assert(show(stripeOf(renderAgenda('en', masked), 'Private appointment')) === show(maskedWant), 'the masked partner stripe');
    seen.add(maskedWant.cls);
    assert(show([...seen].sort()) === show(['ch-stripe', 'ch-stripe has-cal', 'ch-stripe is-partner', 'ch-stripe is-partner has-cal']), `the cases covered: ${show([...seen])}`);
    const rows = html.match(/<button type="button" class="ch-row ch-tap[^"]*">/g) ?? [];
    const striped = html.match(/<button type="button" class="ch-row ch-tap[^"]*"><span class="ch-stripe/g) ?? [];
    assert(rows.length > 5 && striped.length === rows.length, `${striped.length} of ${rows.length} rows striped`);
    // Each "Still open" row's stripe is its own calendar's, solid or hollow by whose it is.
    const card = html.slice(html.indexOf('class="ch-card"'), html.indexOf('class="ch-days"'));
    const shown = week.stillOpen?.shown ?? [];
    assert(shown.length === 5 && (card.match(/<span class="ch-stripe/g) ?? []).length === shown.length, 'every "Still open" row has its stripe');
    for (const row of shown) {
      const got = stripeOf(card, row.item.title ?? '');
      assert(show(got) === show(wanted(row)), `card ${row.item.key}: ${show(got)}, wanted ${show(wanted(row))}`);
    }
  });

  await check('#62 the "Google · <calendar>" chip in its calendar\'s colour, as a Month chip: has-cal with the calendar\'s tones inline, filled for the viewer\'s calendar, outlined (is-partner) for the spouse\'s; no usable colour keeps the grey outline with no style; the CSS fills the viewer\'s with --cal-fill under --cal-text and outlines the partner\'s in --cal-line', () => {
    const styleOf = (color: string | null) => {
      const vars = calendarVars(color);
      return vars ? Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';') : null;
    };
    const PLAIN = item('plain', { source: 'google', readOnly: true, tz: null, title: 'Plain', start: '2026-10-15T12:00:00+03:00', end: '2026-10-15T13:00:00+03:00', calendar: { ...G_FAMILY, color: null }, htmlLink: null, birthday: false });
    const html = renderAgenda('en', model([ok(googleAnswer({ items: { [day(0)]: [DINNER, PLAIN], [day(1)]: [YOGA] } }))]));
    const chips = [...html.matchAll(/<span class="(ch-chip ch-chip-outline ch-cal-chip[^"]*)"(?: style="([^"]*)")? dir="auto">([^<]*)<\/span>/g)].map((m) => ({ cls: m[1], style: m[2] ?? null, text: m[3] }));
    // In time order: Plain (12:00), then Dinner (19:30); Yoga the next day.
    const want = [
      { cls: 'ch-chip ch-chip-outline ch-cal-chip', style: null, text: 'Google · Family' },
      { cls: 'ch-chip ch-chip-outline ch-cal-chip has-cal', style: styleOf(G_FAMILY.color), text: 'Google · Family' },
      { cls: 'ch-chip ch-chip-outline ch-cal-chip is-partner has-cal', style: styleOf(G_NOA.color), text: 'Google · Noa' },
    ];
    assert(show(chips) === show(want), `chips: ${show(chips)}`);
    const rule = (selector: string) => {
      const at = AGENDA_CSS.indexOf(`${selector} {`);
      return at < 0 ? '' : AGENDA_CSS.slice(at, AGENDA_CSS.indexOf('}', at));
    };
    assert(/border-color: var\(--cal-fill\);\s*background: var\(--cal-fill\);\s*color: var\(--cal-text\);/.test(rule('.ch-cal-chip.has-cal')), 'the viewer\'s: filled');
    assert(/border-color: var\(--cal-line\);\s*background: transparent;/.test(rule('.ch-cal-chip.has-cal.is-partner')), 'the partner\'s: outlined, its text still --cal-text');
  });

  await check('#63 the item sheet\'s Calendar line: a masked calendar with no partner name reads "Private calendar" (never empty or "\'s calendar"); with a name it reads as before', () => {
    const generic = { en: 'Private calendar', he: 'יומן פרטי', ru: 'Личный календарь' } as const;
    const named = { en: 'Noa’s calendar', he: 'היומן של Noa', ru: 'Noa (личный)' } as const;
    // The first fact in the sheet is the calendar's: its <dd>.
    const calendarLine = (html: string) => /<dl[^>]*>\s*<div[^>]*><dt>[^<]*<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/.exec(html)?.[1] ?? '';
    for (const locale of ['en', 'he', 'ru'] as const) {
      for (const [kind, cal] of [['reminder', { ...MASKED, name: '' }], ['event', { ...MASKED, name: '  ' }]] as const) {
        const one = item('masked', { kind: kind === 'reminder' ? 'reminder' : 'event', title: 'Masked', start: at(0, '15:00'), calendar: cal });
        const row = rowOf(model([ok(answer({ items: { [day(0)]: [one] } }))]), 'famcal|masked');
        const line = textOf(calendarLine(renderSheet(locale, row)));
        assert(line === generic[locale], `${locale} ${kind}: ${show(line)}`);
      }
      const noa = rowOf(model([ok(answer({ items: { [day(0)]: [item('noa', { title: 'Noa', start: at(0, '15:00'), calendar: MASKED })] } }))]), 'famcal|noa');
      const line = textOf(calendarLine(renderSheet(locale, noa)));
      assert(line === named[locale], `${locale} named: ${show(line)}`);
    }
  });

  await check('#64 a description is never linkified: javascript:, data:, vbscript:, markup and a plain https URL all stay verbatim text, and the sheet has no anchor (only the Google button, a <button>)', () => {
    const notes = ['click (javascript:alert(1))', '<a href="javascript:alert(1)">x</a>', 'data:text/html,<script>', 'vbscript:msgbox(1)', 'https://example.com'];
    for (const description of notes) {
      const one = item('desc', { title: 'Desc', start: at(0, '15:00'), description });
      const row = rowOf(model([ok(answer({ items: { [day(0)]: [one] } }))]), 'famcal|desc');
      const html = markup(renderSheet('en', row));
      assert(!/<a[\s>]/i.test(html) && !/ href="/i.test(html), `${show(description)}: has a link`);
      assert(textOf(html).includes(spaces(description)), `${show(description)}: not shown verbatim`);
    }
    const google = rowOf(googleWeek(), DINNER.key);
    const html = markup(renderSheet('en', google));
    assert(!/<a[\s>]/i.test(html) && /<button[^>]*>Open in Google Calendar/.test(html), 'the Google link is a button');
  });

  await check('#65 the Send sheet shows the weeks\' dates after This week / Next week (the bot\'s bounds, from today, the week start and always-7), en/he/ru; none for This week while always-7 is unknown, none at all before the facts are pinned', () => {
    const sheet = (locale: Locale, o: { today?: DayKey | null; weekStart?: WeekStart | null; lookahead7?: boolean }) =>
      textOf(renderToString(inHome(locale, createElement(SendSheet, { userId: 7, locale, onClose: noop, ...o }))));
    // Monday 19 Oct 2026, weeks from Sunday: this week to Saturday the 24th, next week 25-31.
    const pinned = { today: '2026-10-19' as DayKey, weekStart: 0 as WeekStart, lookahead7: false };
    const span = (locale: Locale, a: DayKey, b: DayKey) =>
      new Intl.DateTimeFormat({ en: 'en-GB', he: 'he-IL', ru: 'ru-RU' }[locale], { day: 'numeric', month: 'short', timeZone: 'UTC' }).formatRange(new Date(`${a}T12:00:00Z`), new Date(`${b}T12:00:00Z`));
    const titles = (locale: Locale) => messages[locale].calendarHome.send as { thisWeek: string; nextWeek: string };
    for (const locale of ['en', 'he', 'ru'] as const) {
      const { thisWeek, nextWeek } = titles(locale);
      assertHas(sheet(locale, pinned), [`${thisWeek} · ${span(locale, '2026-10-19', '2026-10-24')}`, `${nextWeek} · ${span(locale, '2026-10-25', '2026-10-31')}`], locale);
    }
    assert(spaces(span('en', '2026-10-19', '2026-10-24')).replace(/\s/g, '') === '19–24Oct', `en range: ${span('en', '2026-10-19', '2026-10-24')}`);
    assertHas(sheet('en', { ...pinned, lookahead7: true }), [`This week · ${span('en', '2026-10-19', '2026-10-26')}`], 'always 7');
    const unknown = sheet('en', { today: pinned.today, weekStart: 0 });
    assertHas(unknown, ['This week', `Next week · ${span('en', '2026-10-25', '2026-10-31')}`], 'unknown always-7');
    assertLacks(unknown, ['This week ·'], 'unknown always-7');
    assertLacks(sheet('en', {}), [' · '], 'before the facts');
    assertLacks(sheet('en', { today: null, weekStart: null, lookahead7: false }), [' · '], 'null facts');
  });

  // ---- Reminder actions in the item sheet (reminder-actions spec §1, §4, §5, §6) ----

  const warnedBeforeActions = reactWarnings.length;

  const ACT = (o: Partial<ItemReminderDTO> = {}, extra: Partial<ItemDTO> = {}) =>
    item('act', { kind: 'reminder', title: 'Act on me', seriesId: 'series_act', start: at(0, '13:00'), reminder: rem(o), ...extra });
  const sheetWith = (locale: Locale, it: ItemDTO, actions?: SheetActions) => {
    const row = rowOf(model([ok(it.source === 'google' ? googleAnswer({ items: { [day(0)]: [it] } }) : answer({ items: { [day(0)]: [it] } }))]), it.key);
    return renderToString(inHome(locale, createElement(ItemSheet, { row, today: TODAY, tz: TZ, onClose: noop, actions })));
  };
  // 14:00 in Jerusalem: ACT's 13:00 is due. EARLY is 12:00, before it.
  const IDLE: SheetActions = { busy: false, pending: null, note: null, now: Date.parse('2026-10-15T11:00:00Z'), onAction: noop };
  const EARLY: SheetActions = { ...IDLE, now: Date.parse('2026-10-15T09:00:00Z') };
  const buttonsIn = (html: string) => [...markup(html).matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], text: textOf(m[2]) }));
  const actionTexts = (locale: Locale, html: string) => buttonsIn(html).map((b) => b.text).filter((t) => t !== messages[locale].calendarHome.actions.close);
  const labelsOf = (locale: Locale) => messages[locale].calendarHome.sheet.actions as Record<'done' | 'undo' | 'snoozeLabel' | 'snooze15' | 'snooze60' | 'snoozeTomorrow', string>;

  await check('#66 the sheet\'s actions by state and by who views, en/he/ru: Done + Snooze 15 min / 1 hour / Tomorrow while open or snoozed, Done alone before it is due, Not done once done; only for the owner or the creator; none on events, Google items, a reminder with no series, or without the container\'s actions; no untranslated key', () => {
    for (const locale of LOCALES) {
      const l = labelsOf(locale);
      const all = [l.done, l.snooze15, l.snooze60, l.snoozeTomorrow];
      const open = sheetWith(locale, ACT({ open: true }), IDLE);
      assert(show(actionTexts(locale, open)) === show(all), `${locale} open: ${show(actionTexts(locale, open))}`);
      assert(show(actionTexts(locale, sheetWith(locale, ACT({ open: true, snoozedUntil: at(0, '15:30') }), IDLE))) === show(all), `${locale} snoozed`);
      assert(show(actionTexts(locale, sheetWith(locale, ACT(), EARLY))) === show([l.done]), `${locale} not due yet: Done alone`);
      assert(show(actionTexts(locale, sheetWith(locale, ACT({ done: true, doneAt: at(0, '12:00') }), IDLE))) === show([l.undo]), `${locale} done: Not done alone`);
      assertHas(textOf(open), [l.snoozeLabel], `${locale} the Snooze label`);
      assert(/role="group"/.test(open) && open.includes(`aria-label="${l.snoozeLabel}"`), `${locale}: the snooze row is a labelled group`);
      assertLacks(textOf(open), ['sheet.actions', 'actionNotes', 'calendarHome.'], `${locale} untranslated key`);
      if (locale !== 'en') assert(l.done !== labelsOf('en').done && l.snooze60 !== labelsOf('en').snooze60, `${locale}: copy is translated`);
    }
    const none = (what: string, it: ItemDTO, given: SheetActions | null = IDLE) => {
      const actions = given ?? undefined;
      const names = actionTexts('en', sheetWith('en', it, actions));
      assert(names.length === 0 || names.every((n) => n === 'Open in Google Calendar'), `${what}: ${show(names)}`);
      assertLacks(textOf(sheetWith('en', it, actions)), ['Snooze'], what);
    };
    const yes = (what: string, it: ItemDTO) => assert(actionTexts('en', sheetWith('en', it, IDLE)).includes('Done'), `${what}: no Done`);
    yes('the owner and creator', ACT({ open: true }));
    yes('the owner, made by Noa', ACT({ open: true, creatorIsViewer: false, creatorName: 'Noa' }));
    yes('the creator, for Noa', ACT({ open: true, ownerIsViewer: false, ownerName: 'Noa' }, { calendar: NOA_CAL }));
    none('neither owner nor creator', ACT({ open: true, ownerIsViewer: false, creatorIsViewer: false, ownerName: 'Noa' }, { calendar: NOA_CAL }));
    none('an event', item('ev', { title: 'Event', start: at(0, '13:00'), seriesId: 'series_ev' }));
    none('a Google item', DINNER);
    none('a reminder with no series', ACT({ open: true }, { seriesId: null }));
    none('no actions from the container', ACT({ open: true }), null);
    // The CSS: the buttons are the home's ch-btn (44 px), Done 48 px; nothing under 11 px; no hover; logical properties.
    assert(/\.ch-btn \{[^}]*min-height: 44px/.test(HOME_THEME_CSS), 'ch-btn is 44 px');
    assert(/\.ch-sheet-action \{[^}]*min-height: 48px/.test(AGENDA_CSS), 'Done is 48 px');
    const mine = AGENDA_CSS.slice(AGENDA_CSS.indexOf('.ch-actions {'));
    assert(!/:hover/.test(mine) && !/\b(margin|padding)-(left|right|top|bottom)\b|\b(left|right):/.test(mine), 'no hover, no physical property');
    assert([...mine.matchAll(/font-size: (\d+)px/g)].every((m) => Number(m[1]) >= 11), 'nothing under 11 px');
  });

  await check('#67 in flight, every action button is disabled and the tapped one alone has the spinner; the four notes show, role=status, in en/he/ru and none without a note', () => {
    for (const locale of LOCALES) {
      const html = sheetWith(locale, ACT({ open: true }), { ...IDLE, busy: true, pending: 'snooze60' });
      const l = labelsOf(locale);
      const acts = buttonsIn(html).filter((b) => [l.done, l.snooze15, l.snooze60, l.snoozeTomorrow].includes(b.text));
      assert(acts.length === 4 && acts.every((b) => /\bdisabled=""/.test(b.attrs)), `${locale}: all four disabled`);
      const busy = acts.filter((b) => /aria-busy="true"/.test(b.attrs));
      assert(busy.length === 1 && busy[0].text === l.snooze60, `${locale}: spinner on the tapped one: ${show(busy)}`);
      assert((markup(html).match(/ch-spinner/g) ?? []).length === 1, `${locale}: one spinner`);
      const idle = sheetWith(locale, ACT({ open: true }), IDLE);
      assert(!/disabled=""/.test(buttonsIn(idle).filter((b) => b.text === l.done)[0].attrs) && !idle.includes('ch-spinner'), `${locale}: idle`);
      assert(!/role="status"/.test(idle), `${locale}: no note, no status`);
      for (const note of ['changed', 'alreadyDone', 'notYours', 'failed'] as const) {
        const text = messages[locale].calendarHome.sheet.actionNotes[note] as string;
        const html2 = sheetWith(locale, ACT({ open: true }), { ...IDLE, note });
        assert(new RegExp(`<p class="ch-sheet-note" role="status">${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`).test(html2.replace(/&#x27;/g, "'")), `${locale} ${note}: ${show(textOf(html2).slice(0, 300))}`);
      }
    }
  });

  // The server, as the home sees it: the range route serves `live`; the reminder route answers `reminderReply`.
  const FORM2 = item('form2', { kind: 'reminder', title: 'Send the form', seriesId: 'series_form2', start: at(0, '13:00'), reminder: rem({ open: true }) });
  const form2 = (r: Partial<ItemReminderDTO> = {}): ItemDTO => ({ ...FORM2, reminder: rem({ open: true, ...r }) });
  const DONE_AT = at(0, '13:05');
  const doneReminder = rem({ done: true, doneAt: DONE_AT, open: false });
  let live: { items: Record<DayKey, ItemDTO[]>; carry: ItemDTO[] } = { items: {}, carry: [] };
  let reminderReply: (c: FetchCall) => FetchAnswer | Promise<FetchAnswer> = () => ({ status: 500 });
  let rangeGate: Promise<void> | null = null;
  const reminderCalls = () => fetchCalls.filter((c) => c.path === '/api/calendar/reminder');
  const serveReminders = () => {
    answerFetch = async (c) => {
      if (c.path === '/api/calendar/reminder') return reminderReply(c);
      if (rangeGate) await rangeGate;
      return answerFor(c, { items: live.items, carryOvers: live.carry });
    };
  };
  const gate = () => {
    let release: (v: FetchAnswer) => void = noop;
    const promise = new Promise<FetchAnswer>((resolve) => (release = resolve));
    return { promise, release };
  };
  const dialogButtons = (m: Home) => elements(byRole(m.container, 'dialog')[0]).filter((e) => e.localName === 'button').map((e) => e.textContent);
  const dialogButton = (m: Home, text: string) => {
    const found = elements(byRole(m.container, 'dialog')[0]).filter((e) => e.localName === 'button' && e.textContent.includes(text));
    assert(found.length === 1, `no single ${show(text)} button in the dialog: ${show(dialogButtons(m))}`);
    return found[0];
  };
  const stillOpenText = (m: Home) => byClass(m.container, 'ch-card')[0]?.textContent ?? '';

  await check('#68 a tap on Done in the Agenda: the request carries the init data (header and body) and the page\'s user_id; buttons are disabled with a spinner while it flies; the answer patches the sheet, the row and the Still open card before the refetch returns; then undo and snooze; a haptic success after done only, on a 6.1+ client', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    live = { items: { [day(0)]: [form2()] }, carry: [] };
    serveReminders();
    const m = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      assertHas(stillOpenText(m), ['Send the form'], 'the card has it');
      m.click(button(m.container, 'Send the form'));
      assertHas(dialogText(m.container), ['Not done yet'], 'the sheet');
      assert(show(dialogButtons(m)) === show(['Done', '15 min', '1 hour', 'Tomorrow', 'Close']) || dialogButtons(m).slice(0, 4).join() === 'Done,15 min,1 hour,Tomorrow', `buttons: ${show(dialogButtons(m))}`);

      const first = gate();
      reminderReply = () => first.promise;
      m.click(dialogButton(m, 'Done'));
      await settle();
      assert(reminderCalls().length === 1, `one request: ${reminderCalls().length}`);
      const post = reminderCalls()[0];
      assert(post.method === 'POST' && post.headers['Content-Type'] === 'application/json', `method and type: ${post.method}`);
      assert(post.headers['X-Telegram-Init-Data'] === tg.webApp.initData, 'the init data rides in the header');
      assert(show(post.body) === show({ user_id: 5550001, seriesId: 'series_form2', originalStart: FORM2.originalStart, action: 'done', initData: tg.webApp.initData }), `body: ${show(post.body)}`);
      assert(post.credentials === 'same-origin', 'same-origin credentials');
      const dlg = byRole(m.container, 'dialog')[0];
      const acts = elements(dlg).filter((e) => e.localName === 'button' && !['Close'].includes(e.textContent));
      assert(acts.length >= 4 && acts.slice(0, 4).every((e) => e.hasAttribute('disabled')), 'all four disabled in flight');
      assert(byClass(dlg, 'ch-spinner').length === 1 && byClass(acts[0], 'ch-spinner').length === 1, 'the spinner is on Done alone');
      m.click(acts[1]);
      await settle();
      assert(reminderCalls().length === 1, 'a tap on a disabled button sends nothing');

      // The refetch is held back: the patch alone must already show the new state.
      const hold = gate();
      rangeGate = hold.promise.then(noop);
      const before = rangeCalls().length;
      await React.act(async () => first.release(ok200({ status: 'ok', reminder: doneReminder })));
      await settle();
      assert(rangeCalls().length === before + 1 && rangeCalls().at(-1)?.query.get('sources') === 'famcal', `the confirming refetch is FamCal's: ${show(ranges().slice(before))}`);
      assertHas(dialogText(m.container), ['Done at 13:05'], 'the sheet at once');
      assert(show(dialogButtons(m).filter((t) => t !== 'Close')) === show(['Not done']), `only Not done: ${show(dialogButtons(m))}`);
      assert(!stillOpenText(m).includes('Send the form'), 'the card dropped it at once');
      assert(byClass(m.container, 'ch-row').some((r) => r.className.includes('is-done') && r.textContent.includes('Send the form')), 'the row is struck');
      assert(show(tg.calls.filter((c) => c.startsWith('haptic'))) === show(['haptic(success)']), `haptic: ${show(tg.calls)}`);
      live = { items: { [day(0)]: [form2({ done: true, doneAt: DONE_AT, open: false })] }, carry: [] };
      rangeGate = null;
      hold.release({ status: 200 });
      await settle();
      assertHas(dialogText(m.container), ['Done at 13:05'], 'still done after the refetch confirms');

      // Undo: back to open, on the card again; no haptic.
      reminderReply = () => ok200({ status: 'ok', reminder: rem({ open: true }) });
      live = { items: { [day(0)]: [form2()] }, carry: [] };
      m.click(dialogButton(m, 'Not done'));
      await settle();
      assert(reminderCalls()[1].body?.action === 'undo', 'undo posted');
      assertHas(dialogText(m.container), ['Not done yet'], 'undone');
      assertHas(stillOpenText(m), ['Send the form'], 'back on the card');

      // Snooze: "Snoozed until 14:30", still open.
      const until = at(0, '14:30');
      reminderReply = () => ok200({ status: 'ok', reminder: rem({ open: true, snoozedUntil: until }) });
      live = { items: { [day(0)]: [form2({ snoozedUntil: until })] }, carry: [] };
      m.click(dialogButton(m, '15 min'));
      await settle();
      assert(reminderCalls()[2].body?.action === 'snooze15', 'snooze posted');
      assertHas(dialogText(m.container), ['Snoozed until 14:30'], 'snoozed');
      assertHas(stillOpenText(m), ['Send the form'], 'a snoozed past-due item stays on the card');
      reminderReply = () => ok200({ status: 'ok', reminder: rem({ open: true, snoozedUntil: at(1, '09:00') }) });
      m.click(dialogButton(m, 'Tomorrow'));
      await settle();
      assert(show(reminderCalls().map((c) => c.body?.action)) === show(['done', 'undo', 'snooze15', 'snoozeTomorrow']), `actions: ${show(reminderCalls().map((c) => c.body?.action))}`);
      assert(tg.calls.filter((c) => c.startsWith('haptic')).length === 1, 'haptic after done only');
    } finally {
      m.unmount();
    }

    // An old client has no haptics (6.0): nothing is called, nothing throws.
    resetHome();
    const old = fakeTelegramHome({ version: '6.0' });
    fakeWindow.Telegram = { WebApp: old.webApp };
    live = { items: { [day(0)]: [form2()] }, carry: [] };
    serveReminders();
    reminderReply = () => {
      live = { items: { [day(0)]: [form2({ done: true, doneAt: DONE_AT, open: false })] }, carry: [] };
      return ok200({ status: 'ok', reminder: doneReminder });
    };
    const o = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      o.click(button(o.container, 'Send the form'));
      o.click(dialogButton(o, 'Done'));
      await settle();
      assertHas(dialogText(o.container), ['Done at 13:05'], '6.0 client, done');
      assert(old.calls.every((c) => !c.startsWith('haptic')), `no haptic on 6.0: ${show(old.calls)}`);
    } finally {
      o.unmount();
    }
  });

  await check('#69 a tap that cannot apply: changed and not_yours show their note and only refetch; already_done shows its note with the new state; a 500, a 429, no answer and a garbled body show "Couldn\'t save. Try again." with the state unchanged and the buttons live again; the note goes with the next tap, and in en/he/ru', async () => {
    const tryReply = async (locale: Locale, reply: FetchAnswer | 'throw', truth: ItemDTO = form2()) => {
      resetHome();
      fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
      live = { items: { [day(0)]: [form2()] }, carry: [] };
      serveReminders();
      reminderReply = () => {
        live = { items: { [day(0)]: [truth] }, carry: [] };
        return reply;
      };
      const m = await mountHome(locale, {}, fakeClock('2026-10-15T10:00:00Z'));
      const rowName = 'Send the form';
      m.click(button(m.container, rowName));
      const l = labelsOf(locale);
      const before = rangeCalls().length;
      m.click(dialogButton(m, l.done));
      await settle();
      return { m, l, before, notes: messages[locale].calendarHome.sheet.actionNotes as Record<SheetNoteName, string> };
    };
    type SheetNoteName = 'changed' | 'alreadyDone' | 'notYours' | 'failed';
    for (const locale of LOCALES) {
      for (const [status, note] of [['changed', 'changed'], ['not_yours', 'notYours']] as const) {
        const { m, l, before, notes } = await tryReply(locale, ok200({ status }));
        try {
          assertHas(dialogText(m.container), [notes[note]], `${locale} ${status}`);
          assert(rangeCalls().length === before + 1 && rangeCalls().at(-1)?.query.get('sources') === 'famcal', `${locale} ${status}: only a FamCal refetch`);
          assertHas(dialogText(m.container), [messages[locale].calendarHome.sheet.stateOpen], `${locale} ${status}: the state is as it was`);
          assert(dialogButtons(m).includes(l.done), `${locale} ${status}: the item is still there, so the sheet stays`);
        } finally {
          m.unmount();
        }
      }
      const done = await tryReply(locale, ok200({ status: 'already_done', reminder: doneReminder }), form2({ done: true, doneAt: DONE_AT, open: false }));
      try {
        assertHas(dialogText(done.m.container), [done.notes.alreadyDone, done.l.undo], `${locale} already_done`);
      } finally {
        done.m.unmount();
      }
      for (const [what, reply] of [['500', { status: 500, body: { error: 'internal_error' } }], ['429', { status: 429 }], ['no answer', 'throw'], ['garbled', ok200({ nope: true })], ['unknown status', ok200({ status: 'weird' })]] as const) {
        const f = await tryReply(locale, reply);
        try {
          assertHas(dialogText(f.m.container), [f.notes.failed, messages[locale].calendarHome.sheet.stateOpen], `${locale} ${what}`);
          assert(rangeCalls().length === f.before, `${locale} ${what}: no refetch`);
          assert(!dialogButtons(f.m).includes(f.l.undo) && f.m.container && !elements(byRole(f.m.container, 'dialog')[0]).some((e) => e.localName === 'button' && e.hasAttribute('disabled')), `${locale} ${what}: buttons live again`);
          // The next tap clears the note while it flies.
          const hold = gate();
          reminderReply = () => hold.promise;
          f.m.click(dialogButton(f.m, f.l.snooze15));
          await settle();
          assertLacks(dialogText(f.m.container), [f.notes.failed], `${locale} ${what}: the note goes with the next tap`);
          hold.release({ status: 500 });
          await settle();
        } finally {
          f.m.unmount();
        }
      }
    }
  });

  await check('#70 an item the store no longer holds: "changed" shows its note, the answer without it leaves the sheet up for GONE_NOTE_MS, then it closes; with the item still there it stays', async () => {
    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    live = { items: { [day(0)]: [form2()] }, carry: [] };
    serveReminders();
    reminderReply = () => ok200({ status: 'changed' });
    const clock = fakeClock('2026-10-15T10:00:00Z');
    const m = await mountHome('en', {}, clock);
    try {
      m.click(button(m.container, 'Send the form'));
      live = { items: {}, carry: [] };
      m.click(dialogButton(m, 'Done'));
      await settle();
      assertHas(dialogText(m.container), ['This reminder changed. The calendar is up to date now.', 'Send the form'], 'the note over the last known item');
      await clock.advance(GONE_NOTE_MS - 100);
      assert(byRole(m.container, 'dialog').length === 1, 'still up just before');
      await clock.advance(200);
      assert(byRole(m.container, 'dialog').length === 0, 'closed after the note');
      assertLacks(m.text(), ['Send the form'], 'the home no longer lists it');
    } finally {
      m.unmount();
    }

    // Still there: no close, however long.
    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    live = { items: { [day(0)]: [form2()] }, carry: [] };
    serveReminders();
    reminderReply = () => ok200({ status: 'changed' });
    const c2 = fakeClock('2026-10-15T10:00:00Z');
    const k = await mountHome('en', {}, c2);
    try {
      k.click(button(k.container, 'Send the form'));
      k.click(dialogButton(k, 'Done'));
      await settle();
      await c2.advance(GONE_NOTE_MS * 4);
      assert(byRole(k.container, 'dialog').length === 1, 'the sheet stays while the item is there');
    } finally {
      k.unmount();
    }
  });

  await check('#71 the open sheet re-derives from the store by key: a foreground refetch that brings the reminder done by someone else changes the sheet with no tap; a carry-over marked done leaves the card, and the sheet keeps its done state (and its Not done) after the refetch drops it', async () => {
    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    live = { items: { [day(0)]: [form2()] }, carry: [] };
    serveReminders();
    const m = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      m.click(button(m.container, 'Send the form'));
      assertHas(dialogText(m.container), ['Not done yet'], 'before');
      live = { items: { [day(0)]: [form2({ done: true, doneAt: DONE_AT, open: false, ownerIsViewer: true })] }, carry: [] };
      await fireDocument('visibilitychange');
      await settle();
      assertHas(dialogText(m.container), ['Done at 13:05'], 'the sheet followed the store');
      assert(dialogButtons(m).includes('Not done') && !dialogButtons(m).includes('Done'), `and its actions: ${show(dialogButtons(m))}`);
    } finally {
      m.unmount();
    }

    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    const carry = item('passport', { kind: 'reminder', title: 'Renew the passport', seriesId: 'series_pp', start: at(-3, '10:00'), reminder: rem({ open: true, openSince: day(-3) }) });
    live = { items: {}, carry: [carry] };
    serveReminders();
    reminderReply = () => ok200({ status: 'ok', reminder: rem({ done: true, doneAt: DONE_AT, open: false }) });
    const c = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      assertHas(stillOpenText(c), ['Renew the passport'], 'on the card');
      c.click(button(c.container, 'Renew the passport'));
      live = { items: {}, carry: [] };
      c.click(dialogButton(c, 'Done'));
      await settle();
      assertLacks(stillOpenText(c), ['Renew the passport'], 'off the card');
      assertHas(dialogText(c.container), ['Done at 13:05'], 'the sheet, after the refetch dropped the carry-over');
      assert(dialogButtons(c).includes('Not done'), `Not done is still there to undo: ${show(dialogButtons(c))}`);
      assert(!dialogText(c.container).includes('This reminder changed'), 'no note for a plain done');
      // Undo from the kept row: the answer reopens it, and the sheet shows it with the actions back.
      reminderReply = () => ok200({ status: 'ok', reminder: rem({ open: true, openSince: day(-3) }) });
      live = { items: {}, carry: [carry] };
      c.click(dialogButton(c, 'Not done'));
      await settle();
      assertHas(dialogText(c.container), ['Not done yet'], 'undone');
      assertHas(stillOpenText(c), ['Renew the passport'], 'back on the card');
    } finally {
      c.unmount();
    }
  });

  await check('#72 the Month follows a tap: from a picked day, Done patches the sheet and the day\'s row, and the confirming refetch is FamCal\'s windows', async () => {
    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    live = { items: { [day(0)]: [form2()] }, carry: [] };
    serveReminders();
    const m = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      await openMonth(m);
      await tap(m, dayButton(m, TODAY));
      assert(pickedShown(m), 'picked');
      m.click(button(byClass(m.container, 'ch-mp')[0], 'Send the form'));
      assert(dialogButtons(m).includes('Done'), `actions in picked: ${show(dialogButtons(m))}`);
      reminderReply = () => ok200({ status: 'ok', reminder: doneReminder });
      live = { items: { [day(0)]: [form2({ done: true, doneAt: DONE_AT, open: false })] }, carry: [] };
      const before = rangeCalls().length;
      m.click(dialogButton(m, 'Done'));
      await settle();
      flushFrames();
      await settle();
      assertHas(dialogText(m.container), ['Done at 13:05'], 'the sheet');
      assert(byClass(byClass(m.container, 'ch-mp')[0], 'ch-row').some((r) => r.className.includes('is-done') && r.textContent.includes('Send the form')), 'the picked day\'s row is struck');
      assert(rangeCalls().slice(before).length >= 1 && rangeCalls().slice(before).every((c) => c.query.get('sources') === 'famcal'), `FamCal only: ${show(ranges().slice(before))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#72a the sheet reads the reminder\'s real state, not the row\'s per-day mark: a not-done reminder whose time has passed says "Not done yet" with Done and the snoozes, opened from a past day; one still ahead says "Not due yet" with Done alone, whatever its flag; snoozed is as open', () => {
    const l = labelsOf('en');
    const all = [l.done, l.snooze15, l.snooze60, l.snoozeTomorrow];
    const past = sheetWith('en', ACT({ open: false }), IDLE); // a per-day mark of "later", past its time now
    assertHas(textOf(past), ['Not done yet'], 'past due, state line');
    assert(show(actionTexts('en', past)) === show(all), `past due, actions: ${show(actionTexts('en', past))}`);
    const ahead = sheetWith('en', ACT({ open: true }), EARLY); // a flag of "open", ahead of its time
    assertHas(textOf(ahead), ['Not due yet'], 'ahead, state line');
    assert(show(actionTexts('en', ahead)) === show([l.done]), `ahead, actions: ${show(actionTexts('en', ahead))}`);
    assertHas(textOf(sheetWith('en', ACT({ snoozedUntil: at(0, '15:30') }), EARLY)), ['Snoozed until'], 'snoozed ahead of its time');
    assert(show(actionTexts('en', sheetWith('en', ACT({ snoozedUntil: at(0, '15:30') }), EARLY))) === show(all), 'snoozed: as open');
    assert(show(actionTexts('en', sheetWith('en', ACT({ done: true, doneAt: at(0, '12:00') }), IDLE))) === show([l.undo]), 'done: Not done');
  });

  await check('#72b a past day picked in the Month: its never-done reminder opens as "Not done yet" with Done and the snoozes', async () => {
    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    const old = item('old', { kind: 'reminder', title: 'Old errand', seriesId: 'series_old', start: at(-3, '10:00'), reminder: rem({ open: false }) });
    live = { items: { [day(-3)]: [old] }, carry: [] };
    serveReminders();
    const m = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      await openMonth(m);
      await tap(m, dayButton(m, day(-3)));
      assert(pickedShown(m), 'picked');
      m.click(button(byClass(m.container, 'ch-mp')[0], 'Old errand'));
      assertHas(dialogText(m.container), ['Not done yet'], 'the state line');
      assert(dialogButtons(m).slice(0, 4).join() === 'Done,15 min,1 hour,Tomorrow', `buttons: ${show(dialogButtons(m))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#72c an older range read cannot undo a tap: a Done right after a foreground read stays done when that read answers not done; the confirming refetch is a new request; a late answer of it after a Not done stays undone', async () => {
    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    live = { items: { [day(0)]: [form2()] }, carry: [] };
    serveReminders();
    const m = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      m.click(button(m.container, 'Send the form'));
      const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
      answerFetch = (c) => (c.path === '/api/calendar/reminder' ? Promise.resolve(reminderReply(c)) : new Promise<FetchAnswer>((resolve) => held.push({ call: c, resolve })));
      const release = async (h: (typeof held)[number], truth: ItemDTO) => {
        await React.act(async () => h.resolve(answerFor(h.call, { items: { [day(0)]: [truth] }, carryOvers: [] })));
        await settle();
      };
      fetchCalls.length = 0;
      await fireDocument('visibilitychange');
      await settle();
      const out = () => held.length;
      assert(out() === 1, `the foreground read is out: ${out()}`);
      reminderReply = () => ok200({ status: 'ok', reminder: doneReminder });
      m.click(dialogButton(m, 'Done'));
      await settle();
      assertHas(dialogText(m.container), ['Done at 13:05'], 'patched');
      assert(out() === 2, `the confirming read is a new request, not the one in flight: ${out()}`);
      await release(held[0], form2()); // asked before the tap: not done yet
      assertHas(dialogText(m.container), ['Done at 13:05'], 'the older read did not revert it');
      assert(dialogButtons(m).includes('Not done'), `still undoable: ${show(dialogButtons(m))}`);
      // Not done, while the done read is still out.
      reminderReply = () => ok200({ status: 'ok', reminder: rem({ open: true }) });
      m.click(dialogButton(m, 'Not done'));
      await settle();
      assertHas(dialogText(m.container), ['Not done yet'], 'undone');
      await release(held[1], form2({ done: true, doneAt: DONE_AT, open: false })); // asked before the undo: done
      assertHas(dialogText(m.container), ['Not done yet'], 'the done read did not bring it back');
      await release(held[2], form2());
      assertHas(dialogText(m.container), ['Not done yet'], 'the undo confirmed');
    } finally {
      m.unmount();
    }
  });

  await check('#73 React logged no warning in #66-#72c (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeActions, `React warned: ${show(reactWarnings.slice(warnedBeforeActions, warnedBeforeActions + 3))}`);
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
