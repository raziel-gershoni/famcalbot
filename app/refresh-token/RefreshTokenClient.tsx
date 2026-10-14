'use client';

import { useEffect, useCallback, useState } from 'react';
import { RefreshCw, KeyRound, ArrowLeft, Loader2 } from 'lucide-react';

interface Translations {
  title: string;
  subtitle: string;
  stepsTitle: string;
  step1: string;
  step2: string;
  step3: string;
  button: string;
  checking: string;
  openFromBot: string;
  sessionExpired: string;
  startFailed: string;
}

interface RefreshTokenClientProps {
  userId: string;
  locale: string;
  translations: Translations;
}

const OAUTH_PENDING_KEY = 'famcalbot_oauth_pending';

/**
 * The Mini App's signed initData: from the Telegram SDK when it is loaded, else from
 * the launch URL's hash, where Telegram puts it (tgWebAppData). '' in a plain browser.
 */
function readInitData(): string {
  if (typeof window === 'undefined') return '';
  const fromSdk = window.Telegram?.WebApp?.initData;
  if (fromSdk) return fromSdk;
  try {
    return new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData') ?? '';
  } catch {
    return '';
  }
}

export default function RefreshTokenClient({ userId, locale, translations: t }: RefreshTokenClientProps) {
  const isRTL = locale === 'he';
  const [isChecking, setIsChecking] = useState(false);
  // The Google URL comes from POST /api/oauth/start, which creates the OAuth state for
  // the user our credential proves. Until it arrives the button stays disabled.
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

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
        if (response.ok && typeof data.oauthUrl === 'string') {
          setOauthUrl(data.oauthUrl);
        } else if (response.status === 401 || response.status === 403 || response.status === 404) {
          // No credential for this user: inside Telegram, reopen from the bot; in a
          // browser, the WhatsApp link has expired
          setStartError(initData ? t.openFromBot : t.sessionExpired);
        } else {
          setStartError(t.startFailed);
        }
      } catch (error) {
        console.error('Error starting Google sign-in:', error);
        if (!cancelled) setStartError(t.startFailed);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, t.openFromBot, t.sessionExpired, t.startFailed]);

  const checkTokenRefresh = useCallback(async () => {
    const pending = localStorage.getItem(OAUTH_PENDING_KEY);
    if (!pending) return;

    setIsChecking(true);
    try {
      const { userId: pendingUserId, startTime } = JSON.parse(pending);
      const initData = encodeURIComponent(readInitData());
      const response = await fetch(`/api/check-token-refresh?user_id=${pendingUserId}&since=${startTime}&initData=${initData}`, {
        credentials: 'same-origin',
      });
      const data = await response.json();

      if (data.refreshed) {
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
    }
  }, [locale]);

  const startOAuth = useCallback(() => {
    if (!oauthUrl) return;

    // Save pending OAuth flag
    localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({
      userId,
      startTime: Date.now()
    }));

    // Open OAuth in external browser
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.openLink(oauthUrl);
    } else {
      window.open(oauthUrl, '_blank');
    }
  }, [oauthUrl, userId]);

  useEffect(() => {
    // Initialize Telegram WebApp if available
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      window.Telegram.WebApp.expand();
    }

    // Listen for visibility changes to detect return from OAuth
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Small delay to ensure OAuth callback has completed
        setTimeout(checkTokenRefresh, 500);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also check on mount in case user already completed OAuth
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads localStorage, which exists only on the client, so the check must run after mount
    checkTokenRefresh();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkTokenRefresh]);

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
          <p className="subtitle" role="alert">{startError}</p>
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
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `https://telegram.org/js/telegram-web-app.js`,
        }}
      />
    </>
  );
}
