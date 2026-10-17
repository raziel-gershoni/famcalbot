'use client';

// The [locale] Mini App pages render no user data on the server. This gate loads it
// with one authenticated POST to /api/page-data (Telegram initData first; a WhatsApp
// magic-link session rides along as the same-origin cookie), then renders the page's
// own client component with the same props it always had. A locale mismatch becomes a
// router.replace, a notice renders the page's static notice, and 401/403/404 show the
// pageGate card instead of anyone's data, with a way back to the chat. The dashboard has
// two homes: the props' calendarHome picks CalendarHome (the users the calendar home's
// rollout switch covers), inside its own chunk-load boundary, or today's DashboardClient.

import { Component, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { notFound, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { PageDataResult, PageName, PageNotice, PagePropsMap } from '@/src/lib/page-data';
import type { CalendarHomeProps, HomeHints } from '@/src/lib/calendar-view/home-props';
import type { GateLinks } from '@/src/lib/gate-links';
import { readInitData } from '@/src/lib/read-init-data';
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';

/** The look each page already has: the purple Telegram gradient, or the light Tailwind one. */
export type Look = 'telegram' | 'light';
const LOOK: Record<PageName, Look> = {
  dashboard: 'telegram',
  settings: 'telegram',
  'select-calendars': 'telegram',
  subscription: 'telegram',
  calendars: 'light',
  pair: 'light',
};

function PageLoader({ look, label }: { look: Look; label?: string }) {
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
 * The page's TelegramLayout repeats these later; ready() and expand() are idempotent.
 * Some WebApp versions throw on a hex colour, and a throw here would replace the gate.
 */
export function startMiniApp(look: Look) {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tg.ready();
  tg.expand();
  if (look !== 'telegram') return;
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

const telegramLoader = () => <PageLoader look="telegram" />;
const lightLoader = () => <PageLoader look="light" />;

// Each page's existing client component, loaded only once its data has arrived.
const Dashboard = dynamic(() => import('./dashboard/DashboardClient'), { loading: telegramLoader });
// The calendar home (spec §7.1), behind the dashboard's own loader; it applies its look on mount.
const CalendarHome = dynamic(() => import('./dashboard/CalendarHome'), { loading: telegramLoader });
const Settings = dynamic(() => import('./settings/SettingsClient'), { loading: telegramLoader });
const SelectCalendars = dynamic(() => import('./select-calendars/SelectCalendarsClient'), { loading: telegramLoader });
const Subscription = dynamic(() => import('./subscription/SubscriptionClient'), { loading: telegramLoader });
const Calendars = dynamic(() => import('./calendars/CalendarsClient'), { loading: lightLoader });
const Pair = dynamic(() => import('./pair/PairClient'), { loading: lightLoader });

/** Starts fetching a page's chunk while its data is in flight. */
const PRELOAD: Record<PageName, () => Promise<unknown>> = {
  // Only the data says which home the dashboard shows, so both start loading
  dashboard: () => Promise.all([import('./dashboard/DashboardClient'), import('./dashboard/CalendarHome')]),
  settings: () => import('./settings/SettingsClient'),
  'select-calendars': () => import('./select-calendars/SelectCalendarsClient'),
  subscription: () => import('./subscription/SubscriptionClient'),
  calendars: () => import('./calendars/CalendarsClient'),
  pair: () => import('./pair/PairClient'),
};

/**
 * The calendar home's props from the dashboard's (spec §7.1). user.id stays the page's
 * ?user_id, exactly as DashboardClient gets it. page-data always sends hints with
 * calendarHome; without them no hint is promised (Ruling R10). The trial's days left follow
 * the old home's trial line, and hasLocation feeds the location banner (spec §7.2).
 */
function calendarHomeProps(
  p: Omit<PagePropsMap['dashboard'], 'calendarHome' | 'hints'>,
  hints: HomeHints | undefined
): CalendarHomeProps {
  return {
    user: { id: p.user.id, name: p.user.name, isAdmin: p.user.isAdmin },
    locale: p.locale,
    calendarSource: p.calendarSource ?? 'NATIVE',
    needsOAuth: p.needsOAuth,
    needsCalendars: p.needsCalendars,
    hints: hints ?? { reminders: false, voiceEvents: false },
    trialDaysLeft: !p.isEarlyAdopter && p.trial.isTrialing && p.trial.daysRemaining > 0 ? p.trial.daysRemaining : null,
    hasLocation: Boolean(p.user.location),
  };
}

/** The JSON props back in the shapes the client components take (Date, Set, Map). Exported for the smokes. */
export function renderPage(page: PageName, props: PagePropsMap[PageName]) {
  switch (page) {
    case 'dashboard': {
      // calendarHome picks the home; DashboardClient gets exactly the props it always had
      const { calendarHome, hints, ...p } = props as PagePropsMap['dashboard'];
      if (calendarHome) {
        return (
          <HomeChunkBoundary>
            <CalendarHome {...calendarHomeProps(p, hints)} />
          </HomeChunkBoundary>
        );
      }
      return <Dashboard {...p} trial={{ ...p.trial, trialEndsAt: p.trial.trialEndsAt ? new Date(p.trial.trialEndsAt) : null }} />;
    }
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
  return (
    <GateCard
      look="telegram"
      title={t('errorTitle')}
      lines={[t('errorBody')]}
      action={
        <GateActions look="telegram">
          <GateAction look="telegram" primary onClick={reloadPage}>{t('retry')}</GateAction>
        </GateActions>
      }
    />
  );
}

/**
 * Around the calendar home's chunk (spec §5). The home's own boundary lives inside that
 * chunk, so it can't catch the chunk itself failing to load, for example after a deploy
 * lands between the HTML and the chunk's fetch. A chunk-load error reloads the page once,
 * with the home's guard key (so the two boundaries reload once between them), behind the
 * loader; within the guard, or for any other error, the gate's error card, whose button
 * reloads. Never an empty tree. Only the users the switch covers render it. Exported for
 * the smokes.
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
    return this.state.reloading ? <PageLoader look="telegram" /> : <HomeLoadFailed />;
  }
}

const NoticeDetailContext = createContext<string | null>(null);

/** Inside a page's static notice: the server's detail for it (the error message), else `fallback`. */
export function NoticeDetail({ fallback }: { fallback: string }) {
  return <>{useContext(NoticeDetailContext) ?? fallback}</>;
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
      <GateCard
        look={look}
        title={t('telegramTitle')}
        lines={[t('telegramBody')]}
        action={
          <GateActions look={look}>
            <GateAction look={look} primary onClick={() => window.Telegram?.WebApp?.close()}>{t('close')}</GateAction>
          </GateActions>
        }
      />
    );
  }
  return (
    <GateCard
      look={look}
      title={t('browserTitle')}
      lines={[t('browserBody')]}
      action={
        <GateActions look={look}>
          <GateAction look={look} primary href={links.whatsapp}>{t('openWhatsApp')}</GateAction>
          <GateAction look={look} href={links.telegram}>{t('openTelegram')}</GateAction>
        </GateActions>
      }
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
    return <PageLoader look={look} label={t('loading')} />;
  }

  const errorCard = (
    <GateCard
      look={look}
      title={t('errorTitle')}
      lines={[t('errorBody')]}
      action={
        <GateActions look={look}>
          <GateAction look={look} primary onClick={() => setAttempt((n) => n + 1)}>{t('retry')}</GateAction>
        </GateActions>
      }
    />
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
      return <NoticeDetailContext.Provider value={data.detail ?? null}>{notice}</NoticeDetailContext.Provider>;
    }
    case 'notFound':
      // As the page's own notFound() did: the app's 404
      return notFound();
    case 'redirect':
      // Handled in the effect; the router is already moving on
      return <PageLoader look={look} label={t('loading')} />;
  }
}
