import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|refresh-token|oauth-callback|oauth-success|oauth-complete|.*\\..*).*)',],
};
