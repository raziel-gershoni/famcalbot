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

import type { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { hasChat, hasWhatsApp } from '../../lib/has-chat';
import { captureSignInFailure } from './safe-error';
import { getUserById } from '../user-service';
import { convertPrismaUserToConfig, type UserConfig } from '../../types';
import { providerConfigured } from './oidc';
import { emailConfigured } from './email-send';
import { googleAccountKeyId } from './account-key';

export type IdentityKind = 'google' | 'email';
/** What Settings can remove: a Google way, the email way, or the calendar's Google account before its first use. */
export type RemovableWay = 'google' | 'email' | 'calendar-google';
/** See SignInMethodsView.googleFromCalendar. */
export type CalendarSignInState = 'on' | 'off' | null;
/**
 * A way the account always signs in with (web sign-up spec 2026-11-03 §2.12): its Telegram, its WhatsApp, a Google way
 * or an email way. The calendar's Google account is not one: disconnecting the calendar ends it.
 */
export type DurableWay = 'telegram' | 'whatsapp' | IdentityKind;

/** Settings → Sign in on the web, as GET /api/signin-methods answers it (plus the session's method). */
export interface SignInMethodsView {
  /** On for a Telegram account; nothing to add or remove */
  telegram: boolean;
  google: { address: string } | null;
  /**
   * The Google account the calendar is connected from (spec §2.17), while the account has no Google way: 'on' when it
   * would sign in (a current key, and this account the only holder); 'off' when the connection has no usable key yet
   * (Settings offers Turn on); null when there is nothing to show (no connection, a Google way, the switch off, or a
   * key several accounts hold, where Add Google is the way).
   */
  googleFromCalendar: CalendarSignInState;
  email: { address: string } | null;
  /** Which ways this server has set up (their env vars), so Settings offers only those */
  providers: { telegram: boolean; google: boolean; email: boolean };
  /** Telegram or WhatsApp: where the notices go (with none they go by email, and Settings says so) */
  chat: boolean;
  /** The account's only durable way, when it has exactly one: Settings offers no Remove on it, and the server refuses it */
  lastWay: DurableWay | null;
}

/** The P2002 Prisma answers when a unique constraint holds (read by its code, as the fakes throw it). The sign-up reads it too. */
export const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';

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

/**
 * Which way, if any, already shows this verified address (web sign-up spec §2.2): an email way whose subject is it, or
 * a Google way whose stored address is it in any case (Google gives the address as it likes). A check on an address
 * the person just proved (a right sign-up code, Google's verified email), never a sign-in: the caller only refuses a
 * second account with it. Email first. The case-blind compare is narrowed by the database and then made exact here,
 * so no character of the address acts as a pattern.
 */
export async function findWayByAddress(normalized: string): Promise<{ kind: IdentityKind; userId: number } | null> {
  const email = await prisma.signInIdentity.findUnique({
    where: { kind_subject: { kind: 'email', subject: normalized } },
    select: { userId: true },
  });
  if (email) return { kind: 'email', userId: email.userId };
  const google = await prisma.signInIdentity.findMany({
    where: { kind: 'google', address: { equals: normalized, mode: 'insensitive' } },
    select: { userId: true, address: true },
    take: 10,
  });
  const holder = google.find((row) => row.address.toLowerCase() === normalized);
  return holder ? { kind: 'google', userId: holder.userId } : null;
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

/**
 * The account that holds this way, or null; nothing is touched (Join asks it after Add Google or Add email found the
 * way taken, web sign-up spec §3.6).
 */
export async function identityHolder(kind: IdentityKind, subject: string): Promise<number | null> {
  const row = await prisma.signInIdentity.findUnique({ where: { kind_subject: { kind, subject } }, select: { userId: true } });
  return row?.userId ?? null;
}

/** The durable ways of an account, from its row and the kinds of its sign-in ways. */
function durableWays(user: { telegramId: unknown; whatsappPhone?: string | null; whatsappBsuid?: string | null }, kinds: string[]): DurableWay[] {
  const ways: DurableWay[] = [];
  if (user.telegramId !== null && user.telegramId !== undefined) ways.push('telegram');
  if (hasWhatsApp(user)) ways.push('whatsapp');
  for (const kind of ['google', 'email'] as const) if (kinds.includes(kind)) ways.push(kind);
  return ways;
}

/**
 * Where a notice goes for an account with no chat (notice.ts): its email way's address, else its Google way's, skipping
 * the kind just added (`gained`: the notice must reach a way that was there before). null when there is none.
 */
export async function noticeAddress(userId: number, gained: IdentityKind | null): Promise<{ kind: IdentityKind; address: string } | null> {
  const rows = await prisma.signInIdentity.findMany({ where: { userId }, select: { kind: true, address: true } });
  for (const kind of ['email', 'google'] as const) {
    const row = kind === gained ? undefined : rows.find(r => r.kind === kind);
    if (row) return { kind, address: row.address };
  }
  return null;
}

/** Whether the account has a way of this kind. */
export async function hasIdentity(userId: number, kind: IdentityKind): Promise<boolean> {
  const row = await prisma.signInIdentity.findUnique({ where: { userId_kind: { userId, kind } }, select: { id: true } });
  return row !== null;
}

/**
 * An account's Google and email ways, oldest first (the first is the way the account was made with when it was made on
 * famcal.bot): the bot's Connect Telegram question shows it, and the guidance names it. In `tx` when given.
 */
export async function identitiesOf(
  userId: number,
  tx?: Prisma.TransactionClient,
): Promise<Array<{ kind: IdentityKind; subject: string; address: string }>> {
  const rows = await (tx ?? prisma).signInIdentity.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { kind: true, subject: true, address: true },
  });
  return rows.map(r => ({ kind: r.kind as IdentityKind, subject: r.subject, address: r.address }));
}

/**
 * The calendar's Google account row of Settings (spec §2.17), from a user row and whether it has a Google way. null with
 * a Google way, the switch off or no connection. Otherwise 'off' while the key is missing or made under another key id
 * (no query), and 'on' only when the key is current and this account is its only holder: one count, so a Google account
 * shared by several FamCal accounts shows no calendar row (it cannot sign anyone in) and Add Google is the way.
 */
export async function calendarSignInState(
  user: { id: number; googleCalendarSignIn: boolean; googleRefreshToken: string; googleAccountKey: string | null },
  hasGoogleWay: boolean,
): Promise<CalendarSignInState> {
  if (hasGoogleWay || !user.googleCalendarSignIn || !user.googleRefreshToken) return null;
  const keyId = googleAccountKeyId();
  const key = user.googleAccountKey;
  if (!key || !keyId || !key.startsWith(`${keyId}:`)) return 'off';
  const holders = await prisma.user.count({ where: { googleAccountKey: key, googleCalendarSignIn: true, NOT: { googleRefreshToken: '' } } });
  return holders === 1 ? 'on' : null;
}

/** The account's ways, for Settings. The ways, and one count when the calendar's account has a current key. */
export async function listSignInMethods(user: UserConfig): Promise<SignInMethodsView> {
  const rows = await prisma.signInIdentity.findMany({ where: { userId: user.id }, select: { kind: true, address: true } });
  const google = rows.find(r => r.kind === 'google');
  const email = rows.find(r => r.kind === 'email');
  return {
    telegram: user.telegramId !== null,
    google: google ? { address: google.address } : null,
    googleFromCalendar: await calendarSignInState(user, Boolean(google)),
    email: email ? { address: email.address } : null,
    providers: { telegram: providerConfigured('telegram'), google: providerConfigured('google'), email: emailConfigured() },
    chat: hasChat(user),
    lastWay: lastOf(durableWays(user, rows.map(r => r.kind))),
  };
}

const lastOf = (ways: DurableWay[]): DurableWay | null => (ways.length === 1 ? ways[0] : null);

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
 * so the calendar match doesn't make it again (Add Google still works), and clears the calendar account's keyed hash:
 * with the switch off it serves no purpose, so it isn't kept (the Privacy Policy says it is kept only to sign the
 * person in; the lawyer review, finding 10). A removal that changed something ends every web
 * session: sessionsValidAfter is now (the route gives the device it came from a fresh cookie). One that found nothing
 * to remove (no such way, the calendar switch already off) changes nothing and signs nobody out.
 *
 * The account's only durable way (DurableWay; web sign-up spec §2.12) is never removed: 'last-way'. The account's row
 * is locked first (SELECT … FOR UPDATE), so a second removal at the same moment waits for this one and then counts
 * what is left: two removals at once can't take the last two ways. The calendar's row ('calendar-google') is no
 * durable way and is always removable.
 */
export async function removeSignInMethod(userId: number, which: RemovableWay): Promise<'removed' | 'last-way' | 'none'> {
  const outcome = await prisma.$transaction(async (tx): Promise<'removed' | 'last-way' | 'none'> => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { telegramId: true, whatsappPhone: true, whatsappBsuid: true, googleCalendarSignIn: true },
    });
    if (!user) return 'none';
    const kinds = (await tx.signInIdentity.findMany({ where: { userId }, select: { kind: true } })).map(r => r.kind);
    const holds = which !== 'calendar-google' && kinds.includes(which);
    const switchWasOn = which !== 'email' && user.googleCalendarSignIn === true;
    if (!holds && !switchWasOn) return 'none';
    if (holds && durableWays(user, kinds).length <= 1) return 'last-way';
    if (holds) await tx.signInIdentity.deleteMany({ where: { userId, kind: which } });
    await tx.user.update({
      where: { id: userId },
      data: { sessionsValidAfter: new Date(), ...(which === 'email' ? {} : { googleCalendarSignIn: false, googleAccountKey: null }) },
    });
    return 'removed';
  });
  const said = { removed: 'removed; every web session ends', 'last-way': 'not removed: it is the last way to sign in', none: 'not there; nothing changed' };
  console.log(`[signin] user ${userId}: the ${which} way was ${said[outcome]}`);
  return outcome;
}

/**
 * The first way of an account made on famcal.bot, written inside createAccount's transaction (user-service.ts), so the
 * account and its way are made together or not at all. The sign-up signs in with it at once, so its last use is now.
 * A way another account took meanwhile fails the unique (kind, subject) with P2002, which rolls the account back; the
 * caller answers 'taken'.
 */
export async function writeIdentityInTx(
  tx: Prisma.TransactionClient,
  userId: number,
  kind: IdentityKind,
  subject: string,
  address: string,
): Promise<void> {
  await tx.signInIdentity.create({ data: { userId, kind, subject, address, lastUsedAt: new Date() } });
}

/**
 * The account's Google account id and its sign-in address (the email way's normalised subject), null for each it
 * lacks: what a ban records (user-moderation.ts) and what signInRefusal checks (web-session.ts). `googleAddress` is
 * the address Google verified for the Google way, as stored: signInRefusal checks it against the email bans too (a
 * ban records only the email way's subject), and a ban never records it.
 */
export async function accountWays(
  userId: number,
): Promise<{ googleSub: string | null; email: string | null; googleAddress: string | null }> {
  const rows = await prisma.signInIdentity.findMany({ where: { userId }, select: { kind: true, subject: true, address: true } });
  const google = rows.find(r => r.kind === 'google');
  return {
    googleSub: google?.subject ?? null,
    email: rows.find(r => r.kind === 'email')?.subject ?? null,
    googleAddress: google?.address ?? null,
  };
}

/**
 * The accounts that sign in with this Google account or this (normalised) address: what a ban of a bare identifier
 * signs out (user-moderation.ts). At most one each, by the unique (kind, subject).
 */
export async function accountsHoldingWays(ways: { googleSub?: string | null; email?: string | null }): Promise<number[]> {
  const or: Array<{ kind: IdentityKind; subject: string }> = [];
  if (ways.googleSub) or.push({ kind: 'google', subject: ways.googleSub });
  if (ways.email) or.push({ kind: 'email', subject: ways.email });
  if (or.length === 0) return [];
  const rows = await prisma.signInIdentity.findMany({ where: { OR: or }, select: { userId: true } });
  return [...new Set(rows.map(r => r.userId))];
}
