// The one builder of the /signin and /signup paths (web sign-in spec 2026-11-02 §3, web sign-up spec 2026-11-03 §3.4):
// the sign-in page, the email form, Settings, the gate card and the finishing step's signInPageUrl and signUpPageUrl
// (src/lib/web-session.ts) all use signInHref and signUpHref. English has no prefix ('as-needed', i18n/routing.ts), an
// unknown language is English. Client-safe: no Prisma, no Redis, no server-only import, and the SignInStatus type is
// import type (erased). It also holds the statuses /signin may show (Task 8), which ways a new person can sign up
// with, and the name's length limit the sign-up page and the server share.

import { localeHref } from '@/src/site/zmanim/links';
import { normalizeLocale } from '@/src/utils/locale';
import type { SignInStatus } from '@/src/lib/web-session';

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
  'exists-email': 'existsEmail',
  'exists-google': 'existsGoogle',
  stale: 'stale',
};

/** Every status the sign-in flows send to /signin: STATUS_KEY's keys, so a new SignInStatus member is read by construction (the Record fails to compile without it). */
export const SIGNIN_STATUSES = Object.keys(STATUS_KEY) as SignInStatus[];

/** The status a query value names, or null for anything else (an unknown value is ignored). */
export function readSignInStatus(value: unknown): SignInStatus | null {
  return typeof value === 'string' && SIGNIN_STATUSES.includes(value as SignInStatus) ? (value as SignInStatus) : null;
}

export function isOutcome(status: SignInStatus): status is OutcomeStatus {
  return OUTCOMES.includes(status);
}

/**
 * The Join question an Add Google ended on (web sign-up spec 2026-11-03 §3.6): '/signin/add-google/join?token=<id>',
 * under the language's prefix ('token': the log and Sentry scrubber drops it).
 */
export function addGoogleJoinHref(locale: string, joinId: string): string {
  return `${localeHref(normalizeLocale(locale), '/signin/add-google/join')}?token=${encodeURIComponent(joinId)}`;
}

/** '/signin', '/he/signin' or '/ru/signin', then '?status=<status>' when given. */
export function signInHref(locale: string, status?: SignInStatus): string {
  const path = localeHref(normalizeLocale(locale), '/signin');
  return status ? `${path}?status=${encodeURIComponent(status)}` : path;
}

/** '/signup', '/he/signup' or '/ru/signup': the page a sign-up waits on (web sign-up spec §3.4). */
export function signUpHref(locale: string): string {
  return localeHref(normalizeLocale(locale), '/signup');
}

/** A sign-up name's most characters (code points, after trimming): the server refuses more, the page says so first. */
export const SIGNUP_NAME_MAX = 60;

/** The ways a new person can create an account with on this server: the words /signin uses for "New to FamCal?". */
export type SignUpWays = 'google' | 'email' | 'both';

/** The words for the open sign-up ways, or null when none is. Whether a way is open is `signUpOpen`'s rule (signup-open.ts). */
export function signUpWays(google: boolean, email: boolean): SignUpWays | null {
  if (google && email) return 'both';
  if (google) return 'google';
  return email ? 'email' : null;
}
