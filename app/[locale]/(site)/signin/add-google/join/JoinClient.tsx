'use client';

// The Join question's buttons on /signin/add-google/join (web sign-up spec 2026-11-03 §3.6): Join posts the question's
// id (as `token`, which the scrubber drops) to /api/signin-methods/join with this browser's session cookie; Cancel joins
// nothing and changes nothing (the question expires by itself). After either, Open your calendar goes to the account's
// calendar. A late or used question (410) and a refused one (409) have their words; any other failure says so and the
// button works again. The id is never logged.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { readJsonBody } from '@/src/lib/read-json';
import { localeHref } from '@/src/site/zmanim/links';
import { normalizeLocale } from '@/src/utils/locale';

const TAG = '[join]';

type State = 'idle' | 'busy' | 'done' | 'cancelled' | 'expired' | 'refused' | 'failed';

export function JoinClient({ userId, token }: { userId: number; token: string }) {
  const t = useTranslations('site.signin.addGoogle.join');
  const locale = useLocale();
  const [state, setState] = useState<State>('idle');
  const calendar = localeHref(normalizeLocale(locale), `/dashboard?user_id=${userId}`);

  const join = async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      const res = await fetch(`/api/signin-methods/join?user_id=${userId}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await readJsonBody(res, `${TAG} answer`);
      if (res.ok && body?.ok === true) {
        setState('done');
        return;
      }
      console.warn(`${TAG} the answer was ${res.status}`);
      setState(res.status === 410 ? 'expired' : res.status === 409 ? 'refused' : 'failed');
    } catch (error) {
      console.error(`${TAG} the answer failed:`, error instanceof Error ? error.name : typeof error);
      setState('failed');
    }
  };

  if (state === 'done' || state === 'cancelled' || state === 'expired' || state === 'refused') {
    return (
      <div className="site-signin-panel">
        <p role="status">{t(state)}</p>
        <a className="site-signin-way site-signin-continue" data-way="submit" href={calendar}>
          {t('openCalendar')}
        </a>
      </div>
    );
  }
  const busy = state === 'busy';
  return (
    <div className="site-signin-panel">
      {state === 'failed' ? (
        <p className="site-field-error" role="alert">
          {t('failed')}
        </p>
      ) : null}
      <button type="button" className="site-signin-way site-signin-continue" data-way="submit" disabled={busy} aria-busy={busy || undefined} onClick={() => void join()}>
        {busy ? <Loader2 className="site-icon site-spin" aria-hidden="true" focusable="false" /> : null}
        {busy ? t('joining') : t('join')}
      </button>
      <div className="site-signin-links">
        <button type="button" className="site-signin-link" disabled={busy} onClick={() => setState('cancelled')}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
