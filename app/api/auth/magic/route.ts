import { NextRequest, NextResponse } from 'next/server';
import { validateMagicToken } from '@/src/services/magic-link';
import { readSession } from '@/src/lib/session-auth';
import { appKey } from '@/src/lib/app-keys';
import { finishSignIn } from '@/src/lib/web-session';
import { getUserById } from '@/src/services/user-service';
import { getBaseUrl } from '@/src/config/urls';
import { VALID_LOCALES, localeFromAcceptLanguage } from '@/src/utils/locale';

/**
 * Invalid, expired or already used, or no key to sign a session with: the dashboard with
 * no user_id shows the card that offers a fresh link, in the language the link carries,
 * else the browser's, with the prefix for every language (English too, as appPageUrl does, so next-intl keeps that
 * language and pins it in its cookie instead of choosing by Accept-Language). A browser still signed in
 * goes to its own dashboard instead (page-data re-checks the cookie).
 */
function freshLinkCard(request: NextRequest): NextResponse {
  const linkLocale = request.nextUrl.searchParams.get('locale') ?? '';
  const locale = (VALID_LOCALES as readonly string[]).includes(linkLocale)
    ? linkLocale
    : localeFromAcceptLanguage(request.headers.get('accept-language'));
  const session = readSession(request);
  const page = session !== null ? `/dashboard?user_id=${session.userId}` : '/dashboard';
  return NextResponse.redirect(new URL(`/${locale}${page}`, getBaseUrl()));
}

/**
 * The WhatsApp magic link (the bot's "settings", the WhatsApp Google connect): one use, then the finishing step every
 * sign-in shares (src/lib/web-session.ts). It refuses a suspended or banned account with its /signin page, sets the
 * WhatsApp-link session (24 hours, never renewed) and lands on the link's page (the dashboard, or Select calendars
 * right after a Google connect) in the person's language.
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

  const user = await getUserById(data.userId);
  if (!user) {
    console.warn(`[magic] the link names user ${data.userId}, who has no account; fresh-link card`);
    return freshLinkCard(request);
  }

  return finishSignIn(user, 'wa', { page: data.page === 'select-calendars' ? 'select-calendars' : 'dashboard' });
}
