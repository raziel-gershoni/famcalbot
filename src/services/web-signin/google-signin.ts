/**
 * Who a Google sign-in is (web sign-in spec §3, §2.17): the account that added this Google account (google, sub).
 * The one call site for the Google callback's account lookup.
 */

import type { UserConfig } from '../../types';
import type { GoogleClaims } from './oidc';
import { findUserByIdentity } from './identities';

export type GoogleSignInResult = { user: UserConfig } | { status: 'no-account' | 'several' };

export async function resolveGoogleSignIn(claims: GoogleClaims): Promise<GoogleSignInResult> {
  const user = await findUserByIdentity('google', claims.sub);
  if (user) return { user };
  // No way added for this sub. Task 7 adds the Google account a calendar is connected from (spec §2.17) here.
  return { status: 'no-account' };
}
