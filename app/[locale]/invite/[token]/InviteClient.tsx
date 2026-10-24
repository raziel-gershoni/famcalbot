'use client';

// Client-side invite landing.
//
// Four states:
//  1. Inside Telegram WebApp → one-tap accept via /api/pair/accept (uses initData)
//  2. Outside any app → "Open in Telegram" + "Open in WhatsApp" deep links
//  3. After successful accept → confirmation screen
//  4. The two are already paired with each other → that news in place of the button
//
// We intentionally keep this minimal: no design library, just Tailwind, matching
// the rest of the miniapp's plain-but-polished aesthetic.

import { captureError } from '@/src/lib/error-capture';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

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

export default function InviteClient(props: Props) {
  const { token, inviterName, locale, tgDeepLink, waDeepLink, expiresAt } = props;
  const t = useTranslations('invite');
  const [state, setState] = useState<AcceptState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [tgUser, setTgUser] = useState<number | null>(null);
  const [tgInitData, setTgInitData] = useState<string | null>(null);

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

  const expiresWhen = new Date(expiresAt).toLocaleString(
    locale === 'he' ? 'he-IL' : locale === 'ru' ? 'ru-RU' : 'en-US',
    { dateStyle: 'medium', timeStyle: 'short' }
  );

  // Success state
  if (state === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-100 to-teal-100 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="text-6xl mb-4">🎉</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-3">{t('success', { name: inviterName })}</h1>
          <button
            onClick={() => window.Telegram?.WebApp?.close?.()}
            className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-emerald-700 transition-colors"
          >
            {t('closeApp')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-100 p-6">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="text-5xl mb-4">🤝</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">{t('title', { name: inviterName })}</h1>
          <p className="text-gray-600 text-sm">{t('subtitle')}</p>
        </div>

        {state === 'error' && errorMessage && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-4 text-rose-700 text-sm">
            {errorMessage}
          </div>
        )}

        {state === 'alreadyPaired' ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-emerald-700 text-sm text-center">
            {errorMessage}
          </div>
        ) : tgUser ? (
          <button
            onClick={accept}
            disabled={state === 'pending'}
            className="w-full bg-blue-600 text-white py-4 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {state === 'pending' ? t('accepting') : t('accept')}
          </button>
        ) : (
          <div>
            <p className="text-gray-700 text-sm font-medium mb-3 text-center">{t('notInApp')}</p>
            <div className="flex flex-col gap-2">
              {tgDeepLink && (
                <a
                  href={tgDeepLink}
                  className="block w-full bg-sky-500 text-white py-3 rounded-xl font-medium text-center hover:bg-sky-600 transition-colors"
                >
                  {t('openTg')}
                </a>
              )}
              {waDeepLink && (
                <a
                  href={waDeepLink}
                  className="block w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-center hover:bg-emerald-600 transition-colors"
                >
                  {t('openWa')}
                </a>
              )}
            </div>
          </div>
        )}

        <p className="text-xs text-gray-400 text-center mt-6">{t('expires', { when: expiresWhen })}</p>
      </div>
    </div>
  );
}
