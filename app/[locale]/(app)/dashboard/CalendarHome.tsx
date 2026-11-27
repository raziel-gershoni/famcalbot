'use client';

// The calendar home (spec §5, §7.1, §7.2, §7.4, §7.6; Rulings R5, R6, R8, R19; Plan E
// Rulings 1, 2, 6, 7 and 9): what /dashboard shows.
// PageGate renders it with CalendarHomeProps from page-data. Plan E adds the tab bar and
// the Month.
//
// The container owns the data and the Telegram calls; the parts are presentational:
// - the store (D3's reducer) and the loader (./home-loader): one range request per
//   applicable source on mount, no dates; "Show next week" adds a week; a store drop
//   (midnight in tz, other facts) refetches the visible weeks; a return to the
//   foreground (visibilitychange, Telegram's activated) refetches them; ⋯ → Refresh
//   sends fresh=1; a stale Google answer asks once more after about 3 s; a Google error
//   retries once after about 5 s;
// - the answers: 401, 403 and any 404 show PageGate's NoCredentialCard; 429 is busy and a 500
//   is a retry, as a state row once the facts are pinned, else as a card;
// - the shell: the theme (AppScreen's, with D4's useTelegramTheme: Telegram's bg_color for the header and
//   background, data-theme for the tokens), the direction, document-level scroll on the Agenda (the
//   Month is a fixed region with two inner scrollers, MonthView) and the safe areas
//   (components/app-ui/screen.ts, the home's own ./home-shell), the header, the tab bar, the banners, the tab on
//   screen (AgendaView, or the Month's MonthView), and the send and menu sheets;
//   the banners include this device's notifications (6c-2): usePushDevice checks this browser on every open;
// - the tabs (Ruling 1): the bar sits under the header and above the banners, and shows
//   only while a panel can show (no card, no block). The tab on screen
//   is kept in sessionStorage for the session (Ruling 2). A switch closes any sheet and
//   the item sheet, and the Agenda opens at the top. Only the tab on screen is mounted;
//   the other one's tabpanel is there, empty and hidden, for the tab's aria-controls.
//   The header and the tab bar never stick (release 2, Ruling 4): the Agenda scrolls them
//   away with the page, and on the Month the page does not scroll. Their height goes on
//   .ch-home as --ch-top-h, which the Month's region is sized by. On the Month the banners
//   go at the top of the day's list (spec §1), so the top-level ones show off the Month only;
// - the Month (responsive home release 2, spec §1–§4): its focus (month.ts MonthFocus) once
//   the facts are pinned: today's month with today selected on a new visit, kept inside the
//   reach when today moves. A tap on a square selects its day (the list follows; the item
//   sheet of another day closes); Today selects today and seeks its month, the jump selects
//   its day and seeks its month, each with a new seek seq; leaving the tab keeps the month
//   that was in view for the next time. The span holds the focus month. The upright split
//   (collapsed or grown) is this device's memory (localStorage, v2; v1 mapped once). While
//   the Month shows, the loader asks its windows (wantedFocusMonths: the month in view, the
//   selected day's month, then the months around), at most 2 at a time; a return to
//   the foreground and Refresh ask the Month's windows, not the Agenda's weeks; Retry
//   asks one month again. Through a store drop the Month keeps the last facts, so it
//   stays where it is with its squares loading until the new answer;
// - the Month's calendar (release 3, Hebrew months): the account's choice (page-data's monthMode), then this
//   visit's taps on the bar's switch, each saved on the account (saveMonthMode; a failed save keeps it for the
//   visit). Hebrew months show while chosen and the facts show Hebrew dates; when the calendar on screen changes
//   (a tap, Hebrew dates going off or back), the focus moves to the selected day's month in it, the span around
//   that month, and the pane mounts anew there. The jump opens on that calendar's side;
// - the item sheet's reminder actions (reminder-actions spec §4): a tap posts through
//   deps.reminderAction; the answer's reminder patches every copy of the item in the
//   store (patchReminder, and the answer's closedKeys for the earlier open times a Done on a
//   repeating reminder also closed) so the sheet, the rows, the card and the Month follow at once,
//   and FamCal's windows are asked again to confirm. A changed or lost reminder only
//   shows its note and refetches. The open sheet's row is re-derived from the store by
//   key on every render (the tapped row is only the fallback), and a sheet whose item has
//   left the store closes a moment after its note;
// - Telegram's one BackButton (spec §7.6; AppScreen's onBack, set while it should show): shown while the item sheet, the Send sheet or
//   the ⋯ menu is open (the split's collapsed and grown are no back step, spec §3). A tap closes the sheet on top,
//   else the item sheet (Android's back gesture too). Vertical swipes are off while the Month tab
//   shows, its loading included (spec §1), and on everywhere else. Before a reload (a chunk-load error) both are let go,
//   since a reload runs no cleanup and the client keeps them;
// - a return to the foreground after the day has ended in tz (iOS suspends the midnight
//   timer with the app) drops the store at once, rather than asking for yesterday's
//   windows and labelling yesterday "Today" until they answer;
// - Google is a connection beside FamCal (spec "Google as a connection"): the home reads
//   the sources the server lists (FamCal for everyone, Google with a token), and a Google
//   state that needs the user (choose calendars, reconnect) is a banner over the Agenda,
//   never a screen without one. The Agenda, the tabs and the "+" are FamCal's for everyone;
// - the Month's parts (MonthView, MonthPane, MonthSquares, DayPanel, SplitHandle) are a chunk of their own
//   (import()): PageGate preloads this file's chunk on every /dashboard open. The chunk
//   is fetched once the first answer is in,
//   and the Month shows its placeholders until it is there;
// - editing (home editing spec §2, §4): the editor info (what the user can add, where, for
//   whom) is asked once for a FamCal user, and the header's "+" shows by it; the open
//   FamCal item's edit info is asked when its sheet opens, and the sheet shows its pencil
//   and Delete by it. The editor is a sheet of the container's (EditorSheet; ScopeSheet and
//   ConfirmSheet for which occurrences and for "Delete «title»?"). A write posts through
//   deps.editing, and on success the editor closes and FamCal's windows are asked again
//   (renew), so the new or changed item shows. The item sheet re-derives from the store;
//   after an edit it follows the item to its new key when the write gave one (a
//   "following" edit starts a new series, "all" can move its slot) once the refetch the
//   edit started brings that row, and closes if that refetch landed without the item. The
//   BackButton cancels the editor (which asks to discard only after a change);
// - drag to move (editor upgrades spec §4; the Month's list rows and large squares' chips, never the
//   Agenda): MonthView draws the lift and the drop (DragSurface); the container saves. A drop is the
//   editor's own edit with the start shifted (drag-model: the item's edit info, editItemForm, scopePlan,
//   updateBody), sent through deps.editing.update, so no scope or body rule is restated. The item shows
//   on its target day at once (the store's shiftItem) with a pending look; a repeating one asks which
//   occurrences first (the editor's ScopeSheet), and cancelling puts it back. A failure puts it back too,
//   with the editor's error copy in the bar; a success asks the source's windows again and offers Undo
//   (not after "this one and the ones after"). The swipe lock and the BackButton count a lift;
// - an error boundary around all of it; a chunk-load error reloads once.
//
// user.id is the page's own user_id (a Telegram id or a DB id), sent as it is to the
// range route and execute-command, which resolve it with verifyUserAuth, and used as it
// is in the storage keys. It is never swapped for another id.

import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { buildAgenda, reminderMark, storeRow, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import { defaultSpan, growSpan, inSpan, monthFirstDay, monthLastDay, monthModeOf, monthWindow, spanMonths, spanToShow, type MonthKey, type MonthSpan } from '@/src/lib/calendar-view/grid';
import type { MonthMode } from '@/src/lib/calendar-view/month-mode';
import { saveMonthMode } from '@/src/lib/calendar-view/month-mode-client';
import { deviceTimeZone, isPastDay, msUntilAheadCheck, msUntilDayCheck, zoneDiffers } from '@/src/lib/calendar-view/home-client';
import { createHomeLoader, type HomeLoader } from '@/src/lib/calendar-view/home-loader';
import type { CalendarHomeProps, HomeHints } from '@/src/lib/calendar-view/home-props';
import { readConnectBannerClosed, readHomeTab, readMonthSplit, writeConnectBannerClosed, writeHomeTab, writeMonthSplit, type HomeTab, type MonthSplit } from '@/src/lib/calendar-view/home-storage';
import { clampFocus, dayNotices, dayRows, focusInMode, focusJump, focusMonth, focusToday, initialFocus, monthModels, selectDay, wantedFocusMonths, type MonthFocus } from '@/src/lib/calendar-view/month';
import { dayDelta, moveBody, planMove, undoBody, undoable, type CantLift, type MovePlan } from '@/src/lib/calendar-view/drag-model';
import { addDaysToKey, closedReminders, dayStatus, emptyStore, homeNotices, itemCopies, reduceStore, type StoreFacts } from '@/src/lib/calendar-view/store';
import { postReminderAction, type ReminderActionFn, type ReminderActionName } from '@/src/lib/calendar-view/reminder-client';
import { REAL_EDITING, type EditingApi, type WriteOutcome } from '@/src/lib/calendar-view/editor-client';
import { REAL_ZMANIM, zmanWindowOf, type ZmanimApi, type ZmanimListResponse } from '@/src/lib/calendar-view/zmanim-list';
import { REAL_HOME_WEATHER, type HomeWeather, type HomeWeatherApi } from '@/src/lib/calendar-view/home-weather';
import { allOfThem, createBody, crossesKinds, editItemForm, isNativeCalendar, newItemForm, updateBody, type EditorForm } from '@/src/lib/calendar-view/editor-model';
import type { EditScope, EditorInfoResponse, ItemEditInfoResponse } from '@/src/lib/calendar-view/editor-types';
import type { DayKey, ItemDTO, ItemReminderDTO, SourceName } from '@/src/lib/calendar-view/types';
import { DEFAULT_BOT_USERNAME, DEFAULT_WA_NUMBER, type GateLinks } from '@/src/lib/gate-links';
import { sendEventCopy, type SendCopyOutcome } from '@/src/lib/calendar-view/copy-client';
import { hapticError, hapticImpact, hapticSelection, hapticSuccess, hapticWarning, isInTelegram, onTelegramEvent, useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { usePushDevice } from '@/src/lib/use-push-device';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { StateCard } from '@/components/app-ui/StateCard';
import { NoCredentialCard } from '../PageGate';
import { AGENDA_CSS, AgendaView } from './AgendaView';
import { PlaceholderRows } from './DayList';
import { HomeBanners, pushBannerOf } from './HomeBanners';
import { HomeErrorBoundary } from './HomeErrorBoundary';
import { HomeHeader } from './HomeHeader';
import { HomeTabs, PANEL_IDS, TAB_IDS } from './HomeTabs';
import { HOME_SHELL_CSS } from './home-shell';
import { DragBar, type BarContent, type BarState, type UndoEntry } from './DragBar';
import type { DropEvent } from './DragSurface';
import type { MonthDrag } from './MonthView';
import { EditorSheet, type MoveNote, type SaveOutcome } from './EditorSheet';
import type { SheetActions, SheetEditing, SheetNote } from './ItemSheet';
import { MenuSheet } from './MenuSheet';
import { DOM_VISIBILITY, afterShown } from '@/src/lib/visibility-timers';
import { ConfirmSheet, ScopeSheet, type SubmitError } from './ScopeSheet';
import { SendSheet } from './SendSheet';
import { ZmanimSheet } from './ZmanimSheet';

/**
 * The Month's parts, in a chunk of their own: PageGate preloads this file's chunk on
 * every /dashboard open (every user), so the Month's pane, squares, day list, handle and
 * the drag library come only when the home asks for them. A chunk that fails to load
 * reloads the page once (HomeErrorBoundary).
 */
const loadMonthView = () => import('./MonthView');
const MonthView = lazy(() => loadMonthView().then((m) => ({ default: m.MonthView })));

/**
 * The no-credential card's links. The server's env isn't in the browser, so these are
 * the public number and bot the landing pages link to (gate-links' defaults).
 */
const CLIENT_GATE_LINKS: GateLinks = {
  whatsapp: `https://wa.me/${DEFAULT_WA_NUMBER}?text=settings`,
  telegram: `https://t.me/${DEFAULT_BOT_USERNAME}?start=dashboard`,
};

/** The clock, the timers and the device's zone: the real ones, or a smoke's. */
export interface HomeDeps {
  now: () => number;
  setTimer: (run: () => void, ms: number) => () => void;
  deviceTimeZone: () => string | null;
  /** Done, undo and snooze from the item sheet: the fetch. */
  reminderAction: ReminderActionFn;
  /** The editing requests: the editor info, an item's edit info, create, edit and delete. */
  editing: EditingApi;
  /** The zmanim sheet's request for a day's list. */
  zmanim: ZmanimApi;
  /** The header's request for today's weather. */
  weather: HomeWeatherApi;
  /** A failure worth a report (a drop that could not be saved): to the console and to Sentry, with this context (no titles). */
  report: (error: unknown, context: string, extra: Record<string, unknown>) => void;
}

/**
 * The real report: error-capture's one console line and Sentry, loaded on the first report so the
 * home's graph holds no server module (@sentry/nextjs reaches OpenTelemetry and Prisma's instrumentation).
 */
function reportToSentry(error: unknown, context: string, extra: Record<string, unknown>): void {
  import('@/src/lib/error-capture')
    .then((m) => m.captureError(error, context, extra, 'warning'))
    .catch((err: unknown) => console.error(`[${context}] The report could not be sent:`, err, error, extra));
}

const REAL_DEPS: HomeDeps = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
  deviceTimeZone,
  reminderAction: postReminderAction,
  editing: REAL_EDITING,
  zmanim: REAL_ZMANIM,
  weather: REAL_HOME_WEATHER,
  report: reportToSentry,
};

/** Nothing to subscribe to: the value is read once on the client. */
const subscribeNothing = () => () => {};
/** On the server, and while hydrating, the home assumes Telegram (no browser banner). */
const assumeTelegram = () => true;
const noZone = () => null;

/** What stands in for the Agenda: busy or a retry before any answer. */
type Card = 'busy' | 'error';

/** How long a sheet whose item has gone stays up after its note. */
export const GONE_NOTE_MS = 2500;

/** The tapped row with the reminder an action answered, for when the store no longer holds the item. */
function withReminder(row: AgendaRow, reminder: ItemReminderDTO): AgendaRow {
  const prev = row.item.reminder;
  const next = { ...reminder, open: !reminder.done && (reminder.open || !!prev?.open), openSince: prev?.openSince ?? reminder.openSince };
  const item = { ...row.item, reminder: next };
  return { ...row, item, mark: reminderMark(item) };
}

/** The editor on screen: a new item, or an edit of the open one. */
type EditorState =
  | { mode: 'create'; initial: EditorForm; info: EditorInfoResponse; kinds: { event: boolean; reminder: boolean } }
  | { mode: 'edit'; initial: EditorForm; info: ItemEditInfoResponse; key: string };

/** A delete asked for from the item sheet. */
type DeleteState = { key: string; info: ItemEditInfoResponse; title: string };

/** A drop that asks which occurrences first: the item's edit info and the question, with where it went. */
type ScopeAsk = { key: string; days: number; copies: Readonly<Record<string, ItemDTO>>; info: ItemEditInfoResponse; plan: Extract<MovePlan, { kind: 'ask' }> };

/** How long the drag bar stays (Undo included). */
export const DRAG_BAR_MS = 6000;

/** The key for a log line: a Google key's calendar id (often an address) is left out. */
const loggableKey = (key: string) => key.replace(/^google\|[^|]*\|/, 'google|…|');

/** The source an item's windows are asked from after a write. */
const sourceOfKey = (key: string): SourceName => (key.startsWith('google|') ? 'google' : 'famcal');

/** The editor's field a server field name belongs to. */
const FIELD_OF: Record<string, 'title' | 'location' | 'notes' | 'start' | 'end' | 'alert' | 'repeat'> = { title: 'title', location: 'location', description: 'notes', start: 'start', end: 'end', alert: 'alert', repeat: 'repeat' };

const MOVE_NOTES: readonly MoveNote[] = ['moveAlone', 'moveMeet', 'moveHebrew', 'moveRepeat'];

/** A write's outcome as the editor shows it. */
function saveOutcome(out: WriteOutcome): SaveOutcome {
  switch (out.kind) {
    case 'ok':
      return { kind: 'ok' };
    case 'invalid':
      // A cross-source move refused (spec "Google as a connection" §5): saved with other changes, or it can't cross.
      if (out.field && (MOVE_NOTES as readonly string[]).includes(out.field)) return { kind: 'error', error: 'failed', move: out.field as MoveNote };
      // An "All" move that would start the series outside its years: said on the start row, not as a day move.
      if (out.reason === 'year') return { kind: 'error', error: 'failed', field: 'start', fieldError: 'errSeriesYear' };
      return { kind: 'error', error: 'failed', ...(out.field && FIELD_OF[out.field] ? { field: FIELD_OF[out.field] } : {}) };
    case 'notAllowed':
      return { kind: 'error', error: 'notAllowed' };
    case 'notFound':
    case 'changed':
      return { kind: 'error', error: 'changed' };
    case 'busy':
      return { kind: 'error', error: 'busy' };
    case 'reconnect':
      return { kind: 'error', error: 'reconnect' };
    case 'moveFailed':
      return { kind: 'error', error: 'moveFailed' };
    default:
      return { kind: 'error', error: 'failed' };
  }
}

/** The facts the Month last drew with, and the unavailable calendars then: kept through a store drop. */
type HeldFacts = { facts: StoreFacts; unavailable: number };

/** What the loader reads about the Month: the tab on screen and where the Month is. */
type MonthWants = { tab: HomeTab; focus: MonthFocus | null; near: readonly MonthKey[]; inView: MonthKey | null };

/**
 * The header and the tab bar's wrapper (Ruling 4: it never sticks). A flow root, so the tab bar's
 * bottom margin stays inside the height published as --ch-top-h: the Month's region is the
 * viewport less that height, and a margin collapsing out of the wrapper would make the page
 * scroll by it.
 */
export const HOME_TOP_CSS = `
.ch-home-top {
  display: flow-root;
}
`;

/**
 * Puts the wrapper's height on the home's root as --ch-top-h, rounded up to a whole pixel (rounded
 * down, the Month's region would be up to a pixel too tall and the page would scroll by it): the
 * Month's region is the viewport less it. React attaches the root's ref after its children's
 * layout effects, so on the first commit the ref is still empty and the wrapper's parent, the
 * root, stands in. Exported for smoke-app-ui, which pins both.
 */
export function publishTopHeight(top: HTMLElement | null, root: RefObject<HTMLElement | null>) {
  try {
    const home = root.current ?? top?.parentElement;
    if (!top || !home || typeof top.getBoundingClientRect !== 'function') return;
    const height = `${Math.ceil(top.getBoundingClientRect().height)}px`;
    if (home.style.getPropertyValue?.('--ch-top-h') !== height) home.style.setProperty('--ch-top-h', height);
  } catch (err) {
    // Without it the Month's region reads 0 for the header and is that much taller (the page then scrolls a little).
    console.warn('[calendar-home] The header\'s height could not be published:', err);
  }
}

/**
 * The header and the tab bar (they never stick, Ruling 4). Its height is published on every
 * commit, in a layout effect: as an earlier sibling's, it runs before the Month's own layout
 * effects in the same commit (the region's first measure reads the height through CSS), and a
 * ResizeObserver catches what changes it outside a render (fonts, a rotation). On the Month tab it
 * carries is-month: a short phone held upright gets the one-line header there (HOME_SHELL_CSS).
 */
function HomeTop({ homeRef, month, children }: { homeRef: RefObject<HTMLElement | null>; month: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => publishTopHeight(ref.current, homeRef));
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.ResizeObserver !== 'function') return;
    let observer: ResizeObserver;
    try {
      observer = new window.ResizeObserver(() => publishTopHeight(el, homeRef));
      observer.observe(el);
    } catch (err) {
      console.warn('[calendar-home] ResizeObserver failed; the header\'s height follows renders only:', err);
      return;
    }
    return () => observer.disconnect();
  }, [homeRef]);
  return (
    <div ref={ref} className={month ? 'ch-home-top is-month' : 'ch-home-top'}>
      {children}
    </div>
  );
}

/** The page to the top: the Agenda opens there after a tab switch. */
function scrollToTop() {
  try {
    window.scrollTo(0, 0);
  } catch {
    // The page stays where it is.
  }
}

function HomeCard({ kind, onRetry }: { kind: Card; onRetry: () => void }) {
  const t = useTranslations('calendarHome');
  const retry = { label: t('actions.retry'), onClick: onRetry };
  return kind === 'busy' ? <StateCard title={t('state.busy')} action={retry} /> : <StateCard title={t('state.errorTitle')} body={t('state.errorBody')} action={retry} />;
}

/** The Month before the first answer (a reload on the Month tab): placeholders, never free days. */
function MonthLoading() {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-loading" role="status">
      <style>{AGENDA_CSS}</style>
      <span className="ch-visually-hidden">{t('shell.loading')}</span>
      <div className="ch-ghost-head" aria-hidden="true" />
      <PlaceholderRows count={3} />
    </div>
  );
}

export type CalendarHomeContainerProps = CalendarHomeProps & { deps?: Partial<HomeDeps> };

/** The home without its error boundary; `deps` lets a smoke drive the clock and the timers. */
export function CalendarHomeContainer({ deps: depsIn, ...props }: CalendarHomeContainerProps) {
  const { user, locale, sources, googleConnected, googleState, hints, hasTelegram, hasChat, trialDaysLeft, hasLocation, lookahead7, jewish, dafYomi, push, monthMode: savedMonthMode } = props;
  const userId = user.id;
  const t = useTranslations('calendarHome');
  const router = useRouter();
  const [deps] = useState<HomeDeps>(() => ({ ...REAL_DEPS, ...depsIn }));
  const [store, dispatch] = useReducer(reduceStore, undefined, () => emptyStore());
  const [weeks, setWeeks] = useState(1);
  const [sheet, setSheet] = useState<'send' | 'menu' | 'zmanim' | null>(null);
  /** The row whose item sheet is open (AgendaView or the Month's MonthView renders it; the BackButton here closes it). */
  const [selected, setSelected] = useState<AgendaRow | null>(null);
  /** The sheet's reminder action in flight (one at a time), and the note after a tap that changed nothing. */
  const [acting, setActing] = useState<{ key: string; action: ReminderActionName } | null>(null);
  /** calendar: a note's calendar name ("Moved, but the old one is still in <calendar>"). */
  const [note, setNote] = useState<{ key: string; kind: SheetNote; calendar?: string } | null>(null);
  /** "Send a copy" in flight (one at a time), and the key whose last try failed (its note). */
  const [copying, setCopying] = useState<string | null>(null);
  const [copyFailedFor, setCopyFailedFor] = useState<string | null>(null);
  const copyingRef = useRef(false);
  const actingRef = useRef(false);
  /** The home's root (AppScreen's), which carries --ch-top-h. */
  const homeRef = useRef<HTMLDivElement | null>(null);
  /** What the user can add (null until asked, or when the request failed: no "+"). */
  const [editorInfo, setEditorInfo] = useState<EditorInfoResponse | null>(null);
  /** The open item's edit info, with the key it was asked for; bumped to ask again after an edit. */
  const [itemInfo, setItemInfo] = useState<{ key: string; info: ItemEditInfoResponse } | null>(null);
  const [infoTick, setInfoTick] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<SubmitError | null>(null);
  /**
   * After an edit of the open item: its key, the new key the write gave it (or null), and
   * whether the refetch the edit started has landed. Only that refetch may close the sheet:
   * a later Done that drops a carry-over keeps its row, so it can still be undone.
   */
  const [follow, setFollow] = useState<{ key: string; next: string | null; landed: boolean; note?: { kind: SheetNote; calendar: string } } | null>(null);
  const writingRef = useRef(false);
  const editorCancel = useRef<(() => void) | null>(null);
  /** A date or time sheet of the editor is open: a wheel dragged down would otherwise minimize the app. */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Drag to move: an item is lifted (the BackButton counts it). */
  const [dragging, setDragging] = useState(false);
  /** The item whose move is saving (the pending look), and the drop waiting for which occurrences. */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [scopeAsk, setScopeAsk] = useState<ScopeAsk | null>(null);
  /** The bar after a drag (moved with Undo, undone, the note for an item that can't move, an error), and its Undo in flight. */
  const [bar, setBar] = useState<BarState | null>(null);
  const [undoing, setUndoing] = useState(false);
  const barSeq = useRef(0);
  const dragCancel = useRef<(() => void) | null>(null);
  const [firstLoad, setFirstLoad] = useState<'busy' | 'error' | null>(null);
  const [blocked, setBlocked] = useState<'noCredential' | null>(null);
  const inTelegram = useSyncExternalStore(subscribeNothing, isInTelegram, assumeTelegram);
  const deviceZone = useSyncExternalStore(subscribeNothing, deps.deviceTimeZone, noZone);
  /** The tab this session last showed (sessionStorage; Ruling 2). */
  const [tab, setTab] = useState<HomeTab>(() => readHomeTab(userId));
  /** The upright split, collapsed or grown, as this device remembers it (localStorage, v2; v1 mapped once), read once. */
  const [split, setSplit] = useState<MonthSplit>(() => readMonthSplit(String(userId)));
  /** The Connect Telegram banner's close (no chat, 6c-1), as this device remembers it for this account. */
  const [connectClosed, setConnectClosed] = useState(() => readConnectBannerClosed(userId));
  const closeConnect = () => {
    writeConnectBannerClosed(userId);
    setConnectClosed(true);
  };
  /** This device's notifications (6c-2): the open's check (every account in a browser) and "Get reminders on this device". */
  const pushDevice = usePushDevice(userId, push, locale);
  /**
   * Where the Month is (month.ts): the month the pane was last sent to and the selected day; null
   * until the first answer pins the facts. A new visit opens on today's month with today selected.
   */
  const [focus, setFocus] = useState<MonthFocus | null>(null);
  /** Bumped by Today and the jump: the pane scrolls to the focus month on each new value. */
  const [seekSeq, setSeekSeq] = useState(0);
  /**
   * The months the pane holds (grid.ts; owner 2026-11-17, "infinite scroll"): today's −12/+18 on the
   * first answer, grown at an end as the pane scrolls near it, and moved to hold the focus month
   * (a jump, Today). It is not remembered: a new visit opens on today's month.
   */
  const [span, setSpan] = useState<MonthSpan | null>(null);
  /** The jump to a date's sheet is open (the month's name in the pane's bar). */
  const [jumping, setJumping] = useState(false);
  /** The pane's reports: the months it draws (in view and its neighbours), and the month in view. */
  const [near, setNear] = useState<readonly MonthKey[]>([]);
  const [inView, setInView] = useState<MonthKey | null>(null);
  const [held, setHeld] = useState<HeldFacts | null>(null);
  /** The Month's calendar the person chose: the account's (page-data), then this visit's taps on the bar's switch. */
  const [chosenMode, setChosenMode] = useState<MonthMode>(() => savedMonthMode ?? 'gregorian');
  /** The switch's save on its way, if any, and the latest choice (sent when that save lands). */
  const modeSaving = useRef<{ busy: boolean; latest: MonthMode }>({ busy: false, latest: savedMonthMode ?? 'gregorian' });

  const facts = store.facts;
  const notices = homeNotices(store);
  const card: Card | null = !facts && firstLoad ? firstLoad : null;
  // Ruling 1: the tab bar shows only while a panel can show. Otherwise the home is D's:
  // the Agenda (or the card), with no tab bar; the remembered tab is left as it is.
  const tabsShown = card === null && blocked === null;
  const activeTab: HomeTab = tabsShown ? tab : 'agenda';
  // The Month's calendar on screen: Hebrew months while chosen, the account is on the Jewish calendar (spec §7, as
  // page-data reads the stored choice; Hebrew dates alone also show for the Hebrew language or a zone in Israel) and
  // the latest facts (the held ones through a store drop) show Hebrew dates; otherwise Gregorian, the choice kept for
  // when Hebrew dates come back.
  const monthFacts = facts ?? held?.facts ?? null;
  const monthMode: MonthMode = jewish === true && monthFacts?.hebrewDates === true && chosenMode === 'hebrew' ? 'hebrew' : 'gregorian';

  // New facts (the first answer, a hebrewDates change, the next answer after a drop):
  // the Month holds them. On the first answer the focus is today's month (in the Month's
  // calendar) with today selected (a new visit selects today); when today moves later, it
  // stays inside the reach (clampFocus), the selected day kept, except that a selection that
  // was the old today follows to the new one.
  if (facts && (held === null || held.facts !== facts || held.unavailable !== notices.unavailableCalendars)) {
    setHeld({ facts, unavailable: notices.unavailableCalendars });
    if (held === null || held.facts.today !== facts.today) {
      // A selection that was the old today follows to the new today (the month target unchanged); any other stays.
      const clamped = focus === null ? initialFocus(facts.today, monthMode) : clampFocus(focus, facts.today);
      setFocus(clamped !== null && focus !== null && held !== null && focus.selected === held.facts.today ? selectDay(clamped, facts.today) : clamped);
      // The span is set once; a later today keeps it (the months grown or jumped to stay), and Today moves it when asked.
      if (span === null) setSpan(defaultSpan(facts.today, monthMode));
    }
  } else if (focus !== null && monthModeOf(focus.month) !== monthMode) {
    // The Month's calendar changed (the bar's switch, or Hebrew dates going off or back on a later answer), in a
    // pass after any new facts above: the selected day kept, the focus on its month in the new calendar, the span
    // around that month, the pane's reports dropped and the seek moved, as a jump does. MonthView keys the pane by
    // the calendar, so a new pane mounts on that month.
    const next = focusInMode(focus, monthMode);
    if (next !== focus) {
      setFocus(next);
      if (span !== null) setSpan(spanToShow(span, next.month));
      setNear([]);
      setInView(null);
      setSeekSeq((n) => n + 1);
    }
  }
  // The span always holds the focus month: a jump or Today past its ends moves it there.
  if (span !== null && focus !== null && !inSpan(span, focus.month)) {
    const next = spanToShow(span, focus.month);
    if (next !== span) setSpan(next);
  }

  // The loader reads the latest state through these; they are synced before it runs.
  const storeRef = useRef(store);
  const weeksRef = useRef(weeks);
  const blockedRef = useRef(blocked);
  const firstLoadRef = useRef(firstLoad);
  const monthRef = useRef<MonthWants>({ tab: activeTab, focus, near, inView });
  const loaderRef = useRef<HomeLoader | null>(null);
  const resetFor = useRef<string | null>(null);
  useEffect(() => {
    storeRef.current = store;
    weeksRef.current = weeks;
    blockedRef.current = blocked;
    firstLoadRef.current = firstLoad;
    monthRef.current = { tab: activeTab, focus, near, inView };
  });

  useEffect(() => {
    const loader = createHomeLoader({
      userId,
      sources,
      getStore: () => storeRef.current,
      getWeeks: () => weeksRef.current,
      dispatch,
      isBlocked: () => blockedRef.current !== null,
      firstLoadFailed: () => firstLoadRef.current !== null,
      onAnswer: () => setFirstLoad(null),
      onFirstLoadFailed: (kind) => setFirstLoad(kind),
      onNoCredential: () => {
        setBlocked('noCredential');
        setSheet(null);
        setSelected(null);
        setEditor(null);
        setDeleting(null);
      },
      setTimer: deps.setTimer,
      // The Month's windows while the Month is on screen (Ruling 7), most wanted first.
      getMonths: () => {
        const month = monthRef.current;
        const today = storeRef.current.facts?.today;
        return month.tab === 'month' && month.focus && today ? wantedFocusMonths(month.focus, month.near, month.inView, today) : [];
      },
      agendaShowing: () => monthRef.current.tab === 'agenda',
    });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [userId, sources, deps]);

  // Every visible window a source hasn't answered in this epoch: the first load, "Show
  // next week", the refetch after a drop, and the Month's windows as it comes on screen,
  // scrolls, or selects a day in another month.
  useEffect(() => {
    loaderRef.current?.ensure();
  }, [store, weeks, blocked, firstLoad, activeTab, near, inView, focus]);

  // Back in the foreground: the visible windows again (FamCal is one query; a Google
  // cache hit is one MGET). No pull-to-refresh: in Telegram that gesture minimizes the app.
  // If the day has ended in tz meanwhile (iOS suspends the midnight timer with the app),
  // the store drops at once, as the timer would have: the loader starts over with the
  // server's new today, and yesterday never stays labelled "Today".
  useEffect(() => {
    const foreground = () => {
      const facts = storeRef.current.facts;
      if (facts && isPastDay(deps.now(), facts.tz, facts.today) && resetFor.current !== facts.today) {
        resetFor.current = facts.today;
        dispatch({ type: 'reset' });
        return;
      }
      loaderRef.current?.refetchVisible();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') foreground();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const offActivated = onTelegramEvent('activated', foreground);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      offActivated();
    };
  }, [deps]);

  // Midnight in the user's timezone drops the store (D3's reset), once per day the
  // server named; the loader then starts over. A device clock that runs ahead gets the
  // same today back from that reset: from then on the check only asks the visible
  // windows again, soon rather than in an hour, and the server's new today drops the
  // store as any other mismatch does. A hidden tab asks nothing: its timer waits for the tab
  // to show (the foreground handler above checks the day then), so an open background tab
  // cannot keep Neon awake all night.
  const tz = store.facts?.tz ?? null;
  const today = store.facts?.today ?? null;
  useEffect(() => {
    if (!tz || !today) return;
    let cancel = () => {};
    let ahead = 0;
    const arm = () => {
      const now = deps.now();
      const ms = isPastDay(now, tz, today) ? msUntilAheadCheck(ahead++) : msUntilDayCheck(now, tz);
      cancel = deps.setTimer(() => {
        if (DOM_VISIBILITY.isHidden()) {
          cancel = afterShown(arm);
          return;
        }
        if (isPastDay(deps.now(), tz, today)) {
          if (resetFor.current !== today) {
            resetFor.current = today;
            dispatch({ type: 'reset' });
            return;
          }
          loaderRef.current?.refetchVisible();
        }
        arm();
      }, ms);
    };
    arm();
    return () => cancel();
  }, [tz, today, deps]);

  const agenda = useMemo(() => buildAgenda(store, weeks), [store, weeks]);
  // A store drop (midnight, other facts) empties the model, and the item sheet closes for
  // good, so it doesn't open again by itself when the new answer arrives.
  if (agenda === null && selected !== null) setSelected(null);

  // The open sheet follows the store: its row is re-derived by key on every render, and the
  // tapped row is only the fallback while the store holds no copy (a carry-over a refetch
  // dropped after done, which the sheet keeps showing so it can be undone). `gone` is an item
  // the store answered without.
  const liveRow = selected && store.facts ? storeRow(store, selected.item.key, selected.origin) : null;
  const selectedNow = selected && liveRow ? liveRow : selected;
  const selectedGone = selected !== null && store.facts !== null && liveRow === null;

  // The Month: the span's months, each month's model (memoized per store), and the selected day's list.
  const months = useMemo(() => spanMonths(span), [span]);
  const getMonth = useMemo(() => monthModels(store), [store]);
  const monthShown = activeTab === 'month' && held !== null && focus !== null;
  const listDay = monthShown && focus !== null ? focus.selected : null;
  const dayList = useMemo(() => (listDay ? { rows: dayRows(store, listDay), status: dayStatus(store, listDay), notices: dayNotices(store, listDay) } : null), [store, listDay]);

  const closeSheet = useCallback(() => setSheet(null), []);
  const navigate = useCallback(
    (href: string) => {
      setSheet(null);
      router.push(href);
    },
    [router],
  );
  const refresh = useCallback(() => {
    setSheet(null);
    loaderRef.current?.refetchVisible({ fresh: true });
  }, []);
  const showNextWeek = useCallback(() => setWeeks((w) => w + 1), []);
  const retrySource = useCallback((source: SourceName) => loaderRef.current?.refetchVisible({ only: source }), []);
  const retryMonth = useCallback((month: MonthKey, source: SourceName) => loaderRef.current?.retryWindow(monthWindow(month), source), []);
  const chooseCalendars = useCallback(() => router.push(`/${locale}/select-calendars?user_id=${userId}`), [router, locale, userId]);
  const retryCard = useCallback(() => {
    setFirstLoad(null);
  }, []);

  // The sheet's note belongs to the item it was shown for (a move's note is set for the key it follows to): another
  // item drops it, in the render that opens that item.
  const selectedKey = selected?.item.key ?? null;
  const [noteFor, setNoteFor] = useState(selectedKey);
  if (noteFor !== selectedKey) {
    setNoteFor(selectedKey);
    setNote((cur) => (cur && cur.key === selectedKey ? cur : null));
  }
  // What the user can add: asked once, for a Google user too (3b spec §3.3). A failure leaves the header without "+".
  useEffect(() => {
    let live = true;
    deps.editing
      .editor(userId)
      .then((info) => {
        if (live) setEditorInfo(info);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, deps]);
  const kinds = {
    event: !!editorInfo?.kinds.event,
    reminder: !!editorInfo?.kinds.reminder && hints.reminders,
  };
  const canAdd = editorInfo !== null && (kinds.event || kinds.reminder) && facts !== null && card === null && blocked === null;
  // The zmanim button (today's zmanim) is for the Jewish calendar setting, once the first answer has pinned the day.
  const canZmanim = jewish === true && facts !== null && card === null && blocked === null;

  // Today's weather in the header, for a person with a saved place, once the home is usable (the sun's conditions besides
  // the Jewish calendar). Asked again when the server's today moves on (the midnight reset); a failure shows nothing.
  const homeUsable = facts !== null && card === null && blocked === null;
  const weatherDay = facts?.today ?? null;
  const [weather, setWeather] = useState<'loading' | HomeWeather | null>('loading');
  // A new ask (the home turned usable, a new day, another user or language) shows the loading state from its own render.
  const weatherAsk = hasLocation && homeUsable ? JSON.stringify([weatherDay, userId, locale]) : null;
  const [weatherAsked, setWeatherAsked] = useState(weatherAsk);
  if (weatherAsked !== weatherAsk) {
    setWeatherAsked(weatherAsk);
    if (weatherAsk !== null) setWeather('loading');
  }
  useEffect(() => {
    if (!hasLocation || !homeUsable) return;
    let live = true;
    deps.weather
      .load(userId, locale)
      .then((outcome) => {
        if (!live) return;
        if (outcome.kind === 'ok') {
          setWeather(outcome.weather);
        } else {
          console.warn('[home-weather] no forecast', outcome.status);
          setWeather(null);
        }
      })
      .catch((error: unknown) => {
        console.error('[home-weather] the request threw:', error);
        if (live) setWeather(null);
      });
    return () => {
      live = false;
    };
  }, [hasLocation, homeUsable, weatherDay, userId, locale, deps]);

  // The zman that passed last and the next one under the header's date lines, wherever the sun is and a place is saved (a
  // list counted at the zone's main city shows nothing): today's list (the sheet's own request) asked once the home is
  // usable, and again on a new today; once today's are all past, tomorrow's, and before today's first, yesterday's. A timer
  // moves the lines on at each zman, and so does the foreground (iOS freezes the timer with the app). A hidden tab asks
  // nothing (it waits to be shown). A failed list shows nothing (fetchZmanimList logs it) and is asked again on the next
  // foreground, never in a loop.
  const zmanToday = canZmanim && hasLocation ? (facts?.today ?? null) : null;
  const [zmanLists, setZmanLists] = useState<Record<string, ZmanimListResponse>>({});
  const zmanAsked = useRef(new Set<string>());
  const [zmanTick, setZmanTick] = useState(0);
  const askZmanList = useCallback(
    (day: DayKey) => {
      const key = `${userId}:${day}`;
      if (zmanAsked.current.has(key)) return;
      zmanAsked.current.add(key);
      const failed = () => zmanAsked.current.delete(key);
      deps.zmanim
        .list(userId, day)
        .then((out) => {
          if (out.kind === 'ok') setZmanLists((lists) => ({ ...lists, [key]: out.list }));
          else failed();
        })
        .catch((error: unknown) => {
          console.error(`[next-zman] the list for ${day} could not be read:`, error);
          failed();
        });
    },
    [userId, deps],
  );
  const zmanYesterday = zmanToday ? addDaysToKey(zmanToday, -1) : null;
  const zmanTomorrow = zmanToday ? addDaysToKey(zmanToday, 1) : null;
  const listOf = (day: DayKey | null) => (day ? zmanLists[`${userId}:${day}`] : undefined);
  const todayZmanim = listOf(zmanToday);
  const yesterdayZmanim = listOf(zmanYesterday);
  const tomorrowZmanim = listOf(zmanTomorrow);
  // zmanTick: a timer below, or the foreground, moved the clock on.
  const zmanWindow = useMemo(
    () => (todayZmanim === undefined ? { window: null, wants: [] } : zmanWindowOf({ yesterday: yesterdayZmanim, today: todayZmanim, tomorrow: tomorrowZmanim }, deps.now())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [yesterdayZmanim, todayZmanim, tomorrowZmanim, zmanTick, deps],
  );
  const zmanWants = zmanWindow.wants.join(',');
  const nextZmanAt = zmanWindow.window?.next?.row.at ?? null;
  useEffect(() => {
    const tick = () => {
      if (!DOM_VISIBILITY.isHidden()) setZmanTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', tick);
    const offActivated = onTelegramEvent('activated', tick);
    return () => {
      document.removeEventListener('visibilitychange', tick);
      offActivated();
    };
  }, []);
  useEffect(() => {
    if (zmanToday) askZmanList(zmanToday);
  }, [zmanToday, askZmanList, zmanTick]);
  useEffect(() => {
    if (!zmanYesterday || !zmanTomorrow || zmanWants === '') return;
    const ask = () => {
      if (zmanWants.includes('yesterday')) askZmanList(zmanYesterday);
      if (zmanWants.includes('tomorrow')) askZmanList(zmanTomorrow);
    };
    if (!DOM_VISIBILITY.isHidden()) {
      ask();
      return;
    }
    return afterShown(ask);
  }, [zmanWants, zmanYesterday, zmanTomorrow, askZmanList, zmanTick]);
  useEffect(() => {
    if (nextZmanAt === null) return;
    return deps.setTimer(() => setZmanTick((n) => n + 1), Math.max(0, Date.parse(nextZmanAt) - deps.now()) + 1000);
  }, [nextZmanAt, deps, zmanTick]);

  // The open item's edit info (FamCal's, or Google's), asked when its sheet opens (and again
  // after an edit of it). An item of either source is one the user may be able to change:
  // the server answers per item.
  const selectedEditable = selected !== null;
  useEffect(() => {
    if (!selectedKey || !selectedEditable) return;
    let live = true;
    deps.editing
      .item(userId, selectedKey)
      .then((info) => {
        if (live) setItemInfo(info ? { key: selectedKey, info } : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [selectedKey, selectedEditable, infoTick, userId, deps]);
  const openInfo = itemInfo && itemInfo.key === selectedKey ? itemInfo.info : null;

  // An item the store no longer holds: its note shows, then the sheet closes.
  useEffect(() => {
    if (!selectedGone || note === null || note.key !== selectedKey) return;
    return deps.setTimer(() => setSelected(null), GONE_NOTE_MS);
  }, [selectedGone, note, selectedKey, deps]);

  // After an edit: the sheet shows the item under its new key as soon as the store has that
  // row; once the edit's refetch has landed, it closes if the item is not there (moved out of
  // view, or cut off), else it keeps the edited copy as the one to fall back on. Another item
  // opened, or the sheet closed, ends the watch.
  // It is worked out while the page draws, from the store and the open item.
  if (follow) {
    if (selectedKey !== follow.key) {
      setFollow(null);
    } else {
      const moved = follow.next && store.facts ? storeRow(store, follow.next) : null;
      if (moved) {
        setSelected(moved);
        if (follow.note && follow.next) setNote({ key: follow.next, ...follow.note });
        setFollow(null);
      } else if (follow.landed) {
        setSelected(follow.next !== null || liveRow === null ? null : liveRow);
        setFollow(null);
      }
    }
  }

  // Done, undo or snooze on the open sheet's item. One request at a time. An answer with a
  // reminder patches the store at once and FamCal's windows confirm it; changed and
  // not_yours only show their note and refetch. Never throws: a failed request is a note.
  const runAction = async (action: ReminderActionName) => {
    const row = selectedNow;
    const seriesId = row?.item.seriesId;
    const originalStart = row?.item.originalStart;
    if (!row || !seriesId || !originalStart || actingRef.current) return;
    const key = row.item.key;
    actingRef.current = true;
    // What happens to the item now is this tap's, not an earlier edit's.
    setFollow(null);
    setActing({ key, action });
    setNote(null);
    let outcome;
    try {
      outcome = await deps.reminderAction(userId, { seriesId, originalStart, action });
    } catch {
      outcome = { kind: 'failed' as const };
    }
    actingRef.current = false;
    setActing(null);
    if (outcome.kind === 'failed') {
      setNote({ key, kind: 'failed' });
      return;
    }
    const { status, reminder } = outcome;
    if (status === 'changed' || status === 'not_yours') {
      setNote({ key, kind: status === 'changed' ? 'changed' : 'notYours' });
    } else {
      if (reminder) {
        loaderRef.current?.patchReminder(key, reminder);
        setSelected((cur) => (cur && cur.item.key === key ? withReminder(cur, reminder) : cur));
      }
      // A Done on a repeating reminder also closed its earlier open times: they take the same patch.
      if (outcome.closedKeys) {
        for (const [closedKey, closed] of closedReminders(store, outcome.closedKeys, reminder?.doneAt ?? new Date(deps.now()).toISOString())) loaderRef.current?.patchReminder(closedKey, closed);
      }
      if (status === 'already_done') setNote({ key, kind: 'alreadyDone' });
      else if (status === 'ok' && action === 'done') hapticSuccess();
    }
    loaderRef.current?.refetchVisible({ only: 'famcal', renew: true });
  };
  // After a write: the item's source's windows again, so the new or changed item shows (a new
  // item: the source of the calendar it went to, else every source this user reads). Settles
  // when they have landed. A Google write stamps the server's cache, so this read is not a stale one.
  const createdIn = (form: EditorForm): SourceName | undefined => (form.kind === 'reminder' ? 'famcal' : form.calendarId ? (isNativeCalendar(form.calendarId) ? 'famcal' : 'google') : undefined);
  const refreshWritten = (source?: SourceName) => loaderRef.current?.refetchVisible({ ...(source ? { only: source } : {}), renew: true }) ?? Promise.resolve();
  // A write that needs the user's Google connection raises the same banner a failed read does.
  const raiseReconnect = (out: WriteOutcome) => {
    if (out.kind === 'reconnect') dispatch({ type: 'reconnect', reason: out.reason });
  };

  const openAdd = () => {
    if (!editorInfo || !facts) return;
    const initial = newItemForm({
      today: facts.today,
      // On the Month the selected day is always on screen: "+" starts on it (Ruling 3).
      pickedDay: listDay,
      nowMs: deps.now(),
      tz: editorInfo.tz,
      kinds,
      calendars: editorInfo.calendars,
    });
    setSheet(null);
    setEditor({ mode: 'create', initial, info: editorInfo, kinds });
  };
  const openEdit = () => {
    if (!openInfo || !selectedKey) return;
    setEditor({ mode: 'edit', initial: editItemForm(openInfo), info: openInfo, key: selectedKey });
  };
  const openDelete = () => {
    if (!openInfo || !selectedKey) return;
    setDeleteError(null);
    setDeleting({ key: selectedKey, info: openInfo, title: openInfo.occurrence.title });
  };

  // Save from the editor: one write at a time. Success closes the editor and asks FamCal again;
  // after an edit the open sheet follows the item (follow): to its new key when the write gave
  // one, or closed if the refetch lands without it. Never throws.
  const saveEditor = async (form: EditorForm, scope: EditScope): Promise<SaveOutcome> => {
    if (!editor || writingRef.current) return { kind: 'error', error: 'busy' };
    writingRef.current = true;
    let out: WriteOutcome;
    try {
      if (editor.mode === 'create') out = await deps.editing.create(userId, createBody(form));
      else {
        const body = updateBody(form, editor.initial, editor.key, scope, editor.info);
        out = body ? await deps.editing.update(userId, body) : { kind: 'ok', key: editor.key };
      }
    } catch {
      out = { kind: 'failed' };
    }
    writingRef.current = false;
    raiseReconnect(out);
    const result = saveOutcome(out);
    if (result.kind === 'ok') {
      setEditor(null);
      // A move to the other kind of calendar (spec "Google as a connection" §5): the old item leaves
      // its source at once (unless the server says it is still there), and both sources are asked again.
      const moving = editor.mode === 'edit' && crossesKinds(form, editor.initial);
      const leftIn = out.kind === 'ok' ? out.leftIn : undefined;
      if (moving && leftIn === undefined) dispatch({ type: 'dropItem', key: editor.key });
      const landed = refreshWritten(moving ? undefined : editor.mode === 'edit' ? (editor.key.startsWith('google|') ? 'google' : 'famcal') : createdIn(form));
      if (editor.mode === 'edit') {
        const next = out.kind === 'ok' && out.key && out.key !== editor.key ? out.key : null;
        const armed = { key: editor.key, next, landed: false, ...(leftIn !== undefined ? { note: { kind: 'movedLeft' as const, calendar: leftIn } } : {}) };
        if (leftIn !== undefined && !next) setNote({ key: editor.key, kind: 'movedLeft', calendar: leftIn });
        setFollow(armed);
        // The same key's edit info again; a new key's is asked when the sheet moves to it.
        if (!armed.next) setInfoTick((n) => n + 1);
        void landed.then(() => setFollow((cur) => (cur === armed ? { ...armed, landed: true } : cur)));
      } else hapticSuccess();
    }
    return result;
  };

  const runDelete = async (scope: EditScope) => {
    if (!deleting || writingRef.current) return;
    writingRef.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    let out: WriteOutcome;
    try {
      out = await deps.editing.remove(userId, { key: deleting.key, scope });
    } catch {
      out = { kind: 'failed' };
    }
    writingRef.current = false;
    setDeleteBusy(false);
    raiseReconnect(out);
    const result = saveOutcome(out);
    if (result.kind === 'ok') {
      setDeleting(null);
      setSelected((cur) => (cur && cur.item.key === deleting.key ? null : cur));
      hapticSuccess();
      void refreshWritten(deleting.key.startsWith('google|') ? 'google' : 'famcal');
    } else setDeleteError(result.error);
  };

  // ---- Drag to move (editor upgrades spec §4) ----
  // The bar after a drag; a newer one replaces it, and it goes after DRAG_BAR_MS (not while Undo runs).
  const showBar = (next: BarContent) => setBar({ ...next, id: ++barSeq.current });
  useEffect(() => {
    if (!bar || undoing) return;
    return deps.setTimer(() => setBar(null), DRAG_BAR_MS);
  }, [bar, undoing, deps]);
  // A failure is reported once, with its cause (the console line is error-capture's): the key and scope, never a title.
  const reportDrag = (what: string, key: string, scope: EditScope | null, cause: unknown) =>
    deps.report(cause instanceof Error ? cause : new Error(`Drag to move: ${what}`), 'calendar-home-drag', { user_id: userId, what, key: loggableKey(key), ...(scope ? { scope } : {}) });
  // The item exactly as the store held it before the lift's shift, and the source asked again: an answer that
  // landed since can't leave it on a day it never had.
  const putBack = (key: string, copies: Readonly<Record<string, ItemDTO>>) => {
    dispatch({ type: 'restoreItem', key, copies });
    setPendingKey((cur) => (cur === key ? null : cur));
    void refreshWritten(sourceOfKey(key));
  };
  // The drop could not be saved: the item goes back, the bar says why in the editor's words.
  const failMove = (key: string, copies: Readonly<Record<string, ItemDTO>>, bar: { error: SubmitError | null; key?: string }, what: string, cause: unknown, scope: EditScope | null = null) => {
    putBack(key, copies);
    hapticError();
    showBar({ kind: 'error', ...bar });
    reportDrag(what, key, scope, cause);
  };
  const refuseMove = (key: string, copies: Readonly<Record<string, ItemDTO>>, note: CantLift) => {
    putBack(key, copies);
    hapticWarning();
    showBar({ kind: 'note', note });
  };
  // A refusal as the editor words it (EditorSheet.run): the series would start too early, a repeat the server
  // refused, a day move the rule fixes (retrying would fail the same way); else the write's own error.
  const refusalCopy = (result: Extract<SaveOutcome, { kind: 'error' }>, scope: EditScope): { error: SubmitError | null; key?: string } => {
    if (result.fieldError) return { error: result.error, key: `editor.errors.${result.fieldError}` };
    if (result.field === 'repeat') return { error: result.error, key: 'editor.errors.errRepeat' };
    if (result.field === 'start' && scope !== 'single') return { error: result.error, key: 'scope.dayMoveNote' };
    return { error: result.error };
  };

  // The save of a drop, with the scope picked: the editor's PATCH body, through the editor's client.
  const sendMove = async (key: string, days: number, copies: Readonly<Record<string, ItemDTO>>, info: ItemEditInfoResponse, plan: Extract<MovePlan, { kind: 'save' | 'ask' }>, scope: EditScope) => {
    const body = moveBody(plan, key, scope, info);
    if (!body) return putBack(key, copies);
    if (writingRef.current) return failMove(key, copies, { error: 'busy' }, 'busy', new Error('Another write was running'), scope);
    writingRef.current = true;
    let out: WriteOutcome;
    let thrown: unknown = null;
    try {
      out = await deps.editing.update(userId, body);
    } catch (err) {
      thrown = err;
      out = { kind: 'failed' };
    }
    writingRef.current = false;
    raiseReconnect(out);
    const result = saveOutcome(out);
    if (result.kind !== 'ok') return failMove(key, copies, refusalCopy(result, scope), `update ${out.kind}`, thrown ?? new Error(`The move was not saved: ${out.kind}`), scope);
    hapticSuccess();
    const answered = out.kind === 'ok' && out.key ? out.key : key;
    // The bar names the item's new start day (a multi-day item grabbed on its 2nd day starts before the drop day).
    showBar({ kind: 'moved', day: plan.form.startDay, undo: undoable(scope) ? { key: answered, scope, days } : null });
    void refreshWritten(sourceOfKey(key)).then(() => setPendingKey((cur) => (cur === key ? null : cur)));
  };

  // A drop on another day: the item moves at once, then its edit info says whether and how it saves.
  const moveItem = async ({ key, grabbedDay, dropDay }: DropEvent) => {
    const days = dayDelta(grabbedDay, dropDay);
    if (days === null || days === 0 || !facts) return;
    if (writingRef.current || scopeAsk !== null) {
      hapticError();
      showBar({ kind: 'error', error: 'busy' });
      return;
    }
    // The last drag's bar (and its Undo) goes: its Undo could not run while this one writes.
    setBar(null);
    writingRef.current = true;
    const copies = itemCopies(storeRef.current, key);
    dispatch({ type: 'shiftItem', key, days });
    setPendingKey(key);
    let info: ItemEditInfoResponse | null = null;
    let thrown: unknown = null;
    try {
      info = await deps.editing.item(userId, key);
    } catch (err) {
      thrown = err;
    }
    writingRef.current = false;
    if (!info) return failMove(key, copies, { error: null }, 'item info unavailable', thrown ?? new Error('The item could not be read'));
    const plan = planMove(info, days);
    switch (plan.kind) {
      case 'cant':
        return refuseMove(key, copies, plan.reason);
      case 'nothing':
        return putBack(key, copies);
      case 'invalid':
        return failMove(key, copies, { error: null, key: `editor.errors.${plan.error}` }, `blocked ${plan.error}`, new Error(`The editor's check blocks this move: ${plan.error}`));
      case 'refuse':
        return failMove(key, copies, { error: null, key: plan.note === 'dayMoveAlone' ? 'editor.dayMoveAlone' : 'editor.moveAlone' }, `refused ${plan.note}`, new Error(`The editor refuses this move: ${plan.note}`));
      case 'ask':
        setScopeAsk({ key, days, copies, info, plan });
        return;
      case 'save':
        return sendMove(key, days, copies, info, plan, plan.scope);
    }
  };
  const cancelScopeAsk = () => {
    if (!scopeAsk) return;
    putBack(scopeAsk.key, scopeAsk.copies);
    setScopeAsk(null);
  };
  const pickScope = (scope: EditScope) => {
    if (!scopeAsk) return;
    const ask = scopeAsk;
    setScopeAsk(null);
    void sendMove(ask.key, ask.days, ask.copies, ask.info, ask.plan, scope);
  };

  // Undo: the move back, the same way (the item's edit info on the key the PATCH answered, the start shifted back,
  // the editor's body, the same scope). A tap never does nothing: while it runs the button is busy, and while another
  // write runs the bar says so and keeps the Undo for another tap.
  const runUndo = async (entry: UndoEntry) => {
    if (undoing) return;
    if (writingRef.current) {
      hapticError();
      showBar({ kind: 'error', error: 'busy', undo: entry });
      return;
    }
    writingRef.current = true;
    setUndoing(true);
    let out: WriteOutcome = { kind: 'failed' };
    let thrown: unknown = null;
    try {
      const info = await deps.editing.item(userId, entry.key);
      const body = info ? undoBody(info, entry.key, entry.scope, entry.days) : null;
      if (body) out = await deps.editing.update(userId, body);
    } catch (err) {
      thrown = err;
    }
    writingRef.current = false;
    setUndoing(false);
    raiseReconnect(out);
    const result = saveOutcome(out);
    if (result.kind === 'ok') {
      hapticSuccess();
      showBar({ kind: 'undone' });
    } else {
      hapticError();
      showBar({ kind: 'error', ...refusalCopy(result, entry.scope) });
      reportDrag(`undo ${out.kind}`, entry.key, entry.scope, thrown ?? new Error(`The undo was not saved: ${out.kind}`));
    }
    void refreshWritten(sourceOfKey(entry.key));
  };
  // Resting on a chevron scrolls the pane (MonthView gives the layer its onNav, Ruling 5).
  const dragProps: MonthDrag = {
    pendingKey,
    onBlocked: (reason: CantLift) => {
      hapticWarning();
      showBar({ kind: 'note', note: reason });
    },
    onLift: hapticImpact,
    onTarget: hapticSelection,
    onDrop: (drop: DropEvent) => void moveItem(drop),
    onDraggingChange: setDragging,
    cancelRef: dragCancel,
  };
  const sendCopy = async (row: AgendaRow) => {
    if (copyingRef.current) return;
    copyingRef.current = true;
    const key = row.item.key;
    setCopying(key);
    setCopyFailedFor(null);
    let outcome: SendCopyOutcome;
    try {
      outcome = await sendEventCopy(userId, key);
    } catch (err) {
      console.error('[event-copy] sending the copy threw', err);
      outcome = 'failed';
    }
    copyingRef.current = false;
    setCopying(null);
    if (outcome === 'failed') {
      hapticError();
      setCopyFailedFor(key);
    }
  };
  const canSendCopy = inTelegram && selected !== null && selected.item.source === 'famcal' && selected.item.kind === 'event';
  const editing: SheetEditing | undefined =
    openInfo && (openInfo.canEdit || openInfo.canDelete || openInfo.editableInGoogleOnly)
      ? { canEdit: openInfo.canEdit, canDelete: openInfo.canDelete, googleOnly: openInfo.editableInGoogleOnly === true, kind: openInfo.kind, onEdit: openEdit, onDelete: openDelete }
      : undefined;

  const sheetActions: SheetActions = {
    busy: acting !== null,
    pending: acting && acting.key === selectedKey ? acting.action : null,
    note: note && note.key === selectedKey ? note.kind : null,
    ...(note && note.key === selectedKey && note.calendar !== undefined ? { noteValues: { calendar: note.calendar } } : {}),
    now: deps.now(),
    onAction: (action) => void runAction(action),
    editing,
    ...(canSendCopy ? { sendCopy: { busy: copying !== null, failed: copyFailedFor === selectedKey, onSend: () => void sendCopy(selected) } } : {}),
    // The sheet's repeat tag names a Hebrew rule, to a viewer who can't edit too (hebrew-repeats spec §1).
    hebrewRepeat: openInfo?.series.repeat?.hebrew
      ? { count: openInfo.series.repeat.interval, anchor: openInfo.series.repeat.hebrew.anchor }
      : undefined,
  };

  // A tab switch (Ruling 2): any sheet and the item sheet close; leaving the Month keeps the
  // month in view for the next time (the selected day stays); the Agenda opens at the top.
  const switchTab = (next: HomeTab) => {
    setSheet(null);
    setSelected(null);
    setJumping(false);
    if (activeTab === 'month' && focus !== null && held !== null && inView !== null) setFocus(focusMonth(focus, inView));
    if (next === 'month') {
      setNear([]);
      setInView(null);
    }
    setTab(next);
    writeHomeTab(userId, next);
    if (next === 'agenda') scrollToTop();
  };
  // The focus changes (a square, Today, the jump): the item sheet of another day closes with it.
  const changeFocus = (next: MonthFocus) => {
    if (focus === null || next === focus) return;
    if (next.selected !== focus.selected) setSelected(null);
    setFocus(next);
  };
  const selectListDay = (day: DayKey) => {
    if (focus !== null) changeFocus(selectDay(focus, day));
  };
  // The split's handle, the peek, a square while grown: remembered on this device.
  const changeSplit = (next: MonthSplit) => {
    setSplit(next);
    writeMonthSplit(String(userId), next);
  };
  // Near an end of the span: 12 more months there (grid.ts growSpan).
  const needMonths = useCallback((edge: 'before' | 'after') => setSpan((cur) => (cur ? growSpan(cur, edge) : cur)), []);
  // Today: today selected, and the pane sent to its month (the span follows it there).
  const goToday = () => {
    if (held === null || focus === null) return;
    changeFocus(focusToday(focus, held.facts.today));
    setSeekSeq((n) => n + 1);
  };
  // The jump to a date (owner 2026-11-17): the day selected, and the pane sent to its month; the span follows.
  const jumpTo = (day: DayKey) => {
    setJumping(false);
    if (focus === null) return;
    changeFocus(focusJump(focus, day));
    setSeekSeq((n) => n + 1);
  };
  /** The jump's sheet shows only while the Month does (a block or a card hides it). */
  const jumpShown = jumping && monthShown;
  // It opens on the selected day while it lies in the month in view (of either calendar), else on that month's first day.
  const inViewFirst = inView === null ? '' : monthFirstDay(inView);
  const jumpValue: DayKey =
    focus === null ? '' : inView === null || inViewFirst === '' || (inViewFirst <= focus.selected && focus.selected <= monthLastDay(inView)) ? focus.selected : inViewFirst;
  // The bar's Gregorian | Hebrew switch: the Month's calendar for this visit, saved on the account (a failed save keeps
  // the choice for this visit; saveMonthMode logs why). The page's own user_id, as every request of the home's. One save
  // at a time (final review M-1): taps while one is on its way wait, and the latest choice is sent when it lands, unless
  // it is the one just sent, so two saves never land out of order and quick taps stay under the settings' rate limit.
  const changeMonthMode = (next: MonthMode) => {
    setChosenMode(next);
    const saving = modeSaving.current;
    if (saving.busy) {
      saving.latest = next;
      return;
    }
    const send = (mode: MonthMode) => {
      saving.busy = true;
      saving.latest = mode;
      void saveMonthMode(userId, mode).then(() => {
        saving.busy = false;
        if (saving.latest !== mode) send(saving.latest);
      });
    };
    send(next);
  };

  // The one BackButton (§7.6): a tap closes the send or menu sheet, else the item sheet. The
  // split's collapsed and grown are no back step (spec §3).
  const itemOpen = selected !== null && (activeTab === 'agenda' ? blocked === null && card === null && agenda !== null : monthShown);
  const back = () => {
    if (dragging) dragCancel.current?.();
    else if (jumpShown) setJumping(false);
    else if (scopeAsk !== null) cancelScopeAsk();
    else if (deleting !== null) {
      if (!deleteBusy) setDeleting(null);
    } else if (editor !== null) editorCancel.current?.();
    else if (sheet !== null) setSheet(null);
    else if (itemOpen) setSelected(null);
  };
  const backActive = itemOpen || dragging || jumpShown || scopeAsk !== null || (blocked !== 'noCredential' && (sheet !== null || editor !== null || deleting !== null));
  // No swipe-down to minimize while the Month tab shows (spec §1; its loading included): there a
  // drag down scrolls the months or the list. An open date or time sheet locks them too (editor
  // upgrades spec §1), and so does a lifted item (drag to move, spec §4): the finger is dragging it.
  useTelegramVerticalSwipes(activeTab === 'month' || pickerOpen || jumpShown || dragging);

  // The Month's chunk, once the first answer is in and the tab bar shows, so the first
  // tap on Month rarely waits for it. A failed fetch is tried again by that tap.
  const monthPossible = tabsShown && facts !== null;
  useEffect(() => {
    if (monthPossible) loadMonthView().catch(() => {});
  }, [monthPossible]);

  if (blocked === 'noCredential') {
    return <NoCredentialCard inTelegram={inTelegram} links={CLIENT_GATE_LINKS} />;
  }

  const zone = facts && zoneDiffers(deviceZone, facts.tz) ? facts.tz : null;
  // No chat (6c-1): the bot's ways of adding are not this account's; it adds with "+", and the empty state says so.
  const shownHints: HomeHints = hasChat === false ? { ...hints, voiceEvents: false, addByTap: true } : hints;
  const agendaView = (
    <AgendaView
      agenda={agenda}
      hints={shownHints}
      selected={selectedNow}
      onSelect={setSelected}
      sheetActions={sheetActions}
      onShowNextWeek={showNextWeek}
      onRetry={retrySource}
      onChooseCalendars={chooseCalendars}
      dafYomi={dafYomi === true}
    />
  );
  // The banners: above the Agenda's panel, and at the top of the Month's day list (spec §1), never both.
  const banners = (
    <HomeBanners
      googleState={googleState}
      googleConnected={googleConnected}
      trialDaysLeft={trialDaysLeft}
      hasLocation={hasLocation}
      reconnect={notices.reconnect}
      inTelegram={inTelegram}
      hasTelegram={hasTelegram}
      hasChat={hasChat}
      connectClosed={connectClosed}
      onCloseConnect={closeConnect}
      pushBanner={pushBannerOf(push, pushDevice)}
      pushDevice={pushDevice}
      userId={userId}
      locale={locale}
      onNavigate={navigate}
    />
  );
  const monthView =
    monthShown && held !== null && focus !== null && dayList !== null ? (
      <MonthView
        today={held.facts.today}
        tz={held.facts.tz}
        weekStart={held.facts.weekStart}
        hebrewDates={held.facts.hebrewDates}
        monthMode={monthMode}
        onMonthMode={jewish === true ? changeMonthMode : undefined}
        dafYomi={dafYomi === true}
        months={months}
        getMonth={getMonth}
        focus={focus}
        seek={{ month: focus.month, seq: seekSeq }}
        split={split}
        onSplit={changeSplit}
        dayRows={dayList}
        unavailableCalendars={held.unavailable}
        banners={banners}
        selected={selectedNow}
        onSelect={setSelected}
        sheetActions={sheetActions}
        onSelectDay={selectListDay}
        onNearMonths={setNear}
        onMonthInView={setInView}
        onNeedMonths={needMonths}
        onToday={goToday}
        onJump={() => setJumping(true)}
        onRetryMonth={retryMonth}
        onChooseCalendars={chooseCalendars}
        jump={jumpShown ? { value: jumpValue, onPick: jumpTo, onClose: () => setJumping(false) } : null}
        drag={dragProps}
      />
    ) : (
      <MonthLoading />
    );

  return (
    <AppScreen className="ch-home" rootRef={homeRef} onBack={backActive ? back : null}>
      <style>{HOME_SHELL_CSS}</style>
      <style>{HOME_TOP_CSS}</style>
      <HomeTop homeRef={homeRef} month={activeTab === 'month'}>
        <HomeHeader
          today={facts?.today ?? null}
          hebrewDates={facts?.hebrewDates ?? false}
          zone={zone}
          sendOpen={sheet === 'send'}
          menuOpen={sheet === 'menu'}
          onSend={hasChat === false ? undefined : () => setSheet('send')}
          onMenu={() => setSheet('menu')}
          onAdd={canAdd ? openAdd : undefined}
          addOpen={editor?.mode === 'create'}
          onZmanim={canZmanim ? () => setSheet('zmanim') : undefined}
          zmanimOpen={sheet === 'zmanim'}
          weather={hasLocation && homeUsable ? weather : null}
          zmanWindow={zmanWindow.window}
        />
        {tabsShown ? <HomeTabs tab={tab} onTab={switchTab} /> : null}
      </HomeTop>
      {activeTab === 'month' ? null : banners}
      {card ? (
        <HomeCard kind={card} onRetry={retryCard} />
      ) : tabsShown ? (
        <>
          <div role="tabpanel" id={PANEL_IDS.agenda} aria-labelledby={TAB_IDS.agenda} hidden={tab !== 'agenda'}>
            {tab === 'agenda' ? agendaView : null}
          </div>
          <div role="tabpanel" id={PANEL_IDS.month} aria-labelledby={TAB_IDS.month} hidden={tab !== 'month'}>
            {tab === 'month' ? <Suspense fallback={<MonthLoading />}>{monthView}</Suspense> : null}
          </div>
        </>
      ) : (
        agendaView
      )}
      {sheet === 'send' ? <SendSheet userId={userId} locale={locale} today={facts?.today ?? null} weekStart={facts?.weekStart ?? null} lookahead7={lookahead7} onClose={closeSheet} /> : null}
      {sheet === 'zmanim' && facts ? (
        <ZmanimSheet
          userId={userId}
          locale={locale}
          today={facts.today}
          load={deps.zmanim.list}
          onOpenSettings={() => navigate(`/${locale}/settings?user_id=${userId}`)}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === 'menu' ? (
        <MenuSheet
          isAdmin={user.isAdmin}
          inTelegram={inTelegram}
          locale={locale}
          userId={userId}
          onNavigate={navigate}
          onRefresh={refresh}
          onClose={closeSheet}
        />
      ) : null}
      {editor ? (
        <EditorSheet
          mode={editor.mode}
          initial={editor.initial}
          hebrewDates={facts?.hebrewDates ?? false}
          reminderTime={editorInfo?.reminderTime}
          alertsOn={editorInfo?.alertsOn === true}
          defaultLead={editorInfo?.defaultLead}
          zmanim={editorInfo?.zmanim}
          tz={editorInfo?.tz}
          onOpenSettings={() => navigate(`/${locale}/settings?user_id=${userId}`)}
          today={facts?.today}
          weekStart={facts?.weekStart}
          onPickerChange={setPickerOpen}
          {...(editor.mode === 'create'
            ? { kinds: editor.kinds, calendars: editor.info.calendars, partner: editor.info.partner }
            : { info: editor.info, itemKey: editor.key, calendars: editorInfo?.calendars, partner: editorInfo?.partner })}
          onSave={saveEditor}
          onClose={() => setEditor(null)}
          cancelRef={editorCancel}
        />
      ) : null}
      {scopeAsk ? (
        <ScopeSheet
          kind={scopeAsk.info.kind}
          mode="save"
          title={scopeAsk.info.occurrence.title}
          day={scopeAsk.info.occurrence.start.slice(0, 10)}
          all={allOfThem(scopeAsk.info.series.repeat, scopeAsk.info.series.start, scopeAsk.info.series.spec)}
          weekStart={facts?.weekStart}
          choices={scopeAsk.plan.choices}
          note={scopeAsk.plan.note}
          busy={false}
          error={null}
          onPick={pickScope}
          onClose={cancelScopeAsk}
        />
      ) : null}
      <DragBar bar={bar} undoing={undoing} onUndo={(entry) => void runUndo(entry)} />
      {deleting && deleting.info.scopes.length > 1 ? (
        <ScopeSheet
          kind={deleting.info.kind}
          mode="delete"
          title={deleting.title}
          day={deleting.info.occurrence.start.slice(0, 10)}
          all={allOfThem(deleting.info.series.repeat, deleting.info.series.start, deleting.info.series.spec)}
          weekStart={facts?.weekStart}
          busy={deleteBusy}
          error={deleteError}
          onPick={(scope) => void runDelete(scope)}
          onClose={() => !deleteBusy && setDeleting(null)}
        />
      ) : null}
      {deleting && deleting.info.scopes.length <= 1 ? (
        <ConfirmSheet
          heading={t('scope.confirmDelete', { title: deleting.title })}
          confirmLabel={t('scope.deleteConfirm')}
          cancelLabel={t('scope.cancel')}
          danger
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void runDelete('single')}
          onClose={() => !deleteBusy && setDeleting(null)}
        />
      ) : null}
    </AppScreen>
  );
}

export default function CalendarHome(props: CalendarHomeProps) {
  return (
    <HomeErrorBoundary>
      <CalendarHomeContainer {...props} />
    </HomeErrorBoundary>
  );
}
