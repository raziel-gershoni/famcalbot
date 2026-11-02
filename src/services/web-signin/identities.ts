/**
 * The sign-in ways kept in SignInIdentity (spec §2.12): a Google account, keyed by Google's account id (`sub`), or an
 * email address. A person is never found by an address they typed, a name or a phone number.
 *
 * This file starts with the lookup the Google callback needs. Task 5 adds the email lookups (findEmailSignIn,
 * emailSignInAccount, touchEmailSignIn) below it, and Task 6 the add, list and remove functions (Task 6 rewrites the
 * file whole and keeps this lookup's signature and behaviour).
 */

import { prisma } from '../../utils/prisma';
import { convertPrismaUserToConfig, type UserConfig } from '../../types';

/** The account a sign-in way belongs to, with its last use set to now; null when no account has it. */
export async function findUserByIdentity(kind: 'google' | 'email', subject: string): Promise<UserConfig | null> {
  const identity = await prisma.signInIdentity.findUnique({
    where: { kind_subject: { kind, subject } },
    include: { user: true },
  });
  if (!identity) return null;
  await prisma.signInIdentity.update({ where: { id: identity.id }, data: { lastUsedAt: new Date() } });
  return convertPrismaUserToConfig(identity.user);
}
