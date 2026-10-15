// Pairing service — invite/accept/unlink for the 1:1 native-calendar share
// model. Tokens are persisted in PairingInvite (DB) for the 7-day TTL plus
// miniapp-rendered "your active invite" surface.
//
// Reads + writes happen in one place so the constraints (one active partner
// per user; only NATIVE users participate; existing GCal users get a clear
// rejection) live together with the data shape.

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { Pairing, PairingInvite, User } from '@prisma/client';
import { prisma } from '../utils/prisma';

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type PairingErrorCode =
  | 'INVITE_NOT_FOUND'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_USED'
  | 'INVITE_REVOKED'
  | 'INVITER_NOT_NATIVE'
  | 'INVITER_ALREADY_PAIRED'
  | 'INVITEE_NOT_NATIVE'
  | 'INVITEE_ALREADY_PAIRED'
  | 'ALREADY_PAIRED_TOGETHER'
  | 'CANNOT_ACCEPT_OWN_INVITE'
  | 'NOT_PAIRED'
  | 'UNKNOWN_ERROR';

export class PairingError extends Error {
  code: PairingErrorCode;
  constructor(code: PairingErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PairingError';
    this.code = code;
  }
}

// --- Invite creation --------------------------------------------------------

/**
 * Create a fresh invite for the user. Revokes any prior un-accepted, un-revoked,
 * un-expired invites first so a user only ever has one "active link" at a time.
 * Caller is responsible for verifying the user is NATIVE and not already paired.
 */
export async function createInvite(inviterUserId: number): Promise<PairingInvite> {
  const inviter = await prisma.user.findUnique({
    where: { id: inviterUserId },
    select: { id: true, calendarSource: true, pairingId: true },
  });
  if (!inviter) throw new PairingError('UNKNOWN_ERROR', 'Inviter not found');
  if (inviter.calendarSource !== 'NATIVE') throw new PairingError('INVITER_NOT_NATIVE');
  if (inviter.pairingId) throw new PairingError('INVITER_ALREADY_PAIRED');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000);

  // Revoke any prior open invites and create the new one in a single transaction.
  return prisma.$transaction(async (tx) => {
    await tx.pairingInvite.updateMany({
      where: {
        inviterUserId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });
    return tx.pairingInvite.create({
      data: {
        token,
        inviterUserId,
        expiresAt,
      },
    });
  });
}

/** Look up an active invite by token without consuming it (used by the
 *  invite-landing page to render preview info). */
export async function getInviteByToken(token: string): Promise<{
  invite: PairingInvite;
  inviter: Pick<User, 'id' | 'name' | 'englishName' | 'language' | 'calendarSource' | 'pairingId'>;
} | null> {
  const invite = await prisma.pairingInvite.findUnique({ where: { token } });
  if (!invite) return null;
  if (invite.revokedAt) return null;
  if (invite.acceptedAt) return null;
  if (invite.expiresAt.getTime() <= Date.now()) return null;
  const inviter = await prisma.user.findUnique({
    where: { id: invite.inviterUserId },
    select: { id: true, name: true, englishName: true, language: true, calendarSource: true, pairingId: true },
  });
  if (!inviter) return null;
  return { invite, inviter };
}

/** Revoke a user's active invite. Idempotent. */
export async function revokeInvite(inviterUserId: number): Promise<void> {
  await prisma.pairingInvite.updateMany({
    where: { inviterUserId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// --- Invite acceptance ------------------------------------------------------

export interface AcceptResult {
  pairing: Pairing;
  inviterUserId: number;
  inviteeUserId: number;
}

/** Why an invite cannot be accepted right now, or null when it still can. */
function inviteUnavailableCode(
  invite: Pick<PairingInvite, 'revokedAt' | 'acceptedAt' | 'expiresAt'> | null
): PairingErrorCode | null {
  if (!invite) return 'INVITE_NOT_FOUND';
  if (invite.revokedAt) return 'INVITE_REVOKED';
  if (invite.acceptedAt) return 'INVITE_ALREADY_USED';
  if (invite.expiresAt.getTime() <= Date.now()) return 'INVITE_EXPIRED';
  return null;
}

/**
 * True when the inviter's ACTIVE pairing is with the acceptor: the other half of
 * a mutual accept won, the invite is a stale one between two people already
 * paired, or the acceptor is re-tapping this invite. `exceptPairingId` is the
 * pairing this accept just created, which its own reads see. Plain reads, so no
 * new lock is taken.
 */
async function pairedWithEachOther(
  tx: Prisma.TransactionClient,
  inviterUserId: number,
  acceptingUserId: number,
  exceptPairingId?: string
): Promise<boolean> {
  const inviter = await tx.user.findUnique({ where: { id: inviterUserId }, select: { pairingId: true } });
  if (!inviter?.pairingId || inviter.pairingId === exceptPairingId) return false;
  const pairing = await tx.pairing.findUnique({ where: { id: inviter.pairingId } });
  if (pairing?.status !== 'ACTIVE') return false;
  const members = [pairing.inviterUserId, pairing.inviteeUserId];
  return members.includes(inviterUserId) && members.includes(acceptingUserId);
}

/**
 * inviteUnavailableCode, except that an invite this acceptor already accepted,
 * with the two still paired, gives ALREADY_PAIRED_TOGETHER: re-tapping it later,
 * or twice at once. Anyone else keeps INVITE_ALREADY_USED.
 */
async function unavailableFor(
  tx: Prisma.TransactionClient,
  invite: PairingInvite | null,
  acceptingUserId: number
): Promise<PairingErrorCode | null> {
  const code = inviteUnavailableCode(invite);
  if (code !== 'INVITE_ALREADY_USED' || invite?.acceptedByUserId !== acceptingUserId) return code;
  return (await pairedWithEachOther(tx, invite.inviterUserId, acceptingUserId)) ? 'ALREADY_PAIRED_TOGETHER' : code;
}

/**
 * Accept an invite and link both users. Reuses constraints transactionally:
 *   - inviter still NATIVE, still unpaired
 *   - invitee NATIVE, unpaired, not the inviter themselves
 *   - all of inviter's and invitee's PRIVATE calendars get bumped to
 *     SHARED_EDITOR (matches "auto-share existing calendars on link" rule)
 *
 * Single use under concurrency: the invite is claimed, and each user's pairingId
 * is set, by a conditional UPDATE (updateMany with the "still open" / "still
 * unpaired" condition in its WHERE). Under READ COMMITTED a second writer waits
 * for the first to commit, re-checks the WHERE and updates nothing, so one token
 * (and one user) can be claimed only once. A plain read-then-write let two
 * concurrent accepts both pass the checks.
 *
 * Throws PairingError on any constraint violation. Two people already paired
 * with each other (the loser of a mutual accept, or a stale invite) get
 * ALREADY_PAIRED_TOGETHER instead of INVITER_/INVITEE_ALREADY_PAIRED, and so
 * does the acceptor re-tapping this invite instead of INVITE_ALREADY_USED.
 */
export async function acceptInvite(token: string, acceptingUserId: number): Promise<AcceptResult> {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.pairingInvite.findUnique({ where: { token } });
    if (!invite) throw new PairingError('INVITE_NOT_FOUND');
    const unavailable = await unavailableFor(tx, invite, acceptingUserId);
    if (unavailable) throw new PairingError(unavailable);
    if (invite.inviterUserId === acceptingUserId) throw new PairingError('CANNOT_ACCEPT_OWN_INVITE');

    // Claim the invite. Count 0 means another accept (or a revoke) got there first;
    // it has committed by then (the UPDATE waits for it), so the reads below see it.
    const now = new Date();
    const claimed = await tx.pairingInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now, acceptedByUserId: acceptingUserId },
    });
    if (claimed.count !== 1) {
      const current = await tx.pairingInvite.findUnique({ where: { id: invite.id } });
      throw new PairingError((await unavailableFor(tx, current, acceptingUserId)) ?? 'INVITE_ALREADY_USED');
    }

    const [inviter, invitee] = await Promise.all([
      tx.user.findUnique({
        where: { id: invite.inviterUserId },
        select: { id: true, calendarSource: true, pairingId: true },
      }),
      tx.user.findUnique({
        where: { id: acceptingUserId },
        select: { id: true, calendarSource: true, pairingId: true },
      }),
    ]);
    if (!inviter) throw new PairingError('UNKNOWN_ERROR', 'Inviter no longer exists');
    if (!invitee) throw new PairingError('UNKNOWN_ERROR', 'Acceptor no longer exists');

    if (inviter.calendarSource !== 'NATIVE') throw new PairingError('INVITER_NOT_NATIVE');
    if (invitee.calendarSource !== 'NATIVE') throw new PairingError('INVITEE_NOT_NATIVE');
    if (inviter.pairingId || invitee.pairingId) {
      if (await pairedWithEachOther(tx, inviter.id, invitee.id)) throw new PairingError('ALREADY_PAIRED_TOGETHER');
      throw new PairingError(inviter.pairingId ? 'INVITER_ALREADY_PAIRED' : 'INVITEE_ALREADY_PAIRED');
    }

    const pairing = await tx.pairing.create({
      data: {
        status: 'ACTIVE',
        inviterUserId: inviter.id,
        inviteeUserId: invitee.id,
        acceptedAt: now,
      },
    });

    // Link each side only while it is still unpaired and NATIVE; a concurrent accept
    // that paired either user first leaves count 0 and this one rolls back. Lowest
    // user id first: with inviter-then-invitee, A taking B's invite while B took A's
    // locked the two User rows in opposite orders and deadlocked. Count 0 comes only
    // once the other write has committed (the UPDATE waits for it), so the reads in
    // pairedWithEachOther see it.
    for (const userId of [inviter.id, invitee.id].sort((a, b) => a - b)) {
      const linked = await tx.user.updateMany({
        where: { id: userId, pairingId: null, calendarSource: 'NATIVE' },
        data: { pairingId: pairing.id },
      });
      if (linked.count !== 1) {
        if (await pairedWithEachOther(tx, inviter.id, invitee.id, pairing.id)) throw new PairingError('ALREADY_PAIRED_TOGETHER');
        throw new PairingError(userId === inviter.id ? 'INVITER_ALREADY_PAIRED' : 'INVITEE_ALREADY_PAIRED');
      }
    }

    // Auto-share PRIVATE calendars on both sides at the default permission.
    // Owner can later flip any back to PRIVATE or to SHARED_VIEWER.
    await tx.nativeCalendar.updateMany({
      where: { ownerUserId: { in: [inviter.id, invitee.id] }, privacy: 'PRIVATE', isDeleted: false },
      data: { privacy: 'SHARED_EDITOR' },
    });

    return { pairing, inviterUserId: inviter.id, inviteeUserId: invitee.id };
  });
}

// --- Unlink -----------------------------------------------------------------

/**
 * Unlink the requester's pairing. Both partners' pairingId is cleared and the
 * Pairing row is marked UNLINKED for audit. Calendars stay with their owners
 * (no data movement) and all of them go back to PRIVATE, so none still reads
 * "shared"; they are invisible to the partner on the next read.
 *
 * The UNLINKED write is conditional, as acceptInvite's are: count 0 means the
 * partner unlinked first, or an account merge moved the requester's side of the
 * pairing to another user in between. The members are cleared by pairingId,
 * not by the ids read above, for the same reason (the merge may have moved the
 * partner's side).
 */
export async function unlink(actingUserId: number): Promise<{ partnerUserId: number }> {
  return prisma.$transaction(async (tx) => {
    const actor = await tx.user.findUnique({
      where: { id: actingUserId },
      select: { id: true, pairingId: true },
    });
    if (!actor || !actor.pairingId) throw new PairingError('NOT_PAIRED');

    const pairing = await tx.pairing.findUnique({ where: { id: actor.pairingId } });
    if (!pairing || pairing.status !== 'ACTIVE') throw new PairingError('NOT_PAIRED');

    const partnerUserId =
      pairing.inviterUserId === actingUserId ? pairing.inviteeUserId! : pairing.inviterUserId;

    const ended = await tx.pairing.updateMany({
      where: {
        id: pairing.id,
        status: 'ACTIVE',
        OR: [{ inviterUserId: actingUserId }, { inviteeUserId: actingUserId }],
      },
      data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: actingUserId },
    });
    if (ended.count !== 1) throw new PairingError('NOT_PAIRED');
    // The members as they are now: the UNLINKED write holds the pairing row, so no
    // merge can move a side after it.
    const members = await tx.user.findMany({ where: { pairingId: pairing.id }, select: { id: true } });
    await tx.user.updateMany({
      where: { pairingId: pairing.id },
      data: { pairingId: null },
    });
    // Both people's calendars go back to PRIVATE. Users first, then calendars: the
    // order acceptInvite locks them in.
    await tx.nativeCalendar.updateMany({
      where: { ownerUserId: { in: members.map(m => m.id) }, privacy: { not: 'PRIVATE' } },
      data: { privacy: 'PRIVATE' },
    });

    return { partnerUserId };
  });
}

// --- Lookups ----------------------------------------------------------------

/**
 * Get the active partner for a user, or null. Also returns the Pairing record
 * so callers can show acceptedAt etc. in the miniapp.
 */
export async function getActivePartner(userId: number): Promise<{
  partner: Pick<User, 'id' | 'name' | 'englishName' | 'language' | 'whatsappPhone'>;
  pairing: Pairing;
} | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pairingId: true },
  });
  if (!user?.pairingId) return null;
  const pairing = await prisma.pairing.findUnique({ where: { id: user.pairingId } });
  if (!pairing || pairing.status !== 'ACTIVE') return null;
  const partnerId = pairing.inviterUserId === userId ? pairing.inviteeUserId : pairing.inviterUserId;
  if (!partnerId) return null;
  const partner = await prisma.user.findUnique({
    where: { id: partnerId },
    select: { id: true, name: true, englishName: true, language: true, whatsappPhone: true },
  });
  if (!partner) return null;
  return { partner, pairing };
}

/** Get the user's currently-active invite (if any). */
export async function getActiveInvite(userId: number): Promise<PairingInvite | null> {
  const invite = await prisma.pairingInvite.findFirst({
    where: {
      inviterUserId: userId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  return invite;
}

// Type-only re-exports for callers that build invite UIs.
export type { Pairing, PairingInvite } from '@prisma/client';
// Silence unused-import warning when only used for TS narrowing.
void (Prisma as unknown as object);
