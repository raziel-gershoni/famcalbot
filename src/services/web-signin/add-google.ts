/**
 * Settings' Add Google (web sign-in spec §2.9). Google refuses to sign in inside in-app browsers, so Add Google opens a
 * one-time famcal.bot link (5 minutes) in the person's browser: /{lang}/signin/add-google?token=<token> (English
 * unprefixed). That page names the account (peekAddGoogleToken, which never uses the link up) and offers Continue; only
 * Continue (POST /api/auth/google/add-start, Origin-checked) uses the link up (takeAddGoogleToken, GETDEL) and starts
 * Google with an 'add-google' flow bound to that browser. Google's callback then attaches the account
 * (finishAddGoogle), sends the notice and signs that browser in as the account that made the link.
 *
 * Redis keeps the token only as its sha256 (REDIS_KEYS.signinAddGoogle), and no log line holds it. The parameter is
 * `token` so the log and Sentry scrubber (part B) drops it from every URL it sees.
 */

import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { buildUrl } from '../../config/urls';
import { normalizeLocale } from '../../utils/locale';
import { localeHref } from '../../site/zmanim/links';
import { finishSignIn, signInPageUrl, signInRefusal } from '../../lib/web-session';
import { isIdentifierBlocked } from '../../lib/user-moderation';
import { getUserById } from '../user-service';
import type { UserConfig } from '../../types';
import type { OidcFlow } from './flow';
import type { GoogleClaims } from './oidc';
import { addIdentity } from './identities';
import { normalizeEmail } from './email-address';
import { sendSignInNotice } from './notice';

const ADD_GOOGLE_TTL_SECONDS = 5 * 60;
/** 24 random bytes as base64url */
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

const keyOf = (token: string) => REDIS_KEYS.signinAddGoogle(crypto.createHash('sha256').update(token).digest('hex'));

/** Make the one-time link for a proved account: famcal.bot/{lang}/signin/add-google?token=<token>, 5 minutes. */
export async function createAddGoogleLink(user: UserConfig): Promise<string> {
  const token = crypto.randomBytes(24).toString('base64url');
  await redis.set(keyOf(token), JSON.stringify({ userId: user.id }), { ex: ADD_GOOGLE_TTL_SECONDS });
  return buildUrl(localeHref(normalizeLocale(user.language), `/signin/add-google?token=${token}`));
}

function readEntry(raw: unknown): { userId: number } | null {
  if (!raw) return null;
  const entry = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { userId?: unknown };
  return typeof entry.userId === 'number' ? { userId: entry.userId } : null;
}

/** The account a link was made for, without using it up (the page that names it); null for a used, late or bad link. */
export async function peekAddGoogleToken(token: unknown): Promise<{ userId: number } | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return readEntry(await redis.get(keyOf(token)));
}

/** Use a link up (Continue): GETDEL, so it works once. */
export async function takeAddGoogleToken(token: unknown): Promise<{ userId: number } | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return readEntry(await redis.getdel(keyOf(token)));
}

/**
 * Google's callback for an 'add-google' flow (Task 4's handleOidcCallback has proved the token and cleared the flow
 * cookie): attach the Google account (sub, the verified address) to the account that made the link, send the notice,
 * and sign this browser in as that account.
 * - A sub another account holds is refused (status=taken), and so is a second Google account (status=has-one).
 * - A suspended or banned account gets no way and no notice: signInRefusal answers before anything is added, and
 *   finishSignIn shows the person its page.
 * - A Google account, or a verified address, on the blocklist is not added either (status=blocked; web sign-up spec
 *   §2.8: adding a way checks it).
 * - The same account adding the same Google account again ('kept') is signed in without a second notice.
 * The caller has checked the address is verified.
 */
export async function finishAddGoogle(flow: OidcFlow, claims: GoogleClaims): Promise<NextResponse> {
  const user = flow.userId ? await getUserById(flow.userId) : null;
  if (!user || !claims.email) {
    console.warn(`[signin] add-google: ${user ? `user ${user.id}: Google gave no address` : `the account that made the link is not there (${flow.userId ?? 'none'})`}`);
    return NextResponse.redirect(signInPageUrl(flow.locale, 'failed'));
  }
  const refusal = await signInRefusal(user);
  if (refusal) {
    console.warn(`[signin] user ${user.id}: add-google refused: the account is ${refusal}`);
    return finishSignIn(user, 'google');
  }
  if (await isIdentifierBlocked({ googleSub: claims.sub, email: normalizeEmail(claims.email) })) {
    console.warn(`[signin] user ${user.id}: add-google refused: the Google account or its address is on the blocklist`);
    return NextResponse.redirect(signInPageUrl(flow.locale, 'blocked'));
  }
  const added = await addIdentity(user.id, 'google', claims.sub, claims.email, { usedNow: true });
  if (added === 'taken' || added === 'has-one') {
    console.warn(`[signin] user ${user.id}: add-google refused (${added})`);
    return NextResponse.redirect(signInPageUrl(flow.locale, added));
  }
  if (added === 'added') await sendSignInNotice(user, { kind: 'google', address: claims.email, via: 'added' });
  return finishSignIn(user, 'google');
}
