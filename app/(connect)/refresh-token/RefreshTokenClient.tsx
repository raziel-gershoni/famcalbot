'use client';

// /refresh-token in the app's design (plan W4-3; spec 2026-10-19 §4, §5): connect or reconnect Google. An AppScreen on
// the grouped ground (its steps are a card), made of the kit: the header with its back, the hero (the icon and the lead),
// the steps as a numbered card, one primary Continue, and the notices under it.
//
// The flow is the Google connection spec's, unchanged (docs/superpowers/specs/2026-10-19-google-connection-design.md):
// - On mount POST /api/oauth/start (the credential: initData in the body, or the WhatsApp session cookie) makes the
//   Google URL; Continue is busy ("Getting Google ready") until it arrives. A start that fails says why in an error
//   notice (startErrorLines); a server or network failure can be tried again from there, a refused credential cannot.
// - Continue stores famcalbot_oauth_pending and opens Google: Telegram's openLink in the Mini App, a new tab elsewhere.
//   A new URL is made at once (each consent uses one up), and one left 9 minutes is replaced (URL_FRESH_MS).
// - Then the waiting notice: where to finish (Telegram or WhatsApp) and Check again, one check at once. The page asks
//   GET /api/check-token-refresh (initData in the header, `since` the tap on the server's clock) every 2 s for 3
//   minutes, on visibilitychange and on mount; when the 3 minutes end the notice says to check again.
// - A check that the person asked for (Check again, the return to the page, the mount) says "Checking the connection"
//   with a spinner in the notice, in place of its text; the page stays as it is, so focus stays on Check again. One asked
//   for while a quiet poll is on its way is made when that poll answers "not yet". Once the token landed the page moves
//   on to /<locale>/select-calendars?user_id=… with a full load.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser): the calendar,
//   /<locale>/dashboard?user_id=…, with a full page load (this page is outside [locale]).
//
// The words come in a prop (`translations`, from page.tsx: the connect or the reconnect copy, the gate's lines, Back).

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { CalendarSync } from 'lucide-react';
import { readInitData } from '@/src/lib/read-init-data';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';
import { CONNECT_CSS } from '../connect-css';
import { ConnectChecking, ConnectHero } from '../connect-ui';

interface Translations {
  title: string;
  subtitle: string;
  stepsTitle: string;
  step1: string;
  step2: string;
  step3: string;
  button: string;
  /** Continue while the Google URL is being made */
  preparing: string;
  checking: string;
  startFailed: string;
  /** Shown after Google opens: finish there, then tap the finish page's button */
  waitingTelegram: string;
  waitingWhatsApp: string;
  /** Under the waiting text once the 3-minute poll has ended */
  stillWaiting: string;
  /** The error notice's action: ask oauth/start again */
  retry: string;
  /** The waiting notice's action: one check now */
  checkAgain: string;
  /** The header's back (ui.back) */
  back: string;
  /** pageGate's strings: what to do when there is no credential for this page */
  gate: {
    telegramTitle: string;
    telegramBody: string;
    browserTitle: string;
    browserBody: string;
    browserTelegramHint: string;
  };
}

interface RefreshTokenClientProps {
  userId: string;
  locale: string;
  translations: Translations;
}

const OAUTH_PENDING_KEY = 'famcalbot_oauth_pending';

/**
 * After Google opens, ask every 2 s for up to 3 minutes whether the connection landed.
 * It lands only when the owner taps the finish page's button and the bot commits it, often
 * while this page is already visible again, so visibilitychange alone would miss it.
 * check-token-refresh has a rate limit of its own for this (tokenPollRateLimiter).
 */
const POLL_INTERVAL_MS = 2000;
const POLL_WINDOW_MS = 3 * 60_000;

/**
 * A Google URL is good for one consent: the callback uses its state up, and the state ends
 * after 10 minutes (OAUTH_STATE_TTL_MS). So a tap opens the URL prepared for it and a new
 * one is prepared at once, and one unused for 9 minutes is replaced before Google sees it.
 */
const URL_FRESH_MS = 9 * 60_000;

/** A refused credential: trying again can't help, the page has to be opened again from the chat. */
const refusedCredential = (status: number) => status === 401 || status === 403 || status === 404;

/**
 * What the page says when oauth/start gives no Google URL. With no credential it says
 * what PageGate says: inside Telegram, reopen from the bot; in a browser, the WhatsApp
 * link has expired, or, on Telegram, open it from the bot (oauth-callback's "Try again"
 * lands a Telegram user here in the external browser).
 */
export function startErrorLines(status: number, initData: string, t: Translations): string[] {
  if (refusedCredential(status)) {
    return initData
      ? [t.gate.telegramTitle, t.gate.telegramBody]
      : [t.gate.browserTitle, t.gate.browserBody, t.gate.browserTelegramHint];
  }
  return [t.startFailed];
}

/**
 * What oauth/start's answer gives the attempt: the Google URL, and how far the server's
 * clock is from this phone's (serverTime minus the phone's clock when the answer came).
 * check-token-refresh compares since with the commit flag, which the server stamps with
 * its own clock, and a phone's clock can run minutes ahead (no commit would ever count) or
 * behind (an earlier connect would). Offset 0 when the answer has no serverTime: the
 * phone's clock as it is. null when there is no URL.
 */
export function attemptFromStart(data: unknown, clientNow: number): { oauthUrl: string; clockOffset: number; preparedAt: number } | null {
  const { oauthUrl, serverTime } = (data ?? {}) as { oauthUrl?: unknown; serverTime?: unknown };
  if (typeof oauthUrl !== 'string') return null;
  const clockOffset = typeof serverTime === 'number' && Number.isFinite(serverTime) ? serverTime - clientNow : 0;
  return { oauthUrl, clockOffset, preparedAt: clientNow };
}

/**
 * check-token-refresh's since: the tap on Connect, on the server's clock. Not the time the
 * page opened, so a connect that lands in between (another tab, an earlier consent's
 * finish button) can't skip the consent that's still open.
 */
export function attemptSince(clockOffset: number, tapNow: number): number {
  return tapNow + clockOffset;
}

export default function RefreshTokenClient({ userId, locale, translations: t }: RefreshTokenClientProps) {
  const [isChecking, setIsChecking] = useState(false);
  // The Google URL comes from POST /api/oauth/start, which creates the OAuth state for
  // the user our credential proves, with the server's clock offset (attemptFromStart).
  // Until it arrives the button stays disabled, and again after each tap (URL_FRESH_MS).
  const [start, setStart] = useState<{ oauthUrl: string; clockOffset: number; preparedAt: number } | null>(null);
  const oauthUrl = start?.oauthUrl ?? null;
  // The page's own first start failed: what to say, and whether trying again can help
  const [startError, setStartError] = useState<{ lines: string[]; canRetry: boolean } | null>(null);
  // Set when Google opens: when, and whether the finish is in Telegram or WhatsApp
  const [waiting, setWaiting] = useState<{ since: number; telegram: boolean } | null>(null);
  // The 3-minute poll ended without the token
  const [timedOut, setTimedOut] = useState(false);
  const checkInFlight = useRef(false);
  // A check the person asked for (Check again) while a quiet poll was on its way: made once that poll answers "not yet"
  const checkAsked = useRef(false);
  // A later prepare (after a tap, or the timer) failed: Connect stays, and its tap prepares again
  const [retry, setRetry] = useState(false);
  // Only the latest prepare's answer counts, and none after the page is gone
  const prepared = useRef(0);
  const mounted = useRef(true);

  // first: the page's own load, whose failure is the page's answer (startErrorLines). A later
  // one's failure must not end the page: a consent may be open in the browser, and a 429 or a
  // dropped network passes, so Connect stays and retries.
  const prepare = useCallback(async (first = false) => {
    const run = ++prepared.current;
    setStart(null);
    setRetry(false);
    const initData = readInitData();
    const failed = (lines: string[], canRetry: boolean, why: string) => {
      if (!mounted.current || run !== prepared.current) return;
      if (first) {
        console.warn(`[refresh-token] starting the Google sign-in failed (${why})`);
        setStartError({ lines, canRetry });
      } else {
        console.warn(`[refresh-token] preparing the next Google sign-in failed (${why}); Connect retries`);
        setRetry(true);
      }
    };
    try {
      const response = await fetch('/api/oauth/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, initData }),
      });
      const data = await response.json().catch(() => ({}));
      if (!mounted.current || run !== prepared.current) return;
      const attempt = response.ok ? attemptFromStart(data, Date.now()) : null;
      if (attempt) {
        setStart(attempt);
      } else {
        failed(startErrorLines(response.status, initData, t), !refusedCredential(response.status), `HTTP ${response.status}`);
      }
    } catch (error) {
      console.error('[refresh-token] starting the Google sign-in threw:', error);
      failed([t.startFailed], true, error instanceof Error ? error.message : String(error));
    }
  }, [userId, t]);

  useEffect(() => {
    mounted.current = true;
    void prepare(true);
    return () => {
      mounted.current = false;
    };
  }, [prepare]);

  // The error notice's Try again: the page's own start, once more
  const retryStart = () => {
    setStartError(null);
    void prepare(true);
  };

  // A URL nobody tapped is replaced before its state ends (a backgrounded page's timer runs on return)
  useEffect(() => {
    if (!start) return;
    const timer = setTimeout(() => void prepare(), Math.max(0, start.preparedAt + URL_FRESH_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [start, prepare]);

  // quiet: the interval poll, which says nothing unless the connection landed. A check the person asks for while one is
  // on its way says it is checking at once and is made when that one answers "not yet" (one request at a time).
  const checkTokenRefresh = useCallback(async (quiet = false) => {
    const pending = localStorage.getItem(OAUTH_PENDING_KEY);
    if (!pending) return;
    if (checkInFlight.current) {
      if (!quiet) {
        checkAsked.current = true;
        setIsChecking(true);
      }
      return;
    }

    checkInFlight.current = true;
    if (!quiet) setIsChecking(true);
    try {
      const { userId: pendingUserId, startTime } = JSON.parse(pending);
      for (;;) {
        checkAsked.current = false;
        // initData goes in a header, never the URL: it is a credential for 24 hours, and
        // URLs end up in logs and traces. since: only a commit after this attempt counts, so
        // a connect from minutes ago can't skip the consent that's still open
        const initData = readInitData();
        const response = await fetch(`/api/check-token-refresh?user_id=${pendingUserId}&since=${startTime}`, {
          credentials: 'same-origin',
          headers: initData ? { 'X-Telegram-Init-Data': initData } : undefined,
        });
        const data = await response.json();

        if (data.refreshed) {
          setIsChecking(true);
          // Clear the pending flag
          localStorage.removeItem(OAUTH_PENDING_KEY);
          // Navigate to calendar selection with user's locale
          window.location.href = `/${locale}/select-calendars?user_id=${pendingUserId}`;
          return;
        }
        // Not yet. The person tapped Check again while this one was on its way: ask once more, for them
        if (!checkAsked.current) break;
      }
      setIsChecking(false);
    } catch (error) {
      console.error('[refresh-token] checking the connection failed:', error);
      checkAsked.current = false;
      setIsChecking(false);
    } finally {
      checkInFlight.current = false;
    }
  }, [locale]);

  const startOAuth = useCallback(() => {
    if (!start) {
      if (retry) void prepare();
      return;
    }
    if (Date.now() - start.preparedAt >= URL_FRESH_MS) {
      // Its state is about to end: Google would only lead to "expired". The next tap gets a new one.
      void prepare();
      return;
    }

    // Save pending OAuth flag
    localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({
      userId,
      startTime: attemptSince(start.clockOffset, Date.now())
    }));

    // Open OAuth in external browser
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.openLink(start.oauthUrl);
    } else {
      window.open(start.oauthUrl, '_blank');
    }
    // With initData the finish is in Telegram; on the WhatsApp session, in WhatsApp
    setWaiting({ since: Date.now(), telegram: readInitData() !== '' });
    setTimedOut(false);
    // This URL's state is spent once its consent finishes: the next tap opens a new one
    void prepare();
  }, [start, retry, userId, prepare]);

  useEffect(() => {
    // Initialize Telegram WebApp if available
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }

    // Listen for visibility changes to detect return from OAuth
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Small delay to ensure OAuth callback has completed
        setTimeout(() => checkTokenRefresh(), 500);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also check on mount in case user already completed OAuth. It reads localStorage,
    // which exists only on the client, so the check must run after mount.
    checkTokenRefresh();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkTokenRefresh]);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (Date.now() - waiting.since > POLL_WINDOW_MS) {
        clearInterval(timer);
        // The poll stops here: the notice says so, and Check again still asks
        setTimedOut(true);
        return;
      }
      checkTokenRefresh(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [waiting, checkTokenRefresh]);

  // The calendar, with a full load: this page is outside [locale]
  const back = () => {
    window.location.href = `/${locale}/dashboard?user_id=${userId}`;
  };
  const preparing = !oauthUrl && !retry;

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <style>{CONNECT_CSS}</style>
      <ScreenHeader title={t.title} backLabel={t.back} onBack={back} />
      <div className="ch-form-page ch-form-page-grouped">
        <ConnectHero icon={<CalendarSync aria-hidden="true" />} lead={t.subtitle} />
        <SectionLabel>{t.stepsTitle}</SectionLabel>
        {/* role="list": its markers are off and its numbers drawn, and WebKit drops the list's role otherwise */}
        <ol className="ch-form-card ch-connect-steps" role="list">
          {[t.step1, t.step2, t.step3].map((step, i) => (
            <li key={i} className="ch-form-row ch-connect-step">
              <span className="ch-connect-num" aria-hidden="true">{i + 1}</span>
              <span className="ch-form-label">{step}</span>
            </li>
          ))}
        </ol>
        <div className="ch-connect-actions">
          {startError ? (
            <Notice tone="error" action={startError.canRetry ? { label: t.retry, onClick: retryStart } : undefined}>
              {startError.lines.map((line, i) => (
                <Fragment key={line}>
                  {i > 0 ? <br /> : null}
                  {i === 0 && startError.lines.length > 1 ? <strong>{line}</strong> : line}
                </Fragment>
              ))}
            </Notice>
          ) : (
            <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={preparing} aria-busy={preparing || undefined} onClick={startOAuth}>
              {preparing ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
              {preparing ? t.preparing : t.button}
            </button>
          )}
          {/* While a check runs the notice says so in place of its text; the page and Check again stay, so focus does */}
          {waiting ? (
            <Notice action={{ label: t.checkAgain, onClick: () => void checkTokenRefresh() }}>
              {isChecking ? (
                <ConnectChecking label={t.checking} />
              ) : (
                <>
                  {waiting.telegram ? t.waitingTelegram : t.waitingWhatsApp}
                  {timedOut ? (
                    <>
                      <br />
                      {t.stillWaiting}
                    </>
                  ) : null}
                </>
              )}
            </Notice>
          ) : isChecking ? (
            <Notice>
              <ConnectChecking label={t.checking} />
            </Notice>
          ) : null}
        </div>
      </div>
    </AppScreen>
  );
}
