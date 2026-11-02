/**
 * Who a Google sign-in is (web sign-in spec §3, §2.17): the account that added this Google account (google, sub), else
 * the account whose calendar is connected from it (calendar-account.ts). The one call site for the Google callback's
 * account lookup.
 */

import type { UserConfig } from '../../types';
import type { GoogleClaims } from './oidc';
import { findUserByIdentity } from './identities';
import { matchCalendarAccount } from './calendar-account';

export type GoogleSignInResult = { user: UserConfig } | { status: 'no-account' | 'several' | 'failed' };

export async function resolveGoogleSignIn(claims: GoogleClaims): Promise<GoogleSignInResult> {
  const user = await findUserByIdentity('google', claims.sub);
  if (user) return { user };
  // No way added for this sub: the Google account a calendar is connected from (spec §2.17)
  return matchCalendarAccount(claims);
}
