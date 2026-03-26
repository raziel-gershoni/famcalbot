import { NextRequest, NextResponse } from 'next/server';
import { validateMagicToken } from '@/src/services/magic-link';
import { createSessionToken, SESSION_COOKIE } from '@/src/lib/session-auth';
import { getBaseUrl } from '@/src/config/urls';

/**
 * Magic link auth handler
 * Validates token, sets session cookie, redirects to dashboard
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.redirect(new URL('/', getBaseUrl()));
  }

  const data = await validateMagicToken(token);

  if (!data) {
    // Token invalid or expired — redirect to home
    return NextResponse.redirect(new URL('/en/dashboard', getBaseUrl()));
  }

  // Create session cookie and redirect to dashboard with user_id (DB primary key)
  const sessionToken = createSessionToken(data.userId);
  const dashboardUrl = new URL(`/${data.locale}/dashboard?user_id=${data.userId}`, getBaseUrl());

  const response = NextResponse.redirect(dashboardUrl);
  response.cookies.set(SESSION_COOKIE.name, sessionToken, SESSION_COOKIE.options);

  return response;
}
