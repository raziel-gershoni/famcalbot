'use client';

// Cloudflare Turnstile on /signin's email form (web sign-up spec 2026-11-03 §2.4, §3.1): the check that a person, not a
// program, asks for a code. No package: Cloudflare's script, injected once per page when the first widget mounts
// (explicit rendering), and one widget per mount.
//
// - The widget runs in the mode its Cloudflare widget is set to (Managed: most people see a short spinner). theme 'auto'
//   follows the device's dark mode; the language is the page's; the size is 'flexible' (the form's width), or 'compact'
//   where the form is narrower than the 300 px a flexible widget needs (a 320 px phone), so the page never scrolls
//   sideways.
// - The token goes to the parent (onToken), and null whenever there is none: before the pass, after it expired (the
//   widget then fetches a new one by itself), after an error, and on unmount. reset() (the parent calls it after each
//   request, since a token works once) asks for a new one.
// - An error, a timeout or a script that didn't load shows one line and Try again, which renders a fresh widget (and
//   loads the script again when it failed). Inside Telegram's own browser this is what the page can do: the check runs
//   in Cloudflare's iframe, uses no cookie of ours and opens no window. The live check (spec §8) confirms it there.
// - A log line holds Cloudflare's error code only, never the token. Words: site.signin.turnstile*.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useLocale, useTranslations } from 'next-intl';

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** The server's TURNSTILE_ACTION (src/services/web-signin/turnstile.ts, server only); siteverify refuses any other. */
const ACTION = 'email-code';
/** The narrowest a 'flexible' widget draws. */
const FLEXIBLE_MIN_PX = 300;
const TAG = '[turnstile]';

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | null | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

export interface TurnstileHandle {
  /** Forgets the token and asks the widget for a new one. */
  reset(): void;
}

const apiOf = (): TurnstileApi | undefined => (window as unknown as { turnstile?: TurnstileApi }).turnstile;

/** The one load of Cloudflare's script per page; a failed load is forgotten, so the next render tries again. */
let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  const ready = apiOf();
  if (ready) return Promise.resolve(ready);
  if (!loading) {
    const load = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.onload = () => {
        const api = apiOf();
        if (api) resolve(api);
        else reject(new Error('the script loaded without window.turnstile'));
      };
      script.onerror = () => {
        script.parentNode?.removeChild(script);
        reject(new Error('the script did not load'));
      };
      document.head.appendChild(script);
    });
    loading = load;
    load.catch(() => {
      if (loading === load) loading = null;
    });
  }
  return loading;
}

export function TurnstileWidget({ siteKey, onToken, ref }: { siteKey: string; onToken: (token: string | null) => void; ref?: Ref<TurnstileHandle> }) {
  const t = useTranslations('site.signin');
  const locale = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const tokenTo = useRef(onToken);
  const [attempt, setAttempt] = useState(0);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    tokenTo.current = onToken;
  }, [onToken]);

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        tokenTo.current(null);
        const api = apiOf();
        if (api && widgetId.current) api.reset(widgetId.current);
      },
    }),
    [],
  );

  useEffect(() => {
    let gone = false;
    const fail = (why: string) => {
      console.warn(`${TAG} the browser check failed (${why})`);
      tokenTo.current(null);
      setProblem(true);
    };
    loadTurnstile().then(
      (api) => {
        if (gone || !box.current) return;
        const narrow = (box.current.clientWidth || FLEXIBLE_MIN_PX) < FLEXIBLE_MIN_PX;
        const id = api.render(box.current, {
          sitekey: siteKey,
          action: ACTION,
          theme: 'auto',
          language: locale,
          size: narrow ? 'compact' : 'flexible',
          callback: (token: string) => {
            setProblem(false);
            tokenTo.current(token);
          },
          'error-callback': (code: unknown) => {
            fail(`error ${String(code).replace(/[^0-9a-z]/gi, '').slice(0, 12)}`);
            return true;
          },
          'expired-callback': () => tokenTo.current(null),
          'timeout-callback': () => fail('timeout'),
        });
        widgetId.current = typeof id === 'string' ? id : null;
        if (!widgetId.current) fail('no widget');
      },
      (error: unknown) => {
        if (!gone) fail(error instanceof Error ? error.message : 'the script did not load');
      },
    );
    return () => {
      gone = true;
      const api = apiOf();
      if (api && widgetId.current) api.remove(widgetId.current);
      widgetId.current = null;
      tokenTo.current(null);
    };
  }, [siteKey, locale, attempt]);

  const retry = () => {
    setProblem(false);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="site-turnstile">
      <div ref={box} />
      {problem ? (
        <>
          <p className="site-field-error" role="alert">
            {t('turnstileProblem')}
          </p>
          <button type="button" className="site-signin-link" onClick={retry}>
            {t('turnstileRetry')}
          </button>
        </>
      ) : null}
    </div>
  );
}
