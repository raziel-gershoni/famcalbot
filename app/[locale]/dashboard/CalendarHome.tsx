'use client';

// The calendar home (spec §5, §7.1, §7.2; Rulings R5, R6, R8, R19): what /dashboard shows
// the users the rollout switch covers. PageGate renders it with CalendarHomeProps once
// page-data says calendarHome; everyone else keeps today's DashboardClient. Plan D has
// the Agenda only, with no tab bar.
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
//   the safe areas (./home-shell), the header, the banners, AgendaView (D5), and the
//   send and menu sheets;
// - Telegram's one BackButton (spec §7.6): shown while the item sheet, the Send sheet or
//   the ⋯ menu is open, and a tap closes that sheet (Android's back gesture too), so the
//   item sheet's selection lives here; before a reload (not_enabled, a chunk-load error)
//   the button is let go, since a reload runs no cleanup and the client keeps it;
// - a return to the foreground after the day has ended in tz (iOS suspends the midnight
//   timer with the app) drops the store at once, rather than asking for yesterday's
//   windows and labelling yesterday "Today" until they answer;
// - a Google user still setting up (needsOAuth, needsCalendars) gets the setup banner and
//   no Agenda under it (an Agenda with nothing chosen would only say "Nothing planned");
// - an error boundary around all of it; a chunk-load error reloads once.
//
// user.id is the page's own user_id (a Telegram id or a DB id), sent as it is to the
// range route and execute-command, which resolve it with verifyUserAuth. It is never
// swapped for another id.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { buildAgenda, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import { deviceTimeZone, homeSources, isPastDay, msUntilDayCheck, reloadOnce, zoneDiffers } from '@/src/lib/calendar-view/home-client';
import { createHomeLoader, type HomeLoader } from '@/src/lib/calendar-view/home-loader';
import type { CalendarHomeProps } from '@/src/lib/calendar-view/home-props';
import { emptyStore, homeNotices, reduceStore } from '@/src/lib/calendar-view/store';
import type { SourceName } from '@/src/lib/calendar-view/types';
import { DEFAULT_BOT_USERNAME, DEFAULT_WA_NUMBER, type GateLinks } from '@/src/lib/gate-links';
import { isInTelegram, onTelegramEvent, releaseTelegramBackButton, useTelegramBackButton, useTelegramTheme } from '@/src/lib/telegram-ui';
import { NoCredentialCard } from '../PageGate';
import { AgendaView } from './AgendaView';
import { HomeBanners } from './HomeBanners';
import { HomeErrorBoundary } from './HomeErrorBoundary';
import { HomeHeader } from './HomeHeader';
import { HOME_SHELL_CSS } from './home-shell';
import { HOME_THEME_CSS } from './home-theme';
import { MenuSheet } from './MenuSheet';
import { SendSheet } from './SendSheet';

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

export type CalendarHomeContainerProps = CalendarHomeProps & { deps?: Partial<HomeDeps> };

/** The home without its error boundary; `deps` lets a smoke drive the clock and the timers. */
export function CalendarHomeContainer({ deps: depsIn, ...props }: CalendarHomeContainerProps) {
  const { user, locale, calendarSource, needsOAuth, needsCalendars, hints, trialDaysLeft, hasLocation } = props;
  const userId = user.id;
  const router = useRouter();
  const scheme = useTelegramTheme();
  const [deps] = useState<HomeDeps>(() => ({ ...REAL_DEPS, ...depsIn }));
  const [store, dispatch] = useReducer(reduceStore, undefined, () => emptyStore());
  const [weeks, setWeeks] = useState(1);
  const [sheet, setSheet] = useState<'send' | 'menu' | null>(null);
  /** The row whose item sheet is open (AgendaView renders it; the BackButton here closes it). */
  const [selected, setSelected] = useState<AgendaRow | null>(null);
  const [firstLoad, setFirstLoad] = useState<'busy' | 'error' | null>(null);
  const [blocked, setBlocked] = useState<'noCredential' | 'disabled' | null>(null);
  const inTelegram = useSyncExternalStore(subscribeNothing, isInTelegram, assumeTelegram);
  const deviceZone = useSyncExternalStore(subscribeNothing, deps.deviceTimeZone, noZone);

  // The loader reads the latest state through these; they are synced before it runs.
  const storeRef = useRef(store);
  const weeksRef = useRef(weeks);
  const blockedRef = useRef(blocked);
  const firstLoadRef = useRef(firstLoad);
  const loaderRef = useRef<HomeLoader | null>(null);
  const resetFor = useRef<string | null>(null);
  useEffect(() => {
    storeRef.current = store;
    weeksRef.current = weeks;
    blockedRef.current = blocked;
    firstLoadRef.current = firstLoad;
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
        // BackButton: let it go first. If the guard says it already reloaded, the card's
        // Retry reloads by hand.
        if (!reloadOnce(NOT_ENABLED_RELOAD_KEY, Date.now(), releaseTelegramBackButton)) setBlocked('disabled');
      },
      setTimer: deps.setTimer,
    });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [userId, calendarSource, deps]);

  // Every visible window a source hasn't answered in this epoch: the first load, "Show
  // next week", and the refetch after a drop.
  useEffect(() => {
    loaderRef.current?.ensure();
  }, [store, weeks, blocked, firstLoad]);

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
  // server named; the loader then starts over.
  const tz = store.facts?.tz ?? null;
  const today = store.facts?.today ?? null;
  useEffect(() => {
    if (!tz || !today) return;
    let cancel = () => {};
    const arm = () => {
      cancel = deps.setTimer(() => {
        if (isPastDay(deps.now(), tz, today) && resetFor.current !== today) {
          resetFor.current = today;
          dispatch({ type: 'reset' });
          return;
        }
        arm();
      }, msUntilDayCheck(deps.now(), tz));
    };
    arm();
    return () => cancel();
  }, [tz, today, deps]);

  const agenda = useMemo(() => buildAgenda(store, weeks), [store, weeks]);
  const notices = homeNotices(store);
  // A store drop (midnight, other facts) empties the model, and the item sheet closes for
  // good, so it doesn't open again by itself when the new answer arrives.
  if (agenda === null && selected !== null) setSelected(null);

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

  const facts = store.facts;
  const card: Card | null = blocked === 'disabled' ? 'disabled' : !facts && firstLoad ? firstLoad : null;
  const setupNeeded = calendarSource === 'GOOGLE' && (needsOAuth || needsCalendars);
  // The one BackButton (§7.6): a tap closes the send or menu sheet, else the item sheet.
  const itemOpen = blocked === null && card === null && agenda !== null && selected !== null && !setupNeeded;
  const back = () => {
    if (sheet !== null) setSheet(null);
    else setSelected(null);
  };
  useTelegramBackButton(itemOpen || (blocked !== 'noCredential' && sheet !== null), back);

  if (blocked === 'noCredential') {
    return <NoCredentialCard look="telegram" inTelegram={inTelegram} links={CLIENT_GATE_LINKS} />;
  }

  const zone = facts && zoneDiffers(deviceZone, facts.tz) ? facts.tz : null;

  return (
    <div className="ch-home" data-theme={scheme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <style>{HOME_THEME_CSS}</style>
      <style>{HOME_SHELL_CSS}</style>
      <HomeHeader
        today={facts?.today ?? null}
        hebrewDates={facts?.hebrewDates ?? false}
        zone={zone}
        sendOpen={sheet === 'send'}
        menuOpen={sheet === 'menu'}
        onSend={() => setSheet('send')}
        onMenu={() => setSheet('menu')}
      />
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
      ) : (
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
      )}
      {sheet === 'send' ? <SendSheet userId={userId} locale={locale} onClose={closeSheet} /> : null}
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
