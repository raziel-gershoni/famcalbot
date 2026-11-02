/**
 * The ways a FamCal account signs in on the web besides Telegram (web sign-in spec §2.12, §4): one Google account and
 * one email per person, each on one account only (SignInIdentity, unique on (kind, subject) and on (userId, kind)).
 * Google is keyed on its account id (sub), never on the address; an email on its normalised form
 * (normalizeEmail). A way is added only from a proved account (Settings' Add email and Add Google) or by the calendar
 * match (calendar-account.ts), never by matching an address someone typed.
 *
 * This file is the one home of SignInIdentity access (besides the account merge in account-linking.ts), email lookups
 * by address included: the sign-in request looks an address up without touching lastUsedAt (only a finished sign-in
 * does), so those three lookups are separate from findUserByIdentity.
 *
 * No log line here holds a subject or an address: the user id and the kind only.
 */

import { prisma } from '../../utils/prisma';
import { captureSignInFailure } from './safe-error';
import { getUserById } from '../user-service';
import { convertPrismaUserToConfig, type UserConfig } from '../../types';
import { providerConfigured } from './oidc';
import { emailConfigured } from './email-send';

export type IdentityKind = 'google' | 'email';
/** What Settings can remove: a Google way, the email way, or the calendar's Google account before its first use. */
export type RemovableWay = 'google' | 'email' | 'calendar-google';

/** Settings → Sign in on the web, as GET /api/signin-methods answers it (plus the session's method). */
export interface SignInMethodsView {
  /** On for a Telegram account; nothing to add or remove */
  telegram: boolean;
  google: { address: string } | null;
  /** No Google way yet, but the Google account the calendar is connected from would sign in (spec §2.17) */
  googleFromCalendar: boolean;
  email: { address: string } | null;
  /** Which ways this server has set up (their env vars), so Settings offers only those */
  providers: { telegram: boolean; google: boolean; email: boolean };
}

/** The P2002 Prisma answers when a unique constraint holds (read by its code, as the fakes throw it). */
const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';

/**
 * The account a sign-in way belongs to, or null. A found way gets its last-used date (a failure there is logged and the
 * sign-in still goes ahead: the date is only shown in Settings).
 */
export async function findUserByIdentity(kind: IdentityKind, subject: string): Promise<UserConfig | null> {
  const identity = await prisma.signInIdentity.findUnique({
    where: { kind_subject: { kind, subject } },
    select: { id: true, userId: true },
  });
  if (!identity) return null;
  const user = await getUserById(identity.userId);
  if (!user) return null;
  try {
    await prisma.signInIdentity.update({ where: { id: identity.id }, data: { lastUsedAt: new Date() } });
  } catch (error) {
    console.error(`[signin] user ${user.id}: recording when the ${kind} way was last used failed`);
    captureSignInFailure(error, 'signin-identity-touch', { user_id: user.id, purpose: kind });
  }
  return user;
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

/** Whether the account has a way of this kind. */
export async function hasIdentity(userId: number, kind: IdentityKind): Promise<boolean> {
  const row = await prisma.signInIdentity.findUnique({ where: { userId_kind: { userId, kind } }, select: { id: true } });
  return row !== null;
}

/** The account's ways, for Settings. One query (the ways); the rest is on the row already read. */
export async function listSignInMethods(user: UserConfig): Promise<SignInMethodsView> {
  const rows = await prisma.signInIdentity.findMany({ where: { userId: user.id }, select: { kind: true, address: true } });
  const google = rows.find(r => r.kind === 'google');
  const email = rows.find(r => r.kind === 'email');
  return {
    telegram: user.telegramId !== null,
    google: google ? { address: google.address } : null,
    googleFromCalendar: !google && user.googleCalendarSignIn && Boolean(user.googleRefreshToken) && Boolean(user.googleAccountKey),
    email: email ? { address: email.address } : null,
    providers: { telegram: providerConfigured('telegram'), google: providerConfigured('google'), email: emailConfigured() },
  };
}

/**
 * Add a way to an account. 'added': a row was made (the caller sends the notice). 'kept': this same account already
 * holds this subject, nothing changed (no notice: it went out when the way was made). 'taken': another account holds
 * this subject. 'has-one': this account already has a way of this kind with another subject.
 * usedNow: the way signs in at once (Add Google, the calendar match), so its last-used date is now.
 */
export async function addIdentity(
  userId: number,
  kind: IdentityKind,
  subject: string,
  address: string,
  opts: { usedNow?: boolean } = {},
): Promise<'added' | 'kept' | 'taken' | 'has-one'> {
  const holder = await prisma.signInIdentity.findUnique({ where: { kind_subject: { kind, subject } }, select: { userId: true } });
  if (holder) return holder.userId === userId ? 'kept' : 'taken';
  if (await hasIdentity(userId, kind)) return 'has-one';
  try {
    await prisma.signInIdentity.create({
      data: { userId, kind, subject, address, ...(opts.usedNow ? { lastUsedAt: new Date() } : {}) },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another request made one of the two in between: answer what is there now. Whoever made it sends its notice.
    console.warn(`[signin] user ${userId}: adding a ${kind} way met a unique constraint; answering what is stored now`);
    const now = await prisma.signInIdentity.findUnique({ where: { kind_subject: { kind, subject } }, select: { userId: true } });
    if (now) return now.userId === userId ? 'kept' : 'taken';
    return 'has-one';
  }
  console.log(`[signin] user ${userId}: a ${kind} sign-in way was added`);
  return 'added';
}

/**
 * Remove a way (spec §4, §2.13, §2.17). Any Google removal, the calendar's row included, turns googleCalendarSignIn off,
 * so the calendar match doesn't make it again (Add Google still works). Every removal ends every web session:
 * sessionsValidAfter is now (the route gives the device it came from a fresh cookie).
 */
export async function removeSignInMethod(userId: number, which: RemovableWay): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    ...(which === 'calendar-google' ? [] : [prisma.signInIdentity.deleteMany({ where: { userId, kind: which } })]),
    prisma.user.update({
      where: { id: userId },
      data: { sessionsValidAfter: now, ...(which === 'email' ? {} : { googleCalendarSignIn: false }) },
    }),
  ]);
  console.log(`[signin] user ${userId}: the ${which} way was removed; every web session ends`);
}
