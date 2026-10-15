'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { RefreshCw, KeyRound, ArrowLeft, Loader2 } from 'lucide-react';
import { readInitData } from '@/src/lib/read-init-data';

interface Translations {
  title: string;
  subtitle: string;
  stepsTitle: string;
  step1: string;
  step2: string;
  step3: string;
  button: string;
  checking: string;
  startFailed: string;
  /** Shown after Google opens: finish there, then tap the finish page's button */
  waitingTelegram: string;
  waitingWhatsApp: string;
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
 * What the page says when oauth/start gives no Google URL. With no credential it says
 * what PageGate says: inside Telegram, reopen from the bot; in a browser, the WhatsApp
 * link has expired, or, on Telegram, open it from the bot (oauth-callback's "Try again"
 * lands a Telegram user here in the external browser).
 */
export function startErrorLines(status: number, initData: string, t: Translations): string[] {
  if (status === 401 || status === 403 || status === 404) {
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
export function attemptFromStart(data: unknown, clientNow: number): { oauthUrl: string; clockOffset: number } | null {
  const { oauthUrl, serverTime } = (data ?? {}) as { oauthUrl?: unknown; serverTime?: unknown };
  if (typeof oauthUrl !== 'string') return null;
  const clockOffset = typeof serverTime === 'number' && Number.isFinite(serverTime) ? serverTime - clientNow : 0;
  return { oauthUrl, clockOffset };
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
  const isRTL = locale === 'he';
  const [isChecking, setIsChecking] = useState(false);
  // The Google URL comes from POST /api/oauth/start, which creates the OAuth state for
  // the user our credential proves, with the server's clock offset (attemptFromStart).
  // Until it arrives the button stays disabled.
  const [start, setStart] = useState<{ oauthUrl: string; clockOffset: number } | null>(null);
  const oauthUrl = start?.oauthUrl ?? null;
  const [startError, setStartError] = useState<string[] | null>(null);
  // Set when Google opens: when, and whether the finish is in Telegram or WhatsApp
  const [waiting, setWaiting] = useState<{ since: number; telegram: boolean } | null>(null);
  const checkInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const initData = readInitData();
    (async () => {
      try {
        const response = await fetch('/api/oauth/start', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, initData }),
        });
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        const attempt = response.ok ? attemptFromStart(data, Date.now()) : null;
        if (attempt) {
          setStart(attempt);
        } else {
          setStartError(startErrorLines(response.status, initData, t));
        }
      } catch (error) {
        console.error('Error starting Google sign-in:', error);
        if (!cancelled) setStartError([t.startFailed]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, t]);

  // quiet: the interval poll, which shows no overlay unless the connection landed
  const checkTokenRefresh = useCallback(async (quiet = false) => {
    const pending = localStorage.getItem(OAUTH_PENDING_KEY);
    if (!pending || checkInFlight.current) return;

    checkInFlight.current = true;
    if (!quiet) setIsChecking(true);
    try {
      const { userId: pendingUserId, startTime } = JSON.parse(pending);
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
      } else {
        setIsChecking(false);
      }
    } catch (error) {
      console.error('Error checking token refresh:', error);
      setIsChecking(false);
    } finally {
      checkInFlight.current = false;
    }
  }, [locale]);

  const startOAuth = useCallback(() => {
    if (!start) return;

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
  }, [start, userId]);

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
        return;
      }
      checkTokenRefresh(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [waiting, checkTokenRefresh]);

  useEffect(() => {
    // The Telegram MainButton appears once the Google URL is ready
    const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
    if (!tg || !oauthUrl) return;
    tg.MainButton.setText('Connect Google Calendar');
    tg.MainButton.onClick(startOAuth);
    tg.MainButton.show();
    return () => {
      tg.MainButton.offClick(startOAuth);
    };
  }, [oauthUrl, startOAuth]);

  return (
    <>
      <style jsx global>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: 'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0;
          padding: 20px;
        }
      `}</style>

      <style jsx>{`
        .container {
          background: white;
          padding: 50px 40px;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 450px;
          text-align: center;
          animation: slideUp 0.5s ease-out;
        }

        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .icon-wrapper {
          width: 80px;
          height: 80px;
          margin: 0 auto 30px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          animation: scaleIn 0.6s ease-out 0.2s both;
        }

        @keyframes scaleIn {
          from {
            transform: scale(0);
          }
          to {
            transform: scale(1);
          }
        }

        h2 {
          margin: 0 0 15px 0;
          color: #1f2937;
          font-size: 28px;
          font-weight: 600;
        }

        .subtitle {
          color: #6b7280;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 30px;
        }

        .steps {
          text-align: left;
          background: #f3f4f6;
          padding: 20px;
          border-radius: 12px;
          margin-bottom: 30px;
        }

        .steps strong {
          color: #374151;
          font-size: 15px;
        }

        .steps ol {
          margin: 12px 0 0 0;
          padding-left: 20px;
        }

        .steps li {
          margin-bottom: 8px;
          color: #4b5563;
          font-size: 14px;
          line-height: 1.5;
        }

        .steps li:last-child {
          margin-bottom: 0;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          width: 100%;
          padding: 16px 24px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          text-decoration: none;
          border: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 16px rgba(102, 126, 234, 0.5);
        }

        .btn:active {
          transform: translateY(0);
        }

        .back-button {
          position: absolute;
          top: 20px;
          left: 20px;
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: white;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
          backdrop-filter: blur(10px);
        }

        .back-button:hover {
          background: rgba(255, 255, 255, 0.3);
        }

        .loading-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(255, 255, 255, 0.95);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          z-index: 100;
          gap: 20px;
        }

        .spinner {
          animation: spin 1s linear infinite;
          color: #667eea;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .loading-text {
          color: #4b5563;
          font-size: 16px;
          font-weight: 500;
        }

        .waiting {
          margin-top: 20px;
          color: #4b5563;
          font-size: 15px;
          line-height: 1.6;
        }
      `}</style>

      {isChecking && (
        <div className="loading-overlay">
          <Loader2 size={48} style={{ animation: 'spin 1s linear infinite', color: '#667eea' }} />
          <div className="loading-text">{t.checking}</div>
        </div>
      )}

      <button
        className="back-button"
        style={isRTL ? { left: 'auto', right: '20px' } : undefined}
        onClick={() => window.history.back()}
        aria-label="Go back"
      >
        <ArrowLeft size={20} style={isRTL ? { transform: 'scaleX(-1)' } : undefined} />
      </button>

      <div className="container" style={{ direction: isRTL ? 'rtl' : 'ltr' }}>
        <div className="icon-wrapper">
          <RefreshCw size={48} color="white" />
        </div>

        <h2>{t.title}</h2>
        <p className="subtitle">{t.subtitle}</p>

        <div className="steps">
          <strong>{t.stepsTitle}</strong>
          <ol>
            <li>{t.step1}</li>
            <li>{t.step2}</li>
            <li>{t.step3}</li>
          </ol>
        </div>

        {startError ? (
          <div role="alert">
            {startError.map((line, i) => (
              <p key={line} className="subtitle">{i === 0 && startError.length > 1 ? <strong>{line}</strong> : line}</p>
            ))}
          </div>
        ) : (
          <button
            onClick={startOAuth}
            className="btn"
            disabled={!oauthUrl}
          >
            {oauthUrl ? <KeyRound size={20} /> : <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />}
            {t.button}
          </button>
        )}

        {waiting && (
          <p className="waiting" role="status">
            {waiting.telegram ? t.waitingTelegram : t.waitingWhatsApp}
          </p>
        )}
      </div>
    </>
  );
}
