'use client';

// /signup's states and form (web sign-up spec 2026-11-03 §2.2, §2.3, §2.22, §3.4), the page's only script. The sign-up
// waits on the server behind the famcal_signin cookie (path /api/auth), so on load this asks GET /api/auth/signup:
//
// - { way, address }: the address the person proved (its own left-to-right element, wrapping anywhere), the warning
//   against a second account, the name field ("Your name", any direction, 16 px so iOS doesn't zoom), its note ("Your
//   partner sees it."), "Address me as" (two buttons, male or female, none chosen: Create account waits for one; spec
//   2026-11-07-b-features §B2), the consent line linking the Terms and the Privacy Policy, Create account and Use another way;
// - { exists }: the address already signs in by the other way: its guidance (site.signin.status.exists*) and Sign in;
// - { restart: true }: expired or used: Start again (/signin).
// - A read that fails says so, with Try again.
//
// Create account posts { name, gender, locale } (the page's language becomes the account's). A name over 60 characters is said
// before any request (the server's rule is the same: SIGNUP_NAME_MAX). It waits with its button busy and clears on
// every failure with the reason in words; taken, exists and restart replace the form; blocked and suspended go to their
// /signin page; a right answer goes where the server says, this site only. A page the browser restores with Back (the
// back-forward cache) reloads, so the server sends a browser that is signed in now to its calendar. A log line holds
// the status and the error's name only: never the address or the name.

import { useEffect, useId, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { Gender } from '@/src/lib/gender';
import { readJsonBody } from '@/src/lib/read-json';
import { SIGNUP_NAME_MAX, signInHref, type SignUpWays } from '@/src/site/signin';
import { localeHref } from '@/src/site/zmanim/links';

type Way = 'google' | 'email';
type View =
  | { kind: 'loading' }
  | { kind: 'loadFailed' }
  | { kind: 'ready'; way: Way; address: string }
  | { kind: 'exists'; way: Way }
  | { kind: 'expired' }
  | { kind: 'taken' };
/** What the form says went wrong: a key of site.signup, or the sign-in form's requestFailed. */
type Problem = 'nameLong' | 'nameInvalid' | 'addressMissing' | 'limit' | 'requestFailed';

const TAG = '[signup]';
const isWay = (value: unknown): value is Way => value === 'google' || value === 'email';

/** GET /api/auth/signup as a view. Logs the status and the error's name only. */
async function readSignUp(): Promise<View> {
  try {
    const res = await fetch('/api/auth/signup', { credentials: 'same-origin', cache: 'no-store' });
    const body = await readJsonBody(res, `${TAG} the sign-up read`);
    if (res.ok && body) {
      const { way, address, exists, restart } = body;
      if (isWay(way) && typeof address === 'string') return { kind: 'ready', way, address };
      if (isWay(exists)) return { kind: 'exists', way: exists };
      if (restart === true) return { kind: 'expired' };
    }
    console.warn(`${TAG} the sign-up read answered ${res.status}`);
    return { kind: 'loadFailed' };
  } catch (error) {
    console.error(`${TAG} the sign-up read failed:`, error instanceof Error ? error.name : typeof error);
    return { kind: 'loadFailed' };
  }
}

/** `ways`: the ways open for sign-up now (the page's openSignUpWays), which the "start again" line names. */
export function SignUpClient({ ways }: { ways: SignUpWays }) {
  const t = useTranslations('site.signup');
  const ts = useTranslations('site.signin');
  const locale = useLocale();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const nameId = useId();
  const noteId = useId();
  const genderHintId = useId();
  const problemId = useId();

  useEffect(() => {
    let live = true;
    void readSignUp().then((next) => {
      if (live) setView(next);
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  // Back from the calendar restores this page as it was left (the back-forward cache), with no request: reload it, so
  // the server sends a browser that is signed in now to its calendar, and any other one reads its sign-up afresh
  useEffect(() => {
    const reload = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', reload);
    return () => window.removeEventListener('pageshow', reload);
  }, []);

  const retry = () => {
    setView({ kind: 'loading' });
    setAttempt((n) => n + 1);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || view.kind !== 'ready') return;
    const typed = name.trim();
    if (typed === '') return;
    if (Array.from(typed).length > SIGNUP_NAME_MAX) return void setProblem('nameLong');
    if (gender === null) return void setProblem('addressMissing');
    setBusy(true);
    setProblem(null);
    let leaving = false;
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: typed, gender, locale }),
      });
      const body = await readJsonBody(res, `${TAG} create account`);
      if (body?.ok === true && typeof body.redirect === 'string') {
        // The server names the page; it is always this site's
        if (new URL(body.redirect, window.location.origin).origin === window.location.origin) {
          leaving = true;
          window.location.assign(body.redirect);
          return;
        }
        console.error(`${TAG} create account named a page off this site`);
        setProblem('requestFailed');
        return;
      }
      const status = body?.status;
      const way = body?.way;
      if (status === 'name') return void setProblem('nameInvalid');
      if (status === 'gender') return void setProblem('addressMissing');
      if (status === 'limit') return void setProblem('limit');
      if (status === 'restart') return void setView({ kind: 'expired' });
      if (status === 'taken') return void setView({ kind: 'taken' });
      if (status === 'exists' && isWay(way)) return void setView({ kind: 'exists', way });
      if (status === 'blocked' || status === 'suspended') {
        leaving = true;
        window.location.assign(signInHref(locale, status));
        return;
      }
      // 'failed' and an answer this page doesn't know: the request failed
      console.warn(`${TAG} create account answered ${res.status}`);
      setProblem('requestFailed');
    } catch (error) {
      console.error(`${TAG} create account failed:`, error instanceof Error ? error.name : typeof error);
      setProblem('requestFailed');
    } finally {
      if (!leaving) setBusy(false);
    }
  };

  // Use another way is a link; while Create account is out it does nothing
  const holdWhileBusy = (event: MouseEvent<HTMLAnchorElement>) => {
    if (busy) event.preventDefault();
  };

  const spinner = <Loader2 className="site-icon site-spin" aria-hidden="true" focusable="false" />;
  const title = (words: string) => <h1 className="site-h1 site-page-title">{words}</h1>;
  const backToSignIn = (words: string) => (
    <p className="site-back site-signin-again">
      <a href={signInHref(locale)}>{words}</a>
    </p>
  );

  if (view.kind === 'loading') {
    return (
      <>
        {title(t('title'))}
        <p className="site-signin-sent site-signup-wait" role="status">
          {spinner}
          {t('loading')}
        </p>
      </>
    );
  }
  if (view.kind === 'loadFailed') {
    return (
      <>
        {title(t('title'))}
        <p className="site-signin-notice" role="alert">
          {t('loadFailed')}
        </p>
        <div className="site-signin-links">
          <button type="button" className="site-signin-link" onClick={retry}>
            {t('tryAgain')}
          </button>
        </div>
      </>
    );
  }
  if (view.kind === 'expired') {
    return (
      <>
        {title(t('expiredTitle'))}
        <p className="site-lead">{t('expired', { ways })}</p>
        {backToSignIn(t('startAgain'))}
      </>
    );
  }
  if (view.kind === 'exists') {
    return (
      <>
        {title(t('existsTitle'))}
        <p className="site-lead">{ts(view.way === 'email' ? 'status.existsEmail' : 'status.existsGoogle')}</p>
        {backToSignIn(t('signIn'))}
      </>
    );
  }
  if (view.kind === 'taken') {
    return (
      <>
        {title(t('takenTitle'))}
        <p className="site-lead">{t('taken')}</p>
        {backToSignIn(t('signIn'))}
      </>
    );
  }

  const describedBy = problem ? `${noteId} ${problemId}` : noteId;
  return (
    <>
      {title(t('title'))}
      <p className="site-lead">
        {t.rich('lead', {
          address: view.address,
          b: (chunks: ReactNode) => (
            <bdi dir="ltr" className="site-signup-address">
              {chunks}
            </bdi>
          ),
        })}
      </p>
      <p className="site-signin-notice">{t('secondAccount')}</p>
      <div className="site-signin-panel">
        <form onSubmit={create} noValidate>
          <label className="site-field-label" htmlFor={nameId}>
            {t('nameLabel')}
          </label>
          <input
            id={nameId}
            className="site-field"
            type="text"
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="done"
            dir="auto"
            value={name}
            disabled={busy}
            aria-invalid={problem === 'nameLong' || problem === 'nameInvalid' || undefined}
            aria-describedby={describedBy}
            onChange={(e) => setName(e.target.value)}
          />
          <p id={noteId} className="site-signin-note">
            {t('nameNote')}
          </p>
          <fieldset className="site-signup-gender" disabled={busy} aria-describedby={genderHintId}>
            <legend className="site-field-label">{t('addressLabel')}</legend>
            <div className="site-signup-genders">
              {(['male', 'female'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="site-signup-gender-option"
                  aria-pressed={gender === value}
                  onClick={() => {
                    setGender(value);
                    if (problem === 'addressMissing') setProblem(null);
                  }}
                >
                  {value === 'male' ? t('addressMale') : t('addressFemale')}
                </button>
              ))}
            </div>
            <p id={genderHintId} className="site-signin-note">
              {t('addressHint')}
            </p>
          </fieldset>
          {problem ? (
            <p id={problemId} className="site-field-error" role="alert">
              {problem === 'requestFailed' ? ts('requestFailed') : t(problem)}
            </p>
          ) : null}
          <p className="site-signup-consent">
            {t.rich('consent', {
              terms: (chunks: ReactNode) => <a href={localeHref(locale, '/terms')}>{chunks}</a>,
              privacy: (chunks: ReactNode) => <a href={localeHref(locale, '/privacy')}>{chunks}</a>,
            })}
          </p>
          <button type="submit" className="site-signin-way" data-way="submit" disabled={busy || name.trim() === '' || gender === null} aria-busy={busy || undefined}>
            {busy ? spinner : null}
            {busy ? t('creating') : t('create')}
          </button>
        </form>
        <div className="site-signin-links">
          <a className="site-signin-link" href={signInHref(locale)} aria-disabled={busy || undefined} onClick={holdWhileBusy}>
            {t('another')}
          </a>
        </div>
      </div>
    </>
  );
}
