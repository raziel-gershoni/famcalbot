'use client';

// The banners under the home's header (spec §7.2, §5 States), stacked and non-blocking,
// in this order:
// - trial days left, during a trial (→ Subscription);
// - "Set your location for the right times", when the server can't know the user's
//   timezone: no location, and no Google connection to read it from (→ Settings);
// - Choose your calendars: a Google token with no calendars chosen;
// - Reconnect Google: a token cleared while calendars are stored (the page's state, since
//   the range read has no Google half then), or, once a Google answer in this epoch asked
//   for it (it holds until the store drops), a dead token or missing permission (the
//   scopes copy);
// - in a browser, "Open FamCal in Telegram", only for an account with no Telegram but a chat (WhatsApp stays
//   secondary to Telegram); an account that has Telegram already never sees it, and its link
//   starts WhatsApp linking;
// - in a browser, "Connect Telegram" (for reminders and briefings) for an account with no chat at all (6c-1), until it is
//   closed on this device (home-storage.ts). Its press asks for the one-time bot link (telegram-connect-client.ts); a sign-in
//   over an hour old turns it into "Sign in again to connect Telegram"; what came of it is a line under it.
//   While push is set up and this browser can show notifications (6c-2, pushBannerOf), it is "Get reminders on this device"
//   instead: Turn on (the Settings switch's flow, usePushDevice) or, on iPhone and iPad in a browser tab, the three Home Screen
//   steps, with Connect Telegram as its second action and the same close. It hides once this device is on (and while the open's
//   check is out); a browser that can't show notifications keeps Connect Telegram.
// Each banner is one button (or, for Telegram, a link) with a 44 px or taller target; Connect Telegram is two (its own and the
// close), Get reminders on this device three (Turn on, Connect Telegram, the close).
// Google is a connection beside FamCal (spec "Google as a connection" §2): a user who never
// connected sees no Google banner at all, and Connect Google lives in the ⋯ menu only.

import { useTranslations } from 'next-intl';
import { Bell, Loader2, Send, X } from 'lucide-react';
import { DEFAULT_BOT_USERNAME } from '@/src/lib/gate-links';
import type { GoogleState } from '@/src/lib/google-state';
import { connectButtonKey, connectLineKey, useTelegramConnect } from '@/src/lib/telegram-connect-client';
import { IosPushSteps } from '@/components/app-ui/IosPushSteps';
import { pushLineKey, type PushDevice } from '@/src/lib/use-push-device';
import type { PushProps } from '@/src/lib/web-push-client';

export type BannerId = 'trial' | 'location' | 'chooseCalendars' | 'reconnect' | 'reconnectScopes' | 'openInTelegram' | 'connectTelegram';

export interface BannerFacts {
  /** The page's Google state (googleStateOf). */
  googleState: GoogleState;
  /** A Google token is stored. */
  googleConnected: boolean;
  /** Days left in a trial; null or absent: no trial banner. */
  trialDaysLeft?: number | null;
  /** false: no location set; absent: unknown, no location banner. */
  hasLocation?: boolean;
  /** A Google answer in this epoch asked for a reconnect (homeNotices: it holds until the store drops). */
  reconnect: 'token' | 'scopes' | null;
  /** readInitData() is non-empty. */
  inTelegram: boolean;
  /** The account has a Telegram id. false: WhatsApp-only, who gets the Telegram banner in a browser. Absent means unknown: no banner. */
  hasTelegram?: boolean;
  /** false: no chat at all (made on famcal.bot): Connect Telegram in a browser. Absent: has one, as before. */
  hasChat?: boolean;
  /** This device closed the Connect Telegram banner for this account. */
  connectClosed?: boolean;
  /**
   * This device's notifications (6c-2, pushBannerOf): 'offer' turns Connect Telegram into "Get reminders on this device",
   * 'hidden' hides it (this device is on, or the open's check is out). Absent: Connect Telegram as before (push is off, or this
   * browser can't show notifications).
   */
  pushBanner?: 'offer' | 'hidden';
}

/** Which banners show, in order. */
export function homeBanners(f: BannerFacts): BannerId[] {
  const out: BannerId[] = [];
  if (typeof f.trialDaysLeft === 'number' && f.trialDaysLeft > 0) out.push('trial');
  // With a Google token the zone comes from Google; without one, only a location tells it.
  if (f.hasLocation === false && !f.googleConnected) out.push('location');
  if (f.googleState === 'choose') out.push('chooseCalendars');
  // A cleared token has no Google half in the read, so the page's state says it; otherwise a Google answer does.
  if (f.googleState === 'reconnect') out.push('reconnect');
  else if (f.googleState !== 'none' && f.reconnect) out.push(f.reconnect === 'scopes' ? 'reconnectScopes' : 'reconnect');
  if (!f.inTelegram && f.hasTelegram === false && f.hasChat !== false) out.push('openInTelegram');
  if (!f.inTelegram && f.hasChat === false && !f.connectClosed && f.pushBanner !== 'hidden') out.push('connectTelegram');
  return out;
}

/**
 * What this device's notifications make of the Connect Telegram banner (6c-2): nothing without push set up (no key) or where
 * this browser can't show them; hidden until the client has read the browser, while the open's check is out, and while this
 * device is on; else the offer (the iPhone steps as soon as they are known).
 */
export function pushBannerOf(push: PushProps | null | undefined, device: Pick<PushDevice, 'support' | 'phase'>): BannerFacts['pushBanner'] {
  if (!push?.key || device.support === 'unsupported') return undefined;
  if (device.support === 'ios-install') return 'offer';
  if (device.support === null || device.phase === 'checking' || device.phase === 'on' || device.phase === 'stopping') return 'hidden';
  return 'offer';
}

/** The bot's /start connect link: it links a WhatsApp account to Telegram (telegram/commands.ts). */
export const OPEN_IN_TELEGRAM_URL = `https://t.me/${DEFAULT_BOT_USERNAME}?start=connect`;

export interface HomeBannersProps extends BannerFacts {
  /** The page's own user_id, as CalendarHomeProps carries it. */
  userId: number;
  locale: string;
  onNavigate: (href: string) => void;
  /** Closes the Connect Telegram banner (the home remembers it on the device); absent: no close. */
  onCloseConnect?: () => void;
  /** This device's notifications (the home's usePushDevice), for "Get reminders on this device"; absent: Connect Telegram. */
  pushDevice?: PushDevice;
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

/**
 * Connect Telegram, for an account with no chat (6c-1): the banner's own button (the bot's one-time link, or Sign in again
 * after a stale sign-in) and its close, side by side in one banner; what came of a press is a line under it.
 */
function ConnectTelegramBanner({ userId, locale, onClose }: { userId: number; locale: string; onClose?: () => void }) {
  const t = useTranslations('calendarHome');
  const c = useTranslations('telegramConnect');
  const { phase, press } = useTelegramConnect(userId, locale);
  const working = phase === 'busy' || phase === 'leaving';
  const line = connectLineKey(phase);
  return (
    <>
      <div className="ch-banner ch-banner-telegram ch-banner-split" data-banner="connectTelegram">
        <button type="button" className="ch-banner-main ch-tap" disabled={working} aria-busy={working || undefined} onClick={press}>
          <Send className="ch-banner-icon ch-flip" aria-hidden="true" focusable="false" />
          <span className="ch-banner-text">
            <span className="ch-banner-title">{c(connectButtonKey(phase))}</span>
            <span className="ch-banner-body">{t('banner.connectTelegramBody')}</span>
          </span>
          {working ? <Loader2 className="ch-banner-chevron ch-spin" aria-hidden="true" focusable="false" /> : <Chevron />}
        </button>
        {onClose ? (
          <button type="button" className="ch-banner-close ch-tap" aria-label={t('banner.close')} onClick={onClose}>
            <X aria-hidden="true" focusable="false" />
          </button>
        ) : null}
      </div>
      {line ? (
        <p className={line.problem ? 'ch-banner-line is-problem' : 'ch-banner-line'} role={line.problem ? 'alert' : 'status'}>
          {c(line.key)}
        </p>
      ) : null}
    </>
  );
}

/**
 * Get reminders on this device (6c-2 §2.1): the icon, the words and the close on top; the iPhone steps under them in a browser
 * tab; then Turn on (or Sign in again, or "Tap again to allow") and Connect Telegram. What came of either press is a line under it.
 */
function PushBanner({ userId, locale, device, onClose }: { userId: number; locale: string; device: PushDevice; onClose?: () => void }) {
  const t = useTranslations('calendarHome');
  const s = useTranslations('settings');
  const c = useTranslations('telegramConnect');
  const connect = useTelegramConnect(userId, locale);
  const connecting = connect.phase === 'busy' || connect.phase === 'leaving';
  const connectLine = connectLineKey(connect.phase);
  const ios = device.support === 'ios-install';
  const stale = device.phase === 'stale' || device.phase === 'leaving';
  const working = device.phase === 'busy' || device.phase === 'leaving' || device.phase === 'stopping';
  const said = pushLineKey(device.line);
  const turnOnLabel = device.phase === 'busy' ? s('push.turningOn') : stale ? s('push.signInAgain') : device.line === 'again' ? s('push.again') : t('banner.pushAction');
  const spin = <Loader2 size={16} className="ch-spin" aria-hidden="true" focusable="false" />;
  return (
    <>
      <div className="ch-banner ch-banner-telegram ch-banner-push" data-banner="connectTelegram" data-push="offer">
        <div className="ch-banner-push-head">
          <Bell className="ch-banner-icon" aria-hidden="true" focusable="false" />
          <span className="ch-banner-text">
            <span className="ch-banner-title">{t('banner.pushTitle')}</span>
            <span className="ch-banner-body">{ios ? s('push.ios.body') : t('banner.pushBody')}</span>
          </span>
          {onClose ? (
            <button type="button" className="ch-banner-close ch-tap" aria-label={t('banner.close')} onClick={onClose}>
              <X aria-hidden="true" focusable="false" />
            </button>
          ) : null}
        </div>
        {ios ? <IosPushSteps className="ch-banner-steps" /> : null}
        <div className="ch-banner-push-actions">
          {ios ? null : (
            <button type="button" className="ch-btn ch-btn-primary" disabled={working} aria-busy={working || undefined} onClick={device.press}>
              {working ? spin : null}
              {turnOnLabel}
            </button>
          )}
          <button type="button" className="ch-btn" disabled={connecting} aria-busy={connecting || undefined} onClick={connect.press}>
            {connecting ? spin : null}
            {c(connectButtonKey(connect.phase))}
          </button>
        </div>
      </div>
      {said ? (
        <p className={said.problem ? 'ch-banner-line is-problem' : 'ch-banner-line'} role={said.problem ? 'alert' : 'status'}>
          {s(said.key)}
        </p>
      ) : null}
      {stale ? (
        <p className="ch-banner-line" role="status">
          {s('push.staleNote')}
        </p>
      ) : null}
      {connectLine ? (
        <p className={connectLine.problem ? 'ch-banner-line is-problem' : 'ch-banner-line'} role={connectLine.problem ? 'alert' : 'status'}>
          {c(connectLine.key)}
        </p>
      ) : null}
    </>
  );
}

export function HomeBanners({ userId, locale, onNavigate, onCloseConnect, pushDevice, ...facts }: HomeBannersProps) {
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
          case 'connectTelegram':
            return facts.pushBanner === 'offer' && pushDevice ? (
              <PushBanner key={id} userId={userId} locale={locale} device={pushDevice} onClose={onCloseConnect} />
            ) : (
              <ConnectTelegramBanner key={id} userId={userId} locale={locale} onClose={onCloseConnect} />
            );
        }
      })}
    </div>
  );
}
