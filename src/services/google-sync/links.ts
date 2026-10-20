// The copy links' side of a Google commit (google-sync spec §3 Asked only on first use, §4
// Token or scopes), and the copy calendars FamCal never shows back (§2 Never shown back).
//
// - A commit puts the user's links that stopped on the token or the permission back to
//   work, with their items' retries cleared, so the worker picks them up at once.
// - A 'sync' consent's commit turns the copy on: a new link, or the one kept from an
//   earlier turn-off (re-enable), after re-checking the calendar is still the user's own.
// - Every Google calendar a link of the user ever held is hidden from FamCal's Google lists.

import { prisma } from '../../utils/prisma';
import { openSyncGate } from './gate';
import { hasSyncScope } from './scopes';

/** What a 'sync' consent carries from the callback to the commit (the pending entry). */
export interface SyncConsent {
  nativeCalendarId: string;
  /** The account the consent was given in (googleAccountOf); null when Google didn't say. */
  googleAccount: string | null;
}

/** The states a commit ends: the token was dead, or the permission was missing. */
const COMMIT_ENDS = ['token', 'scopes'];

/** Where a link goes when it works again: 'ok', or 'creating' while it has no Google calendar yet; 'scopes' without the permission. */
function workingState(googleCalendarId: string | null, scopes: readonly string[]): string {
  if (!hasSyncScope(scopes)) return 'scopes';
  return googleCalendarId ? 'ok' : 'creating';
}

/**
 * After a commit saved a token with these granted scopes: the user's links in 'token' or
 * 'scopes' go back to work ('ok' or 'creating'), or to 'scopes' when the grant still lacks
 * calendar.app.created, and their items' nextAttemptAt is cleared. Other states ('gone',
 * 'otherAccount', 'plan', 'error') are the worker's to decide. Opens the gate when a link
 * changed. Returns the link ids it changed.
 */
export async function restoreSyncLinks(userId: number, scopes: readonly string[]): Promise<string[]> {
  const links = await prisma.googleSyncLink.findMany({
    where: { userId, state: { in: COMMIT_ENDS } },
    select: { id: true, googleCalendarId: true, state: true },
  });
  const changed = links.filter((l) => workingState(l.googleCalendarId, scopes) !== l.state);
  for (const next of ['ok', 'creating', 'scopes']) {
    const ids = changed.filter((l) => workingState(l.googleCalendarId, scopes) === next).map((l) => l.id);
    if (ids.length > 0) await prisma.googleSyncLink.updateMany({ where: { id: { in: ids } }, data: { state: next } });
  }
  const working = links.filter((l) => workingState(l.googleCalendarId, scopes) !== 'scopes').map((l) => l.id);
  if (working.length > 0) {
    await prisma.googleSyncItem.updateMany({ where: { linkId: { in: working }, nextAttemptAt: { not: null } }, data: { nextAttemptAt: null } });
  }
  if (changed.length > 0 || working.length > 0) {
    console.log(`[google-sync] user ${userId}: commit restored links [${changed.map((l) => l.id).join(',')}] (${working.length} working)`);
    openSyncGate();
  }
  return changed.map((l) => l.id);
}

export type EnableResult = { status: 'created' | 'reenabled' | 'already'; linkId: string } | { status: 'not_owner' };

/**
 * Turn a copy on for an own FamCal calendar, in one transaction (the commit of a 'sync'
 * consent; the calendars page's turn-on when the permission is held uses it too):
 * - the calendar must still be the user's own and not deleted (a partner's data reaches
 *   only the owner's Google, spec Review focus 4), else nothing is written;
 * - no link yet: a new one, enabled, 'creating', with the consent's account, dirty;
 * - a link kept from an earlier turn-off: enabled again on the same row and Google
 *   calendar (spec §3 Re-enable). The queued Remove/Keep and its token are dropped, every
 *   item goes dirty with its hashes and retries cleared, and backfilledAt is cleared so the
 *   worker copies the calendar in full again. The stored account stays, so a token of
 *   another account shows as 'otherAccount', never as a silent second copy;
 * - a link already on: unchanged (restoreSyncLinks handles its state).
 * Opens the gate on a change.
 */
export async function enableSyncLink(userId: number, consent: SyncConsent, scopes: readonly string[]): Promise<EnableResult> {
  const result = await prisma.$transaction(async (tx): Promise<EnableResult> => {
    const calendar = await tx.nativeCalendar.findFirst({
      where: { id: consent.nativeCalendarId, ownerUserId: userId, isDeleted: false },
      select: { id: true },
    });
    if (!calendar) return { status: 'not_owner' };
    const existing = await tx.googleSyncLink.findFirst({
      where: { userId, nativeCalendarId: calendar.id },
      select: { id: true, enabled: true, googleCalendarId: true, googleAccount: true },
    });
    if (!existing) {
      const created = await tx.googleSyncLink.create({
        data: { userId, nativeCalendarId: calendar.id, googleAccount: consent.googleAccount, enabled: true, state: workingState(null, scopes), dirtySeq: 1 },
        select: { id: true },
      });
      return { status: 'created', linkId: created.id };
    }
    if (existing.enabled) return { status: 'already', linkId: existing.id };
    // The items before the link, as the merge writes them (marks, then its links), so the
    // two never lock one copy's rows in opposite orders.
    await tx.googleSyncItem.updateMany({
      where: { linkId: existing.id },
      data: { masterHash: null, slotHashes: {}, dirtySeq: { increment: 1 }, attempts: 0, nextAttemptAt: null },
    });
    await tx.googleSyncLink.update({
      where: { id: existing.id },
      data: {
        enabled: true,
        state: workingState(existing.googleCalendarId, scopes),
        unlinkChoice: null,
        unlinkToken: null,
        backfilledAt: null,
        lastError: null,
        googleAccount: existing.googleAccount ?? consent.googleAccount,
        dirtySeq: { increment: 1 },
      },
    });
    return { status: 'reenabled', linkId: existing.id };
  });
  if (result.status === 'not_owner') {
    console.warn(`[google-sync] user ${userId}: no copy made of calendar ${consent.nativeCalendarId}: not their own live calendar at commit`);
  } else {
    console.log(`[google-sync] user ${userId}: copy ${result.status} for calendar ${consent.nativeCalendarId} (link ${result.linkId})`);
    if (result.status !== 'already') openSyncGate();
  }
  return result;
}

/**
 * The Google calendar ids of every link the user has, on or off: FamCal's own copies,
 * which its Google lists (listUserCalendars, the select-calendars POST) never offer.
 */
export async function syncCopyCalendarIds(userId: number): Promise<Set<string>> {
  const links = await prisma.googleSyncLink.findMany({
    where: { userId, googleCalendarId: { not: null } },
    select: { googleCalendarId: true },
  });
  return new Set(links.flatMap((l) => (l.googleCalendarId ? [l.googleCalendarId] : [])));
}
