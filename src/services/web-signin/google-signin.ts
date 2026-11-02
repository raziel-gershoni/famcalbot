/**
 * Which FamCal account a Google sign-in opens (spec §3): the Google sign-in way with this Google account id (`sub`).
 * Never the email: Google's address can change hands, its account id never does.
 */

import type { UserConfig } from '../../types';
import { findUserByIdentity } from './identities';
import type { GoogleClaims } from './oidc';

export type GoogleSignInResult = { user: UserConfig } | { status: 'no-account' | 'several' };

export async function resolveGoogleSignIn(claims: GoogleClaims): Promise<GoogleSignInResult> {
  const user = await findUserByIdentity('google', claims.sub);
  if (user) return { user };
  // The match by the Google Calendar connection's account (spec §2.17) joins here, as the one other way in.
  return { status: 'no-account' };
}
