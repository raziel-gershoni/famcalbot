'use client';

// The [locale] Mini App pages render no user data on the server. This gate loads it
// with one authenticated POST to /api/page-data (Telegram initData first; a WhatsApp
// magic-link session rides along as the same-origin cookie), then renders the page's
// own client component with the same props it always had. A locale mismatch becomes a
// router.replace, a notice renders the page's static notice, and 401/403/404 show the
// pageGate card instead of anyone's data, with a way back to the chat. The dashboard is
// the calendar home, inside its own chunk-load boundary. Every page is drawn in the app's own look (the home's tokens, no
// colour of ours on Telegram's chrome); Settings', Subscription's, Pair's, Calendars' and Select calendars' sit on the
// grouped ground.

import { Component, useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { notFound, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { StateCard } from '@/components/app-ui/StateCard';
import type { PageDataResult, PageName, PageNotice, PagePropsMap } from '@/src/lib/page-data';
import type { CalendarHomeProps } from '@/src/lib/calendar-view/home-props';
import type { GateLinks } from '@/src/lib/gate-links';
import { enableTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { readInitData } from '@/src/lib/read-init-data';
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';

/**
 * What a page's own screen is drawn on, where it is not the plain ground: Settings', Subscription's, Pair's, Calendars' and
 * Select calendars' cards sit on the secondary one. Their loader takes the same, so Telegram's header and the page do not change colour when the
 * page arrives. The gate's and the error's cards are a different screen and stay plain.
 */
type Ground = 'grouped';
const GROUND: Partial<Record<PageName, Ground>> = {
  settings: 'grouped',
  subscription: 'grouped',
  pair: 'grouped',
  calendars: 'grouped',
  'select-calendars': 'grouped',
};

/** The loader: the home's own background, one spinner and the loading text for a screen reader (on the ground its page is drawn on). Exported for the dashboard's redirect, which shows the dashboard's own. */
export function PageLoader({ label, ground }: { label?: string; ground?: Ground }) {
  const t = useTranslations('pageGate');
  return (
    <AppScreen ground={ground}>
      <div className="ch-loader" role="status">
        <Loader2 size={32} className="ch-spin" aria-hidden="true" />
        <span className="ch-visually-hidden">{label ?? t('loading')}</span>
      </div>
    </AppScreen>
  );
}

/**
 * Full height and the page's Telegram chrome at once, not after the data round trip. ready() and expand()
 * are idempotent. The page sets no colour of its own: its AppScreen takes the theme's bg_color for Telegram's header and
 * background (secondary_bg_color in a light theme for a grouped screen, whose loader is grouped too).
 */
export function startMiniApp() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tg.ready();
  tg.expand();
  // A reload keeps swipes off if the page before it (Month browse) turned them off
  enableTelegramVerticalSwipes();
}

const appLoader = () => <PageLoader />;
const groupedAppLoader = () => <PageLoader ground="grouped" />;

// Each page's existing client component, loaded only once its data has arrived.
// The calendar home (spec §7.1), behind the dashboard's own loader; it applies its look on mount.
const CalendarHome = dynamic(() => import('./dashboard/CalendarHome'), { loading: appLoader });
const Settings = dynamic(() => import('./settings/SettingsClient'), { loading: groupedAppLoader });
const SelectCalendars = dynamic(() => import('./select-calendars/SelectCalendarsClient'), { loading: groupedAppLoader });
const Subscription = dynamic(() => import('./subscription/SubscriptionClient'), { loading: groupedAppLoader });
const Calendars = dynamic(() => import('./calendars/CalendarsClient'), { loading: groupedAppLoader });
const Pair = dynamic(() => import('./pair/PairClient'), { loading: groupedAppLoader });

/** Starts fetching a page's chunk while its data is in flight. */
const PRELOAD: Record<PageName, () => Promise<unknown>> = {
  dashboard: () => import('./dashboard/CalendarHome'),
  settings: () => import('./settings/SettingsClient'),
  'select-calendars': () => import('./select-calendars/SelectCalendarsClient'),
  subscription: () => import('./subscription/SubscriptionClient'),
  calendars: () => import('./calendars/CalendarsClient'),
  pair: () => import('./pair/PairClient'),
};

const FAMCAL_ONLY: CalendarHomeProps['sources'] = ['famcal'];

/**
 * The calendar home's props from the dashboard's (spec §7.1). user.id stays the page's
 * ?user_id. The trial's days left show only for a trialing user who isn't an early
 * adopter, and hasLocation feeds the location banner (spec §7.2).
 */
function calendarHomeProps(p: PagePropsMap['dashboard']): CalendarHomeProps {
  return {
    user: { id: p.user.id, name: p.user.name, isAdmin: p.user.isAdmin },
    locale: p.locale,
    sources: p.sources ?? FAMCAL_ONLY,
    googleConnected: p.googleConnected ?? false,
    googleState: p.googleState ?? 'none',
    hints: p.hints,
    trialDaysLeft: !p.isEarlyAdopter && p.trial.isTrialing && p.trial.daysRemaining > 0 ? p.trial.daysRemaining : null,
    hasLocation: Boolean(p.user.location),
    lookahead7: p.lookahead7,
    jewish: p.jewish === true,
  };
}

/** The JSON props back in the shapes the client components take (Date, Set, Map). Exported for the smokes. */
export function renderPage(page: PageName, props: PagePropsMap[PageName]) {
  switch (page) {
    case 'dashboard':
      return (
        <HomeChunkBoundary>
          <CalendarHome {...calendarHomeProps(props as PagePropsMap['dashboard'])} />
        </HomeChunkBoundary>
      );
    case 'settings':
      return <Settings {...(props as PagePropsMap['settings'])} />;
    case 'select-calendars': {
      const p = props as PagePropsMap['select-calendars'];
      const sel = p.currentSelections;
      return (
        <SelectCalendars
          {...p}
          currentSelections={{
            ...sel,
            selectedCalendars: new Set(sel.selectedCalendars),
            calendarLabels: new Map(sel.calendarLabels.map(([id, labels]) => [id, new Set(labels)])),
            calendarRules: new Map(sel.calendarRules),
          }}
        />
      );
    }
    case 'subscription':
      return <Subscription {...(props as PagePropsMap['subscription'])} />;
    case 'calendars':
      return <Calendars {...(props as PagePropsMap['calendars'])} />;
    case 'pair':
      return <Pair {...(props as PagePropsMap['pair'])} />;
  }
}

function reloadPage() {
  try {
    window.location.reload();
  } catch {
    // The card stays.
  }
}

/** A calendar home that didn't load: the gate's error card, whose button reloads the page. */
function HomeLoadFailed() {
  const t = useTranslations('pageGate');
  return <Gate title={t('errorTitle')} body={t('errorBody')} actions={[{ label: t('retry'), primary: true, onClick: reloadPage }]} />;
}

/**
 * Around the calendar home's chunk (spec §5). The home's own boundary lives inside that
 * chunk, so it can't catch the chunk itself failing to load, for example after a deploy
 * lands between the HTML and the chunk's fetch. A chunk-load error reloads the page once,
 * with the home's guard key (so the two boundaries reload once between them), behind the
 * loader; within the guard, or for any other error, the gate's error card, whose button
 * reloads. Never an empty tree. Exported for the smokes.
 */
export class HomeChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean; reloading: boolean }> {
  state = { failed: false, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown) {
    console.error('[calendar-home] The home did not load:', error);
    if (isChunkLoadError(error) && !reloadOnce(CHUNK_RELOAD_KEY)) this.setState({ reloading: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return this.state.reloading ? <PageLoader /> : <HomeLoadFailed />;
  }
}

interface GateActionSpec {
  label: string;
  /** The filled one: the card's main way on. */
  primary?: boolean;
  href?: string;
  onClick?: () => void;
}

/** A gate's card: the app's StateCard inside its own screen. The first action is its filled one, the second its quieter one. */
function Gate({ title, body, actions }: { title: string; body: string; actions: GateActionSpec[] }) {
  const [first, second] = actions;
  return (
    <AppScreen>
      <StateCard tone="crash" title={title} body={body} action={first} secondary={second} />
    </AppScreen>
  );
}

/**
 * The card for a page nobody has proved they may see. Inside Telegram the chat's buttons
 * reopen it with fresh initData, so it closes the Mini App. In a browser it leads with
 * WhatsApp ("settings" brings a fresh magic link); a WhatsApp-only user who tapped the
 * Telegram link would get a second, unlinked account from /start, so that link comes
 * second and says who it is for.
 */
export function NoCredentialCard({ inTelegram, links }: { inTelegram: boolean; links: GateLinks }) {
  const t = useTranslations('pageGate');
  if (inTelegram) {
    return (
      <Gate
        title={t('telegramTitle')}
        body={t('telegramBody')}
        actions={[{ label: t('close'), primary: true, onClick: () => window.Telegram?.WebApp?.close() }]}
      />
    );
  }
  return (
    <Gate
      title={t('browserTitle')}
      body={t('browserBody')}
      actions={[
        { label: t('openWhatsApp'), primary: true, href: links.whatsapp },
        { label: t('openTelegram'), href: links.telegram },
      ]}
    />
  );
}

type Outcome =
  | { key: string; kind: 'data'; data: PageDataResult }
  | { key: string; kind: 'gate'; inTelegram: boolean }
  | { key: string; kind: 'error' };

interface PageGateProps {
  page: PageName;
  /** The page's ?user_id, as the client components have always received it. */
  userId: number;
  locale: string;
  /** The page's static notices (no user data), shown when the server picks one. */
  notices?: Partial<Record<PageNotice, ReactNode>>;
  /** Where the no-credential card sends someone (gateLinks(), from the server's env). */
  links: GateLinks;
}

export default function PageGate({ page, userId, locale, notices = {}, links }: PageGateProps) {
  const t = useTranslations('pageGate');
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // A result belongs to one request; a new page, user, locale or retry shows the loader.
  const key = `${page}|${userId}|${locale}|${attempt}`;

  // Declared before the data effect, so it runs in the hydration commit, before the fetch
  useEffect(() => {
    startMiniApp();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initData = readInitData();
    PRELOAD[page]().catch(() => undefined);

    (async () => {
      let next: Outcome;
      try {
        const res = await fetch('/api/page-data', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page, user_id: userId, locale, initData }),
        });
        if (res.ok) {
          next = { key, kind: 'data', data: (await res.json()) as PageDataResult };
        } else if (res.status === 401 || res.status === 403 || res.status === 404) {
          next = { key, kind: 'gate', inTelegram: Boolean(initData) };
        } else {
          next = { key, kind: 'error' };
        }
      } catch (error) {
        console.error(`[PageGate] ${page}:`, error);
        next = { key, kind: 'error' };
      }
      if (cancelled) return;

      if (next.kind === 'data' && next.data.kind === 'redirect') {
        const to = next.data.to;
        // Only an app path; the loader stays up while the router moves on
        if (to.startsWith('/') && !to.startsWith('//')) {
          router.replace(to);
          return;
        }
        next = { key, kind: 'error' };
      }
      setOutcome(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [key, page, userId, locale, router]);

  if (!outcome || outcome.key !== key) {
    return <PageLoader label={t('loading')} ground={GROUND[page]} />;
  }

  const errorCard = (
    <Gate title={t('errorTitle')} body={t('errorBody')} actions={[{ label: t('retry'), primary: true, onClick: () => setAttempt((n) => n + 1) }]} />
  );

  if (outcome.kind === 'error') return errorCard;

  if (outcome.kind === 'gate') {
    return <NoCredentialCard inTelegram={outcome.inTelegram} links={links} />;
  }

  const data = outcome.data;
  switch (data.kind) {
    case 'props':
      return renderPage(page, data.props);
    case 'notice': {
      const notice = notices[data.notice];
      if (notice === undefined) return errorCard;
      return <>{notice}</>;
    }
    case 'notFound':
      // As the page's own notFound() did: the app's 404
      return notFound();
    case 'redirect':
      // Handled in the effect; the router is already moving on
      return <PageLoader label={t('loading')} ground={GROUND[page]} />;
  }
}
