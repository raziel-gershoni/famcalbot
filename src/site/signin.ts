// The one builder of the /signin path (web sign-in spec 2026-11-02 §3): the sign-in page, the email form, Settings, the
// gate card and the finishing step's signInPageUrl (src/lib/web-session.ts) all use signInHref. English has no prefix
// ('as-needed', i18n/routing.ts), an unknown language is English. Client-safe: no Prisma, no Redis, no server-only
// import, and the SignInStatus type is import type (erased). It also holds the statuses /signin may show (Task 8).

import { localeHref } from '@/src/site/zmanim/links';
import { normalizeLocale } from '@/src/utils/locale';
import type { SignInStatus } from '@/src/lib/web-session';

/** Every status the sign-in flows send to /signin. */
export const SIGNIN_STATUSES = ['no-account', 'several', 'suspended', 'blocked', 'restart', 'failed', 'unavailable', 'taken', 'has-one'] as const satisfies readonly SignInStatus[];

/** The answers another try won't change: they stand instead of the ways, with their own words and actions. */
export type OutcomeStatus = 'no-account' | 'several' | 'suspended' | 'blocked' | 'taken' | 'has-one';
const OUTCOMES: readonly SignInStatus[] = ['no-account', 'several', 'suspended', 'blocked', 'taken', 'has-one'];

/** Each status's key under site.signin.status (an outcome's is an object with a title and a body; the rest are one line). */
export const STATUS_KEY: Record<SignInStatus, string> = {
  'no-account': 'noAccount',
  several: 'several',
  suspended: 'suspended',
  blocked: 'blocked',
  restart: 'restart',
  failed: 'failed',
  unavailable: 'unavailable',
  taken: 'taken',
  'has-one': 'hasOne',
};

/** The status a query value names, or null for anything else (an unknown value is ignored). */
export function readSignInStatus(value: unknown): SignInStatus | null {
  return typeof value === 'string' && (SIGNIN_STATUSES as readonly string[]).includes(value) ? (value as SignInStatus) : null;
}

export function isOutcome(status: SignInStatus): status is OutcomeStatus {
  return OUTCOMES.includes(status);
}

/** '/signin', '/he/signin' or '/ru/signin', then '?status=<status>' when given. */
export function signInHref(locale: string, status?: SignInStatus): string {
  const path = localeHref(normalizeLocale(locale), '/signin');
  return status ? `${path}?status=${encodeURIComponent(status)}` : path;
}
