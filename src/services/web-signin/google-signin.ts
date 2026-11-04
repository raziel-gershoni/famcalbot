/**
 * Who a Google sign-in is (web sign-in spec §3, §2.17; web sign-up spec §2.2, §2.8, §3.3): the account that added this
 * Google account (google, sub), else the account whose calendar is connected from it (calendar-account.ts), else
 * nobody, and then whether a new account may be made for it. The one call site for the Google callback's account
 * lookup.
 *
 * - 'blocked': the Google account (its sub) or its verified address is on the blocklist, for a sign-in and a sign-up
 *   alike (an account found by its sub is refused here, before finishSignIn's own check of its ways).
 * - 'new': no account holds this Google account in any way (no Google way with this sub, no calendar key for its
 *   address), no way of another account shows the verified address, and Google sign-up is open here (signUpOpen:
 *   email sending set up too, since the new account's notices go only by email): the callback starts the sign-up.
 *   With Google sign-up closed it is 'no-account', the page a sign-in with no account had before sign-up.
 * - 'exists' (way 'email'): the verified address is another account's email way. Its page says to sign in with a code
 *   and add Google in Settings. A check on an address Google just proved, never a sign-in by address.
 * - A Google way of another sub that shows the address stays 'no-account' (that page's words fit; "use Google" would
 *   be what the person just did).
 * No log line holds the sub or the address: the outcome and a user id only.
 */

import type { UserConfig } from '../../types';
import type { GoogleClaims } from './oidc';
import { isIdentifierBlocked } from '../../lib/user-moderation';
import { normalizeEmail } from './email-address';
import { findUserByIdentity, findWayByAddress } from './identities';
import { matchCalendarAccount } from './calendar-account';
import { signUpOpen } from './signup-open';

export type GoogleSignInResult =
  | { user: UserConfig }
  | { status: 'no-account' | 'several' | 'failed' | 'blocked' | 'new' }
  | { status: 'exists'; way: 'email' };

export async function resolveGoogleSignIn(claims: GoogleClaims): Promise<GoogleSignInResult> {
  const address = claims.emailVerified ? normalizeEmail(claims.email) : null;
  if (await isIdentifierBlocked({ googleSub: claims.sub, email: address })) {
    console.warn('[signin] google: this Google account or its verified address is on the blocklist');
    return { status: 'blocked' };
  }
  const user = await findUserByIdentity('google', claims.sub);
  if (user) return { user };
  // No way added for this sub: the Google account a calendar is connected from (spec §2.17)
  const match = await matchCalendarAccount(claims);
  if (!('status' in match) || match.status !== 'new') return match;
  if (!address) {
    console.warn('[signin] google: the verified address is not one FamCal can keep; no sign-up');
    return { status: 'no-account' };
  }
  const held = await findWayByAddress(address);
  if (held?.kind === 'email') {
    console.log(`[signin] google: the verified address is user ${held.userId}'s email way; no sign-up`);
    return { status: 'exists', way: 'email' };
  }
  if (held) {
    console.warn(`[signin] google: the verified address shows on user ${held.userId}'s Google way of another Google account; no sign-up`);
    return { status: 'no-account' };
  }
  if (!signUpOpen('google')) {
    console.warn('[signin] google: no FamCal account holds this Google account, and Google sign-up is off (email sending is not set up); no sign-up');
    return { status: 'no-account' };
  }
  console.log('[signin] google: no FamCal account holds this Google account; the sign-up is offered');
  return { status: 'new' };
}
