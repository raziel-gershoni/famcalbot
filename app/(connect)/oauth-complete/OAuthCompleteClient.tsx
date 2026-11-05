'use client';

// /oauth-complete in the app's design (plan W4-3): one more tap to finish connecting Google, here in this browser (web
// sign-up spec §2.10, §3.10) or in Telegram or WhatsApp. It always opens in a browser (after Google's consent), so its
// look follows the browser's light or dark.
//
// - Before the fragment is read (the server's render and the first paint), and while the page asks whether this browser
//   is signed in as the account that started the consent (POST /api/oauth/claim { token, peek: true }), the app's
//   loader, never an empty card.
// - Ready: an AppScreen on the grouped ground (the owner line is a notice on a card): a success icon, the title and the
//   subtitle, the owner line ({name} through next-intl); then Finish here (the primary) when this browser is that account,
//   and the buttons the fragment's b= allows: Finish in Telegram (the primary when there is no Finish here, else
//   outlined), Finish in WhatsApp (outlined beside Telegram or under Finish here, else the primary) with its hint under it.
// - Finish here posts the id (POST /api/oauth/claim, this site and JSON); the server commits it only for that account and
//   names the page to go to (this site only). A refusal says why in an error notice and takes Finish here away (the
//   connection is used up, or this browser's sign-in ended); a request that never reached the server keeps it.
// - Not that account and no chat button (an account made on famcal.bot, in a browser not signed in as it): Sign in to
//   finish, with Sign in.
// - This browser is that account but its sign-in is over an hour old (6c-1 follow-ups; the check answers stale: true, and
//   Finish here is refused 403 stale-sign-in with the connection kept for the chat buttons): with no chat button, the
//   stale card, "Sign in again first" with a Sign in again button (a plain /signin link would send a browser that still
//   holds its cookie straight back to its calendar, so the press signs out first: sign-in-again.ts); a refused Finish here
//   says so in its notice with the same action and takes Finish here away. A sign-out that fails (Sign in again does
//   not leave) says so in an error line (hereNetwork) and keeps the action. A WhatsApp link's session (the check and the
//   refusal say whatsapp: true) has no web way to sign in again with: the card and the notice show the WhatsApp hint
//   (pageGate.browserBody, a fresh link from the chat) in place of Sign in again, as Settings does.
// - A fragment that is missing or bad: the kit's state card, "This link is incomplete".
//
// The pendingId, the owner's first name and the buttons are in the URL fragment (finishPageUrl), which only this
// client reads; the id goes to this site's own route in a POST body as `token` (a name the Sentry scrubber drops), never
// in a URL, and no log line here holds it. Words: oauthComplete.* and pageGate.loading (the page's provider).

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CircleCheck } from 'lucide-react';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { StateCard } from '@/components/app-ui/StateCard';
import { readJsonBody } from '@/src/lib/read-json';
import { signInAgain } from '@/src/lib/sign-in-again';
import { signInHref } from '@/src/site/signin';
import { CONNECT_CSS } from '../connect-css';
import { ConnectHero, ConnectLoader } from '../connect-ui';

/** What the claim buttons say. */
export interface FinishButtonWords {
  telegramButton: string;
  whatsappButton: string;
  /** Under the WhatsApp button: nothing is connected until that message is sent */
  whatsappHint: string;
}

interface OAuthCompleteClientProps {
  botUsername: string;
  waNumber: string;
}

/** What the OAuth callback put in the fragment: #p=<pendingId>&n=<first name>&b=tg,wa */
export interface FinishParams {
  pendingId: string;
  ownerName: string;
  telegram: boolean;
  whatsapp: boolean;
}

const PENDING_ID = /^[A-Za-z0-9_-]{32}$/;
const TAG = '[oauth-complete]';

export function parseFinishFragment(hash: string): FinishParams | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const pendingId = params.get('p') ?? '';
  if (!PENDING_ID.test(pendingId)) return null;
  const buttons = (params.get('b') ?? '').split(',');
  return { pendingId, ownerName: params.get('n') ?? '', telegram: buttons.includes('tg'), whatsapp: buttons.includes('wa') };
}

/**
 * The claim links: the bot's /start gc_<id>, and a WhatsApp message that contains gc_<id>.
 * A button shows only when the owner has that channel and it is configured.
 */
export function finishLinks(
  params: FinishParams,
  botUsername: string,
  waNumber: string,
  waText: string,
): { telegram?: string; whatsapp?: string } {
  const code = `gc_${params.pendingId}`;
  return {
    ...(params.telegram && botUsername ? { telegram: `https://t.me/${botUsername}?start=${code}` } : {}),
    ...(params.whatsapp && waNumber
      ? { whatsapp: `https://wa.me/${waNumber}?text=${encodeURIComponent(waText.replace('{code}', code))}` }
      : {}),
  };
}

/**
 * The claim buttons. Telegram is the primary; WhatsApp is outlined beside it and the primary alone. Under Finish here
 * (`secondary`) both are outlined. WhatsApp only prefills the message, so its hint under it says to send it.
 */
export function FinishButtons({
  links,
  translations: t,
  secondary = false,
}: {
  links: { telegram?: string; whatsapp?: string };
  translations: FinishButtonWords;
  secondary?: boolean;
}) {
  const whatsappPrimary = !secondary && !links.telegram;
  return (
    <div className="ch-connect-actions">
      {links.telegram ? (
        <a className={`ch-btn ${secondary ? 'ch-btn-outline' : 'ch-btn-primary'} ch-save`} href={links.telegram}>
          {t.telegramButton}
        </a>
      ) : null}
      {links.whatsapp ? (
        <>
          <a className={`ch-btn ${whatsappPrimary ? 'ch-btn-primary' : 'ch-btn-outline'} ch-save`} href={links.whatsapp}>
            {t.whatsappButton}
          </a>
          <p className="ch-form-fixed">{t.whatsappHint}</p>
        </>
      ) : null}
    </div>
  );
}

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

/** What a refused Finish here says: a key of oauthComplete. */
type Problem = 'hereNotOwner' | 'hereExpired' | 'hereSignedOut' | 'hereFailed' | 'hereNetwork' | 'hereStale';
const REFUSALS: Record<string, Problem> = { not_owner: 'hereNotOwner', expired: 'hereExpired', 'signed-out': 'hereSignedOut', 'stale-sign-in': 'hereStale' };

/** What the check says of this browser's session: see useMine. */
interface Seen {
  mine: boolean;
  stale: boolean;
  /** With stale: the session is a WhatsApp link's, which signs in again only by a fresh link from the chat */
  whatsapp: boolean;
}

/**
 * What this browser's session is to the consent: the account that started it (`mine`), or its own account with a sign-in
 * over an hour old (`stale`, never with mine; `whatsapp` when that session is a WhatsApp link's); null while the page asks
 * (no id: none of them).
 */
function useMine(pendingId: string | null): Seen | null {
  const [answer, setAnswer] = useState<({ id: string } & Seen) | null>(null);
  useEffect(() => {
    if (!pendingId) return;
    let live = true;
    void (async () => {
      let mine = false;
      let stale = false;
      let whatsapp = false;
      try {
        const res = await fetch('/api/oauth/claim', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: pendingId, peek: true }),
        });
        const body = await readJsonBody(res, `${TAG} the Finish here check`);
        if (!res.ok) console.warn(`${TAG} the Finish here check answered ${res.status}`);
        mine = res.ok && body?.mine === true;
        stale = res.ok && !mine && body?.stale === true;
        whatsapp = stale && body?.whatsapp === true;
      } catch (error) {
        // The chat buttons still work: the page shows them as if this browser were not the account
        console.error(`${TAG} the Finish here check failed:`, error instanceof Error ? error.name : typeof error);
      }
      if (live) setAnswer({ id: pendingId, mine, stale, whatsapp });
    })();
    return () => {
      live = false;
    };
  }, [pendingId]);
  if (!pendingId) return { mine: false, stale: false, whatsapp: false };
  return answer?.id === pendingId ? { mine: answer.mine, stale: answer.stale, whatsapp: answer.whatsapp } : null;
}

export default function OAuthCompleteClient({ botUsername, waNumber }: OAuthCompleteClientProps) {
  const t = useTranslations('oauthComplete');
  const gate = useTranslations('pageGate');
  const locale = useLocale();
  // The fragment exists only in the browser; the server render has none (null)
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => null);
  const params = hash === null ? null : parseFinishFragment(hash);
  const seen = useMine(params?.pendingId ?? null);
  const mine = seen === null ? null : seen.mine;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // A refused Finish here: the connection is used up, or this browser's sign-in ended
  const [hereGone, setHereGone] = useState(false);
  // Finish here was refused as a stale sign-in: whether this session is a WhatsApp link's (the hint, no Sign in again)
  const [staleWhatsApp, setStaleWhatsApp] = useState(false);
  // The Sign in again press is out (sign-out, then /signin): a second press is ignored and the button reads as busy
  const [leaving, setLeaving] = useState(false);
  // The last Sign in again press did not leave (the sign-out failed, logged in sign-in-again.ts): the page says so
  const [leaveFailed, setLeaveFailed] = useState(false);
  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    setLeaveFailed(false);
    void signInAgain(locale).then((left) => {
      if (left) return;
      setLeaving(false);
      setLeaveFailed(true);
    });
  };

  if (hash === null || (params && seen === null)) {
    return (
      <AppScreen ground="grouped">
        <ConnectLoader label={gate('loading')} />
      </AppScreen>
    );
  }
  // The message as written, {code} and all: finishLinks puts the claim code in
  const links = params ? finishLinks(params, botUsername, waNumber, t.raw('whatsappText') as string) : {};
  const chat = Boolean(links.telegram || links.whatsapp);
  if (!params) {
    return (
      <AppScreen>
        <StateCard tone="crash" title={t('incompleteTitle')} body={t('incompleteBody')} />
      </AppScreen>
    );
  }
  if (!mine && !chat) {
    // This browser's own account, signed in over an hour ago: the cookie is still here, so /signin would only send it back
    // to its calendar; the press signs out first
    if (seen?.stale && seen.whatsapp) {
      // A WhatsApp link's session: no web way to sign in again with, so the card points to a fresh link from the chat
      return (
        <AppScreen>
          <StateCard
            tone="crash"
            title={t('staleTitle')}
            body={
              <>
                {t('staleBody')}
                <br />
                {gate('browserBody')}
              </>
            }
          />
        </AppScreen>
      );
    }
    if (seen?.stale) {
      return (
        <AppScreen>
          <StateCard tone="crash" title={t('staleTitle')} body={t('staleBody')} action={{ label: t('staleButton'), onClick: leave, busy: leaving }} />
          {leaveFailed ? <Notice tone="error">{t('hereNetwork')}</Notice> : null}
        </AppScreen>
      );
    }
    return (
      <AppScreen>
        <StateCard tone="crash" title={t('signInTitle')} body={t('signInBody')} action={{ label: t('signInButton'), href: signInHref(locale) }} />
      </AppScreen>
    );
  }
  const here = mine === true && !hereGone;

  const finishHere = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    let leaving = false;
    try {
      const res = await fetch('/api/oauth/claim', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: params.pendingId }),
      });
      const body = await readJsonBody(res, `${TAG} Finish here`);
      if (res.ok && body?.ok === true && typeof body.redirect === 'string') {
        // The server names the page; it is always this site's
        if (new URL(body.redirect, window.location.origin).origin === window.location.origin) {
          leaving = true;
          window.location.assign(body.redirect);
          return;
        }
        console.error(`${TAG} Finish here named a page off this site`);
        setProblem('hereFailed');
        setHereGone(true);
        return;
      }
      console.warn(`${TAG} Finish here answered ${res.status}`);
      if (res.status === 429) {
        // Too many requests: nothing was used up, so it can be pressed again
        setProblem('hereNetwork');
        return;
      }
      const refusal = REFUSALS[String(body?.error)] ?? 'hereFailed';
      if (refusal === 'hereStale') setStaleWhatsApp(body?.whatsapp === true);
      setProblem(refusal);
      setHereGone(true);
    } catch (error) {
      console.error(`${TAG} Finish here failed:`, error instanceof Error ? error.name : typeof error);
      setProblem('hereNetwork');
    } finally {
      if (!leaving) setBusy(false);
    }
  };

  return (
    <AppScreen ground="grouped">
      <style>{FORM_CSS}</style>
      <style>{CONNECT_CSS}</style>
      <div className="ch-form-page ch-form-page-grouped">
        <ConnectHero icon={<CircleCheck aria-hidden="true" />} title={t('title')} lead={t('subtitle')} />
        <Notice>{params.ownerName ? t('owner', { name: params.ownerName }) : t('ownerUnnamed')}</Notice>
        {problem === 'hereStale' && staleWhatsApp ? (
          <Notice tone="error">
            {t('hereStale')}
            <br />
            {gate('browserBody')}
          </Notice>
        ) : problem === 'hereStale' ? (
          // A sign-out that failed says so in the notice and keeps Sign in again
          <Notice tone="error" action={{ label: t('staleButton'), onClick: leave, busy: leaving }}>
            {leaveFailed ? t('hereNetwork') : t('hereStale')}
          </Notice>
        ) : problem ? (
          <Notice tone="error">{t(problem)}</Notice>
        ) : null}
        {here ? (
          <div className="ch-connect-actions">
            <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={busy} aria-busy={busy || undefined} onClick={finishHere}>
              {busy ? t('hereBusy') : t('hereButton')}
            </button>
          </div>
        ) : null}
        {chat ? (
          <FinishButtons
            links={links}
            secondary={here}
            translations={{ telegramButton: t('telegramButton'), whatsappButton: t('whatsappButton'), whatsappHint: t('whatsappHint') }}
          />
        ) : null}
      </div>
    </AppScreen>
  );
}
