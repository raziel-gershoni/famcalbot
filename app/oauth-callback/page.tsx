import { redirect } from 'next/navigation';
import { prisma } from '@/src/utils/prisma';
import { getUserByTelegramId, updateGoogleRefreshToken } from '@/src/services/user-service';
import { XCircle, AlertTriangle } from 'lucide-react';

interface PageProps {
  searchParams: Promise<{
    code?: string;
    state?: string;
  }>;
}

// Error page component
function ErrorPage({ message, telegramId }: { message: string; telegramId?: number }) {
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
function NoRefreshTokenPage({ telegramId }: { telegramId: number }) {
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

export default async function OAuthCallbackPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { code, state } = params;

  // Validate state token
  if (!state || typeof state !== 'string') {
    return <ErrorPage message="Missing or invalid state parameter" />;
  }

  // Look up state token in database
  const stateRecord = await prisma.oAuthState.findUnique({
    where: { token: state }
  });

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

  try {
    // Exchange code for tokens
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'https://famcalbot.vercel.app'}/api/refresh-token`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
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

    const tokens = await tokenResponse.json();

    if (!tokens.refresh_token) {
      // No refresh token - need to revoke and retry
      return <NoRefreshTokenPage telegramId={telegramId} />;
    }

    // Get user to verify
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      return <ErrorPage message="User not found" telegramId={telegramId} />;
    }

    // Save new refresh token
    await updateGoogleRefreshToken(telegramId, tokens.refresh_token);

    // Redirect to success page which will guide user back to Telegram
    const userLocale = user.language === 'Hebrew' ? 'he' : 'en';
    redirect(`/oauth-complete?user_id=${telegramId}&locale=${userLocale}`);
  } catch (error) {
    console.error('OAuth error:', error);
    return (
      <ErrorPage
        message={`Error during OAuth: ${error instanceof Error ? error.message : 'Unknown error'}`}
        telegramId={telegramId}
      />
    );
  }
}
