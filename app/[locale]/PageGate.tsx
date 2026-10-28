'use client';

// The [locale] Mini App pages render no user data on the server. This gate loads it
// with one authenticated POST to /api/page-data (Telegram initData first; a WhatsApp
// magic-link session rides along as the same-origin cookie), then renders the page's
// own client component with the same props it always had. A locale mismatch becomes a
// router.replace, a notice renders the page's static notice, and 401/403/404 show the
// pageGate card instead of anyone's data, with a way back to the chat. The dashboard is
// the calendar home, inside its own chunk-load boundary. Each page has a look: the dashboard's,
// Settings', Subscription's and Pair's are the app's own ('app': the home's tokens, no colour of ours on
// Telegram's chrome), and the other pages keep the purple gradient (select-calendars) or the light
// card (calendars) until a later plan moves them.

import { Component, useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { notFound, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { StateCard } from '@/components/app-ui/StateCard';
import type { PageDataResult, PageName, PageNotice, PagePropsMap } from '@/src/lib/page-data';
import type { CalendarHomeProps } from '@/src/lib/calendar-view/home-props';
import type { GateLinks } from '@/src/lib/gate-links';
import { enableTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { readInitData } from '@/src/lib/read-init-data';
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';

/** The look of each page: the app's own, the purple Telegram gradient, or the light Tailwind one. */
export type Look = 'app' | 'telegram' | 'light';
const LOOK: Record<PageName, Look> = {
  dashboard: 'app',
  settings: 'app',
  'select-calendars': 'telegram',
  subscription: 'app',
  calendars: 'light',
  pair: 'app',
};

/**
 * What a page's own screen is drawn on, where it is not the plain ground: Settings', Subscription's and Pair's cards sit on
 * the secondary one. Their loader takes the same, so Telegram's header and the page do not change colour when the
 * page arrives. The gate's and the error's cards are a different screen and stay plain.
 */
type Ground = 'grouped';
const GROUND: Partial<Record<PageName, Ground>> = {
  settings: 'grouped',
  subscription: 'grouped',
  pair: 'grouped',
};

/** The app's loader: the home's own background, one spinner and the loading text for a screen reader. */
function AppLoader({ label, ground }: { label?: string; ground?: Ground }) {
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

/** The loader of a look (and, in the app's, of the ground its page is drawn on). Exported for the dashboard's redirect, which shows the dashboard's own. */
export function PageLoader({ look, label, ground }: { look: Look; label?: string; ground?: Ground }) {
  if (look === 'app') return <AppLoader label={label} ground={ground} />;
  if (look === 'light') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-50 p-6">
        <Loader2 size={40} className="animate-spin text-indigo-400" aria-label={label} />
      </div>
    );
  }
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    }}>
      <div style={{ color: 'white', animation: 'pagegate-spin 1s linear infinite', display: 'flex' }}>
        <Loader2 size={48} aria-label={label} />
      </div>
      <style>{`
        @keyframes pagegate-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/**
 * Full height and the page's Telegram chrome at once, not after the data round trip.
 * The old pages' TelegramLayout repeats these later; ready() and expand() are idempotent.
 * Some WebApp versions throw on a hex colour, and a throw here would replace the gate.
 * The purple page sets its purple header and background. The app's look sets no colour of
 * its own: its AppScreen takes the theme's bg_color for Telegram's header and background
 * (secondary_bg_color in a light theme for a grouped screen, whose loader is grouped too).
 */
export function startMiniApp(look: Look) {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tg.ready();
  tg.expand();
  if (look === 'light') return;
  if (look === 'telegram') {
    try {
      tg.setHeaderColor('#667eea');
    } catch (e) {
      console.error('[PageGate] Could not set the header colour:', e);
    }
    try {
      tg.setBackgroundColor('#ffffff');
    } catch (e) {
      console.error('[PageGate] Could not set the background colour:', e);
    }
  }
  // A reload keeps swipes off if the page before it (Month browse) turned them off
  enableTelegramVerticalSwipes();
}

const appLoader = () => <PageLoader look="app" />;
const groupedAppLoader = () => <PageLoader look="app" ground="grouped" />;
const telegramLoader = () => <PageLoader look="telegram" />;
const lightLoader = () => <PageLoader look="light" />;

// Each page's existing client component, loaded only once its data has arrived.
// The calendar home (spec §7.1), behind the dashboard's own loader; it applies its look on mount.
const CalendarHome = dynamic(() => import('./dashboard/CalendarHome'), { loading: appLoader });
const Settings = dynamic(() => import('./settings/SettingsClient'), { loading: groupedAppLoader });
const SelectCalendars = dynamic(() => import('./select-calendars/SelectCalendarsClient'), { loading: telegramLoader });
const Subscription = dynamic(() => import('./subscription/SubscriptionClient'), { loading: groupedAppLoader });
const Calendars = dynamic(() => import('./calendars/CalendarsClient'), { loading: lightLoader });
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
  return <Gate look="app" title={t('errorTitle')} body={t('errorBody')} actions={[{ label: t('retry'), primary: true, onClick: reloadPage }]} />;
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
    return this.state.reloading ? <PageLoader look="app" /> : <HomeLoadFailed />;
  }
}

function GateCard({ look, title, lines, action }: { look: Look; title: string; lines: string[]; action?: ReactNode }) {
  if (look === 'light') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-50 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center">
          <div className="mb-4 flex justify-center"><AlertTriangle size={48} className="text-amber-500" /></div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">{title}</h1>
          {lines.map((line) => (
            <p key={line} className="text-gray-600 text-sm mt-2">{line}</p>
          ))}
          {action}
        </div>
      </div>
    );
  }
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      padding: '20px'
    }}>
      <div style={{
        background: 'white',
        padding: '40px',
        borderRadius: '15px',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        textAlign: 'center',
        maxWidth: '400px'
      }}>
        <div style={{ marginBottom: '20px' }}><AlertTriangle size={64} color="#f59e0b" /></div>
        <h1 style={{ color: '#333', margin: '0 0 10px 0', fontSize: '22px' }}>{title}</h1>
        {lines.map((line) => (
          <p key={line} style={{ color: '#666', marginTop: '10px' }}>{line}</p>
        ))}
        {action}
      </div>
    </div>
  );
}

interface GateActionSpec {
  label: string;
  /** The filled one: the card's main way on. */
  primary?: boolean;
  href?: string;
  onClick?: () => void;
}

/**
 * A gate's card in the page's look: the app's StateCard inside its own screen, or the
 * purple and the light pages' card. The first action is the app card's filled one, the
 * second its quieter one.
 */
function Gate({ look, title, body, actions }: { look: Look; title: string; body: string; actions: GateActionSpec[] }) {
  if (look === 'app') {
    const [first, second] = actions;
    return (
      <AppScreen>
        <StateCard tone="crash" title={title} body={body} action={first} secondary={second} />
      </AppScreen>
    );
  }
  return (
    <GateCard
      look={look}
      title={title}
      lines={[body]}
      action={
        <GateActions look={look}>
          {actions.map((a) => (
            <GateAction key={a.label} look={look} primary={a.primary} href={a.href} onClick={a.onClick}>
              {a.label}
            </GateAction>
          ))}
        </GateActions>
      }
    />
  );
}

/** A gate card's actions, stacked under its text. */
function GateActions({ look, children }: { look: Look; children: ReactNode }) {
  return look === 'light'
    ? <div className="mt-6 space-y-3">{children}</div>
    : <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>{children}</div>;
}

/** One action: a link when it has an href, else a button. The primary one is filled. */
function GateAction({ look, primary = false, href, onClick, children }: {
  look: Look;
  primary?: boolean;
  href?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const className = look === 'light'
    ? `block w-full font-medium py-3 rounded-xl ${primary ? 'bg-indigo-600 text-white' : 'bg-white text-indigo-700 border border-indigo-200'}`
    : undefined;
  const style = look === 'light' ? undefined : {
    display: 'block',
    boxSizing: 'border-box' as const,
    width: '100%',
    padding: '12px',
    border: primary ? 'none' : '1px solid #667eea',
    borderRadius: '12px',
    background: primary ? '#667eea' : 'white',
    color: primary ? 'white' : '#667eea',
    fontSize: '16px',
    fontWeight: 500,
    textAlign: 'center' as const,
    textDecoration: 'none',
    cursor: 'pointer',
  };
  if (href) {
    return <a href={href} className={className} style={style}>{children}</a>;
  }
  return <button type="button" onClick={onClick} className={className} style={style}>{children}</button>;
}

/**
 * The card for a page nobody has proved they may see. Inside Telegram the chat's buttons
 * reopen it with fresh initData, so it closes the Mini App. In a browser it leads with
 * WhatsApp ("settings" brings a fresh magic link); a WhatsApp-only user who tapped the
 * Telegram link would get a second, unlinked account from /start, so that link comes
 * second and says who it is for.
 */
export function NoCredentialCard({ look, inTelegram, links }: { look: Look; inTelegram: boolean; links: GateLinks }) {
  const t = useTranslations('pageGate');
  if (inTelegram) {
    return (
      <Gate
        look={look}
        title={t('telegramTitle')}
        body={t('telegramBody')}
        actions={[{ label: t('close'), primary: true, onClick: () => window.Telegram?.WebApp?.close() }]}
      />
    );
  }
  return (
    <Gate
      look={look}
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
    startMiniApp(LOOK[page]);
  }, [page]);

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

  const look = LOOK[page];

  if (!outcome || outcome.key !== key) {
    return <PageLoader look={look} label={t('loading')} ground={GROUND[page]} />;
  }

  const errorCard = (
    <Gate look={look} title={t('errorTitle')} body={t('errorBody')} actions={[{ label: t('retry'), primary: true, onClick: () => setAttempt((n) => n + 1) }]} />
  );

  if (outcome.kind === 'error') return errorCard;

  if (outcome.kind === 'gate') {
    return <NoCredentialCard look={look} inTelegram={outcome.inTelegram} links={links} />;
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
      return <PageLoader look={look} label={t('loading')} ground={GROUND[page]} />;
  }
}
