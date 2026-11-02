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

/** The account that signs in with this (normalised) address: its user, the address as stored, the person's language. */
export async function findEmailSignIn(normalized: string): Promise<{ userId: number; address: string; language: string } | null> {
  const row = await prisma.signInIdentity.findUnique({
    where: { kind_subject: { kind: 'email', subject: normalized } },
    select: { userId: true, address: true, user: { select: { language: true } } },
  });
  return row ? { userId: row.userId, address: row.address, language: row.user.language } : null;
}

/** The account a right code signs in, while it still has that email way (it may have been removed since the code). */
export async function emailSignInAccount(userId: number, address: string): Promise<{ identityId: number; user: UserConfig } | null> {
  const row = await prisma.signInIdentity.findFirst({
    where: { kind: 'email', userId, address },
    select: { id: true, user: true },
  });
  return row ? { identityId: row.id, user: convertPrismaUserToConfig(row.user) } : null;
}

/** Marks the email way used now (Settings shows it). */
export async function touchEmailSignIn(identityId: number): Promise<void> {
  await prisma.signInIdentity.update({ where: { id: identityId }, data: { lastUsedAt: new Date() } });
}
