'use client';

// /signin's ways and the email code form (spec 2026-11-02-web-sign-in §3), the page's only script. The server says which
// ways are configured (no button for one whose keys aren't set) and passes the bot's link and the page's address.
//
// - With ?invite= on the page (a clean token, passed by the server), every way carries it: the start links' query and
//   the email request's body. The server keeps it in the one-time flow record and lands back on the invite.
// - Telegram and Google are plain links to their start routes (/api/auth/<way>/start?locale=): the server makes the
//   one-time checks and redirects to the provider. Tapping one shows that it is opening and the other ways are off
//   (a ctrl/cmd/shift/middle click opens a new tab and leaves this page as it was); coming back with the browser's Back
//   (the page restored from the back-forward cache) makes the ways usable again.
// - Inside Telegram, in its own browser (window.TelegramWebviewProxy, iOS and Android), Telegram's login can't finish and
//   Google refuses to sign in: no OIDC flow starts. A Mini App webview (window.Telegram.WebApp.initData not empty) counts
//   too, best effort: this site's pages load no Telegram SDK, so it is seen only where a client-side navigation kept the
//   object from an app page. The Telegram way is Telegram's own app link instead (the
//   bot's chat, whose dashboard button opens the Mini App), and Google's place says to open this page in a browser, with
//   its address.
// - Email: the address, then one answer for every address ("If this email is on a FamCal account, we sent a code"), then
//   the 6-digit code. A right code goes where the server says (this site only); a wrong one says so; a code the server
//   can't use any more goes back to the address; a blocked or suspended account goes to its page. A right sign-up code
//   goes to the sign-up page (the server's redirect). "Send a new code" asks again for the same address.
// - A right code whose address already signs in to another account by the other way (the verify route's { error:
//   'exists', way }, web sign-up spec §2.2) goes to /signin?status=exists-google (or exists-email), whose line says to
//   sign in that way and add this one in Settings.
// - Bot check (web sign-up spec 2026-11-03 §2.4): when the server passes a Turnstile site key, the email form and the code
//   screen each hold Cloudflare's check (TurnstileWidget). Send and "Send a new code" wait for its token, the token goes
//   with the request, and the check is reset after each request (a token works once). The server's 'check' refusal has
//   its own words. No site key: no widget, no script, and the request is as in 6b.
// - Every request waits with its button busy and the others off, and clears on failure with the reason in words. A log
//   line holds the status and the error only: never the address or the code.
// - The words are site.signin.* (the site namespace reaches the client). Inputs are 16 px (no zoom on iOS) and read left
//   to right in every language.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Mail, Send } from 'lucide-react';
import { GoogleMark } from '@/components/site/GoogleMark';
import { TurnstileWidget, type TurnstileHandle } from '@/components/site/TurnstileWidget';
import { readJsonBody } from '@/src/lib/read-json';
import { signInHref } from '@/src/site/signin';

export interface SignInWays {
  telegram: boolean;
  google: boolean;
  email: boolean;
}

type Step = 'choose' | 'email' | 'code';
type Busy = 'telegram' | 'google' | 'email' | 'code';
/** What the form says went wrong: a key of site.signin. */
type Problem = 'requestFailed' | 'codeWrong' | 'codeLimited' | 'codeRestart' | 'emailCheck';

const TAG = '[signin]';
const subscribe = () => () => {};
/**
 * Inside Telegram: its own browser defines the TelegramWebviewProxy bridge (the sure signal). A Mini App webview has
 * Telegram.WebApp with the initData it was opened with, but a site page loads no SDK, so that is best effort (only a
 * client-side navigation from an app page leaves the object behind). A normal browser has neither. No sign-in flow of
 * ours can finish inside Telegram.
 */
const inTelegram = () => {
  if (typeof window === 'undefined') return false;
  if ('TelegramWebviewProxy' in window) return true;
  const webApp = (window as unknown as { Telegram?: { WebApp?: { initData?: unknown } } }).Telegram?.WebApp;
  return typeof webApp?.initData === 'string' && webApp.initData !== '';
};
const onServer = () => false;

export function SignInClient({
  ways,
  telegramAppUrl,
  pageAddress,
  turnstileSiteKey = null,
  invite = null,
}: {
  ways: SignInWays;
  telegramAppUrl: string;
  pageAddress: string;
  /** Cloudflare Turnstile's site key, when the server has the check on (page.tsx reads it per request) */
  turnstileSiteKey?: string | null;
  /** The partner invite this sign-in began on (/signin?invite=, a clean token, passed by the server), or null */
  invite?: string | null;
}) {
  const t = useTranslations('site.signin');
  const locale = useLocale();
  // The start routes' query: the page's language, and the invite this sign-in began on
  const startQuery = `locale=${locale}${invite ? `&invite=${invite}` : ''}`;
  const inApp = useSyncExternalStore(subscribe, inTelegram, onServer);
  const [step, setStep] = useState<Step>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const checkRef = useRef<TurnstileHandle>(null);
  const emailId = useId();
  const codeId = useId();
  const problemId = useId();
  /** Waiting for the bot check's token: Send and Send a new code wait too */
  const waiting = turnstileSiteKey !== null && token === null;

  // Back from Telegram's or Google's page restores this one as it was left: its ways work again
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(null);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  // A way that is a link: while one is opening the others do nothing; a modified or non-primary click opens a new tab, so
  // this page stays as it was
  const startWay = (way: 'telegram' | 'google') => (event: MouseEvent<HTMLAnchorElement>) => {
    if (busy !== null) return event.preventDefault();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    setBusy(way);
  };

  const goTo = (next: Step) => {
    setProblem(null);
    setStep(next);
  };

  const requestCode = async (event?: FormEvent) => {
    event?.preventDefault();
    const address = email.trim();
    if (busy || address === '' || waiting) return;
    setBusy('email');
    setProblem(null);
    try {
      const res = await fetch('/api/auth/email/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(turnstileSiteKey ? { email: address, locale, token } : { email: address, locale }), ...(invite ? { invite } : {}) }),
      });
      const body = await readJsonBody(res, `${TAG} code request`);
      if (res.ok && body?.ok === true) {
        setEmail(address);
        setCode('');
        setStep('code');
        return;
      }
      if (body?.error === 'check') {
        console.warn(`${TAG} the browser check was refused (${res.status})`);
        setProblem('emailCheck');
        return;
      }
      console.warn(`${TAG} the code request answered ${res.status}`);
      setProblem('requestFailed');
    } catch (error) {
      console.error(`${TAG} the code request failed:`, error instanceof Error ? error.name : typeof error);
      setProblem('requestFailed');
    } finally {
      setBusy(null);
      // A token works once: the check asks for the next one
      if (turnstileSiteKey) checkRef.current?.reset();
    }
  };

  const checkCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy('code');
    setProblem(null);
    let leaving = false;
    try {
      const res = await fetch('/api/auth/email/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await readJsonBody(res, `${TAG} code check`);
      if (res.ok && body?.ok === true && typeof body.redirect === 'string') {
        // The server names the page; it is always this site's
        if (new URL(body.redirect, window.location.origin).origin === window.location.origin) {
          leaving = true;
          window.location.assign(body.redirect);
          return;
        }
        console.error(`${TAG} the code check named a page off this site`);
        setProblem('requestFailed');
        return;
      }
      const error = body?.error;
      if (error === 'wrong') return void setProblem('codeWrong');
      if (error === 'limited') return void setProblem('codeLimited');
      if (error === 'restart') {
        setStep('email');
        setProblem('codeRestart');
        return;
      }
      // The address already signs in to another account by the other way (web sign-up spec §2.2): its line on /signin
      const way = body?.way;
      if (error === 'exists' && (way === 'google' || way === 'email')) {
        leaving = true;
        window.location.assign(signInHref(locale, way === 'google' ? 'exists-google' : 'exists-email'));
        return;
      }
      if (error === 'blocked' || error === 'suspended') {
        leaving = true;
        window.location.assign(signInHref(locale, error));
        return;
      }
      // 'failed' and an answer this page doesn't know: the request failed
      console.warn(`${TAG} the code check answered ${res.status}`);
      setProblem('requestFailed');
    } catch (error) {
      console.error(`${TAG} the code check failed:`, error instanceof Error ? error.name : typeof error);
      setProblem('requestFailed');
    } finally {
      if (!leaving) setBusy(null);
    }
  };

  const spinner = <Loader2 className="site-icon site-spin" aria-hidden="true" focusable="false" />;
  const problemLine = problem ? (
    <p id={problemId} className="site-field-error" role="alert">
      {t(problem)}
    </p>
  ) : null;
  // The email form and the code screen each mount their own (a step change renders a fresh check)
  const browserCheck = turnstileSiteKey ? <TurnstileWidget key="turnstile" ref={checkRef} siteKey={turnstileSiteKey} onToken={setToken} /> : null;

  if (step === 'choose') {
    return (
      <div className="site-signin-panel">
        <ul className="site-signin-ways">
          {ways.telegram ? (
            <li>
              {inApp ? (
                <a className="site-signin-way" data-way="telegram" href={telegramAppUrl}>
                  <Send aria-hidden="true" focusable="false" />
                  {t('telegramInApp')}
                </a>
              ) : (
                <a className="site-signin-way" data-way="telegram" href={`/api/auth/telegram/start?${startQuery}`} aria-busy={busy === 'telegram' || undefined} onClick={startWay('telegram')}>
                  {busy === 'telegram' ? spinner : <Send aria-hidden="true" focusable="false" />}
                  {busy === 'telegram' ? t('opening') : t('telegram')}
                </a>
              )}
              <p className="site-signin-note">{inApp ? t('telegramInAppNote') : t('telegramNote')}</p>
            </li>
          ) : null}
          {ways.google ? (
            <li>
              {inApp ? (
                <p className="site-signin-notice">
                  {t('googleInApp')}
                  <code dir="ltr">{pageAddress}</code>
                </p>
              ) : (
                <a className="site-signin-way" data-way="google" href={`/api/auth/google/start?${startQuery}`} aria-busy={busy === 'google' || undefined} onClick={startWay('google')}>
                  {busy === 'google' ? spinner : <GoogleMark />}
                  {busy === 'google' ? t('opening') : t('google')}
                </a>
              )}
            </li>
          ) : null}
          {ways.email ? (
            <li>
              <button type="button" className="site-signin-way" data-way="email" disabled={busy !== null} onClick={() => goTo('email')}>
                <Mail aria-hidden="true" focusable="false" />
                {t('email')}
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    );
  }

  if (step === 'email') {
    return (
      <div className="site-signin-panel">
        <form onSubmit={requestCode} noValidate>
          <label className="site-field-label" htmlFor={emailId}>
            {t('emailLabel')}
          </label>
          <input
            id={emailId}
            className="site-field"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="send"
            dir="ltr"
            value={email}
            disabled={busy !== null}
            aria-describedby={problem ? problemId : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />
          {problemLine}
          {browserCheck}
          <button type="submit" className="site-signin-way" data-way="submit" disabled={busy !== null || email.trim() === '' || waiting} aria-busy={busy === 'email' || undefined}>
            {busy === 'email' ? spinner : null}
            {busy === 'email' ? t('emailSending') : waiting ? t('turnstileWaiting') : t('emailSend')}
          </button>
        </form>
        <div className="site-signin-links">
          <button type="button" className="site-signin-link" disabled={busy !== null} onClick={() => goTo('choose')}>
            {t('otherWays')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="site-signin-panel">
      <p className="site-signin-sent" role="status">
        {/* With sign-up on (a site key), every address may get a code: the line says where to look, the same for all */}
        {turnstileSiteKey ? t('emailSentOpen') : t('emailSent')}
      </p>
      <form onSubmit={checkCode} noValidate>
        <label className="site-field-label" htmlFor={codeId}>
          {t('codeLabel')}
        </label>
        <input
          id={codeId}
          className="site-field site-field-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="done"
          dir="ltr"
          maxLength={6}
          value={code}
          disabled={busy !== null}
          aria-invalid={problem === 'codeWrong' || undefined}
          aria-describedby={problem ? problemId : undefined}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        {problemLine}
        <button type="submit" className="site-signin-way" data-way="submit" disabled={busy !== null || code.length !== 6} aria-busy={busy === 'code' || undefined}>
          {busy === 'code' ? spinner : null}
          {busy === 'code' ? t('codeChecking') : t('codeSubmit')}
        </button>
      </form>
      {browserCheck}
      <div className="site-signin-links">
        <button type="button" className="site-signin-link" disabled={busy !== null || waiting} onClick={() => void requestCode()}>
          {t('codeAgain')}
        </button>
        <button type="button" className="site-signin-link" disabled={busy !== null} onClick={() => goTo('choose')}>
          {t('otherWays')}
        </button>
      </div>
    </div>
  );
}
