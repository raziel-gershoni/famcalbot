import { redirect } from 'next/navigation';
import { prisma } from '@/src/utils/prisma';
import { getUserById } from '@/src/services/user-service';
import { normalizeLocale } from '@/src/utils/locale';
import { XCircle, AlertTriangle } from 'lucide-react';
import { buildUrl } from '@/src/config/urls';
import { getTranslations } from 'next-intl/server';
import { captureError } from '@/src/lib/error-capture';
import { OAUTH_STATE_PREFIX } from '@/src/lib/oauth-state';
import { createPendingGoogleToken, finishPageUrl, type GoogleGrant } from '@/src/services/google-connect';
import { GOOGLE_CONNECT_SCOPES, parseGrantedScopes } from '@/src/services/google-sync/scopes';
import { googleAccountOf } from '@/src/services/google-sync/account';
import { googleFetch } from '@/src/services/google-retry';
import { DEFAULT_BOT_USERNAME } from '@/src/lib/gate-links';
import type { UserConfig } from '@/src/types';

interface PageProps {
  searchParams: Promise<{
    code?: string;
    state?: string;
  }>;
}

/**
 * Where "Try again" goes from the consent browser. That browser has no Telegram initData,
 * so /refresh-token would only show its gate to a Telegram user: send them back to the
 * bot. A WhatsApp-only user may have their session cookie here.
 */
function retryHrefFor(user: UserConfig): string {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  if (user.telegramId) return `https://t.me/${botUsername}?start=dashboard`;
  return `/refresh-token?user_id=${user.telegramId ?? user.id}`;
}

// Error page component. retryHref is the "Try again" link (retryHrefFor). The title, the
// button's text and the direction default to the English page.
function ErrorPage({ message, retryHref, title = 'Error', buttonText = 'Try Again', dir = 'ltr' }: {
  message: string;
  retryHref?: string;
  title?: string;
  buttonText?: string;
  dir?: 'ltr' | 'rtl';
}) {
  return (
    <html dir={dir}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- the Telegram WebApp SDK loads synchronously so window.Telegram exists before page code runs */}
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>{`
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 15px;
            max-width: 400px;
            text-align: center;
          }
          .icon { font-size: 64px; margin-bottom: 20px; }
          h2 { margin: 0 0 20px 0; color: #333; }
          p { color: #666; line-height: 1.6; margin-bottom: 15px; }
          a { color: #667eea; text-decoration: none; font-weight: 600; }
          .btn {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
          }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div className="icon"><XCircle size={64} color="#ef4444" /></div>
          <h2>{title}</h2>
          <p>{message}</p>
          {retryHref !== undefined && (
            <a href={retryHref} className="btn">
              {buttonText}
            </a>
          )}
        </div>
      </body>
    </html>
  );
}

// Google refused to exchange the code (exchangeRefusal): the sign-in starts again from FamCal
async function ExchangeFailedPage({ locale, retryHref }: { locale: string; retryHref: string }) {
  const t = await getTranslations({ locale, namespace: 'oauth.exchangeFailed' });
  return <ErrorPage title={t('title')} message={t('message')} buttonText={t('tryAgain')} retryHref={retryHref} dir={locale === 'he' ? 'rtl' : 'ltr'} />;
}

/** Google's token endpoint answer, as far as the callback reads it. */
interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Why Google refused the exchange, for the log: the status, and its OAuth error and
 * description when the body has them ('HTTP 400 invalid_grant: Bad Request'). Never the code
 * or a token. null when the answer is a success.
 */
function exchangeRefusal(status: number, ok: boolean, answer: TokenAnswer | null): string | null {
  if (ok && answer && answer.error === undefined) return null;
  const error = typeof answer?.error === 'string' ? ` ${answer.error}` : '';
  const description = error && typeof answer?.error_description === 'string' ? `: ${answer.error_description}` : '';
  return `HTTP ${status}${error}${description}${answer ? '' : ' (no JSON body)'}`;
}

// No refresh token error page
function NoRefreshTokenPage({ retryHref }: { retryHref: string }) {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- the Telegram WebApp SDK loads synchronously so window.Telegram exists before page code runs */}
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>{`
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 15px;
            max-width: 400px;
            text-align: center;
          }
          .icon { font-size: 64px; margin-bottom: 20px; }
          h2 { margin: 0 0 20px 0; color: #333; }
          p { color: #666; line-height: 1.6; }
          a { color: #667eea; text-decoration: none; font-weight: 600; }
          .btn {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
          }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div className="icon"><AlertTriangle size={64} color="#f59e0b" /></div>
          <h2>One More Step</h2>
          <p>Google didn&apos;t provide a new refresh token because you&apos;ve authorized before.</p>
          <p><strong>Please revoke access first:</strong></p>
          <p>1. Go to <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">Google Permissions</a></p>
          <p>2. Remove &quot;FamCalBot&quot;</p>
          <p>3. Come back and try again</p>
          <a href={retryHref} className="btn">
            Try Again
          </a>
        </div>
      </body>
    </html>
  );
}

// Insufficient scopes error page - shown when user deselects permissions on Google consent screen
async function InsufficientScopesPage({ retryHref, missingScopes, locale }: { retryHref: string; missingScopes: string[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'oauth.insufficientScopes' });
  const missingRead = missingScopes.some(s => s.includes('readonly'));
  const missingWrite = missingScopes.some(s => s.includes('events'));
  const isRtl = locale === 'he';

  return (
    <html dir={isRtl ? 'rtl' : 'ltr'}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- the Telegram WebApp SDK loads synchronously so window.Telegram exists before page code runs */}
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>{`
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 15px;
            max-width: 420px;
            text-align: center;
          }
          h2 { margin: 0 0 15px 0; color: #333; }
          p { color: #666; line-height: 1.6; margin-bottom: 15px; }
          .highlight {
            background: #fef3c7;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            text-align: ${isRtl ? 'right' : 'left'};
          }
          .highlight strong { color: #92400e; }
          .permission {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 10px 0;
            padding: 10px;
            border-radius: 6px;
          }
          .permission.granted { background: #d1fae5; }
          .permission.missing { background: #fee2e2; }
          .checkbox { font-size: 20px; }
          .btn {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
          }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div style={{ fontSize: '48px', marginBottom: '15px' }}>&#9888;&#65039;</div>
          <h2>{t('title')}</h2>
          <p dangerouslySetInnerHTML={{ __html: t('description') }} />

          <div className="highlight">
            <strong>{t('checkAll')}</strong>
            <div className={`permission ${missingRead ? 'missing' : 'granted'}`}>
              <span className="checkbox">{missingRead ? '☐' : '☑️'}</span>
              <span><strong>{t('viewCalendar')}</strong> — {t('viewCalendarDesc')}</span>
            </div>
            <div className={`permission ${missingWrite ? 'missing' : 'granted'}`}>
              <span className="checkbox">{missingWrite ? '☐' : '☑️'}</span>
              <span><strong>{t('editEvents')}</strong> — {t('editEventsDesc')}</span>
            </div>
          </div>

          <p style={{ fontSize: '14px', color: '#888' }}>
            {t('footnote')}
          </p>

          <a href={retryHref} className="btn">
            {t('tryAgain')}
          </a>
        </div>
      </body>
    </html>
  );
}

export default async function OAuthCallbackPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { code, state } = params;

  // Validate state token
  if (!state || typeof state !== 'string') {
    return <ErrorPage message="Missing or invalid state parameter" />;
  }

  // Only states from POST /api/oauth/start (bound to an authenticated user) are
  // honoured. An unprefixed one came from the old unauthenticated /refresh-token page.
  if (!state.startsWith(OAUTH_STATE_PREFIX)) {
    return <ErrorPage message="State token expired. Please try again." />;
  }

  // Look up state token in database
  const stateRecord = await prisma.oAuthState.findUnique({ where: { token: state } });

  // Validate state exists
  if (!stateRecord) {
    return <ErrorPage message="Invalid or expired state token. Please try again." />;
  }

  // Use the state up (one-time use only). deleteMany checks and deletes in one statement,
  // so of two callbacks with the same state only one gets count 1; the other is refused
  // here instead of failing on a row that is already gone.
  const { count } = await prisma.oAuthState.deleteMany({ where: { id: stateRecord.id } });
  if (count !== 1) {
    return <ErrorPage message="Invalid or expired state token. Please try again." />;
  }

  // Validate state hasn't expired
  if (stateRecord.expiresAt < new Date()) {
    return <ErrorPage message="State token expired. Please try again." />;
  }

  // The state holds the DB id of the user oauth/start authenticated. Resolve it before
  // talking to Google: the token can be committed on this user and no other.
  const user = await getUserById(Number(stateRecord.userId));
  if (!user) {
    return <ErrorPage message="User not found" />;
  }
  const retryHref = retryHrefFor(user);

  // Exchange code for tokens. googleFetch retries a rate limit or a 5xx on the token endpoint
  // (the state is used up already, so a failure here is a "try again" page); a code Google
  // had redeemed before the answer was lost comes back invalid_grant, the page it would have been.
  const redirectUri = buildUrl('/api/refresh-token');
  let tokenResponse;

  try {
    tokenResponse = await googleFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
  } catch (error) {
    captureError(error, 'oauth-token-exchange');
    return (
      <ErrorPage
        message={`Error exchanging authorization code: ${error instanceof Error ? error.message : 'Unknown error'}`}
        retryHref={retryHref}
      />
    );
  }

  const userLocale = normalizeLocale(user.language);

  // Google's answer. A refusal (invalid_grant: a code used already or expired;
  // redirect_uri_mismatch; invalid_client) has no scope list, so it used to show as the
  // permissions page. It is its own page, logged with Google's reason.
  const tokens: TokenAnswer | null = await tokenResponse.json().catch((error: unknown) => {
    console.warn(`[oauth-callback] user ${user.id}: Google's token answer (HTTP ${tokenResponse.status}) isn't JSON:`, error instanceof Error ? error.message : String(error));
    return null;
  });
  const refusal = exchangeRefusal(tokenResponse.status, tokenResponse.ok, tokens);
  if (refusal || !tokens) {
    console.error(`[oauth-callback] user ${user.id}: Google refused the code exchange (${refusal})`);
    captureError(new Error(`Google refused the code exchange (${refusal})`), 'oauth-token-exchange', { user_id: user.id, purpose: stateRecord.purpose ?? 'connect' });
    return <ExchangeFailedPage locale={userLocale} retryHref={retryHref} />;
  }

  // Check if all required scopes were granted. Connecting needs the two calendar scopes
  // only; a 'sync' consent's calendar.app.created may be unticked, and the copy then waits
  // in 'scopes' (google-sync spec §3).
  const grantedScopes = parseGrantedScopes(tokens.scope);
  const missingScopes = GOOGLE_CONNECT_SCOPES.filter(s => !grantedScopes.includes(s));

  if (missingScopes.length > 0) {
    return <InsufficientScopesPage retryHref={retryHref} missingScopes={missingScopes} locale={userLocale} />;
  }

  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!refreshToken) {
    // No refresh token - need to revoke and retry
    return <NoRefreshTokenPage retryHref={retryHref} />;
  }

  // Nothing is saved here. This browser finished Google's consent, but the state only says
  // who started it, and anyone can start one and send the Google URL to someone else. So
  // the token waits in Redis until the state's owner claims it from their own Telegram or
  // WhatsApp (src/services/google-connect.ts).
  // What the commit saves with the token: the granted scopes, and for a 'sync' consent the
  // calendar to copy and the account it goes to (googleAccountOf: the token carries no id
  // token). An account Google doesn't tell stays unknown, logged; the copy still starts.
  const grant: GoogleGrant = { scopes: grantedScopes };
  if (stateRecord.purpose === 'sync' && stateRecord.nativeCalendarId) {
    let googleAccount: string | null = null;
    try {
      googleAccount = await googleAccountOf(String(tokens.access_token ?? ''));
    } catch (error) {
      console.warn(`[oauth-callback] user ${user.id}: the Google account of a sync consent is unknown:`, error instanceof Error ? error.message : String(error));
      captureError(error, 'google-sync-account', { user_id: user.id }, 'warning');
    }
    grant.sync = { nativeCalendarId: stateRecord.nativeCalendarId, googleAccount };
  }

  let pendingId: string;
  try {
    pendingId = await createPendingGoogleToken(user.id, refreshToken, grant);
  } catch (error) {
    captureError(error, 'oauth-save-token');
    return (
      <ErrorPage
        message={`Error saving token: ${error instanceof Error ? error.message : 'Unknown error'}`}
        retryHref={retryHref}
      />
    );
  }

  // The finish page, with the pendingId in the URL fragment: a reload keeps it, and it
  // never reaches a server or a Referer
  redirect(finishPageUrl(userLocale, pendingId, user));
}
