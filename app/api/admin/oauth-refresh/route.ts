import { NextRequest, NextResponse } from 'next/server';
import { getUserByTelegramId, updateGoogleRefreshToken } from '@/src/services/user-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (!code || typeof code !== 'string') {
    return new NextResponse(
      '<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h2>❌ Error</h2><p>Missing authorization code</p><p><a href="/admin">← Back to Admin</a></p></body></html>',
      {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }

  const telegramId = state ? parseInt(state) : null;
  if (!telegramId) {
    return new NextResponse(
      '<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h2>❌ Error</h2><p>Missing user ID</p><p><a href="/admin">← Back to Admin</a></p></body></html>',
      {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${request.nextUrl.origin}/api/admin/oauth-refresh`,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenResponse.json();

    if (!tokens.refresh_token) {
      return new NextResponse(
        '<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h2>❌ No Refresh Token</h2><p>Revoke access first at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">Google Permissions</a></p><p><a href="/admin">← Back to Admin</a></p></body></html>',
        {
          status: 400,
          headers: { 'Content-Type': 'text/html' }
        }
      );
    }

    await updateGoogleRefreshToken(telegramId, tokens.refresh_token);

    const user = await getUserByTelegramId(telegramId);

    return new NextResponse(
      `<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h2>✅ Success!</h2><p><strong>${user?.name}</strong><br>Token refreshed</p><p><a href="/admin">← Back to Admin</a></p></body></html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  } catch (error) {
    return new NextResponse(
      `<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h2>❌ Error</h2><p>${error instanceof Error ? error.message : 'Unknown error'}</p><p><a href="/admin">← Back to Admin</a></p></body></html>`,
      {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }
}
