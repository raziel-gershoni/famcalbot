// What the calendars page shows of the copies to Google (google-sync spec §1 Where it lives,
// §5 States): one row per own live FamCal calendar, with the copy's state and progress, and
// the partner's name for the "Only <owner> can copy this one" line on a partner's calendar.
// Read only; GET /api/google-sync serves it. Ids only on the wire: no Google ids, no names
// beyond the partner's first name.

import { prisma } from '../../utils/prisma';
import { getActivePartnerSummary } from '../native-reminders/ownership';
import { syncAllowed } from './access';
import { firstNameOf } from '../../lib/first-name';

/** A copy's row, as the page words it (messages googleCopy.status.*). */
export type CopyStatus = 'off' | 'copying' | 'copied' | 'approve' | 'reconnect' | 'plan' | 'gone' | 'otherAccount' | 'error';

export interface CopyRow {
  calendarId: string;
  /** The user's link on this calendar (on or off), for "Create it again"; null when there is none. */
  linkId: string | null;
  /** Whether the copy is on (the switch). */
  on: boolean;
  status: CopyStatus;
  /** Items copied and up to date, of all the copy's items; and those that can't be copied (§4 Unsupported). */
  copied: number;
  total: number;
  unsupported: number;
  /**
   * A 'sync' consent for this calendar can still be used: the user's one-time state for it is
   * neither used (the callback deletes it) nor expired. The page's consent wait holds only while it is.
   */
  consentOpen: boolean;
}

export interface CopiesView {
  /** Whether the page shows the copy rows: Google is connected, or a copy is on (a dead token still shows its "Needs reconnect"). */
  shown: boolean;
  /** The partner's first name, for the non-owner line on their shared calendars; null when unpaired. */
  ownerName: string | null;
  rows: CopyRow[];
}

/** How far a copy is (S3): every item, the ones copied and clean, the unsupported and the failed ones. */
export async function syncProgress(linkId: string): Promise<{ total: number; copied: number; unsupported: number; failing: number }> {
  const [total, copied, unsupported, failing] = await Promise.all([
    prisma.googleSyncItem.count({ where: { linkId } }),
    prisma.googleSyncItem.count({ where: { linkId, status: 'ok', dirtySeq: { equals: prisma.googleSyncItem.fields.pushedSeq } } }),
    prisma.googleSyncItem.count({ where: { linkId, status: 'unsupported' } }),
    prisma.googleSyncItem.count({ where: { linkId, status: 'error' } }),
  ]);
  return { total, copied, unsupported, failing };
}

interface LinkFacts {
  enabled: boolean;
  state: string;
  backfilledAt: Date | null;
}

/**
 * A copy's row status. Off when there is no link or it is turned off. A plan without
 * google_sync pauses it at once (the worker sets 'plan' on its next pass). 'creating', a
 * backfill not yet marked, or items still waiting (neither copied, unsupported nor failed)
 * read as copying; otherwise copied. The other states are the worker's (spec §4 Failures).
 */
export function copyStatus(link: LinkFacts | null, progress: { total: number; copied: number; unsupported: number; failing: number } | null, allowed: boolean): CopyStatus {
  if (!link || !link.enabled) return 'off';
  if (!allowed || link.state === 'plan') return 'plan';
  switch (link.state) {
    case 'token': return 'reconnect';
    case 'scopes': return 'approve';
    case 'gone': return 'gone';
    case 'otherAccount': return 'otherAccount';
    case 'error': return 'error';
    case 'creating': return 'copying';
  }
  const p = progress ?? { total: 0, copied: 0, unsupported: 0, failing: 0 };
  const waiting = p.total - p.copied - p.unsupported - p.failing;
  return !link.backfilledAt || waiting > 0 ? 'copying' : 'copied';
}

/**
 * The page's view for a user. `connected`: the user has a Google token. On a plan without
 * google_sync only the copies that are on are listed (as paused); the plan is peeked, so a
 * page view never logs feature_blocked.
 */
export async function copiesView(user: { id: number; pairingId: string | null }, connected: boolean): Promise<CopiesView> {
  const [calendars, allowed, partner] = await Promise.all([
    prisma.nativeCalendar.findMany({ where: { ownerUserId: user.id, isDeleted: false }, select: { id: true }, orderBy: [{ createdAt: 'asc' }] }),
    syncAllowed(user.id, false),
    getActivePartnerSummary(user.id, user.pairingId),
  ]);
  const ids = calendars.map((c) => c.id);
  const [links, openStates] = ids.length === 0 ? [[], []] : await Promise.all([
    prisma.googleSyncLink.findMany({
      where: { userId: user.id, nativeCalendarId: { in: ids } },
      select: { id: true, nativeCalendarId: true, enabled: true, state: true, backfilledAt: true },
    }),
    prisma.oAuthState.findMany({
      where: { userId: BigInt(user.id), purpose: 'sync', nativeCalendarId: { in: ids }, expiresAt: { gt: new Date() } },
      select: { nativeCalendarId: true },
    }),
  ]);
  const byCalendar = new Map(links.map((l) => [l.nativeCalendarId, l]));
  const consentOpen = new Set(openStates.map((s) => s.nativeCalendarId));
  const rows = await Promise.all(calendars.map(async (c): Promise<CopyRow> => {
    const link = byCalendar.get(c.id) ?? null;
    const progress = link?.enabled ? await syncProgress(link.id) : null;
    return {
      calendarId: c.id,
      linkId: link?.id ?? null,
      on: Boolean(link?.enabled),
      status: copyStatus(link, progress, allowed),
      copied: progress?.copied ?? 0,
      total: progress?.total ?? 0,
      unsupported: progress?.unsupported ?? 0,
      consentOpen: consentOpen.has(c.id),
    };
  }));
  const anyOn = rows.some((r) => r.on);
  const firstName = partner ? firstNameOf(partner) : null;
  return {
    shown: connected || anyOn,
    ownerName: firstName,
    rows: !connected && !anyOn ? [] : allowed ? rows : rows.filter((r) => r.on),
  };
}
