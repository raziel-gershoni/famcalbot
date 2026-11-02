'use client';

// /signin/add-google's one button (spec 2026-11-02-web-sign-in §2.9): Continue posts the one-time token to
// /api/auth/google/add-start, which uses it up, ties the Google sign-in to this browser (famcal_signin) and answers
// Google's URL; then this tab goes there. A link used or late by then (410) says to start again from Settings; any other
// failure says so and the button works again. The token is never logged.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { GoogleMark } from '@/components/site/GoogleMark';
import { readJsonBody } from '@/src/lib/read-json';

const TAG = '[add-google]';

export function AddGoogleClient({ token }: { token: string }) {
  const t = useTranslations('site.signin');
  const [state, setState] = useState<'idle' | 'busy' | 'expired' | 'failed'>('idle');

  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setState('idle');
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const go = async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      const res = await fetch('/api/auth/google/add-start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await readJsonBody(res, `${TAG} add-start`);
      if (res.ok && typeof body?.url === 'string') {
        window.location.assign(body.url);
        return;
      }
      console.warn(`${TAG} add-start answered ${res.status}`);
      setState(res.status === 410 || res.status === 404 ? 'expired' : 'failed');
    } catch (error) {
      console.error(`${TAG} add-start failed:`, error instanceof Error ? error.name : typeof error);
      setState('failed');
    }
  };

  if (state === 'expired') {
    return (
      <p className="site-signin-notice" role="alert">
        {t('addGoogle.expired')}
      </p>
    );
  }
  const busy = state === 'busy';
  return (
    <div className="site-signin-panel">
      <p>{t('addGoogle.body')}</p>
      {state === 'failed' ? (
        <p className="site-field-error" role="alert">
          {t('addGoogle.failed')}
        </p>
      ) : null}
      <button type="button" className="site-signin-way site-signin-continue" data-way="google" disabled={busy} aria-busy={busy || undefined} onClick={() => void go()}>
        {busy ? <Loader2 className="site-icon site-spin" aria-hidden="true" focusable="false" /> : <GoogleMark />}
        {busy ? t('opening') : t('addGoogle.continue')}
      </button>
    </div>
  );
}
