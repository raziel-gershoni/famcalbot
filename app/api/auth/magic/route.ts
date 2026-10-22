import { NextRequest, NextResponse } from 'next/server';
import { validateMagicToken } from '@/src/services/magic-link';
import { createSessionToken, SESSION_COOKIE, validateSessionFromRequest } from '@/src/lib/session-auth';
import { appKey } from '@/src/lib/app-keys';
import { getBaseUrl } from '@/src/config/urls';
import { prisma } from '@/src/utils/prisma';
import { VALID_LOCALES, localeFromAcceptLanguage } from '@/src/utils/locale';

/**
 * Invalid, expired or already used, or no key to sign a session with: the dashboard with
 * no user_id shows the card that offers a fresh link, in the language the link carries,
 * else the browser's. A browser still signed in goes to its own dashboard instead
 * (page-data re-checks the cookie).
 */
function freshLinkCard(request: NextRequest): NextResponse {
  const linkLocale = request.nextUrl.searchParams.get('locale') ?? '';
  const locale = (VALID_LOCALES as readonly string[]).includes(linkLocale)
    ? linkLocale
    : localeFromAcceptLanguage(request.headers.get('accept-language'));
  const sessionUserId = validateSessionFromRequest(request);
  const to = sessionUserId !== null ? `/${locale}/dashboard?user_id=${sessionUserId}` : `/${locale}/dashboard`;
  return NextResponse.redirect(new URL(to, getBaseUrl()));
}

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

  // The session key before the token: validateMagicToken uses the link up (GETDEL), so a
  // link refused for a missing SESSION_SECRET still works once it is set. appKey reports
  // the missing secret (once per process).
  if (!appKey('session-cookie')) {
    console.error('[magic] SESSION_SECRET is not set; the magic link was left unused');
    return freshLinkCard(request);
  }

  const data = await validateMagicToken(token);

  if (!data) {
    return freshLinkCard(request);
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
