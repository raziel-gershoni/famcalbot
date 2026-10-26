// Who a native reminder belongs to (spec §2, ruling R2).
//
// The effective owner is worked out on every read, never stored: forUserId counts
// only while that user is still the creator's ACTIVE partner. Unlinking or a
// deleted account (forUserId goes null) hands the reminder back to its creator
// with no write, and re-pairing with the same person restores the link. Google is
// a connection beside FamCal, so it changes nothing here.
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
  telegramId: bigint | null;
  language: string;
  /** HH:mm or null (09:00): when their date-only reminders ping. */
  reminderTime?: string | null;
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
    select: { id: true, name: true, englishName: true, gender: true, telegramId: true, language: true, reminderTime: true },
  });
}

/** Load once per fetch or digest; every ownership check for this viewer reads it. */
export async function loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext> {
  return { viewerId: user.id, partner: await getActivePartnerSummary(user.id, user.pairingId ?? null) };
}

/** forUserId counts only while it is the creator's ACTIVE partner; otherwise the creator. */
export function effectiveOwnerId(
  series: { creatorUserId: number; forUserId: number | null },
  creatorPartner: { id: number } | null
): number {
  if (series.forUserId == null || !creatorPartner) return series.creatorUserId;
  if (series.forUserId !== creatorPartner.id) return series.creatorUserId;
  return creatorPartner.id;
}

/** The reminder columns that say who it is for. */
export type ReminderSeriesColumns = { creatorUserId: number; forUserId: number | null; forBoth?: boolean };
type RecipientColumns = ReminderSeriesColumns;

/**
 * Everyone a reminder pings and shows to, creator first. A reminder for both partners
 * (forBoth, with forUserId the partner) is for the creator and that partner while R2 still
 * accepts forUserId; otherwise the creator alone. A single reminder is the effective owner
 * alone. The ONE recipients rule: the pass, the actions, the digests, the calendar and the
 * editor all ask it, none re-derives it.
 */
export function recipientIds(series: RecipientColumns, creatorPartner: { id: number } | null): number[] {
  const owner = effectiveOwnerId(series, creatorPartner);
  if (!series.forBoth) return [owner];
  return owner === series.creatorUserId ? [series.creatorUserId] : [series.creatorUserId, owner];
}

/**
 * Whose ping a snooze or an undo by `actorId` is about: their own when they are a
 * recipient; else (the creator of someone else's single reminder) its one recipient.
 * The Mini App shows the same ping's snooze.
 */
export function pingUserFor(recipients: number[], actorId: number): number {
  return recipients.includes(actorId) ? actorId : recipients[0];
}

/**
 * The snooze the viewer sees on an occurrence: their own (each partner snoozes for themselves),
 * or, for the creator of someone else's single reminder, its one recipient's. Null when none.
 */
export function viewerSnoozedUntil(
  series: ReminderSeriesColumns,
  state: { pings: Array<{ userId: number; snoozedUntil: Date | null }> } | undefined,
  ctx: ViewerContext
): Date | null {
  const pingUserId = pingUserFor(recipientIdsForViewer(series, ctx), ctx.viewerId);
  return state?.pings.find((p) => p.userId === pingUserId)?.snoozedUntil ?? null;
}

/**
 * The creator's ACTIVE partner, seen from a viewer with no extra query: the viewer's own
 * partner when the viewer created it, the viewer when the viewer's partner did, otherwise
 * unknown (null).
 */
function creatorPartnerForViewer(series: { creatorUserId: number }, ctx: ViewerContext): { id: number } | null {
  if (series.creatorUserId === ctx.viewerId) return ctx.partner;
  return ctx.partner && series.creatorUserId === ctx.partner.id ? { id: ctx.viewerId } : null;
}

/**
 * effectiveOwnerId seen from a viewer, with no extra query. The viewer's ACTIVE
 * partner is the creator's partner when the viewer created it, and the viewer is
 * the creator's partner when the partner created it. Anyone else's reminder stays its
 * creator's.
 */
export function effectiveOwnerForViewer(series: { creatorUserId: number; forUserId: number | null }, ctx: ViewerContext): number {
  return effectiveOwnerId(series, creatorPartnerForViewer(series, ctx));
}

/** recipientIds seen from a viewer, with no extra query. */
export function recipientIdsForViewer(series: RecipientColumns, ctx: ViewerContext): number[] {
  return recipientIds(series, creatorPartnerForViewer(series, ctx));
}
