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

/**
 * Accept an invite and link both users. Reuses constraints transactionally:
 *   - inviter still NATIVE, still unpaired
 *   - invitee NATIVE, unpaired, not the inviter themselves
 *   - all of inviter's and invitee's PRIVATE calendars get bumped to
 *     SHARED_EDITOR (matches "auto-share existing calendars on link" rule)
 *
 * Throws PairingError on any constraint violation.
 */
export async function acceptInvite(token: string, acceptingUserId: number): Promise<AcceptResult> {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.pairingInvite.findUnique({ where: { token } });
    if (!invite) throw new PairingError('INVITE_NOT_FOUND');
    if (invite.revokedAt) throw new PairingError('INVITE_REVOKED');
    if (invite.acceptedAt) throw new PairingError('INVITE_ALREADY_USED');
    if (invite.expiresAt.getTime() <= Date.now()) throw new PairingError('INVITE_EXPIRED');
    if (invite.inviterUserId === acceptingUserId) throw new PairingError('CANNOT_ACCEPT_OWN_INVITE');

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
    if (inviter.pairingId) throw new PairingError('INVITER_ALREADY_PAIRED');
    if (invitee.pairingId) throw new PairingError('INVITEE_ALREADY_PAIRED');

    const pairing = await tx.pairing.create({
      data: {
        status: 'ACTIVE',
        inviterUserId: inviter.id,
        inviteeUserId: invitee.id,
        acceptedAt: new Date(),
      },
    });

    await tx.user.update({ where: { id: inviter.id }, data: { pairingId: pairing.id } });
    await tx.user.update({ where: { id: invitee.id }, data: { pairingId: pairing.id } });

    // Auto-share PRIVATE calendars on both sides at the default permission.
    // Owner can later flip any back to PRIVATE or to SHARED_VIEWER.
    await tx.nativeCalendar.updateMany({
      where: { ownerUserId: { in: [inviter.id, invitee.id] }, privacy: 'PRIVATE', isDeleted: false },
      data: { privacy: 'SHARED_EDITOR' },
    });

    await tx.pairingInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedByUserId: invitee.id },
    });

    return { pairing, inviterUserId: inviter.id, inviteeUserId: invitee.id };
  });
}

// --- Unlink -----------------------------------------------------------------

/**
 * Unlink the requester's pairing. Both partners' pairingId is cleared and the
 * Pairing row is marked UNLINKED for audit. Calendars stay with their owners
 * (no data movement); previously-shared calendars become invisible to the
 * partner on the next read.
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

    await tx.pairing.update({
      where: { id: pairing.id },
      data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: actingUserId },
    });
    await tx.user.updateMany({
      where: { id: { in: [pairing.inviterUserId, pairing.inviteeUserId!] } },
      data: { pairingId: null },
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
