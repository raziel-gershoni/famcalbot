import { redirect } from 'next/navigation';
import { prisma } from '@/src/utils/prisma';
import { getUserByTelegramId, updateGoogleRefreshToken } from '@/src/services/user-service';
import { normalizeLocale } from '@/src/utils/locale';
import { XCircle, AlertTriangle } from 'lucide-react';
import { buildUrl } from '@/src/config/urls';
import { updateUserInCache } from '@/src/services/reminder-cache';
import { getTranslations } from 'next-intl/server';
import { captureError } from '@/src/lib/error-capture';

interface PageProps {
  searchParams: Promise<{
    code?: string;
    state?: string;
  }>;
}

// Error page component
function ErrorPage({ message, telegramId }: { message: string; telegramId?: bigint }) {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
          {telegramId && (
            <a href={`/refresh-token?user_id=${telegramId}`} className="btn">
              Try Again
            </a>
          )}
        </div>
      </body>
    </html>
  );
}

// No refresh token error page
function NoRefreshTokenPage({ telegramId }: { telegramId: bigint }) {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
          <a href={`/refresh-token?user_id=${telegramId}`} className="btn">
            Try Again
          </a>
        </div>
      </body>
    </html>
  );
}

// Insufficient scopes error page - shown when user deselects permissions on Google consent screen
async function InsufficientScopesPage({ telegramId, missingScopes, locale }: { telegramId: bigint; missingScopes: string[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'oauth.insufficientScopes' });
  const missingRead = missingScopes.some(s => s.includes('readonly'));
  const missingWrite = missingScopes.some(s => s.includes('events'));
  const isRtl = locale === 'he';

  return (
    <html dir={isRtl ? 'rtl' : 'ltr'}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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

          <a href={`/refresh-token?user_id=${telegramId}`} className="btn">
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

  const telegramId = stateRecord.userId;

  // Delete used state token (one-time use only)
  await prisma.oAuthState.delete({ where: { id: stateRecord.id } });

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
        telegramId={telegramId}
      />
    );
  }

  const tokens = await tokenResponse.json();

  // Get user to verify and get locale for i18n
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    return <ErrorPage message="User not found" telegramId={telegramId} />;
  }

  const userLocale = normalizeLocale(user.language);

  // Check if all required scopes were granted
  const REQUIRED_SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events'
  ];

  const grantedScopes = (tokens.scope || '').split(' ');
  const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));

  if (missingScopes.length > 0) {
    return <InsufficientScopesPage telegramId={telegramId} missingScopes={missingScopes} locale={userLocale} />;
  }

  if (!tokens.refresh_token) {
    // No refresh token - need to revoke and retry
    return <NoRefreshTokenPage telegramId={telegramId} />;
  }

  // Save new refresh token (user already verified above)
  try {
    await updateGoogleRefreshToken(telegramId, tokens.refresh_token);

    // Update reminder cache if user has reminders enabled
    if (user.remindersEnabled) {
      await updateUserInCache({
        id: user.id,
        telegramId: user.telegramId?.toString() ?? '',
        googleRefreshToken: tokens.refresh_token, // Fresh token (not encrypted)
        calendarAssignments: user.calendarAssignments,
        defaultReminderMinutes: user.defaultReminderMinutes ?? null,
        language: user.language,
        name: user.name,
        pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
      });
    }

    // Notify admin of successful token refresh
    const { notifyAdminWarning } = await import('@/src/utils/error-notifier');
    await notifyAdminWarning(
      'Token Refreshed',
      `User ${telegramId} (${user.name || 'Unknown'}) successfully refreshed their Google Calendar token`
    ).catch(err => captureError(err, 'oauth-admin-notify', {}, 'warning'));
  } catch (error) {
    captureError(error, 'oauth-save-token');
    return (
      <ErrorPage
        message={`Error saving token: ${error instanceof Error ? error.message : 'Unknown error'}`}
        telegramId={telegramId}
      />
    );
  }

  // Redirect to success page which will guide user back to Telegram
  redirect(`/oauth-complete?user_id=${telegramId}&locale=${userLocale}`);
}
