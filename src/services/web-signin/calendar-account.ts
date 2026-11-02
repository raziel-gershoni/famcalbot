/**
 * The Google account a calendar is connected from also signs in (web sign-in spec §2.17; the owner's request: the
 * person proved that account is theirs when they connected it).
 *
 * What is kept: User.googleAccountKey, the keyed hash of the connected account's address (account-key.ts), written by
 * the connect's commit (google-connect.ts) and cleared by the disconnect; and User.googleCalendarSignIn (default on,
 * turned off by removing the calendar's row or any Google way in Settings). The calendar consent has no openid, so the
 * address is the account's primary calendar id (googleAccountOf, as the copy to Google reads it).
 *
 * At sign-in (matchCalendarAccount, when (google, sub) found nobody): the verified address's key is looked up. Exactly
 * one account holding it with a live connection, its switch on and no Google way yet → Google is asked again with that
 * account's calendar token (syncGoogle(token).account(): getGoogleAuth, then googleAccountOf through googleFetch), and
 * its primary calendar must be the verified address right now. Then a Google way is made for that sub, the chat gets
 * the notice, and the person is signed in. Several accounts on one Google account (a shared family account) → several;
 * anything else → no-account.
 *
 * Connections made before 6b, or keyed under another SESSION_SECRET, get their key from fillGoogleAccountKeys, run once
 * per boot from instrumentation.ts: one select, then one Google call per such connection; a failure is logged and left
 * for the next boot.
 *
 * No log line holds an address: the user id only.
 */

import { prisma } from '../../utils/prisma';
import { readStoredToken } from '../../utils/encryption';
import { captureError } from '../../lib/error-capture';
import { getUserById } from '../user-service';
import { signInRefusal } from '../../lib/web-session';
import { syncGoogle } from '../google-sync/client';
import type { UserConfig } from '../../types';
import type { GoogleClaims } from './oidc';
import { addIdentity, hasIdentity } from './identities';
import { sendSignInNotice } from './notice';
import { googleAccountKey, googleAccountKeyId } from './account-key';

export { googleAccountKey, googleAccountKeyId } from './account-key';

export type CalendarMatch = { user: UserConfig } | { status: 'no-account' | 'several' };

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The account a stored calendar token belongs to now, or null (no token, or Google didn't tell: logged and captured). */
async function liveAccountOf(userId: number, storedToken: string): Promise<string | null> {
  const token = readStoredToken(storedToken, { userId, column: 'googleRefreshToken' });
  if (!token) {
    console.warn(`[google-account] user ${userId}: no usable calendar token to ask Google with`);
    return null;
  }
  try {
    return await syncGoogle(token).account();
  } catch (error) {
    console.warn(`[google-account] user ${userId}: Google did not tell the calendar's account: ${error instanceof Error ? error.message : String(error)}`);
    captureError(error, 'google-account-check', { user_id: userId }, 'warning');
    return null;
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
  if (live === null || !sameAddress(live, claims.email)) {
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

/**
 * The startup pass: give every connected calendar with no key, or a key of another key id, its account key. One select,
 * then for each such row one Google call and one write; the write is made only over the token the select read, so a
 * reconnect in between keeps its own. Never throws.
 */
export async function fillGoogleAccountKeys(): Promise<void> {
  const keyId = googleAccountKeyId();
  if (!keyId) {
    // Startup names the missing variable once (smoke-auth-leftovers #5 counts the lines that do), so this line does not
    console.warn('[google-account] no sign-in key, so the calendar accounts are not keyed');
    return;
  }
  let rows: { id: number; googleRefreshToken: string }[];
  try {
    rows = await prisma.user.findMany({
      where: {
        NOT: { googleRefreshToken: '' },
        OR: [{ googleAccountKey: null }, { NOT: { googleAccountKey: { startsWith: `${keyId}:` } } }],
      },
      select: { id: true, googleRefreshToken: true },
      orderBy: { id: 'asc' },
    });
  } catch (error) {
    captureError(error, 'google-account-fill');
    return;
  }
  if (rows.length === 0) {
    console.log('[google-account] startup pass: every connected calendar has its account key');
    return;
  }
  let filled = 0;
  for (const row of rows) {
    const live = await liveAccountOf(row.id, row.googleRefreshToken);
    const key = live ? googleAccountKey(live) : null;
    if (!key) continue;
    try {
      const { count } = await prisma.user.updateMany({
        where: { id: row.id, googleRefreshToken: row.googleRefreshToken },
        data: { googleAccountKey: key },
      });
      if (count === 1) filled++;
      else console.log(`[google-account] user ${row.id}: the calendar changed while the pass asked; its connect keeps its own key`);
    } catch (error) {
      captureError(error, 'google-account-fill', { user_id: row.id }, 'warning');
    }
  }
  console.log(`[google-account] startup pass: ${filled} filled, ${rows.length - filled} left`);
}
