import { NextRequest, NextResponse } from 'next/server';
import { getBaseUrl } from '@/src/config/urls';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * OAuth callback handler
 * Google redirects here after user authorization with code and state params
 * Forwards to /oauth-callback page for token exchange
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (!code || !state) {
    return NextResponse.json(
      { error: 'Missing code or state parameter' },
      { status: 400 }
    );
  }

  // Redirect to oauth-callback page to handle token exchange. On the public URL, not
  // request.url: behind Railway's proxy that is Next's own http://localhost:8080.
  return NextResponse.redirect(
    new URL(`/oauth-callback?code=${code}&state=${state}`, getBaseUrl())
  );
}
