/**
 * Admin user-moderation helpers
 * - Suspend / unsuspend a user (soft, reversible)
 * - Hard delete a user and all related rows
 * - Ban / unban an account's identifiers: Telegram id, WhatsApp number, Google account id, sign-in address and the
 *   address of its Google way (a persistent blocklist; survives hard delete). No log line here holds an identifier: the
 *   user id and the kinds only.
 */

import type { BlockedIdentifier, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { REDIS_KEYS, subscriptionReminderKeys } from '../config/redis-keys';
import { invalidateFeatureAccessCache } from '../services/subscription-service';
import { removeUserFromCache } from '../services/reminder-cache';
import { setupTrackKeys } from '../services/setup-tracks';
import { emailKey, maskEmail, normalizeEmail } from '../services/web-signin/email-address';
import { captureError } from './error-capture';
import { readStoredToken } from '../utils/encryption';

const BLOCK_CACHE_TTL = 3600; // 1 hour — primed on ban, cleared on unban

// ============================================
// SUSPENSION
// ============================================

export function isUserSuspended(user: { suspendedAt: Date | null } | null | undefined): boolean {
  return !!user?.suspendedAt;
}

/**
 * Suspends the account and ends its web sessions (web sign-in spec §2.13): sessionsValidAfter moves to the suspension's
 * moment, so a cookie from before it stays refused after an unsuspend too (unsuspendUser leaves it).
 */
export async function suspendUser(userId: number, adminId: number, reason: string | null): Promise<void> {
  const now = new Date();
  await prisma.user.update({
    where: { id: userId },
    data: {
      suspendedAt: now,
      suspendedBy: adminId,
      suspendedReason: reason,
      sessionsValidAfter: now,
    },
  });

  await invalidateFeatureAccessCache(userId);
  console.log(`[Moderation] Admin ${adminId} suspended user ${userId}`);
}

export async function unsuspendUser(userId: number, adminId: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
    },
  });

  await invalidateFeatureAccessCache(userId);
  console.log(`[Moderation] Admin ${adminId} unsuspended user ${userId}`);
}

// ============================================
// HARD DELETE
// ============================================

/**
 * Delete a user and every row that points at them, in one transaction. The
 * schema refuses the delete (ON DELETE RESTRICT) while a calendar, an event
 * they created, a pairing, or any of the per-user rows below still holds the
 * id, so those go first:
 *   1. Unpair, with unlink()'s writes: the pairing stays as UNLINKED history,
 *      both partners' pairingId is cleared and the partner's calendars go back
 *      to PRIVATE (users first, then calendars, as acceptInvite locks them).
 *   2. Their own calendars; the events in them cascade.
 *   3. Events they created in someone else's calendar go to that calendar's
 *      owner, so the partner keeps them.
 *   4. Pairing history: a row needs its inviter, so the pairings they started
 *      go; where they were the invitee the row stays with no invitee.
 * NativeEvent.forUserId, NativeReminderState.doneByUserId and
 * PairingInvite.acceptedByUserId are SET NULL and their invites and their
 * NativeReminderPing rows CASCADE in the database, as do their copies to Google (GoogleSyncLink, and its items) and
 * their web sign-in ways (SignInIdentity). The Google
 * token goes with the user, so nothing can reach a copy afterwards: before this
 * transaction, each copy with work queued is carried out in Google synchronously
 * (google-sync spec §2): Remove for a copy that is on, the queued Remove or Keep for one
 * turned off, with the link's unlinkToken or else the user's own token, through the
 * worker's own Remove and Keep (carryOutCopiesBeforeDelete). Best effort: a failure is
 * logged with the link id and sent to Sentry, and the delete goes on. Then the user's
 * own Google token is revoked at Google (revokeGoogleToken, Disconnect Google's call),
 * best effort the same way: without it the grant would outlive the row that held it.
 * Admin ids they left in compedBy, grantedBy, suspendedBy and bannedBy stay: they
 * are plain audit columns, and compedBy != null is what marks a comp.
 * Also clears Redis caches keyed by userId.
 */
export async function hardDeleteUser(userId: number, adminId: number): Promise<void> {
  try {
    // Loaded here: the worker reaches the Google client and the calendar code, which the
    // moderation helpers' other callers (the webhooks' blocklist checks) never need.
    const { carryOutCopiesBeforeDelete } = await import('../services/google-sync/worker');
    await carryOutCopiesBeforeDelete(userId);
  } catch (error) {
    // Reading the copies failed: the delete goes on, and their Google calendars stay.
    console.error(`[Moderation] Hard delete of user ${userId}: carrying out the copies to Google failed`, error);
    captureError(error, 'google-sync-hard-delete', { user_id: userId });
  }

  // The Google token goes with the row below, and the grant would stay alive at Google with nothing left that could
  // ever use or revoke it: revoke it now, with Disconnect Google's own call (after the copies above, which needed it).
  // revokeGoogleToken logs and reports its own failure; the delete goes on either way.
  // The same tokens Disconnect Google revokes: the person's own, and any a merged-away account left on a copy link
  // (unlinkToken), which the cascade below would otherwise drop with the link while the grant lives on.
  try {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { googleRefreshToken: true } });
    const links = await prisma.googleSyncLink.findMany({ where: { userId, unlinkToken: { not: null } }, select: { id: true, unlinkToken: true } });
    const tokens = [...new Set([
      row ? readStoredToken(row.googleRefreshToken, { userId, column: 'googleRefreshToken' }) : '',
      ...links.map((l) => readStoredToken(l.unlinkToken ?? '', { userId, column: `unlinkToken of link ${l.id}` })),
    ].filter(Boolean))];
    if (tokens.length > 0) {
      const { revokeGoogleToken } = await import('../services/google-disconnect');
      for (const token of tokens) {
        if (!(await revokeGoogleToken(token, { user_id: userId }))) {
          console.warn(`[Moderation] Hard delete of user ${userId}: a Google grant could not be revoked; the delete goes on`);
        }
      }
    }
  } catch (error) {
    console.error(`[Moderation] Hard delete of user ${userId}: revoking the Google token failed; the delete goes on`, error);
    captureError(error, 'google-hard-delete-revoke', { user_id: userId });
  }

  // The person's cache keys that need their rows to be named (read before the rows go)
  const cacheKeys = await personalCacheKeys(userId);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { pairingId: true } });

    if (user?.pairingId) {
      await tx.pairing.updateMany({
        where: { id: user.pairingId, status: 'ACTIVE' },
        data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: adminId },
      });
      const partners = await tx.user.findMany({ where: { pairingId: user.pairingId, id: { not: userId } }, select: { id: true } });
      await tx.user.updateMany({ where: { pairingId: user.pairingId }, data: { pairingId: null } });
      await tx.nativeCalendar.updateMany({
        where: { ownerUserId: { in: partners.map(p => p.id) }, privacy: { not: 'PRIVATE' } },
        data: { privacy: 'PRIVATE' },
      });
    }

    await tx.nativeCalendar.deleteMany({ where: { ownerUserId: userId } });

    const elsewhere = await tx.nativeEvent.findMany({ where: { creatorUserId: userId }, select: { calendarId: true } });
    const calendars = await tx.nativeCalendar.findMany({
      where: { id: { in: [...new Set(elsewhere.map(e => e.calendarId))] } },
      select: { id: true, ownerUserId: true },
    });
    for (const calendar of calendars) {
      await tx.nativeEvent.updateMany({
        where: { creatorUserId: userId, calendarId: calendar.id },
        data: { creatorUserId: calendar.ownerUserId },
      });
    }

    await tx.pairing.deleteMany({ where: { inviterUserId: userId } });
    await tx.pairing.updateMany({ where: { inviteeUserId: userId }, data: { inviteeUserId: null } });
    await tx.pairing.updateMany({ where: { unlinkedByUserId: userId }, data: { unlinkedByUserId: null } });

    await tx.userActivity.deleteMany({ where: { userId } });
    await tx.userFeedback.deleteMany({ where: { userId } });
    await tx.usageCounter.deleteMany({ where: { userId } });
    // Our payment records go with the account (the Privacy Policy keeps only Telegram's own after a deletion)
    await tx.payment.deleteMany({ where: { userId } });
    await tx.subscription.deleteMany({ where: { userId } });
    await tx.userFeatureOverride.deleteMany({ where: { userId } });
    await tx.oAuthState.deleteMany({ where: { userId: BigInt(userId) } });
    await tx.user.delete({ where: { id: userId } });
  });

  await clearDeletedUserCaches(userId, cacheKeys);

  console.log(`[Moderation] Admin ${adminId} hard-deleted user ${userId}`);
}

/**
 * The person's Redis keys that only their rows can name: the subscription reminders (keyed by the Telegram id, or the
 * user id, and a month's end: the current month's and each payment's). Read before an account goes (hard delete, the
 * WhatsApp-only half of a merge) and handed to clearDeletedUserCaches. A read that fails is logged; the keys then
 * expire within their 30 days.
 */
export async function personalCacheKeys(userId: number): Promise<string[]> {
  try {
    const [user, subscription, payments] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } }),
      prisma.subscription.findUnique({ where: { userId }, select: { currentPeriodEnd: true } }),
      prisma.payment.findMany({ where: { userId }, select: { periodEnd: true } }),
    ]);
    return subscriptionReminderKeys([user?.telegramId, userId], [subscription?.currentPeriodEnd, ...payments.map((p) => p.periodEnd)]);
  } catch (err) {
    console.error(`[Moderation] Reading the cache keys of user ${userId} failed; they expire within 30 days:`, err);
    captureError(err, 'moderation-cache-keys', { user_id: userId }, 'warning');
    return [];
  }
}

/**
 * Best-effort cleanup of the Redis state keyed by a user id that no longer
 * exists: after a hard delete, and for the WhatsApp-only half of an account
 * merge. Drops them from the reminder cache too, so the reminder run stops
 * reading a user that is gone before the next hourly sync. Every key of the
 * person that outlives a day goes (the account's deletion clears them, not only
 * their 30 days): the access cache, the timezone, the voice flows' state, the
 * setup tracks, the copy-to-Google markers and the Google cache stamps by their
 * id, the kid-name notes by a scan of their prefix, and `extraKeys`
 * (personalCacheKeys, read before the rows went). Keys that live a day or less
 * (the Google ranges, the summary dedup, a briefing's text, the event alerts'
 * marks, the voice cards) expire on their own.
 */
export async function clearDeletedUserCaches(userId: number, extraKeys: string[] = []): Promise<void> {
  try {
    await Promise.all([
      invalidateFeatureAccessCache(userId),
      removeUserFromCache(userId),
      redis.del(
        REDIS_KEYS.userTimezone(userId),
        REDIS_KEYS.lastCreatedEvent(userId),
        REDIS_KEYS.storyImage(userId),
        REDIS_KEYS.recentEvents(userId),
        REDIS_KEYS.googleSyncOrphans(userId),
        REDIS_KEYS.googleSyncDisconnect(userId),
        REDIS_KEYS.gcalStamp(userId),
        REDIS_KEYS.gcalColours(userId),
        REDIS_KEYS.gcalGoneWarned(userId),
        ...setupTrackKeys(userId),
        ...extraKeys,
      ),
      import('../services/google-disconnect').then(({ deleteMatching }) => deleteMatching(`kidname:asked:${userId}:*`)),
    ]);
  } catch (err) {
    console.warn(`[Moderation] Redis cleanup failed for deleted user ${userId}:`, err);
    captureError(err, 'moderation-cache-cleanup', { user_id: userId }, 'warning');
  }
}

// ============================================
// BLOCKLIST
// ============================================

/**
 * The identifiers a ban names, one row each (web sign-up spec §2.8, §3.8): a Telegram id, a WhatsApp number, a Google
 * account id (`sub`), a sign-in address and the address of the account's Google way (both in normalizeEmail's form,
 * and both recorded in the `email` column). Any may be absent.
 */
export interface BlockArgs {
  telegramId?: number | bigint | null;
  whatsappPhone?: string | null;
  googleSub?: string | null;
  email?: string | null;
  /** The normalised address of the Google way (spec §10): an `email` row too, and the same kind. */
  googleAddress?: string | null;
}

/** The blocklist rows that name any of them. */
function blockFilters(args: BlockArgs): Prisma.BlockedIdentifierWhereInput[] {
  const filters: Prisma.BlockedIdentifierWhereInput[] = [];
  if (args.telegramId) filters.push({ telegramId: BigInt(args.telegramId) });
  if (args.whatsappPhone) filters.push({ whatsappPhone: args.whatsappPhone });
  if (args.googleSub) filters.push({ googleSub: args.googleSub });
  if (args.email) filters.push({ email: args.email });
  if (args.googleAddress) filters.push({ email: args.googleAddress });
  return filters;
}

/**
 * An email ban's cache key, blocked:email:<emailKey>: the keyed hash the other sign-in keys use, never the address.
 * null (logged) when SESSION_SECRET is unset, so the database answers instead (no email way can exist then).
 */
function emailCacheKey(email: string): string | null {
  try {
    return REDIS_KEYS.blockedEmail(emailKey(email));
  } catch (err) {
    console.warn(`[Moderation] No sign-in key for an email ban's cache; the database answers (${err instanceof Error ? err.name : typeof err})`);
    return null;
  }
}

/** The cache key of each identifier given. */
function blockCacheKeys(args: BlockArgs): string[] {
  const keys: string[] = [];
  if (args.telegramId) keys.push(REDIS_KEYS.blockedTelegramId(args.telegramId.toString()));
  if (args.whatsappPhone) keys.push(REDIS_KEYS.blockedWhatsAppPhone(args.whatsappPhone));
  if (args.googleSub) keys.push(REDIS_KEYS.blockedGoogleSub(args.googleSub));
  const mailKey = args.email ? emailCacheKey(args.email) : null;
  if (mailKey) keys.push(mailKey);
  const googleMailKey = args.googleAddress ? emailCacheKey(args.googleAddress) : null;
  if (googleMailKey) keys.push(googleMailKey);
  return keys;
}

/** A blocklist row's identifier, as BlockArgs. */
function argsOfRow(row: BlockedIdentifier): BlockArgs {
  return { telegramId: row.telegramId, whatsappPhone: row.whatsappPhone, googleSub: row.googleSub, email: row.email };
}

/**
 * Whether any identifier given is blocked. Cached in Redis for 1h per identifier: a ban and a hit here prime the
 * cache, and an unban clears it.
 */
export async function isIdentifierBlocked(args: BlockArgs): Promise<boolean> {
  // Quick path: the cache of each identifier given
  for (const key of blockCacheKeys(args)) {
    try {
      const cached = await redis.get<string>(key);
      if (cached === '1') return true;
    } catch (err) {
      console.warn('[Moderation] Reading the blocklist cache failed; asking the database', err);
    }
  }

  // The database
  const filters = blockFilters(args);
  if (filters.length === 0) return false;
  const blocked = await prisma.blockedIdentifier.findFirst({ where: { OR: filters } });
  if (!blocked) return false;

  // Re-prime the cache of the entry found
  const reprimeFailed = (err: unknown) => console.warn('[Moderation] Re-priming the blocklist cache failed', err);
  for (const key of blockCacheKeys(argsOfRow(blocked))) {
    redis.set(key, '1', { ex: BLOCK_CACHE_TTL }).catch(reprimeFailed);
  }
  return true;
}

/** What a blocklist entry blocks. */
export type BlockKind = 'telegram' | 'whatsapp' | 'google' | 'email';

/** A ban or unban the admin can't do: no such account or entry, or nothing to block. Its message names no identifier. */
export class BanTargetError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NO_IDENTIFIER') {
    super(`ban target: ${code}`);
    this.name = 'BanTargetError';
  }
}

/** The kinds given, in this order. */
function kindsOf(args: BlockArgs): BlockKind[] {
  const kinds: BlockKind[] = [];
  if (args.telegramId) kinds.push('telegram');
  if (args.whatsappPhone) kinds.push('whatsapp');
  if (args.googleSub) kinds.push('google');
  if (args.email || args.googleAddress) kinds.push('email');
  return kinds;
}

/**
 * Everything an account signs in with: its Telegram id, its WhatsApp number, and its Google account id, sign-in address
 * and the address Google verified for its Google way (accountWays; null when it equals the sign-in address, so one row,
 * or when normalizeEmail can't keep it, so none and the ban still goes through). The blocklist holds no BSUID, as before.
 */
async function identifiersOf(userId: number): Promise<BlockArgs> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true, whatsappPhone: true } });
  if (!user) throw new BanTargetError('NOT_FOUND');
  const { accountWays } = await import('../services/web-signin/identities');
  const ways = await accountWays(userId);
  const google = normalizeEmail(ways.googleAddress);
  return {
    telegramId: user.telegramId,
    whatsappPhone: user.whatsappPhone,
    googleSub: ways.googleSub,
    email: ways.email,
    googleAddress: google && google !== ways.email ? google : null,
  };
}

/**
 * Ban, so none of it can sign up or sign in again (web sign-up spec §2.8, §3.8).
 * - `{ userId }` (the admin panel, any account, a browser-only one included) reads the account's identifiers and records
 *   each one. A bare BlockArgs records what it names.
 * - One row per identifier, each column unique, so a second ban of the same one updates its reason.
 * - Every account that holds one of them is signed out on the web (web sign-in spec §2.13): sessionsValidAfter moves to
 *   now, in the row every request already reads, so a live cookie is refused at its next request.
 * - The cache keys are primed for an hour.
 * The log names the account (or "identifiers") and the kinds, never a value.
 */
export async function banIdentifier(
  target: { userId: number } | BlockArgs,
  adminId: number,
  reason: string | null
): Promise<{ kinds: BlockKind[] }> {
  const accountId = 'userId' in target ? target.userId : null;
  const args = accountId !== null ? await identifiersOf(accountId) : (target as BlockArgs);
  const kinds = kindsOf(args);
  if (kinds.length === 0) throw new BanTargetError('NO_IDENTIFIER');

  const record = { bannedBy: adminId, bannedReason: reason };
  const ops: Promise<unknown>[] = [];
  if (args.telegramId) {
    const telegramId = BigInt(args.telegramId);
    ops.push(prisma.blockedIdentifier.upsert({ where: { telegramId }, update: record, create: { telegramId, ...record } }));
  }
  if (args.whatsappPhone) {
    const whatsappPhone = args.whatsappPhone;
    ops.push(prisma.blockedIdentifier.upsert({ where: { whatsappPhone }, update: record, create: { whatsappPhone, ...record } }));
  }
  if (args.googleSub) {
    const googleSub = args.googleSub;
    ops.push(prisma.blockedIdentifier.upsert({ where: { googleSub }, update: record, create: { googleSub, ...record } }));
  }
  if (args.email) {
    const email = args.email;
    ops.push(prisma.blockedIdentifier.upsert({ where: { email }, update: record, create: { email, ...record } }));
  }
  if (args.googleAddress) {
    const email = args.googleAddress;
    ops.push(prisma.blockedIdentifier.upsert({ where: { email }, update: record, create: { email, ...record } }));
  }
  for (const key of blockCacheKeys(args)) ops.push(redis.set(key, '1', { ex: BLOCK_CACHE_TTL }));

  const owners: Prisma.UserWhereInput[] = [];
  if (accountId !== null) owners.push({ id: accountId });
  if (args.telegramId) owners.push({ telegramId: BigInt(args.telegramId) });
  if (args.whatsappPhone) owners.push({ whatsappPhone: args.whatsappPhone });
  if (accountId === null && (args.googleSub || args.email)) {
    const { accountsHoldingWays } = await import('../services/web-signin/identities');
    const holders = await accountsHoldingWays({ googleSub: args.googleSub, email: args.email });
    if (holders.length > 0) owners.push({ id: { in: holders } });
  }
  if (owners.length > 0) {
    ops.push(prisma.user.updateMany({ where: { OR: owners }, data: { sessionsValidAfter: new Date() } }).then(({ count }) => {
      console.log(`[Moderation] Ban by admin ${adminId}: ${count} account(s) signed out on the web`);
    }));
  }

  await Promise.all(ops);
  console.log(`[Moderation] Admin ${adminId} banned ${accountId !== null ? `user ${accountId}` : 'identifiers'}: ${kinds.join(', ')}`);
  return { kinds };
}

/**
 * Unban: one entry of the list by its id (the panel, which shows a Google account and an address masked), every
 * identifier an account has (`{ userId }`), or what a bare BlockArgs names. The rows and their cache keys go. The log
 * names the entry or the account and the kinds, never a value.
 */
export async function unbanIdentifier(
  target: BlockArgs | { userId: number } | { entryId: number },
  adminId: number
): Promise<{ kinds: BlockKind[] }> {
  let args: BlockArgs;
  let who: string;
  if ('entryId' in target) {
    const row = await prisma.blockedIdentifier.findUnique({ where: { id: target.entryId } });
    if (!row) throw new BanTargetError('NOT_FOUND');
    args = argsOfRow(row);
    who = `entry ${row.id}`;
  } else if ('userId' in target) {
    args = await identifiersOf(target.userId);
    who = `user ${target.userId}`;
  } else {
    args = target;
    who = 'identifiers';
  }
  const kinds = kindsOf(args);
  if (kinds.length === 0) throw new BanTargetError('NO_IDENTIFIER');

  const keys = blockCacheKeys(args);
  await Promise.all([
    prisma.blockedIdentifier.deleteMany({ where: { OR: blockFilters(args) } }),
    ...(keys.length > 0 ? [redis.del(...keys)] : []),
  ]);
  console.log(`[Moderation] Admin ${adminId} unbanned ${who}: ${kinds.join(', ')}`);
  return { kinds };
}

/** One entry of the admin's blocked list. */
export interface BlockedEntry {
  id: number;
  kind: BlockKind;
  /** The Telegram id and the WhatsApp number in full; a Google account by the last 4 of its id; an address masked (maskEmail) */
  shown: string;
  bannedBy: number;
  bannedReason: string | null;
  createdAt: Date;
}

/** What a row blocks, as the list shows it; null for a row with no identifier (none is ever written). */
function shownOf(row: BlockedIdentifier): { kind: BlockKind; shown: string } | null {
  if (row.telegramId !== null) return { kind: 'telegram', shown: row.telegramId.toString() };
  if (row.whatsappPhone) return { kind: 'whatsapp', shown: row.whatsappPhone };
  if (row.googleSub) return { kind: 'google', shown: `•••${row.googleSub.slice(-4)}` };
  if (row.email) return { kind: 'email', shown: maskEmail(row.email) };
  return null;
}

/** The blocked list, newest first. A Google account id and an address never leave the server whole. */
export async function listBlockedIdentifiers(): Promise<BlockedEntry[]> {
  const rows = await prisma.blockedIdentifier.findMany({ orderBy: { createdAt: 'desc' } });
  const entries: BlockedEntry[] = [];
  for (const row of rows) {
    const what = shownOf(row);
    if (!what) {
      console.warn(`[Moderation] Blocklist entry ${row.id} names no identifier; it is left out of the list`);
      continue;
    }
    entries.push({ id: row.id, ...what, bannedBy: row.bannedBy, bannedReason: row.bannedReason, createdAt: row.createdAt });
  }
  return entries;
}
