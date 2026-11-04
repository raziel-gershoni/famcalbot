/**
 * Web sign-up (spec 2026-11-03-web-sign-up §2.2, §2.3, §2.6, §2.22, §3.4): the end of a Google or email-code sign-in
 * that found no account. The proved identity (Google's sub and verified address, or the address an email code proved)
 * waits in a one-time record behind the famcal_signin cookie (flow.ts, kind 'signup', 10 minutes). /signup reads it
 * (signUpView, not used up); Create account takes it (completeSignUp, one use), makes the account through the one
 * creation step (createAccount: the account, its sign-in way in the same transaction, its first FamCal calendar) and
 * signs this browser in (finishSignIn).
 *
 * Create account, in this order:
 *  1. the name (cleanName), before the record is touched, so a typo costs nothing;
 *  2. the record (takeFlow, GETDEL): none is 'restart', with the cookie left alone (it may name another tab's sign-in);
 *  3. the bans as of now: the Google sub and the address, or the email address;
 *  4. the address check again: a way of another account may show the address since the sign-in ('exists');
 *  5. the cap on new accounts per internet address (allowNewAccount: 5 a day per IPv4 address or IPv6 /48); a count
 *     that can't be read (Redis failing, store-down) is 'failed', never 'limit';
 *  6. the account (createAccount); a way someone took in the meantime fails the unique (kind, subject): 'taken';
 *  7. the session (finishSignIn, json), landing in the account's language on the invite the sign-in began on, else
 *     the dashboard (landingPage).
 * From step 2 on, every answer clears the flow cookie, except a creation step that failed on something unclassified (a
 * transient database error): that 500 puts the sign-up back under a new cookie with the time it had left, so pressing
 * Create account again works (the cap slot stays spent).
 *
 * Answers, in finishSignIn's json shape: { ok: true, redirect } with the session cookie, or { ok: false, status }:
 * 'name' (400), 'restart', 'exists' with the way that shows the address, 'blocked' (403), 'limit' (429), 'failed' (503)
 * when the cap's count can't be read, 'taken' (409), finishSignIn's own 'suspended' / 'blocked' / 'failed', and
 * 'failed' (500) from the creation step or the route's catch.
 *
 * No log line holds an address, a sub, a name, an invite or the cookie: the way, a user id and the outcome only.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { finishSignIn, landingPage } from '../../lib/web-session';
import { isIdentifierBlocked } from '../../lib/user-moderation';
import { SIGNUP_NAME_MAX } from '../../site/signin';
import { VALID_LOCALES, normalizeLocale, type Locale } from '../../utils/locale';
import type { UserConfig } from '../../types';
import { AccountBlockedError, createAccount } from '../user-service';
import { clientAddress } from './client-address';
import { normalizeEmail } from './email-address';
import { clearFlowCookie, peekFlow, startFlow, takeFlow, type SignUpFlow } from './flow';
import { findWayByAddress, isUniqueViolation, type IdentityKind } from './identities';
import { allowNewAccount } from './limits';
import { captureSignInFailure, safeErrorSummary } from './safe-error';

/**
 * A character no name may hold (spec §2.22: the partner and the bot's HTML messages show it): C0 and C1 controls,
 * Arabic's letter mark, the zero-width space, joiners and the direction marks (U+200B–U+200F), the line and paragraph
 * separators and the direction embeddings and overrides (U+2028–U+202E), the word joiner, the direction isolates
 * (U+2066–U+2069), a lone surrogate, and the zero-width no-break space.
 */
function refusedInName(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0xfeff
  );
}

/** The name as it is kept: trimmed, 1 to 60 characters (code points), none of them refusedInName; else null. */
export function cleanName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim();
  const characters = Array.from(name);
  if (characters.length === 0 || characters.length > SIGNUP_NAME_MAX) return null;
  return characters.some((c) => refusedInName(c.codePointAt(0) ?? 0)) ? null : name;
}

/** The normalised address a sign-up is for: an email way's subject, or Google's verified address normalised (null if it can't be one). */
function addressOf(flow: SignUpFlow): string | null {
  return flow.way === 'email' ? flow.subject : normalizeEmail(flow.address);
}

/** The kind of another account's way that shows this sign-up's address, or null (spec §2.2: a check on a proved address, never a sign-in). */
async function heldBy(flow: SignUpFlow): Promise<IdentityKind | null> {
  const address = addressOf(flow);
  if (!address) return null;
  const held = await findWayByAddress(address);
  if (!held) return null;
  console.log(`[signup] a ${flow.way} sign-up's address already signs in to user ${held.userId} with ${held.kind}`);
  return held.kind;
}

/** What GET /api/auth/signup answers: the sign-up to finish, the way that already signs in with its address, or start again. */
export type SignUpView = { way: IdentityKind; address: string } | { exists: IdentityKind } | { restart: true };

/** This browser's sign-up as /signup shows it, read without using it up (one Redis read; a database read only for the address check). */
export async function signUpView(request: NextRequest): Promise<SignUpView> {
  const flow = await peekFlow(request, 'signup');
  if (!flow) return { restart: true };
  const held = await heldBy(flow);
  return held ? { exists: held } : { way: flow.way, address: flow.address };
}

/** Create account's body: the name typed, and the page's language. */
export type SignUpBody = { name?: unknown; locale?: unknown };

type SignUpRefusal = 'name' | 'restart' | 'blocked' | 'limit' | 'taken' | 'failed';

const refuse = (status: SignUpRefusal, httpStatus = 200) => NextResponse.json({ ok: false, status }, { status: httpStatus });

/** The new account's language: the page's, when it is one of ours (the person may have switched it on /signup), else the sign-in's. */
function languageOf(body: SignUpBody, flow: SignUpFlow): Locale {
  return typeof body.locale === 'string' && (VALID_LOCALES as readonly string[]).includes(body.locale) ? (body.locale as Locale) : normalizeLocale(flow.locale);
}

/** POST /api/auth/signup after the same-origin check and the JSON read (the route's): see the order above. */
export async function completeSignUp(request: NextRequest, body: SignUpBody): Promise<NextResponse> {
  const name = cleanName(body.name);
  if (!name) {
    console.log('[signup] a name was refused (empty, over 60 characters, or a control, direction or zero-width character)');
    return refuse('name', 400);
  }
  const taken = await takeFlow(request, ['signup']);
  if (!taken || taken.kind !== 'signup') {
    console.log('[signup] Create account with no sign-up in this browser: start again');
    // The cookie is left as it is: it may name this browser's newer sign-in of another way (takeFlow left it alone)
    return refuse('restart');
  }
  const flow: SignUpFlow = taken;
  const done = (response: NextResponse) => {
    clearFlowCookie(response);
    return response;
  };
  const address = addressOf(flow);
  if (!address) {
    console.warn(`[signup] a ${flow.way} sign-up holds no address FamCal can keep`);
    return done(refuse('failed', 500));
  }
  if (await isIdentifierBlocked(flow.way === 'google' ? { googleSub: flow.subject, email: address } : { email: address })) {
    console.warn(`[signup] a ${flow.way} sign-up refused: its Google account or address is on the blocklist`);
    return done(refuse('blocked', 403));
  }
  const held = await heldBy(flow);
  if (held) return done(NextResponse.json({ ok: false, status: 'exists', way: held }));
  const cap = await allowNewAccount(clientAddress(request));
  if (!cap.ok) {
    console.warn(`[signup] a ${flow.way} sign-up refused: ${cap.reason}`);
    // A store that can't count is an outage, not too many accounts: the page says the request failed (try again)
    return done(cap.reason === 'store-down' ? refuse('failed', 503) : refuse('limit', 429));
  }
  let user: UserConfig;
  try {
    user = await createAccount({
      via: 'web',
      way: { kind: flow.way, subject: flow.subject, address: flow.address },
      name,
      language: languageOf(body, flow),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      console.warn(`[signup] a ${flow.way} sign-up met a way another account took in the meantime (taken)`);
      return done(refuse('taken', 409));
    }
    if (error instanceof AccountBlockedError) {
      console.warn(`[signup] a ${flow.way} sign-up refused by the creation step's ban check`);
      return done(refuse('blocked', 403));
    }
    // Something unclassified (a transient database error): no account was made, so the sign-up goes back under a new
    // cookie with the time it had left, and Create account can be pressed again. The cap slot stays spent.
    captureSignInFailure(error, 'signup-complete', { api_route: '/api/auth/signup' });
    const failed = refuse('failed', 500);
    try {
      await startFlow(failed, flow);
      console.warn(`[signup] a ${flow.way} sign-up failed in the creation step; the sign-up was put back for another try`);
      return failed;
    } catch (restoreError) {
      console.error(`[signup] a ${flow.way} sign-up failed in the creation step and could not be put back: ${safeErrorSummary(restoreError)}`);
      return done(refuse('failed', 500));
    }
  }
  const finished = await finishSignIn(user, flow.way, { respond: 'json', page: landingPage(flow.invite) });
  console.log(`[signup] user ${user.id} was made on the web with ${flow.way}`);
  return done(finished);
}
