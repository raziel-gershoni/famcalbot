import createMiddleware from 'next-intl/middleware';
import { locales } from './i18n';

export default createMiddleware({
  // A list of all locales that are supported
  locales,

  // Used when no locale matches
  defaultLocale: 'en',

  // Don't redirect if locale is in pathname
  localePrefix: 'as-needed',
});

export const config = {
  // Match only internationalized pathnames
  // Skip API routes, OAuth routes, and static files
  matcher: ['/((?!api|_next|_vercel|refresh-token|oauth-callback|oauth-success|oauth-complete|.*\\..*).*)'],
};
