'use client';

// The calendar home (spec §5, §7.1, §7.2, §7.4, §7.6; Rulings R5, R6, R8, R19; Plan E
// Rulings 1, 2, 6, 7 and 9): what /dashboard shows the users the rollout switch covers.
// PageGate renders it with CalendarHomeProps once page-data says calendarHome; everyone
// else keeps today's DashboardClient. Plan E adds the tab bar and the Month.
//
// The container owns the data and the Telegram calls; the parts are presentational:
// - the store (D3's reducer) and the loader (./home-loader): one range request per
//   applicable source on mount, no dates; "Show next week" adds a week; a store drop
//   (midnight in tz, other facts) refetches the visible weeks; a return to the
//   foreground (visibilitychange, Telegram's activated) refetches them; ⋯ → Refresh
//   sends fresh=1; a stale Google answer asks once more after about 3 s; a Google error
//   retries once after about 5 s;
// - the answers: 404 not_enabled reloads once (PageGate then shows today's dashboard);
//   401, 403 and any other 404 show PageGate's NoCredentialCard; 429 is busy and a 500
//   is a retry, as a state row once the facts are pinned, else as a card;
// - the shell: the theme (D4's useTelegramTheme: Telegram's bg_color for the header and
//   background, data-theme for the tokens), the direction, document-level scroll and
//   the safe areas (./home-shell), the header, the tab bar, the banners, the tab on
//   screen (AgendaView, or the Month's MonthView), and the send and menu sheets;
// - the tabs (Ruling 1): the bar sits under the header and above the banners, and shows
//   only while a panel can show (no card, no block, not setupNeeded). The tab on screen
//   is kept in sessionStorage for the session (Ruling 2). A switch closes any sheet and
//   the item sheet, and the Agenda opens at the top. Only the tab on screen is mounted;
//   the other one's tabpanel is there, empty and hidden, for the tab's aria-controls.
//   While the Month shows browse, the header and the tab bar stick under the safe areas,
//   as in the approved MonthFlow (whose inner scroller the spec's document scroll
//   replaces): 6,400 px down at today's month, Send, ⋯ and the Agenda tab are still a tap
//   away. Their height goes on .ch-home as --ch-top-h, where browse's own bar sticks
//   under them. On the Agenda and in picked they scroll with the page;
// - the Month (spec §7.4): its MonthUi (month.ts) once the facts are pinned, from the
//   layout this device remembers (localStorage), kept inside the window when today
//   moves; browse opens on today's month with a peek the first time, on the picked
//   month after "All months", and on the month that was in view after a tab switch.
//   While the Month shows, the loader asks its windows (wantedMonths: the months near
//   the screen, or picked's month and its neighbours), at most 2 at a time; a return to
//   the foreground and Refresh ask the Month's windows, not the Agenda's weeks; Retry
//   asks one month again. Through a store drop the Month keeps the last facts, so it
//   stays where it is with its cells loading until the new answer;
// - Telegram's one BackButton (spec §7.6): shown while the item sheet, the Send sheet or
//   the ⋯ menu is open, or while the Month is in picked. A tap closes the sheet on top,
//   else the item sheet, else goes back to browse (Android's back gesture too). Vertical
//   swipes are off while the Month shows browse, its loading included (Ruling 9), and on
//   everywhere else. Before a reload (not_enabled, a chunk-load error) both are let go,
//   since a reload runs no cleanup and the client keeps them;
// - a return to the foreground after the day has ended in tz (iOS suspends the midnight
//   timer with the app) drops the store at once, rather than asking for yesterday's
//   windows and labelling yesterday "Today" until they answer;
// - a Google user still setting up (needsOAuth, needsCalendars) gets the setup banner, no
//   tab bar and no Agenda under it (an Agenda with nothing chosen would only say
//   "Nothing planned"); a remembered Month tab is left as it is;
// - the Month's views (MonthView, MonthBrowse, MonthPicked) are a chunk of their own
//   (import()): PageGate preloads this file's chunk on every /dashboard open, for the
//   users the switch doesn't cover too. The chunk is fetched once the first answer is in,
//   and the Month shows its placeholders until it is there;
// - an error boundary around all of it; a chunk-load error reloads once.
//
// user.id is the page's own user_id (a Telegram id or a DB id), sent as it is to the
// range route and execute-command, which resolve it with verifyUserAuth, and used as it
// is in the storage keys. It is never swapped for another id.

import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { buildAgenda, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import { monthSpan, monthWindow, type MonthKey } from '@/src/lib/calendar-view/grid';
import { deviceTimeZone, homeSources, isPastDay, msUntilAheadCheck, msUntilDayCheck, reloadOnce, zoneDiffers } from '@/src/lib/calendar-view/home-client';
import { createHomeLoader, type HomeLoader } from '@/src/lib/calendar-view/home-loader';
import type { CalendarHomeProps } from '@/src/lib/calendar-view/home-props';
import { readHomeTab, readMonthLayout, writeHomeTab, writeMonthLayout, type HomeTab } from '@/src/lib/calendar-view/home-storage';
import { backToBrowse, clampMonthUi, dayRows, initialMonthUi, monthModels, wantedMonths, type MonthUi } from '@/src/lib/calendar-view/month';
import { dayStatus, emptyStore, homeNotices, reduceStore, type StoreFacts } from '@/src/lib/calendar-view/store';
import type { SourceName } from '@/src/lib/calendar-view/types';
import { DEFAULT_BOT_USERNAME, DEFAULT_WA_NUMBER, type GateLinks } from '@/src/lib/gate-links';
import { isInTelegram, onTelegramEvent, releaseTelegramControls, useTelegramBackButton, useTelegramTheme, useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { NoCredentialCard } from '../PageGate';
import { AGENDA_CSS, AgendaView } from './AgendaView';
import { PlaceholderRows } from './DayList';
import { HomeBanners } from './HomeBanners';
import { HomeErrorBoundary } from './HomeErrorBoundary';
import { HomeHeader } from './HomeHeader';
import { HomeTabs, PANEL_IDS, TAB_IDS } from './HomeTabs';
import { HOME_SHELL_CSS } from './home-shell';
import { HOME_THEME_CSS } from './home-theme';
import { MenuSheet } from './MenuSheet';
import { SendSheet } from './SendSheet';

/**
 * The Month's views, in a chunk of their own: PageGate preloads this file's chunk on
 * every /dashboard open (the users the switch doesn't cover included), so the Month's
 * three views come only when the home asks for them. A chunk that fails to load reloads
 * the page once (HomeErrorBoundary).
 */
const loadMonthView = () => import('./MonthView');
const MonthView = lazy(() => loadMonthView().then((m) => ({ default: m.MonthView })));

/** The reload-once guard for 404 not_enabled (the switch was turned back). */
export const NOT_ENABLED_RELOAD_KEY = 'famcal:calendarHome:notEnabledReload:v1';

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
}

const REAL_DEPS: HomeDeps = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
  deviceTimeZone,
};

/** Nothing to subscribe to: the value is read once on the client. */
const subscribeNothing = () => () => {};
/** On the server, and while hydrating, the home assumes Telegram (no browser banner). */
const assumeTelegram = () => true;
const noZone = () => null;

/** What stands in for the Agenda: busy or a retry before any answer, or the switch-off card. */
type Card = 'busy' | 'error' | 'disabled';

/** The facts the Month last drew with, and the unavailable calendars then: kept through a store drop. */
type HeldFacts = { facts: StoreFacts; unavailable: number };

/** What the loader reads about the Month: the tab on screen and where the Month is. */
type MonthWants = { tab: HomeTab; ui: MonthUi | null; near: readonly MonthKey[]; inView: MonthKey | null };

/**
 * The header and the tab bar's wrapper. While the Month shows browse it sticks under the
 * safe areas, above browse's own bar (z-index 4 over 3) and under the sheets (50), on the
 * page's background, as the approved MonthFlow keeps them on screen.
 */
export const HOME_TOP_CSS = `
.ch-home-top.is-sticky {
  position: sticky;
  top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
  z-index: 4;
  background: var(--ch-bg);
}
`;

/** Puts the wrapper's height on .ch-home as --ch-top-h: browse's bar sticks under it, and its titles stop under both. */
function publishTopHeight(top: HTMLElement | null) {
  try {
    const home = top?.parentElement;
    if (!top || !home || typeof top.getBoundingClientRect !== 'function') return;
    const height = `${Math.round(top.getBoundingClientRect().height)}px`;
    if (home.style.getPropertyValue?.('--ch-top-h') !== height) home.style.setProperty('--ch-top-h', height);
  } catch {
    // Without it the bar sticks at the safe areas, as it would with nothing above it.
  }
}

/**
 * The header and the tab bar, sticky while `sticky` (browse). Its height is published on
 * every commit, in a layout effect: as an earlier sibling's, it runs before the Month's
 * own layout effects in the same commit (browse's opening scroll reads it), and a
 * ResizeObserver catches what changes it outside a render (fonts, a rotation).
 */
function HomeTop({ sticky, children }: { sticky: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => publishTopHeight(ref.current));
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.ResizeObserver !== 'function') return;
    let observer: ResizeObserver;
    try {
      observer = new window.ResizeObserver(() => publishTopHeight(el));
      observer.observe(el);
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={sticky ? 'ch-home-top is-sticky' : 'ch-home-top'}>
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
  return (
    <div className="ch-home-card" role="status">
      {kind === 'busy' ? (
        <p className="ch-home-card-title">{t('state.busy')}</p>
      ) : (
        <>
          <p className="ch-home-card-title">{t('state.errorTitle')}</p>
          <p className="ch-home-card-body">{t('state.errorBody')}</p>
        </>
      )}
      <button type="button" className="ch-btn ch-btn-primary ch-home-card-action" onClick={onRetry}>
        {t('actions.retry')}
      </button>
    </div>
  );
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
  const { user, locale, calendarSource, needsOAuth, needsCalendars, hints, trialDaysLeft, hasLocation, lookahead7 } = props;
  const userId = user.id;
  const router = useRouter();
  const scheme = useTelegramTheme();
  const [deps] = useState<HomeDeps>(() => ({ ...REAL_DEPS, ...depsIn }));
  const [store, dispatch] = useReducer(reduceStore, undefined, () => emptyStore());
  const [weeks, setWeeks] = useState(1);
  const [sheet, setSheet] = useState<'send' | 'menu' | null>(null);
  /** The row whose item sheet is open (AgendaView or the Month's picked renders it; the BackButton here closes it). */
  const [selected, setSelected] = useState<AgendaRow | null>(null);
  const [firstLoad, setFirstLoad] = useState<'busy' | 'error' | null>(null);
  const [blocked, setBlocked] = useState<'noCredential' | 'disabled' | null>(null);
  const inTelegram = useSyncExternalStore(subscribeNothing, isInTelegram, assumeTelegram);
  const deviceZone = useSyncExternalStore(subscribeNothing, deps.deviceTimeZone, noZone);
  /** The tab this session last showed (sessionStorage; Ruling 2). */
  const [tab, setTab] = useState<HomeTab>(() => readHomeTab(userId));
  /** The Month's layout as this device remembers it (localStorage), read once. */
  const [savedLayout] = useState(() => readMonthLayout(userId));
  /** Where the Month is (month.ts); null until the first answer pins the facts. In browse, its month is where browse opens next. */
  const [monthUi, setMonthUi] = useState<MonthUi | null>(null);
  /** True until the Month is first left or changed: browse's first opening peeks at the month before (spec §7.4). */
  const [monthFresh, setMonthFresh] = useState(true);
  /** MonthBrowse's reports: the months near the screen, and the month under its bar. */
  const [near, setNear] = useState<readonly MonthKey[]>([]);
  const [inView, setInView] = useState<MonthKey | null>(null);
  const [held, setHeld] = useState<HeldFacts | null>(null);

  const facts = store.facts;
  const notices = homeNotices(store);
  const card: Card | null = blocked === 'disabled' ? 'disabled' : !facts && firstLoad ? firstLoad : null;
  const setupNeeded = calendarSource === 'GOOGLE' && (needsOAuth || needsCalendars);
  // Ruling 1: the tab bar shows only while a panel can show. Otherwise the home is D's:
  // the Agenda (or the card), with no tab bar; the remembered tab is left as it is.
  const tabsShown = card === null && blocked === null && !setupNeeded;
  const activeTab: HomeTab = tabsShown ? tab : 'agenda';

  // New facts (the first answer, a hebrewDates change, the next answer after a drop):
  // the Month holds them. When today moved (or on the first answer), the Month's UI
  // starts from the remembered layout while the Month hasn't been on screen yet (a
  // restored picked opens on today, browse on today's month), else it stays inside
  // the new window (clampMonthUi).
  if (facts && (held === null || held.facts !== facts || held.unavailable !== notices.unavailableCalendars)) {
    setHeld({ facts, unavailable: notices.unavailableCalendars });
    if (held === null || held.facts.today !== facts.today) {
      setMonthUi(monthUi === null || (monthFresh && activeTab !== 'month') ? initialMonthUi(savedLayout, facts.today) : clampMonthUi(monthUi, facts.today));
    }
  }

  // The loader reads the latest state through these; they are synced before it runs.
  const storeRef = useRef(store);
  const weeksRef = useRef(weeks);
  const blockedRef = useRef(blocked);
  const firstLoadRef = useRef(firstLoad);
  const monthRef = useRef<MonthWants>({ tab: activeTab, ui: monthUi, near, inView });
  const loaderRef = useRef<HomeLoader | null>(null);
  const resetFor = useRef<string | null>(null);
  useEffect(() => {
    storeRef.current = store;
    weeksRef.current = weeks;
    blockedRef.current = blocked;
    firstLoadRef.current = firstLoad;
    monthRef.current = { tab: activeTab, ui: monthUi, near, inView };
  });

  useEffect(() => {
    const loader = createHomeLoader({
      userId,
      sources: homeSources(calendarSource),
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
      },
      onNotEnabled: () => {
        // PageGate renders today's dashboard after the reload, which keeps Telegram's
        // BackButton and swipe setting: let both go first. If the guard says it already
        // reloaded, the card's Retry reloads by hand.
        if (!reloadOnce(NOT_ENABLED_RELOAD_KEY, Date.now(), releaseTelegramControls)) setBlocked('disabled');
      },
      setTimer: deps.setTimer,
      // The Month's windows while the Month is on screen (Ruling 7), most wanted first.
      getMonths: () => {
        const month = monthRef.current;
        const today = storeRef.current.facts?.today;
        return month.tab === 'month' && month.ui && today ? wantedMonths(month.ui, month.near, month.inView, today) : [];
      },
      agendaShowing: () => monthRef.current.tab === 'agenda',
    });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [userId, calendarSource, deps]);

  // Every visible window a source hasn't answered in this epoch: the first load, "Show
  // next week", the refetch after a drop, and the Month's windows as it comes on screen,
  // scrolls, or changes layout or month.
  useEffect(() => {
    loaderRef.current?.ensure();
  }, [store, weeks, blocked, firstLoad, activeTab, near, inView, monthUi]);

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
  // store as any other mismatch does.
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

  // The Month: the window around the held today, each month's model (memoized per store),
  // and the picked day's list.
  const heldToday = held?.facts.today ?? null;
  const months = useMemo(() => (heldToday ? monthSpan(heldToday) : []), [heldToday]);
  const getMonth = useMemo(() => monthModels(store), [store]);
  const monthShown = activeTab === 'month' && held !== null && monthUi !== null;
  const pickedShown = monthShown && monthUi?.layout === 'picked';
  const pickedDay = pickedShown ? (monthUi?.selected ?? null) : null;
  const pickedList = useMemo(() => (pickedDay ? { rows: dayRows(store, pickedDay), status: dayStatus(store, pickedDay) } : null), [store, pickedDay]);

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
    if (blockedRef.current === 'disabled') {
      try {
        window.location.reload();
      } catch {
        // The card stays.
      }
      return;
    }
    setFirstLoad(null);
  }, []);

  // A tab switch (Ruling 2): any sheet and the item sheet close; leaving browse keeps the
  // month in view for the next time; the Agenda opens at the top.
  const switchTab = (next: HomeTab) => {
    setSheet(null);
    setSelected(null);
    if (activeTab === 'month' && monthUi !== null && held !== null) {
      setMonthFresh(false);
      if (monthUi.layout === 'browse' && inView !== null && inView !== monthUi.month) setMonthUi({ ...monthUi, month: inView });
    }
    if (next === 'month') {
      setNear([]);
      setInView(null);
    }
    setTab(next);
    writeHomeTab(userId, next);
    if (next === 'agenda') scrollToTop();
  };
  // The Month's next UI (a day picked, a chevron, Today, "All months", the BackButton):
  // a layout change is remembered on this device, and browse comes back on its month.
  const changeUi = (next: MonthUi) => {
    if (monthUi === null || next === monthUi) return;
    setMonthUi(next);
    setMonthFresh(false);
    if (next.selected !== monthUi.selected) setSelected(null);
    if (next.layout !== monthUi.layout) {
      writeMonthLayout(userId, next.layout);
      if (next.layout === 'browse') {
        setNear([]);
        setInView(null);
      }
    }
  };

  // The one BackButton (§7.6): a tap closes the send or menu sheet, else the item sheet,
  // else takes picked back to browse.
  const itemOpen =
    selected !== null && (activeTab === 'agenda' ? blocked === null && card === null && agenda !== null && !setupNeeded : pickedShown);
  const back = () => {
    if (sheet !== null) setSheet(null);
    else if (itemOpen) setSelected(null);
    else if (pickedShown && monthUi !== null) changeUi(backToBrowse(monthUi));
  };
  useTelegramBackButton(itemOpen || pickedShown || (blocked !== 'noCredential' && sheet !== null), back);
  // Ruling 9: no swipe-down to minimize while the Month shows browse (its loading
  // included): there a drag down scrolls the months. The header and the tab bar stick
  // over browse at the same time.
  const monthLayout = monthUi?.layout ?? (savedLayout === 'picked' ? 'picked' : 'browse');
  const browsing = activeTab === 'month' && monthLayout === 'browse';
  useTelegramVerticalSwipes(browsing);

  // The Month's chunk, once the first answer is in and the tab bar shows, so the first
  // tap on Month rarely waits for it. A failed fetch is tried again by that tap.
  const monthPossible = tabsShown && facts !== null;
  useEffect(() => {
    if (monthPossible) loadMonthView().catch(() => {});
  }, [monthPossible]);

  if (blocked === 'noCredential') {
    return <NoCredentialCard look="telegram" inTelegram={inTelegram} links={CLIENT_GATE_LINKS} />;
  }

  const zone = facts && zoneDiffers(deviceZone, facts.tz) ? facts.tz : null;
  const agendaView = (
    <AgendaView
      agenda={agenda}
      hints={hints}
      setupNeeded={setupNeeded}
      selected={selected}
      onSelect={setSelected}
      onShowNextWeek={showNextWeek}
      onRetry={retrySource}
      onChooseCalendars={chooseCalendars}
    />
  );
  const monthView =
    monthShown && held !== null && monthUi !== null ? (
      <MonthView
        today={held.facts.today}
        tz={held.facts.tz}
        weekStart={held.facts.weekStart}
        hebrewDates={held.facts.hebrewDates}
        months={months}
        getMonth={getMonth}
        ui={monthUi}
        start={{ month: monthUi.month, peek: monthFresh }}
        dayRows={pickedList}
        unavailableCalendars={held.unavailable}
        selected={selected}
        onSelect={setSelected}
        onUi={changeUi}
        onNearMonths={setNear}
        onMonthInView={setInView}
        onRetryMonth={retryMonth}
        onChooseCalendars={chooseCalendars}
      />
    ) : (
      <MonthLoading />
    );

  return (
    <div className="ch-home" data-theme={scheme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <style>{HOME_THEME_CSS}</style>
      <style>{HOME_SHELL_CSS}</style>
      <style>{HOME_TOP_CSS}</style>
      <HomeTop sticky={browsing}>
        <HomeHeader
          today={facts?.today ?? null}
          hebrewDates={facts?.hebrewDates ?? false}
          zone={zone}
          sendOpen={sheet === 'send'}
          menuOpen={sheet === 'menu'}
          onSend={() => setSheet('send')}
          onMenu={() => setSheet('menu')}
        />
        {tabsShown ? <HomeTabs tab={tab} onTab={switchTab} /> : null}
      </HomeTop>
      <HomeBanners
        calendarSource={calendarSource}
        needsOAuth={needsOAuth}
        needsCalendars={needsCalendars}
        trialDaysLeft={trialDaysLeft}
        hasLocation={hasLocation}
        reconnect={notices.reconnect}
        inTelegram={inTelegram}
        userId={userId}
        locale={locale}
        onNavigate={navigate}
      />
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
      {sheet === 'menu' ? (
        <MenuSheet
          calendarSource={calendarSource}
          isAdmin={user.isAdmin}
          locale={locale}
          userId={userId}
          onNavigate={navigate}
          onRefresh={refresh}
          onClose={closeSheet}
        />
      ) : null}
    </div>
  );
}

export default function CalendarHome(props: CalendarHomeProps) {
  return (
    <HomeErrorBoundary>
      <CalendarHomeContainer {...props} />
    </HomeErrorBoundary>
  );
}
