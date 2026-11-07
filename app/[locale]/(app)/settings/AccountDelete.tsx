'use client';

// Settings' "Delete account" (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3): a red row at the bottom of
// Settings, and a sheet that says what goes (the data, the partner, the copies in Google), that it can't be undone, and,
// while a paid month runs, that the plan ends with the account and a refund is asked for first (a link to the Terms).
// Delete my account posts { confirm: true } (account-delete-client.ts); the server deletes through the admin's one path.
// A browser whose sign-in is over an hour old learns it on the press: the sheet then offers Sign in again (signInAgain),
// or, for a WhatsApp link's session, asks for a new link in the chat. While it works the sheet can't be closed. Done (or
// already deleted, a 404): this browser's notifications are turned off (turnOffPush, locally: the devices went with the
// account), and Close leaves: the Mini App closes, a browser goes to famcal.bot's home page, signed out.
//
// AccountDeleteView is presentational (the smoke renders every phase); AccountDelete owns the state and the request.
// Drawn with the app's kit, like GoogleDisconnect. `onSheet` tells the screen what its Back should do while the sheet is open.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Trash2 } from 'lucide-react';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { FormCard } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { readInitData } from '@/src/lib/read-init-data';
import { signInAgain } from '@/src/lib/sign-in-again';
import { turnOffPush } from '@/src/lib/web-push-client';
import { localeHref } from '@/src/site/zmanim/links';
import { requestAccountDelete, type AccountDeleteError } from './account-delete-client';

export type AccountDeletePhase = 'idle' | 'confirm' | 'working' | 'done' | 'gone';

export interface AccountDeleteViewProps {
  phase: AccountDeletePhase;
  /** A paid month runs (page-data, paidMonthRunning): the sheet says the plan ends with the account. */
  paidMonthRunning: boolean;
  error: AccountDeleteError | null;
  /** The Terms' "Cancelling and refunds" in the page's language. */
  termsHref: string;
  onOpen: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onSignInAgain: () => void;
  onClose: () => void;
}

export function AccountDeleteView(props: AccountDeleteViewProps) {
  const t = useTranslations('settings.accountDelete');
  const { phase, error } = props;
  const working = phase === 'working';
  const finished = phase === 'done' || phase === 'gone';
  const finishedTitle = phase === 'gone' ? t('goneTitle') : t('doneTitle');

  return (
    <>
      <FormCard>
        <button type="button" className="ch-form-row ch-danger-row" aria-haspopup="dialog" onClick={props.onOpen}>
          <Trash2 size={18} aria-hidden="true" />
          {t('button')}
        </button>
      </FormCard>
      {phase !== 'idle' && (
        <BottomSheet label={finished ? finishedTitle : t('confirmTitle')} closeLabel={finished ? t('close') : t('cancel')} closeDisabled={working} onClose={finished ? props.onClose : props.onCancel}>
          {finished ? (
            <h2 className="ch-sheet-heading">{finishedTitle}</h2>
          ) : (
            <>
              <h2 className="ch-sheet-heading">{t('confirmTitle')}</h2>
              <ul className="ch-sheet-list">
                <li>{t('goesData')}</li>
                <li>{t('goesPartner')}</li>
                <li>{t('goesGoogle')}</li>
              </ul>
              <p className="ch-sheet-sub">{t('undone')}</p>
              {props.paidMonthRunning && (
                <p className="ch-sheet-sub">
                  {t.rich('paidMonth', {
                    terms: (chunks: ReactNode) => (
                      <a href={props.termsHref} target="_blank" rel="noopener noreferrer">
                        {chunks}
                      </a>
                    ),
                  })}
                </p>
              )}
              <div className="ch-sheet-stack">
                {error === 'failed' || error === 'busy' ? <Notice tone="error">{t(error === 'busy' ? 'errorBusy' : 'errorFailed')}</Notice> : null}
                {error === 'stale' ? <p className="ch-form-fixed">{t('staleNote')}</p> : null}
                {error === 'staleLink' ? <Notice>{t('staleLink')}</Notice> : null}
                {working && (
                  <p className="ch-form-fixed ch-working">
                    <Loader2 size={16} className="ch-spin" aria-hidden="true" /> {t('working')}
                  </p>
                )}
                {error === 'stale' ? (
                  <button type="button" className="ch-btn ch-btn-primary ch-save" onClick={props.onSignInAgain}>
                    {t('signInAgain')}
                  </button>
                ) : error === 'staleLink' ? null : (
                  <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" onClick={props.onConfirm} disabled={working}>
                    {t('confirm')}
                  </button>
                )}
              </div>
            </>
          )}
        </BottomSheet>
      )}
    </>
  );
}

interface AccountDeleteProps {
  userId: number;
  paidMonthRunning: boolean;
  /** What Back should do while the sheet is open: its closer (a no-op during the request, Leave when done), or null once closed. */
  onSheet?: (close: (() => void) | null) => void;
}

const noop = () => {};

export default function AccountDelete({ userId, paidMonthRunning, onSheet }: AccountDeleteProps) {
  const locale = useLocale();
  const [phase, setPhase] = useState<AccountDeletePhase>('idle');
  const [error, setError] = useState<AccountDeleteError | null>(null);

  // The account is gone: the Mini App closes; a browser (signed out by the answer's cleared cookie) goes to the home page
  const leave = useCallback(() => {
    const tg = readInitData() !== '' ? window.Telegram?.WebApp : undefined;
    if (tg) {
      tg.close();
      return;
    }
    window.location.assign(localeHref(locale, '/'));
  }, [locale]);

  // The closers run later than the render that made them: they read the parent's latest callback.
  const latest = useRef({ onSheet, leave });
  useEffect(() => {
    latest.current = { onSheet, leave };
  });
  useEffect(() => {
    const closer = phase === 'confirm' ? () => setPhase('idle') : phase === 'working' ? noop : phase === 'done' || phase === 'gone' ? () => latest.current.leave() : null;
    latest.current.onSheet?.(closer);
  }, [phase]);
  useEffect(() => () => latest.current.onSheet?.(null), []);

  const confirm = async () => {
    setError(null);
    setPhase('working');
    const result = await requestAccountDelete(userId);
    if (result.kind === 'deleted' || result.kind === 'gone') {
      // This browser drops its subscription; its device row went with the account, so no request is sent (turnOffPush logs a failure)
      await turnOffPush(null);
      setPhase(result.kind === 'deleted' ? 'done' : 'gone');
      return;
    }
    setError(result.kind === 'stale' ? (result.whatsapp ? 'staleLink' : 'stale') : result.code);
    setPhase('confirm');
  };

  return (
    <AccountDeleteView
      phase={phase}
      paidMonthRunning={paidMonthRunning}
      error={error}
      termsHref={`${localeHref(locale, '/terms')}#cancel`}
      onOpen={() => {
        setError(null);
        setPhase('confirm');
      }}
      onConfirm={() => void confirm()}
      onCancel={() => setPhase('idle')}
      onSignInAgain={() => void signInAgain(locale)}
      onClose={leave}
    />
  );
}
