import { NextRequest, NextResponse } from 'next/server';
import { getBaseUrl } from '@/src/config/urls';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Google's redirect URI after the consent screen. With a code and a state it forwards both to
 * the /oauth-callback page, which exchanges the code. Without a code (the person said no:
 * ?error=access_denied, or anything else) it forwards Google's error, or missing_code (a code
 * with no state: missing_state, and the code is dropped), with the state, and the callback shows
 * the card for it in the person's language.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  // On the public URL, not request.url: behind Railway's proxy that is Next's own http://localhost:8080.
  if (!code || !state) {
    const error = searchParams.get('error') || (code ? 'missing_state' : 'missing_code');
    console.warn(`[refresh-token] Google came back without ${code ? 'a state' : 'a code'} (${error.slice(0, 60)})`);
    const query = new URLSearchParams({ error, ...(state ? { state } : {}) });
    return NextResponse.redirect(new URL(`/oauth-callback?${query.toString()}`, getBaseUrl()));
  }

  // Redirect to oauth-callback page to handle token exchange.
  return NextResponse.redirect(
    new URL(`/oauth-callback?code=${code}&state=${state}`, getBaseUrl())
  );
}
