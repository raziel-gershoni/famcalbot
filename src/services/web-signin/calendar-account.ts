/**
 * The Google account a calendar is connected from also signs in (web sign-in spec §2.17; the owner's request: the
 * person proved that account is theirs when they connected it).
 *
 * What is kept: User.googleAccountKey, the keyed hash of the connected account's address (account-key.ts), written by
 * the connect's commit (google-connect.ts) or by Turn on in Settings (turnOnCalendarAccount below) and cleared by the
 * disconnect; and User.googleCalendarSignIn (default on, turned off by removing the calendar's row or any Google way in
 * Settings, which also clears the key). The key is made and kept only for an account whose switch is on: the connect,
 * the merge and Turn on all check it. The calendar consent has no openid, so the address is the account's primary
 * calendar id (googleAccountOf, as the copy to Google reads it).
 *
 * At sign-in (matchCalendarAccount, when (google, sub) found nobody): the verified address's key is looked up. Exactly
 * one account holding it with a live connection, its switch on and no Google way yet → Google is asked again with that
 * account's calendar token (syncGoogle(token).account(): getGoogleAuth, then googleAccountOf through googleFetch), and
 * its primary calendar must be the verified address right now. Then a Google way is made for that sub, the chat gets
 * the notice, and the person is signed in. Several accounts on one Google account (a shared family account) → several;
 * a dead token or a different address → no-account; Google not answering → failed ("try again").
 *
 * A connection made before 6b, or keyed under another SESSION_SECRET, has no usable key and signs in only after its
 * owner presses Turn on in Settings (the owner's decision, 2026-11-02: Google's User Data Policy asks to notify people
 * and ask them before their data is used in a new way). Nothing keys a connection at startup, and nothing asks Google
 * about connections in bulk.
 *
 * No log line holds an address: the user id and the kind only.
 */

import { prisma } from '../../utils/prisma';
import { readStoredToken } from '../../utils/encryption';
import { captureError } from '../../lib/error-capture';
import { getUserById } from '../user-service';
import { signInRefusal } from '../../lib/web-session';
import { syncGoogle } from '../google-sync/client';
import type { UserConfig } from '../../types';
import { providerConfigured, type GoogleClaims } from './oidc';
import { addIdentity, calendarSignInState, hasIdentity } from './identities';
import { sendSignInNotice } from './notice';
import { classifyGoogleError } from '../calendar-read/google-map';
import { googleAccountKey } from './account-key';

export { googleAccountKey, googleAccountKeyId } from './account-key';

export type CalendarMatch = { user: UserConfig } | { status: 'no-account' | 'several' | 'failed' };

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What asking Google about a stored calendar token gave: the account's address; 'token' (the token is dead: no usable
 * token, or classifyGoogleError says 'token'); or 'unavailable' (anything else: a transient failure, a rate limit, an
 * unknown error, or no address). Each is logged with the user id and the kind only; a Google failure is captured.
 */
type LiveAccount = { address: string } | 'token' | 'unavailable';

async function liveAccountOf(userId: number, storedToken: string): Promise<LiveAccount> {
  const token = readStoredToken(storedToken, { userId, column: 'googleRefreshToken' });
  if (!token) {
    console.warn(`[google-account] user ${userId}: no usable calendar token to ask Google with (token)`);
    return 'token';
  }
  try {
    const address = await syncGoogle(token).account();
    if (!address || !address.trim()) {
      console.warn(`[google-account] user ${userId}: Google named no account (unavailable)`);
      return 'unavailable';
    }
    return { address };
  } catch (error) {
    const kind = classifyGoogleError(error) === 'token' ? 'token' : 'unavailable';
    console.warn(`[google-account] user ${userId}: Google did not tell the calendar's account (${kind}): ${error instanceof Error ? error.message : String(error)}`);
    captureError(error, 'google-account-check', { user_id: userId }, 'warning');
    return kind;
  }
}

export async function matchCalendarAccount(claims: GoogleClaims): Promise<CalendarMatch> {
  if (!claims.emailVerified || !claims.email) return { status: 'no-account' };
  const key = googleAccountKey(claims.email);
  if (!key) {
    console.warn('[signin] google: no account key (SESSION_SECRET is unset), so no calendar match');
    return { status: 'no-account' };
  }
  // Spec §2.17: exactly one account with the switch on, a live connection and no Google way. Only accounts with the
  // switch on and a connection are holders, so an account that turned it off (or disconnected) is not a second one.
  const holders = await prisma.user.findMany({
    where: { googleAccountKey: key, googleCalendarSignIn: true, NOT: { googleRefreshToken: '' } },
    select: { id: true, googleRefreshToken: true },
    orderBy: { id: 'asc' },
    take: 2,
  });
  if (holders.length === 0) return { status: 'no-account' };
  if (holders.length > 1) {
    console.warn(`[signin] google: the calendar account is connected on several FamCal accounts (${holders.map(h => h.id).join(', ')}): no match`);
    return { status: 'several' };
  }
  const [holder] = holders;
  if (await hasIdentity(holder.id, 'google')) {
    console.log(`[signin] user ${holder.id}: has another Google way, so the calendar's account does not sign in`);
    return { status: 'no-account' };
  }
  const live = await liveAccountOf(holder.id, holder.googleRefreshToken);
  // Google not answering is "try again", not "no account": the account exists and a retry works
  if (live === 'unavailable') return { status: 'failed' };
  if (live === 'token' || !sameAddress(live.address, claims.email)) {
    console.warn(`[signin] user ${holder.id}: the live check of the calendar's Google account did not agree`);
    return { status: 'no-account' };
  }
  const user = await getUserById(holder.id);
  if (!user) return { status: 'no-account' };
  // A suspended or banned account is answered, and finishSignIn refuses it with its page (signInRefusal is the one rule
  // it uses): nothing is attached or sent.
  if (await signInRefusal(user)) return { user };
  const added = await addIdentity(user.id, 'google', claims.sub, claims.email, { usedNow: true });
  if (added === 'taken' || added === 'has-one') {
    console.warn(`[signin] user ${user.id}: the calendar match could not make the Google way (${added})`);
    return { status: 'no-account' };
  }
  // 'kept' (a request made the same way a moment ago) sends no second notice: the one that made it did
  if (added === 'added') await sendSignInNotice(user, { kind: 'google', address: claims.email, via: 'calendar' });
  console.log(`[signin] user ${user.id}: signed in with the Google account their calendar is connected from`);
  return { user };
}

export type TurnOnResult = 'on' | 'shared' | 'reconnect' | 'failed' | 'not-offered';

/**
 * Settings → Turn on (spec §2.17): key a calendar connection that has no usable key (connected before 6b, Google did
 * not name the account at connect, or keyed under another SESSION_SECRET). The press is the person's consent: it reads
 * the primary calendar id once, live, and keeps its hash.
 * - 'not-offered': the row, read fresh, is not in the 'off' state (listSignInMethods' rule).
 * - 'reconnect': the calendar's token is dead. 'failed': Google did not answer, named no account, or the write lost.
 * - 'shared': another FamCal account with its switch on and a live connection holds the same Google account, so
 *   nothing is kept (Add Google is the way for either).
 * - 'on': the key is written by one conditional write over the token that was read, so a reconnect in between keeps
 *   its own. No chat notice (the first sign-in with it sends the calendar notice) and sessionsValidAfter is untouched.
 */
export async function turnOnCalendarAccount(userId: number): Promise<TurnOnResult> {
  const result = await turnOn(userId);
  console.log(`[signin] user ${userId}: calendar account turn on: ${result}`);
  return result;
}

async function turnOn(userId: number): Promise<TurnOnResult> {
  // Settings offers Turn on only while Google sign-in is set up; a direct request keeps no key with no use
  if (!providerConfigured('google')) return 'not-offered';
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, googleCalendarSignIn: true, googleRefreshToken: true, googleAccountKey: true },
  });
  if (!row) return 'not-offered';
  if ((await calendarSignInState(row, await hasIdentity(userId, 'google'))) !== 'off') return 'not-offered';
  const live = await liveAccountOf(userId, row.googleRefreshToken);
  if (live === 'token') return 'reconnect';
  if (live === 'unavailable') return 'failed';
  const key = googleAccountKey(live.address);
  if (!key) {
    console.warn(`[signin] user ${userId}: turn on has no account key (SESSION_SECRET is unset)`);
    return 'failed';
  }
  const other = await prisma.user.findFirst({
    where: { id: { not: userId }, googleAccountKey: key, googleCalendarSignIn: true, NOT: { googleRefreshToken: '' } },
    select: { id: true },
  });
  if (other) return 'shared';
  const { count } = await prisma.user.updateMany({
    where: { id: userId, googleRefreshToken: row.googleRefreshToken, googleCalendarSignIn: true },
    data: { googleAccountKey: key },
  });
  if (count !== 1) {
    console.warn(`[signin] user ${userId}: the calendar changed while turn on asked Google; it keeps its own key`);
    return 'failed';
  }
  return 'on';
}
