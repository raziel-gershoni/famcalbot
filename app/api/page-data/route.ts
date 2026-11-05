// POST /api/page-data — the private data behind a [locale] Mini App page.
// Body: { page, user_id, locale, initData? }. Returns one of
//   { kind: 'props', props }    the page's client component props
//   { kind: 'redirect', to }    the user's language differs from the URL's locale
//   { kind: 'notice', notice }  the page shows a static notice instead
//   { kind: 'notFound' }
// or 400 (unknown page, no user_id), 401, 403, 404 or 429 from verifyUserAuth.
//
// The pages used to load this during SSR for any ?user_id, with no credential. Now they
// render no user data and PageGate calls this route, which proves the user first
// (Telegram initData, else the session cookie). It is also the one route that renews a
// famcal.bot session (needsRenewal, web sign-in spec §3), on every page the web app opens.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { needsRenewal, reissueSessionToken, setSessionCookie } from '@/src/lib/session-auth';
import { generalRateLimiter } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';
import { isPageName, loadPageData } from '@/src/lib/page-data';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const page: unknown = body?.page;
    if (!isPageName(page)) {
      return NextResponse.json({ error: 'Unknown page' }, { status: 400 });
    }

    const rawUserId = body.user_id;
    const initData = typeof body.initData === 'string' ? body.initData : null;
    const auth = await verifyUserAuth(
      request,
      rawUserId != null ? String(rawUserId) : null,
      initData,
      generalRateLimiter,
      'page-data'
    );
    if (!auth.success) return auth.response;

    const locale = typeof body.locale === 'string' ? body.locale : '';
    // The `push` prop is for a browser session: Telegram's initData passes none
    const session = auth.via === 'session' ? { provedAt: auth.session.provedAt } : null;
    const result = await loadPageData(page, auth.user, parseInt(String(rawUserId)), locale, session);
    const response = NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    // After the row check above accepted it: a famcal.bot sign-in's cookie over a day old gets 30 more days, with its
    // first sign-in time, proved-at and method (so Sign out on all devices still ends it, and Connect Telegram's hour
    // never restarts). A WhatsApp link's never is renewed.
    if (auth.via === 'session' && needsRenewal(auth.session, Date.now())) {
      setSessionCookie(response, reissueSessionToken(auth.session));
    }
    return response;
  } catch (error) {
    captureError(error, 'page-data', { api_route: '/api/page-data' });
    return NextResponse.json({ error: 'Failed to load page' }, { status: 500 });
  }
}
