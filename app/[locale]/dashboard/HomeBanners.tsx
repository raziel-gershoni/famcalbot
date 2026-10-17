'use client';

// The banners under the home's header (spec §7.2, §5 States), stacked and non-blocking,
// in this order:
// - trial days left, during a trial (→ Subscription);
// - "Set your location for the right times", when the server can't know the user's
//   timezone: no location, and no Google connection to read it from (→ Settings);
// - the Google setup card: Connect Google Calendar (no token), else Choose your
//   calendars (none chosen); Google users only;
// - Reconnect Google, once a Google answer in this epoch asked for it (it holds until the
//   store drops): a dead token, or missing permission (the scopes copy); never with the
//   Connect card, never for FamCal;
// - in a browser, "Open FamCal in Telegram" (WhatsApp stays secondary to Telegram).
// Each banner is one button (or, for Telegram, a link) with a 44 px or taller target.
// FamCal users never see a Google entry.

import { useTranslations } from 'next-intl';
import { DEFAULT_BOT_USERNAME } from '@/src/lib/gate-links';

export type BannerId = 'trial' | 'location' | 'connectGoogle' | 'chooseCalendars' | 'reconnect' | 'reconnectScopes' | 'openInTelegram';

export interface BannerFacts {
  calendarSource: 'GOOGLE' | 'NATIVE';
  needsOAuth: boolean;
  needsCalendars: boolean;
  /** Days left in a trial; null or absent: no trial banner. */
  trialDaysLeft?: number | null;
  /** false: no location set; absent: unknown, no location banner. */
  hasLocation?: boolean;
  /** A Google answer in this epoch asked for a reconnect (homeNotices: it holds until the store drops). */
  reconnect: 'token' | 'scopes' | null;
  /** readInitData() is non-empty. */
  inTelegram: boolean;
}

/** Which banners show, in order. */
export function homeBanners(f: BannerFacts): BannerId[] {
  const google = f.calendarSource === 'GOOGLE';
  const out: BannerId[] = [];
  if (typeof f.trialDaysLeft === 'number' && f.trialDaysLeft > 0) out.push('trial');
  if (f.hasLocation === false && (!google || f.needsOAuth)) out.push('location');
  if (google && f.needsOAuth) out.push('connectGoogle');
  else if (google && f.needsCalendars) out.push('chooseCalendars');
  if (google && !f.needsOAuth && f.reconnect) out.push(f.reconnect === 'scopes' ? 'reconnectScopes' : 'reconnect');
  if (!f.inTelegram) out.push('openInTelegram');
  return out;
}

/** The bot's /start connect link: it links a WhatsApp account to Telegram (telegram/commands.ts). */
export const OPEN_IN_TELEGRAM_URL = `https://t.me/${DEFAULT_BOT_USERNAME}?start=connect`;

export interface HomeBannersProps extends BannerFacts {
  /** The page's own user_id, as CalendarHomeProps carries it. */
  userId: number;
  locale: string;
  onNavigate: (href: string) => void;
}

type Tone = 'plain' | 'accent' | 'warn';

function BannerIcon({ id }: { id: BannerId }) {
  const common = { className: 'ch-banner-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false };
  switch (id) {
    case 'trial':
      return (
        <svg {...common}>
          <path d="M12 3l2.7 5.5 6 .9-4.3 4.2 1 6L12 16.8 6.6 19.6l1-6L3.3 9.4l6-.9z" />
        </svg>
      );
    case 'location':
      return (
        <svg {...common}>
          <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
          <circle cx="12" cy="9.5" r="2.5" />
        </svg>
      );
    case 'reconnect':
    case 'reconnectScopes':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.5v.01" />
        </svg>
      );
    case 'openInTelegram':
      return (
        <svg {...common} className="ch-banner-icon ch-flip">
          <path d="M22 2L11 13" />
          <path d="M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      );
  }
}

function Chevron() {
  return (
    <svg className="ch-banner-chevron ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function BannerContent({ id, title, body, action }: { id: BannerId; title: string; body?: string; action?: string }) {
  return (
    <>
      <BannerIcon id={id} />
      <span className="ch-banner-text">
        <span className="ch-banner-title">{title}</span>
        {body ? <span className="ch-banner-body">{body}</span> : null}
      </span>
      {action ? <span className="ch-banner-action">{action}</span> : <Chevron />}
    </>
  );
}

export function HomeBanners({ userId, locale, onNavigate, ...facts }: HomeBannersProps) {
  const t = useTranslations('calendarHome');
  const ids = homeBanners(facts);
  if (ids.length === 0) return null;

  const button = (id: BannerId, tone: Tone, href: string, title: string, body?: string, action?: string) => (
    <button key={id} type="button" className={`ch-banner ch-tap ch-banner-${tone}`} data-banner={id} onClick={() => onNavigate(href)}>
      <BannerContent id={id} title={title} body={body} action={action} />
    </button>
  );
  const page = (name: string) => `/${locale}/${name}?user_id=${userId}`;
  const refreshToken = `/refresh-token?user_id=${userId}`;

  return (
    <div className="ch-banners">
      {ids.map((id) => {
        switch (id) {
          case 'trial':
            return button(id, 'accent', page('subscription'), t('banner.trial', { count: facts.trialDaysLeft ?? 0 }), undefined, t('banner.trialAction'));
          case 'location':
            return button(id, 'plain', page('settings'), t('banner.location'), undefined, t('banner.locationAction'));
          case 'connectGoogle':
            return button(id, 'accent', refreshToken, t('banner.connectGoogle'), t('banner.connectGoogleBody'));
          case 'chooseCalendars':
            return button(id, 'accent', page('select-calendars'), t('banner.chooseCalendars'), t('banner.chooseCalendarsBody'));
          case 'reconnect':
            return button(id, 'warn', refreshToken, t('banner.reconnect'), t('banner.reconnectBody'), t('banner.reconnectAction'));
          case 'reconnectScopes':
            return button(id, 'warn', refreshToken, t('banner.reconnectScopes'), t('banner.reconnectScopesBody'), t('banner.reconnectAction'));
          case 'openInTelegram':
            return (
              <a key={id} className="ch-banner ch-tap ch-banner-telegram" data-banner={id} href={OPEN_IN_TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
                <BannerContent id={id} title={t('banner.openInTelegram')} body={t('banner.openInTelegramBody')} />
              </a>
            );
        }
      })}
    </div>
  );
}
