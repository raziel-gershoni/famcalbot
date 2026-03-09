import { redirect } from 'next/navigation';
import crypto from 'crypto';
import { prisma } from '@/src/utils/prisma';
import { getUserByTelegramId } from '@/src/services/user-service';
import { XCircle } from 'lucide-react';
import RefreshTokenClient from './RefreshTokenClient';
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';
import ruMessages from '@/messages/ru.json';
import { buildUrl } from '@/src/config/urls';

interface PageProps {
  searchParams: Promise<{
    code?: string;
    state?: string;
    user_id?: string;
  }>;
}

// OAuth scopes
const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar.events';

export default async function RefreshTokenPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { code, state, user_id } = params;

  // If OAuth callback → redirect to dedicated handler
  if (code && state) {
    redirect(`/oauth-callback?code=${code}&state=${state}`);
  }

  // Otherwise → show auth initiation page
  if (!user_id) {
    return (
      <div style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: 0,
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
          maxWidth: '400px',
          textAlign: 'center'
        }}>
          <div style={{ marginBottom: '20px' }}><XCircle size={64} color="#ef4444" /></div>
          <h2 style={{ margin: '0 0 20px 0', color: '#333' }}>Missing Parameter</h2>
          <p style={{ color: '#666', lineHeight: '1.6' }}>
            Missing user_id parameter. Please use the link provided by the bot.
          </p>
        </div>
      </div>
    );
  }

  // Get user's language preference (already normalized to 'he'/'ru'/'en')
  const user = await getUserByTelegramId(parseInt(user_id));
  const locale = user?.language || 'en';
  const messages = { en: enMessages, he: heMessages, ru: ruMessages }[locale] ?? enMessages;
  const t = messages.refreshToken;

  // Generate secure state token
  const stateToken = crypto.randomBytes(32).toString('hex');

  // Store state in database with 10-minute expiration
  await prisma.oAuthState.create({
    data: {
      userId: BigInt(user_id),
      token: stateToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    }
  });

  // Always request both read and write scopes for full functionality
  const oauthScope = `${CALENDAR_SCOPE_READ} ${CALENDAR_SCOPE_WRITE}`;

  // Generate OAuth URL
  const baseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const redirectUri = buildUrl('/api/refresh-token');
  const urlParams = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: oauthScope,
    access_type: 'offline',
    prompt: 'consent', // Force consent to get refresh token
    state: stateToken // Secure random token
  });

  const oauthUrl = `${baseUrl}?${urlParams.toString()}`;

  return <RefreshTokenClient oauthUrl={oauthUrl} userId={user_id} locale={locale} translations={t} />;
}
