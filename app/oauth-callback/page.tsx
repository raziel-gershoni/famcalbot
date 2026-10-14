import { redirect } from 'next/navigation';
import { prisma } from '@/src/utils/prisma';
import { getUserById, updateUserById } from '@/src/services/user-service';
import { normalizeLocale } from '@/src/utils/locale';
import { XCircle, AlertTriangle } from 'lucide-react';
import { buildUrl } from '@/src/config/urls';
import { updateUserInCache } from '@/src/services/reminder-cache';
import { getTranslations } from 'next-intl/server';
import { captureError } from '@/src/lib/error-capture';
import { OAUTH_STATE_PREFIX } from '@/src/lib/oauth-state';

interface PageProps {
  searchParams: Promise<{
    code?: string;
    state?: string;
  }>;
}

// Error page component. retryUserId is the user_id for the retry link (telegramId ?? DB id).
function ErrorPage({ message, retryUserId }: { message: string; retryUserId?: number }) {
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
          <h2>Error</h2>
          <p>{message}</p>
          {retryUserId !== undefined && (
            <a href={`/refresh-token?user_id=${retryUserId}`} className="btn">
              Try Again
            </a>
          )}
        </div>
      </body>
    </html>
  );
}

// No refresh token error page
function NoRefreshTokenPage({ retryUserId }: { retryUserId: number }) {
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
          <a href={`/refresh-token?user_id=${retryUserId}`} className="btn">
            Try Again
          </a>
        </div>
      </body>
    </html>
  );
}

// Insufficient scopes error page - shown when user deselects permissions on Google consent screen
async function InsufficientScopesPage({ retryUserId, missingScopes, locale }: { retryUserId: number; missingScopes: string[]; locale: string }) {
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

          <a href={`/refresh-token?user_id=${retryUserId}`} className="btn">
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

  // Validate state hasn't expired
  if (stateRecord.expiresAt < new Date()) {
    await prisma.oAuthState.delete({ where: { id: stateRecord.id } });
    return <ErrorPage message="State token expired. Please try again." />;
  }

  // Delete used state token (one-time use only)
  await prisma.oAuthState.delete({ where: { id: stateRecord.id } });

  // The state holds the DB id of the user oauth/start authenticated. Resolve it before
  // talking to Google: the token is saved on this user and no other.
  const user = await getUserById(Number(stateRecord.userId));
  if (!user) {
    return <ErrorPage message="User not found" />;
  }
  const retryUserId = user.telegramId ?? user.id;

  // Exchange code for tokens
  const redirectUri = buildUrl('/api/refresh-token');
  let tokenResponse;

  try {
    tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
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
        retryUserId={retryUserId}
      />
    );
  }

  const tokens = await tokenResponse.json();

  const userLocale = normalizeLocale(user.language);

  // Check if all required scopes were granted
  const REQUIRED_SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events'
  ];

  const grantedScopes = (tokens.scope || '').split(' ');
  const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));

  if (missingScopes.length > 0) {
    return <InsufficientScopesPage retryUserId={retryUserId} missingScopes={missingScopes} locale={userLocale} />;
  }

  if (!tokens.refresh_token) {
    // No refresh token - need to revoke and retry
    return <NoRefreshTokenPage retryUserId={retryUserId} />;
  }

  // Save new refresh token on the authenticated owner, by DB id (updateUserById encrypts it)
  try {
    await updateUserById(user.id, { googleRefreshToken: tokens.refresh_token });

    // If the user was previously on NATIVE, completing OAuth is an explicit
    // opt-in to GOOGLE. Flip calendarSource and soft-delete the auto-created
    // native calendar so the model stays "either/or per user" (locked
    // product decision). The native calendar row is preserved (isDeleted=true)
    // in case the user ever switches back; the in-bot calendar UI hides it.
    if (user.calendarSource === 'NATIVE') {
      const { prisma } = await import('@/src/utils/prisma');
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { calendarSource: 'GOOGLE' },
        });
        await tx.nativeCalendar.updateMany({
          where: { ownerUserId: user.id, isDeleted: false },
          data: { isDeleted: true },
        });
      });
    }

    // Update reminder cache if user has reminders enabled
    if (user.remindersEnabled) {
      await updateUserInCache({
        id: user.id,
        telegramId: user.telegramId?.toString() ?? '',
        googleRefreshToken: tokens.refresh_token, // Fresh token (not encrypted)
        calendarAssignments: user.calendarAssignments,
        calendarSource: 'GOOGLE', // Completing OAuth switches a NATIVE user to Google (above)
        pairingId: user.pairingId,
        defaultReminderMinutes: user.defaultReminderMinutes ?? null,
        language: user.language,
        name: user.name,
        pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
        location: user.location,
      });
    }

    // Notify admin of successful token refresh
    const { notifyAdminWarning } = await import('@/src/utils/error-notifier');
    await notifyAdminWarning(
      'Token Refreshed',
      `User ${retryUserId} (${user.name || 'Unknown'}) successfully refreshed their Google Calendar token`
    ).catch(err => captureError(err, 'oauth-admin-notify', {}, 'warning'));
  } catch (error) {
    captureError(error, 'oauth-save-token');
    return (
      <ErrorPage
        message={`Error saving token: ${error instanceof Error ? error.message : 'Unknown error'}`}
        retryUserId={retryUserId}
      />
    );
  }

  // Redirect to success page which will guide user back to Telegram
  redirect(`/oauth-complete?user_id=${retryUserId}&locale=${userLocale}`);
}
