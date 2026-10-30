import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { cityPageVerdict } from './src/lib/page-limit';
import { limitPage } from './src/lib/page-limit-page';

// Every page request passes here: first the zmanim city pages' request limit (src/lib/page-limit.ts: 60 city pages a
// minute from one address, then 429 with Retry-After until the minute ends and a one-line page in the visitor's
// language), then next-intl's locale handling.

const intl = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  const verdict = cityPageVerdict(
    {
      path: request.nextUrl.pathname,
      address: request.headers.get('x-real-ip'),
    },
    Date.now(),
  );
  if (!verdict.ok) {
    return new NextResponse(limitPage(request.nextUrl.pathname).html, {
      status: 429,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(verdict.retryAfterS), 'Cache-Control': 'no-store' },
    });
  }
  return intl(request);
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|refresh-token|oauth-callback|oauth-complete|.*\\..*).*)',],
};
