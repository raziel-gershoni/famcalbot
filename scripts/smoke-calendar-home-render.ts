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
//  - the Agenda has no setup shape any more (Google as a connection): FamCal is everyone's,
//    so a user still choosing Google calendars sees their FamCal days under the banner;
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
// (R5); the menu (R6); the banners (§7.2), with the Agenda under a Google setup banner;
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
// midnight on the Month; the tab bar for a Google user with no token; no clipping ancestor above the Month; the unavailable-calendars row
// once above the Month; a tab switch from picked and back; Telegram's activated on the
// Month; the item sheet keeping focus over picked.
//
// Editing in the home (home editing spec §2, §4, §6; #74-#87), in real React on the same fake
// DOM, with the editing routes served by a fake (the older checks leave them unserved, so
// the "+" and the pencil never show): the "+" by kinds (events, reminders, both, neither, a
// failed read, a Google user, before the first answer); the editor's defaults for the day in
// view (today at the next round hour for an hour, the Month's picked day), its fields by
// kind, the start moving the end, all day hiding the times, the repeat and calendar choices;
// inline errors, the request bodies (the init data in the header and the body), Save
// disabled and busy in flight and every failure above Save; the item sheet's pencil and
// Delete by permission; the edit prefill and what is shown as text; the scope sheet for
// repeating items only (every choice, Delete's too, "Delete «title»?" for a single one); the
// item sheet following the store after a write; Cancel, the discard question and the
// BackButton; copy in en, he and ru, RTL; the form kit's CSS.
//
// The calendars page's Copy to Google rows (google-sync S4; #119-#125), in real React on the
// same fake DOM with /api/google-sync served by a fake: the rows after the GET, the non-owner
// line and the notes; nothing when the copies don't apply; the load error; turning on (busy,
// the consent wait, Open Google through openLink, or on at once); turning off with Remove/Keep;
// a calendar delete asking first; each state's action; progress. The rows' copy and CSS are
// in smoke-calendars-google-copy.ts.
//
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under three clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-home-render.ts

// The views first: the import-rule checks walk what these load.
import CalendarHome, { CalendarHomeContainer, DRAG_BAR_MS, GONE_NOTE_MS, HOME_TOP_CSS, type HomeDeps } from '../app/[locale]/dashboard/CalendarHome';
import { AgendaView, AGENDA_CSS, type AgendaViewProps } from '../app/[locale]/dashboard/AgendaView';
import { ItemSheet, type SheetActions } from '../app/[locale]/dashboard/ItemSheet';
import { FORM_CSS } from '../app/[locale]/dashboard/form-kit';
import { DRAG_CSS, OVERLAY_CLASS, LIFT_DELAY_MS, LIFT_TOLERANCE_PX, MOUSE_DISTANCE_PX, NAV_DWELL_MS } from '../app/[locale]/dashboard/DragSurface';
import { DRAG_BAR_CSS, DragBar } from '../app/[locale]/dashboard/DragBar';
import { REPEAT_CSS } from '../app/[locale]/dashboard/RepeatSheet';
import { SendSheet } from '../app/[locale]/dashboard/SendSheet';
import { BottomSheet } from '../app/[locale]/dashboard/BottomSheet';
import SelectCalendarsClient from '../app/[locale]/select-calendars/SelectCalendarsClient';
import CalendarsClient from '../app/[locale]/calendars/CalendarsClient';

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
import { REAL_EDITING } from '../src/lib/calendar-view/editor-client';
import { liftVerdict } from '../src/lib/calendar-view/drag-model';
import { resetHolidaysCache } from '../src/lib/calendar-view/holidays-client';
import type { EditorInfoResponse, ItemEditInfoResponse, RepeatInfo } from '../src/lib/calendar-view/editor-types';
import { checkForm, editItemForm, moveStart, movesDay, newItemForm, scopePlan, setAllDay, setKind, spanOf, updateBody, type EditorForm, type NewItemContext } from '../src/lib/calendar-view/editor-model';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// The wheel library runs on touch events and animation frames, which the fake DOM has none of: a
// stub with the same props stands in for it, and a change goes through its onChange like a field's.
// The library's own markup and ARIA are checked in smoke-date-picker-render.ts.
{
  const wheelLib = nodeRequire.resolve('@ncdai/react-wheel-picker');
  const StubWheel = (p: { options: { value: string; label: unknown }[]; value: string; onValueChange: (v: string) => void }) =>
    createElement(
      'div',
      { 'data-rwp': '', 'data-stub-wheel': '', 'data-value': p.value, tabIndex: 0, onChange: (e: { target: { value: string } }) => p.onValueChange(e.target.value) },
      p.options.map((o) => createElement('span', { key: o.value }, String(o.label))),
    );
  const StubWrapper = (p: { className?: string; children?: ReactElement }) => createElement('div', { 'data-rwp-wrapper': '', className: p.className }, p.children);
  nodeRequire.cache[wheelLib] = { id: wheelLib, filename: wheelLib, loaded: true, exports: { WheelPicker: StubWheel, WheelPickerWrapper: StubWrapper } } as unknown as NodeJS.Module;
}
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
    if (text.startsWith('[command-client]') || text.startsWith('[calendar-home]') || text.startsWith('[holidays]')) {
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
const DINNER = item('dinner', { source: 'google', readOnly: true, canEdit: false, tz: null, title: 'Dinner with the Cohens', start: '2026-10-15T19:30:00+03:00', end: '2026-10-15T22:00:00+03:00', calendar: G_FAMILY, htmlLink: HTML_LINK, birthday: false });
const BIRTHDAY = item('bday', { source: 'google', readOnly: true, canEdit: false, tz: null, title: 'Noa’s birthday', start: day(1), end: day(2), allDay: true, calendar: G_BIRTHDAYS, birthday: true, htmlLink: null });
const YOGA = item('yoga', { source: 'google', readOnly: true, canEdit: false, tz: null, title: 'Yoga', start: '2026-10-16T18:00:00+03:00', end: '2026-10-16T19:00:00+03:00', calendar: G_NOA, htmlLink: 'https://www.google.com/calendar/event?eid=eW9nYQ' });

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
  return { agenda, hints: HINTS_ALL, selected: null, onSelect: noop, onShowNextWeek: noop, onRetry: noop, onChooseCalendars: noop, ...o };
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
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** A select's options, which React walks to set the chosen one. */
  get options(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement && c.localName === 'option');
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

const documentEvents: Row[] = [];
(globalThis as Row).KeyboardEvent = class {
  constructor(
    public type: string,
    public init: Row = {},
  ) {}
};

const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML' },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
  // What the home dispatches on the document (drag to move: Escape, the library's own cancel).
  dispatchEvent: (event: Row) => {
    documentEvents.push(event);
    return true;
  },
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

/**
 * What the editing routes (the editor info, an item's edit info, the writes) answer. Apart from
 * answerFetch, which the older checks set for the range route alone: by default none of them is
 * served (the "+" and the pencil never show), and the editing checks (#74 on) set their own.
 */
const EDITING_PATHS = ['/api/calendar/editor', '/api/calendar/item', '/api/calendar/items'];
let serveEditing: (call: FetchCall) => FetchAnswer | Promise<FetchAnswer> = () => ({ status: 500, body: { error: 'not served' } });

/**
 * The holidays route (GET /api/calendar/holidays, the Hebrew holidays layer): its calls are kept apart from
 * fetchCalls, so the older checks' counts of range and write calls are what they were, and by default it
 * answers no holidays. The holiday checks (#88 on) set serveHolidays.
 */
const holidayCalls: FetchCall[] = [];
let serveHolidays: (call: FetchCall) => FetchAnswer | Promise<FetchAnswer> = (call) => ({ status: 200, body: call.query.has('next') ? { next: null } : { days: {} } });

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
  const holidays = call.path === '/api/calendar/holidays';
  (holidays ? holidayCalls : fetchCalls).push(call);
  const reply = await (holidays ? serveHolidays(call) : EDITING_PATHS.includes(call.path) ? serveEditing(call) : answerFetch(call));
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

/** What the home reported (drag to move: a failed drop), apart from the console. */
const reports: { error: unknown; context: string; extra: Record<string, unknown> }[] = [];

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
    editing: REAL_EDITING,
    report: (error, context, extra) => void reports.push({ error, context, extra }),
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
    HapticFeedback: { notificationOccurred: (type: string) => calls.push(`haptic(${type})`), selectionChanged: () => calls.push('haptic(selection)'), impactOccurred: (style: string) => calls.push(`haptic(impact ${style})`) },
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
  sources: ['famcal'],
  googleConnected: false,
  googleState: 'none',
  hints: HINTS_ALL,
};
/**
 * A home that reads Google alone: the fixture for Google's own rendering paths (the server's
 * sources always list famcal first, so no real user has this; the home is source-agnostic and
 * reads whatever the `sources` prop lists). BOTH_HOME below is the real connected user.
 */
const GOOGLE_HOME: CalendarHomeProps = { ...FAMCAL_HOME, user: { id: 5550002, name: 'Avi', isAdmin: true }, sources: ['google'], googleConnected: true, googleState: 'connected' };

/** A FamCal user with Google connected beside it (the server's sources for a user with a token), with calendars chosen. */
const BOTH_HOME: CalendarHomeProps = { ...FAMCAL_HOME, user: { id: 5550003, name: 'Hila', isAdmin: false }, sources: ['famcal', 'google'], googleConnected: true, googleState: 'connected' };

/**
 * The route's answer to one source's request for a user with both: the asked source as given, the other
 * 'pending' (it applies but wasn't requested), each with its own legend. A source with no entry in `o` is ok and empty.
 */
function answerSource(
  c: FetchCall,
  o: { famcal?: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> }; google?: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } } = {},
): FetchAnswer {
  const window = { from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7) };
  if (c.query.get('sources') === 'google') {
    const g = o.google ?? {};
    return ok200(googleAnswer({ ...window, ...g, sources: { famcal: { status: 'pending' }, google: g.sources?.google ?? { status: 'ok' } } }));
  }
  const f = o.famcal ?? {};
  return ok200(answer({ ...window, ...f, sources: { famcal: { status: 'ok' }, google: { status: 'pending' } } }));
}

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
  holidayCalls.length = 0;
  serveHolidays = (call) => ({ status: 200, body: call.query.has('next') ? { next: null } : { days: {} } });
  resetHolidaysCache();
  serveEditing = () => ({ status: 500, body: { error: 'not served' } });
  pushes.length = 0;
  reports.length = 0;
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

  // The holidays hook asks the holidays route from any mounted view with Hebrew dates (no network here).
  (globalThis as Row).fetch = fakeFetch;

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

  await check('#11 the empty state (Ruling R10) names only the ways this user can add things; a connected user with no Google calendars chosen still gets their FamCal Agenda (an ok answer with nothing is an empty week)', () => {
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
    // To the Agenda that is an empty week like any other: the setup shape is gone (FamCal is everyone's).
    const unchosen = model([ok(googleAnswer({ calendars: [] }))]);
    assert(unchosen.empty, 'to the model, an ok answer with nothing chosen is empty');
    assertHas(textOf(renderAgenda('en', unchosen)), ['Nothing planned', 'send the bot a voice message', 'Show next week'], 'an empty week, not a setup screen');
    assertHas(textOf(renderAgenda('he', unchosen)), ['אין אירועים'], 'he');
    assertHas(textOf(renderAgenda('ru', unchosen)), ['Ничего не запланировано'], 'ru');
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
    assert(/\nhtml:has\(\.ch-home:not\(\.ch-standalone\)\) \{\s*background-color: var\(--tg-theme-bg-color, var\(--bg-white\)\);\s*\}/.test(HOME_THEME_CSS), 'the root, light');
    assert(/\nhtml:has\(\.ch-home:not\(\.ch-standalone\)\[data-theme='dark'\]\) \{\s*background-color: var\(--tg-theme-bg-color, #15151d\);\s*color-scheme: dark;\s*\}/.test(HOME_THEME_CSS), 'the root, dark');
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

  await check('#31 the ⋯ menu (R6, Google as a connection §2): everyone gets Calendars and Partner; a user who never connected gets Connect Google, one with a token Choose calendars and Reconnect Google, one with a cleared token only Reconnect Google; admins the Admin panel; each opens its page with the page\'s user_id, and the sheet closes', async () => {
    const famcal = menuEntries({ googleState: 'none', isAdmin: false, locale: 'en', userId: 5550001 });
    assert(show(famcal.map((e) => [e.id, e.href])) === show([['settings', '/en/settings?user_id=5550001'], ['calendars', '/en/calendars?user_id=5550001'], ['partner', '/en/pair?user_id=5550001'], ['connectGoogle', '/refresh-token?user_id=5550001'], ['subscription', '/en/subscription?user_id=5550001'], ['refresh', null], ['feedback', '/en/feedback?user_id=5550001']]), `never connected: ${show(famcal)}`);
    const idsFor = (googleState: 'none' | 'choose' | 'reconnect' | 'connected') => menuEntries({ googleState, isAdmin: false, locale: 'en', userId: 1 }).map((e) => e.id);
    assert(show(idsFor('choose')) === show(['settings', 'calendars', 'partner', 'chooseCalendars', 'reconnectGoogle', 'subscription', 'refresh', 'feedback']), `choose: ${show(idsFor('choose'))}`);
    assert(show(idsFor('reconnect')) === show(['settings', 'calendars', 'partner', 'reconnectGoogle', 'subscription', 'refresh', 'feedback']), `a cleared token: ${show(idsFor('reconnect'))}`);
    assert(show(idsFor('connected')) === show(['settings', 'calendars', 'partner', 'chooseCalendars', 'reconnectGoogle', 'subscription', 'refresh', 'feedback']), `connected: ${show(idsFor('connected'))}`);
    const google = menuEntries({ googleState: 'connected', isAdmin: true, locale: 'ru', userId: 5550002 });
    const want = [
      ['settings', '/ru/settings?user_id=5550002'],
      ['calendars', '/ru/calendars?user_id=5550002'],
      ['partner', '/ru/pair?user_id=5550002'],
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
      assertHas(dialogText(m.container), ['Settings Calendars Partner Connect Google Calendar Subscription Refresh Feedback Close'], 'the never-connected menu');
      assertLacks(dialogText(m.container), ['Choose calendars', 'Reconnect Google', 'Admin panel'], 'only the Connect entry, no admin entry');
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
      assertHas(dialogText(g.container), ['Настройки Календари Партнёр Выбрать календари Переподключить Google Подписка Обновить Обратная связь Панель администратора'], 'the Google admin\'s menu (ru)');
      g.click(byData(g.container, 'menu', 'admin'));
      assert(show(pushes) === show(['/ru/admin-panel?user_id=5550002']), `push: ${show(pushes)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#32 the banners (§7.2, Google as a connection §2), in order: trial, location, Choose your calendars (a token, none chosen), Reconnect (a cleared token with calendars stored, or a Google answer that asked: token or scopes) and, in a browser, Open FamCal in Telegram; never a Connect banner, never a Google banner for a user who never connected; each opens its page', async () => {
    const base: BannerFacts = { googleState: 'none', googleConnected: false, reconnect: null, inTelegram: true };
    const cases: [Partial<BannerFacts>, string[]][] = [
      [{}, []],
      [{ trialDaysLeft: 5, hasLocation: false, inTelegram: false }, ['trial', 'location', 'openInTelegram']],
      [{ trialDaysLeft: 0, hasLocation: true }, []],
      [{ trialDaysLeft: null }, []],
      [{ reconnect: 'token' }, []],
      // Never connected: the location banner follows the missing location, and nothing else about Google.
      [{ hasLocation: false }, ['location']],
      // A token with no calendars chosen.
      [{ googleState: 'choose', googleConnected: true, hasLocation: false }, ['chooseCalendars']],
      [{ googleState: 'choose', googleConnected: true, reconnect: 'token' }, ['chooseCalendars', 'reconnect']],
      // A cleared token while calendars are stored: Reconnect from the page's state, with the location banner (no token to read a zone from).
      [{ googleState: 'reconnect', hasLocation: false }, ['location', 'reconnect']],
      [{ googleState: 'reconnect', reconnect: 'scopes' }, ['reconnect']],
      // Connected: a Google answer's reconnect.
      [{ googleState: 'connected', googleConnected: true, hasLocation: false }, []],
      [{ googleState: 'connected', googleConnected: true, reconnect: 'token' }, ['reconnect']],
      [{ googleState: 'connected', googleConnected: true, reconnect: 'scopes', inTelegram: false }, ['reconnectScopes', 'openInTelegram']],
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

  await check('#38 a user who connected Google but hasn\'t chosen calendars (a token, none chosen; Google answers ok with 7 empty days): the Choose your calendars banner, and under it the FamCal Agenda as for anyone (their events, the tab bar, no setup shape); both sources are asked; a user who never connected has no Google banner at all', async () => {
    const cases: [Locale, string, string][] = [
      ['en', 'Choose your calendars Pick the Google calendars to show here and in your summaries.', 'Grandma visits'],
      ['he', 'בחירת יומנים אילו יומני Google להציג כאן ובסיכומים?', 'Grandma visits'],
    ];
    for (const [locale, title, event] of cases) {
      resetHome();
      answerFetch = (c) => answerSource(c, { famcal: { items: WEEK }, google: { calendars: [] } });
      const m = await mountHome(locale, { ...BOTH_HOME, googleState: 'choose' });
      try {
        assertHas(m.text(), [title, event], `${locale}: the banner, and FamCal's own events under it`);
        assert(m.html().includes('data-banner="chooseCalendars"'), `${locale}: the chooseCalendars banner`);
        assert(m.html().includes('role="tablist"'), `${locale}: the tab bar`);
        assert(show(ranges()) === show(['famcal default', 'google default']), `${locale}: both sources asked: ${show(ranges())}`);
        m.click(byData(m.container, 'banner', 'chooseCalendars'));
        assert(show(pushes) === show([`/${locale}/select-calendars?user_id=5550003`]), `chooseCalendars opens its page: ${show(pushes)}`);
      } finally {
        m.unmount();
      }
    }
    // Never connected: nothing about Google on the home (Connect lives in the menu).
    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK }));
    const n = await mountHome('en');
    try {
      assert(!/data-banner="(?:connectGoogle|chooseCalendars|reconnect|reconnectScopes)"/.test(n.html()), 'no Google banner');
      assertLacks(n.text(), ['Connect Google', 'Choose your calendars', 'Reconnect'], 'never connected: no Google words on the home');
      assert(show(ranges()) === show(['famcal default']), `FamCal alone: ${show(ranges())}`);
    } finally {
      n.unmount();
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

  await check('#43 the Month\'s parts are client-safe, and its views are a chunk of their own (every /dashboard open preloads CalendarHome\'s chunk): CalendarHome loads HomeTabs, month.ts, grid.ts, home-storage.ts and hebrew-date.ts, and reaches MonthView only through one import(), never MonthBrowse or MonthPicked; MonthView loads both; neither graph has a server module or @hebcal/core', () => {
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
    // Drag to move: the library and DragSurface come with the Month's chunk, not the Agenda's first one.
    assert(!home.has(dashboard('DragSurface.tsx')) && ![...home].some((p) => /@dnd-kit/.test(p)), `dnd-kit in CalendarHome's own chunk: ${show([...home].filter((p) => /@dnd-kit|DragSurface/.test(p)).map((p) => path.relative(ROOT, p)))}`);
    assert(view.has(dashboard('DragSurface.tsx')) && [...view].some((p) => /@dnd-kit[\\/]core/.test(p)), 'the Month views load the drag surface');
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

  await check('#52 a Google user whose token was cleared (calendars stored; Ruling 1 no longer hides the tabs): the tab bar and the remembered Month show, only FamCal is asked (the month\'s windows too), the Reconnect banner comes from the page\'s state, and the Month behaves as for any home; the busy card still shows no tab bar', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550002), 'month');
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', { ...FAMCAL_HOME, user: { id: 5550002, name: 'Avi', isAdmin: true }, googleState: 'reconnect' }, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(m.html().includes('role="tablist"') && m.html().includes('role="tabpanel"'), 'the tab bar and its panel');
      assert(m.html().includes('data-banner="reconnect"') && m.text().includes('Your Google connection expired'), 'the Reconnect banner, with no Google answer asking for it');
      assert(ranges().length > 0 && ranges().every((r) => r.startsWith('famcal ')), `FamCal alone is asked, the Month\'s windows too: ${show(ranges())}`);
      assert(fakeWindow.sessionStorage.getItem(homeTabKey(5550002)) === 'month', 'the stored tab is kept');
      assert(swipeCalls(tg.calls).includes('disableVerticalSwipes()'), `browse turns swipes off as for any home: ${show(swipeCalls(tg.calls))}`);
      m.click(byData(m.container, 'banner', 'reconnect'));
      assert(show(pushes) === show(['/refresh-token?user_id=5550002']), `Reconnect opens the token page: ${show(pushes)}`);
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
    const PLAIN = item('plain', { source: 'google', readOnly: true, canEdit: false, tz: null, title: 'Plain', start: '2026-10-15T12:00:00+03:00', end: '2026-10-15T13:00:00+03:00', calendar: { ...G_FAMILY, color: null }, htmlLink: null, birthday: false });
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

  // ---- Editing in the home (home editing spec §2, §4, §6) ----

  const warnedBeforeEditing = reactWarnings.length;

  const EDITOR_INFO: EditorInfoResponse = {
    kinds: { event: true, reminder: true },
    calendars: [
      { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5', main: true, mine: true },
      { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E', main: false, mine: false, ownerName: 'Noa' },
    ],
    partner: { name: 'Noa', canRemind: true },
    tz: TZ,
    reminderTime: '09:00',
    alertsOn: false,
    defaultLead: 15,
  };
  const editorWith = (o: Omit<Partial<EditorInfoResponse>, 'kinds'> & { kinds?: Partial<EditorInfoResponse['kinds']> } = {}): EditorInfoResponse => ({ ...EDITOR_INFO, ...o, kinds: { ...EDITOR_INFO.kinds, ...o.kinds } });
  /** An item's edit info: the Dentist, a one-off event the viewer may change and delete. */
  const infoFor = (o: Partial<ItemEditInfoResponse> = {}): ItemEditInfoResponse => ({
    kind: 'event',
    canEdit: true,
    canDelete: true,
    occurrence: { start: `${day(0)}T09:30`, end: `${day(0)}T10:30`, allDay: false, title: 'Dentist', location: 'Clinic on Herzl St', description: 'Bring the X-rays' },
    series: { recurring: false, start: `${day(0)}T09:30`, repeat: null, fixedDays: false, zone: 'UTC' },
    calendar: { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5' },
    tz: 'UTC',
    forName: null,
    scopes: ['single'],
    ...o,
  });
  /** A weekly Tuesday event: Swimming, 20 October at 17:00. */
  const SWIM = item('swim', { title: 'Swimming', start: at(5, '17:00'), end: at(5, '18:00'), seriesId: 'series_swim', recurring: true });
  const swimInfo = (o: Partial<ItemEditInfoResponse> = {}) =>
    infoFor({
      occurrence: { start: `${day(5)}T17:00`, end: `${day(5)}T18:00`, allDay: false, title: 'Swimming', location: '', description: '' },
      series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC' },
      scopes: ['single', 'following', 'all'],
      ...o,
    });

  /** What the editing routes answer in a check: the editor info, an item's edit info by key, and the writes. */
  type EditingServer = { editor?: FetchAnswer; item?: (key: string) => FetchAnswer; write?: (call: FetchCall) => FetchAnswer | Promise<FetchAnswer> };
  let editingKeys: string[] = [];
  function serveEditingWith(o: EditingServer = {}) {
    editingKeys = [];
    serveEditing = (c) => {
      if (c.path === '/api/calendar/editor') return o.editor ?? ok200(EDITOR_INFO);
      if (c.path === '/api/calendar/item') {
        editingKeys.push(c.query.get('key') ?? '');
        return o.item ? o.item(c.query.get('key') ?? '') : { status: 404, body: { error: 'not_found' } };
      }
      return o.write ? o.write(c) : ok200({ status: 'ok' });
    };
  }
  const writes = () => fetchCalls.filter((c) => c.path === '/api/calendar/items');
  const editorCalls = () => fetchCalls.filter((c) => c.path === '/api/calendar/editor');
  const itemCalls = () => fetchCalls.filter((c) => c.path === '/api/calendar/item');

  /** The home on a fake clock (10:00 in Jerusalem on 15 October) with FamCal's week and the editing routes served. */
  async function editingHome(locale: Locale, server: EditingServer = {}, props: Partial<CalendarHomeProps> = {}, week: Record<DayKey, ItemDTO[]> = { ...WEEK, [day(5)]: [...WEEK[day(5)], SWIM] }) {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    // FamCal's windows come from `world.week`: a check changes it before the refetch that follows a write.
    const world = { week };
    answerFetch = (c) => answerFor(c, { items: world.week });
    serveEditingWith(server);
    const clock = fakeClock('2026-10-15T07:00:00Z');
    const m = await mountHome(locale, props, clock);
    return { m, tg, world, clock };
  }

  /** A Google user's editor info (3b spec §2.4, §3.3): events only, the writable calendars the server read live, the primary marked. */
  const GOOGLE_EDITOR: EditorInfoResponse = {
    kinds: { event: true, reminder: false },
    calendars: [
      { id: 'family@group.calendar.google.com', name: 'Family', color: '#7986CB', main: false, mine: true },
      { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5', main: true, mine: true },
    ],
    partner: null,
    tz: TZ,
    reminderTime: '09:00',
    alertsOn: false,
    defaultLead: 15,
  };
  /** The home for a Google user on the same fake clock: Google's windows come from `world.items`, the editing routes from `server`. */
  async function googleHome(locale: Locale, server: EditingServer = {}, props: Partial<CalendarHomeProps> = {}) {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const world = { items: { [day(0)]: [DINNER], [day(1)]: [BIRTHDAY, YOGA] } as Record<DayKey, ItemDTO[]> };
    answerFetch = (c) => ok200(googleAnswer({ from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7), items: world.items }));
    serveEditingWith({ editor: ok200(GOOGLE_EDITOR), ...server });
    const m = await mountHome(locale, { ...GOOGLE_HOME, ...props }, fakeClock('2026-10-15T07:00:00Z'));
    return { m, tg, world };
  }

  // The fake DOM has no events for inputs: a field's change goes through the props React gave it.
  type Fake = FakeElement;
  const propsOf = (el: Fake): Row => (el as unknown as Row)[Object.keys(el).find((k) => k.startsWith('__reactProps$')) as string];
  const clickEl = (el: Fake) => React.act(() => propsOf(el).onClick({ preventDefault: noop, stopPropagation: noop }));
  const rootOf = (el: Fake) => {
    let node: FakeNode = el;
    while (node.parentNode) node = node.parentNode;
    return node;
  };
  /**
   * A text field's change goes through its onChange. A date or time pill (a button that opens a sheet)
   * is driven through the sheet as a person would: the date by paging to the month and tapping the
   * day, the time by setting the two wheels (the stub below) and tapping Done.
   */
  const typeInto = async (el: Fake, value: string) => {
    const kind = el.getAttribute('data-pill');
    if (!kind) return React.act(() => propsOf(el).onChange({ target: { value } }));
    const root = rootOf(el);
    await clickEl(el);
    await settle();
    const sheet = () => {
      const all = byRole(root, 'dialog');
      return all[all.length - 1];
    };
    if (kind === 'date') {
      for (let guard = 0; guard < 600; guard++) {
        const days = elements(sheet()).filter((e) => e.getAttribute('data-day') !== null);
        const cell = days.find((e) => e.getAttribute('data-day') === value);
        if (cell) {
          assert(cell.getAttribute('aria-disabled') === null, `${value} is greyed, not pickable`);
          await clickEl(cell);
          await settle();
          return;
        }
        const [first, last] = [days[0].getAttribute('data-day') as string, days[days.length - 1].getAttribute('data-day') as string];
        const label = value > last ? messages.en.calendarHome.picker.nextMonth : messages.en.calendarHome.picker.prevMonth;
        assert(value > last || value < first, `${value} is in the page but not a cell`);
        const nav = elements(sheet()).find((e) => e.getAttribute('aria-label') === label) as Fake;
        assert(nav.getAttribute('disabled') === null, `cannot page to ${value}`);
        await clickEl(nav);
      }
      throw new Error(`never reached ${value}`);
    }
    const wheels = elements(sheet()).filter((e) => e.getAttribute('data-stub-wheel') !== null);
    assert(wheels.length === 2, `${wheels.length} wheels`);
    const [hour, minute] = value.split(':');
    await React.act(() => propsOf(wheels[0]).onChange({ target: { value: hour } }));
    await React.act(() => propsOf(wheels[1]).onChange({ target: { value: minute } }));
    await clickEl(elements(sheet()).find((e) => e.localName === 'button' && e.textContent.trim() === messages.en.calendarHome.picker.done) as Fake);
    await settle();
  };
  const topDialog = (m: Home) => {
    const all = byRole(m.container, 'dialog');
    assert(all.length > 0, 'no dialog open');
    return all[all.length - 1];
  };
  const topText = (m: Home) => textOf(htmlOf(topDialog(m)));
  const inDialog = (m: Home, label: string) => {
    // A pill's name carries its value ("Start date, Thu 15 Oct 2026").
    const found = elements(topDialog(m)).filter((e) => e.getAttribute('aria-label') === label || (e.getAttribute('data-pill') !== null && (e.getAttribute('aria-label') ?? '').startsWith(`${label}, `)));
    assert(found.length > 0, `nothing labelled ${show(label)} in the dialog: ${show(topText(m).slice(0, 300))}`);
    return found[0];
  };
  const tapIn = (m: Home, text: string) => {
    const found = elements(topDialog(m)).filter((e) => e.localName === 'button' && e.textContent.trim() === text);
    assert(found.length > 0, `no button ${show(text)} in the dialog: ${show(elements(topDialog(m)).filter((e) => e.localName === 'button').map((e) => e.textContent))}`);
    m.click(found[0]);
  };
  const tapPlus = (m: Home, label = 'Add') => m.click(byLabel(m.container, label));
  const fieldValue = (m: Home, label: string): unknown => {
    const el = inDialog(m, label);
    return el.getAttribute('data-pill') !== null ? el.getAttribute('data-value') : propsOf(el).value;
  };
  const hasField = (m: Home, label: string) => elements(topDialog(m)).some((e) => e.getAttribute('aria-label') === label || (e.getAttribute('data-pill') !== null && (e.getAttribute('aria-label') ?? '').startsWith(`${label}, `)));
  const hasPlus = (m: Home, label = 'Add') => elements(m.container).some((e) => e.getAttribute('aria-label') === label);

  await check('#74 the "+" in the header by kinds: shown when the user can add an event, a reminder or both; with neither or a failed editor read no "+"; a Google user is asked and gets it from the server\'s kinds; not before the first answer; en/he/ru label', async () => {
    const cases: [string, EditorInfoResponse, Partial<CalendarHomeProps>, boolean][] = [
      ['both', editorWith(), {}, true],
      ['events only', editorWith({ kinds: { reminder: false } }), {}, true],
      ['reminders only', editorWith({ kinds: { event: false }, calendars: [] }), {}, true],
      ['reminders only, but the home hints none', editorWith({ kinds: { event: false }, calendars: [] }), { hints: { reminders: false, voiceEvents: true } }, false],
      ['neither', editorWith({ kinds: { event: false, reminder: false }, calendars: [] }), {}, false],
    ];
    for (const [what, info, props, want] of cases) {
      const { m } = await editingHome('en', { editor: ok200(info) }, props);
      try {
        assert(hasPlus(m) === want, `${what}: "+" ${hasPlus(m) ? 'shown' : 'missing'}`);
        assert(editorCalls().length === 1, `${what}: one editor read: ${editorCalls().length}`);
        assert(editorCalls()[0].query.get('user_id') === '5550001' && editorCalls()[0].method === 'GET', `${what}: the editor request ${editorCalls()[0].url}`);
      } finally {
        m.unmount();
      }
    }
    const failed = await editingHome('en', { editor: { status: 500, body: { error: 'internal_error' } } });
    try {
      assert(!hasPlus(failed.m), 'a failed editor read: no "+"');
    } finally {
      failed.m.unmount();
    }
    // A Google user is asked too (3b spec §3.3): the "+" follows what the server says.
    const google = await googleHome('en');
    try {
      assert(hasPlus(google.m) && editorCalls().length === 1, `a Google user with writable calendars: "+" and one editor read (${editorCalls().length})`);
    } finally {
      google.m.unmount();
    }
    const googleNone = await googleHome('en', { editor: ok200(editorWith({ kinds: { event: false, reminder: false }, calendars: [] })) });
    try {
      assert(!hasPlus(googleNone.m) && editorCalls().length === 1, 'a Google user who can write nowhere: asked, no "+"');
    } finally {
      googleNone.m.unmount();
    }
    // Before the first answer there is no day to start from.
    resetHome();
    answerFetch = () => new Promise<FetchAnswer>(noop);
    serveEditingWith();
    const early = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(!hasPlus(early), 'no "+" before the first answer');
    } finally {
      early.unmount();
    }
    for (const locale of LOCALES) {
      const { m } = await editingHome(locale);
      try {
        const label = messages[locale].calendarHome.header.add;
        assert(hasPlus(m, label), `${locale}: "+" labelled ${show(label)}`);
        if (locale !== 'en') assert(label !== messages.en.calendarHome.header.add, `${locale}: translated`);
        const btn = byLabel(m.container, label);
        assert(btn.localName === 'button' && btn.getAttribute('type') === 'button' && btn.className.includes('ch-icon-btn'), `${locale}: a 44 px icon button`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#75 the "+" opens "New" on today at the next round hour for an hour (Event | Reminder switch, the event\'s fields and defaults); with one kind no switch', async () => {
    const { m } = await editingHome('en');
    try {
      tapPlus(m);
      await settle();
      const dlg = topDialog(m);
      assert(dlg.getAttribute('aria-label') === 'New' && dlg.getAttribute('aria-modal') === 'true', 'a modal dialog named New');
      const text = topText(m);
      assertHas(text, ['Cancel', 'New', 'Event', 'Reminder', 'All day', 'Starts', 'Ends', 'Repeat', 'Never', 'Calendar', 'Family', 'Save'], 'the event editor');
      const kinds = byRole(dlg, 'radio').map((e) => [e.textContent, e.getAttribute('aria-checked')]);
      assert(show(kinds) === show([['Event', 'true'], ['Reminder', 'false']]), `the switch: ${show(kinds)}`);
      assert(fieldValue(m, 'Start date') === TODAY && fieldValue(m, 'Start time') === '11:00', `starts: ${fieldValue(m, 'Start date')} ${fieldValue(m, 'Start time')}`);
      assert(fieldValue(m, 'End date') === TODAY && fieldValue(m, 'End time') === '12:00', `ends: ${fieldValue(m, 'End date')} ${fieldValue(m, 'End time')}`);
      assert(fieldValue(m, 'Title') === '' && fieldValue(m, 'Location') === '' && fieldValue(m, 'Notes') === '', 'empty text fields');
      const sw = byRole(dlg, 'switch');
      assert(sw.length === 1 && sw[0].getAttribute('aria-checked') === 'false' && sw[0].textContent.includes('All day'), 'the All day switch, off');
      assertLacks(text, ['calendarHome.'], 'no untranslated key');
      // The header's + shows it is open; the day behind is the home's.
      assert(byLabel(m.container, 'Add').getAttribute('aria-expanded') === 'true', 'the + knows the editor is open');
    } finally {
      m.unmount();
    }
    for (const [what, info, label] of [
      ['events only', editorWith({ kinds: { reminder: false } }), 'Event'],
      ['reminders only', editorWith({ kinds: { event: false }, calendars: [] }), 'Reminder'],
    ] as const) {
      const { m } = await editingHome('en', { editor: ok200(info) });
      try {
        tapPlus(m);
        await settle();
        assert(!elements(topDialog(m)).some((e) => e.getAttribute('aria-label') === 'Type'), `${what}: no Event | Reminder switch`);
        assertHas(topText(m), [label === 'Event' ? 'All day' : 'At a set time'], `${what}: opens on its kind`);
      } finally {
        m.unmount();
      }
    }
  });

  const sameBody = (got: unknown, want: Row) => {
    const norm = (o: unknown): unknown => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o as Row).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, norm(v)])) : o);
    return show(norm(got)) === show(norm(want));
  };
  const INIT = 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc';
  const heldAnswer = () => {
    let release: (a: FetchAnswer) => void = noop;
    const promise = new Promise<FetchAnswer>((resolve) => (release = resolve));
    return { promise, release: (a: FetchAnswer) => React.act(async () => release(a)) };
  };
  const switchOf = (m: Home, text: string) => {
    const found = byRole(topDialog(m), 'switch').filter((e) => e.textContent.includes(text));
    assert(found.length === 1, `no switch ${show(text)}`);
    return found[0];
  };
  const selects = (m: Home) => elements(topDialog(m)).filter((e) => e.localName === 'select');
  // The Repeat row is a button that opens the Repeat sheet (editor upgrades spec §3): the row, its shown value, and the sheet's parts.
  const repeatRow = (m: Home) => {
    const found = elements(topDialog(m)).filter((e) => e.localName === 'button' && e.className.includes('ch-form-row') && e.getAttribute('aria-haspopup') === 'dialog' && e.textContent.startsWith('Repeat'));
    assert(found.length === 1, `${found.length} Repeat rows: ${show(topText(m).slice(0, 300))}`);
    return found[0];
  };
  const repeatShown = (m: Home) => byClass(repeatRow(m), 'ch-form-value-text')[0].textContent;
  const openRepeat = async (m: Home) => {
    m.click(repeatRow(m));
    await settle();
    assert(topDialog(m).getAttribute('aria-label') === 'Repeat', `the Repeat sheet is on top: ${show(topDialog(m).getAttribute('aria-label'))}`);
  };
  /** The sheet's Cancel and Done, whatever the language. */
  const sheetCancel = async (m: Home) => {
    m.click(byClass(topDialog(m), 'ch-editor-cancel')[0]);
    await settle();
  };
  const sheetDone = async (m: Home) => {
    m.click(saveButton(m));
    await settle();
  };
  /** The frequency radios of the open sheet: [value, text]. */
  const freqOptions = (m: Home): [unknown, string][] => byRole(byRole(topDialog(m), 'radiogroup')[0], 'radio').map((e) => [e.getAttribute('data-value'), e.textContent.trim()]);
  const radioGroup = (m: Home, label: string) => elements(topDialog(m)).filter((e) => e.getAttribute('role') === 'radiogroup' && e.getAttribute('aria-label') === label)[0];
  const radiosOf = (m: Home, label: string) => byRole(radioGroup(m, label) ?? topDialog(m), 'radio');
  const freqTexts = (m: Home) => radiosOf(m, 'How often').map((e) => e.textContent.trim());
  const chooseIn = (m: Home, group: string, text: string) => {
    const found = radiosOf(m, group).filter((e) => e.textContent.trim() === text);
    assert(found.length === 1, `no ${show(text)} in ${show(group)}: ${show(radiosOf(m, group).map((e) => e.textContent))}`);
    m.click(found[0]);
  };
  const summaryOf = (m: Home) => byClass(topDialog(m), 'ch-repeat-summary')[0].textContent;
  const doneRepeat = async (m: Home, label = 'Done') => {
    tapIn(m, label);
    await settle();
  };
  /** Opens the sheet, picks a frequency by its text and applies it. */
  const pickRepeat = async (m: Home, text: string) => {
    await openRepeat(m);
    chooseIn(m, 'How often', text);
    await doneRepeat(m);
  };
  /** The frequency texts by the old choice names. */
  const FREQ: Record<string, string> = { none: 'Never', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', hebrew: 'Every year on the Hebrew date' };
  const pickFreq = (m: Home, choice: string) => pickRepeat(m, FREQ[choice] ?? choice);
  const saveButton = (m: Home) => {
    const found = elements(topDialog(m)).filter((e) => e.localName === 'button' && byClass(e, 'ch-save').length + (e.className.includes('ch-save') ? 1 : 0) > 0);
    assert(found.length === 1, 'the Save button');
    return found[0];
  };
  const alerts = (m: Home) => byRole(topDialog(m), 'alert').map((e) => e.textContent);
  const hasDialog = (m: Home) => byRole(m.container, 'dialog').length > 0;

  await check('#75a on the Month with a day picked, the "+" starts on that day at 09:00; on today\'s picked day, at the next round hour', async () => {
    const { m } = await editingHome('en');
    try {
      await openMonth(m);
      await tap(m, dayButton(m, '2026-10-20'));
      assert(pickedShown(m), 'a day is picked');
      tapPlus(m);
      await settle();
      assert(fieldValue(m, 'Start date') === '2026-10-20' && fieldValue(m, 'Start time') === '09:00' && fieldValue(m, 'End time') === '10:00', `picked day: ${fieldValue(m, 'Start date')} ${fieldValue(m, 'Start time')}`);
      tapIn(m, 'Cancel');
      await tap(m, dayButton(m, TODAY));
      tapPlus(m);
      await settle();
      assert(fieldValue(m, 'Start date') === TODAY && fieldValue(m, 'Start time') === '11:00', `today picked: ${fieldValue(m, 'Start date')} ${fieldValue(m, 'Start time')}`);
    } finally {
      m.unmount();
    }
  });

  // ================= Drag to move (editor upgrades spec §4) =================
  // The library's own sensors need a real pointer, so these checks drive the DndContext's handlers (onDragStart,
  // onDragOver, onDragEnd, onDragCancel) the way the library calls them, with the data the draggables registered,
  // and read the rest from the page: the markers, the requests, the store, the bar, Telegram's calls.

  const SHARED_VIEW = item('shared', { title: 'Noa’s dentist', start: at(0, '12:00'), end: at(0, '13:00'), calendar: NOA_CAL, canEdit: false });
  const STANDUP = item('standup', { title: 'Standup', start: at(0, '08:30'), end: at(0, '09:00'), recurring: true, seriesId: 'series_standup', repeatsEveryDay: true });
  const dgMovedTo = (it: ItemDTO, days: number): ItemDTO => ({ ...it, start: at(days, '09:30'), end: at(days, '10:30') });
  const dgWeek = (): Record<DayKey, ItemDTO[]> => ({ [day(0)]: [STANDUP, DENTIST, SHARED_VIEW], [day(5)]: [SWIM] });
  /** The Dentist's edit info when it is on `days` after today. */
  const dgDentistInfo = (days: number, o: Partial<ItemEditInfoResponse> = {}) =>
    infoFor({ occurrence: { start: `${day(days)}T09:30`, end: `${day(days)}T10:30`, allDay: false, title: 'Dentist', location: '', description: '' }, series: { recurring: false, start: `${day(days)}T09:30`, repeat: null, fixedDays: false, zone: 'UTC', rule: { choice: 'none' }, first: true }, ...o });

  const dgDnd = (m: Home): Row => {
    const grid = byClass(m.container, 'ch-mp-grid')[0] ?? byClass(m.container, 'ch-mb-grid')[0];
    assert(grid, 'no month grid');
    const key = Object.keys(grid).find((k) => k.startsWith('__reactFiber$')) as string;
    for (let f = (grid as unknown as Row)[key]; f; f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p.onDragEnd === 'function' && p.collisionDetection) return p;
    }
    throw new Error('no DndContext above the grid');
  };
  /** The DragOverlay's props, found below the DndContext. */
  const dgOverlay = (m: Home): Row => {
    const grid = byClass(m.container, 'ch-mp-grid')[0] ?? byClass(m.container, 'ch-mb-grid')[0];
    const key = Object.keys(grid).find((k) => k.startsWith('__reactFiber$')) as string;
    let context: Row | null = null;
    for (let f = (grid as unknown as Row)[key]; f && !context; f = f.return) if (f.memoizedProps && typeof f.memoizedProps.onDragEnd === 'function') context = f;
    const queue: Row[] = [context as Row];
    while (queue.length) {
      const f = queue.shift() as Row;
      if (f.memoizedProps && 'dropAnimation' in f.memoizedProps && 'modifiers' in f.memoizedProps) return f.memoizedProps;
      for (let c = f.child; c; c = c.sibling) queue.push(c);
    }
    throw new Error('no DragOverlay');
  };
  const dgLiftEvent = (it: ItemDTO, onDay: DayKey) => ({ active: { id: `${it.key}@${onDay}`, data: { current: { key: it.key, day: onDay, title: it.title, verdict: liftVerdict(it) } } } });
  const dgLift = (m: Home, it: ItemDTO, onDay: DayKey) => React.act(async () => dgDnd(m).onDragStart(dgLiftEvent(it, onDay)));
  const dgHover = (m: Home, id: string | null) => React.act(async () => dgDnd(m).onDragOver({ over: id === null ? null : { id } }));
  const dgDrop = async (m: Home, id: string | null) => {
    await React.act(async () => dgDnd(m).onDragEnd({ over: id === null ? null : { id } }));
    await settle();
  };
  const dgDay = (d: DayKey) => `day:${d}`;
  const dgBar = (m: Home) => byClass(m.container, 'ch-dbar-region')[0];
  const dgBarText = (m: Home) => textOf(htmlOf(dgBar(m)));
  const dgUndo = (m: Home) => byClass(m.container, 'ch-dbar-undo')[0];
  const dgRowTitles = (m: Home) => byClass(m.container, 'ch-row').map((r) => textOf(htmlOf(r)));
  const dgRow = (m: Home, title: string) => byClass(m.container, 'ch-row').find((r) => textOf(htmlOf(r)).includes(title)) as FakeElement;
  const DGMSG = messages.en.calendarHome;

  /** The home on the Month with TODAY picked, the editing routes serving the Dentist's info. */
  async function dgHome(locale: Locale, server: EditingServer = {}, week = dgWeek()) {
    const home = await editingHome(locale, server, {}, week);
    await openMonth(home.m);
    const label = formatDayLong(TODAY, locale);
    await tap(home.m, byClass(home.m.container, 'ch-mb-cell').find((e) => (e.getAttribute('aria-label') ?? '').startsWith(label)) as FakeElement);
    assert(pickedShown(home.m), 'a day is picked');
    return home;
  }

  await check('#d1 what lifts: a row of picked\'s list and a chip of browse carry the one marker when the item can be changed and does not repeat every day; none in the Agenda; the library gets the spec\'s sensors', async () => {
    const { m } = await dgHome('en');
    try {
      const lifted = (title: string) => dgRow(m, title).getAttribute('data-lift');
      assert(lifted('Dentist') === 'yes', 'the Dentist lifts');
      assert(lifted('Standup') === null, 'an every-day repeat does not');
      assert(lifted('Noa’s dentist') === null, 'an item the viewer can\'t change does not');
      assert(dgRow(m, 'Dentist').className.includes('ch-liftable') && dgRow(m, 'Noa’s dentist').className.includes('ch-liftable'), 'both take the press (the second says why)');
      const sensors = dgDnd(m).sensors as { sensor: { name: string }; options: Row }[];
      assert(show(sensors.map((s) => [s.sensor.name, s.options.activationConstraint])) === show([['MouseSensor', { distance: MOUSE_DISTANCE_PX }], ['TouchSensor', { delay: LIFT_DELAY_MS, tolerance: LIFT_TOLERANCE_PX }]]), `sensors ${show(sensors)}`);
      assert(MOUSE_DISTANCE_PX === 6 && LIFT_DELAY_MS === 450 && LIFT_TOLERANCE_PX === 8 && NAV_DWELL_MS === 600 && DRAG_BAR_MS === 6000, 'the spec\'s numbers');
      // Browse: the chips.
      m.click(byClass(m.container, 'ch-mp-back')[0]);
      await settle();
      flushFrames();
      assert(browseShown(m), 'browse');
      const chips = byClass(m.container, 'ch-mb-chip');
      const markers = chips.filter((c) => c.getAttribute('data-lift') === 'yes');
      assert(chips.length > markers.length && markers.length > 0, `${markers.length} of ${chips.length} chips lift`);
      assert(markers.every((c) => textOf(htmlOf(c)).includes('Dentist') || textOf(htmlOf(c)).includes('Swimming')), 'only the Dentist and Swimming');
      // The Agenda has none at all.
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(elements(m.container).every((e) => e.getAttribute('data-lift') === null && !e.className.includes('ch-liftable')), 'the Agenda has no draggable');
    } finally {
      m.unmount();
    }
  });

  await check('#d2 a drop on another day: the item leaves the picked day at once, the editor\'s PATCH goes out (its info read first, the start shifted, the same body), then the source is asked again; the bar says where, with Undo; swipes are locked while it is lifted; haptics', async () => {
    let moved = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { m, tg, world, clock } = await dgHome('en', {
      item: () => ok200(dgDentistInfo(moved)),
      write: async () => {
        await gate;
        return ok200({ status: 'ok' });
      },
    });
    try {
      assert(dgRowTitles(m).some((t) => t.includes('Dentist')), 'listed on the picked day');
      const before = swipeCalls(tg.calls).length;
      await dgLift(m, DENTIST, TODAY);
      assert(tg.calls.includes('haptic(impact medium)'), 'a medium impact on the lift');
      assert(swipeCalls(tg.calls).slice(before).join() === 'disableVerticalSwipes()', `swipes locked: ${swipeCalls(tg.calls).slice(before)}`);
      await dgHover(m, dgDay(day(2)));
      assert(tg.calls.includes('haptic(selection)'), 'a tick per new day');
      // The ghost never takes the pointer (it would hide the cell under the finger from the hit test), follows the finger,
      // and the page auto-scrolls only while something is really lifted.
      const overlay = dgOverlay(m);
      assert(overlay.className === OVERLAY_CLASS && (overlay.style as Row).pointerEvents === 'none' && overlay.modifiers.length === 1, `overlay ${show({ c: overlay.className, s: overlay.style })}`);
      assert(dgDnd(m).autoScroll === true, 'auto-scroll while lifted');
      assert(DRAG_CSS.includes('.ch-drag-overlay {\n  pointer-events: none;'), 'the wrapper takes no pointer events in CSS either');
      await React.act(async () => dgDnd(m).onDragEnd({ over: { id: dgDay(day(2)) } }));
      await settle();
      assert(swipeCalls(tg.calls).at(-1) === 'enableVerticalSwipes()', 'swipes back on at the drop');
      assert(dgDnd(m).autoScroll === false, 'no auto-scroll once dropped');
      // The PATCH is in flight: the item has left the picked day and stands on the target, pending.
      assert(!dgRowTitles(m).some((t) => t.includes('Dentist')), `still on the picked day: ${dgRowTitles(m)}`);
      assert(writes().length === 1, 'one PATCH in flight');
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { start: `${day(2)}T09:30`, end: `${day(2)}T10:30` } }), `body ${show(writes()[0].body)}`);
      assert(itemCalls().map((c) => c.query.get('key')).join() === 'famcal|dentist', 'its edit info was read first');
      moved = 2;
      world.week = { ...dgWeek(), [day(0)]: [STANDUP, SHARED_VIEW], [day(2)]: [dgMovedTo(DENTIST, 2)] };
      const asked = ranges().length;
      await React.act(async () => release());
      await settle();
      assert(tg.calls.includes('haptic(success)'), 'a success tap');
      assert(dgBar(m).getAttribute('aria-live') === 'polite', 'the bar is a polite live region');
      assert(dgBarText(m).includes(`Moved to ${formatDayShort(day(2), 'en')}`) && dgBarText(m).includes('Undo'), `bar: ${dgBarText(m)}`);
      assert(ranges().length > asked && ranges().slice(asked).every((r) => r.startsWith('famcal')), `FamCal asked again: ${ranges().slice(asked)}`);
      assert(byClass(m.container, 'is-pending').length === 0, 'the pending look is gone once the refetch landed');
      // The bar goes after six seconds.
      await clock.advance(5000);
      assert(dgBarText(m).includes('Moved to'), 'still there at five seconds');
      await clock.advance(1100);
      assert(!dgBarText(m).includes('Moved to') && !dgUndo(m), `gone: ${dgBarText(m)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#d3 Undo sends the move back the same way (the item\'s info read on the key the PATCH ANSWERED, the start shifted back, the same scope) and says so; a newer drag takes the old bar away at once and replaces it; a failed Undo says why and is reported', async () => {
    const answered = 'famcal|dentist#moved';
    let writeCount = 0;
    let release!: () => void;
    let gate: Promise<void> | null = null;
    const { m, world } = await dgHome('en', {
      // The moved item lives under the key the PATCH answered; the original key is read at day 0.
      item: (key) => ok200(dgDentistInfo(key === answered ? 2 : 0)),
      write: async () => {
        writeCount++;
        if (gate) await gate;
        if (writeCount === 4) return { status: 500, body: { error: 'internal_error' } };
        return ok200(writeCount === 1 ? { status: 'ok', key: answered } : { status: 'ok' });
      },
    });
    try {
      await dgLift(m, DENTIST, TODAY);
      world.week = { ...dgWeek(), [day(0)]: [STANDUP, SHARED_VIEW], [day(2)]: [dgMovedTo(DENTIST, 2)] };
      await dgDrop(m, dgDay(day(2)));
      assert(dgUndo(m) && dgBarText(m).includes('Moved to'), `bar ${dgBarText(m)}`);
      world.week = dgWeek();
      const itemReads = itemCalls().length;
      await tap(m, dgUndo(m));
      await settle();
      assert(writes().length === 2, `${writes().length} writes`);
      assert(itemCalls().length === itemReads + 1 && itemCalls().at(-1)?.query.get('key') === answered, `its info was read on ${itemCalls().at(-1)?.query.get('key')}, not the answered key`);
      assert(sameBody(writes()[1].body, { user_id: 5550001, initData: INIT, key: answered, scope: 'single', changes: { start: `${day(0)}T09:30`, end: `${day(0)}T10:30` } }), `undo body ${show(writes()[1].body)}`);
      assert(dgBarText(m) === DGMSG.drag.undone && !dgUndo(m), `bar: ${dgBarText(m)}`);
      assert(dgRowTitles(m).some((t) => t.includes('Dentist')), 'back on the picked day');
      // A newer drag: the old bar (and its Undo) is gone while it writes, then the new one takes its place.
      gate = new Promise<void>((resolve) => (release = resolve));
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, dgDay(day(3)));
      assert(dgBarText(m) === '' && !dgUndo(m), `the old bar is gone while the new drop writes: ${dgBarText(m)}`);
      gate = null;
      await React.act(async () => release());
      await settle();
      assert(dgBarText(m).includes(`Moved to ${formatDayShort(day(3), 'en')}`) && !dgBarText(m).includes(DGMSG.drag.undone), `the new bar: ${dgBarText(m)}`);
      // Undo that fails: the editor\'s words, a report with the key and scope, no title.
      writeCount = 3;
      await tap(m, dgUndo(m));
      await settle();
      assert(dgBarText(m) === messages.en.calendarHome.editor.submitErrors.failed && !dgUndo(m), `failed undo: ${dgBarText(m)}`);
      assert(reports.length === 1 && String(reports[0].extra.what).startsWith('undo') && reports[0].extra.scope === 'single' && !show(reports).includes('Dentist'), `report ${show(reports.map((r) => r.extra))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#d4 a repeating item asks which occurrences first (the editor\'s ScopeSheet), with the item already on its new day; Close or the BackButton puts it back with no request; a choice saves with that scope; no Undo after "this one and the ones after"', async () => {
    const swimAt = (days: number) => swimInfo({ occurrence: { start: `${day(days)}T17:00`, end: `${day(days)}T18:00`, allDay: false, title: 'Swimming', location: '', description: '' }, series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC' } });
    const { m, tg } = await dgHome('en', { item: () => ok200(swimAt(5)), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await tap(m, dayButton(m, day(5)));
      assert(dgRowTitles(m).some((t) => t.includes('Swimming')), 'Swimming on its day');
      // Close puts it back.
      await dgLift(m, SWIM, day(5));
      await dgDrop(m, dgDay(day(7)));
      assert(dialogText(m.container).includes('This event repeats') && dialogText(m.container).includes('Only this one') && dialogText(m.container).includes('Every Tuesday'), `sheet: ${dialogText(m.container)}`);
      assert(writes().length === 0, 'nothing sent yet');
      assert(!dgRowTitles(m).some((t) => t.includes('Swimming')), 'already on its new day');
      tapIn(m, 'Cancel');
      await settle();
      assert(writes().length === 0 && dgRowTitles(m).some((t) => t.includes('Swimming')), `Close: ${dgRowTitles(m)}`);
      // The BackButton does too.
      await dgLift(m, SWIM, day(5));
      await dgDrop(m, dgDay(day(7)));
      assert(byRole(m.container, 'dialog').length === 1, 'the sheet again');
      await React.act(async () => tg.fire('backButtonClicked'));
      await settle();
      assert(byRole(m.container, 'dialog').length === 0 && writes().length === 0 && dgRowTitles(m).some((t) => t.includes('Swimming')), 'the BackButton put it back');
      // A choice saves with its scope.
      await dgLift(m, SWIM, day(5));
      await dgDrop(m, dgDay(day(7)));
      const choice = (text: string) => elements(topDialog(m)).filter((e) => e.localName === 'button').find((b) => textOf(htmlOf(b)).includes(text)) as FakeElement;
      m.click(choice('Only this one'));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'single', changes: { start: `${day(7)}T17:00`, end: `${day(7)}T18:00` } }), `body ${show(writes()[0].body)}`);
      assert(dgUndo(m), 'Undo after only this one');
      // This one and the ones after: saved, but no Undo.
      await dgLift(m, SWIM, day(5));
      await dgDrop(m, dgDay(day(6)));
      m.click(choice('This one and the ones after'));
      await settle();
      assert(writes()[1].body?.scope === 'following', `scope ${writes()[1].body?.scope}`);
      assert(dgBarText(m).includes('Moved to') && !dgUndo(m), `no Undo after following: ${dgBarText(m)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#d5 a drop that fails puts the item back, says why in the editor\'s words, taps an error, logs the key and scope (no title) and asks the source again; a drop on its own day or outside the grid sends nothing', async () => {
    const { m, tg } = await dgHome('en', { item: () => ok200(dgDentistInfo(0)), write: () => ({ status: 500, body: { error: 'internal_error' } }) });
    try {
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, dgDay(TODAY));
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, null);
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, 'nav:next');
      assert(fetchCalls.filter((c) => c.path === '/api/calendar/item' || c.path === '/api/calendar/items').length === 0, 'no request');
      assert(dgRowTitles(m).some((t) => t.includes('Dentist')) && dgBarText(m) === '', 'nothing moved, no bar');
      const asked = ranges().length;
      // The source's answer is held, so what shows is the item put back, not the refetch's copy.
      const answerRange = answerFetch;
      answerFetch = () => new Promise(() => {});
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, dgDay(day(2)));
      assert(dgRowTitles(m).some((t) => t.includes('Dentist')), `back on the picked day: ${dgRowTitles(m)}`);
      assert(dgBarText(m) === messages.en.calendarHome.editor.submitErrors.failed && !dgUndo(m), `bar: ${dgBarText(m)}`);
      assert(tg.calls.includes('haptic(error)'), 'an error tap');
      assert(reports.length === 1 && reports[0].context === 'calendar-home-drag' && reports[0].extra.key === 'famcal|dentist' && reports[0].extra.scope === 'single', `report ${show(reports)}`);
      assert(!show(reports.map((r) => [String(r.error), r.extra])).includes('Dentist'), 'no title in the report');
      assert(ranges().length > asked, 'the source was asked again');
      answerFetch = answerRange;
      // The other failures say theirs.
      for (const [status, body, text] of [[403, { error: 'not_allowed' }, 'notAllowed'], [409, { error: 'changed' }, 'changed'], [429, { error: 'busy' }, 'busy']] as const) {
        serveEditing = (c) => (c.path === '/api/calendar/item' ? ok200(dgDentistInfo(0)) : { status, body });
        await dgLift(m, DENTIST, TODAY);
        await dgDrop(m, dgDay(day(2)));
        assert(dgBarText(m) === messages.en.calendarHome.editor.submitErrors[text], `${status}: ${dgBarText(m)}`);
      }
      // An edit info that can't be read is the drag's own message.
      serveEditing = () => ({ status: 500, body: { error: 'internal_error' } });
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, dgDay(day(2)));
      assert(dgBarText(m) === DGMSG.drag.failed && dgRowTitles(m).some((t) => t.includes('Dentist')), `info: ${dgBarText(m)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#d6 an item that can\'t move says why on a long-press (a warning tap and the bar), stays inert (no swipe lock, no drop); the drop\'s own edit info is the final word for a read-only or an every-day series', async () => {
    const { m, tg } = await dgHome('en', { item: () => ok200(dgDentistInfo(0, { canEdit: false })) });
    try {
      const before = swipeCalls(tg.calls).length;
      await dgLift(m, SHARED_VIEW, TODAY);
      assert(dgBarText(m) === DGMSG.drag.cantMove, `bar: ${dgBarText(m)}`);
      assert(tg.calls.includes('haptic(warning)') && !tg.calls.includes('haptic(impact medium)'), 'a warning, no lift');
      assert(swipeCalls(tg.calls).length === before, 'no swipe lock');
      await dgDrop(m, dgDay(day(2)));
      assert(fetchCalls.filter((c) => c.path.startsWith('/api/calendar/item')).length === 0, 'nothing sent');
      await dgLift(m, STANDUP, TODAY);
      assert(dgBarText(m) === DGMSG.drag.cantMoveDaily, `bar: ${dgBarText(m)}`);
      // The edit info says it can't be changed: it snaps back with that note.
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, dgDay(day(2)));
      assert(dgBarText(m) === DGMSG.drag.cantMove && dgRowTitles(m).some((t) => t.includes('Dentist')) && writes().length === 0, `info says no: ${dgBarText(m)}`);
      // A Google series shown as a plain event, daily by its info.
      serveEditing = (c) => (c.path === '/api/calendar/item' ? ok200(dgDentistInfo(0, { series: { recurring: true, start: `${day(0)}T09:30`, repeat: { freq: 'daily', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC' }, scopes: ['single', 'following', 'all'] })) : ok200({ status: 'ok' }));
      await dgLift(m, DENTIST, TODAY);
      await dgDrop(m, dgDay(day(2)));
      assert(dgBarText(m) === DGMSG.drag.cantMoveDaily && dgRowTitles(m).some((t) => t.includes('Dentist')) && writes().length === 0, `daily by its info: ${dgBarText(m)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#d7 the BackButton cancels a lift (Escape, the library\'s own cancel, and nothing dropped), shown while lifting in browse; a tab switch while lifted lets the swipe lock go', async () => {
    const { m, tg } = await editingHome('en', { item: () => ok200(dgDentistInfo(0)) }, {}, dgWeek());
    try {
      await openMonth(m);
      assert(browseShown(m), 'browse');
      assert(backCalls(tg.calls).at(-1) === 'BackButton.hide()', 'hidden in browse');
      await dgLift(m, DENTIST, TODAY);
      assert(backCalls(tg.calls).at(-1) === 'BackButton.show()', 'shown while lifted');
      documentEvents.length = 0;
      await React.act(async () => tg.fire('backButtonClicked'));
      assert(documentEvents.some((e) => e.type === 'keydown' && (e.init as Row).code === 'Escape'), 'Escape went out');
      await dgDrop(m, dgDay(day(2)));
      assert(fetchCalls.filter((c) => c.path.startsWith('/api/calendar/item')).length === 0, 'nothing dropped');
      await React.act(async () => dgDnd(m).onDragCancel());
      assert(backCalls(tg.calls).at(-1) === 'BackButton.hide()', 'hidden again');
      // A tab switch while lifted: the Month goes, and the swipe lock with it (the Agenda scrolls and swipes as ever).
      await dgLift(m, DENTIST, TODAY);
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(swipeCalls(tg.calls).at(-1) === 'enableVerticalSwipes()' && backCalls(tg.calls).at(-1) === 'BackButton.hide()', `after the tab switch: ${swipeCalls(tg.calls).at(-2)}, ${swipeCalls(tg.calls).at(-1)}, ${backCalls(tg.calls).at(-1)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#d8 over a month chevron for 600 ms the picked month turns (the picked day\'s list stays), again every 600 ms while the finger stays; a drop there is on a day of that month; it comes back to the picked day\'s month after', async () => {
    const { m } = await dgHome('en', { item: () => ok200(dgDentistInfo(0)), write: () => ok200({ status: 'ok' }) });
    try {
      const title = () => textOf(htmlOf(byClass(m.container, 'ch-mp-title')[0]));
      assert(title().includes('October'), title());
      await dgLift(m, DENTIST, TODAY);
      await dgHover(m, 'nav:next');
      assert(title().includes('October'), 'not before the dwell');
      await React.act(async () => new Promise((resolve) => setTimeout(resolve, NAV_DWELL_MS + 150)));
      assert(title().includes('November'), `turned: ${title()}`);
      assert(dgRowTitles(m).some((t) => t.includes('Dentist')), 'the lifted row is still in the page');
      // Still over the chevron: it turns again after another dwell, and the month it lands on is asked (loaded) while lifted.
      await React.act(async () => new Promise((resolve) => setTimeout(resolve, NAV_DWELL_MS + 150)));
      assert(title().includes('December'), `turned again: ${title()}`);
      await settle();
      assert(rangeCalls().some((c) => (c.query.get('from') ?? '').startsWith('2027-01') || (c.query.get('to') ?? '').startsWith('2027-01')), `January (December's neighbour) was asked: ${ranges()}`);
      await dgHover(m, dgDay('2026-11-03'));
      await React.act(async () => new Promise((resolve) => setTimeout(resolve, NAV_DWELL_MS + 150)));
      assert(title().includes('December'), 'it does not keep turning off the chevron');
      await dgDrop(m, dgDay('2026-11-03'));
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { start: '2026-11-03T09:30', end: '2026-11-03T10:30' } }), `body ${show(writes()[0].body)}`);
      assert(title().includes('October'), `back on the picked day's month: ${title()}`);
    } finally {
      m.unmount();
    }
  });

  await check('#d10 browse: a bar of a multi-day all-day item grabbed on its 2nd day and dropped on a cell moves by the days between the two; it shows on the target at once with the pending look and the bar names its new start day (not the drop day)', async () => {
    const TRIP = (span: ItemDTO['span']) => item('trip', { title: 'Camping', allDay: true, tz: null, start: day(5), end: day(8), span });
    const tripInfo = infoFor({ occurrence: { start: day(5), end: day(7), allDay: true, title: 'Camping', location: '', description: '' }, series: { recurring: false, start: day(5), repeat: null, fixedDays: false, zone: 'UTC', rule: { choice: 'none' }, first: true } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const week = { [day(5)]: [TRIP('endsLater')], [day(6)]: [TRIP('spansDay')], [day(7)]: [TRIP('continues')] };
    const { m, world } = await editingHome('en', { item: () => ok200(tripInfo), write: async () => { await gate; return ok200({ status: 'ok' }); } }, {}, week);
    try {
      await openMonth(m);
      assert(browseShown(m), 'browse');
      const cellOf = (d: DayKey) => dayButton(m, d);
      const pendingIn = (d: DayKey) => byClass(cellOf(d), 'ch-mb-chip').filter((c) => c.className.includes('is-pending')).length;
      const chipsIn = (d: DayKey) => byClass(cellOf(d), 'ch-mb-chip').filter((c) => c.getAttribute('data-lift') === 'yes').length;
      assert(chipsIn(day(5)) === 1 && chipsIn(day(6)) === 1 && chipsIn(day(7)) === 1, 'the bar lifts from each of its days');
      const delta = 4; // grabbed on day(6), dropped on day(10)
      await dgLift(m, TRIP('spansDay'), day(6));
      world.week = { [day(9)]: [{ ...TRIP('endsLater'), start: day(9), end: day(12) }], [day(10)]: [{ ...TRIP('spansDay'), start: day(9), end: day(12) }], [day(11)]: [{ ...TRIP('continues'), start: day(9), end: day(12) }] };
      await dgDrop(m, dgDay(day(10)));
      assert(writes().length === 1 && sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|trip', scope: 'single', changes: { start: day(5 + delta), end: day(7 + delta) } }), `body ${show(writes()[0].body)}`);
      assert(chipsIn(day(5)) === 0 && pendingIn(day(9)) === 1 && pendingIn(day(10)) === 1, `on its new days, pending: ${pendingIn(day(9))} ${pendingIn(day(10))} ${chipsIn(day(5))}`);
      await React.act(async () => release());
      await settle();
      assert(dgBarText(m).includes(`Moved to ${formatDayShort(day(9), 'en')}`) && !dgBarText(m).includes(formatDayShort(day(10), 'en')), `bar: ${dgBarText(m)}`);
      assert(byClass(m.container, 'is-pending').length === 0, 'the pending look is gone after the refetch');
    } finally {
      m.unmount();
    }
  });

  await check('#d11 a repeating item\'s refusals in the editor\'s words: a day move the rule fixes (the rolled Hebrew year\'s "delete the series" note), the series starting too early, a repeat the server refused, a repeat that would end before it starts; and a cancel puts the item back as it was even after a refetch landed', async () => {
    const swimAt = (o: Partial<ItemEditInfoResponse['series']> = {}) =>
      swimInfo({ series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC', ...o } });
    let answer: FetchAnswer = { status: 400, body: { error: 'invalid', field: 'start' } };
    const { m, tg } = await dgHome('en', { item: () => ok200(swimAt()), write: () => answer });
    try {
      await tap(m, dayButton(m, day(5)));
      const choice = (text: string) => elements(topDialog(m)).filter((e) => e.localName === 'button').find((b) => textOf(htmlOf(b)).includes(text)) as FakeElement;
      const attempt = async (pick: string) => {
        await dgLift(m, SWIM, day(5));
        await dgDrop(m, dgDay(day(7)));
        m.click(choice(pick));
        await settle();
      };
      const copy = messages.en.calendarHome;
      await attempt('Every Tuesday');
      assert(dgBarText(m) === copy.scope.dayMoveNote, `rolled year / fixed days: ${dgBarText(m)}`);
      assert(dgRowTitles(m).some((r) => r.includes('Swimming')), 'back on its day');
      answer = { status: 400, body: { error: 'invalid', field: 'start', reason: 'year' } };
      await attempt('Every Tuesday');
      assert(dgBarText(m) === copy.editor.errors.errSeriesYear, `series year: ${dgBarText(m)}`);
      answer = { status: 400, body: { error: 'invalid', field: 'repeat' } };
      await attempt('This one and the ones after');
      assert(dgBarText(m) === copy.editor.errors.errRepeat, `repeat: ${dgBarText(m)}`);
      answer = { status: 400, body: { error: 'invalid', field: 'start' } };
      await attempt('Only this one');
      assert(dgBarText(m) === copy.editor.submitErrors.failed, `only this one is not the day-move case: ${dgBarText(m)}`);
      // The editor's own check on the moved form: past the series' last day, nothing is sent.
      const sent = writes().length;
      serveEditingWith({ item: () => ok200(swimAt({ repeat: { freq: 'weekly', interval: 1, byDay: [], ends: true }, rule: { choice: 'weekly', until: day(5) }, spec: { freq: 'weekly', interval: 1, byDay: ['TU'], until: day(5) } })), write: () => answer });
      await dgLift(m, SWIM, day(5));
      await dgDrop(m, dgDay(day(7)));
      assert(dgBarText(m) === copy.editor.errors.errRepeatEnd && writes().length === sent && dgRowTitles(m).some((r) => r.includes('Swimming')), `past its end: ${dgBarText(m)}`);
      // A refetch lands while the scope question is open; closing it puts the item back where the store has it, not a shift away.
      serveEditingWith({ item: () => ok200(swimAt()), write: () => answer });
      await dgLift(m, SWIM, day(5));
      await dgDrop(m, dgDay(day(7)));
      assert(byRole(m.container, 'dialog').length === 1 && !dgRowTitles(m).some((r) => r.includes('Swimming')), 'the question is open, the item already on its new day');
      await React.act(async () => tg.fire('activated'));
      await settle();
      tapIn(m, 'Cancel');
      await settle();
      assert(dgRowTitles(m).some((r) => r.includes('Swimming')), `back on its own day: ${dgRowTitles(m)}`);
      await tap(m, dayButton(m, day(3)));
      assert(!dgRowTitles(m).some((r) => r.includes('Swimming')), 'and not two days before it');
    } finally {
      m.unmount();
    }
  });

  await check('#d9 the bar in Hebrew and Russian: the date in the locale\'s short form and Undo; the drag\'s styles: no text menu on an item, a 2 px accent outline on the day under the finger, the ghost, a 44 px Undo, logical properties only, reduced motion respected', async () => {
    for (const locale of ['he', 'ru'] as const) {
      const { m } = await dgHome(locale, { item: () => ok200(dgDentistInfo(0)), write: () => ok200({ status: 'ok' }) });
      try {
        await dgLift(m, DENTIST, TODAY);
        await dgDrop(m, dgDay(day(2)));
        const msg = messages[locale].calendarHome.drag;
        assert(dgBarText(m) === `${msg.moved.replace('{date}', formatDayShort(day(2), locale))} ${msg.undo}`, `${locale}: ${dgBarText(m)}`);
        assert(elements(m.container).find((e) => e.className === 'ch-home')?.getAttribute('dir') === (locale === 'he' ? 'rtl' : 'ltr'), `${locale} direction`);
      } finally {
        m.unmount();
      }
    }
    assert(/-webkit-touch-callout: none/.test(DRAG_CSS) && /user-select: none/.test(DRAG_CSS), 'no text menu on an item');
    assert(/\.is-drop \{[^}]*outline: 2px solid var\(--ch-accent\)/.test(DRAG_CSS), 'the 2 px accent outline');
    assert(/prefers-reduced-motion: reduce[\s\S]*animation: none/.test(DRAG_CSS), 'reduced motion');
    assert(/min-block-size: 44px/.test(DRAG_BAR_CSS) && /min-inline-size: 44px/.test(DRAG_BAR_CSS), 'a 44 px Undo');
    for (const css of [DRAG_CSS, DRAG_BAR_CSS]) {
      assert(!/(margin|padding|border)-(left|right)|\b(left|right):/.test(css), 'logical properties only');
      assert(!/font-size: ([0-9]|10)px/.test(css), 'no text under 11 px');
      assert(!/:hover/.test(css), 'no hover');
    }
  });
  await check('#d12 an Undo tapped while another write runs: the bar says so and keeps the Undo, so it can be tapped again', async () => {
    const entry = { key: 'famcal|dentist#moved', scope: 'single' as const, days: 2 };
    const html = renderToString(inHome('en', createElement(DragBar, { bar: { id: 1, kind: 'error', error: 'busy', undo: entry }, undoing: false, onUndo: noop })));
    assert(html.includes('<button') && html.includes(`>${messages.en.calendarHome.drag.undo}</button>`), `the busy bar keeps its Undo: ${html}`);
    const plain = renderToString(inHome('en', createElement(DragBar, { bar: { id: 2, kind: 'error', error: 'busy' }, undoing: false, onUndo: noop })));
    assert(!plain.includes('<button'), 'an error with no entry has no Undo');
  });

  await check('#76 the editor\'s defaults for the day in view: the Month\'s picked day, else today at the next round hour for an hour (a late hour rolls into tomorrow); a reminder form; the start moves the end with it; all day keeps the days between', () => {
    const base = { today: TODAY, pickedDay: null, nowMs: Date.parse('2026-10-15T07:00:00Z'), tz: TZ, kinds: { event: true, reminder: true }, calendars: EDITOR_INFO.calendars };
    const pick = (o: Partial<NewItemContext>) => {
      const f = newItemForm({ ...base, ...o });
      return `${f.startDay} ${f.startTime} → ${f.endDay} ${f.endTime}`;
    };
    assert(pick({}) === '2026-10-15 11:00 → 2026-10-15 12:00', `today: ${pick({})}`);
    assert(pick({ nowMs: Date.parse('2026-10-15T07:59:00Z') }) === '2026-10-15 11:00 → 2026-10-15 12:00', 'still the next hour at 10:59');
    assert(pick({ nowMs: Date.parse('2026-10-15T20:30:00Z') }) === '2026-10-16 00:00 → 2026-10-16 01:00', `23:30 rolls into tomorrow: ${pick({ nowMs: Date.parse('2026-10-15T20:30:00Z') })}`);
    assert(pick({ pickedDay: '2026-10-20' }) === '2026-10-20 09:00 → 2026-10-20 10:00', `a picked day: ${pick({ pickedDay: '2026-10-20' })}`);
    assert(pick({ pickedDay: TODAY }) === '2026-10-15 11:00 → 2026-10-15 12:00', 'today picked is today');
    const f = newItemForm(base);
    assert(f.kind === 'event' && f.repeat === 'none' && f.calendarId === 'native:cal_me_7f3a' && !f.allDay && !f.forPartner, `defaults: ${show(f)}`);
    assert(newItemForm({ ...base, kinds: { event: false, reminder: true }, calendars: [] }).kind === 'reminder', 'reminders only opens on a reminder');
    // Moving the start keeps the duration; all day keeps the days between.
    const moved = moveStart({ ...f, endTime: '12:30' }, { startTime: '15:00' });
    assert(moved.startTime === '15:00' && moved.endTime === '16:30' && moved.endDay === TODAY, `timed: ${show(moved)}`);
    const over = moveStart(f, { startTime: '23:30' });
    assert(over.endDay === '2026-10-16' && over.endTime === '00:30', `across midnight: ${over.endDay} ${over.endTime}`);
    const dayMove = moveStart({ ...f, allDay: true, endDay: '2026-10-17' }, { startDay: '2026-10-20' });
    assert(dayMove.endDay === '2026-10-22', `all day: ${dayMove.endDay}`);
    assert(moveStart(f, { startTime: '' }).endTime === f.endTime, 'a cleared time leaves the end');
    assert(setAllDay(setAllDay(f, true), false).endTime === '12:00', 'all day off again brings the times back');
    // The kind switch: a Hebrew repeat does not survive a switch to an event on a Google calendar.
    const assertSame = (got: unknown, want: unknown, what: string) => assert(show(got) === show(want), `${what}: got ${show(got)}, want ${show(want)}`);
    const heb = { freq: 'hebrew', interval: 2, count: 4 } as const;
    const gFam = { ...f, calendarId: 'avi@gmail.com', repeat: heb };
    assertSame(setKind({ ...gFam, kind: 'reminder' }, 'event').repeat, { freq: 'yearly', interval: 2, count: 4 }, 'reminder to event on a Google calendar: Hebrew falls back to yearly, keeping its interval and end');
    assert(setKind({ ...gFam, kind: 'reminder' }, 'event').kind === 'event', 'the kind is switched');
    assertSame(setKind({ ...f, kind: 'reminder', repeat: heb }, 'event').repeat, heb, 'a FamCal calendar keeps it');
    assertSame(setKind({ ...f, kind: 'reminder', calendarId: null, repeat: heb }, 'event').repeat, heb, 'no calendar (FamCal default) keeps it');
    assertSame(setKind(gFam, 'reminder').repeat, heb, 'to a reminder keeps it (always FamCal)');
    const wk = { freq: 'weekly', interval: 1 } as const;
    assertSame(setKind({ ...gFam, kind: 'reminder', repeat: wk }, 'event').repeat, wk, 'a Gregorian repeat is untouched');
    // The checks.
    assert(show(checkForm({ ...f, title: '  ' })) === show({ title: 'errTitle' }), 'an empty title');
    assert(show(checkForm({ ...f, title: 'x'.repeat(201) })) === show({ title: 'errTitleLong' }), 'a long title');
    assert(show(checkForm({ ...f, title: 'x', endTime: '10:00' })) === show({ end: 'errEnd' }), 'ends before it starts');
    assert(show(checkForm({ ...f, title: 'x', endTime: '11:00' })) === show({ end: 'errEnd' }), 'ends as it starts');
    assert(show(checkForm({ ...f, title: 'x', startDay: '' })) === show({ start: 'errDate' }), 'a cleared date');
    assert(show(checkForm({ ...f, title: 'x', startDay: '0026-10-15' })) === show({ start: 'errDate' }), 'a year the server refuses');
    assert(show(checkForm({ ...f, title: 'x', allDay: true, endDay: '2026-10-14' })) === show({ end: 'errEnd' }), 'all day ends the day before');
    assert(show(checkForm({ ...f, title: 'x', allDay: true, startTime: '', endTime: '' })) === show({}), 'all day needs no times');
    assert(show(checkForm({ ...f, kind: 'reminder', title: 'x', endDay: '', endTime: '' })) === show({}), 'a reminder has no end');
    assert(show(checkForm({ ...f, title: 'x', location: 'y'.repeat(201), notes: 'z'.repeat(2001) })) === show({ location: 'errTooLong', notes: 'errTooLong' }), 'long location and notes');
  });

  await check('#76a a year typed into the start date (0002, 0020, 0202, then 2027) keeps the end the last real length after the start, timed and all day; a year outside 1900-2100 is never measured from; in the editor too', async () => {
    const base = { today: TODAY, pickedDay: null, nowMs: Date.parse('2026-10-15T07:00:00Z'), tz: TZ, kinds: { event: true, reminder: true }, calendars: EDITOR_INFO.calendars };
    /** Each value in turn, as a date input sends them, with the editor's last real length held. */
    const typeYear = (from: EditorForm, days: string[]) => {
      let form = from;
      let held = spanOf(from);
      for (const startDay of days) {
        form = moveStart(form, { startDay }, held);
        held = spanOf(form) ?? held;
      }
      return form;
    };
    const timed = { ...newItemForm(base), endTime: '13:30' };
    const t = typeYear(timed, ['0002-10-15', '0020-10-15', '0202-10-15', '2027-10-15']);
    assert(`${t.startDay} ${t.startTime} → ${t.endDay} ${t.endTime}` === '2027-10-15 11:00 → 2027-10-15 13:30', `timed: ${t.startDay} ${t.startTime} → ${t.endDay} ${t.endTime}`);
    const allDay = { ...newItemForm(base), allDay: true, endDay: '2026-10-17' };
    const a = typeYear(allDay, ['0002-10-20', '0020-10-20', '0202-10-20', '2028-10-20']);
    assert(`${a.startDay} → ${a.endDay}` === '2028-10-20 → 2028-10-22', `all day: ${a.startDay} → ${a.endDay}`);
    // A start in a year the server refuses is not measured from, held length or not.
    const odd = { ...timed, startDay: '1899-10-15' };
    assert(spanOf(odd) === null && spanOf({ ...timed, endDay: '2101-01-01' }) === null, 'a span from 1899 or to 2101');
    const fromOdd = moveStart(odd, { startDay: '2026-10-16' });
    assert(fromOdd.endDay === timed.endDay && fromOdd.endTime === timed.endTime, `no length from 1899: ${fromOdd.endDay} ${fromOdd.endTime}`);
    assert(moveStart(odd, { startDay: '2026-10-16' }, { allDay: false, size: 90 }).endTime === '12:30', 'the held length instead');
    assert(moveStart(odd, { startDay: '2026-10-16' }, { allDay: true, size: 1 }).endTime === timed.endTime, 'an all-day length is not a timed one');
    // In the editor: each value through the date input's onChange.
    const { m } = await editingHome('en');
    try {
      tapPlus(m);
      await settle();
      await typeInto(inDialog(m, 'End time'), '13:30');
      await typeInto(inDialog(m, 'Start date'), '2027-10-15');
      assert(fieldValue(m, 'End date') === '2027-10-15' && fieldValue(m, 'End time') === '13:30', `the end: ${fieldValue(m, 'End date')} ${fieldValue(m, 'End time')}`);
      m.click(switchOf(m, 'All day'));
      await typeInto(inDialog(m, 'End date'), '2027-10-17');
      await typeInto(inDialog(m, 'Start date'), '2028-10-20');
      assert(fieldValue(m, 'End date') === '2028-10-22', `all day, the end: ${fieldValue(m, 'End date')}`);
    } finally {
      m.unmount();
    }
  });

  await check("B1 the reminder editor's hint names the user's own reminder time (from the editor info), not a fixed 09:00", async () => {
    const { m } = await editingHome('en', { editor: ok200(editorWith({ reminderTime: '07:30' })) });
    try {
      tapPlus(m);
      await settle();
      tapIn(m, 'Reminder');
      const text = topText(m);
      assertHas(text, ['Without a time, the reminder arrives at 07:30'], 'the hint');
      assertLacks(text, ['arrives at 09:00'], 'no fixed time');
    } finally {
      m.unmount();
    }
  });

  await check('#77 the event editor in use: fields by kind (a reminder has When, At a set time, Repeat and For, no location, all day or notes); the start moves the end; all day hides the times; the repeat choices name the start day', async () => {
    const { m } = await editingHome('en');
    try {
      tapPlus(m);
      await settle();
      // The start moves the end with it.
      await typeInto(inDialog(m, 'Start time'), '15:00');
      assert(fieldValue(m, 'End time') === '16:00' && fieldValue(m, 'End date') === TODAY, `end follows: ${fieldValue(m, 'End time')}`);
      await typeInto(inDialog(m, 'End time'), '18:30');
      await typeInto(inDialog(m, 'Start time'), '16:00');
      assert(fieldValue(m, 'End time') === '19:30', `the duration kept: ${fieldValue(m, 'End time')}`);
      // The Repeat row opens the sheet; its frequencies are the same on every day, and its summary reads from the start day (Thursday 15 October).
      const options = (sel: Fake) => elements(sel).filter((e) => e.localName === 'option').map((e) => [propsOf(e).value, e.textContent]);
      await openRepeat(m);
      assert(show(freqTexts(m)) === show(['Never', 'Daily', 'Weekly', 'Monthly', 'Yearly', 'Every year on the Hebrew date']), `repeat: ${show(freqTexts(m))}`);
      chooseIn(m, 'How often', 'Monthly');
      assert(summaryOf(m) === 'Every month on the 15th', `monthly on the 15th: ${summaryOf(m)}`);
      await doneRepeat(m, 'Cancel');
      assert(repeatShown(m) === 'Never', 'Cancel leaves the repeat as it was');
      await typeInto(inDialog(m, 'Start date'), '2026-10-22');
      assert(fieldValue(m, 'End date') === '2026-10-22', 'a later day carries the end');
      await pickFreq(m, 'monthly');
      assert(repeatShown(m) === 'Every month on the 22nd', `the ordinal follows the day: ${repeatShown(m)}`);
      assert(show(options(selects(m)[0])) === show([['native:cal_me_7f3a', 'Family'], ['native:cal_noa_91b2', 'Noa and the kids · Noa']]), `calendars: ${show(options(selects(m)[0]))}`);
      assertHas(topText(m), ['Family'], 'the main calendar is the default');
      // All day hides the times.
      assert(elements(topDialog(m)).filter((e) => e.getAttribute('data-pill') === 'time').length === 2, 'two time pills');
      m.click(switchOf(m, 'All day'));
      assert(switchOf(m, 'All day').getAttribute('aria-checked') === 'true', 'all day is on');
      assert(elements(topDialog(m)).filter((e) => e.getAttribute('data-pill') === 'time').length === 0, 'no time pills all day');
      assert(elements(topDialog(m)).filter((e) => e.getAttribute('data-pill') === 'date').length === 2, 'the dates stay');
      m.click(switchOf(m, 'All day'));
      assert(fieldValue(m, 'Start time') === '16:00' && fieldValue(m, 'End time') === '19:30', 'the times come back');
      // A reminder.
      tapIn(m, 'Reminder');
      const text = topText(m);
      assertHas(text, ['When', 'At a set time', 'Without a time, the reminder arrives at 09:00', 'Repeat', 'For', 'Me', 'Noa', 'Save'], 'the reminder editor');
      assertLacks(text, ['All day', 'Ends', 'Calendar'], 'a reminder has no such fields');
      assert(!hasField(m, 'Location') && !hasField(m, 'Notes'), 'no location or notes on a reminder');
      assert(switchOf(m, 'At a set time').getAttribute('aria-checked') === 'true', 'a set time by default');
      assert(fieldValue(m, 'Date') === '2026-10-22' && fieldValue(m, 'Time') === '16:00', `when: ${fieldValue(m, 'Date')} ${fieldValue(m, 'Time')}`);
      assert(byRole(topDialog(m), 'radio').filter((e) => e.getAttribute('aria-checked') === 'true').map((e) => e.textContent).includes('Me'), 'for me by default');
      m.click(switchOf(m, 'At a set time'));
      assert(elements(topDialog(m)).filter((e) => e.getAttribute('data-pill') === 'time').length === 0, 'no time pill without a set time');
      tapIn(m, 'Event');
      assertHas(topText(m), ['All day'], 'back to an event');
      assert(hasField(m, 'Location') && hasField(m, 'Notes'), 'location and notes are back');
    } finally {
      m.unmount();
    }
    // For appears only when the partner can be reminded.
    const alone = await editingHome('en', { editor: ok200(editorWith({ partner: { name: 'Noa', canRemind: false } })) });
    try {
      tapPlus(alone.m);
      await settle();
      tapIn(alone.m, 'Reminder');
      assertLacks(topText(alone.m), ['For'], 'a partner who cannot be pinged');
    } finally {
      alone.m.unmount();
    }
    const single = await editingHome('en', { editor: ok200(editorWith({ partner: null })) });
    try {
      tapPlus(single.m);
      await settle();
      tapIn(single.m, 'Reminder');
      assertLacks(topText(single.m), ['For'], 'no partner');
    } finally {
      single.m.unmount();
    }
  });

  await check('#78 Save: inline errors under the fields (no request until it is valid), the body sent (event and reminder, the init data in the header and the body), the button disabled and busy while it flies, then the editor closes and FamCal is asked again; every failure shows above Save and keeps the form', async () => {
    const { m, tg } = await editingHome('en');
    try {
      tapPlus(m);
      await settle();
      m.click(saveButton(m));
      await settle();
      assert(show(alerts(m)) === show(['Add a title']), `title error: ${show(alerts(m))}`);
      assert(writes().length === 0, 'nothing sent');
      assert(inDialog(m, 'Title').getAttribute('aria-invalid') === 'true', 'the field is marked invalid');
      await typeInto(inDialog(m, 'Title'), '  Parents’ evening ');
      assert(alerts(m).length === 0, 'the error goes once the title is there');
      await typeInto(inDialog(m, 'End time'), '10:30');
      m.click(saveButton(m));
      assert(show(alerts(m)) === show(['It ends before it starts']), `end error: ${show(alerts(m))}`);
      await typeInto(inDialog(m, 'End time'), '12:30');
      await pickFreq(m, 'weekly');
      await typeInto(selects(m)[0], 'native:cal_noa_91b2');
      await typeInto(inDialog(m, 'Location'), ' School hall ');
      await typeInto(inDialog(m, 'Notes'), 'Bring the form');
      const hold = heldAnswer();
      serveEditingWith({ write: () => hold.promise });
      const before = rangeCalls().length;
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 1, `one write: ${writes().length}`);
      const post = writes()[0];
      assert(post.method === 'POST' && post.headers['Content-Type'] === 'application/json' && post.credentials === 'same-origin', 'POST, JSON, same-origin');
      assert(post.headers['X-Telegram-Init-Data'] === INIT, 'the init data in the header');
      const want = { user_id: 5550001, initData: INIT, kind: 'event', title: 'Parents’ evening', location: 'School hall', description: 'Bring the form', allDay: false, start: `${TODAY}T11:00`, end: `${TODAY}T12:30`, repeat: { freq: 'weekly', interval: 1, byDay: ['TH'] }, calendarId: 'native:cal_noa_91b2' };
      assert(sameBody(post.body, want), `body: ${show(post.body)}`);
      const save = saveButton(m);
      assert(save.hasAttribute('disabled') && save.getAttribute('aria-busy') === 'true' && byClass(save, 'ch-form-spinner').length === 1, 'Save is disabled and busy while it flies');
      m.click(save);
      await settle();
      assert(writes().length === 1, 'a tap on the disabled Save sends nothing');
      await hold.release(ok200({ status: 'ok', key: 'famcal|new1#2026-10-15T08:00:00.000Z' }));
      await settle();
      assert(!hasDialog(m), 'the editor closes');
      assert(rangeCalls().slice(before).some((c) => c.query.get('sources') === 'famcal'), `FamCal is asked again: ${show(ranges().slice(before))}`);
      assert(tg.calls.includes('haptic(success)'), 'a haptic on success');
      // Every failure: the message above Save, the form kept, Save live again.
      const failures: [FetchAnswer, string][] = [
        [{ status: 403, body: { error: 'not_allowed' } }, 'You can’t change this one'],
        [{ status: 409, body: { error: 'changed' } }, 'This changed in the meantime — reopen it'],
        [{ status: 404, body: { error: 'not_found' } }, 'This changed in the meantime — reopen it'],
        [{ status: 500, body: { error: 'internal_error' } }, 'Couldn’t save. Try again.'],
        [{ status: 429, body: { error: 'Too many requests' } }, 'Too many changes at once. Try again in a minute.'],
        [{ status: 400, body: { error: 'invalid', field: 'title' } }, 'Couldn’t save. Try again.'],
        ['throw', 'Couldn’t save. Try again.'],
        [{ status: 200, body: { nope: true } }, 'Couldn’t save. Try again.'],
      ];
      for (const [reply, text] of failures) {
        tapPlus(m);
        await settle();
        await typeInto(inDialog(m, 'Title'), 'Retry me');
        serveEditingWith({ write: () => reply });
        m.click(saveButton(m));
        await settle();
        assert(hasDialog(m) && alerts(m).includes(text), `${show(reply)}: ${show(alerts(m))} (want ${show(text)})`);
        assert(fieldValue(m, 'Title') === 'Retry me' && !saveButton(m).hasAttribute('disabled'), 'the form is kept and Save is live');
        if (reply !== 'throw' && (reply as { body: Row }).body.field === 'title') assert(alerts(m).includes('Check this one'), 'the server\'s field is marked');
        await typeInto(inDialog(m, 'Title'), 'Retry me too');
        assert(alerts(m).length === 0 || alerts(m).every((a) => a === 'Check this one'), 'editing clears the message');
        tapIn(m, 'Cancel');
        tapIn(m, 'Discard');
      }
    } finally {
      m.unmount();
    }
  });

  await check('#79 a new reminder: with a time (and for the partner), a date only (arrives at 09:00); the body carries no end, location, notes or calendar; a reminder alone for me', async () => {
    const { m } = await editingHome('en');
    try {
      tapPlus(m);
      await settle();
      tapIn(m, 'Reminder');
      await typeInto(inDialog(m, 'Title'), 'Buy a gift');
      tapIn(m, 'Noa');
      assert(byRole(topDialog(m), 'radio').some((e) => e.textContent === 'Noa' && e.getAttribute('aria-checked') === 'true'), 'for Noa');
      await typeInto(inDialog(m, 'Date'), '2026-10-21');
      await typeInto(inDialog(m, 'Time'), '18:00');
      await pickFreq(m, 'yearly');
      m.click(saveButton(m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, kind: 'reminder', title: 'Buy a gift', allDay: false, start: '2026-10-21T18:00', repeat: { freq: 'yearly', interval: 1 }, forPartner: true }), `timed: ${show(writes()[0].body)}`);
      assert(!hasDialog(m), 'closed');
      tapPlus(m);
      await settle();
      tapIn(m, 'Reminder');
      await typeInto(inDialog(m, 'Title'), 'Call the plumber');
      m.click(switchOf(m, 'At a set time'));
      m.click(saveButton(m));
      await settle();
      assert(sameBody(writes()[1].body, { user_id: 5550001, initData: INIT, kind: 'reminder', title: 'Call the plumber', allDay: true, start: TODAY, repeat: 'none' }), `date only: ${show(writes()[1].body)}`);
    } finally {
      m.unmount();
    }
    // An event with nothing but a title: no location or notes in the body; all day keeps the day.
    const plain = await editingHome('en');
    try {
      tapPlus(plain.m);
      await settle();
      await typeInto(inDialog(plain.m, 'Title'), 'Day off');
      plain.m.click(switchOf(plain.m, 'All day'));
      plain.m.click(saveButton(plain.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, kind: 'event', title: 'Day off', allDay: true, start: TODAY, end: TODAY, repeat: 'none', calendarId: 'native:cal_me_7f3a' }), `all day: ${show(writes()[0].body)}`);
    } finally {
      plain.m.unmount();
    }
  });

  /** Opens an item's sheet from its row (by title) and lets the edit info arrive. */
  const openItem = async (m: Home, title: string) => {
    m.click(button(m.container, title));
    await settle();
  };
  const sheetButtons = (m: Home) => elements(topDialog(m)).filter((e) => e.localName === 'button').map((e) => e.getAttribute('aria-label') ?? e.textContent.trim());
  const dentistInfo = (o: Partial<ItemEditInfoResponse> = {}) => (key: string) => (key === 'famcal|dentist' ? ok200(infoFor(o)) : { status: 404, body: { error: 'not_found' } } as FetchAnswer);

  await check('#80 the item sheet\'s pencil and Delete by permission: the pencil for who may edit, Delete event / Delete reminder for who may delete, neither for a viewer; nothing before the edit info arrives, a Google item is asked too; none when the read fails or says 404; asked once per sheet with the key and the init data', async () => {
    const cases: [string, Partial<ItemEditInfoResponse>, string[]][] = [
      ['owner', {}, ['Edit', 'Delete event']],
      ['may edit only', { canDelete: false }, ['Edit']],
      ['may delete only', { canEdit: false }, ['Delete event']],
      ['a viewer', { canEdit: false, canDelete: false }, []],
      ['a reminder', { kind: 'reminder' }, ['Edit', 'Delete reminder']],
    ];
    for (const [what, over, want] of cases) {
      const { m } = await editingHome('en', { item: dentistInfo(over) });
      try {
        await openItem(m, 'Dentist');
        const got = sheetButtons(m).filter((b) => b === 'Edit' || b.startsWith('Delete'));
        assert(show(got) === show(want), `${what}: ${show(got)}`);
        assert(itemCalls().length === 1 && itemCalls()[0].query.get('key') === 'famcal|dentist' && itemCalls()[0].query.get('user_id') === '5550001', `${what}: one read of the item: ${show(itemCalls().map((c) => c.url))}`);
        assert(itemCalls()[0].headers['X-Telegram-Init-Data'] === INIT && itemCalls()[0].method === 'GET', `${what}: the init data in the header`);
        if (want.includes('Edit')) {
          const pencil = byLabel(topDialog(m), 'Edit');
          assert(pencil.localName === 'button' && pencil.className.includes('ch-icon-btn') && byClass(byClass(topDialog(m), 'ch-sheet-head')[0], 'ch-sheet-edit').length === 1, `${what}: a 44 px icon button in the header`);
        }
        if (want.includes('Delete event') || want.includes('Delete reminder')) {
          const buttons = sheetButtons(m);
          assert(buttons.indexOf(want[want.length - 1]) < buttons.indexOf('Close'), `${what}: Delete sits above Close`);
        }
      } finally {
        m.unmount();
      }
    }
    // Nothing before the answer; the Done button of a reminder keeps working beside them.
    const slow = heldAnswer();
    const wait = await editingHome('en', { item: () => slow.promise as unknown as FetchAnswer });
    try {
      await openItem(wait.m, 'Dentist');
      assert(!sheetButtons(wait.m).includes('Edit') && !sheetButtons(wait.m).some((b) => b.startsWith('Delete')), 'no pencil or Delete before the edit info');
      await slow.release(ok200(infoFor()));
      await settle();
      assert(sheetButtons(wait.m).includes('Edit'), 'the pencil comes with the answer');
    } finally {
      wait.m.unmount();
    }
    for (const [what, reply] of [['a 404', { status: 404, body: { error: 'not_found' } }], ['a 500', { status: 500, body: {} }], ['a garbled body', { status: 200, body: { kind: 'event' } }], ['no answer', 'throw']] as [string, FetchAnswer][]) {
      const { m } = await editingHome('en', { item: () => reply });
      try {
        await openItem(m, 'Dentist');
        assert(!sheetButtons(m).includes('Edit') && !sheetButtons(m).some((b) => b.startsWith('Delete')), `${what}: no controls`);
        assertHas(topText(m), ['Dentist'], `${what}: the sheet is still there`);
      } finally {
        m.unmount();
      }
    }
    // A Google item is asked too (3b spec §3.3); with the server's answer it has the pencil.
    const g = await googleHome('en', { item: () => ok200(infoFor({ source: 'google' })) });
    try {
      await openItem(g.m, 'Dinner with the Cohens');
      assert(itemCalls().length === 1 && itemCalls()[0].query.get('key') === 'google|dinner' && sheetButtons(g.m).includes('Edit'), `a Google item: asked once, with the pencil: ${show(editingKeys)}`);
    } finally {
      g.m.unmount();
    }
    // The labels in he and ru.
    for (const locale of ['he', 'ru'] as const) {
      const { m } = await editingHome(locale, { item: dentistInfo() });
      try {
        m.click(button(m.container, 'Dentist'));
        await settle();
        const l = messages[locale].calendarHome.sheet;
        assert(sheetButtons(m).includes(l.edit) && sheetButtons(m).includes(l.deleteEvent), `${locale}: ${show(sheetButtons(m))}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#81 the pencil opens the editor on the item: prefilled, the kind fixed, the Repeat row (no Calendar row without move targets: the calendar and "For Noa" stay text); Save with nothing changed just closes; a one-off sends only what changed, with no scope question', async () => {
    const { m } = await editingHome('en', { item: dentistInfo() });
    try {
      await openItem(m, 'Dentist');
      m.click(byLabel(topDialog(m), 'Edit'));
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'Edit', 'the editor is named Edit');
      assert(fieldValue(m, 'Title') === 'Dentist' && fieldValue(m, 'Location') === 'Clinic on Herzl St' && fieldValue(m, 'Notes') === 'Bring the X-rays', 'text fields prefilled');
      assert(fieldValue(m, 'Start date') === TODAY && fieldValue(m, 'Start time') === '09:30' && fieldValue(m, 'End time') === '10:30', 'times prefilled');
      assert(!elements(topDialog(m)).some((e) => e.getAttribute('aria-label') === 'Type') && selects(m).length === 0, 'no kind switch; no select at all (the Repeat row is a button, no move targets, no Calendar select)');
      assertHas(topText(m), ['Family', 'All day', 'Starts', 'Ends', 'Repeat', 'Never'], 'the calendar as text, the Repeat row at Never');
      // Nothing changed: Save just closes the editor.
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 0 && byRole(m.container, 'dialog').length === 1, 'nothing sent; the item sheet is behind');
      // A change: only it goes.
      m.click(byLabel(topDialog(m), 'Edit'));
      await settle();
      await typeInto(inDialog(m, 'Title'), '  Dentist (moved) ');
      serveEditingWith({ item: dentistInfo(), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 1 && writes()[0].method === 'PATCH', `a PATCH: ${show(writes().map((c) => c.method))}`);
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { title: 'Dentist (moved)' } }), `body: ${show(writes()[0].body)}`);
      assert(byRole(m.container, 'dialog').length === 1, 'the editor closed with no scope question');
      // Timed changes carry start and end together; a cleared location is sent as empty.
      m.click(byLabel(topDialog(m), 'Edit'));
      await settle();
      await typeInto(inDialog(m, 'Start time'), '10:00');
      await typeInto(inDialog(m, 'Location'), '');
      m.click(saveButton(m));
      await settle();
      assert(sameBody(writes()[1].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { location: '', start: `${TODAY}T10:00`, end: `${TODAY}T11:00` } }), `body 2: ${show(writes()[1].body)}`);
    } finally {
      m.unmount();
    }
    // An all-day event made timed, and a timed one made all day.
    const allDayInfo = infoFor({ occurrence: { start: day(1), end: day(1), allDay: true, title: 'Grandma visits', location: '', description: '' } });
    const g = await editingHome('en', { item: (k) => (k === 'famcal|grandma' ? ok200(allDayInfo) : { status: 404, body: {} }) });
    try {
      await openItem(g.m, 'Grandma visits');
      g.m.click(byLabel(topDialog(g.m), 'Edit'));
      await settle();
      assert(switchOf(g.m, 'All day').getAttribute('aria-checked') === 'true' && elements(topDialog(g.m)).filter((e) => e.getAttribute('data-pill') === 'time').length === 0, 'an all-day event opens all day');
      g.m.click(switchOf(g.m, 'All day'));
      assert(fieldValue(g.m, 'Start time') === '09:00' && fieldValue(g.m, 'End time') === '10:00', 'timed again from 09:00 for an hour');
      g.m.click(saveButton(g.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|grandma', scope: 'single', changes: { allDay: false, start: `${day(1)}T09:00`, end: `${day(1)}T10:00` } }), `timed: ${show(writes()[0].body)}`);
    } finally {
      g.m.unmount();
    }
    // A reminder for Noa: its time only, no end; "For Noa" as text; "Repeats every Tuesday" for a series.
    const remInfo = infoFor({
      kind: 'reminder',
      occurrence: { start: `${day(5)}T17:00`, end: `${day(5)}T17:00`, allDay: false, title: 'Book the plumber', location: '', description: '' },
      series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, fixedDays: true, zone: 'UTC' },
      calendar: { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5' },
      forName: 'Noa',
      scopes: ['single', 'following', 'all'],
    });
    const r = await editingHome('en', { item: (k) => (k === 'famcal|recycling' ? ok200(remInfo) : { status: 404, body: {} }) });
    try {
      await openItem(r.m, 'Take out the recycling');
      r.m.click(byLabel(topDialog(r.m), 'Edit'));
      await settle();
      assertHas(topText(r.m), ['For Noa', 'Every Tuesday', 'At a set time'], 'the For line and the Repeat row at the rule it has');
      assertLacks(topText(r.m), ['Family', 'Repeats every'], 'a reminder shows no calendar line');
      assert(!hasField(r.m, 'Location') && !hasField(r.m, 'Notes') && selects(r.m).length === 0, 'no event fields; no select (the Repeat row opens a sheet)');
      assert(!byRole(topDialog(r.m), 'radio').length, 'no For choice on an edit');
      await typeInto(inDialog(r.m, 'Time'), '17:30');
      r.m.click(saveButton(r.m));
      await settle();
      assertHas(topText(r.m), ['This reminder repeats'], 'a series asks');
      tapIn(r.m, 'Only this one (Tue 20 Oct)');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|recycling', scope: 'single', changes: { start: `${day(5)}T17:30` } }), `reminder body: ${show(writes()[0].body)}`);
    } finally {
      r.m.unmount();
    }
  });

  await check('#81a the Alert row (editor upgrades spec §2): in the times card after Repeat for a timed event when alerts can reach the user; Default names the user\'s lead; a lead, None and At start are sent, the default is not; hidden all day, for a reminder and when alerts are off; read-only for a Google calendar; in en, he and ru', async () => {
    const withAlerts = (o: Partial<EditorInfoResponse> = {}) => ok200(editorWith({ alertsOn: true, ...o }));
    const options = (sel: Fake) => elements(sel).filter((e) => e.localName === 'option').map((e) => [propsOf(e).value, e.textContent]);
    const { m } = await editingHome('en', { editor: withAlerts() });
    try {
      tapPlus(m);
      await settle();
      assertHas(topText(m), ['Repeat', 'Alert', 'Default (15 min before)'], 'the row, on Default');
      assert(show(options(selects(m)[0])) === show([['default', 'Default (15 min before)'], ['none', 'None'], ['0', 'At start'], ['5', '5 min before'], ['10', '10 min before'], ['15', '15 min before'], ['30', '30 min before'], ['60', '1 hour before'], ['120', '2 hours before'], ['1440', '1 day before']]), `alert options: ${show(options(selects(m)[0]))}`);
      await typeInto(inDialog(m, 'Title'), 'Parents’ evening');
      await typeInto(selects(m)[0], '30');
      assertHas(topText(m), ['30 min before'], 'the pick shows');
      serveEditingWith({ editor: withAlerts(), write: () => ok200({ status: 'ok' }) });
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 1 && (writes()[0].body as Row).alert === 30, `a lead is sent: ${show(writes()[0]?.body)}`);
    } finally {
      m.unmount();
    }
    const b = await editingHome('en', { editor: withAlerts() });
    try {
      tapPlus(b.m);
      await settle();
      await typeInto(inDialog(b.m, 'Title'), 'Parents’ evening');
      await typeInto(selects(b.m)[0], 'none');
      serveEditingWith({ editor: withAlerts(), write: () => ok200({ status: 'ok' }) });
      b.m.click(saveButton(b.m));
      await settle();
      assert((writes()[0].body as Row).alert === 'none', `None is sent: ${show(writes()[0].body)}`);
    } finally {
      b.m.unmount();
    }
    const c = await editingHome('en', { editor: withAlerts() });
    try {
      tapPlus(c.m);
      await settle();
      await typeInto(inDialog(c.m, 'Title'), 'Parents’ evening');
      serveEditingWith({ editor: withAlerts(), write: () => ok200({ status: 'ok' }) });
      c.m.click(saveButton(c.m));
      await settle();
      assert(!('alert' in (writes()[0].body as Row)), `the default is left out: ${show(writes()[0].body)}`);
    } finally {
      c.m.unmount();
    }
    // The row is gone all day, and for a reminder.
    const d = await editingHome('en', { editor: withAlerts() });
    try {
      tapPlus(d.m);
      await settle();
      assert(selects(d.m).length === 2, `alert and calendar: ${selects(d.m).length}`);
      d.m.click(switchOf(d.m, 'All day'));
      assert(selects(d.m).length === 1 && !topText(d.m).includes('Alert'), 'no Alert row all day');
      d.m.click(switchOf(d.m, 'All day'));
      tapIn(d.m, 'Reminder');
      assert(!topText(d.m).includes('Alert'), 'no Alert row for a reminder');
    } finally {
      d.m.unmount();
    }
    // Alerts off for this user: no row.
    const off = await editingHome('en');
    try {
      tapPlus(off.m);
      await settle();
      assert(!topText(off.m).includes('Alert') && selects(off.m).length === 1, 'no Alert row when alerts cannot reach the user');
    } finally {
      off.m.unmount();
    }
    // A user at start by default: "Default (at start)".
    const zero = await editingHome('en', { editor: withAlerts({ defaultLead: 0 }) });
    try {
      tapPlus(zero.m);
      await settle();
      assertHas(topText(zero.m), ['Default (at start)'], 'the default lead of 0');
    } finally {
      zero.m.unmount();
    }
    // A Google calendar picked: the row is read-only and the body carries no alert.
    const google = await editingHome('en', {
      editor: withAlerts({ calendars: [...EDITOR_INFO.calendars, { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5', main: false, mine: true }] }),
    });
    try {
      tapPlus(google.m);
      await settle();
      await typeInto(inDialog(google.m, 'Title'), 'Parents’ evening');
      await typeInto(selects(google.m)[0], '30');
      await typeInto(selects(google.m)[1], 'avi@gmail.com');
      assertHas(topText(google.m), ['Alert', 'Default (15 min before)'], 'a read-only row');
      assertLacks(topText(google.m), ['30 min before'], 'not the lead picked before');
      assert(selects(google.m).length === 1, `no Alert select: ${selects(google.m).length}`);
      serveEditingWith({ editor: ok200(EDITOR_INFO), write: () => ok200({ status: 'ok' }) });
      google.m.click(saveButton(google.m));
      await settle();
      assert(!('alert' in (writes()[0].body as Row)) && (writes()[0].body as Row).calendarId === 'avi@gmail.com', `no alert for Google: ${show(writes()[0].body)}`);
    } finally {
      google.m.unmount();
    }
    // The words in he and ru.
    for (const [locale, label, def, lead] of [['he', 'התראה', 'ברירת מחדל (15 דקות לפני)', '30 דקות לפני'], ['ru', 'Уведомление', 'По умолчанию (за\u00a015\u00a0минут)', 'за\u00a030\u00a0минут']] as const) {
      const l = await editingHome(locale, { editor: withAlerts() });
      try {
        tapPlus(l.m, messages[locale].calendarHome.header.add);
        await settle();
        assertHas(topText(l.m), [label, def], `${locale} row`);
        assert(options(selects(l.m)[0]).some((o) => o[1] === lead), `${locale} options: ${show(options(selects(l.m)[0]))}`);
      } finally {
        l.m.unmount();
      }
    }
  });

  await check('#81b the Alert row on an edit: the stored alert prefilled (an off-list lead as its own option), only a change is sent, a series asks for its scope, a Google item shows its own alert read-only, and the server\'s refusal shows under the row', async () => {
    const withAlerts = ok200(editorWith({ alertsOn: true }));
    const options = (sel: Fake) => elements(sel).filter((e) => e.localName === 'option').map((e) => [propsOf(e).value, e.textContent]);
    const a = await editingHome('en', { editor: withAlerts, item: dentistInfo({ alert: 45 }) });
    try {
      await openItem(a.m, 'Dentist');
      a.m.click(byLabel(topDialog(a.m), 'Edit'));
      await settle();
      assertHas(topText(a.m), ['Alert', '45 min before'], 'an off-list lead shows as it is');
      assert(show(options(selects(a.m)[0]).map((o) => o[0])) === show(['default', 'none', '0', '5', '10', '15', '30', '45', '60', '120', '1440']), `in order: ${show(options(selects(a.m)[0]))}`);
      await typeInto(selects(a.m)[0], '30');
      assert(options(selects(a.m)[0]).some((o) => o[0] === '45'), 'the option stays after another pick');
      await typeInto(selects(a.m)[0], '45');
      // Left alone, a title change does not send the alert.
      await typeInto(inDialog(a.m, 'Title'), 'Dentist 2');
      serveEditingWith({ editor: withAlerts, item: dentistInfo({ alert: 45 }), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
      a.m.click(saveButton(a.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { title: 'Dentist 2' } }), `body: ${show(writes()[0].body)}`);
    } finally {
      a.m.unmount();
    }
    const b = await editingHome('en', { editor: withAlerts, item: dentistInfo({ alert: 'none' }) });
    try {
      await openItem(b.m, 'Dentist');
      b.m.click(byLabel(topDialog(b.m), 'Edit'));
      await settle();
      assertHas(topText(b.m), ['None'], 'None prefilled');
      await typeInto(selects(b.m)[0], 'default');
      serveEditingWith({ editor: withAlerts, item: dentistInfo({ alert: 'none' }), write: () => ({ status: 400, body: { error: 'invalid', field: 'alert' } }) });
      b.m.click(saveButton(b.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { alert: 'default' } }), `body: ${show(writes()[0].body)}`);
      assert(show(alerts(b.m)).includes('Check this one'), `the refusal shows under the row: ${show(alerts(b.m))}`);
    } finally {
      b.m.unmount();
    }
    const g = await editingHome('en', {
      editor: withAlerts,
      item: (k) => (k === 'famcal|dentist' ? ok200(infoFor({ source: 'google', alert: 60, alertReadOnly: true, calendar: { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5' } })) : { status: 404, body: {} }),
    });
    try {
      await openItem(g.m, 'Dentist');
      g.m.click(byLabel(topDialog(g.m), 'Edit'));
      await settle();
      assertHas(topText(g.m), ['Alert', 'From Google Calendar: 1 hour before'], 'Google\'s own alert');
      assert(selects(g.m).length === 0, `no select: ${selects(g.m).length}`);
    } finally {
      g.m.unmount();
    }
    const none = await editingHome('en', {
      editor: withAlerts,
      item: (k) => (k === 'famcal|dentist' ? ok200(infoFor({ source: 'google', alert: 'default', alertReadOnly: true, calendar: { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5' } })) : { status: 404, body: {} }),
    });
    try {
      await openItem(none.m, 'Dentist');
      none.m.click(byLabel(topDialog(none.m), 'Edit'));
      await settle();
      assertHas(topText(none.m), ['Default (15 min before)'], 'a Google event with none of its own');
    } finally {
      none.m.unmount();
    }
    // A move to the other kind of calendar: the row shows what the event will land with, not the old alert.
    const both = ok200(editorWith({ alertsOn: true, calendars: [...EDITOR_INFO.calendars, { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5', main: false, mine: true }] }));
    const x = await editingHome('en', { editor: both, item: dentistInfo({ alert: 30, canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'avi@gmail.com'] }) });
    try {
      await openItem(x.m, 'Dentist');
      x.m.click(byLabel(topDialog(x.m), 'Edit'));
      await settle();
      assertHas(topText(x.m), ['30 min before'], 'the stored alert before the move is picked');
      assert(selects(x.m).length === 2, `alert, calendar: ${selects(x.m).length}`);
      await typeInto(selects(x.m)[1], 'avi@gmail.com');
      assertHas(topText(x.m), ['Default (15 min before)'], 'the default it lands with');
      assertLacks(topText(x.m), ['30 min before'], 'not the old alert');
      assert(selects(x.m).length === 1, 'read-only: no Alert select');
    } finally {
      x.m.unmount();
    }
    // An alert edited first, then the other kind picked: the edit goes back, so the move is saved alone.
    const y = await editingHome('en', { editor: both, item: dentistInfo({ alert: 30, canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'avi@gmail.com'] }) });
    try {
      await openItem(y.m, 'Dentist');
      y.m.click(byLabel(topDialog(y.m), 'Edit'));
      await settle();
      await typeInto(selects(y.m)[0], '10');
      await typeInto(selects(y.m)[1], 'avi@gmail.com');
      serveEditingWith({ editor: both, item: dentistInfo({ alert: 30, canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'avi@gmail.com'] }), write: () => ok200({ status: 'ok', key: 'google|avi@gmail.com|dentist' }) });
      y.m.click(saveButton(y.m));
      await settle();
      assert(writes().length === 1 && sameBody((writes()[0].body as Row).changes, { calendarId: 'avi@gmail.com' }), `the move alone: ${show(writes()[0]?.body)}`);
    } finally {
      y.m.unmount();
    }
    // A series: an alert change alone asks "this one and the ones after" or "all of them".
    const s = await editingHome('en', { editor: withAlerts, item: (k) => (k === 'famcal|swim' ? ok200(swimInfo({ alert: 'default' })) : { status: 404, body: {} }) });
    try {
      await openItem(s.m, 'Swimming');
      s.m.click(byLabel(topDialog(s.m), 'Edit'));
      await settle();
      await typeInto(selects(s.m)[0], '10');
      s.m.click(saveButton(s.m));
      await settle();
      assertHas(topText(s.m), ['This one and the ones after'], 'the scope sheet offers the series choices');
      assertLacks(topText(s.m), ['Only this one'], 'no "only this one" for an alert');
      assertHas(topText(s.m), ['A calendar, alert or recipient change applies from here on or to all of them.'], 'the line names the alert');
    } finally {
      s.m.unmount();
    }
  });

  await check('#82 the scope sheet, for repeating items only: "This event repeats" with Only this one (date), This one and the ones after, Every Tuesday (or All of them with no short name); each choice sends its scope; Cancel returns to the editor; Delete asks the same three; a single item asks "Delete “title”?"', async () => {
    const swim = (o: Partial<ItemEditInfoResponse> = {}) => (key: string) => (key === 'famcal|swim' ? ok200(swimInfo(o)) : ({ status: 404, body: {} } as FetchAnswer));
    const { m } = await editingHome('en', { item: swim() });
    try {
      await openItem(m, 'Swimming');
      m.click(byLabel(topDialog(m), 'Edit'));
      await settle();
      assertHas(topText(m), ['Every Tuesday'], 'the series\' repeat in the Repeat row');
      await typeInto(inDialog(m, 'Location'), 'The pool');
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 0, 'nothing sent before the choice');
      const dlg = topDialog(m);
      assert(dlg.getAttribute('aria-label') === 'This event repeats', 'the scope sheet is a dialog');
      const choices = elements(dlg).filter((e) => e.localName === 'button').map((e) => e.textContent.trim());
      assert(show(choices) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'Every Tuesday', 'Cancel']), `choices: ${show(choices)}`);
      assertHas(topText(m), ['Swimming', 'Save the change to:'], 'the item named');
      tapIn(m, 'Cancel');
      assert(topDialog(m).getAttribute('aria-label') === 'Edit' && fieldValue(m, 'Location') === 'The pool', 'Cancel returns to the editor with its form');
      for (const [choice, scope] of [['This one and the ones after', 'following'], ['Every Tuesday', 'all'], ['Only this one (Tue 20 Oct)', 'single']] as const) {
        m.click(saveButton(m));
        await settle();
        tapIn(m, choice);
        await settle();
        const last = writes()[writes().length - 1];
        assert(last.method === 'PATCH' && last.body?.scope === scope && last.body?.key === 'famcal|swim#2026-10-20T14:00:00.000Z' || last.body?.key === 'famcal|swim', `${scope}: ${show(last.body)}`);
        assert(!byRole(m.container, 'dialog').some((d) => d.getAttribute('aria-label') === 'Edit'), `${scope}: the editor closed`);
        m.click(byLabel(topDialog(m), 'Edit'));
        await settle();
        await typeInto(inDialog(m, 'Location'), `The pool ${scope}`);
      }
      assert(writes().map((c) => c.body?.scope).join() === 'following,all,single', `scopes: ${writes().map((c) => c.body?.scope).join()}`);
      // A failure keeps the editor, and the message is above Save.
      serveEditingWith({ item: swim(), write: () => ({ status: 403, body: { error: 'not_allowed' } }) });
      m.click(saveButton(m));
      await settle();
      tapIn(m, 'Every Tuesday');
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'Edit' && alerts(m).includes('You can’t change this one'), `a refused save: ${show(alerts(m))}`);
    } finally {
      m.unmount();
    }
    // With no short name: all of them.
    const noShortName: [string, RepeatInfo][] = [
      ['monthly', { freq: 'monthly', interval: 1, byDay: [], ends: false }],
      ['a series cut by "following"', { freq: 'weekly', interval: 1, byDay: [], ends: true }],
      ['every other week', { freq: 'weekly', interval: 2, byDay: [], ends: false }],
    ];
    for (const [what, repeat] of noShortName) {
      const w = await editingHome('en', { item: swim({ series: { recurring: true, start: `${day(5)}T17:00`, repeat, fixedDays: false, zone: 'UTC' } }) });
      try {
        await openItem(w.m, 'Swimming');
        tapIn(w.m, 'Delete event');
        const choices = elements(topDialog(w.m)).filter((e) => e.localName === 'button').map((e) => e.textContent.trim());
        assert(show(choices) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'All of them', 'Cancel']), `${what}: ${show(choices)}`);
      } finally {
        w.m.unmount();
      }
    }
    const daily = await editingHome('en', { item: swim({ series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'daily', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC' } }) });
    try {
      await openItem(daily.m, 'Swimming');
      tapIn(daily.m, 'Delete event');
      assertHas(topText(daily.m), ['Every day'], 'a daily series: Every day');
    } finally {
      daily.m.unmount();
    }
    // Delete of a series: the same three choices; each sends its scope; the item sheet goes.
    const del = await editingHome('en', { item: swim() });
    try {
      await openItem(del.m, 'Swimming');
      tapIn(del.m, 'Delete event');
      assert(topDialog(del.m).getAttribute('aria-label') === 'This event repeats', 'the scope sheet asks');
      assertHas(topText(del.m), ['Delete:'], 'delete wording');
      del.world.week = { ...del.world.week, [day(5)]: del.world.week[day(5)].filter((i) => i.id !== 'swim') };
      const before = rangeCalls().length;
      tapIn(del.m, 'This one and the ones after');
      await settle();
      assert(writes().length === 1 && writes()[0].method === 'DELETE' && sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following' }), `delete body: ${show(writes()[0]?.body)}`);
      assert(!hasDialog(del.m), 'the sheets are gone');
      assert(rangeCalls().slice(before).some((c) => c.query.get('sources') === 'famcal'), 'FamCal is asked again');
    } finally {
      del.m.unmount();
    }
    // A single item: "Delete “Dentist”?"; Cancel sends nothing; Delete sends scope single.
    const one = await editingHome('en', { item: dentistInfo() });
    try {
      await openItem(one.m, 'Dentist');
      tapIn(one.m, 'Delete event');
      assert(topDialog(one.m).getAttribute('aria-label') === 'Delete “Dentist”?', `the question: ${topDialog(one.m).getAttribute('aria-label')}`);
      const choices = elements(topDialog(one.m)).filter((e) => e.localName === 'button').map((e) => e.textContent.trim());
      assert(show(choices) === show(['Delete', 'Cancel']), `buttons: ${show(choices)}`);
      tapIn(one.m, 'Cancel');
      await settle();
      assert(writes().length === 0 && topDialog(one.m).getAttribute('aria-label') === 'Details', 'Cancel sends nothing and keeps the item sheet');
      tapIn(one.m, 'Delete event');
      const hold = heldAnswer();
      serveEditingWith({ item: dentistInfo(), write: () => hold.promise });
      tapIn(one.m, 'Delete');
      await settle();
      assert(elements(topDialog(one.m)).filter((e) => e.localName === 'button').every((e) => e.hasAttribute('disabled') || e.textContent.trim() === 'Cancel'), 'Delete is disabled while it flies');
      await hold.release({ status: 500, body: {} });
      await settle();
      assert(topDialog(one.m).getAttribute('aria-label') === 'Delete “Dentist”?' && alerts(one.m).includes('Couldn’t save. Try again.'), `a failed delete says so: ${show(alerts(one.m))}`);
      serveEditingWith({ item: dentistInfo(), write: () => ok200({ status: 'ok' }) });
      tapIn(one.m, 'Delete');
      await settle();
      assert(writes().length === 2 && writes()[1].method === 'DELETE' && sameBody(writes()[1].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single' }), `body: ${show(writes()[1].body)}`);
      assert(!hasDialog(one.m), 'the item sheet closes after a delete');
    } finally {
      one.m.unmount();
    }
    // A reminder says Delete reminder, and the scope sheet says "This reminder repeats".
    const rem = await editingHome('en', { item: (k) => (k === 'famcal|recycling' ? ok200(swimInfo({ kind: 'reminder' })) : { status: 404, body: {} }) });
    try {
      await openItem(rem.m, 'Take out the recycling');
      tapIn(rem.m, 'Delete reminder');
      assert(topDialog(rem.m).getAttribute('aria-label') === 'This reminder repeats', 'the reminder wording');
    } finally {
      rem.m.unmount();
    }
  });

  await check('#82a a series whose rule fixes its days (the bot\'s "every Tuesday"): a change that moves the date offers only "Only this one", with a line on how to move them all, in en, he and ru; a new time of day, or a series that follows its start, keeps the three choices', async () => {
    const fixed = swimInfo({ series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, fixedDays: true, zone: 'UTC' } });
    const serve = (info: ItemEditInfoResponse) => (key: string) => (key === 'famcal|swim' ? ok200(info) : ({ status: 404, body: {} } as FetchAnswer));
    const choicesOf = (m: Home) => elements(topDialog(m)).filter((e) => e.localName === 'button').map((e) => e.textContent.trim());
    const NOTE = 'To move all of them to another day, delete the series and create it again.';
    const { m } = await editingHome('en', { item: serve(fixed), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openItem(m, 'Swimming');
      m.click(byLabel(topDialog(m), 'Edit'));
      await settle();
      await typeInto(inDialog(m, 'Start date'), day(7));
      m.click(saveButton(m));
      await settle();
      assert(show(choicesOf(m)) === show(['Only this one (Tue 20 Oct)', 'Cancel']), `a date move: ${show(choicesOf(m))}`);
      assertHas(topText(m), [NOTE], 'the line on moving them all');
      tapIn(m, 'Cancel');
      // Back on the start day, a new time of day: the three choices and no line.
      await typeInto(inDialog(m, 'Start date'), day(5));
      await typeInto(inDialog(m, 'Start time'), '18:00');
      m.click(saveButton(m));
      await settle();
      assert(show(choicesOf(m)) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'Every Tuesday', 'Cancel']), `a new time: ${show(choicesOf(m))}`);
      assertLacks(topText(m), [NOTE], 'no line for a new time');
      tapIn(m, 'Cancel');
      await typeInto(inDialog(m, 'Start date'), day(6));
      m.click(saveButton(m));
      await settle();
      tapIn(m, 'Only this one (Tue 20 Oct)');
      await settle();
      assert(writes().length === 1 && writes()[0].body?.scope === 'single' && writes()[0].body?.changes?.start === `${day(6)}T18:00`, `the one choice sends single: ${show(writes()[0]?.body)}`);
    } finally {
      m.unmount();
    }
    // A series that follows its start (what the editor writes) moves days for every scope.
    const plain = await editingHome('en', { item: serve(swimInfo()) });
    try {
      await openItem(plain.m, 'Swimming');
      plain.m.click(byLabel(topDialog(plain.m), 'Edit'));
      await settle();
      await typeInto(inDialog(plain.m, 'Start date'), day(7));
      plain.m.click(saveButton(plain.m));
      await settle();
      assert(choicesOf(plain.m).length === 4 && !topText(plain.m).includes(NOTE), `no fixed days: ${show(choicesOf(plain.m))}`);
    } finally {
      plain.m.unmount();
    }
    // The line in Hebrew and Russian.
    for (const [locale, note] of [['he', 'כדי להעביר את כל המופעים ליום אחר, צריך למחוק את הסדרה וליצור אותה מחדש.'], ['ru', 'Чтобы перенести их все на другой день, удалите серию и создайте её заново.']] as const) {
      const l = await editingHome(locale, { item: serve(fixed) });
      try {
        await openItem(l.m, 'Swimming');
        l.m.click(byLabel(topDialog(l.m), messages[locale].calendarHome.sheet.edit));
        await settle();
        await typeInto(inDialog(l.m, messages[locale].calendarHome.editor.startsDate), day(7));
        l.m.click(saveButton(l.m));
        await settle();
        assertHas(topText(l.m), [note], `${locale}: the line`);
        assert(choicesOf(l.m).length === 2, `${locale}: one choice and Cancel: ${show(choicesOf(l.m))}`);
      } finally {
        l.m.unmount();
      }
    }
  });

  await check('#82b the date move that limits a fixed-day series to "Only this one" is read in the series\' own zone, as the store reads it, not on the user\'s clock: the same day for the user can be another day there (and the reverse)', async () => {
    // A series kept in Jerusalem, seen from New York (seven hours behind until 25 October): 17:00 here is midnight there.
    const fixed = swimInfo({ series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, fixedDays: true, zone: 'Asia/Jerusalem' }, tz: 'America/New_York' });
    const serve = (key: string) => (key === 'famcal|swim' ? ok200(fixed) : ({ status: 404, body: {} } as FetchAnswer));
    const choicesOf = (m: Home) => elements(topDialog(m)).filter((e) => e.localName === 'button').map((e) => e.textContent.trim());
    const tryEdit = async (startDay: string, startTime: string) => {
      const { m } = await editingHome('en', { item: serve, write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
      try {
        await openItem(m, 'Swimming');
        m.click(byLabel(topDialog(m), 'Edit'));
        await settle();
        await typeInto(inDialog(m, 'Start date'), startDay);
        await typeInto(inDialog(m, 'Start time'), startTime);
        m.click(saveButton(m));
        await settle();
        return choicesOf(m).length;
      } finally {
        m.unmount();
      }
    };
    assert((await tryEdit(day(5), '16:00')) === 2, 'the same day here, the day before there: only this one');
    assert((await tryEdit(day(5), '18:00')) === 4, 'the same day here and there: the three choices');
    assert((await tryEdit(day(6), '00:30')) === 4, 'another day here, the same day there: the three choices');
    assert((await tryEdit(day(7), '17:00')) === 2, 'another day in both: only this one');
    // The pure rule, with a zone the clock of an all-day item does not touch.
    const at1 = editItemForm(fixed);
    assert(movesDay({ ...at1, startTime: '16:00' }, at1, 'America/New_York', 'Asia/Jerusalem'), 'the pure rule: 16:00');
    assert(!movesDay({ ...at1, startTime: '16:00' }, at1, 'Asia/Jerusalem', 'Asia/Jerusalem'), 'one zone: the same day');
    assert(movesDay({ ...at1, allDay: true, startDay: day(6) }, { ...at1, allDay: true }, 'America/New_York', 'Asia/Jerusalem'), 'all day: the day as written');
    assert(!movesDay({ ...at1, startDay: '2026-1' }, { ...at1, startDay: '2026-1' }, 'America/New_York', 'Asia/Jerusalem'), 'a day being typed is no move');
  });

  await check('#83 after a write the item sheet follows the store: a changed title shows when FamCal answers; a "following" edit or an "all" day move (a new key) shows the item under its new key once the refetch brings it, and closes only if it never does; an item that is gone (moved out of view, or deleted elsewhere) closes it once the edit\'s refetch has landed', async () => {
    const swim = (key: string) => (key === 'famcal|swim' ? ok200(swimInfo()) : ({ status: 404, body: {} } as FetchAnswer));
    const edited = { ...SWIM, title: 'Swimming lesson' };
    // Same key: the sheet shows the new title.
    const a = await editingHome('en', { item: dentistInfo(), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
    try {
      await openItem(a.m, 'Dentist');
      a.world.week = { ...a.world.week, [day(0)]: a.world.week[day(0)].map((i) => (i.id === 'dentist' ? { ...DENTIST, title: 'Dentist (moved)' } : i)) };
      a.m.click(byLabel(topDialog(a.m), 'Edit'));
      await settle();
      await typeInto(inDialog(a.m, 'Title'), 'Dentist (moved)');
      a.m.click(saveButton(a.m));
      await settle();
      assert(topDialog(a.m).getAttribute('aria-label') === 'Details' && topText(a.m).includes('Dentist (moved)'), `the sheet shows the change: ${topText(a.m).slice(0, 120)}`);
      assert(itemCalls().length === 2, `the edit info is asked again: ${itemCalls().length}`);
    } finally {
      a.m.unmount();
    }
    // A new key (following): the sheet moves to the new series' row once the refetch brings it.
    const NEW_KEY = 'famcal|swim2#2026-10-20T14:00:00.000Z';
    const b = await editingHome('en', { item: (key) => (key === NEW_KEY ? ok200(swimInfo({ occurrence: { ...swimInfo().occurrence, title: 'Swimming lesson' } })) : swim(key)), write: () => ok200({ status: 'ok', key: NEW_KEY }) });
    try {
      await openItem(b.m, 'Swimming');
      b.world.week = { ...b.world.week, [day(5)]: b.world.week[day(5)].map((i) => (i.id === 'swim' ? { ...SWIM, id: 'swim2', key: NEW_KEY, seriesId: 'swim2', title: 'Swimming lesson' } : i)) };
      b.m.click(byLabel(topDialog(b.m), 'Edit'));
      await settle();
      await typeInto(inDialog(b.m, 'Title'), 'Swimming lesson');
      b.m.click(saveButton(b.m));
      await settle();
      tapIn(b.m, 'This one and the ones after');
      await settle();
      assert(hasDialog(b.m) && topDialog(b.m).getAttribute('aria-label') === 'Details' && topText(b.m).includes('Swimming lesson'), `the sheet shows the new series' row: ${hasDialog(b.m) ? topText(b.m).slice(0, 120) : 'closed'}`);
      assert(editingKeys[editingKeys.length - 1] === NEW_KEY && sheetButtons(b.m).includes('Edit'), `its edit info is the new key's: ${show(editingKeys)}`);
    } finally {
      b.m.unmount();
    }
    // An "all" day move (Tuesday to Monday): the moved row, the sheet on it.
    const MOVED_KEY = 'famcal|swim#2026-10-19T14:00:00.000Z';
    const dm = await editingHome('en', { item: swim, write: () => ok200({ status: 'ok', key: MOVED_KEY }) });
    try {
      await openItem(dm.m, 'Swimming');
      dm.world.week = { ...dm.world.week, [day(5)]: dm.world.week[day(5)].filter((i) => i.id !== 'swim'), [day(4)]: [...dm.world.week[day(4)], { ...SWIM, key: MOVED_KEY, start: at(4, '17:00'), end: at(4, '18:00'), originalStart: at(4, '17:00') }] };
      dm.m.click(byLabel(topDialog(dm.m), 'Edit'));
      await settle();
      await typeInto(inDialog(dm.m, 'Start date'), day(4));
      dm.m.click(saveButton(dm.m));
      await settle();
      tapIn(dm.m, 'Every Tuesday');
      await settle();
      assert(hasDialog(dm.m) && topText(dm.m).includes('Mon 19 Oct 17:00'), `the sheet on the moved row: ${hasDialog(dm.m) ? topText(dm.m).slice(0, 160) : 'closed'}`);
      assert(editingKeys[editingKeys.length - 1] === MOVED_KEY, `asked for the moved key: ${show(editingKeys)}`);
    } finally {
      dm.m.unmount();
    }
    // A new key that the refetch doesn't bring (out of view): the sheet stays until that refetch lands, then closes.
    const lost = await editingHome('en', { item: swim, write: () => ok200({ status: 'ok', key: NEW_KEY }) });
    try {
      await openItem(lost.m, 'Swimming');
      lost.world.week = { ...lost.world.week, [day(5)]: lost.world.week[day(5)].filter((i) => i.id !== 'swim') };
      const held = gate();
      answerFetch = async (c) => {
        await held.promise;
        return answerFor(c, { items: lost.world.week });
      };
      lost.m.click(byLabel(topDialog(lost.m), 'Edit'));
      await settle();
      await typeInto(inDialog(lost.m, 'Title'), 'Swimming lesson');
      lost.m.click(saveButton(lost.m));
      await settle();
      tapIn(lost.m, 'This one and the ones after');
      await settle();
      assert(hasDialog(lost.m) && topDialog(lost.m).getAttribute('aria-label') === 'Details', 'the sheet waits for the refetch');
      await React.act(async () => held.release(ok200({})));
      await settle();
      assert(!hasDialog(lost.m), 'the refetch landed without it: the sheet closes');
    } finally {
      lost.m.unmount();
    }
    // Gone from the store after the refetch: it closes.
    const c = await editingHome('en', { item: dentistInfo(), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
    try {
      await openItem(c.m, 'Dentist');
      c.world.week = { ...c.world.week, [day(0)]: c.world.week[day(0)].filter((i) => i.id !== 'dentist') };
      c.m.click(byLabel(topDialog(c.m), 'Edit'));
      await settle();
      await typeInto(inDialog(c.m, 'Start date'), day(20));
      c.m.click(saveButton(c.m));
      await settle();
      assert(!hasDialog(c.m), 'the item sheet closes when its item has left the window');
    } finally {
      c.m.unmount();
    }
    void edited;
  });

  await check('#83a after an edit, only the edit\'s own refetch may close the sheet: a carry-over renamed, then marked Done, keeps its row and its Not done when the next refetch drops it; another item opened ends the watch', async () => {
    resetHome();
    fakeWindow.Telegram = { WebApp: fakeTelegramHome().webApp };
    const carry = item('passport', { kind: 'reminder', title: 'Renew the passport', seriesId: 'series_pp', start: at(-3, '10:00'), reminder: rem({ open: true, openSince: day(-3) }) });
    const renamed = { ...carry, title: 'Renew both passports' };
    live = { items: {}, carry: [carry] };
    serveReminders();
    const passportInfo = infoFor({ kind: 'reminder', occurrence: { start: `${day(-3)}T10:00`, end: `${day(-3)}T10:00`, allDay: false, title: 'Renew the passport', location: '', description: '' } });
    serveEditingWith({ item: (k) => (k === 'famcal|passport' ? ok200(passportInfo) : { status: 404, body: {} }), write: () => ok200({ status: 'ok', key: 'famcal|passport' }) });
    reminderReply = () => ok200({ status: 'ok', reminder: rem({ done: true, doneAt: DONE_AT, open: false }) });
    const c = await mountHome('en', {}, fakeClock('2026-10-15T10:00:00Z'));
    try {
      c.click(button(c.container, 'Renew the passport'));
      await settle();
      c.click(byLabel(topDialog(c), 'Edit'));
      await settle();
      await typeInto(inDialog(c, 'Title'), 'Renew both passports');
      live = { items: {}, carry: [renamed] };
      c.click(saveButton(c));
      await settle();
      assert(topDialog(c).getAttribute('aria-label') === 'Details' && topText(c).includes('Renew both passports'), `the sheet shows the new title: ${topText(c).slice(0, 120)}`);
      // Done: the refetch drops the carry-over; the sheet keeps it, done, with Not done.
      live = { items: {}, carry: [] };
      c.click(dialogButton(c, 'Done'));
      await settle();
      assert(hasDialog(c), 'the sheet closed after the Done that followed an edit');
      assertHas(dialogText(c.container), ['Renew both passports', 'Done at 13:05'], 'the kept row');
      assert(dialogButtons(c).includes('Not done'), `Not done is still there to undo: ${show(dialogButtons(c))}`);
    } finally {
      c.unmount();
    }
    // The watch ends with the sheet: an edit whose refetch is held, the sheet closed and another item opened, then the refetch lands without the first.
    const w = await editingHome('en', { item: dentistInfo(), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
    try {
      await openItem(w.m, 'Dentist');
      w.m.click(byLabel(topDialog(w.m), 'Edit'));
      await settle();
      await typeInto(inDialog(w.m, 'Title'), 'Dentist (moved)');
      const held = gate();
      answerFetch = async (c2) => {
        await held.promise;
        return answerFor(c2, { items: w.world.week });
      };
      w.world.week = { ...w.world.week, [day(0)]: w.world.week[day(0)].filter((i) => i.id !== 'dentist') };
      w.m.click(saveButton(w.m));
      await settle();
      tapIn(w.m, 'Close');
      await settle();
      await openItem(w.m, 'Football practice');
      await React.act(async () => held.release(ok200({})));
      await settle();
      assert(hasDialog(w.m) && topText(w.m).includes('Football practice'), 'the other item\'s sheet stays');
    } finally {
      w.m.unmount();
    }
  });

  await check('#84 Cancel and Telegram\'s BackButton: Cancel closes at once when nothing changed and asks "Discard your changes?" after a change; Keep editing returns; the BackButton shows with the editor and does the same, closing a sheet on top first (the scope sheet, then the editor); Escape cancels too; the item sheet behind stays', async () => {
    const swim = (key: string) => (key === 'famcal|swim' ? ok200(swimInfo()) : ({ status: 404, body: {} } as FetchAnswer));
    const { m, tg } = await editingHome('en', { item: swim });
    try {
      tapPlus(m);
      await settle();
      assert(tg.calls.includes('BackButton.show()') && tg.backHandlers() === 1, 'the BackButton shows with the editor');
      tapIn(m, 'Cancel');
      assert(!hasDialog(m), 'Cancel on an untouched form closes it');
      tapPlus(m);
      await settle();
      await typeInto(inDialog(m, 'Title'), 'Half written');
      tapIn(m, 'Cancel');
      assert(topDialog(m).getAttribute('aria-label') === 'Discard your changes?', 'asks to discard');
      assert(show(elements(topDialog(m)).filter((e) => e.localName === 'button').map((e) => e.textContent.trim())) === show(['Discard', 'Keep editing']), 'Discard or Keep editing');
      tapIn(m, 'Keep editing');
      assert(topDialog(m).getAttribute('aria-label') === 'New' && fieldValue(m, 'Title') === 'Half written', 'Keep editing returns to the form');
      // The BackButton asks the same.
      await React.act(async () => tg.fire('backButtonClicked'));
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'Discard your changes?', 'the BackButton asks to discard');
      await React.act(async () => tg.fire('backButtonClicked'));
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'New', 'a second back closes the question');
      m.key(topDialog(m), 'Escape');
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'Discard your changes?', 'Escape cancels too');
      tapIn(m, 'Discard');
      assert(!hasDialog(m) && writes().length === 0, 'discarded: nothing sent');
      assert(tg.calls.includes('BackButton.hide()'), 'the BackButton hides again');
      // From the item sheet: the scope sheet closes first, then the editor, then the item sheet.
      await openItem(m, 'Swimming');
      m.click(byLabel(topDialog(m), 'Edit'));
      await settle();
      await typeInto(inDialog(m, 'Title'), 'Swim');
      m.click(saveButton(m));
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'This event repeats', 'the scope sheet');
      await React.act(async () => tg.fire('backButtonClicked'));
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'Edit', 'back closed the scope sheet only');
      await React.act(async () => tg.fire('backButtonClicked'));
      await settle();
      tapIn(m, 'Discard');
      assert(topDialog(m).getAttribute('aria-label') === 'Details', 'the item sheet is still there');
      await React.act(async () => tg.fire('backButtonClicked'));
      await settle();
      assert(!hasDialog(m), 'and the BackButton closes it');
      // A delete question closes with back, too.
      await openItem(m, 'Swimming');
      tapIn(m, 'Delete event');
      await React.act(async () => tg.fire('backButtonClicked'));
      await settle();
      assert(topDialog(m).getAttribute('aria-label') === 'Details' && writes().length === 0, 'back cancels the delete question');
    } finally {
      m.unmount();
    }
  });

  await check('#85 the editing copy in en, he and ru: no untranslated key in the editor, the scope sheet, the discard and delete questions; dir="rtl" in Hebrew with the time pills left to right; the Hebrew and Russian copy is translated', async () => {
    for (const locale of LOCALES) {
      const swim = (key: string) => (key === 'famcal|swim' ? ok200(swimInfo()) : ({ status: 404, body: {} } as FetchAnswer));
      const { m } = await editingHome(locale, { item: swim });
      try {
        const l = messages[locale].calendarHome;
        const seen: string[] = [];
        const look = (what: string) => {
          const html = htmlOf(topDialog(m));
          assertLacks(html + textOf(html), ['calendarHome.', '[missing', 'undefined'], `${locale} ${what}`);
          seen.push(textOf(html));
        };
        const cancelBtn = () => elements(topDialog(m)).find((e) => e.className.includes('ch-editor-cancel')) as Fake;
        const sheetBtns = () => elements(topDialog(m)).filter((e) => e.localName === 'button');
        m.click(byLabel(m.container, l.header.add));
        await settle();
        look('new event');
        assert(topDialog(m).getAttribute('aria-label') === l.editor.titleNew, `${locale}: the editor is named ${l.editor.titleNew}`);
        assert(m.html().startsWith('<div class="ch-home" data-theme="light" dir="' + (locale === 'he' ? 'rtl' : 'ltr') + '"'), `${locale}: the root's direction`);
        assert(elements(topDialog(m)).filter((e) => e.getAttribute('data-pill') === 'time').every((e) => e.getAttribute('dir') === 'ltr'), `${locale}: times run left to right`);
        m.click(byRole(topDialog(m), 'radio').find((e) => e.textContent === l.editor.kind.reminder) as Fake);
        look('new reminder');
        m.click(byRole(topDialog(m), 'radio').find((e) => e.textContent === l.editor.kind.event) as Fake);
        await typeInto(inDialog(m, l.editor.fields.title), 'x');
        m.click(cancelBtn());
        look('discard');
        m.click(sheetBtns()[sheetBtns().length - 1]); // keep editing
        assert(topDialog(m).getAttribute('aria-label') === l.editor.titleNew, `${locale}: back in the editor`);
        m.click(cancelBtn());
        m.click(sheetBtns()[0]); // discard
        assert(!hasDialog(m), `${locale}: discarded`);
        await openItem(m, 'Swimming');
        look('item sheet');
        m.click(byLabel(topDialog(m), l.sheet.edit));
        await settle();
        look('edit');
        await typeInto(inDialog(m, l.editor.fields.title), 'Swim');
        m.click(saveButton(m));
        await settle();
        look('scope (save)');
        assertHas(seen[seen.length - 1], [l.scope.save.event, l.scope.following, l.scope.save.ask], `${locale} scope copy`);
        m.click(sheetBtns()[sheetBtns().length - 1]); // cancel
        m.click(cancelBtn());
        m.click(sheetBtns()[0]); // discard
        m.click(elements(topDialog(m)).find((e) => e.className.includes('ch-sheet-delete')) as Fake);
        look('scope (delete)');
        assertHas(seen[seen.length - 1], [l.scope.delete.ask], `${locale} delete copy`);
        if (locale !== 'en') {
          for (const key of ['editor.save', 'editor.cancel', 'scope.following', 'scope.cancel', 'editor.discard.title'] as const) {
            const get = (loc: Locale) => key.split('.').reduce<Row>((o, k) => o[k], messages[loc].calendarHome) as unknown as string;
            assert(get(locale) !== get('en'), `${locale}: ${key} is translated`);
          }
        }
      } finally {
        m.unmount();
      }
    }
  });

  await check('#86 the form kit\'s CSS (spec §4): every tap at least 44 px, nothing under 11 px, logical properties only, no hover, the date and time pills and the select over a value row, the editor panel full height with a sticky Save bar', () => {
    const css = [FORM_CSS, HOME_THEME_CSS, AGENDA_CSS].join('\n');
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule for ${selector}`);
      return m[1];
    };
    for (const selector of ['.ch-pill', '.ch-segment', '.ch-radio', '.ch-editor-cancel']) {
      const min = /min-block-size:\s*(\d+)px/.exec(rule(selector));
      assert(min && Number(min[1]) >= 44, `${selector} min-block-size ${min?.[1]}`);
    }
    for (const selector of ['.ch-form-row', '.ch-form-field', '.ch-scope-choice', '.ch-save']) {
      const min = /min-block-size:\s*(\d+)px/.exec(rule(selector));
      assert(min && Number(min[1]) >= 44, `${selector} min-block-size ${min?.[1]}`);
    }
    assert(/\.ch-icon-btn \{[^}]*block-size: 44px/.test(HOME_SHELL_CSS), '.ch-icon-btn 44 px')
    const physical = FORM_CSS.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:|(?:^|[\s;{])(?:width|height)\s*:|(?:min|max)-(?:width|height)\s*:/gm);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(FORM_CSS), 'no hover styles');
    assert([...FORM_CSS.matchAll(/font-size:\s*(\d+)px/g)].every((m) => Number(m[1]) >= 11), 'nothing under 11 px');
    assert(/\.ch-form-select \{[^}]*opacity:\s*0[^}]*\}/.test(FORM_CSS) && /\.ch-form-select \{[^}]*inset:\s*0/.test(FORM_CSS), 'the select sits over the row');
    assert(/\.ch-sheet-full \{[^}]*flex:\s*1[^}]*max-block-size:\s*none/.test(HOME_THEME_CSS), 'the editor panel fills the screen');
    assert(/\.ch-save-bar \{[^}]*flex:\s*none/.test(FORM_CSS) && /\.ch-editor-body \{[^}]*overflow-y:\s*auto/.test(FORM_CSS), 'a scrolling body over a fixed Save bar');
    assert(/prefers-reduced-motion/.test(HOME_THEME_CSS), 'reduced motion');
  });

  await check('#87 React logged no warning in #74-#86 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeEditing, `React warned: ${show(reactWarnings.slice(warnedBeforeEditing, warnedBeforeEditing + 3))}`);
  });

  // ---- Hebrew holidays on the home (Hebrew holidays spec §5; #88-#95) ----

  const warnedBeforeHolidays = reactWarnings.length;
  type Hol = { title: string; brief: string; chag: boolean; kind: string };
  const hol = (title: string, kind: string, brief = title): Hol => ({ title, brief, chag: kind === 'chag', kind });
  /** The holidays each language's fake route knows, by day: a yom tov today, two minor ones tomorrow, and cells of October and September. */
  const HOLIDAYS: Record<Locale, Record<DayKey, Hol[]>> = {
    en: {
      [day(0)]: [hol('Shmini Atzeret', 'chag')],
      [day(1)]: [hol('Chanukah: 8 Candles', 'minor'), hol('Rosh Chodesh Tevet', 'roshChodesh')],
      '2026-10-01': [hol("Sukkot VI (CH''M)", 'cholHamoed', 'Sukkot VI')],
      '2026-10-12': [hol('Rosh Chodesh Cheshvan', 'roshChodesh')],
      '2026-10-20': [hol('Yom HaZikaron', 'modern')],
      '2026-09-12': [hol('Rosh Hashana 5787', 'chag')],
    },
    he: {
      [day(0)]: [hol('שמיני עצרת', 'chag')],
      [day(1)]: [hol('חנוכה: ח׳ נרות', 'minor'), hol('ראש חודש טבת', 'roshChodesh')],
      '2026-10-12': [hol('ראש חודש חשון', 'roshChodesh')],
      '2026-10-20': [hol('יום הזכרון', 'modern')],
      '2026-09-12': [hol('ראש השנה תשפ״ז', 'chag')],
    },
    ru: {
      [day(0)]: [hol('Шмини Ацерет', 'chag')],
      [day(1)]: [hol('Ханука: 8 Свечей', 'minor'), hol('Рош ходеш Тевет', 'roshChodesh')],
      '2026-10-12': [hol('Рош ходеш Хешван', 'roshChodesh')],
      '2026-10-20': [hol('День памяти павших', 'modern')],
      '2026-09-12': [hol('Рош а-Шана 5787', 'chag')],
    },
  };
  /** The fake route: the fixtures of the requested language inside [from, to]. */
  const serveFixtures = (c: FetchCall): FetchAnswer => {
    const lang = (c.query.get('lang') ?? 'en') as Locale;
    const from = c.query.get('from') ?? '';
    const to = c.query.get('to') ?? '';
    const days = Object.fromEntries(Object.entries(HOLIDAYS[lang] ?? {}).filter(([k]) => k >= from && k <= to));
    return ok200({ days });
  };
  const asked = () => holidayCalls.map((c) => `${c.query.get('from')}→${c.query.get('to')} ${c.query.get('lang')}`);
  const headSubs = (m: Home) => byClass(m.container, 'ch-head-sub');
  const dayHead = (m: Home, dayKey: DayKey) => {
    const found = elements(m.container).find((e) => e.getAttribute('id') === `ch-day-${dayKey}`);
    assert(found, `no header for ${dayKey}`);
    return found;
  };
  const holidayIn = (el: FakeNode) => byClass(el, 'ch-day-holiday')[0];
  const list = (locale: Locale, titles: string[]) => new Intl.ListFormat(locale, { style: 'long', type: 'unit' }).format(titles);

  await check('#88 the header and the Agenda name the day\'s holidays in en, he and ru: after the Hebrew date, the titles joined as the language lists things, bidi-isolated, a yom tov in the accent; one request for the month, in the language, however many views ask', async () => {
    for (const locale of LOCALES) {
      resetHome();
      serveHolidays = serveFixtures;
      answerFetch = (c) => answerFor(c, { items: WEEK });
      const m = await mountHome(locale);
      try {
        assert(show(asked()) === show([`2026-10-01→2026-10-31 ${locale}`]), `${locale}: one request for October: ${show(asked())}`);
        const [today, tomorrow] = [HOLIDAYS[locale][day(0)], HOLIDAYS[locale][day(1)]];
        // The header: its own line after the Hebrew date, the yom tov in the accent.
        const subs = headSubs(m);
        assert(subs.length === 2 && !subs[0].className.includes('ch-day-holiday'), `${locale}: the Hebrew date, then the holiday line: ${show(subs.map((e) => e.className))}`);
        assert(subs[1].className === 'ch-head-sub ch-day-holiday is-chag', `${locale}: today's line: ${subs[1].className}`);
        assert(htmlOf(subs[1]) === `<p class="ch-head-sub ch-day-holiday is-chag"><bdi>${today[0].title}</bdi></p>`, `${locale}: ${htmlOf(subs[1])}`);
        // The Agenda's day headers: the title in today's header (a yom tov), two joined in tomorrow's.
        const first = holidayIn(dayHead(m, day(0)));
        assert(first?.className === 'ch-day-holiday is-chag' && htmlOf(first) === `<span class="ch-day-holiday is-chag"><bdi>${today[0].title}</bdi></span>`, `${locale}: ${first && htmlOf(first)}`);
        const second = holidayIn(dayHead(m, day(1)));
        assert(second?.className === 'ch-day-holiday', `${locale}: tomorrow isn't a yom tov: ${second?.className}`);
        assert(second.textContent === list(locale, tomorrow.map((h) => h.title)), `${locale}: ${second.textContent} vs ${list(locale, tomorrow.map((h) => h.title))}`);
        assert(second.textContent.includes(', ') || locale === 'en' || second.textContent.includes(' '), `${locale}: a list`);
        // A day with none has no span, and the Hebrew date is still before the holiday.
        assert(!holidayIn(dayHead(m, day(4))), 'a day without a holiday has no span');
        const head = htmlOf(dayHead(m, day(0)));
        assert(head.indexOf('ch-day-hebrew') > 0 && head.indexOf('ch-day-hebrew') < head.indexOf('ch-day-holiday'), `${locale}: the holiday follows the Hebrew date: ${head}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#88a holidays never hold the home back: the Agenda and header show while the holidays are still on their way, and the holidays join them when they land', async () => {
    resetHome();
    let land: (a: FetchAnswer) => void = noop;
    serveHolidays = () => new Promise<FetchAnswer>((resolve) => { land = resolve; });
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en');
    try {
      assertHas(m.text(), ['Dentist', 'Grandma visits', '4 Cheshvan 5787'], 'the home, before the holidays');
      assert(holidayCalls.length === 1 && !/ch-day-holiday/.test(markup(m.html())), 'asked, nothing shown yet');
      await React.act(async () => land(serveFixtures(holidayCalls[0])));
      await settle();
      assert(/Shmini Atzeret/.test(m.text()) && byClass(m.container, 'ch-day-holiday').length === 4, `the holidays arrived (the header, and the three days of the week that have one): ${show(byClass(m.container, 'ch-day-holiday').map(htmlOf))}`);
      assert(holidayCalls.length === 1, 'and were not asked again');
    } finally {
      m.unmount();
    }
  });

  await check('#88c the countdown under the Hebrew date on a day with no holiday line, in en, he and ru: the base name first, "tomorrow" the day before, counted in whole days from the server\'s today; none on a holiday day, with Hebrew dates off, and nothing (logged) when the request fails', async () => {
    const COPY: Record<Locale, { name: string; far: string; tomorrow: string }> = {
      en: { name: 'Chanukah', far: 'Chanukah in 12 days', tomorrow: 'Chanukah tomorrow' },
      he: { name: 'חנוכה', far: 'חנוכה בעוד 12 ימים', tomorrow: 'חנוכה מחר' },
      ru: { name: 'Ханука', far: 'Ханука через 12 дней', tomorrow: 'Ханука завтра' },
    };
    const nextCalls = () => holidayCalls.filter((c) => c.query.has('next'));
    const serveNext = (names: (typeof COPY)[Locale], on: DayKey): ((c: FetchCall) => FetchAnswer) => (c) => c.query.has('next') ? ok200({ next: { day: on, name: names.name } }) : ok200({ days: {} });
    const countdown = (m: Home, locale: Locale) => headSubs(m).filter((e) => e.textContent.includes(COPY[locale].name));
    for (const locale of LOCALES) {
      // Twelve days out: the line follows the Hebrew date, bidi-isolated, muted (the plain sub-line).
      resetHome();
      serveHolidays = serveNext(COPY[locale], day(12));
      answerFetch = (c) => answerFor(c, { items: WEEK });
      let m = await mountHome(locale);
      try {
        await settle();
        assert(show(nextCalls().map((c) => `${c.query.get('next')} ${c.query.get('lang')}`)) === show([`${day(0)} ${locale}`]), `${locale}: one next request, from the server's today: ${show(nextCalls().map((c) => c.query.toString()))}`);
        const [line] = countdown(m, locale);
        assert(countdown(m, locale).length === 1 && htmlOf(line) === `<p class="ch-head-sub"><bdi>${COPY[locale].far}</bdi></p>`, `${locale}: ${show(headSubs(m).map(htmlOf))}`);
        const subs = headSubs(m);
        assert(subs.length === 2 && subs[1] === line && !subs[0].className.includes('ch-day-holiday'), `${locale}: the Hebrew date, then the countdown`);
      } finally {
        m.unmount();
      }
      // The day before.
      resetHome();
      serveHolidays = serveNext(COPY[locale], day(1));
      answerFetch = (c) => answerFor(c, { items: WEEK });
      m = await mountHome(locale);
      try {
        await settle();
        assert(countdown(m, locale).length === 1 && countdown(m, locale)[0].textContent === COPY[locale].tomorrow, `${locale}: tomorrow: ${show(headSubs(m).map(htmlOf))}`);
      } finally {
        m.unmount();
      }
    }
    // A holiday day shows its holiday line and asks for no countdown.
    resetHome();
    serveHolidays = (c) => c.query.has('next') ? ok200({ next: { day: day(12), name: 'Chanukah' } }) : serveFixtures(c);
    answerFetch = (c) => answerFor(c, { items: WEEK });
    let m = await mountHome('en');
    try {
      await settle();
      assert(nextCalls().length === 0 && !/Chanukah in/.test(m.text()) && /Shmini Atzeret/.test(m.text()), `a holiday day: ${show(asked())}, ${show(headSubs(m).map(htmlOf))}`);
    } finally {
      m.unmount();
    }
    // Hebrew dates off: no request, no line.
    resetHome();
    serveHolidays = serveNext(COPY.en, day(12));
    answerFetch = (c) => answerFor(c, { items: WEEK, hebrewDates: false });
    m = await mountHome('en');
    try {
      await settle();
      assert(holidayCalls.length === 0 && !/Chanukah/.test(m.text()), `Hebrew dates off: ${show(asked())}`);
    } finally {
      m.unmount();
    }
    // A failed request logs and shows nothing.
    for (const failure of [{ status: 500, body: { error: 'failed' } }, { status: 200, body: { next: 'soon' } }] as FetchAnswer[]) {
      resetHome();
      serveHolidays = (c) => c.query.has('next') ? failure : ok200({ days: {} });
      answerFetch = (c) => answerFor(c, { items: WEEK });
      const logged = appLogs.length;
      m = await mountHome('en');
      try {
        await settle();
        const lines = appLogs.slice(logged).filter((l) => l.startsWith('[holidays] next'));
        assert(lines.length === 1 && lines[0].includes(`next after ${day(0)} (en) failed`), `one log line: ${show(lines)}`);
        assert(headSubs(m).length === 1, `nothing shown: ${show(headSubs(m).map(htmlOf))}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#89 with Hebrew dates off there are no holidays: no request, no line, no span, on the Agenda or the Month', async () => {
    resetHome();
    serveHolidays = serveFixtures;
    answerFetch = (c) => answerFor(c, { items: WEEK, hebrewDates: false });
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await tap(m, tabButton(m, 'agenda'));
      assert(holidayCalls.length === 0, `no request: ${show(asked())}`);
      assert(!/ch-day-holiday|has-chag|Shmini Atzeret/.test(markup(m.html())), 'nothing shown');
      await openMonth(m);
      assert(holidayCalls.length === 0 && !/Yom HaZikaron|Shmini Atzeret/.test(markup(m.html())), `nothing on the Month: ${show(asked())}`);
    } finally {
      m.unmount();
    }
  });

  await check('#90 a failed holidays request (500, no connection, a garbled answer) shows nothing and logs the month and status, the home carries on, and the failure is not remembered: the next view of the month asks again and shows them', async () => {
    for (const failure of [{ status: 500, body: { error: 'failed' } }, 'throw', { status: 200, body: { days: [] } }, { status: 200, body: { days: { [day(0)]: [{ title: 1 }] } } }] as FetchAnswer[]) {
      resetHome();
      serveHolidays = () => failure;
      answerFetch = (c) => answerFor(c, { items: WEEK });
      const logged = appLogs.length;
      fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'agenda');
      const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
      try {
        assertHas(m.text(), ['Dentist', 'Grandma visits'], `the home, ${show(failure)}`);
        assert(!/ch-day-holiday/.test(markup(m.html())), `nothing shown: ${show(failure)}`);
        const lines = appLogs.slice(logged).filter((l) => l.startsWith('[holidays]'));
        assert(lines.length === 1 && lines[0].includes('2026-10 (en) failed'), `one log line with the month: ${show(lines)}`);
        if (typeof failure === 'object' && failure.status === 500) assert(lines[0].includes('with 500'), `and the status: ${lines[0]}`);
        // Not remembered: the Month asks October again, and this time it answers.
        serveHolidays = serveFixtures;
        await openMonth(m);
        assert(asked().filter((a) => a.startsWith('2026-10-01')).length === 2, `October is asked again: ${show(asked())}`);
        assert(byClass(m.container, 'ch-mb-hmonth').some((e) => e.textContent === 'Yom HaZikaron'), 'and the holidays show');
      } finally {
        m.unmount();
      }
    }
  });

  await check('#90a a month whose holidays request failed is asked again when the month in view changes, even though its grid never unmounted: October fails, the user scrolls to November and back, and October is asked a second time and shows its holidays', async () => {
    resetHome();
    serveHolidays = () => ({ status: 502, body: { error: 'deploying' } });
    answerFetch = (c) => answerFor(c, { items: WEEK });
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await settle();
      flushFrames();
      await settle();
      const octAsks = () => asked().filter((a) => a.startsWith('2026-10-01')).length;
      assert(octAsks() >= 1, `October was asked: ${show(asked())}`);
      assert(!byClass(m.container, 'ch-mb-hmonth').some((e) => e.textContent === 'Yom HaZikaron'), 'and failed: no holiday yet');
      const before = octAsks();
      serveHolidays = serveFixtures;
      scrollPageTo(inViewAt('2026-11'));
      await settle();
      scrollPageTo(inViewAt('2026-10'));
      await settle();
      flushFrames();
      await settle();
      assert(octAsks() === before + 1, `October is asked again after the month in view changed: ${before} then ${octAsks()}: ${show(asked())}`);
      assert(byClass(m.container, 'ch-mb-hmonth').some((e) => e.textContent === 'Yom HaZikaron'), 'and the holidays show');
    } finally {
      m.unmount();
    }
  });

  await check('#91 the Month\'s cell: the second line holds the day\'s highest-priority holiday (brief), a yom tov in the accent; a Hebrew month\'s first day keeps the month name, except under a yom tov (1 Tishrei shows Rosh Hashana); the month\'s first cell gives its name up to a holiday; the aria label names the titles; the line is one dir=auto ellipsis line', async () => {
    resetHome();
    serveHolidays = serveFixtures;
    answerFetch = (c) => answerFor(c, { items: WEEK });
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await settle();
      flushFrames();
      await settle();
      const line = (dayKey: DayKey) => byClass(dayButton(m, dayKey), 'ch-mb-hmonth')[0];
      // A plain holiday: its brief, muted.
      assert(line('2026-10-20').textContent === 'Yom HaZikaron' && line('2026-10-20').className === 'ch-mb-hmonth' && line('2026-10-20').getAttribute('dir') === 'auto', `a modern day: ${htmlOf(line('2026-10-20'))}`);
      assert((dayButton(m, '2026-10-20').getAttribute('aria-label') ?? '').includes('Yom HaZikaron'), `the label names it: ${dayButton(m, '2026-10-20').getAttribute('aria-label')}`);
      // 1 Cheshvan: Rosh Chodesh is implied, the month name stays.
      assert(line('2026-10-12').textContent === 'Chesh.' && line('2026-10-12').className === 'ch-mb-hmonth', `1 Cheshvan: ${htmlOf(line('2026-10-12'))}`);
      assert((dayButton(m, '2026-10-12').getAttribute('aria-label') ?? '').includes('Rosh Chodesh Cheshvan'), 'but the label still names Rosh Chodesh');
      // The month's first cell (Hebrew day 19, not a Hebrew month start): the holiday takes the line, with its brief.
      assert(line('2026-10-01').textContent === 'Sukkot VI', `the first cell: ${htmlOf(line('2026-10-01'))}`);
      assert((dayButton(m, '2026-10-01').getAttribute('aria-label') ?? '').includes("Sukkot VI (CH''M)"), 'and the label has the full title');
      // 1 Tishrei: a yom tov takes the line from the month name, in the accent.
      assert(line('2026-09-12').textContent === 'Rosh Hashana 5787' && line('2026-09-12').className === 'ch-mb-hmonth has-chag', `1 Tishrei: ${htmlOf(line('2026-09-12'))}`);
      // A day with none keeps what it had: nothing on a plain day, a month name on a Hebrew day 1.
      assert(line('2026-10-17').textContent === '' && line('2026-10-17').getAttribute('dir') === null, `a plain day, nothing: ${htmlOf(line('2026-10-17'))}`);
      // The cell's height is the browse math's: the line's size and the cell are untouched.
      assert(/\.ch-mb-hmonth \{[^}]*block-size: 13px[^}]*white-space: nowrap[^}]*overflow: hidden[^}]*text-overflow: ellipsis/.test(MONTH_BROWSE_CSS), 'one ellipsis line of 13 px');
      assert(/\.ch-mb-hmonth\.has-chag \{\s*color: var\(--ch-accent\);\s*\}/.test(MONTH_BROWSE_CSS), 'a yom tov reads the accent');
    } finally {
      m.unmount();
    }
  });

  await check('#91a the Month\'s cell in he and ru: the line holds the brief in the page\'s language (a Hebrew Rosh Chodesh keeps the month name in Hebrew), the label has the titles', async () => {
    for (const locale of ['he', 'ru'] as const) {
      resetHome();
      serveHolidays = serveFixtures;
      answerFetch = (c) => answerFor(c, { items: WEEK });
      fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
      const m = await mountHome(locale, {}, fakeClock('2026-10-15T07:00:00Z'));
      try {
        await settle();
        flushFrames();
        await settle();
        const cell = (dayKey: DayKey) => {
          const found = byClass(byData(m.container, 'month', dayKey.slice(0, 7)), 'ch-mb-cell').find((e) => (e.getAttribute('aria-label') ?? '').startsWith(formatDayLong(dayKey, locale)));
          assert(found, `${locale}: no cell for ${dayKey}`);
          return found;
        };
        const line = (dayKey: DayKey) => byClass(cell(dayKey), 'ch-mb-hmonth')[0];
        assert(line('2026-10-20').textContent === HOLIDAYS[locale]['2026-10-20'][0].brief, `${locale}: ${line('2026-10-20').textContent}`);
        assert(line('2026-09-12').className === 'ch-mb-hmonth has-chag' && line('2026-09-12').textContent === HOLIDAYS[locale]['2026-09-12'][0].brief, `${locale}: 1 Tishrei: ${htmlOf(line('2026-09-12'))}`);
        assert(/[א-ת]/.test(line('2026-10-12').textContent) === (locale === 'he') && line('2026-10-12').className === 'ch-mb-hmonth', `${locale}: 1 Cheshvan keeps the month: ${line('2026-10-12').textContent}`);
        assert((cell('2026-10-20').getAttribute('aria-label') ?? '').includes(HOLIDAYS[locale]['2026-10-20'][0].title), `${locale}: the label`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#92 the picked day\'s header names the holidays after its Hebrew date, a yom tov in the accent, bidi-isolated; the compact grid has no holiday line', async () => {
    resetHome();
    serveHolidays = serveFixtures;
    answerFetch = (c) => answerFor(c, { items: WEEK });
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await settle();
      flushFrames();
      await settle();
      await tap(m, dayButton(m, '2026-10-20'));
      assert(pickedShown(m), 'picked');
      const head = byClass(m.container, 'ch-mp-day')[0];
      assert(htmlOf(holidayIn(head)) === '<span class="ch-day-holiday"><bdi>Yom HaZikaron</bdi></span>', `${htmlOf(head)}`);
      assert(htmlOf(head).indexOf('ch-mp-day-hebrew') < htmlOf(head).indexOf('ch-day-holiday'), 'after the Hebrew date');
      await tap(m, byClass(m.container, 'ch-mp-cell').find((e) => (e.getAttribute('aria-label') ?? '').startsWith(formatDayLong(day(0), 'en'))) as FakeElement);
      assert(holidayIn(byClass(m.container, 'ch-mp-day')[0])?.className === 'ch-day-holiday is-chag', "today's yom tov reads the accent");
      assert(byClass(m.container, 'ch-mp-cell').every((e) => !/Shmini|Zikaron/.test(e.textContent)), 'no holiday line in the compact grid');
    } finally {
      m.unmount();
    }
  });

  await check('#93 the holidays\' client is client-safe and the CSS follows the home\'s rules: holidays-client.ts loads only react, the grid and the wire types (never @hebcal/core or the server module); logical properties, no hover, nothing under 11 px; yom tov titles read --ch-accent, the rest --ch-muted', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/holidays-client.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map((m) => `${m[1] ? 'type ' : ''}${m[2]}`);
    assert(show(imports.sort()) === show(['./grid', 'react', 'type ./types']), `imports: ${show(imports)}`);
    const walk = (id: string, seen = new Set<string>()): Set<string> => {
      for (const child of require.cache[id]?.children ?? []) if (!seen.has(child.id)) { seen.add(child.id); walk(child.id, seen); }
      return seen;
    };
    const client = path.join(ROOT, 'src/lib/calendar-view/holidays-client.ts');
    assert(require.cache[client] !== undefined, 'holidays-client.ts is not in require.cache: the check would be empty');
    const loaded = [...walk(client)];
    assert(!loaded.some((id) => /@hebcal|hebrew-holidays|node_modules\/(?:@prisma|ioredis|@upstash)/.test(id)), `server code reached: ${show(loaded.filter((id) => /@hebcal|hebrew-holidays/.test(id)))}`);
    for (const view of ['MonthBrowse', 'DayList', 'MonthPicked', 'HomeHeader']) {
      const file = fs.readFileSync(path.join(ROOT, `app/[locale]/dashboard/${view}.tsx`), 'utf8');
      assert(/holidays-client/.test(file) && !/@hebcal\/core|services\/hebrew-holidays/.test(file), `${view} reads holidays-client only`);
    }
    const css = [HOME_THEME_CSS, MONTH_BROWSE_CSS].join('\n');
    assert(/\.ch-day-holiday \{\s*color: var\(--ch-muted\);\s*\}/.test(HOME_THEME_CSS) && /\.ch-day-holiday\.is-chag \{\s*color: var\(--ch-accent\);\s*\}/.test(HOME_THEME_CSS), 'the colours');
    const holidayCss = [...css.matchAll(/[^{}]*(?:ch-day-holiday|has-chag)[^{}]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
    assert(holidayCss.length > 0 && !/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|(?:^|[\s;{])(?:width|height)\s*:/.test(holidayCss), `physical properties in ${holidayCss}`);
    // The holiday span is a flex item of a wrapping header: a dot drawn inside it would start the wrapped line, so the 8px gap alone separates it.
    assert(!/ch-day-holiday[^{]*::(?:before|after)/.test(css), 'no separator pseudo-element on the holiday span (a wrapped line would start with a stray dot)');
    assert(!/:hover/.test(holidayCss) && [...holidayCss.matchAll(/font-size:\s*(\d+)px/g)].every((m) => Number(m[1]) >= 11), 'no hover, nothing under 11 px');
  });

  await check('#94 React logged no warning in #88-#93 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeHolidays, `React warned: ${show(reactWarnings.slice(warnedBeforeHolidays, warnedBeforeHolidays + 3))}`);
  });

  // ---- Editing step 3b in the home: repeat, calendar and recipient on edit, Google items (3b spec §2, §4, §5; #95-#103) ----

  const warnedBefore3b = reactWarnings.length;
  /** The edit info of the Swimming series (Tue 20 Oct 17:00), with the 3b additions. */
  /** The editor again on the item sheet that is still open behind it. */
  const openEditorAgain = async (m: Home, label = 'Edit') => {
    m.click(byLabel(topDialog(m), label));
    await settle();
  };
  const swimSeries = (series: Partial<ItemEditInfoResponse['series']> = {}, o: Partial<ItemEditInfoResponse> = {}) =>
    swimInfo({ series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC', rule: { choice: 'weekly' }, first: true, ...series }, ...o });
  const serveSwim = (info: ItemEditInfoResponse) => (key: string) => (key === 'famcal|swim' ? ok200(info) : ({ status: 404, body: {} } as FetchAnswer));
  const serveDentist = (info: ItemEditInfoResponse) => (key: string) => (key === 'famcal|dentist' ? ok200(info) : ({ status: 404, body: {} } as FetchAnswer));
  const openEditor = async (m: Home, title: string, label = 'Edit') => {
    await openItem(m, title);
    m.click(byLabel(topDialog(m), label));
    await settle();
  };
  /** A value row by its label ("Repeat", "Calendar"): the row, its select, its shown value, its options. The Repeat row is a button that opens the Repeat sheet. */
  const isRepeatLabel = (label: string) => label === messages.en.calendarHome.editor.repeat.label || label === messages.he.calendarHome.editor.repeat.label || label === messages.ru.calendarHome.editor.repeat.label;
  const isRowLike = (e: Fake, label: string) => (e.localName === 'label' || (e.localName === 'button' && e.getAttribute('aria-haspopup') === 'dialog')) && e.className.includes('ch-form-row') && e.textContent.startsWith(label);
  const valueRow = (m: Home, label: string) => {
    const found = elements(topDialog(m)).filter((e) => isRowLike(e, label));
    assert(found.length === 1, `${found.length} rows start with ${show(label)}: ${show(topText(m).slice(0, 400))}`);
    return found[0];
  };
  const hasRow = (m: Home, label: string) => elements(topDialog(m)).some((e) => isRowLike(e, label));
  const selectIn = (m: Home, label: string) => elements(valueRow(m, label)).filter((e) => e.localName === 'select')[0];
  const shownIn = (m: Home, label: string) => byClass(valueRow(m, label), 'ch-form-value-text')[0].textContent;
  /** A select's options; for the Repeat row, the sheet's frequencies, read by opening it and cancelling. */
  const optionsIn = (m: Home, label: string): [unknown, string][] => {
    if (!isRepeatLabel(label)) return elements(selectIn(m, label)).filter((e) => e.localName === 'option').map((o): [unknown, string] => [propsOf(o).value, o.textContent]);
    m.click(valueRow(m, label));
    const out = freqOptions(m);
    m.click(byClass(topDialog(m), 'ch-editor-cancel')[0]);
    return out;
  };
  /** A pick: a select's value; for the Repeat row, a frequency by its value, applied with Done. */
  const pick = async (m: Home, label: string, value: string) => {
    if (!isRepeatLabel(label)) return React.act(() => propsOf(selectIn(m, label)).onChange({ target: { value } }));
    m.click(valueRow(m, label));
    const radio = byRole(byRole(topDialog(m), 'radiogroup')[0], 'radio').filter((e) => e.getAttribute('data-value') === value)[0];
    assert(radio !== undefined, `no frequency ${show(value)} in the sheet: ${show(freqOptions(m))}`);
    m.click(radio);
    await sheetDone(m);
  };
  const lastWrite = () => writes()[writes().length - 1];
  const choiceTexts = (m: Home) => elements(topDialog(m)).filter((e) => e.localName === 'button').map((e) => e.textContent.trim());
  const radioOf = (m: Home, text: string) => byRole(topDialog(m), 'radio').filter((e) => e.textContent === text)[0];
  const PICK_NOTE = 'A calendar, alert or recipient change applies from here on or to all of them.';
  const FROM_HERE = 'From 20 Oct on. Earlier ones stay as they were.';
  const DAY_ALONE = 'Save the day change on its own first.';

  await check('#95 the Repeat row on edit: the five choices worded from the start day with the stored one selected; a custom rule and an end get their own labels; picking another sends repeat alone, from this one on, with no scope question; an untouched custom rule is never sent', async () => {
    // A one-off event, at Never: the five, in the create row's words.
    const a = await editingHome('en', { item: serveDentist(infoFor({ series: { recurring: false, start: `${day(0)}T09:30`, repeat: null, fixedDays: false, zone: 'UTC', rule: { choice: 'none' }, first: true } })), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
    try {
      await openEditor(a.m, 'Dentist');
      assert(shownIn(a.m, 'Repeat') === 'Never', `a one-off shows ${show(shownIn(a.m, 'Repeat'))}`);
      assert(
        show(optionsIn(a.m, 'Repeat')) === show([['none', 'Never'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly'], ['hebrew', 'Every year on the Hebrew date']]),
        `options: ${show(optionsIn(a.m, 'Repeat'))}`,
      );
      assertLacks(topText(a.m), ['Earlier ones stay'], 'a one-off has no "from here" line');
      await pick(a.m, 'Repeat', 'weekly');
      assert(shownIn(a.m, 'Repeat') === 'Every week on Thursday', 'the pick shows');
      a.m.click(saveButton(a.m));
      await settle();
      assert(writes().length === 1 && sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { repeat: { freq: 'weekly', interval: 1, byDay: ['TH'] } } }), `one-off to series: ${show(writes()[0]?.body)}`);
      assert(!hasDialog(a.m) || topDialog(a.m).getAttribute('aria-label') === 'Details', 'no scope question');
    } finally {
      a.m.unmount();
    }
    // A series at a rule the row has: that one is selected; a pick is a repeat change from here on ('following'), no sheet.
    const b = await editingHome('en', { item: serveSwim(swimSeries()), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(b.m, 'Swimming');
      assert(shownIn(b.m, 'Repeat') === 'Every week on Tuesday' && optionsIn(b.m, 'Repeat').length === 6, `a weekly series: ${show(shownIn(b.m, 'Repeat'))}, ${optionsIn(b.m, 'Repeat').length} options`);
      assertLacks(topText(b.m), ['Repeats every'], 'the row replaces the old text line');
      await pick(b.m, 'Repeat', 'daily');
      b.m.click(saveButton(b.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'daily', interval: 1 } } }), `a repeat change: ${show(writes()[0]?.body)}`);
      assert(topDialog(b.m).getAttribute('aria-label') === 'Details', 'no scope sheet for a repeat change');
    } finally {
      b.m.unmount();
    }
    // Opened past the first occurrence: the line appears once the repeat changes.
    const c = await editingHome('en', { item: serveSwim(swimSeries({ first: false })) });
    try {
      await openEditor(c.m, 'Swimming');
      assertLacks(topText(c.m), [FROM_HERE], 'no line before a change');
      await pick(c.m, 'Repeat', 'monthly');
      assertHas(topText(c.m), [FROM_HERE], 'the line under the row');
      assert(byClass(valueRow(c.m, 'Repeat'), 'ch-form-hint').length === 1, 'it is the row\'s own hint');
      await pick(c.m, 'Repeat', 'weekly');
      assertLacks(topText(c.m), [FROM_HERE], 'back to the stored rule: no line');
    } finally {
      c.m.unmount();
    }
    // The first occurrence changes the series: no line.
    const d = await editingHome('en', { item: serveSwim(swimSeries({ first: true })) });
    try {
      await openEditor(d.m, 'Swimming');
      await pick(d.m, 'Repeat', 'daily');
      assertLacks(topText(d.m), ['Earlier ones stay'], 'no line from the first occurrence');
    } finally {
      d.m.unmount();
    }
    // A custom rule: its own first choice, selected; an edit of something else sends no repeat; a pick of Never stops it, sending the occurrence's own times.
    const custom = swimSeries({ repeat: { freq: 'weekly', interval: 2, byDay: [], ends: false }, rule: { choice: 'custom' } });
    const e = await editingHome('en', { item: serveSwim(custom), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(e.m, 'Swimming');
      assert(shownIn(e.m, 'Repeat') === 'Every 2 weeks', `custom: ${show(shownIn(e.m, 'Repeat'))}`);
      const opts = optionsIn(e.m, 'Repeat');
      assert(show(opts[0]) === show(['custom', 'Current: Every 2 weeks']) && show(opts.slice(1).map((o) => o[0])) === show(['none', 'daily', 'weekly', 'monthly', 'yearly', 'hebrew']), `custom first: ${show(opts)}`);
      await typeInto(inDialog(e.m, 'Location'), 'The pool');
      e.m.click(saveButton(e.m));
      await settle();
      assert(show(choiceTexts(e.m)) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'All of them', 'Cancel']), `a title-like edit keeps the three: ${show(choiceTexts(e.m))}`);
      tapIn(e.m, 'This one and the ones after');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { location: 'The pool' } }), `the untouched custom rule is not sent: ${show(writes()[0]?.body)}`);
      e.m.click(byLabel(topDialog(e.m), 'Edit'));
      await settle();
      await pick(e.m, 'Repeat', 'none');
      e.m.click(saveButton(e.m));
      await settle();
      assert(sameBody(lastWrite().body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: 'none', start: `${day(5)}T17:00`, end: `${day(5)}T18:00` } }), `a stop sends the occurrence's own times: ${show(lastWrite().body)}`);
    } finally {
      e.m.unmount();
    }
    // Ends: the row's words gain the end, and the sheet's Ends shows it; an unreadable rule is "Current repeat".
    const ended = swimSeries({ rule: { choice: 'daily', until: day(12) }, repeat: { freq: 'daily', interval: 1, byDay: [], ends: true } });
    const f = await editingHome('en', { item: serveSwim(ended) });
    try {
      await openEditor(f.m, 'Swimming');
      assert(shownIn(f.m, 'Repeat') === 'Every day, until 27 Oct', `ended: ${show(shownIn(f.m, 'Repeat'))}`);
      await openRepeat(f.m);
      assert(summaryOf(f.m) === 'Every day, until 27 Oct', `the sheet's summary: ${summaryOf(f.m)}`);
      assert(radiosOf(f.m, 'Ends').filter((e) => e.getAttribute('aria-checked') === 'true').map((e) => e.textContent).join() === 'On date', 'Ends is On date');
      assert(elements(topDialog(f.m)).some((e) => e.getAttribute('data-pill') === 'date' && e.getAttribute('data-value') === day(12)), 'its date is the stored one');
      await sheetCancel(f.m);
    } finally {
      f.m.unmount();
    }
    const customEnded = swimSeries({ repeat: { freq: 'weekly', interval: 2, byDay: [], ends: true }, rule: { choice: 'custom', until: day(12) } });
    const g = await editingHome('en', { item: serveSwim(customEnded) });
    try {
      await openEditor(g.m, 'Swimming');
      assert(shownIn(g.m, 'Repeat') === 'Every 2 weeks, until 27 Oct', `custom with an end: ${show(shownIn(g.m, 'Repeat'))}`);
    } finally {
      g.m.unmount();
    }
    const unreadable = swimSeries({ repeat: null, rule: { choice: 'custom' } });
    const h = await editingHome('en', { item: serveSwim(unreadable) });
    try {
      await openEditor(h.m, 'Swimming');
      assert(shownIn(h.m, 'Repeat') === 'Current repeat' && optionsIn(h.m, 'Repeat')[0][0] === 'custom', `unreadable: ${show(shownIn(h.m, 'Repeat'))}`);
    } finally {
      h.m.unmount();
    }
    // A reminder has the row too, and a Google rule can bring its own words.
    const remRule = swimSeries({ rule: { choice: 'custom', words: 'Every weekday' } }, { kind: 'reminder' });
    const r = await editingHome('en', { item: (k) => (k === 'famcal|recycling' ? ok200(remRule) : ({ status: 404, body: {} } as FetchAnswer)) });
    try {
      await openEditor(r.m, 'Take out the recycling');
      assert(shownIn(r.m, 'Repeat') === 'Every weekday', `a reminder, the server's words: ${show(shownIn(r.m, 'Repeat'))}`);
    } finally {
      r.m.unmount();
    }
  });

  await check('#95a a rule with days that reads as one of the five (Google\'s own weekly events, the bot\'s every Tuesday, BYDAY) and a day move alone: "Only this one" keeps the rule and sends no repeat; "This one and the ones after" sends the shown choice again, so the rule follows the start from there (never refused); from the first occurrence, no line on moving them all; picking one of the five with the move is a repeat change, never refused', async () => {
    const NOTE = 'To move all of them to another day, delete the series and create it again.';
    const later = swimSeries({ fixedDays: true, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, rule: { choice: 'weekly' }, first: false });
    const moved = { start: `${day(7)}T17:00`, end: `${day(7)}T18:00` };
    for (const [pickText, scope, changes] of [
      ['Only this one (Tue 20 Oct)', 'single', moved],
      ['This one and the ones after', 'following', { ...moved, repeat: { freq: 'weekly', interval: 1, byDay: ['TH'] } }],
    ] as const) {
      const a = await editingHome('en', { item: serveSwim(later), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
      try {
        await openEditor(a.m, 'Swimming');
        assert(shownIn(a.m, 'Repeat') === 'Every week on Tuesday', 'it reads as the weekly choice');
        await typeInto(inDialog(a.m, 'Start date'), day(7));
        a.m.click(saveButton(a.m));
        await settle();
        assert(show(choiceTexts(a.m)) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'Cancel']), `this one, or from here on: ${show(choiceTexts(a.m))}`);
        assertHas(topText(a.m), [NOTE], 'the line on moving them all, from a later occurrence');
        tapIn(a.m, pickText);
        await settle();
        assert(writes().length === 1 && sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope, changes }), `${scope}: ${show(writes()[0]?.body)}`);
      } finally {
        a.m.unmount();
      }
    }
    // From the first occurrence, "this one and the ones after" is the whole series: no line.
    const first = swimSeries({ fixedDays: true, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, rule: { choice: 'weekly' } });
    const f = await editingHome('en', { item: serveSwim(first), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(f.m, 'Swimming');
      await typeInto(inDialog(f.m, 'Start date'), day(7));
      f.m.click(saveButton(f.m));
      await settle();
      assert(show(choiceTexts(f.m)) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'Cancel']), `from the first: ${show(choiceTexts(f.m))}`);
      assertLacks(topText(f.m), [NOTE], 'no line from the first occurrence');
    } finally {
      f.m.unmount();
    }
    // The pure rule: a rule the five can't say (custom) still moves this one alone; a new time of day restates nothing.
    const assertSame = (got: unknown, want: unknown, what: string) => assert(sameBody(got, want as Row), `${what}: got ${show(got)}, want ${show(want)}`);
    const initial = editItemForm(later);
    const dayMoved = { ...initial, startDay: day(7), endDay: day(7) };
    assertSame(scopePlan(dayMoved, initial, later), { kind: 'sheet', choices: ['single', 'following'], note: 'dayMove' }, 'the plan');
    assertSame(updateBody(dayMoved, initial, 'famcal|swim', 'following', later)?.changes, { ...moved, repeat: { freq: 'weekly', interval: 1, byDay: ['TH'] } }, 'following restates');
    assertSame(updateBody(dayMoved, initial, 'famcal|swim', 'single', later)?.changes, moved, 'single keeps the rule');
    const custom = swimSeries({ fixedDays: true, repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'], ends: false }, rule: { choice: 'custom' }, first: false });
    const ci = editItemForm(custom);
    assertSame(scopePlan({ ...ci, startDay: day(7), endDay: day(7) }, ci, custom), { kind: 'sheet', choices: ['single'], note: 'dayMove' }, 'custom: this one alone');
    assertSame(updateBody({ ...initial, startTime: '18:00', endTime: '19:00' }, initial, 'famcal|swim', 'following', later)?.changes, { start: `${day(5)}T18:00`, end: `${day(5)}T19:00` }, 'a new time restates nothing');
    const fixed = later;
    const b = await editingHome('en', { item: serveSwim(fixed), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(b.m, 'Swimming');
      await typeInto(inDialog(b.m, 'Start date'), day(7));
      await pick(b.m, 'Repeat', 'daily');
      b.m.click(saveButton(b.m));
      await settle();
      assert(!alerts(b.m).includes(DAY_ALONE) && writes().length === 1, `not refused: ${show(alerts(b.m))}`);
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'daily', interval: 1 }, start: `${day(7)}T17:00`, end: `${day(7)}T18:00` } }), `a move that picks one of the five: ${show(writes()[0].body)}`);
    } finally {
      b.m.unmount();
    }
  });

  await check('#96 the Calendar row on edit, from the item\'s move targets: the current one selected, the others offered (the partner\'s as "<calendar> · <name>"), the private ones left out when the server leaves them out; without targets the name stays text; a reminder has none', async () => {
    const calendars = [
      ...EDITOR_INFO.calendars,
      { id: 'native:cal_me_private', name: 'Just me', color: '#8E24AA', main: false, mine: true },
    ];
    const editor = ok200(editorWith({ calendars }));
    const movable = (o: Partial<ItemEditInfoResponse> = {}) => infoFor({ canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'native:cal_noa_91b2', 'native:cal_me_private'], ...o });
    const a = await editingHome('en', { editor, item: serveDentist(movable()), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
    try {
      await openEditor(a.m, 'Dentist');
      assert(shownIn(a.m, 'Calendar') === 'Family', `current: ${show(shownIn(a.m, 'Calendar'))}`);
      assert(show(optionsIn(a.m, 'Calendar')) === show([['native:cal_me_7f3a', 'Family'], ['native:cal_noa_91b2', 'Noa and the kids · Noa'], ['native:cal_me_private', 'Just me']]), `options: ${show(optionsIn(a.m, 'Calendar'))}`);
      assert(!byClass(topDialog(a.m), 'ch-form-fixed').some((p) => p.textContent === 'Family'), 'no text line beside the row');
      await pick(a.m, 'Calendar', 'native:cal_noa_91b2');
      a.m.click(saveButton(a.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { calendarId: 'native:cal_noa_91b2' } }), `a one-off moves with no question: ${show(writes()[0].body)}`);
    } finally {
      a.m.unmount();
    }
    // The server leaves the private calendar out for the partner's event: it is not offered.
    const partners = infoFor({ calendar: { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E' }, canMoveCalendar: true, moveTargets: ['native:cal_noa_91b2', 'native:cal_me_7f3a'] });
    const b = await editingHome('en', { editor, item: serveDentist(partners) });
    try {
      await openEditor(b.m, 'Dentist');
      assert(show(optionsIn(b.m, 'Calendar').map((o) => o[0])) === show(['native:cal_noa_91b2', 'native:cal_me_7f3a']), `the private one is not offered: ${show(optionsIn(b.m, 'Calendar'))}`);
    } finally {
      b.m.unmount();
    }
    // No move targets (or one): the calendar's name stays text, no Calendar row.
    for (const [what, over] of [['none given', {}], ['can\'t move', { canMoveCalendar: false, moveTargets: ['native:cal_me_7f3a'] }]] as [string, Partial<ItemEditInfoResponse>][]) {
      const c = await editingHome('en', { editor, item: serveDentist(infoFor(over)) });
      try {
        await openEditor(c.m, 'Dentist');
        assert(!hasRow(c.m, 'Calendar') && byClass(topDialog(c.m), 'ch-form-fixed').some((p) => p.textContent === 'Family'), `${what}: the name as text`);
      } finally {
        c.m.unmount();
      }
    }
    // A reminder lives on its creator's main calendar: no row, even with targets.
    const d = await editingHome('en', { editor, item: (k) => (k === 'famcal|recycling' ? ok200(movable({ kind: 'reminder' })) : ({ status: 404, body: {} } as FetchAnswer)) });
    try {
      await openEditor(d.m, 'Take out the recycling');
      assert(!hasRow(d.m, 'Calendar'), 'a reminder has no Calendar row');
    } finally {
      d.m.unmount();
    }
  });

  await check('#96a a calendar change on a series asks with two neutral choices and the line (never "Only this one", never "Every Tuesday"); a repeat change in the same save asks nothing; the other fields of the save go along', async () => {
    const calendars = EDITOR_INFO.calendars;
    const series = swimSeries({}, { canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'native:cal_noa_91b2'] });
    const a = await editingHome('en', { editor: ok200(editorWith({ calendars })), item: serveSwim(series), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(a.m, 'Swimming');
      await pick(a.m, 'Calendar', 'native:cal_noa_91b2');
      await typeInto(inDialog(a.m, 'Location'), 'The pool');
      a.m.click(saveButton(a.m));
      await settle();
      assert(topDialog(a.m).getAttribute('aria-label') === 'This event repeats', 'the scope sheet');
      assert(show(choiceTexts(a.m)) === show(['This one and the ones after', 'All of them', 'Cancel']), `choices: ${show(choiceTexts(a.m))}`);
      assertHas(topText(a.m), [PICK_NOTE], 'the line on the sheet');
      assert(writes().length === 0, 'nothing sent before the choice');
      tapIn(a.m, 'All of them');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'all', changes: { calendarId: 'native:cal_noa_91b2', location: 'The pool' } }), `all: ${show(writes()[0].body)}`);
      a.m.click(byLabel(topDialog(a.m), 'Edit'));
      await settle();
      await pick(a.m, 'Calendar', 'native:cal_noa_91b2');
      a.m.click(saveButton(a.m));
      await settle();
      tapIn(a.m, 'This one and the ones after');
      await settle();
      assert(lastWrite().body?.scope === 'following' && sameBody(lastWrite().body?.changes, { calendarId: 'native:cal_noa_91b2' }), `following: ${show(lastWrite().body)}`);
    } finally {
      a.m.unmount();
    }
    // With a repeat change: from this one on, no sheet, both fields go.
    const b = await editingHome('en', { editor: ok200(editorWith({ calendars })), item: serveSwim(series), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(b.m, 'Swimming');
      await pick(b.m, 'Calendar', 'native:cal_noa_91b2');
      await pick(b.m, 'Repeat', 'daily');
      b.m.click(saveButton(b.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'daily', interval: 1 }, calendarId: 'native:cal_noa_91b2' } }), `both: ${show(writes()[0]?.body)}`);
    } finally {
      b.m.unmount();
    }
    // Going back to the first calendar is no change.
    const c = await editingHome('en', { editor: ok200(editorWith({ calendars })), item: serveSwim(series) });
    try {
      await openEditor(c.m, 'Swimming');
      await pick(c.m, 'Calendar', 'native:cal_noa_91b2');
      await pick(c.m, 'Calendar', 'native:cal_me_7f3a');
      c.m.click(saveButton(c.m));
      await settle();
      assert(writes().length === 0 && topDialog(c.m).getAttribute('aria-label') === 'Details', 'nothing changed: Save just closes');
    } finally {
      c.m.unmount();
    }
  });

  await check('#97 the For row on edit, for the reminder\'s creator: Me | <partner> with the current one selected, the take-back always there; the same two-choice sheet for a series; the recipient sees "For <name>" text', async () => {
    const reminder = (o: Partial<ItemEditInfoResponse> = {}, series: Partial<ItemEditInfoResponse['series']> = {}) =>
      infoFor({
        kind: 'reminder',
        occurrence: { start: `${day(0)}T17:00`, end: `${day(0)}T17:00`, allDay: false, title: 'Dentist', location: '', description: '' },
        series: { recurring: false, start: `${day(0)}T17:00`, repeat: null, fixedDays: false, zone: 'UTC', rule: { choice: 'none' }, first: true, ...series },
        canChangeRecipient: true,
        forPartner: false,
        ...o,
      });
    const a = await editingHome('en', { item: serveDentist(reminder()), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
    try {
      await openEditor(a.m, 'Dentist');
      assert(show(byRole(topDialog(a.m), 'radio').map((e) => [e.textContent, e.getAttribute('aria-checked')])) === show([['Me', 'true'], ['Noa', 'false']]), 'Me | Noa, Me selected');
      assertLacks(topText(a.m), ['For Noa'], 'no text line beside the row');
      a.m.click(radioOf(a.m, 'Noa'));
      a.m.click(saveButton(a.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { forPartner: true } }), `to Noa: ${show(writes()[0].body)}`);
    } finally {
      a.m.unmount();
    }
    // Currently for the partner: Noa selected, Me takes it back, and a reminder for the partner shows the row even when the partner can't be reached now.
    const b = await editingHome('en', { editor: ok200(editorWith({ partner: { name: 'Noa', canRemind: false } })), item: serveDentist(reminder({ forPartner: true, forName: 'Noa' })), write: () => ok200({ status: 'ok', key: 'famcal|dentist' }) });
    try {
      await openEditor(b.m, 'Dentist');
      assert(radioOf(b.m, 'Noa').getAttribute('aria-checked') === 'true' && radioOf(b.m, 'Me').getAttribute('aria-checked') === 'false', 'Noa selected');
      b.m.click(radioOf(b.m, 'Me'));
      b.m.click(saveButton(b.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { forPartner: false } }), `the take-back: ${show(writes()[0].body)}`);
    } finally {
      b.m.unmount();
    }
    // A series: the two-choice sheet and the line.
    const c = await editingHome('en', { item: serveSwim(reminder({ occurrence: { start: `${day(5)}T17:00`, end: `${day(5)}T17:00`, allDay: false, title: 'Swimming', location: '', description: '' }, scopes: ['single', 'following', 'all'] }, { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, rule: { choice: 'weekly' } })), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(c.m, 'Swimming');
      c.m.click(radioOf(c.m, 'Noa'));
      c.m.click(saveButton(c.m));
      await settle();
      assert(show(choiceTexts(c.m)) === show(['This one and the ones after', 'All of them', 'Cancel']), `choices: ${show(choiceTexts(c.m))}`);
      assertHas(topText(c.m), [PICK_NOTE], 'the line');
      tapIn(c.m, 'This one and the ones after');
      await settle();
      assert(lastWrite().body?.scope === 'following' && sameBody(lastWrite().body?.changes, { forPartner: true }), `following: ${show(lastWrite().body)}`);
    } finally {
      c.m.unmount();
    }
    // Not the creator: "For Noa" as text and no choice.
    const d = await editingHome('en', { item: serveDentist(reminder({ canChangeRecipient: false, forName: 'Noa', forPartner: true })) });
    try {
      await openEditor(d.m, 'Dentist');
      assertHas(topText(d.m), ['For Noa'], 'the text line');
      assert(byRole(topDialog(d.m), 'radio').length === 0, 'no choice');
    } finally {
      d.m.unmount();
    }
  });

  await check('#97a a day move on a set-weekdays series together with a calendar or recipient change can\'t be saved: "Save the day change on its own first." and nothing is written; without the day move, or with a repeat pick, it goes through', async () => {
    const calendars = EDITOR_INFO.calendars;
    const fixed = swimSeries({ fixedDays: true, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, rule: { choice: 'weekly' } }, { canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'native:cal_noa_91b2'] });
    const a = await editingHome('en', { editor: ok200(editorWith({ calendars })), item: serveSwim(fixed), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(a.m, 'Swimming');
      await pick(a.m, 'Calendar', 'native:cal_noa_91b2');
      await typeInto(inDialog(a.m, 'Start date'), day(7));
      a.m.click(saveButton(a.m));
      await settle();
      assert(alerts(a.m).includes(DAY_ALONE), `the note: ${show(alerts(a.m))}`);
      assert(writes().length === 0 && topDialog(a.m).getAttribute('aria-label') === 'Edit', 'nothing written, no sheet');
      // The note goes with the next change; without the day move the two-choice sheet opens.
      await typeInto(inDialog(a.m, 'Start date'), day(5));
      assert(!alerts(a.m).includes(DAY_ALONE), 'the note goes when the form changes');
      a.m.click(saveButton(a.m));
      await settle();
      assert(show(choiceTexts(a.m)) === show(['This one and the ones after', 'All of them', 'Cancel']), `no day move: ${show(choiceTexts(a.m))}`);
    } finally {
      a.m.unmount();
    }
    // The recipient, the same.
    const rem = infoFor({
      kind: 'reminder',
      occurrence: { start: `${day(5)}T17:00`, end: `${day(5)}T17:00`, allDay: false, title: 'Swimming', location: '', description: '' },
      series: { recurring: true, start: `${day(5)}T17:00`, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false }, fixedDays: true, zone: 'UTC', rule: { choice: 'weekly' }, first: true },
      canChangeRecipient: true,
      forPartner: false,
      scopes: ['single', 'following', 'all'],
    });
    const b = await editingHome('en', { item: serveSwim(rem) });
    try {
      await openEditor(b.m, 'Swimming');
      b.m.click(radioOf(b.m, 'Noa'));
      await typeInto(inDialog(b.m, 'Date'), day(7));
      b.m.click(saveButton(b.m));
      await settle();
      assert(alerts(b.m).includes(DAY_ALONE) && writes().length === 0, `a reminder: ${show(alerts(b.m))}`);
    } finally {
      b.m.unmount();
    }
    // Picking one of the five with the move: the repeat change wins, nothing is refused.
    const c = await editingHome('en', { editor: ok200(editorWith({ calendars })), item: serveSwim(fixed), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(c.m, 'Swimming');
      await pick(c.m, 'Calendar', 'native:cal_noa_91b2');
      await pick(c.m, 'Repeat', 'daily');
      await typeInto(inDialog(c.m, 'Start date'), day(7));
      c.m.click(saveButton(c.m));
      await settle();
      assert(writes().length === 1 && writes()[0].body?.scope === 'following', `sent: ${show(writes()[0]?.body)}`);
    } finally {
      c.m.unmount();
    }
    // In Hebrew and Russian.
    for (const locale of ['he', 'ru'] as const) {
      const l = messages[locale].calendarHome;
      const d = await editingHome(locale, { editor: ok200(editorWith({ calendars })), item: serveSwim(fixed) });
      try {
        await openEditor(d.m, 'Swimming', l.sheet.edit);
        await pick(d.m, l.editor.calendar, 'native:cal_noa_91b2');
        await typeInto(inDialog(d.m, l.editor.startsDate), day(7));
        d.m.click(saveButton(d.m));
        await settle();
        assert(alerts(d.m).includes(l.editor.dayMoveAlone) && l.editor.dayMoveAlone !== messages.en.calendarHome.editor.dayMoveAlone, `${locale}: ${show(alerts(d.m))}`);
      } finally {
        d.m.unmount();
      }
    }
  });

  await check('#98 Google users: the "+" opens an Event form on a Google calendar (no kind switch, the primary the default, the Calendar row lists the writable ones); Save creates there and asks Google again, not FamCal', async () => {
    const { m } = await googleHome('en', { write: () => ok200({ status: 'ok', key: 'google|avi@gmail.com|new1' }) });
    try {
      assert(hasPlus(m), 'the "+"');
      tapPlus(m);
      await settle();
      assert(!elements(topDialog(m)).some((e) => e.getAttribute('aria-label') === 'Type'), 'no Event | Reminder switch');
      assertHas(topText(m), ['All day', 'Starts', 'Calendar', 'Avi'], 'the event form on the primary');
      assert(show(optionsIn(m, 'Calendar')) === show([['family@group.calendar.google.com', 'Family'], ['avi@gmail.com', 'Avi']]), `calendars: ${show(optionsIn(m, 'Calendar'))}`);
      assert(shownIn(m, 'Calendar') === 'Avi', 'the primary is the default');
      await typeInto(inDialog(m, 'Title'), 'Lunch');
      await pick(m, 'Calendar', 'family@group.calendar.google.com');
      const before = rangeCalls().length;
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 1 && writes()[0].method === 'POST' && writes()[0].body?.calendarId === 'family@group.calendar.google.com' && writes()[0].body?.kind === 'event', `create: ${show(writes()[0]?.body)}`);
      const after = rangeCalls().slice(before);
      assert(after.length > 0 && after.every((c) => c.query.get('sources') === 'google'), `Google is asked again: ${show(after.map((c) => c.url))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#98a Google items: the pencil and Delete come from the item\'s edit info (asked with the google key); an event that is writable but can only be changed in Google shows that line and no pencil, a read-only calendar shows nothing; the three scopes work as for FamCal', async () => {
    const info = (o: Partial<ItemEditInfoResponse> = {}) => infoFor({ source: 'google', occurrence: { start: `${day(0)}T19:30`, end: `${day(0)}T22:00`, allDay: false, title: 'Dinner with the Cohens', location: '', description: '' }, ...o });
    const serve = (i: ItemEditInfoResponse) => (key: string) => (key === 'google|dinner' ? ok200(i) : ({ status: 404, body: {} } as FetchAnswer));
    const a = await googleHome('en', { item: serve(info()), write: () => ok200({ status: 'ok', key: 'google|dinner' }) });
    try {
      await openItem(a.m, 'Dinner with the Cohens');
      assert(editingKeys.length === 1 && editingKeys[0] === 'google|dinner', `asked with the google key: ${show(editingKeys)}`);
      const b = sheetButtons(a.m);
      assert(b.includes('Edit') && b.includes('Delete event') && b.includes('Open in Google Calendar'), `buttons: ${show(b)}`);
      assertLacks(topText(a.m), ['can only be changed in Google Calendar'], 'no line for an editable event');
    } finally {
      a.m.unmount();
    }
    const only = await googleHome('en', { item: serve(info({ canEdit: false, canDelete: false, editableInGoogleOnly: true })) });
    try {
      await openItem(only.m, 'Dinner with the Cohens');
      const b = sheetButtons(only.m);
      assert(!b.includes('Edit') && !b.some((x) => x.startsWith('Delete')), `no pencil or Delete: ${show(b)}`);
      assertHas(topText(only.m), ['This one can only be changed in Google Calendar'], 'the line');
      assert(b.includes('Open in Google Calendar'), 'the Google link stays');
    } finally {
      only.m.unmount();
    }
    const readOnly = await googleHome('en', { item: serve(info({ canEdit: false, canDelete: false })) });
    try {
      await openItem(readOnly.m, 'Dinner with the Cohens');
      assertLacks(topText(readOnly.m), ['can only be changed'], 'a read-only calendar: no line');
      assert(!sheetButtons(readOnly.m).includes('Edit'), 'and no pencil');
    } finally {
      readOnly.m.unmount();
    }
    // Edit, with a scope for a Google series.
    const series = info({ series: { recurring: true, start: `${day(0)}T19:30`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC', rule: { choice: 'custom', words: 'Every Thursday' }, first: true }, scopes: ['single', 'following', 'all'] });
    const c = await googleHome('en', { item: serve(series), write: () => ok200({ status: 'ok', key: 'google|dinner' }) });
    try {
      await openEditor(c.m, 'Dinner with the Cohens');
      assert(shownIn(c.m, 'Repeat') === 'Every Thursday', `the server's words: ${show(shownIn(c.m, 'Repeat'))}`);
      await typeInto(inDialog(c.m, 'Location'), 'Their place');
      c.m.click(saveButton(c.m));
      await settle();
      assert(show(choiceTexts(c.m)).includes('Only this one'), `scope sheet: ${show(choiceTexts(c.m))}`);
      tapIn(c.m, 'This one and the ones after');
      await settle();
      assert(lastWrite().method === 'PATCH' && lastWrite().body?.key === 'google|dinner' && lastWrite().body?.scope === 'following', `patch: ${show(lastWrite().body)}`);
      const askedGoogle = rangeCalls().filter((x) => x.query.get('sources') === 'google').length;
      assert(askedGoogle > 0 && rangeCalls().every((x) => x.query.get('sources') === 'google'), 'only Google is asked');
    } finally {
      c.m.unmount();
    }
    // Delete a one-off.
    const d = await googleHome('en', { item: serve(info()), write: () => ok200({ status: 'ok' }) });
    try {
      await openItem(d.m, 'Dinner with the Cohens');
      tapIn(d.m, 'Delete event');
      const beforeDelete = rangeCalls().length;
      tapIn(d.m, 'Delete');
      await settle();
      assert(writes().length === 1 && writes()[0].method === 'DELETE' && writes()[0].body?.key === 'google|dinner', `delete: ${show(writes()[0]?.body)}`);
      // A deleted Google item leaves the Agenda and Month by asking Google again, not FamCal.
      const afterDelete = rangeCalls().slice(beforeDelete);
      assert(afterDelete.length > 0 && afterDelete.every((x) => x.query.get('sources') === 'google'), `only Google is asked after the delete: ${show(afterDelete.map((x) => x.url))}`);
    } finally {
      d.m.unmount();
    }
  });

  await check('#98c a day move the server refuses for a series with fixed days (the rule changed after the sheet opened) shows the day note, not "Couldn\'t save"', async () => {
    const series = infoFor({
      source: 'google',
      occurrence: { start: `${day(0)}T19:30`, end: `${day(0)}T22:00`, allDay: false, title: 'Dinner with the Cohens', location: '', description: '' },
      series: { recurring: true, start: `${day(0)}T19:30`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC', rule: { choice: 'weekly' }, first: true },
      scopes: ['single', 'following', 'all'],
    });
    const a = await googleHome('en', { item: (key) => (key === 'google|dinner' ? ok200(series) : ({ status: 404, body: {} } as FetchAnswer)), write: () => ({ status: 400, body: { error: 'invalid', field: 'start' } }) });
    try {
      await openEditor(a.m, 'Dinner with the Cohens');
      await typeInto(inDialog(a.m, 'Start date'), day(2));
      a.m.click(saveButton(a.m));
      await settle();
      tapIn(a.m, 'Every Thursday');
      await settle();
      assert(writes().length === 1 && writes()[0].body?.scope === 'all', `sent: ${show(writes()[0]?.body)}`);
      assert(alerts(a.m).includes(messages.en.calendarHome.scope.dayMoveNote), `the day note: ${show(alerts(a.m))}`);
      assert(!alerts(a.m).includes('Couldn’t save. Try again.'), `not the generic text: ${show(alerts(a.m))}`);
    } finally {
      a.m.unmount();
    }
  });

  await check('#98b the sheet follows a Google item across a key change (a repeat change or a split gives the event a new id): it shows the item under the new key once Google brings it, and closes if it never does', async () => {
    const infoOf = (title: string) => infoFor({ source: 'google', occurrence: { start: `${day(0)}T19:30`, end: `${day(0)}T22:00`, allDay: false, title, location: '', description: '' }, series: { recurring: false, start: `${day(0)}T19:30`, repeat: null, fixedDays: false, zone: 'UTC', rule: { choice: 'none' }, first: true } });
    const serve = (key: string) => (key === 'google|dinner' ? ok200(infoOf('Dinner with the Cohens')) : key === 'google|dinner2' ? ok200(infoOf('Dinner, weekly')) : ({ status: 404, body: {} } as FetchAnswer));
    const a = await googleHome('en', { item: serve, write: () => ok200({ status: 'ok', key: 'google|dinner2' }) });
    try {
      await openEditor(a.m, 'Dinner with the Cohens');
      await pick(a.m, 'Repeat', 'weekly');
      a.world.items = { ...a.world.items, [day(0)]: [{ ...DINNER, id: 'dinner2', key: 'google|dinner2', title: 'Dinner, weekly', recurring: true }] };
      a.m.click(saveButton(a.m));
      await settle();
      assert(topDialog(a.m).getAttribute('aria-label') === 'Details' && topText(a.m).includes('Dinner, weekly'), `the sheet moved to the new key: ${show(topText(a.m).slice(0, 200))}`);
      assert(editingKeys.includes('google|dinner2'), `its info was asked: ${show(editingKeys)}`);
    } finally {
      a.m.unmount();
    }
    const b = await googleHome('en', { item: serve, write: () => ok200({ status: 'ok', key: 'google|gone' }) });
    try {
      await openEditor(b.m, 'Dinner with the Cohens');
      await pick(b.m, 'Repeat', 'weekly');
      b.world.items = { ...b.world.items, [day(0)]: [] };
      b.m.click(saveButton(b.m));
      await settle();
      assert(!hasDialog(b.m), 'the item never came: the sheet closes');
    } finally {
      b.m.unmount();
    }
  });

  await check('#99 a Google write that needs the user\'s connection (403 reconnect, token or scopes) shows "Your Google connection expired" above Save and raises the home\'s reconnect banner (its wording for scopes); a delete the same; a 500 stays "Couldn\'t save"', async () => {
    const info = infoFor({ source: 'google', occurrence: { start: `${day(0)}T19:30`, end: `${day(0)}T22:00`, allDay: false, title: 'Dinner with the Cohens', location: '', description: '' } });
    const serve = (key: string) => (key === 'google|dinner' ? ok200(info) : ({ status: 404, body: {} } as FetchAnswer));
    const bannerText = (m: Home) => textOf(htmlOf(m.container));
    for (const [reason, banner] of [['token', 'Your Google connection expired'], ['scopes', 'FamCal needs permission to read your calendar']] as const) {
      const { m } = await googleHome('en', { item: serve, write: () => ({ status: 403, body: { error: 'reconnect', reason } }) });
      try {
        await openEditor(m, 'Dinner with the Cohens');
        assert(!elements(m.container).some((e) => e.className.includes('ch-banner') && e.textContent.includes(banner)), `${reason}: no banner yet`);
        await typeInto(inDialog(m, 'Title'), 'Dinner (late)');
        m.click(saveButton(m));
        await settle();
        assert(topDialog(m).getAttribute('aria-label') === 'Edit' && alerts(m).includes('Your Google connection expired'), `${reason}: the editor stays with the message: ${show(alerts(m))}`);
        assert(bannerText(m).includes(banner) && bannerText(m).includes('Reconnect Google'), `${reason}: the banner is raised`);
      } finally {
        m.unmount();
      }
    }
    const del = await googleHome('en', { item: serve, write: () => ({ status: 403, body: { error: 'reconnect', reason: 'token' } }) });
    try {
      await openItem(del.m, 'Dinner with the Cohens');
      tapIn(del.m, 'Delete event');
      tapIn(del.m, 'Delete');
      await settle();
      assert(alerts(del.m).includes('Your Google connection expired') && textOf(htmlOf(del.m.container)).includes('Reconnect Google'), `a delete: ${show(alerts(del.m))}`);
    } finally {
      del.m.unmount();
    }
    const failed = await googleHome('en', { item: serve, write: () => ({ status: 500, body: { error: 'internal_error' } }) });
    try {
      await openEditor(failed.m, 'Dinner with the Cohens');
      await typeInto(inDialog(failed.m, 'Title'), 'Dinner (late)');
      failed.m.click(saveButton(failed.m));
      await settle();
      assert(alerts(failed.m).includes('Couldn’t save. Try again.') && !textOf(htmlOf(failed.m.container)).includes('Reconnect Google'), `a 500: ${show(alerts(failed.m))}`);
    } finally {
      failed.m.unmount();
    }
  });

  await check('#99a a write is never cut short on the client: a Google "this one and the ones after" runs many Google calls, and an abort would show "Couldn\'t save" while the write lands; create, edit and delete send no time limit and wait for the answer, the reads keep theirs', async () => {
    resetHome();
    let release: (a: FetchAnswer) => void = noop;
    serveEditing = (c) => (c.method === 'GET' ? ok200({}) : new Promise<FetchAnswer>((resolve) => (release = resolve)));
    for (const [method, send] of [
      ['POST', () => REAL_EDITING.create(5550001, { kind: 'event', title: 'x', allDay: false, start: `${day(1)}T10:00`, end: `${day(1)}T11:00`, repeat: 'none' })],
      ['PATCH', () => REAL_EDITING.update(5550001, { key: 'google|swim', scope: 'following', changes: { title: 'y' } })],
      ['DELETE', () => REAL_EDITING.remove(5550001, { key: 'google|swim', scope: 'single' })],
    ] as const) {
      fetchCalls.length = 0;
      const pending = send();
      await new Promise((resolve) => setImmediate(resolve));
      const call = fetchCalls[0];
      assert(call?.method === method && call.signal === undefined, `${method}: a time limit on the write: ${show({ method: call?.method, signal: call?.signal !== undefined })}`);
      release({ status: 200, body: { status: 'ok', key: 'google|swim2' } });
      const out = await pending;
      assert(out.kind === 'ok' && out.key === 'google|swim2', `${method}: ${show(out)}`);
    }
    fetchCalls.length = 0;
    await REAL_EDITING.editor(5550001);
    await REAL_EDITING.item(5550001, 'google|swim');
    assert(fetchCalls.length === 2 && fetchCalls.every((c) => c.method === 'GET' && c.signal !== undefined), `the reads keep their limit: ${show(fetchCalls.map((c) => [c.method, c.signal !== undefined]))}`);
  });

  await check('#100 the 3b copy in en, he and ru: the new rows, the lines, the Google line and the reconnect error show real text, no key left bare, and Hebrew and Russian are translated, not copied', async () => {
    const calendars = EDITOR_INFO.calendars;
    for (const locale of LOCALES) {
      const l = messages[locale].calendarHome;
      const series = swimSeries({ first: false, repeat: { freq: 'weekly', interval: 2, byDay: [], ends: true }, rule: { choice: 'custom', until: day(12) } }, { canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'native:cal_noa_91b2'] });
      const { m } = await editingHome(locale, { editor: ok200(editorWith({ calendars })), item: serveSwim(series) });
      try {
        await openEditor(m, 'Swimming', l.sheet.edit);
        await pick(m, l.editor.repeat.label, 'daily');
        const html = htmlOf(topDialog(m));
        assertLacks(html + textOf(html), ['calendarHome.', '[missing', 'undefined'], `${locale} editor`);
        assert(byClass(valueRow(m, l.editor.repeat.label), 'ch-form-hint').length === 1, `${locale}: the "from here" line`);
        await pick(m, l.editor.calendar, 'native:cal_noa_91b2');
        await pick(m, l.editor.repeat.label, 'custom');
        m.click(saveButton(m));
        await settle();
        const sheet = htmlOf(topDialog(m));
        assertLacks(sheet + textOf(sheet), ['calendarHome.', '[missing', 'undefined'], `${locale} scope sheet`);
        assertHas(textOf(sheet), [l.scope.seriesNote], `${locale}: the series line`);
      } finally {
        m.unmount();
      }
      if (locale !== 'en') {
        for (const key of ['editor.repeat.current', 'editor.repeat.currentPlain', 'editor.repeat.until', 'editor.repeat.fromHere', 'editor.dayMoveAlone', 'editor.submitErrors.reconnect', 'scope.seriesNote', 'sheet.googleOnly'] as const) {
          const get = (loc: Locale) => key.split('.').reduce<Row>((o, k) => o[k], messages[loc].calendarHome) as unknown as string;
          assert(get(locale) !== get('en'), `${locale}: ${key} is translated`);
        }
      }
      const g = await googleHome(locale, { item: (k) => (k === 'google|dinner' ? ok200(infoFor({ source: 'google', canEdit: false, canDelete: false, editableInGoogleOnly: true })) : ({ status: 404, body: {} } as FetchAnswer)) });
      try {
        await openItem(g.m, 'Dinner with the Cohens');
        assertHas(topText(g.m), [l.sheet.googleOnly], `${locale}: the Google line`);
      } finally {
        g.m.unmount();
      }
    }
  });

  await check('#101 React logged no warning in #95-#100 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBefore3b, `React warned: ${show(reactWarnings.slice(warnedBefore3b, warnedBefore3b + 3))}`);
  });

  // ---- Hebrew-date repeats in the editor (hebrew-repeats spec §4; #102-#107) ----

  const warnedBeforeHebrew = reactWarnings.length;
  /** Like editingHome, with the route's `hebrewDates` set (the default answer has it on). */
  async function hebrewHome(locale: Locale, hebrewDates: boolean, server: EditingServer = {}) {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: { ...WEEK, [day(5)]: [...WEEK[day(5)], SWIM] }, hebrewDates });
    serveEditingWith(server);
    const m = await mountHome(locale, {}, fakeClock('2026-10-15T07:00:00Z'));
    return { m, tg };
  }
  /** A Hebrew series' edit info: Swimming, opened on its 20 Oct occurrence, anchored on 30 Cheshvan (24 Nov 2022). */
  const hebrewSwim = (choice: 'hebrew' | 'custom' = 'hebrew', o: { interval?: number; until?: string; first?: boolean } = {}) =>
    swimSeries(
      {
        repeat: { freq: 'yearly', interval: o.interval ?? 1, byDay: [], ends: Boolean(o.until), hebrew: { anchor: '2022-11-24' } },
        rule: { choice, anchor: '2022-11-24', ...(o.until ? { until: o.until } : {}) },
        first: o.first ?? true,
      },
      {},
    );
  const HEBREW_TEXTS: Record<Locale, { hebrew: string }> = {
    en: { hebrew: 'Every year on 4 Cheshvan' },
    he: { hebrew: 'כל שנה בד׳ בחשון' },
    ru: { hebrew: 'Каждый год 4 хешвана' },
  };

  await check('#102 create: the Hebrew choice follows the five when the home shows Hebrew dates, worded from the form\'s start day in each language (gematriya in Hebrew), and follow the day when it changes; a pick is sent as repeat', async () => {
    for (const locale of LOCALES) {
      const l = messages[locale].calendarHome;
      const { m } = await hebrewHome(locale, true, { write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
      try {
        tapPlus(m, l.header.add);
        await settle();
        const opts = optionsIn(m, l.editor.repeat.label);
        assert(show(opts.slice(0, 5).map((o) => o[0])) === show(['none', 'daily', 'weekly', 'monthly', 'yearly']), `${locale}: the five first: ${show(opts)}`);
        assert(show(opts.slice(5)) === show([['hebrew', l.editor.repeat.freq.hebrew]]), `${locale}: the Hebrew choice: ${show(opts.slice(5))}`);
        // The sheet words the Hebrew date of the start day, in each language.
        m.click(valueRow(m, l.editor.repeat.label));
        m.click(byRole(topDialog(m), 'radio').filter((e) => e.getAttribute('data-value') === 'hebrew')[0]);
        assert(summaryOf(m) === HEBREW_TEXTS[locale].hebrew, `${locale}: the summary: ${show(summaryOf(m))}`);
        await sheetCancel(m);
        if (locale === 'en') {
          await typeInto(inDialog(m, 'Start date'), '2026-10-22');
          await typeInto(inDialog(m, 'Title'), 'Grandpa');
          await pick(m, 'Repeat', 'hebrew');
          assert(shownIn(m, 'Repeat') === 'Every year on 11 Cheshvan', `the pick shows: ${show(shownIn(m, 'Repeat'))}`);
          m.click(saveButton(m));
          await settle();
          assert(writes().length === 1 && show(writes()[0].body?.repeat) === show({ freq: 'hebrew', interval: 1 }) && writes()[0].body?.kind === 'event', `sent: ${show(writes()[0]?.body)}`);
        }
      } finally {
        m.unmount();
      }
    }
  });

  await check('#102a create: a reminder has the choice too; with Hebrew dates off, or a Google calendar chosen, or a Google user, there are none, and a Hebrew pick falls back to yearly when the calendar becomes a Google one', async () => {
    const both = editorWith({ calendars: [...EDITOR_INFO.calendars, { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5', main: false, mine: true }] });
    const a = await hebrewHome('en', true, { editor: ok200(both), write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
    try {
      tapPlus(a.m);
      await settle();
      await pick(a.m, 'Repeat', 'hebrew');
      await pick(a.m, 'Calendar', 'avi@gmail.com');
      assert(show(optionsIn(a.m, 'Repeat').map((o) => o[0])) === show(['none', 'daily', 'weekly', 'monthly', 'yearly']), `a Google calendar: ${show(optionsIn(a.m, 'Repeat'))}`);
      assert(shownIn(a.m, 'Repeat') === 'Every year on 15 Oct', `the pick fell back to yearly: ${show(shownIn(a.m, 'Repeat'))}`);
      await pick(a.m, 'Calendar', 'native:cal_me_7f3a');
      assert(optionsIn(a.m, 'Repeat').length === 6, 'back on FamCal: the choices are back');
      // A reminder is always FamCal's: the Google calendar picked for the event does not take them away.
      await pick(a.m, 'Calendar', 'avi@gmail.com');
      assert(optionsIn(a.m, 'Repeat').length === 5, 'the Google calendar again');
      tapIn(a.m, 'Reminder');
      await settle();
      assert(optionsIn(a.m, 'Repeat').length === 6, `a reminder: ${show(optionsIn(a.m, 'Repeat'))}`);
      await pick(a.m, 'Repeat', 'hebrew');
      await typeInto(inDialog(a.m, 'Title'), 'Light a candle');
      a.m.click(saveButton(a.m));
      await settle();
      assert(writes().length === 1 && writes()[0].body?.kind === 'reminder' && show(writes()[0].body?.repeat) === show({ freq: 'hebrew', interval: 1 }), `a reminder sent: ${show(writes()[0]?.body)}`);
    } finally {
      a.m.unmount();
    }
    const off = await hebrewHome('en', false);
    try {
      tapPlus(off.m);
      await settle();
      assert(optionsIn(off.m, 'Repeat').length === 5, `Hebrew dates off: ${show(optionsIn(off.m, 'Repeat'))}`);
    } finally {
      off.m.unmount();
    }
    const g = await googleHome('en');
    try {
      tapPlus(g.m);
      await settle();
      assert(optionsIn(g.m, 'Repeat').length === 5, `a Google user: ${show(optionsIn(g.m, 'Repeat'))}`);
    } finally {
      g.m.unmount();
    }
  });

  await check('#102b create: switching Reminder to Event while a Google calendar is the target drops a Hebrew pick to yearly (Google as the default calendar, or picked first), and the save sends it so', async () => {
    const google = { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5', main: false, mine: true };
    const gMain = editorWith({ calendars: [{ ...google, main: true }, ...EDITOR_INFO.calendars.map((c) => ({ ...c, main: false }))] });
    const flows: [string, EditorInfoResponse, boolean][] = [
      ['Google is the default calendar', gMain, false],
      ['a Google calendar picked first', editorWith({ calendars: [...EDITOR_INFO.calendars, google] }), true],
    ];
    for (const [label, info, pickFirst] of flows) {
      const a = await hebrewHome('en', true, { editor: ok200(info), write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
      try {
        tapPlus(a.m);
        await settle();
        if (pickFirst) await pick(a.m, 'Calendar', 'avi@gmail.com');
        tapIn(a.m, 'Reminder');
        await settle();
        await pick(a.m, 'Repeat', 'hebrew');
        tapIn(a.m, 'Event');
        await settle();
        assert(optionsIn(a.m, 'Repeat').length === 5, `${label}: no Hebrew choices on an event: ${show(optionsIn(a.m, 'Repeat'))}`);
        assert(shownIn(a.m, 'Repeat') === 'Every year on 15 Oct', `${label}: the pick fell back to yearly: ${show(shownIn(a.m, 'Repeat'))}`);
        await typeInto(inDialog(a.m, 'Title'), 'Visit');
        a.m.click(saveButton(a.m));
        await settle();
        assert(writes().length === 1 && show(writes()[0].body?.repeat) === show({ freq: 'yearly', interval: 1 }) && writes()[0].body?.calendarId === 'avi@gmail.com', `${label}: sent: ${show(writes()[0]?.body)}`);
      } finally {
        a.m.unmount();
      }
    }
  });

  await check('#103 edit: a Hebrew item opens (the client takes the choice and the anchor) with its choice selected, worded from the stored anchor and not from the opened (maybe rolled) day; picking another is a repeat change from here on, with no question', async () => {
    const { m } = await hebrewHome('en', true, { item: serveSwim(hebrewSwim('hebrew')), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(m, 'Swimming');
      assert(shownIn(m, 'Repeat') === 'Every year on 30 Cheshvan', `shown: ${show(shownIn(m, 'Repeat'))}`);
      assert(
        show(optionsIn(m, 'Repeat')) ===
          show([['none', 'Never'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly'], ['hebrew', 'Every year on the Hebrew date']]),
        `options: ${show(optionsIn(m, 'Repeat'))}`,
      );
      await typeInto(inDialog(m, 'Location'), 'The pool');
      m.click(saveButton(m));
      await settle();
      assert(choiceTexts(m).includes('All of them'), `a plain edit asks the three: ${show(choiceTexts(m))}`);
      tapIn(m, 'Only this one (Tue 20 Oct)');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'single', changes: { location: 'The pool' } }), `the stored choice is never sent: ${show(writes()[0]?.body)}`);
      m.click(byLabel(topDialog(m), 'Edit'));
      await settle();
      await pick(m, 'Repeat', 'yearly');
      m.click(saveButton(m));
      await settle();
      assert(sameBody(lastWrite().body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'yearly', interval: 1 } } }), `back to yearly: ${show(lastWrite().body)}`);
    } finally {
      m.unmount();
    }
    // A Gregorian series picks Hebrew: worded from the day the new part starts on.
    const yearly = swimSeries({ repeat: { freq: 'yearly', interval: 1, byDay: [], ends: false }, rule: { choice: 'yearly' } });
    const g = await hebrewHome('en', true, { item: serveSwim(yearly), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(g.m, 'Swimming');
      await openRepeat(g.m);
      chooseIn(g.m, 'How often', 'Every year on the Hebrew date');
      assert(summaryOf(g.m) === 'Every year on 9 Cheshvan', `worded from the opened day: ${show(summaryOf(g.m))}`);
      await sheetDone(g.m);
      g.m.click(saveButton(g.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'hebrew', interval: 1 } } }), `sent: ${show(writes()[0]?.body)}`);
    } finally {
      g.m.unmount();
    }
    // A day move: the stored choice keeps its anchor's words.
    const moved = await hebrewHome('en', true, { item: serveSwim(hebrewSwim('hebrew')) });
    try {
      await openEditor(moved.m, 'Swimming');
      await typeInto(inDialog(moved.m, 'Start date'), day(7));
      await openRepeat(moved.m);
      assert(summaryOf(moved.m) === 'Every year on 30 Cheshvan' && freqOptions(moved.m).length === 6, `after a day move: ${show(summaryOf(moved.m))}`);
      await sheetCancel(moved.m);
    } finally {
      moved.m.unmount();
    }
  });

  await check('#103a edit: a Hebrew rule shows its words to anyone who opens it, with Hebrew dates off too (the stored choice only, selected); a Hebrew rule with an end names it; every 2 years is a first, custom choice with the anchor\'s date', async () => {
    const off = await hebrewHome('en', false, { item: serveSwim(hebrewSwim('hebrew')) });
    try {
      await openEditor(off.m, 'Swimming');
      assert(shownIn(off.m, 'Repeat') === 'Every year on 30 Cheshvan', `shown: ${show(shownIn(off.m, 'Repeat'))}`);
      assert(show(optionsIn(off.m, 'Repeat').map((o) => o[0])) === show(['none', 'daily', 'weekly', 'monthly', 'yearly', 'hebrew']), `only the stored one: ${show(optionsIn(off.m, 'Repeat'))}`);
    } finally {
      off.m.unmount();
    }
    const ended = await hebrewHome('en', true, { item: serveSwim(hebrewSwim('hebrew', { until: day(12) })) });
    try {
      await openEditor(ended.m, 'Swimming');
      assert(shownIn(ended.m, 'Repeat') === 'Every year on 30 Cheshvan, until 27 Oct', `ended: ${show(shownIn(ended.m, 'Repeat'))}`);
    } finally {
      ended.m.unmount();
    }
    const custom = await hebrewHome('en', true, { item: serveSwim(hebrewSwim('custom', { interval: 2 })) });
    try {
      await openEditor(custom.m, 'Swimming');
      assert(shownIn(custom.m, 'Repeat') === 'Every 2 years on 30 Cheshvan', `custom: ${show(shownIn(custom.m, 'Repeat'))}`);
      assert(optionsIn(custom.m, 'Repeat')[0][0] === 'custom', 'a first choice of its own');
    } finally {
      custom.m.unmount();
    }
    for (const locale of ['he', 'ru'] as const) {
      const h = await hebrewHome(locale, true, { item: serveSwim(hebrewSwim('hebrew')) });
      try {
        await openEditor(h.m, 'Swimming', messages[locale].calendarHome.sheet.edit);
        const want = locale === 'he' ? 'כל שנה בל׳ בחשון' : 'Каждый год 30 хешвана';
        assert(shownIn(h.m, messages[locale].calendarHome.editor.repeat.label) === want, `${locale}: ${show(shownIn(h.m, messages[locale].calendarHome.editor.repeat.label))}`);
      } finally {
        h.m.unmount();
      }
    }
  });

  await check('#104 edit: an "all" day move the server refuses for a Hebrew series (from a rolled occurrence, or one whose own start is a rolled year) shows the day note, not "Couldn\'t save"', async () => {
    const a = await hebrewHome('en', true, { item: serveSwim(hebrewSwim('hebrew')), write: () => ({ status: 400, body: { error: 'invalid', field: 'start' } }) });
    try {
      await openEditor(a.m, 'Swimming');
      await typeInto(inDialog(a.m, 'Start date'), day(7));
      a.m.click(saveButton(a.m));
      await settle();
      assert(choiceTexts(a.m).includes('All of them'), `the three choices: ${show(choiceTexts(a.m))}`);
      tapIn(a.m, 'All of them');
      await settle();
      assert(writes().length === 1 && writes()[0].body?.scope === 'all', `sent: ${show(writes()[0]?.body)}`);
      assert(alerts(a.m).includes(messages.en.calendarHome.scope.dayMoveNote), `the day note: ${show(alerts(a.m))}`);
      assert(!alerts(a.m).includes('Couldn’t save. Try again.'), `not the generic text: ${show(alerts(a.m))}`);
    } finally {
      a.m.unmount();
    }
  });

  await check('#104c edit: an "all" move the server refuses because the series would start outside its years (reason "year") says so on the start row, not the day note or "Couldn\'t save", in each language', async () => {
    for (const locale of LOCALES) {
      const l = messages[locale].calendarHome;
      const a = await hebrewHome(locale, true, { item: serveSwim(hebrewSwim('hebrew')), write: () => ({ status: 400, body: { error: 'invalid', field: 'start', reason: 'year' } }) });
      try {
        await openEditor(a.m, 'Swimming', l.sheet.edit);
        await typeInto(inDialog(a.m, l.editor.startsDate), day(7));
        a.m.click(saveButton(a.m));
        await settle();
        tapIn(a.m, l.scope.all);
        await settle();
        assert(writes().length === 1 && writes()[0].body?.scope === 'all', `${locale} sent: ${show(writes()[0]?.body)}`);
        assert(alerts(a.m).includes(l.editor.errors.errSeriesYear), `${locale}: the year message: ${show(alerts(a.m))}`);
        assert(!alerts(a.m).includes(l.scope.dayMoveNote) && !alerts(a.m).includes(l.editor.submitErrors.failed), `${locale}: no day note, no generic text: ${show(alerts(a.m))}`);
      } finally {
        a.m.unmount();
      }
    }
  });

  await check('#104b the item sheet names the rule (spec §1, §4): a Hebrew series says "Every year on 30 Cheshvan" (the stored anchor, gematriya in Hebrew, every 2 years named) in place of the generic "Repeats", to a viewer who cannot edit too, with Hebrew dates off too; a Gregorian series keeps "Repeats"', async () => {
    const WORDS: Record<Locale, string> = { en: 'Every year on 30 Cheshvan', he: 'כל שנה בל׳ בחשון', ru: 'Каждый год 30 хешвана' };
    for (const locale of LOCALES) {
      const a = await hebrewHome(locale, true, { item: serveSwim(hebrewSwim('hebrew')) });
      try {
        await openItem(a.m, 'Swimming');
        const text = topText(a.m);
        assert(text.includes(WORDS[locale]), `${locale}: ${show(text)} lacks ${show(WORDS[locale])}`);
        assert(!text.includes(messages[locale].calendarHome.sheet.repeats), `${locale}: the generic tag is gone: ${show(text)}`);
      } finally {
        a.m.unmount();
      }
    }
    // Every 2 years, a viewer who cannot edit, Hebrew dates off: the words still show.
    const viewer = { ...hebrewSwim('hebrew', { interval: 2 }), canEdit: false, canDelete: false };
    const v = await hebrewHome('en', false, { item: serveSwim(viewer) });
    try {
      await openItem(v.m, 'Swimming');
      assert(topText(v.m).includes('Every 2 years on 30 Cheshvan') && !topText(v.m).includes('Repeats'), `viewer: ${show(topText(v.m))}`);
    } finally {
      v.m.unmount();
    }
    // A Gregorian series is unchanged.
    const g = await hebrewHome('en', true, { item: serveSwim(swimSeries({ repeat: { freq: 'yearly', interval: 1, byDay: [], ends: false }, rule: { choice: 'yearly' } })) });
    try {
      await openItem(g.m, 'Swimming');
      assert(topText(g.m).includes('Repeats') && !topText(g.m).includes('Every year on'), `yearly: ${show(topText(g.m))}`);
    } finally {
      g.m.unmount();
    }
    // Before the edit info arrives the generic tag stands.
    const none = await hebrewHome('en', true, { item: () => ({ status: 404, body: {} }) });
    try {
      await openItem(none.m, 'Swimming');
      assert(topText(none.m).includes('Repeats'), `no info: ${show(topText(none.m))}`);
    } finally {
      none.m.unmount();
    }
  });

  await check('#105 the Hebrew copy in en, he and ru: real text, no key left bare, and Hebrew and Russian translated, not copied', () => {
    for (const locale of LOCALES) {
      const l = messages[locale].calendarHome.editor.repeat as unknown as Record<string, string>;
      for (const key of ['hebrewPlain', 'hebrewEvery']) {
        assert(typeof l[key] === 'string' && l[key].length > 0, `${locale}: editor.repeat.${key} exists`);
        if (locale !== 'en') assert(l[key] !== (messages.en.calendarHome.editor.repeat as unknown as Record<string, string>)[key], `${locale}: editor.repeat.${key} is translated`);
      }
    }
  });

  await check('#107 React logged no warning in #102-#105 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeHebrew, `React warned: ${show(reactWarnings.slice(warnedBeforeHebrew, warnedBeforeHebrew + 3))}`);
  });

  // ---- The date and time pickers in the editor (editor upgrades spec §1; P1-P5) ----

  const warnedBeforePickers = reactWarnings.length;
  const cellsOf = (m: Home) => elements(topDialog(m)).filter((e) => e.getAttribute('data-day') !== null);
  const cell = (m: Home, dayKey: string) => cellsOf(m).find((e) => e.getAttribute('data-day') === dayKey) as Fake;
  const swipeLog = (tg: { calls: string[] }) => tg.calls.filter((c) => /VerticalSwipes/.test(c));
  const editorSheetName = (m: Home) => topDialog(m).getAttribute('aria-label');

  await check('P1 a date pill opens the date sheet on the chosen day (focus on it, a grid with one tab stop); Escape and Telegram\'s Back close the sheet before the editor; swipes are off while it is open and on after; a pick closes it, sets the day and ticks', async () => {
    const tg = fakeTelegramHome({ version: '8.0' });
    resetHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    serveEditingWith();
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      tapPlus(m);
      await settle();
      assert(editorSheetName(m) === 'New', `the editor: ${editorSheetName(m)}`);
      const pill = inDialog(m, 'Start date');
      assert(pill.localName === 'button' && pill.getAttribute('aria-haspopup') === 'dialog' && pill.getAttribute('data-value') === TODAY, 'the pill is a button naming the day');
      assert(pill.textContent.includes('Thu, 15 Oct 2026'), `the pill reads the day: ${pill.textContent}`);
      const before = swipeLog(tg).length;
      pill.focus(); // a tap focuses the button; the sheet gives focus back to it
      await clickEl(pill);
      await settle();
      assert(editorSheetName(m) === 'Start date', `the date sheet: ${editorSheetName(m)}`);
      assert(swipeLog(tg).at(-1) === 'disableVerticalSwipes()' && swipeLog(tg).length > before, `swipes off while open: ${show(swipeLog(tg))}`);
      const grid = byRole(topDialog(m), 'grid');
      assert(grid.length === 1 && cellsOf(m).length === 31, `one grid of October's 31 days: ${cellsOf(m).length}`);
      const chosen = cellsOf(m).filter((e) => e.getAttribute('aria-selected') === 'true');
      assert(chosen.length === 1 && chosen[0].getAttribute('data-day') === TODAY, 'the chosen day is selected');
      assert(cellsOf(m).filter((e) => e.getAttribute('tabindex') === '0').map((e) => e.getAttribute('data-day')).join() === TODAY, 'one tab stop, on the chosen day');
      assert(fakeDocument.activeElement === chosen[0], 'focus lands on the chosen day');
      assert(cell(m, TODAY).getAttribute('aria-current') === 'date' && cell(m, TODAY).getAttribute('aria-label') === 'Thursday, 15 October 2026, 4 Cheshvan', `today's cell: ${cell(m, TODAY).getAttribute('aria-label')}`);
      // Escape closes the sheet, not the editor.
      m.key(topDialog(m), 'Escape');
      await settle();
      assert(editorSheetName(m) === 'New', `Escape closed only the sheet: ${editorSheetName(m)}`);
      assert(swipeLog(tg).at(-1) === 'enableVerticalSwipes()', `swipes on again: ${show(swipeLog(tg))}`);
      assert(fakeDocument.activeElement !== null && (fakeDocument.activeElement as Fake).getAttribute('data-pill') === 'date', 'focus is back on the pill');
      // Telegram's Back: the sheet first, then the editor.
      await clickEl(inDialog(m, 'Start date'));
      await settle();
      assert(editorSheetName(m) === 'Start date', 'open again');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(editorSheetName(m) === 'New', 'Back closed the sheet and left the editor');
      // A pick: the day is set, the sheet closed, and the tick sent.
      const ticks = tg.calls.filter((c) => c === 'haptic(selection)').length;
      await typeInto(inDialog(m, 'Start date'), day(3));
      assert(editorSheetName(m) === 'New' && fieldValue(m, 'Start date') === day(3) && fieldValue(m, 'End date') === day(3), `picked: ${fieldValue(m, 'Start date')} ${fieldValue(m, 'End date')}`);
      assert(tg.calls.filter((c) => c === 'haptic(selection)').length > ticks, 'a day tap ticks');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assertHas(topText(m), ['Discard your changes?'], 'Back with no sheet open asks about the changed editor');
    } finally {
      m.unmount();
    }
  });

  await check('P2 the end sheet greys the days before the start and refuses them; the start sheet greys nothing; a series (daily) floors at 2000 and a one-off at 1900 (first and last page chevrons)', async () => {
    const { m } = await editingHome('en');
    try {
      tapPlus(m);
      await settle();
      await typeInto(inDialog(m, 'Start date'), day(5));
      await clickEl(inDialog(m, 'End date'));
      await settle();
      assert(editorSheetName(m) === 'End date', 'the end sheet');
      const dayKeys = cellsOf(m).map((e) => e.getAttribute('data-day') as string);
      const disabled = (k: string) => cell(m, k).getAttribute('aria-disabled') === 'true';
      assert(dayKeys.includes(TODAY) && disabled(TODAY) && disabled(day(4)) && !disabled(day(5)) && !disabled(day(6)), 'days before the start are greyed');
      await clickEl(cell(m, TODAY));
      assert(editorSheetName(m) === 'End date', 'a greyed day does not close the sheet');
      m.key(topDialog(m), 'Escape');
      await settle();
      assert(fieldValue(m, 'End date') === day(5), 'and does not change the end');
      await clickEl(inDialog(m, 'Start date'));
      await settle();
      assert(cellsOf(m).every((e) => e.getAttribute('aria-disabled') === null), 'the start sheet greys nothing');
      // The floor: a one-off pages back to 1900, a daily series stops at 2000.
      const prev = () => elements(topDialog(m)).find((e) => e.getAttribute('aria-label') === 'Previous month') as Fake;
      const back = async (n: number) => {
        for (let i = 0; i < n && prev().getAttribute('disabled') === null; i++) await clickEl(prev());
      };
      await back(130 * 12);
      assert(prev().getAttribute('disabled') !== null, 'the first page of a one-off has no earlier one');
      assert(cellsOf(m)[0].getAttribute('data-day') === '1900-01-01', `a one-off reaches ${cellsOf(m)[0].getAttribute('data-day')}`);
      m.key(topDialog(m), 'Escape');
      await settle();
      await pick(m, 'Repeat', 'daily');
      await clickEl(inDialog(m, 'Start date'));
      await settle();
      await back(130 * 12);
      assert(cellsOf(m)[0].getAttribute('data-day') === '2000-01-01', `a daily series reaches ${cellsOf(m)[0].getAttribute('data-day')}`);
    } finally {
      m.unmount();
    }
  });

  await check('P3 a Hebrew yearly repeat opens the date sheet in Hebrew (the Hebrew month, Hebrew days leading, the switch on Hebrew); any other repeat opens it in Gregorian; the switch swaps which calendar leads on the same cells; Hebrew dates off: no switch and no Hebrew line', async () => {
    const { m } = await hebrewHome('en', true);
    try {
      tapPlus(m);
      await settle();
      await clickEl(inDialog(m, 'Start date'));
      await settle();
      const radios = () => byRole(topDialog(m), 'radio');
      assert(radios().map((r) => r.textContent).join() === 'Gregorian,Hebrew' && radios()[0].getAttribute('aria-checked') === 'true', `the switch: ${radios().map((r) => r.textContent)}`);
      assertHas(topText(m), ['October 2026', 'Tishrei – Cheshvan 5787'], 'Gregorian title and the Hebrew months under it');
      assert(cell(m, TODAY).textContent === '154', `Gregorian leads, the Hebrew day under it: ${cell(m, TODAY).textContent}`);
      await clickEl(radios()[1]);
      await settle();
      assertHas(topText(m), ['Cheshvan 5787', 'Oct – Nov 2026'], 'Hebrew title over the Gregorian months');
      assert(cell(m, TODAY).textContent === '415', `Hebrew leads on the same cell: ${cell(m, TODAY).textContent}`);
      assert(cellsOf(m).length === 29 || cellsOf(m).length === 30, `a Hebrew month: ${cellsOf(m).length} days`);
      assert(cell(m, TODAY).getAttribute('aria-label') === 'Thursday, 15 October 2026, 4 Cheshvan', `the same name in both modes: ${cell(m, TODAY).getAttribute('aria-label')}`);
      m.key(topDialog(m), 'Escape');
      await settle();
      await pick(m, 'Repeat', 'hebrew');
      await clickEl(inDialog(m, 'Start date'));
      await settle();
      assert(radios()[1].getAttribute('aria-checked') === 'true', 'a Hebrew yearly repeat opens in Hebrew');
      assertHas(topText(m), ['Cheshvan 5787'], 'on the Hebrew month');
      m.key(topDialog(m), 'Escape');
      await settle();
      await pick(m, 'Repeat', 'yearly');
      await clickEl(inDialog(m, 'Start date'));
      await settle();
      assert(radios()[0].getAttribute('aria-checked') === 'true', 'a Gregorian repeat opens in Gregorian, nothing remembered');
    } finally {
      m.unmount();
    }
    const off = await hebrewHome('en', false);
    try {
      tapPlus(off.m);
      await settle();
      await clickEl(inDialog(off.m, 'Start date'));
      await settle();
      assert(byRole(topDialog(off.m), 'radio').length === 0, 'no switch without Hebrew dates');
      assert(!topText(off.m).includes('Cheshvan') && !topText(off.m).includes('Chesh.'), 'and no Hebrew line');
      assert(!elements(topDialog(off.m)).some((e) => (e.getAttribute('class') ?? '').includes('ch-picker-sub')), 'no second line on a cell');
    } finally {
      off.m.unmount();
    }
  });

  await check('P4 a time pill opens the time sheet on its time (hours 00-23, minutes in fives; a stored off-step minute joins the minutes); Done applies, Escape cancels; the end follows a moved start', async () => {
    const { m } = await editingHome('en');
    try {
      tapPlus(m);
      await settle();
      const startTime = fieldValue(m, 'Start time') as string;
      await clickEl(inDialog(m, 'Start time'));
      await settle();
      assert(editorSheetName(m) === 'Start time', 'the time sheet');
      const wheels = elements(topDialog(m)).filter((e) => e.getAttribute('data-stub-wheel') !== null);
      assert(wheels.length === 2 && wheels[0].childNodes.length === 24 && wheels[1].childNodes.length === 12, `24 hours and 12 minutes: ${wheels.map((w) => w.childNodes.length)}`);
      assert(wheels[0].getAttribute('data-value') === startTime.slice(0, 2) && wheels[1].getAttribute('data-value') === startTime.slice(3), 'open on the time it has');
      await React.act(() => propsOf(wheels[0]).onChange({ target: { value: '15' } }));
      m.key(topDialog(m), 'Escape');
      await settle();
      assert(fieldValue(m, 'Start time') === startTime, 'Escape cancels what the wheels held');
      await typeInto(inDialog(m, 'Start time'), '15:35');
      assert(fieldValue(m, 'Start time') === '15:35' && fieldValue(m, 'End time') === '16:35', `Done applies and the end follows: ${fieldValue(m, 'Start time')} ${fieldValue(m, 'End time')}`);
      // An off-step minute (10:07 from Google or the bot) joins the wheel.
      await typeInto(inDialog(m, 'Start time'), '10:07');
      await clickEl(inDialog(m, 'Start time'));
      await settle();
      const minutes = elements(topDialog(m)).filter((e) => e.getAttribute('data-stub-wheel') !== null)[1];
      assert(minutes.childNodes.length === 13 && minutes.childNodes.map((c) => c.textContent).includes('07'), `10:07 joins the minutes: ${minutes.childNodes.map((c) => c.textContent)}`);
      assert(minutes.getAttribute('data-value') === '07', 'and is the one chosen');
      await clickEl(elements(topDialog(m)).find((e) => e.localName === 'button' && e.textContent.trim() === 'Done') as Fake);
      await settle();
      assert(fieldValue(m, 'Start time') === '10:07', 'open and Done change nothing');
    } finally {
      m.unmount();
    }
  });

  await check('P5 React logged no warning in P1-P4 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforePickers, `React warned: ${show(reactWarnings.slice(warnedBeforePickers, warnedBeforePickers + 3))}`);
  });

  // ---- Google as a connection (G3): the client reads facts, never calendarSource ----

  const warnedBeforeConnection = reactWarnings.length;
  const GOOGLE_FAMILY_ID = 'family@group.calendar.google.com';

  /** The union editor info the server answers a connected user (G1): FamCal's kinds and partner, plus the writable Google rows; `main` marks the default. */
  const unionEditor = (main: 'famcal' | 'google'): EditorInfoResponse => ({
    kinds: { event: true, reminder: true },
    calendars: [
      { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5', main: main === 'famcal', mine: true },
      { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E', main: false, mine: false, ownerName: 'Noa' },
      { id: GOOGLE_FAMILY_ID, name: 'Google Family', color: '#7986CB', main: false, mine: true },
      { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5', main: main === 'google', mine: true },
    ],
    partner: { name: 'Noa', canRemind: true },
    tz: TZ,
    reminderTime: '09:00',
    alertsOn: false,
    defaultLead: 15,
  });
  /** The home for a user with FamCal and Google both: each source's windows from `world`, the editing routes from `server`. */
  async function bothHome(locale: Locale, server: EditingServer = {}, props: Partial<CalendarHomeProps> = {}) {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const world = { famcal: WEEK as Record<DayKey, ItemDTO[]>, google: { [day(0)]: [DINNER], [day(1)]: [BIRTHDAY, YOGA] } as Record<DayKey, ItemDTO[]> };
    answerFetch = (c) => answerSource(c, { famcal: { items: world.famcal }, google: { items: world.google } });
    serveEditingWith({ editor: ok200(unionEditor('google')), ...server });
    const m = await mountHome(locale, { ...BOTH_HOME, ...props }, fakeClock('2026-10-15T07:00:00Z'));
    return { m, tg, world };
  }

  // ---- The Repeat sheet (editor upgrades spec §3, ruling 9): the row opens it, the cards, the draft, Back, the words, the errors ----

  /** The sheet's parts. */
  const chipsOf = (m: Home) => byClass(topDialog(m), 'ch-day');
  const stepValues = (m: Home) => byClass(topDialog(m), 'ch-step-value').map((e) => e.textContent);
  /** A stepper's buttons: [dec, inc] of the n-th stepper. */
  const stepButtons = (m: Home, n: number) => byClass(topDialog(m), 'ch-step').slice(n * 2, n * 2 + 2);
  const stepper = (m: Home, n: number, dir: '-' | '+') => m.click(stepButtons(m, n)[dir === '-' ? 0 : 1]);
  const endChoices = (m: Home) => radiosOf(m, 'Ends').map((e) => [e.textContent, e.getAttribute('aria-checked')]);
  const SHEET_TG = async (locale: Locale = 'en') => {
    const tg = fakeTelegramHome({ version: '8.0' });
    resetHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    return { tg, mount: () => mountHome(locale, {}, fakeClock('2026-10-15T07:00:00Z')) };
  };

  await check('S1 the Repeat row opens the Repeat sheet over the editor (swipes off while it is open): the summary is the row\'s value; Never shows the frequency card alone; Weekly adds "Every [-] N [+] weeks" (44px buttons, clamped 1..99) and the week\'s chips in the week-start order with the start\'s day on and disabled (with its reason as text); Done applies and closes, and the body sends the spec', async () => {
    const { tg, mount } = await SHEET_TG();
    serveEditingWith({ write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
    const m = await mount();
    try {
      tapPlus(m);
      await settle();
      assert(repeatShown(m) === 'Never' && repeatRow(m).getAttribute('aria-haspopup') === 'dialog', 'the row is a button showing Never');
      const before = swipeLog(tg).length;
      await openRepeat(m);
      assert(swipeLog(tg).at(-1) === 'disableVerticalSwipes()' && swipeLog(tg).length > before, `swipes off while the sheet is open: ${show(swipeLog(tg))}`);
      assert(summaryOf(m) === 'Never', `the summary: ${summaryOf(m)}`);
      assert(show(freqTexts(m)) === show(['Never', 'Daily', 'Weekly', 'Monthly', 'Yearly', 'Every year on the Hebrew date']), 'the frequencies');
      assert(radiosOf(m, 'How often')[0].getAttribute('aria-checked') === 'true' && stepValues(m).length === 0 && chipsOf(m).length === 0, 'Never: the frequency card alone');
      chooseIn(m, 'How often', 'Weekly');
      assert(summaryOf(m) === 'Every week on Thursday', `weekly: ${summaryOf(m)}`);
      assert(stepValues(m).join() === '1', 'every 1');
      const chips = chipsOf(m);
      assert(show(chips.map((c) => c.textContent)) === show(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']), `chips in the week-start order (Sunday): ${show(chips.map((c) => c.textContent))}`);
      const thu = chips[4];
      assert(thu.getAttribute('aria-pressed') === 'true' && thu.getAttribute('aria-disabled') === 'true', 'the start\'s day is on and disabled');
      const reason = thu.getAttribute('aria-describedby');
      assert(reason !== null && elements(topDialog(m)).some((e) => e.getAttribute('id') === reason && e.textContent === 'The day it starts on stays selected.'), 'its reason is text');
      m.click(thu);
      assert(chipsOf(m)[4].getAttribute('aria-pressed') === 'true' && summaryOf(m) === 'Every week on Thursday', 'it can\'t be turned off');
      m.click(chips[0]);
      assert(chipsOf(m)[0].getAttribute('aria-pressed') === 'true' && summaryOf(m) === 'Every week on Sun and Thu', `Sunday joins: ${summaryOf(m)}`);
      m.click(chips[0]);
      assert(summaryOf(m) === 'Every week on Thursday', 'and leaves');
      m.click(chips[0]);
      stepper(m, 0, '+');
      assert(stepValues(m).join() === '2' && summaryOf(m) === 'Every 2 weeks on Sun and Thu', `every 2: ${summaryOf(m)}`);
      stepper(m, 0, '-');
      assert(stepButtons(m, 0)[0].getAttribute('aria-disabled') === 'true', 'at 1 the minus is off');
      const plus = stepButtons(m, 0)[1];
      for (let i = 0; i < 120; i++) stepper(m, 0, '+');
      assert(stepValues(m).join() === '99' && stepButtons(m, 0)[1].getAttribute('aria-disabled') === 'true', `clamped at 99: ${stepValues(m)}`);
      assert(plus === stepButtons(m, 0)[1] && plus.getAttribute('disabled') === null, 'at the limit the button stays a button (aria-disabled, so focus stays), and a press does nothing');
      for (let i = 0; i < 97; i++) stepper(m, 0, '-');
      assert(stepValues(m).join() === '2', `back to 2: ${stepValues(m)}`);
      // Nothing outside the sheet changed yet; Done applies and closes.
      assert(show(elements(m.container).filter((e) => e.className.includes('ch-save')).length) !== '0', 'the editor is still behind');
      await sheetDone(m);
      assert(editorSheetName(m) === 'New' && repeatShown(m) === 'Every 2 weeks on Sun and Thu', `the row after Done: ${show(repeatShown(m))}`);
      assert(swipeLog(tg).at(-1) === 'enableVerticalSwipes()', 'swipes on again');
      await typeInto(inDialog(m, 'Title'), 'Pool');
      m.click(saveButton(m));
      await settle();
      assert(show(writes()[0].body?.repeat) === show({ freq: 'weekly', interval: 2, byDay: ['TH', 'SU'] }), `the body sends the spec: ${show(writes()[0]?.body)}`);
    } finally {
      m.unmount();
    }
  });

  await check('S2 Back, Escape and Cancel close the Repeat sheet first and drop its draft; the editor stays, with its repeat as it was; Back again leaves the editor; the pick Done applied shows when the sheet opens again', async () => {
    const { tg, mount } = await SHEET_TG();
    serveEditingWith();
    const m = await mount();
    try {
      tapPlus(m);
      await settle();
      await openRepeat(m);
      chooseIn(m, 'How often', 'Daily');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(editorSheetName(m) === 'New' && repeatShown(m) === 'Never', `Back closed the sheet only: ${editorSheetName(m)} ${repeatShown(m)}`);
      assert(swipeLog(tg).at(-1) === 'enableVerticalSwipes()', 'swipes on again');
      await openRepeat(m);
      assert(summaryOf(m) === 'Never', 'the draft was dropped');
      chooseIn(m, 'How often', 'Daily');
      m.key(topDialog(m), 'Escape');
      await settle();
      assert(editorSheetName(m) === 'New' && repeatShown(m) === 'Never', 'Escape does the same');
      await openRepeat(m);
      chooseIn(m, 'How often', 'Daily');
      await sheetCancel(m);
      assert(editorSheetName(m) === 'New' && repeatShown(m) === 'Never', 'and so does Cancel');
      await pickFreq(m, 'daily');
      assert(repeatShown(m) === 'Every day', 'Done applies');
      await openRepeat(m);
      assert(summaryOf(m) === 'Every day' && radiosOf(m, 'How often')[1].getAttribute('aria-checked') === 'true', 'it opens on the applied pick');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(editorSheetName(m) === 'New', 'Back closed the sheet');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assertHas(topText(m), ['Discard your changes?'], 'the next Back is the editor\'s: the repeat made it a changed form');
    } finally {
      m.unmount();
    }
  });

  await check('S3 the monthly options follow the start: "On day 15" and "On the third Thursday" (the ordinal is the start\'s), "On the last Thursday" only in the month\'s last seven days; the choice follows a moved start by itself, and a "last" reads as the n-th weekday once the start leaves the last week', async () => {
    const { mount } = await SHEET_TG();
    serveEditingWith({ write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
    const m = await mount();
    try {
      tapPlus(m);
      await settle();
      await typeInto(inDialog(m, 'Title'), 'Rent');
      await openRepeat(m);
      chooseIn(m, 'How often', 'Monthly');
      assert(summaryOf(m) === 'Every month on the 15th', `monthly: ${summaryOf(m)}`);
      assert(show(radiosOf(m, 'Each month').map((e) => e.textContent)) === show(['On day 15', 'On the third Thursday']), `options: ${show(radiosOf(m, 'Each month').map((e) => e.textContent))}`);
      chooseIn(m, 'Each month', 'On the third Thursday');
      assert(summaryOf(m) === 'Every month on the third Thursday', `the n-th weekday: ${summaryOf(m)}`);
      await sheetDone(m);
      await typeInto(inDialog(m, 'Start date'), '2026-10-22');
      assert(repeatShown(m) === 'Every month on the fourth Thursday', `the ordinal follows the start: ${repeatShown(m)}`);
      await typeInto(inDialog(m, 'Start date'), '2026-10-29');
      await openRepeat(m);
      assert(show(radiosOf(m, 'Each month').map((e) => e.textContent)) === show(['On day 29', 'On the fifth Thursday', 'On the last Thursday']), `the last week: ${show(radiosOf(m, 'Each month').map((e) => e.textContent))}`);
      chooseIn(m, 'Each month', 'On the last Thursday');
      assert(summaryOf(m) === 'Every month on the last Thursday', `last: ${summaryOf(m)}`);
      await sheetDone(m);
      m.click(saveButton(m));
      await settle();
      assert(show(writes()[0].body?.repeat) === show({ freq: 'monthly', interval: 1, monthly: 'last' }), `sent: ${show(writes()[0]?.body)}`);
    } finally {
      m.unmount();
    }
    // Moving the start out of the last week: the choice is the day again, in the row and in the body.
    const { mount: again } = await SHEET_TG();
    serveEditingWith({ write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
    const n = await again();
    try {
      tapPlus(n);
      await settle();
      await typeInto(inDialog(n, 'Title'), 'Rent');
      await typeInto(inDialog(n, 'Start date'), '2026-10-29');
      await openRepeat(n);
      chooseIn(n, 'How often', 'Monthly');
      chooseIn(n, 'Each month', 'On the last Thursday');
      await sheetDone(n);
      await typeInto(inDialog(n, 'Start date'), '2026-10-22');
      assert(repeatShown(n) === 'Every month on the fourth Thursday', `back to the n-th weekday: ${repeatShown(n)}`);
      n.click(saveButton(n));
      await settle();
      assert(show(writes()[0].body?.repeat) === show({ freq: 'monthly', interval: 1, monthly: 'weekday' }), `sent: ${show(writes()[0]?.body)}`);
    } finally {
      n.unmount();
    }
  });

  await check('S4 Ends: Never, On <date> (the date sheet, not before the start; Escape and Back close it before the Repeat sheet) and After N times (a stepper clamped 1..999); one end at a time; the words and the body carry it', async () => {
    const { tg, mount } = await SHEET_TG();
    serveEditingWith({ write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
    const m = await mount();
    try {
      tapPlus(m);
      await settle();
      await typeInto(inDialog(m, 'Title'), 'Pool');
      await openRepeat(m);
      assert(radioGroup(m, 'Ends') === undefined && elements(topDialog(m)).filter((e) => e.getAttribute('role') === 'radiogroup').length === 1, 'no Ends for Never');
      chooseIn(m, 'How often', 'Daily');
      assert(show(endChoices(m)) === show([['Never', 'true'], ['On date', 'false'], ['After', 'false']]), `Ends: ${show(endChoices(m))}`);
      assert(!elements(topDialog(m)).some((e) => e.getAttribute('data-pill') === 'date'), 'Never has no date');
      chooseIn(m, 'Ends', 'On date');
      const pill = inDialog(m, 'Repeat end date');
      assert(pill.getAttribute('data-value') === '2026-10-19', `a first end four days on: ${pill.getAttribute('data-value')}`);
      assert(summaryOf(m) === 'Every day, until 19 Oct', `until: ${summaryOf(m)}`);
      // The date sheet: nothing before the start; Escape and Back close it first.
      await clickEl(pill);
      await settle();
      assert(editorSheetName(m) === 'Repeat end date' && swipeLog(tg).at(-1) === 'disableVerticalSwipes()', `the date sheet: ${editorSheetName(m)}`);
      const disabled = (k: string) => cell(m, k).getAttribute('aria-disabled') === 'true';
      assert(disabled(day(-1)) && !disabled(TODAY) && !disabled(day(1)), 'days before the start are greyed, the start\'s own day is not');
      m.key(topDialog(m), 'Escape');
      await settle();
      assert(editorSheetName(m) === 'Repeat', 'Escape closed the date sheet only');
      await clickEl(inDialog(m, 'Repeat end date'));
      await settle();
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(editorSheetName(m) === 'Repeat', 'Back closed the date sheet only');
      await typeInto(inDialog(m, 'Repeat end date'), '2026-10-25');
      assert(editorSheetName(m) === 'Repeat' && summaryOf(m) === 'Every day, until 25 Oct', `picked: ${summaryOf(m)}`);
      chooseIn(m, 'Ends', 'After');
      assert(!elements(topDialog(m)).some((e) => e.getAttribute('data-pill') === 'date') && stepValues(m).join() === '1,5', `After: ${stepValues(m)}`);
      assert(summaryOf(m) === 'Every day, 5 times', `times: ${summaryOf(m)}`);
      stepper(m, 1, '+');
      assert(summaryOf(m) === 'Every day, 6 times', 'six');
      for (let i = 0; i < 6; i++) stepper(m, 1, '-');
      assert(summaryOf(m) === 'Every day, once' && stepButtons(m, 1)[0].getAttribute('aria-disabled') === 'true', `once, clamped at 1: ${summaryOf(m)}`);
      for (let i = 0; i < 1000; i++) stepper(m, 1, '+');
      assert(stepValues(m)[1] === '999' && stepButtons(m, 1)[1].getAttribute('aria-disabled') === 'true', `clamped at 999, the plus is off: ${stepValues(m)}`);
      for (let i = 0; i < 993; i++) stepper(m, 1, '-');
      assert(stepValues(m)[1] === '6', 'six again');
      await sheetDone(m);
      assert(repeatShown(m) === 'Every day, 6 times', `the row: ${repeatShown(m)}`);
      m.click(saveButton(m));
      await settle();
      assert(show(writes()[0].body?.repeat) === show({ freq: 'daily', interval: 1, count: 6 }), `sent with its end: ${show(writes()[0]?.body)}`);
    } finally {
      m.unmount();
    }
    // An end the start has moved past is the Repeat row's own error, and nothing is sent.
    const { mount: again } = await SHEET_TG();
    serveEditingWith({ write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
    const n = await again();
    try {
      tapPlus(n);
      await settle();
      await typeInto(inDialog(n, 'Title'), 'Pool');
      await openRepeat(n);
      chooseIn(n, 'How often', 'Daily');
      chooseIn(n, 'Ends', 'On date');
      await sheetDone(n);
      assert(repeatShown(n) === 'Every day, until 19 Oct', `until: ${repeatShown(n)}`);
      await typeInto(inDialog(n, 'Start date'), '2026-10-30');
      n.click(saveButton(n));
      await settle();
      assert(writes().length === 0 && alerts(n).includes('The repeat can\'t end before it starts'), `an end before the start: ${show(alerts(n))} ${writes().length}`);
      assert(repeatRow(n).getAttribute('aria-describedby') !== null, 'the Repeat row points at its error');
    } finally {
      n.unmount();
    }
    // Hebrew gets the end and every N years (ruling B).
    const h = await hebrewHome('en', true, { write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
    try {
      tapPlus(h.m);
      await settle();
      await typeInto(inDialog(h.m, 'Title'), 'Grandpa');
      await openRepeat(h.m);
      chooseIn(h.m, 'How often', 'Every year on the Hebrew date');
      assert(byClass(topDialog(h.m), 'ch-step-value').length === 1 && byClass(topDialog(h.m), 'ch-step-unit')[0].textContent === 'year', 'Hebrew: every N years');
      stepper(h.m, 0, '+');
      stepper(h.m, 0, '+');
      chooseIn(h.m, 'Ends', 'After');
      stepper(h.m, 1, '-');
      stepper(h.m, 1, '-');
      assert(summaryOf(h.m) === 'Every 3 years on 4 Cheshvan, 3 times', `Hebrew: ${summaryOf(h.m)}`);
      await sheetDone(h.m);
      h.m.click(saveButton(h.m));
      await settle();
      assert(show(writes()[0].body?.repeat) === show({ freq: 'hebrew', interval: 3, count: 3 }), `sent: ${show(writes()[0]?.body)}`);
    } finally {
      h.m.unmount();
    }
  });

  await check('S5 a rule the sheet can\'t say is the first, selected choice "Current: <words>", kept unless another is made (Done on it sends nothing; going back to it after a pick sends nothing); picking another sends the spec', async () => {
    const custom = swimSeries({ repeat: { freq: 'weekly', interval: 2, byDay: [], ends: false }, rule: { choice: 'custom' } });
    const e = await editingHome('en', { item: serveSwim(custom), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(e.m, 'Swimming');
      await openRepeat(e.m);
      assert(show(freqTexts(e.m).slice(0, 2)) === show(['Current: Every 2 weeks', 'Never']), `Current first: ${show(freqTexts(e.m))}`);
      assert(radiosOf(e.m, 'How often')[0].getAttribute('aria-checked') === 'true' && summaryOf(e.m) === 'Every 2 weeks', 'selected, and the summary says its words');
      assert(stepValues(e.m).length === 0 && chipsOf(e.m).length === 0, 'no controls for a rule the sheet can\'t say');
      await sheetDone(e.m);
      await typeInto(inDialog(e.m, 'Location'), 'The pool');
      // Pick Daily, then change your mind: the stored rule again, nothing sent.
      await openRepeat(e.m);
      chooseIn(e.m, 'How often', 'Daily');
      chooseIn(e.m, 'How often', 'Current: Every 2 weeks');
      await sheetDone(e.m);
      e.m.click(saveButton(e.m));
      await settle();
      tapIn(e.m, 'This one and the ones after');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { location: 'The pool' } }), `no repeat: ${show(writes()[0]?.body)}`);
      e.m.click(byLabel(topDialog(e.m), 'Edit'));
      await settle();
      await pickRepeat(e.m, 'Weekly');
      e.m.click(saveButton(e.m));
      await settle();
      assert(sameBody(lastWrite().body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'weekly', interval: 2, byDay: ['TU'] } } }), `a pick sends the spec (its N, same frequency): ${show(lastWrite().body)}`);
    } finally {
      e.m.unmount();
    }
  });

  await check('S6 a stored spec opens in the sheet as it is (the weekly days, N, the end, the monthly choice); a series whose rule fixes its days moved with "this one and the ones after" sends the shown spec so the days gain the new start\'s', async () => {
    const multi = swimSeries({ spec: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, fixedDays: true, rule: { choice: 'custom' }, first: false, repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'], ends: false } });
    const a = await editingHome('en', { item: serveSwim(multi), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(a.m, 'Swimming');
      assert(repeatShown(a.m) === 'Every week on Tue and Thu', `the row: ${repeatShown(a.m)}`);
      await openRepeat(a.m);
      assert(chipsOf(a.m).filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent).join() === 'Tue,Thu', 'its days are on');
      assert(chipsOf(a.m)[2].getAttribute('aria-disabled') === 'true' && chipsOf(a.m)[4].getAttribute('aria-disabled') === null, 'the start\'s Tuesday is pinned, Thursday can be turned off');
      await sheetCancel(a.m);
      // Done on an unchanged spec is no edit: Back leaves the editor without asking.
      await openRepeat(a.m);
      await sheetDone(a.m);
      React.act(() => a.tg.fire('backButtonClicked'));
      await settle();
      assert(topDialog(a.m).getAttribute('aria-label') === 'Details', `Done with nothing changed, then Back: the editor closed without asking: ${show(topDialog(a.m).getAttribute('aria-label'))}`);
      await openEditorAgain(a.m);
      await typeInto(inDialog(a.m, 'Start date'), day(8));
      a.m.click(saveButton(a.m));
      await settle();
      assert(show(choiceTexts(a.m)) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'Cancel']), `this one, or from here on: ${show(choiceTexts(a.m))}`);
      tapIn(a.m, 'This one and the ones after');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { start: `${day(8)}T17:00`, end: `${day(8)}T18:00`, repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH', 'FR'] } } }), `restated on the new start: ${show(writes()[0]?.body)}`);
    } finally {
      a.m.unmount();
    }
    const nth = swimSeries({ spec: { freq: 'monthly', interval: 2, monthly: 'weekday', count: 4 }, fixedDays: true, rule: { choice: 'custom' }, first: true, repeat: { freq: 'monthly', interval: 2, byDay: ['TU'], byDayOrdinals: [3], ends: true, count: 4 } });
    const b = await editingHome('en', { item: serveSwim(nth) });
    try {
      await openEditor(b.m, 'Swimming');
      assert(repeatShown(b.m) === 'Every 2 months on the third Tuesday, 4 times', `monthly, ended: ${repeatShown(b.m)}`);
      await openRepeat(b.m);
      assert(stepValues(b.m).join() === '2,4' && endChoices(b.m)[2][1] === 'true' && radiosOf(b.m, 'Each month')[1].getAttribute('aria-checked') === 'true', 'N, the end and the choice are the stored ones');
      await sheetCancel(b.m);
    } finally {
      b.m.unmount();
    }
  });

  await check('S7 the server\'s refusal of the repeat (400 invalid, field repeat) shows under the Repeat row, not above Save; editing the repeat clears it', async () => {
    const { mount } = await SHEET_TG();
    serveEditingWith({ write: () => ({ status: 400, body: { error: 'invalid', field: 'repeat' } }) });
    const m = await mount();
    try {
      tapPlus(m);
      await settle();
      await typeInto(inDialog(m, 'Title'), 'Pool');
      await pickFreq(m, 'weekly');
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 1 && show(alerts(m)) === show(['Check how it repeats']), `the row's own error: ${show(alerts(m))}`);
      assert(repeatRow(m).getAttribute('aria-describedby') !== null && repeatRow(m).getAttribute('aria-describedby') === byRole(topDialog(m), 'alert')[0].getAttribute('id'), 'the row points at its error');
      const bar = byClass(topDialog(m), 'ch-save-bar')[0];
      assert(!byRole(bar, 'alert').length, 'nothing above Save');
      await pickFreq(m, 'daily');
      assert(show(alerts(m)) === show([]), `editing clears it: ${show(alerts(m))}`);
    } finally {
      m.unmount();
    }
  });

  await check('S8 the scope sheet names "all of them" by the series\' words when it is richer than every day / every <weekday> ("Every 2 weeks on Sun and Tue"); a series that ends keeps "All of them"', async () => {
    const rich = swimSeries({ spec: { freq: 'weekly', interval: 2, byDay: ['TU', 'SU'] }, rule: { choice: 'custom' }, repeat: { freq: 'weekly', interval: 2, byDay: ['SU', 'TU'], ends: false } });
    const a = await editingHome('en', { item: serveSwim(rich), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(a.m, 'Swimming');
      await typeInto(inDialog(a.m, 'Location'), 'The pool');
      a.m.click(saveButton(a.m));
      await settle();
      assert(show(choiceTexts(a.m)) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'Every 2 weeks on Sun and Tue', 'Cancel']), `the short name: ${show(choiceTexts(a.m))}`);
    } finally {
      a.m.unmount();
    }
    const ends = swimSeries({ spec: { freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], count: 5 }, rule: { choice: 'custom' }, repeat: { freq: 'weekly', interval: 2, byDay: ['SU', 'TU'], ends: true, count: 5 } });
    const b = await editingHome('en', { item: serveSwim(ends) });
    try {
      await openEditor(b.m, 'Swimming');
      await typeInto(inDialog(b.m, 'Location'), 'The pool');
      b.m.click(saveButton(b.m));
      await settle();
      assert(choiceTexts(b.m).includes('All of them'), `an ending series: ${show(choiceTexts(b.m))}`);
    } finally {
      b.m.unmount();
    }
  });

  await check('S9 the Repeat sheet in he and ru: real text, the words agree (Hebrew «ביום חמישי השלישי בכל חודש», Russian «каждый третий четверг месяца»), the weekday list in the locale\'s short names, the stepper reads left to right, no key left bare', async () => {
    const WANT: Record<'he' | 'ru', { weekly: string; monthly: string; day: string; unit: string }> = {
      he: { weekly: 'כל שבוע בימים א׳ וה׳', monthly: 'ביום חמישי השלישי בכל חודש', day: 'ה׳', unit: 'שבוע' },
      ru: { weekly: 'Каждую неделю, по вс и чт', monthly: 'Каждый третий четверг месяца', day: 'чт', unit: 'неделю' },
    };
    const WANT_OPTIONS = { he: ['ב-15 בחודש', 'ביום חמישי השלישי בכל חודש'], ru: ['15-го числа', 'В третий четверг'] };
    for (const locale of ['he', 'ru'] as const) {
      const l = messages[locale].calendarHome;
      const { mount } = await SHEET_TG(locale);
      serveEditingWith({ write: () => ok200({ status: 'ok', key: 'famcal|new' }) });
      const m = await mount();
      try {
        tapPlus(m, l.header.add);
        await settle();
        await typeInto(inDialog(m, l.editor.fields.title), 'Pool');
        m.click(valueRow(m, l.editor.repeat.label));
        await settle();
        assert(topDialog(m).getAttribute('aria-label') === l.editor.repeat.label, `${locale}: the sheet`);
        assert(summaryOf(m) === l.editor.repeat.none, `${locale}: Never says ${summaryOf(m)}`);
        m.click(byRole(topDialog(m), 'radio').filter((r) => r.getAttribute('data-value') === 'weekly')[0]);
        const chips = chipsOf(m);
        assert(chips.length === 7 && chips[4].textContent === WANT[locale].day && chips[4].getAttribute('aria-disabled') === 'true', `${locale}: chips: ${show(chips.map((c) => c.textContent))}`);
        assert(chips[4].getAttribute('aria-label') !== null && !chips[4].getAttribute('aria-label')?.includes('editor.repeat'), `${locale}: a name for the chip`);
        m.click(chips[0]);
        assert(summaryOf(m) === WANT[locale].weekly, `${locale}: weekly: ${show(summaryOf(m))}`);
        const stepRow = byClass(topDialog(m), 'ch-stepper')[0];
        assert(stepRow.getAttribute('dir') === 'ltr' && byClass(topDialog(m), 'ch-step-unit')[0].textContent === WANT[locale].unit, `${locale}: the stepper is left to right, its unit ${byClass(topDialog(m), 'ch-step-unit')[0].textContent}`);
        m.click(byRole(topDialog(m), 'radio').filter((r) => r.getAttribute('data-value') === 'monthly')[0]);
        const monthlyOptionTexts = radiosOf(m, l.editor.repeat.monthlyLabel).map((r) => r.textContent.trim());
        assert(show(monthlyOptionTexts) === show(WANT_OPTIONS[locale]), `${locale}: the monthly options read as sentences: ${show(monthlyOptionTexts)}`);
        m.click(radiosOf(m, l.editor.repeat.monthlyLabel).filter((r) => r.getAttribute('data-value') === 'weekday')[0]);
        assert(summaryOf(m) === WANT[locale].monthly, `${locale}: monthly: ${show(summaryOf(m))}`);
        assertLacks(topText(m), ['editor.repeat', 'calendarHome'], `${locale}: no key left bare`);
        await sheetDone(m);
        assert(shownIn(m, l.editor.repeat.label) === WANT[locale].monthly, `${locale}: the row says it: ${show(shownIn(m, l.editor.repeat.label))}`);
        m.click(saveButton(m));
        await settle();
        assert(show(writes()[0].body?.repeat) === show({ freq: 'monthly', interval: 1, monthly: 'weekday' }), `${locale}: sent: ${show(writes()[0]?.body)}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('S11 a series in another zone than the user\'s (a Tuesday 02:00 series in Jerusalem, Monday 19:00 for a user in New York) is worded and built on the series\' day: a plain weekly on Tuesday, not Monday and Tuesday; a pick sends Tuesday', async () => {
    const zoned = swimSeries(
      { spec: { freq: 'weekly', interval: 1, byDay: ['TU'] }, zone: 'Asia/Jerusalem', start: `${day(4)}T19:00`, rule: { choice: 'weekly' }, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'], ends: false } },
      { tz: 'America/New_York', occurrence: { start: `${day(4)}T19:00`, end: `${day(4)}T20:00`, allDay: false, title: 'Swimming', location: '', description: '' } },
    );
    const a = await editingHome('en', { item: serveSwim(zoned), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(a.m, 'Swimming');
      assert(fieldValue(a.m, 'Start date') === day(4), 'the form shows the user\'s Monday');
      assert(repeatShown(a.m) === 'Every week on Tuesday', `the row: ${repeatShown(a.m)}`);
      await openRepeat(a.m);
      assert(chipsOf(a.m).filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent).join() === 'Tue' && chipsOf(a.m)[2].getAttribute('aria-disabled') === 'true', 'only the series\' Tuesday is on, and pinned');
      stepper(a.m, 0, '+');
      await sheetDone(a.m);
      a.m.click(saveButton(a.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'weekly', interval: 2, byDay: ['TU'] } } }), `a pick says Tuesday: ${show(writes()[0]?.body)}`);
    } finally {
      a.m.unmount();
    }
  });

  await check('S12 a weekly Tue/Thu series whose Tuesday is moved to a Thursday it already has offers only "Only this one" (never a silent repeat change, and no "this one and the ones after" the server would refuse), and sends no repeat; leaving a custom rule for a frequency keeps its end and, for the same frequency, its N; the Hebrew choice stays while the stored rule is Hebrew', async () => {
    const multi = swimSeries({ spec: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, fixedDays: true, rule: { choice: 'custom' }, first: false, repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'], ends: false } });
    const a = await editingHome('en', { item: serveSwim(multi), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(a.m, 'Swimming');
      await typeInto(inDialog(a.m, 'Start date'), day(7));
      a.m.click(saveButton(a.m));
      await settle();
      assert(show(choiceTexts(a.m)) === show(['Only this one (Tue 20 Oct)', 'Cancel']), `asked: ${show(choiceTexts(a.m))}`);
      tapIn(a.m, 'Only this one (Tue 20 Oct)');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'single', changes: { start: `${day(7)}T17:00`, end: `${day(7)}T18:00` } }), `this one alone, no repeat: ${show(writes()[0]?.body)}`);
    } finally {
      a.m.unmount();
    }
    const custom = swimSeries({ repeat: { freq: 'weekly', interval: 2, byDay: [], ends: true }, rule: { choice: 'custom', until: day(12) } });
    const b = await editingHome('en', { item: serveSwim(custom), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(b.m, 'Swimming');
      await openRepeat(b.m);
      chooseIn(b.m, 'How often', 'Weekly');
      assert(summaryOf(b.m) === 'Every 2 weeks on Tuesday, until 27 Oct' && endChoices(b.m)[1][1] === 'true', `its end and N carry: ${summaryOf(b.m)}`);
      await sheetDone(b.m);
      b.m.click(saveButton(b.m));
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { repeat: { freq: 'weekly', interval: 2, byDay: ['TU'], until: day(12) } } }), `sent with the end: ${show(writes()[0]?.body)}`);
      b.m.click(byLabel(topDialog(b.m), 'Edit'));
      await settle();
      await openRepeat(b.m);
      chooseIn(b.m, 'How often', 'Daily');
      assert(summaryOf(b.m) === 'Every day, until 27 Oct', `another frequency: the end, N back to 1: ${summaryOf(b.m)}`);
      await sheetCancel(b.m);
    } finally {
      b.m.unmount();
    }
    const counted = swimSeries({ repeat: { freq: 'weekly', interval: 2, byDay: [], ends: true, count: 8 }, rule: { choice: 'custom', until: day(54) } });
    const c = await editingHome('en', { item: serveSwim(counted), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(c.m, 'Swimming');
      await openRepeat(c.m);
      chooseIn(c.m, 'How often', 'Weekly');
      assert(summaryOf(c.m) === 'Every 2 weeks on Tuesday, 8 times' && endChoices(c.m)[2][1] === 'true', `a count stays a count: ${summaryOf(c.m)} ${show(endChoices(c.m))}`);
      await sheetCancel(c.m);
    } finally {
      c.m.unmount();
    }
    const h = await hebrewHome('en', false, { item: serveSwim(hebrewSwim('hebrew')) });
    try {
      await openEditor(h.m, 'Swimming');
      await openRepeat(h.m);
      chooseIn(h.m, 'How often', 'Yearly');
      assert(freqOptions(h.m).some((o) => o[0] === 'hebrew'), `the Hebrew choice stays while the stored rule is Hebrew: ${show(freqOptions(h.m))}`);
      await sheetCancel(h.m);
    } finally {
      h.m.unmount();
    }
  });

  await check('S13 an untouched Done on the Repeat sheet applies nothing: Tue/Thu moved to a Wednesday, the sheet opened and Done pressed, the start moved back to the Tuesday and the title edited asks its scope question and sends no repeat (the Wednesday was not baked in)', async () => {
    const multi = swimSeries({ spec: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, fixedDays: true, rule: { choice: 'custom' }, first: false, repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'], ends: false } });
    const a = await editingHome('en', { item: serveSwim(multi), write: () => ok200({ status: 'ok', key: 'famcal|swim' }) });
    try {
      await openEditor(a.m, 'Swimming');
      await typeInto(inDialog(a.m, 'Start date'), day(6));
      await openRepeat(a.m);
      await sheetDone(a.m);
      await typeInto(inDialog(a.m, 'Start date'), day(5));
      await typeInto(inDialog(a.m, 'Title'), 'Pool');
      a.m.click(saveButton(a.m));
      await settle();
      assert(writes().length === 0, `asked, not written: ${show(writes()[0]?.body)}`);
      assert(show(choiceTexts(a.m)) === show(['Only this one (Tue 20 Oct)', 'This one and the ones after', 'Every week on Tue and Thu', 'Cancel']), `the scope question: ${show(choiceTexts(a.m))}`);
      tapIn(a.m, 'This one and the ones after');
      await settle();
      assert(sameBody(writes()[0].body, { user_id: 5550001, initData: INIT, key: 'famcal|swim', scope: 'following', changes: { title: 'Pool' } }), `title only: ${show(writes()[0]?.body)}`);
    } finally {
      a.m.unmount();
    }
  });

  await check('S10 the Repeat sheet\'s CSS: 44px targets (chips, steppers), logical properties only, nothing under 11px, no hover, a reduced-motion-safe transition; the form kit\'s new rows (choice rows, stepper) follow the same rules', () => {
    for (const [what, css] of [['RepeatSheet', REPEAT_CSS], ['form kit', FORM_CSS]] as const) {
      assert(!/:hover/.test(css) && !/\b(margin|padding)-(left|right)\b|\b(left|right)\s*:|text-align:\s*(left|right)/.test(css), `${what}: no hover, logical properties only`);
      assert(!Array.from(css.matchAll(/font-size:\s*(\d+)px/g)).some((x) => Number(x[1]) < 11), `${what}: nothing under 11px`);
    }
    assert(/\.ch-day \{[^}]*min-block-size: 44px/.test(REPEAT_CSS), 'a chip is at least 44px tall');
    assert(/\.ch-step \{[^}]*inline-size: 44px;[^}]*block-size: 44px/.test(FORM_CSS), 'a stepper button is 44px');
    assert(/@media \(prefers-reduced-motion: no-preference\)[^@]*transition/.test(REPEAT_CSS) && !/transition/.test(REPEAT_CSS.replace(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*$/, '')), 'its only transition sits behind no-preference');
    assert(/\.ch-form-row \{[^}]*min-block-size: 48px/.test(FORM_CSS), 'a row is at least 48px');
  });

  await check('#108 a connected user\'s home reads both sources: FamCal and Google are each asked, their items share the Agenda, "Show next week" and the foreground ask both, and a Google outage leaves FamCal\'s days in place', async () => {
    const { m } = await bothHome('en');
    try {
      assert(show(ranges()) === show(['famcal default', 'google default']), `first load: ${show(ranges())}`);
      assert(rangeCalls().every((c) => c.query.get('user_id') === '5550003'), 'under the page\'s user_id');
      assertHas(m.text(), ['Grandma visits', 'Dinner with the Cohens'], 'both sources\' events, one list');
      assert(m.html().includes('role="tablist"'), 'the tab bar');
      fetchCalls.length = 0;
      m.click(button(m.container, 'Show next week'));
      await settle();
      assert(show(ranges().slice().sort()) === show([`famcal ${day(7)}→${day(14)}`, `google ${day(7)}→${day(14)}`]), `next week asks both: ${show(ranges())}`);
      fetchCalls.length = 0;
      await fireDocument('visibilitychange');
      await settle();
      assert(ranges().some((r) => r.startsWith('famcal ')) && ranges().some((r) => r.startsWith('google ')), `the foreground asks both: ${show(ranges())}`);
    } finally {
      m.unmount();
    }
    // Google down: its error row shows, and FamCal's days stay (review focus 2).
    resetHome();
    answerFetch = (c) => answerSource(c, { famcal: { items: WEEK }, google: { sources: { google: { status: 'error', reason: 'transient' } }, calendars: [] } });
    const down = await mountHome('en', BOTH_HOME);
    try {
      assertHas(down.text(), ['Grandma visits', 'Couldn’t load Google Calendar Retry'], 'FamCal\'s events and the Google error row');
      assertLacks(down.text(), ['Couldn’t load FamCal', 'Busy right now'], 'FamCal is fine');
    } finally {
      down.unmount();
    }
    // A dead token (Google answers reconnect): the Reconnect banner, FamCal untouched.
    resetHome();
    answerFetch = (c) => answerSource(c, { famcal: { items: WEEK }, google: { sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] } });
    const dead = await mountHome('en', BOTH_HOME);
    try {
      assert(dead.html().includes('data-banner="reconnect"'), 'the Reconnect banner, once Google asked for it');
      assertHas(dead.text(), ['Grandma visits'], 'FamCal\'s events');
      assert(!dead.html().includes('data-banner="chooseCalendars"'), 'and not Choose calendars');
    } finally {
      dead.unmount();
    }
  });

  await check('#109 the "+" and reminders for a user with Google: the Event | Reminder switch, one Calendar row of both kinds in the server\'s order, the default from the server\'s main (a Google primary, or the FamCal main), a reminder carrying no calendar; a create refreshes the source of the calendar it went to', async () => {
    const { m } = await bothHome('en');
    try {
      assert(hasPlus(m), 'the "+" for a user with Google');
      tapPlus(m);
      await settle();
      assert(show(byRole(topDialog(m), 'radio').map((e) => e.textContent)) === show(['Event', 'Reminder']), 'the Event | Reminder switch');
      assert(show(optionsIn(m, 'Calendar')) === show([['native:cal_me_7f3a', 'Family'], ['native:cal_noa_91b2', 'Noa and the kids · Noa'], [GOOGLE_FAMILY_ID, 'Google Family'], ['avi@gmail.com', 'Avi']]), `calendars: ${show(optionsIn(m, 'Calendar'))}`);
      assert(shownIn(m, 'Calendar') === 'Avi', `the Google primary is the default: ${shownIn(m, 'Calendar')}`);
      // An event on a FamCal calendar: FamCal's windows are asked again, not Google's.
      await typeInto(inDialog(m, 'Title'), 'Lunch');
      await pick(m, 'Calendar', 'native:cal_me_7f3a');
      fetchCalls.length = 0;
      serveEditing = (c) => (c.path === '/api/calendar/editor' ? ok200(unionEditor('google')) : ok200({ status: 'ok', key: 'famcal|new1' }));
      m.click(saveButton(m));
      await settle();
      assert(writes().length === 1 && writes()[0].body?.calendarId === 'native:cal_me_7f3a' && writes()[0].body?.kind === 'event', `FamCal create: ${show(writes()[0]?.body)}`);
      const afterFamcal = rangeCalls().map((c) => c.query.get('sources'));
      assert(afterFamcal.length > 0 && afterFamcal.every((s2) => s2 === 'famcal'), `only FamCal is asked: ${show(afterFamcal)}`);
      // An event on a Google calendar: Google's windows.
      tapPlus(m);
      await settle();
      await typeInto(inDialog(m, 'Title'), 'Dinner');
      await pick(m, 'Calendar', GOOGLE_FAMILY_ID);
      fetchCalls.length = 0;
      serveEditing = (c) => (c.path === '/api/calendar/editor' ? ok200(unionEditor('google')) : ok200({ status: 'ok', key: 'google|x|new2' }));
      m.click(saveButton(m));
      await settle();
      assert(writes()[0].body?.calendarId === GOOGLE_FAMILY_ID, `Google create: ${show(writes()[0]?.body)}`);
      const afterGoogle = rangeCalls().map((c) => c.query.get('sources'));
      assert(afterGoogle.length > 0 && afterGoogle.every((s2) => s2 === 'google'), `only Google is asked: ${show(afterGoogle)}`);
      // A reminder: no Calendar row, no calendar in the body (the server pins it to FamCal), FamCal refreshed.
      tapPlus(m);
      await settle();
      tapIn(m, 'Reminder');
      assert(!hasField(m, 'Calendar') && !elements(topDialog(m)).some((e) => e.localName === 'select' && e.getAttribute('aria-label') === 'Calendar'), 'a reminder has no Calendar row');
      await typeInto(inDialog(m, 'Title'), 'Call Grandma');
      fetchCalls.length = 0;
      serveEditing = (c) => (c.path === '/api/calendar/editor' ? ok200(unionEditor('google')) : ok200({ status: 'ok', key: 'famcal|rem' }));
      m.click(saveButton(m));
      await settle();
      assert(writes()[0].body?.kind === 'reminder' && !('calendarId' in (writes()[0].body ?? {})), `reminder body: ${show(writes()[0]?.body)}`);
      const afterReminder = rangeCalls().map((c) => c.query.get('sources'));
      assert(afterReminder.length > 0 && afterReminder.every((s2) => s2 === 'famcal'), `a reminder lives in FamCal: ${show(afterReminder)}`);
    } finally {
      m.unmount();
    }
    // The default follows the server's main: a user whose default is the FamCal main sees it selected.
    const famcalMain = await bothHome('en', { editor: ok200(unionEditor('famcal')) });
    try {
      tapPlus(famcalMain.m);
      await settle();
      assert(shownIn(famcalMain.m, 'Calendar') === 'Family', `the FamCal main: ${shownIn(famcalMain.m, 'Calendar')}`);
    } finally {
      famcalMain.m.unmount();
    }
    // A user with a token but no usable reminders (the plan\'s hints): events only, still a "+".
    const noReminders = await bothHome('en', {}, { hints: { reminders: false, voiceEvents: true } });
    try {
      tapPlus(noReminders.m);
      await settle();
      assert(!elements(topDialog(noReminders.m)).some((e) => e.getAttribute('aria-label') === 'Type'), 'no switch without reminders');
      assertHas(topText(noReminders.m), ['All day', 'Avi'], 'an event form on the default');
    } finally {
      noReminders.m.unmount();
    }
    // A cleared token (state reconnect, FamCal alone): the "+" is there and FamCal is all it offers.
    const cleared = await editingHome('en', { editor: ok200(EDITOR_INFO) }, { googleState: 'reconnect' });
    try {
      assert(hasPlus(cleared.m), 'the "+" without a token');
      assert(cleared.m.html().includes('role="tablist"'), 'the tab bar without a token');
    } finally {
      cleared.m.unmount();
    }
  });

  await check('#110 the item sheet\'s edit info is asked for FamCal and Google items alike on every home (a user with both can change both); no read of the old calendarSource anywhere in the client', async () => {
    const { m } = await bothHome('en', {
      item: (key) => ok200(infoFor({ source: key.startsWith('google|') ? 'google' : 'famcal', occurrence: { start: `${day(0)}T19:30`, end: `${day(0)}T22:00`, allDay: false, title: 'Dinner with the Cohens', location: '', description: '' } })),
    });
    try {
      await openItem(m, 'Dinner with the Cohens');
      assert(itemCalls().some((c) => c.query.get('key')?.startsWith('google|')), `the Google item's info is asked: ${show(itemCalls().map((c) => c.query.get('key')))}`);
      assert(sheetButtons(m).includes('Edit'), `the pencil on a Google item: ${show(sheetButtons(m))}`);
      m.click(dialogButton(m, 'Close'));
      await settle();
      await openItem(m, 'Grandma visits');
      assert(itemCalls().some((c) => c.query.get('key')?.startsWith('famcal|')), `the FamCal item's info is asked too: ${show(itemCalls().map((c) => c.query.get('key')))}`);
      assert(sheetButtons(m).includes('Edit'), `the pencil on a FamCal item: ${show(sheetButtons(m))}`);
    } finally {
      m.unmount();
    }
    // The client's own code reads no calendarSource (the legacy column stays on the server, unread).
    for (const rel of ['app/[locale]/PageGate.tsx', 'app/[locale]/dashboard/CalendarHome.tsx', 'app/[locale]/dashboard/HomeBanners.tsx', 'app/[locale]/dashboard/MenuSheet.tsx', 'src/lib/calendar-view/home-client.ts', 'src/lib/calendar-view/home-props.ts', 'src/lib/page-data.ts']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert(!/\bcalendarSource\b|\bneedsOAuth\b|\bneedsCalendars\b/.test(src), `${rel} still reads the legacy source`);
    }
  });

  await check('#111 the Google states in en, he and ru: Choose calendars and Reconnect banners and the menu\'s Connect entry read real text, none of them for the wrong state', async () => {
    const wants: [Locale, string, string][] = [
      ['en', 'Connect Google Calendar', 'Reconnect Google'],
      ['he', 'חיבור ליומן Google', 'חיבור מחדש ל-Google'],
      ['ru', 'Подключить Google Календарь', 'Переподключить Google'],
    ];
    for (const [locale, connect, reconnect] of wants) {
      resetHome();
      answerFetch = () => ok200(answer({ items: WEEK }));
      const never = await mountHome(locale);
      try {
        never.click(byLabel(never.container, messages[locale].calendarHome.header.menu));
        const text = dialogText(never.container);
        assertHas(text, [connect], `${locale}: the Connect entry`);
        assertLacks(text, [reconnect], `${locale}: no Reconnect for a user who never connected`);
        never.click(byData(never.container, 'menu', 'connectGoogle'));
        assert(show(pushes) === show(['/refresh-token?user_id=5550001']), `${locale}: Connect opens the token page: ${show(pushes)}`);
      } finally {
        never.unmount();
      }
      resetHome();
      answerFetch = () => ok200(answer({ items: WEEK }));
      const cleared = await mountHome(locale, { googleState: 'reconnect' });
      try {
        assertHas(cleared.text(), [messages[locale].calendarHome.banner.reconnect], `${locale}: the Reconnect banner`);
        cleared.click(byLabel(cleared.container, messages[locale].calendarHome.header.menu));
        const text = dialogText(cleared.container);
        assertHas(text, [reconnect], `${locale}: the menu's Reconnect`);
        assertLacks(text, [connect], `${locale}: no Connect for a user with calendars stored`);
      } finally {
        cleared.unmount();
      }
    }
  });

  await check('#111a select-calendars: ticking primary on a Google calendar while a FamCal calendar holds the default says "New events will go to <name>" (once, in en, he and ru); with no FamCal primary, or on a calendar that already had it, the old "set as primary" line stays', async () => {
    const calendars = [
      { id: 'avi@gmail.com', name: 'Avi', backgroundColor: '#039BE5', primary: true },
      { id: GOOGLE_FAMILY_ID, name: 'Google Family', backgroundColor: '#7986CB' },
    ];
    const selections = (primary: boolean) => ({
      selectedCalendars: new Set(['avi@gmail.com', GOOGLE_FAMILY_ID]),
      calendarLabels: new Map([
        ['avi@gmail.com', new Set(primary ? ['primary', 'yours'] : ['yours'])],
        [GOOGLE_FAMILY_ID, new Set(['yours'])],
      ]) as unknown as ComponentProps<typeof SelectCalendarsClient>['currentSelections']['calendarLabels'],
      spouseInfo: null,
      calendarRules: new Map<string, string>(),
      globalRules: [],
    });
    // The page's <style jsx> is rewritten by Next's compiler; under tsx React sees the bare attribute and warns. Those two warnings are not the page's.
    const warnedBefore = reactWarnings.length;
    const dropStyledJsx = () => {
      const mine = reactWarnings.splice(warnedBefore);
      reactWarnings.push(...mine.filter((w) => !(w.includes('non-boolean attribute') && /(?:jsx|global)$/.test(w))));
    };
    const wants: [Locale, string][] = [
      ['en', 'New events will go to Google Family'],
      ['he', 'אירועים חדשים יתווספו ליומן Google Family'],
      ['ru', 'Новые события будут добавляться в календарь «Google Family»'],
    ];
    const mountPage = async (locale: Locale, famcalPrimaryName: string | null, primary = false) => {
      resetHome();
      answerFetch = () => ok200({ success: true });
      const m = mount(inApp(locale, createElement(SelectCalendarsClient, { userId: 5550001, userName: 'Dana', availableCalendars: calendars, currentSelections: selections(primary), locale, calendarLimit: -1, famcalPrimaryName })));
      await settle();
      return m;
    };
    const tapPrimary = async (m: Awaited<ReturnType<typeof mountPage>>, calendarName: string) => {
      const row = elements(m.container).filter((e) => e.className.includes('calendar-item') && e.textContent.includes(calendarName))[0];
      assert(row, `no row for ${calendarName}`);
      const icon = elements(row).filter((e) => e.getAttribute('aria-label')?.toLowerCase().includes('primary') || e.getAttribute('title')?.toLowerCase().includes('primary'))[0];
      assert(icon, `no primary icon in ${calendarName}'s row: ${htmlOf(row).slice(0, 400)}`);
      m.click(icon);
      await settle();
    };
    const textNow = (m: Awaited<ReturnType<typeof mountPage>>) => textOf(innerHtml(m.container));
    for (const [locale, line] of wants) {
      const m = await mountPage(locale, 'Family');
      try {
        await tapPrimary(m, 'Google Family');
        assertHas(textNow(m), [line], `${locale}: the note`);
        assert(!(textNow(m).match(new RegExp(line.replace(/[.*+?^${}()|[\]\\«»]/g, '\\$&'), 'g')) ?? []).slice(1).length, `${locale}: once`);
        assert(fetchCalls.some((c) => c.path === '/api/select-calendars' && c.method === 'POST'), `${locale}: the save went out`);
      } finally {
        m.unmount();
      }
    }
    const none = await mountPage('en', null);
    try {
      await tapPrimary(none, 'Google Family');
      assertHas(textNow(none), ['Google Family set as primary'], 'no FamCal primary: the old line');
      assertLacks(textNow(none), ['New events will go to'], 'no note');
    } finally {
      none.unmount();
    }
    const same = await mountPage('en', 'Family', true);
    try {
      await tapPrimary(same, 'Avi');
      assertHas(textNow(same), ['Avi set as primary'], 'already primary: the old line');
      assertLacks(textNow(same), ['New events will go to'], 'no note');
    } finally {
      same.unmount();
    }
    dropStyledJsx();
  });

  await check('#112 React logged no warning in #108-#111 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeConnection, `React warned: ${show(reactWarnings.slice(warnedBeforeConnection, warnedBeforeConnection + 3))}`);
  });

  // ---- The cross-source move (G4, spec §5): the Calendar row across kinds ----

  const warnedBeforeMove = reactWarnings.length;
  const MOVE_ALONE = 'Save the move on its own first.';
  const ALERTS_FOLLOW = 'Alerts and colour follow the new calendar.';
  const PARTNER_SEES = 'Your partner will see this';
  const CROSS_NOTE = 'Moving to another kind of calendar moves the whole series.';
  const BOTH_TARGETS = ['native:cal_me_7f3a', 'native:cal_noa_91b2', GOOGLE_FAMILY_ID, 'avi@gmail.com'];
  /** The Dinner series on Google (weekly), as its edit info says. */
  const dinnerSeries = (o: Partial<ItemEditInfoResponse> = {}) =>
    infoFor({
      source: 'google',
      calendar: { id: GOOGLE_FAMILY_ID, name: 'Google Family', color: '#7986CB' },
      occurrence: { start: `${day(0)}T19:30`, end: `${day(0)}T22:00`, allDay: false, title: 'Dinner with the Cohens', location: '', description: '' },
      series: { recurring: true, start: `${day(0)}T19:30`, repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'UTC', rule: { choice: 'weekly' }, first: true },
      scopes: ['single', 'following', 'all'],
      canMoveCalendar: true,
      moveTargets: [GOOGLE_FAMILY_ID, 'avi@gmail.com', 'native:cal_me_7f3a', 'native:cal_noa_91b2'],
      sharedTargets: ['native:cal_noa_91b2'],
      ...o,
    });
  const serveDinner = (info: ItemEditInfoResponse) => (key: string) => (key === 'google|dinner' ? ok200(info) : ({ status: 404, body: {} } as FetchAnswer));
  const hintOf = (m: Home, label: string) => byClass(valueRow(m, label), 'ch-form-hint').map((e) => e.textContent).join(' | ');

  await check('#113 the Calendar row on edit lists both kinds; picking the other kind says "Alerts and colour follow the new calendar." and a one-off moves with no question, the calendar alone in the body; with any other change Save says "Save the move on its own first." and sends nothing', async () => {
    const info = infoFor({ canMoveCalendar: true, moveTargets: BOTH_TARGETS });
    const a = await bothHome('en', { item: serveDentist(info), write: () => ok200({ status: 'ok', key: `google|${GOOGLE_FAMILY_ID}|copy1` }) });
    try {
      await openEditor(a.m, 'Dentist');
      assert(show(optionsIn(a.m, 'Calendar').map((o) => o[0])) === show(BOTH_TARGETS), `both kinds: ${show(optionsIn(a.m, 'Calendar'))}`);
      assert(hintOf(a.m, 'Calendar') === '', `no line before a pick: ${show(hintOf(a.m, 'Calendar'))}`);
      await pick(a.m, 'Calendar', 'native:cal_noa_91b2');
      assert(hintOf(a.m, 'Calendar') === '', 'the same kind: no line');
      await pick(a.m, 'Calendar', GOOGLE_FAMILY_ID);
      assert(hintOf(a.m, 'Calendar') === ALERTS_FOLLOW, `the other kind: ${show(hintOf(a.m, 'Calendar'))}`);
      await typeInto(inDialog(a.m, 'Location'), 'Somewhere else');
      a.m.click(saveButton(a.m));
      await settle();
      assert(writes().length === 0 && topText(a.m).includes(MOVE_ALONE), `saved alone: ${show(topText(a.m).slice(-200))}`);
      await typeInto(inDialog(a.m, 'Location'), 'Clinic on Herzl St');
      assert(!topText(a.m).includes(MOVE_ALONE), 'a change clears the note');
      a.m.click(saveButton(a.m));
      await settle();
      assert(sameBody(writes()[0]?.body, { user_id: 5550003, initData: INIT, key: 'famcal|dentist', scope: 'single', changes: { calendarId: GOOGLE_FAMILY_ID } }), `the move alone: ${show(writes()[0]?.body)}`);
    } finally {
      a.m.unmount();
    }
  });

  await check('#114 a series to the other kind: the scope sheet offers only "All of them", with "Moving to another kind of calendar moves the whole series."; into a FamCal calendar the partner sees, the row also says "Your partner will see this"', async () => {
    const a = await bothHome('en', { item: serveDinner(dinnerSeries()), write: () => ok200({ status: 'ok', key: 'famcal|copied#2026-10-15T16:30:00.000Z' }) });
    try {
      await openEditor(a.m, 'Dinner with the Cohens');
      await pick(a.m, 'Calendar', 'native:cal_me_7f3a');
      assert(hintOf(a.m, 'Calendar') === ALERTS_FOLLOW, `a private FamCal calendar: ${show(hintOf(a.m, 'Calendar'))}`);
      await pick(a.m, 'Calendar', 'native:cal_noa_91b2');
      assert(hintOf(a.m, 'Calendar') === `${PARTNER_SEES} · ${ALERTS_FOLLOW}`, `a shared one: ${show(hintOf(a.m, 'Calendar'))}`);
      a.m.click(saveButton(a.m));
      await settle();
      assert(topDialog(a.m).getAttribute('aria-label') === 'This event repeats', 'the scope sheet');
      assert(show(choiceTexts(a.m)) === show(['All of them', 'Cancel']), `choices: ${show(choiceTexts(a.m))}`);
      assertHas(topText(a.m), [CROSS_NOTE], 'the line');
      assertLacks(topText(a.m), [PICK_NOTE], 'not the calendar-change line');
      tapIn(a.m, 'All of them');
      await settle();
      assert(sameBody(writes()[0]?.body, { user_id: 5550003, initData: INIT, key: 'google|dinner', scope: 'all', changes: { calendarId: 'native:cal_noa_91b2' } }), `all: ${show(writes()[0]?.body)}`);
    } finally {
      a.m.unmount();
    }
  });

  await check('#115 why an item can\'t cross: the reason under the Calendar row (or as a line when there is no row); a refusal the server gives (moveMeet, moveHebrew, moveRepeat) shows its reason above Save, not "Couldn\'t save"', async () => {
    const hebrew = infoFor({ canMoveCalendar: true, moveTargets: ['native:cal_me_7f3a', 'native:cal_noa_91b2'], moveReason: 'hebrew' });
    const a = await bothHome('en', { item: serveDentist(hebrew) });
    try {
      await openEditor(a.m, 'Dentist');
      assert(hintOf(a.m, 'Calendar') === 'Google Calendar can’t repeat by the Hebrew date', `the hint: ${show(hintOf(a.m, 'Calendar'))}`);
    } finally {
      a.m.unmount();
    }
    const meet = dinnerSeries({ canMoveCalendar: false, moveTargets: [GOOGLE_FAMILY_ID], sharedTargets: undefined, moveReason: 'meet' });
    const b = await bothHome('en', { item: serveDinner(meet) });
    try {
      await openEditor(b.m, 'Dinner with the Cohens');
      assert(!hasRow(b.m, 'Calendar'), 'no row');
      assert(byClass(topDialog(b.m), 'ch-form-fixed').some((p) => p.textContent === 'This one has a video call or files, so it stays in Google Calendar'), `the line: ${show(topText(b.m).slice(-300))}`);
    } finally {
      b.m.unmount();
    }
    for (const [field, text] of [['moveRepeat', 'This repeat can’t be moved'], ['moveMeet', 'This one has a video call or files, so it stays in Google Calendar'], ['moveHebrew', 'Google Calendar can’t repeat by the Hebrew date']]) {
      const c = await bothHome('en', { item: serveDentist(infoFor({ canMoveCalendar: true, moveTargets: BOTH_TARGETS })), write: () => ({ status: 400, body: { error: 'invalid', field } }) });
      try {
        await openEditor(c.m, 'Dentist');
        await pick(c.m, 'Calendar', 'avi@gmail.com');
        c.m.click(saveButton(c.m));
        await settle();
        assert(topText(c.m).includes(text) && !topText(c.m).includes('Couldn’t save'), `${field}: ${show(topText(c.m).slice(-200))}`);
      } finally {
        c.m.unmount();
      }
    }
  });

  await check('#116 after a move the old item leaves its source at once (dropItem), both sources are asked again, and the sheet follows the item to its new key in the other source; "Couldn\'t move" and "still in" are told', async () => {
    const info = infoFor({ canMoveCalendar: true, moveTargets: BOTH_TARGETS });
    const copyKey = 'google|avi@gmail.com|copy1';
    const copy = item('copy1', { ...DENTIST, key: copyKey, id: 'copy1', source: 'google', tz: null, calendar: G_FAMILY });
    const serve = (k: string) => (k === 'famcal|dentist' ? ok200(info) : k === copyKey ? ok200(infoFor({ source: 'google', calendar: { id: 'avi@gmail.com', name: 'Avi', color: '#039BE5' } })) : ({ status: 404, body: {} } as FetchAnswer));
    const a = await bothHome('en', { item: serve, write: () => ok200({ status: 'ok', key: copyKey }) });
    try {
      await openEditor(a.m, 'Dentist');
      await pick(a.m, 'Calendar', 'avi@gmail.com');
      // FamCal's refetch fails: only dropItem can take the old row away.
      answerFetch = (c) => (c.query.get('sources') === 'google'
        ? answerSource(c, { google: { items: { ...a.world.google, [day(0)]: [DINNER, copy] } } })
        : { status: 500, body: { error: 'internal_error' } });
      fetchCalls.length = 0;
      a.m.click(saveButton(a.m));
      await settle();
      assert(ranges().some((r) => r.startsWith('famcal ')) && ranges().some((r) => r.startsWith('google ')), `both asked again: ${show(ranges())}`);
      const rows = elements(a.m.container).filter((e) => e.localName === 'button' && e.className.includes('ch-row') && e.textContent.includes('Dentist'));
      assert(rows.length === 1, `one Dentist row, the copy: ${rows.length}`);
      assert(topDialog(a.m).getAttribute('aria-label') === 'Details' && editingKeys.includes(copyKey), `the sheet followed: ${show(editingKeys)}`);
    } finally {
      a.m.unmount();
    }
    const b = await bothHome('en', { item: serveDentist(info), write: () => ok200({ status: 'ok', key: copyKey, leftIn: 'Family' }) });
    try {
      b.world.google = { ...b.world.google, [day(0)]: [DINNER, copy] };
      await openEditor(b.m, 'Dentist');
      await pick(b.m, 'Calendar', 'avi@gmail.com');
      b.m.click(saveButton(b.m));
      await settle();
      assert(topDialog(b.m).getAttribute('aria-label') === 'Details' && topText(b.m).includes('Moved, but the old one is still in Family'), `still in: ${show(topText(b.m).slice(0, 300))}`);
    } finally {
      b.m.unmount();
    }
    for (const [what, answer, text] of [['500 move_failed', { status: 500, body: { error: 'move_failed' } }, 'Couldn’t move. Try again.'], ['429 busy', { status: 429, body: { error: 'busy' } }, 'Too many changes at once. Try again in a minute.']] as [string, FetchAnswer, string][]) {
      const c = await bothHome('en', { item: serveDentist(info), write: () => answer });
      try {
        await openEditor(c.m, 'Dentist');
        await pick(c.m, 'Calendar', 'avi@gmail.com');
        c.m.click(saveButton(c.m));
        await settle();
        assert(topText(c.m).includes(text), `${what}: ${show(topText(c.m).slice(-200))}`);
      } finally {
        c.m.unmount();
      }
    }
  });

  await check('#117 the move copy in en, he and ru: real text, no key left bare, and Hebrew and Russian translated, not copied', () => {
    const keys = ['editor.moveAlone', 'editor.move.alertsFollow', 'editor.move.partnerSees', 'editor.move.reasons.meet', 'editor.move.reasons.hebrew', 'editor.move.reasons.repeat', 'editor.submitErrors.moveFailed', 'sheet.actionNotes.movedLeft', 'scope.crossKindNote'];
    const at = (locale: Locale, k: string) => k.split('.').reduce<unknown>((o, p) => (o as Row | undefined)?.[p], messages[locale].calendarHome);
    for (const k of keys) {
      const en = at('en', k);
      assert(typeof en === 'string' && en.length > 0, `en ${k}`);
      for (const locale of ['he', 'ru'] as Locale[]) {
        const v = at(locale, k);
        assert(typeof v === 'string' && v.length > 0 && v !== en, `${locale} ${k}: ${show(v)}`);
      }
    }
    assert(/\{calendar\}/.test(String(at('he', 'sheet.actionNotes.movedLeft'))) && /\{calendar\}/.test(String(at('ru', 'sheet.actionNotes.movedLeft'))), 'the calendar placeholder kept');
  });

  await check('#118 React logged no warning in #113-#117 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeMove, `React warned: ${show(reactWarnings.slice(warnedBeforeMove, warnedBeforeMove + 3))}`);
  });

  // ---- The calendars page's Copy to Google rows (google-sync S4), in real React ----

  const warnedBeforeCopies = reactWarnings.length;
  const cal = (rawId: string, name: string, isOwner: boolean) => ({
    rawId, name, color: '#039BE5', labels: [], privacy: 'SHARED_EDITOR' as const, ownerUserId: isOwner ? 5 : 6, isOwner,
    personName: null, personEnglishName: null, personGender: null, rules: [], createdAt: '2026-01-01T00:00:00.000Z',
  });
  const CALS = [cal('own', 'Home', true), cal('plain', 'Work', true), cal('noa-cal', 'Noa family', false)];
  const copyRow = (calendarId: string, o: Row = {}) => ({ calendarId, linkId: `link-${calendarId}`, on: true, status: 'copied', copied: 0, total: 0, unsupported: 0, consentOpen: false, ...o });
  const VIEW = { shown: true, ownerName: 'Noa', rows: [copyRow('own'), copyRow('plain', { on: false, status: 'off', linkId: null })] };
  const gcm = (locale: Locale) => (messages[locale] as Row).googleCopy as Row & { status: Row; actions: Row; unlink: Row; errors: Row; notes: Row; busy: Row };
  const cardOf = (m: Mounted, name: string) => {
    const card = elements(m.container).filter((e) => e.className === 'bg-white rounded-2xl shadow p-4' && e.textContent.includes(name))[0];
    assert(card, `no card for ${name}`);
    return card;
  };
  const switchIn = (node: FakeNode) => byRole(node, 'switch')[0];
  const buttonIn = (node: FakeNode, text: string) => {
    const b = elements(node).filter((e) => e.localName === 'button' && textOf(htmlOf(e)) === text)[0];
    assert(b, `no button ${show(text)} in ${textOf(htmlOf(node)).slice(0, 300)}`);
    return b;
  };
  const copyCalls = () => fetchCalls.filter((c) => c.path === '/api/google-sync');
  let serveCopies: (c: FetchCall) => FetchAnswer | Promise<FetchAnswer> = () => ok200(VIEW);
  const mountCalendars = async (locale: Locale = 'en') => {
    resetHome();
    const tg = fakeTelegram();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const assigned: string[] = [];
    fakeWindow.location = { hash: '', reload: noop, assign: (u: string) => assigned.push(u) };
    (globalThis as Row).confirm = () => true;
    answerFetch = (c) => (c.path === '/api/google-sync' ? serveCopies(c) : c.path === '/api/native-calendars' ? ok200({ calendars: CALS }) : ok200({ success: true }));
    const m = mount(inApp(locale, createElement(CalendarsClient, { userId: 5, locale, initialCalendars: CALS, googleColors: [] })));
    await settle();
    return { m, tg, assigned };
  };

  await check('#119 calendars page: after its GET each own card has the Copy to Google row (on and copied; off), the partner\'s card says only its owner can copy it, and the notes show once; en, he (RTL) and ru; the GET carries initData in the header only', async () => {
    serveCopies = () => ok200(VIEW);
    for (const locale of ['en', 'he', 'ru'] as Locale[]) {
      const { m } = await mountCalendars(locale);
      try {
        const g = gcm(locale);
        const get = copyCalls()[0];
        assert(get && get.method === 'GET' && get.url === '/api/google-sync?user_id=5' && Object.keys(get.headers).some((h) => /init-data/i.test(h)), `${locale}: GET ${show(get)}`);
        const home = cardOf(m, 'Home');
        assert(switchIn(home).getAttribute('aria-checked') === 'true', `${locale}: Home's switch`);
        assertHas(textOf(htmlOf(home)), [String(g.title), String(g.status.copied)], `${locale}: Home`);
        assert(switchIn(cardOf(m, 'Work')).getAttribute('aria-checked') === 'false', `${locale}: Work's switch`);
        const noa = cardOf(m, 'Noa family');
        assert(!switchIn(noa), `${locale}: a switch on the partner's calendar`);
        assertHas(textOf(htmlOf(noa)), [String(g.nonOwner).replace('{owner}', 'Noa')], `${locale}: the non-owner line`);
        const text = textOf(innerHtml(m.container));
        assert(text.split(String(g.notes.alerts)).length === 2, `${locale}: the notes, once: ${text.slice(0, 400)}`);
        if (locale === 'he') assert(elements(m.container).some((e) => e.getAttribute('dir') === 'rtl'), 'he: no dir="rtl"');
      } finally {
        m.unmount();
      }
    }
  });

  await check('#120 calendars page: no copy rows, non-owner line or notes when the copies don\'t apply (no Google, no copy on); a failed GET shows the load error and the cards as before', async () => {
    serveCopies = () => ok200({ shown: false, ownerName: 'Noa', rows: [] });
    let { m } = await mountCalendars('en');
    try {
      assert(byRole(m.container, 'switch').length === 0, 'a switch');
      assertLacks(textOf(innerHtml(m.container)), ['Copy to Google', 'Only Noa can copy', String(gcm('en').notes.alerts)], 'not shown');
      assertHas(textOf(innerHtml(m.container)), ['Home', 'Work', 'Noa family'], 'the cards');
    } finally {
      m.unmount();
    }
    serveCopies = () => ({ status: 500, body: { error: 'failed' } });
    ({ m } = await mountCalendars('en'));
    try {
      assertHas(textOf(innerHtml(m.container)), [String(gcm('en').errors.load), 'Home'], 'the load error');
      assert(byRole(m.container, 'switch').length === 0, 'a switch after a failed GET');
    } finally {
      m.unmount();
    }
  });

  await check('#121 calendars page: turning a copy on without the permission shows the busy line, then "Approve in Google, then tap the link FamCal sends you." with Open Google, which goes through Telegram\'s openLink; with the permission it turns on and asks the rows again', async () => {
    let release: (a: FetchAnswer) => void = noop;
    serveCopies = (c) => (c.method === 'POST' ? new Promise<FetchAnswer>((r) => { release = r; }) : ok200(VIEW));
    const { m, tg } = await mountCalendars('en');
    try {
      m.click(switchIn(cardOf(m, 'Work')));
      await settle();
      const post = copyCalls().find((c) => c.method === 'POST');
      assert(post && show(post.body) === show({ action: 'enable', nativeCalendarId: 'plain' }), `POST ${show(post)}`);
      const work = () => cardOf(m, 'Work');
      assert(switchIn(work()).getAttribute('aria-busy') === 'true' && switchIn(work()).hasAttribute('disabled'), 'not busy');
      assertHas(textOf(htmlOf(work())), ['Turning on…'], 'the busy line');
      release(ok200({ status: 'consent', oauthUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=u1_x', serverTime: 1 }));
      await settle();
      assertHas(textOf(htmlOf(work())), ['Approve in Google, then tap the link FamCal sends you.'], 'the wait line');
      m.click(buttonIn(work(), 'Open Google'));
      assert(tg.calls.includes('openLink(https://accounts.google.com/o/oauth2/v2/auth?state=u1_x)'), `calls ${show(tg.calls)}`);
    } finally {
      m.unmount();
    }
    serveCopies = (c) => (c.method === 'POST' ? ok200({ status: 'created' }) : ok200(VIEW));
    const again = await mountCalendars('en');
    try {
      const gets = () => copyCalls().filter((c) => c.method === 'GET').length;
      const before = gets();
      again.m.click(switchIn(cardOf(again.m, 'Work')));
      await settle();
      assert(gets() === before + 1, `the rows were not asked again: ${show(copyCalls().map((c) => c.method))}`);
      assertLacks(textOf(htmlOf(cardOf(again.m, 'Work'))), ['Approve in Google'], 'a wait line after on');
    } finally {
      again.m.unmount();
    }
  });

  await check('#122 calendars page: turning a copy off asks Remove or Keep (spec §1\'s question); Keep sends DELETE with googleCopy keep; Cancel sends nothing; an error answer shows under the row', async () => {
    serveCopies = (c) => (c.method === 'DELETE' ? ok200({ status: 'off' }) : ok200(VIEW));
    const { m } = await mountCalendars('en');
    try {
      m.click(switchIn(cardOf(m, 'Home')));
      await settle();
      assertHas(textOf(htmlOf(cardOf(m, 'Home'))), ['from Google too, including anything you added to it?', 'FamCal · '], 'the question');
      m.click(buttonIn(cardOf(m, 'Home'), 'Cancel'));
      await settle();
      assert(!copyCalls().some((c) => c.method === 'DELETE'), 'Cancel sent a DELETE');
      m.click(switchIn(cardOf(m, 'Home')));
      await settle();
      m.click(buttonIn(cardOf(m, 'Home'), 'Keep'));
      await settle();
      const del = copyCalls().find((c) => c.method === 'DELETE');
      assert(del && show(del.body) === show({ nativeCalendarId: 'own', googleCopy: 'keep' }), `DELETE ${show(del)}`);
    } finally {
      m.unmount();
    }
    serveCopies = (c) => (c.method === 'DELETE' ? { status: 500, body: { error: 'failed' } } : ok200(VIEW));
    const failed = await mountCalendars('en');
    try {
      failed.m.click(switchIn(cardOf(failed.m, 'Home')));
      await settle();
      failed.m.click(buttonIn(cardOf(failed.m, 'Home'), 'Remove'));
      await settle();
      assert(byRole(cardOf(failed.m, 'Home'), 'alert').some((e) => textOf(htmlOf(e)) === String(gcm('en').errors.failed)), 'no error under the row');
    } finally {
      failed.m.unmount();
    }
  });

  await check('#123 calendars page: deleting a calendar whose copy is on asks Remove or Keep after the confirm and sends the choice in the calendar DELETE; a calendar with no copy on is deleted as before, with no googleCopy', async () => {
    serveCopies = () => ok200(VIEW);
    const { m } = await mountCalendars('en');
    try {
      m.click(byLabel(cardOf(m, 'Home'), 'Delete'));
      await settle();
      assert(!fetchCalls.some((c) => c.path === '/api/native-calendars/own'), 'deleted before the question');
      m.click(buttonIn(cardOf(m, 'Home'), 'Remove'));
      await settle();
      const del = fetchCalls.find((c) => c.path === '/api/native-calendars/own' && c.method === 'DELETE');
      assert(del && del.body?.googleCopy === 'remove', `DELETE ${show(del)}`);
      m.click(byLabel(cardOf(m, 'Work'), 'Delete'));
      await settle();
      const plain = fetchCalls.find((c) => c.path === '/api/native-calendars/plain' && c.method === 'DELETE');
      assert(plain && !('googleCopy' in (plain.body ?? {})), `plain DELETE ${show(plain)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#124 calendars page: each state\'s action: Approve in Google starts the consent, Reconnect Google opens /refresh-token, Create it again and Copy again send recreate with the link; progress and "can\'t be copied" show', async () => {
    serveCopies = (c) => (c.method === 'POST' ? ok200(c.body?.action === 'recreate' ? { status: 'recreated' } : { status: 'consent', oauthUrl: 'https://accounts.google.com/x' }) : ok200({
      shown: true, ownerName: null, rows: [copyRow('own', { status: 'reconnect' }), copyRow('plain', { status: 'gone' })],
    }));
    const { m, assigned } = await mountCalendars('en');
    try {
      m.click(buttonIn(cardOf(m, 'Home'), 'Reconnect Google'));
      assert(show(assigned) === show(['/refresh-token?user_id=5']), `assigned ${show(assigned)}`);
      m.click(buttonIn(cardOf(m, 'Work'), 'Create it again'));
      await settle();
      assert(copyCalls().some((c) => c.method === 'POST' && show(c.body) === show({ action: 'recreate', linkId: 'link-plain' })), `recreate ${show(copyCalls())}`);
    } finally {
      m.unmount();
    }
    serveCopies = (c) => (c.method === 'POST' ? ok200({ status: 'consent', oauthUrl: 'https://accounts.google.com/x' }) : ok200({
      shown: true, ownerName: null, rows: [copyRow('own', { status: 'approve' }), copyRow('plain', { status: 'copying', copied: 340, total: 1200, unsupported: 2 })],
    }));
    const b = await mountCalendars('en');
    try {
      assertHas(textOf(htmlOf(cardOf(b.m, 'Work'))), ['Copying… 340 of 1,200', '2 events can\'t be copied'], 'progress');
      b.m.click(buttonIn(cardOf(b.m, 'Home'), 'Approve in Google'));
      await settle();
      assert(copyCalls().some((c) => c.method === 'POST' && show(c.body) === show({ action: 'enable', nativeCalendarId: 'own' })), 'no consent request');
      assertHas(textOf(htmlOf(cardOf(b.m, 'Home'))), ['Open Google'], 'the wait');
    } finally {
      b.m.unmount();
    }
  });

  await check('#124b calendars page: a turn-off that lands while a GET is in flight asks the rows once more after it, so the row never stays on the stale answer', async () => {
    let hold: ((a: FetchAnswer) => void) | null = null;
    let gets = 0;
    const offView = { ...VIEW, rows: [copyRow('own', { on: false, status: 'off' }), VIEW.rows[1]] };
    let turnedOff = false;
    serveCopies = (c) => {
      if (c.method === 'DELETE') { turnedOff = true; return ok200({ status: 'off' }); }
      gets += 1;
      if (gets === 2) return new Promise<FetchAnswer>((r) => { hold = r; });
      return ok200(turnedOff ? offView : VIEW);
    };
    const { m } = await mountCalendars('en');
    try {
      fireDocument('visibilitychange');
      await settle();
      assert(hold, 'the second GET is not in flight');
      m.click(switchIn(cardOf(m, 'Home')));
      await settle();
      m.click(buttonIn(cardOf(m, 'Home'), 'Keep'));
      await settle();
      (hold as unknown as (a: FetchAnswer) => void)(ok200(VIEW));
      await settle();
      assert(gets === 3, `GETs ${gets}`);
      assert(switchIn(cardOf(m, 'Home')).getAttribute('aria-checked') === 'false', 'the row stayed on');
    } finally {
      m.unmount();
    }
  });

  await check('#124c calendars page: deleting a calendar before the copy rows loaded, or after their GET failed, asks the rows first and then Remove or Keep; if they still can\'t load, nothing is deleted and an error shows', async () => {
    // The first GET fails; the delete asks again, the copy is on, so the question comes first.
    let gets = 0;
    serveCopies = (c) => (c.method === 'GET' && ++gets === 1 ? { status: 500, body: { error: 'failed' } } : ok200(VIEW));
    const a = await mountCalendars('en');
    try {
      assert(byRole(a.m.container, 'switch').length === 0, 'rows after a failed GET');
      a.m.click(byLabel(cardOf(a.m, 'Home'), 'Delete'));
      await settle();
      assert(gets === 2, `GETs ${gets}`);
      assert(!fetchCalls.some((c) => c.path === '/api/native-calendars/own' && c.method === 'DELETE'), 'deleted before the question');
      a.m.click(buttonIn(cardOf(a.m, 'Home'), 'Keep'));
      await settle();
      const del = fetchCalls.find((c) => c.path === '/api/native-calendars/own' && c.method === 'DELETE');
      assert(del && del.body?.googleCopy === 'keep', `DELETE ${show(del)}`);
    } finally {
      a.m.unmount();
    }
    // The first GET still in flight: the delete doesn't take its absence for "no copy".
    let hold: ((x: FetchAnswer) => void) | null = null;
    gets = 0;
    serveCopies = (c) => (c.method === 'GET' && ++gets === 1 ? new Promise<FetchAnswer>((r) => { hold = r; }) : ok200(VIEW));
    const b = await mountCalendars('en');
    try {
      b.m.click(byLabel(cardOf(b.m, 'Home'), 'Delete'));
      await settle();
      assert(!fetchCalls.some((c) => c.path === '/api/native-calendars/own' && c.method === 'DELETE'), 'deleted while the rows were loading');
      assertHas(textOf(htmlOf(cardOf(b.m, 'Home'))), ['from Google too, including anything you added to it?'], 'the question');
      (hold as unknown as (x: FetchAnswer) => void)(ok200(VIEW));
      await settle();
    } finally {
      b.m.unmount();
    }
    // The rows can't load at all: no delete, an error.
    serveCopies = () => ({ status: 500, body: { error: 'failed' } });
    const c = await mountCalendars('en');
    try {
      c.m.click(byLabel(cardOf(c.m, 'Home'), 'Delete'));
      await settle();
      assert(!fetchCalls.some((x) => x.path === '/api/native-calendars/own' && x.method === 'DELETE'), 'deleted with no rows');
      assertHas(textOf(innerHtml(c.m.container)), [String(gcm('en').errors.load)], 'the load error');
    } finally {
      c.m.unmount();
    }
  });

  await check('#124d calendars page: the consent wait ends once its consent can\'t be used: a refresh that shows the row on in "Approve in Google" (a commit without the permission), or a stopped copy\'s consent the server no longer holds, brings back Approve in Google, never Open Google on the used URL; a wait begun while a GET was in flight survives that GET', async () => {
    const usedUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=u1_used';
    let rows: Row[] = VIEW.rows;
    serveCopies = (c) => (c.method === 'POST' ? ok200({ status: 'consent', oauthUrl: usedUrl }) : ok200({ shown: true, ownerName: null, rows }));
    const a = await mountCalendars('en');
    try {
      const work = () => cardOf(a.m, 'Work');
      a.m.click(switchIn(work()));
      await settle();
      assertHas(textOf(htmlOf(work())), ['Open Google'], 'the wait');
      // Unticked in Google, then the bot's link: the commit turned the copy on in 'scopes'.
      rows = [VIEW.rows[0], copyRow('plain', { status: 'approve', consentOpen: false })];
      fireDocument('visibilitychange');
      await settle();
      assertLacks(textOf(htmlOf(work())), ['Open Google', 'then tap the link FamCal sends you'], 'the wait after the commit');
      const posts = () => copyCalls().filter((c) => c.method === 'POST').length;
      const before = posts();
      a.m.click(buttonIn(work(), 'Approve in Google'));
      await settle();
      assert(posts() === before + 1, `Approve in Google sent no fresh consent: ${show(copyCalls().map((c) => c.method))}`);
      assert(!a.tg.calls.some((c) => c.includes('u1_used') && c.startsWith('openLink')), `the used URL was opened: ${show(a.tg.calls)}`);
    } finally {
      a.m.unmount();
    }
    // A stopped copy: the row stays 'approve' either way; the server's consentOpen tells.
    rows = [copyRow('own', { status: 'approve', consentOpen: false }), VIEW.rows[1]];
    const b = await mountCalendars('en');
    try {
      const home = () => cardOf(b.m, 'Home');
      b.m.click(buttonIn(home(), 'Approve in Google'));
      await settle();
      rows = [copyRow('own', { status: 'approve', consentOpen: true }), VIEW.rows[1]];
      fireDocument('visibilitychange');
      await settle();
      assertHas(textOf(htmlOf(home())), ['Open Google'], 'the wait while the consent is live');
      rows = [copyRow('own', { status: 'approve', consentOpen: false }), VIEW.rows[1]];
      fireDocument('visibilitychange');
      await settle();
      assertLacks(textOf(htmlOf(home())), ['Open Google'], 'the wait after the consent was used');
      assertHas(textOf(htmlOf(home())), ['Approve in Google'], 'the action back');
    } finally {
      b.m.unmount();
    }
    // A GET sent before the POST answered can't know the new consent: the wait stays.
    let hold: ((x: FetchAnswer) => void) | null = null;
    let gets = 0;
    rows = VIEW.rows;
    serveCopies = (c) => {
      if (c.method === 'POST') return ok200({ status: 'consent', oauthUrl: usedUrl });
      gets += 1;
      return gets === 2 ? new Promise<FetchAnswer>((r) => { hold = r; }) : ok200({ shown: true, ownerName: null, rows });
    };
    const c = await mountCalendars('en');
    try {
      fireDocument('visibilitychange');
      await settle();
      assert(hold, 'the second GET is not in flight');
      c.m.click(switchIn(cardOf(c.m, 'Work')));
      await settle();
      (hold as unknown as (x: FetchAnswer) => void)(ok200({ shown: true, ownerName: null, rows }));
      await settle();
      assertHas(textOf(htmlOf(cardOf(c.m, 'Work'))), ['Open Google'], 'the wait dropped by an older GET');
    } finally {
      c.m.unmount();
    }
  });

  await check('#125 React logged no warning on the calendars page (#119-#124d); the page\'s own logs are only the failures #120, #122 and #124c caused', () => {
    const lines = reactWarnings.slice(warnedBeforeCopies);
    const own = lines.filter((w) => /^\[(calendars|google-copy)\]/.test(w));
    assert(lines.length === own.length, `React warned: ${show(lines.filter((w) => !own.includes(w)).slice(0, 3))}`);
    const loadFailed = '[calendars] loading the Google copies failed: Error: google-sync GET answered 500';
    assert(show(own) === show([loadFailed, '[google-copy] DELETE off answered 500', loadFailed, loadFailed, '[calendars] loading the Google copies before a delete failed: Error: google-sync GET answered 500']), `logs ${show(own)}`);
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
