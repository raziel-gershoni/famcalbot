// Who a native reminder belongs to (spec §2, ruling R2).
//
// The effective owner is worked out on every read, never stored: forUserId counts
// only while that user is still the creator's ACTIVE partner and still on the
// built-in calendar. Unlinking, a switch to Google or a deleted account (forUserId
// goes null) all hand the reminder back to its creator with no write, and
// re-pairing with the same person restores the link.
//
// This file reads Pairing itself and never imports event-store.ts: event-store
// imports this file, and a cycle between the two breaks partial store stubs in the
// smoke scripts (Planning Ruling 2).

import { prisma } from '../../utils/prisma';

/** The ACTIVE partner, with what reminders need to name, ping and gate them. */
export interface PartnerSummary {
  id: number;
  name: string;
  /** '' when unset (Prisma's String @default("")), so fall back with ||, not ??. */
  englishName: string;
  gender: string;
  calendarSource: 'GOOGLE' | 'NATIVE';
  telegramId: bigint | null;
  language: string;
}

/** Whoever is reading reminders, and their ACTIVE partner (null when unpaired). */
export interface ViewerContext {
  viewerId: number;
  partner: PartnerSummary | null;
}

/**
 * The other member of the user's ACTIVE pairing, or null. The pairing rule is
 * event-store's getPartnerUserId, repeated here so the two files never import each other.
 */
export async function getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null> {
  if (!pairingId) return null;
  const pair = await prisma.pairing.findUnique({
    where: { id: pairingId },
    select: { status: true, inviterUserId: true, inviteeUserId: true },
  });
  if (!pair || pair.status !== 'ACTIVE') return null;
  const partnerId = pair.inviterUserId === userId ? pair.inviteeUserId : pair.inviterUserId;
  if (partnerId == null) return null;
  return prisma.user.findUnique({
    where: { id: partnerId },
    select: { id: true, name: true, englishName: true, gender: true, calendarSource: true, telegramId: true, language: true },
  });
}

/** Load once per fetch or digest; every ownership check for this viewer reads it. */
export async function loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext> {
  return { viewerId: user.id, partner: await getActivePartnerSummary(user.id, user.pairingId ?? null) };
}

/** forUserId counts only while it is the creator's ACTIVE partner and that partner is NATIVE; otherwise the creator. */
export function effectiveOwnerId(
  series: { creatorUserId: number; forUserId: number | null },
  creatorPartner: { id: number; calendarSource: string } | null
): number {
  if (series.forUserId == null || !creatorPartner) return series.creatorUserId;
  if (series.forUserId !== creatorPartner.id || creatorPartner.calendarSource !== 'NATIVE') return series.creatorUserId;
  return creatorPartner.id;
}

/**
 * effectiveOwnerId seen from a viewer, with no extra query. The viewer's ACTIVE
 * partner is the creator's partner when the viewer created it, and the viewer is
 * the creator's partner when the partner created it (the viewer reads the built-in
 * calendar, so is NATIVE). Anyone else's reminder stays its creator's.
 */
export function effectiveOwnerForViewer(series: { creatorUserId: number; forUserId: number | null }, ctx: ViewerContext): number {
  const creatorPartner =
    series.creatorUserId === ctx.viewerId
      ? ctx.partner
      : ctx.partner && series.creatorUserId === ctx.partner.id
        ? { id: ctx.viewerId, calendarSource: 'NATIVE' }
        : null;
  return effectiveOwnerId(series, creatorPartner);
}
