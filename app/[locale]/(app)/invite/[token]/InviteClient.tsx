'use client';

// Client-side invite landing, in the home's design (spec 2026-10-19 §4, §5; plan W3): an AppScreen with the card the app's
// states use (StateCard's classes), outside PageGate, because anyone with the link may see it.
//
// Four states:
//  1. Inside Telegram WebApp → one-tap accept via /api/pair/accept (uses initData)
//  2. Outside any app → "Open in Telegram" + "Open in WhatsApp" deep links
//  3. After successful accept → confirmation card
//  4. The two are already paired with each other → that news in place of the button (information, not an error)
//
// - Whether this is Telegram is read after mount (window.Telegram is not there on the server), so the server's markup, the
//   links, is what the first client render draws too; Accept replaces them once the effect has run. The expiry waits for the
//   client as well: the server does not know the device's timezone, and a time written in the server's would not match.
// - An error code from the accept route says its own message (ERROR_KEYS); anything else says "could not accept". A request
//   that fails outright is said the same way, and reported (captureError).

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { captureError } from '@/src/lib/error-capture';
import { formatDeviceDayTime } from '@/src/lib/calendar-view/device-time';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { Notice } from '@/components/app-ui/Notice';
import { StateCard } from '@/components/app-ui/StateCard';
import { INVITE_CSS } from './invite-css';

interface Props {
  token: string;
  inviterName: string;
  locale: string;
  tgDeepLink: string;
  waDeepLink: string;
  expiresAt: string;
}

// Window.Telegram.WebApp is already typed in src/types/telegram-webapp.d.ts

type AcceptState = 'idle' | 'pending' | 'success' | 'alreadyPaired' | 'error';

/** The invite error codes /api/pair/accept returns, and the invite.errors key that says each. */
const ERROR_KEYS: Record<string, string> = {
  INVITE_NOT_FOUND: 'errors.notFound',
  INVITE_EXPIRED: 'errors.expired',
  INVITE_ALREADY_USED: 'errors.alreadyUsed',
  INVITE_REVOKED: 'errors.revoked',
  CANNOT_ACCEPT_OWN_INVITE: 'errors.ownInvite',
  INVITER_ALREADY_PAIRED: 'errors.inviterAlreadyPaired',
  INVITEE_ALREADY_PAIRED: 'errors.inviteeAlreadyPaired',
  ALREADY_PAIRED_TOGETHER: 'errors.alreadyPairedTogether',
};

// The device's own timezone is not the server's: nothing is written for the expiry until the page is on the client.
const subscribe = () => () => {};
const noExpiryOnServer = () => null;

export default function InviteClient(props: Props) {
  const { token, inviterName, locale, tgDeepLink, waDeepLink, expiresAt } = props;
  const t = useTranslations('invite');
  const [state, setState] = useState<AcceptState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [tgUser, setTgUser] = useState<number | null>(null);
  const [tgInitData, setTgInitData] = useState<string | null>(null);
  const expires = useSyncExternalStore(subscribe, () => formatDeviceDayTime(expiresAt, locale) || null, noExpiryOnServer);

  useEffect(() => {
    // Detect TG WebApp environment
    const tg = window.Telegram?.WebApp;
    if (tg?.initData && tg.initDataUnsafe?.user?.id) {
      tg.ready?.();
      tg.expand?.();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- window.Telegram exists only on the client, so this must run after mount
      setTgInitData(tg.initData);
      setTgUser(tg.initDataUnsafe.user.id);
    }
  }, []);

  const accept = async () => {
    if (!tgUser || !tgInitData) return;
    setState('pending');
    setErrorMessage('');
    try {
      const res = await fetch(`/api/pair/accept?user_id=${tgUser}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, initData: tgInitData }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setState(data?.error === 'ALREADY_PAIRED_TOGETHER' ? 'alreadyPaired' : 'error');
        setErrorMessage(t(ERROR_KEYS[data?.error] ?? 'errorGeneric'));
        return;
      }
      setState('success');
    } catch (error) {
      // A network failure: the user sees the generic error; the cause is logged and reported.
      captureError(error, 'invite-accept', { token_length: token.length }, 'warning');
      setState('error');
      setErrorMessage(t('errorGeneric'));
    }
  };

  const pending = state === 'pending';

  return (
    <AppScreen>
      <style>{INVITE_CSS}</style>
      <div className="ch-invite-page">
        {state === 'success' ? (
          <StateCard title={t('success', { name: inviterName })} action={{ label: t('closeApp'), onClick: () => window.Telegram?.WebApp?.close?.() }} />
        ) : (
          <div className="ch-home-card">
            <h1 className="ch-home-card-title">{t('title', { name: inviterName })}</h1>
            <p className="ch-home-card-body">{t('subtitle')}</p>

            {errorMessage ? <Notice tone={state === 'alreadyPaired' ? 'info' : 'error'}>{errorMessage}</Notice> : null}

            {state === 'alreadyPaired' ? null : tgUser ? (
              <div className="ch-home-card-actions">
                <button type="button" className="ch-btn ch-btn-primary ch-home-card-action" disabled={pending} aria-busy={pending || undefined} onClick={accept}>
                  {pending ? t('accepting') : t('accept')}
                </button>
              </div>
            ) : (
              <>
                <p className="ch-home-card-body">{t('notInApp')}</p>
                <div className="ch-home-card-actions">
                  {tgDeepLink ? (
                    <a className="ch-btn ch-btn-primary ch-home-card-action" href={tgDeepLink}>
                      {t('openTg')}
                    </a>
                  ) : null}
                  {waDeepLink ? (
                    <a className="ch-btn ch-home-card-action" href={waDeepLink}>
                      {t('openWa')}
                    </a>
                  ) : null}
                </div>
              </>
            )}

            {expires ? <p className="ch-home-card-body ch-invite-expires">{t('expires', { when: expires })}</p> : null}
          </div>
        )}
      </div>
    </AppScreen>
  );
}
