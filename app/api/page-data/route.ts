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
// (Telegram initData, else the WhatsApp session cookie).

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
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
    const result = await loadPageData(page, auth.user, parseInt(String(rawUserId)), locale);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    captureError(error, 'page-data', { api_route: '/api/page-data' });
    return NextResponse.json({ error: 'Failed to load page' }, { status: 500 });
  }
}
