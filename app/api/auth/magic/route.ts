import { NextRequest, NextResponse } from 'next/server';
import { validateMagicToken } from '@/src/services/magic-link';
import { createSessionToken, SESSION_COOKIE, validateSessionFromRequest } from '@/src/lib/session-auth';
import { getBaseUrl } from '@/src/config/urls';
import { prisma } from '@/src/utils/prisma';
import { VALID_LOCALES, localeFromAcceptLanguage } from '@/src/utils/locale';

/**
 * Magic link auth handler
 * Validates token, sets session cookie, redirects to the link's page (the dashboard,
 * or select-calendars right after a Google connect)
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.redirect(new URL('/', getBaseUrl()));
  }

  const data = await validateMagicToken(token);

  if (!data) {
    // Invalid, expired or already used: the dashboard with no user_id shows the card that
    // offers a fresh link, in the language the link carries, else the browser's. A browser
    // still signed in goes to its own dashboard instead (page-data re-checks the cookie).
    const linkLocale = request.nextUrl.searchParams.get('locale') ?? '';
    const locale = (VALID_LOCALES as readonly string[]).includes(linkLocale)
      ? linkLocale
      : localeFromAcceptLanguage(request.headers.get('accept-language'));
    const sessionUserId = validateSessionFromRequest(request);
    const to = sessionUserId !== null ? `/${locale}/dashboard?user_id=${sessionUserId}` : `/${locale}/dashboard`;
    return NextResponse.redirect(new URL(to, getBaseUrl()));
  }

  // Refuse to grant a session to a suspended user.
  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { suspendedAt: true },
  });
  if (user?.suspendedAt) {
    return NextResponse.redirect(new URL('/', getBaseUrl()));
  }

  // Create session cookie and redirect to the link's page with user_id (DB primary key)
  const sessionToken = createSessionToken(data.userId);
  const page = data.page === 'select-calendars' ? 'select-calendars' : 'dashboard';
  const pageUrl = new URL(`/${data.locale}/${page}?user_id=${data.userId}`, getBaseUrl());

  const response = NextResponse.redirect(pageUrl);
  response.cookies.set(SESSION_COOKIE.name, sessionToken, SESSION_COOKIE.options);

  return response;
}
