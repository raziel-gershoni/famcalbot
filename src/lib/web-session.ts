/**
 * The one finishing step of every web sign-in (spec 2026-11-02-web-sign-in §3). The WhatsApp link, Telegram, Google
 * and the email code all end here, so:
 * - a suspended or banned account is refused the same way everywhere, with its own /signin page;
 * - every session cookie is made in one place, with how the person signed in and the moment, in milliseconds;
 * - the person lands on their own page in their own language.
 * No line here logs a cookie, a token or an address: the user id, the method and the outcome only.
 */

import { NextResponse } from 'next/server';
import { createSessionToken, setSessionCookie, type SignInMethod } from './session-auth';
import { isIdentifierBlocked } from './user-moderation';
import { captureError } from './error-capture';
import { getBaseUrl } from '../config/urls';
import { normalizeLocale } from '../utils/locale';
import { signInHref } from '../site/signin';

/** The app pages a sign-in lands on: the calendar, or Select calendars right after a Google connect on WhatsApp. */
export type FinishPage = 'dashboard' | 'select-calendars';

/**
 * The outcomes /signin shows (?status=). 'taken' and 'has-one' are what Add Google answers: the Google account already
 * signs in to another FamCal account, or this account already has a Google way.
 */
export type SignInStatus =
  | 'no-account' | 'several' | 'suspended' | 'blocked' | 'restart' | 'failed' | 'unavailable' | 'taken' | 'has-one';

/** What the finishing step reads of the account. A UserConfig (user-service) and a Prisma User both fit. */
export interface SignInAccount {
  id: number;
  language: string;
  suspendedAt: Date | null;
  telegramId: number | bigint | null;
  whatsappPhone?: string | null;
}

/**
 * An absolute landing URL always carries its locale prefix, English included (/en/dashboard, /en/signin): next-intl
 * ('as-needed' with detection on, i18n/routing.ts) then redirects /en/... once to the bare path and pins the
 * NEXT_LOCALE cookie, where a bare path would be routed by the browser's Accept-Language (an English speaker with a
 * Hebrew browser would land on /he/... and bounce back). Client links stay relative and unprefixed for English
 * (signInHref).
 */
function prefixed(locale: string, href: string): string {
  const l = normalizeLocale(locale);
  return href.startsWith(`/${l}/`) ? href : `/${l}${href}`;
}

/** /signin on the site in a language, absolute, with the status and an explicit locale prefix. The path is signInHref's (src/site/signin.ts), the one builder. */
export function signInPageUrl(locale: string, status?: SignInStatus): string {
  return new URL(prefixed(locale, signInHref(locale, status)), getBaseUrl()).toString();
}

/**
 * An app page of the person's, absolute: /{locale}/{page}?user_id={DB id}, in their language, with the locale prefix
 * for every language (an unknown language is English).
 */
export function appPageUrl(locale: string, page: FinishPage, userId: number): string {
  return new URL(prefixed(locale, `/${page}?user_id=${userId}`), getBaseUrl()).toString();
}

/**
 * Why this account may not sign in, or null: 'suspended' (checked first), or 'blocked' (its Telegram id or WhatsApp
 * number is on the blocklist). The one rule: finishSignIn uses it, and so do Add Google and the calendar match before
 * they attach a way or send a notice (they answer with finishSignIn, which refuses the same way). It throws when the
 * blocklist can't be read; callers inside finishSignIn are covered by its catch.
 */
export async function signInRefusal(user: SignInAccount): Promise<'suspended' | 'blocked' | null> {
  if (user.suspendedAt) return 'suspended';
  if (await isIdentifierBlocked({ telegramId: user.telegramId, whatsappPhone: user.whatsappPhone ?? null })) return 'blocked';
  return null;
}

/**
 * Finish a sign-in as `user` by `method`.
 * - A suspended account goes to /signin?status=suspended, and one whose Telegram id or WhatsApp number is banned to
 *   status=blocked, with no cookie.
 * - Otherwise the session cookie is set (signed in now) and the person lands on `page` (the dashboard by default) in
 *   their language.
 * - `respond: 'json'` answers { ok: true, redirect } (200) or { ok: false, status } (403; 500 for 'failed') instead of
 *   redirecting.
 * - A step that throws (no SESSION_SECRET, the blocklist read) is logged and captured, and answered with 'failed'.
 */
export async function finishSignIn(
  user: SignInAccount,
  method: SignInMethod,
  opts: { page?: FinishPage; respond?: 'redirect' | 'json' } = {},
): Promise<NextResponse> {
  const locale = normalizeLocale(user.language);
  const json = opts.respond === 'json';
  const refuse = (status: SignInStatus) =>
    json
      ? NextResponse.json({ ok: false, status }, { status: status === 'failed' ? 500 : 403 })
      : NextResponse.redirect(signInPageUrl(locale, status));

  try {
    const refusal = await signInRefusal(user);
    if (refusal) {
      console.warn(`[signin] ${method} sign-in refused: user ${user.id} is ${refusal === 'blocked' ? 'on the blocklist' : refusal}`);
      return refuse(refusal);
    }

    const redirect = appPageUrl(locale, opts.page ?? 'dashboard', user.id);
    const response = json ? NextResponse.json({ ok: true, redirect }) : NextResponse.redirect(redirect);
    setSessionCookie(response, createSessionToken(user.id, method, Date.now()));
    console.log(`[signin] user ${user.id} signed in (${method})`);
    return response;
  } catch (error) {
    console.error(`[signin] finishing a ${method} sign-in for user ${user.id} failed`, error);
    captureError(error, 'signin-finish', { user_id: user.id, method });
    return refuse('failed');
  }
}
