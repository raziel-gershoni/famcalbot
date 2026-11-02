// The one builder of the /signin path (web sign-in spec 2026-11-02 §3): the sign-in page, the email form, Settings, the
// gate card and the finishing step's signInPageUrl (src/lib/web-session.ts) all use signInHref. English has no prefix
// ('as-needed', i18n/routing.ts), an unknown language is English. Client-safe: no Prisma, no Redis, no server-only
// import, and the SignInStatus type is import type (erased).

import { localeHref } from '@/src/site/zmanim/links';
import { normalizeLocale } from '@/src/utils/locale';
import type { SignInStatus } from '@/src/lib/web-session';

/** '/signin', '/he/signin' or '/ru/signin', then '?status=<status>' when given. */
export function signInHref(locale: string, status?: SignInStatus): string {
  const path = localeHref(normalizeLocale(locale), '/signin');
  return status ? `${path}?status=${encodeURIComponent(status)}` : path;
}
