// The copy links' side of a Google commit (google-sync spec §3 Asked only on first use, §4
// Token or scopes), and the copy calendars FamCal never shows back (§2 Never shown back).
//
// - A commit puts the user's links that stopped on the token, the permission or another
//   Google account back to work, with their retries cleared, so the worker picks them up at
//   once (and checks the account again: a token still of another account goes back to
//   'otherAccount').
// - A 'sync' consent's commit turns the copy on: a new link, or the one kept from an
//   earlier turn-off (re-enable), after re-checking the calendar is still the user's own.
// - Every Google calendar a link of the user ever held is hidden from FamCal's Google lists.

import { prisma } from '../../utils/prisma';
import { openSyncGate } from './gate';
import { clearLinkRetries } from './retries';
import { hasSyncScope } from './scopes';
import { linkToken } from './markers';

/** What a 'sync' consent carries from the callback to the commit (the pending entry). */
export interface SyncConsent {
  nativeCalendarId: string;
  /** The account the consent was given in (googleAccountOf); null when Google didn't say. */
  googleAccount: string | null;
}

/**
 * The states a commit ends: the token was dead, the permission was missing, or the token was
 * another Google account's. A new token may be the copy's own account again, and nothing
 * else ever re-checks a link in 'otherAccount' (the worker leaves it alone), so the commit
 * puts it back to work and the worker's account check decides again.
 */
const COMMIT_ENDS = ['token', 'scopes', 'otherAccount'];

/** Where a link goes when it works again: 'ok', or 'creating' while it has no Google calendar yet; 'scopes' without the permission. */
function workingState(googleCalendarId: string | null, scopes: readonly string[]): string {
  if (!hasSyncScope(scopes)) return 'scopes';
  return googleCalendarId ? 'ok' : 'creating';
}

/**
 * Where a commit puts a link stopped on the token or the permission, or null to leave it:
 * an enabled link goes back to work; a turned-off one only when it has a turn-off
 * (unlinkChoice) on a Google calendar it holds, or one still queued (dirtySeq > pushedSeq).
 * A queued one with no stored id may still own a calendar (a create whose id was never
 * stored), which the worker's turn-off looks up by its token, so it goes back too; a
 * turned-off link with no Google calendar and nothing queued is left as it is.
 */
function restoredState(
  link: { enabled: boolean; googleCalendarId: string | null; unlinkChoice: string | null; dirtySeq: number; pushedSeq: number },
  scopes: readonly string[],
): string | null {
  if (!link.enabled && !(link.unlinkChoice && (link.googleCalendarId || link.dirtySeq > link.pushedSeq))) return null;
  return workingState(link.googleCalendarId, scopes);
}

/**
 * After a commit saved a token with these granted scopes: the user's links in 'token',
 * 'scopes' or 'otherAccount' go back to work ('ok' or 'creating'), or to 'scopes' when the
 * grant still lacks calendar.app.created, and their items' nextAttemptAt and the links' own
 * backoff (retries.ts) are cleared. A turned-off link goes back only for its Remove/Keep
 * (restoredState); one with no Google calendar and nothing queued is left as it is. Other states
 * ('gone', 'plan', 'error') are the worker's to decide. Opens the gate when a link changed.
 * Returns the link ids it changed.
 */
export async function restoreSyncLinks(userId: number, scopes: readonly string[]): Promise<string[]> {
  const found = await prisma.googleSyncLink.findMany({
    where: { userId, state: { in: COMMIT_ENDS } },
    select: { id: true, googleCalendarId: true, state: true, enabled: true, unlinkChoice: true, dirtySeq: true, pushedSeq: true },
  });
  const skipped = found.filter((l) => restoredState(l, scopes) === null).map((l) => l.id);
  if (skipped.length > 0) console.log(`[google-sync] user ${userId}: commit left turned-off links with no Google calendar and nothing queued [${skipped.join(',')}]`);
  const links = found.flatMap((l) => {
    const next = restoredState(l, scopes);
    return next === null ? [] : [{ ...l, next }];
  });
  const changed = links.filter((l) => l.next !== l.state);
  for (const next of ['ok', 'creating', 'scopes']) {
    const ids = changed.filter((l) => l.next === next).map((l) => l.id);
    if (ids.length > 0) await prisma.googleSyncLink.updateMany({ where: { id: { in: ids } }, data: { state: next } });
  }
  const working = links.filter((l) => l.next !== 'scopes').map((l) => l.id);
  if (working.length > 0) {
    await prisma.googleSyncItem.updateMany({ where: { linkId: { in: working }, nextAttemptAt: { not: null } }, data: { nextAttemptAt: null } });
    await clearLinkRetries(working);
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
    // A backoff left from the dropped turn-off doesn't hold the copy back.
    if (result.status === 'reenabled') await clearLinkRetries([result.linkId]);
    if (result.status !== 'already') openSyncGate();
  }
  return result;
}

/**
 * "Create it again" for a copy whose Google calendar is gone, and "Copy again from scratch?"
 * for one whose token is another Google account's (spec §4): in one transaction, every item
 * forgets its Google event and hashes and goes dirty with its retries cleared (the items
 * before the link, as the merge writes them), and the link forgets its Google calendar and
 * account, back to 'creating' with backfilledAt cleared. The worker then makes a new calendar
 * in the token's account and copies everything again. Only the user's own copy that is on and
 * in 'gone' or 'otherAccount'; false when there is none. Opens the gate.
 */
export async function recreateSyncLink(userId: number, linkId: string): Promise<boolean> {
  const done = await prisma.$transaction(async (tx) => {
    const link = await tx.googleSyncLink.findFirst({
      where: { id: linkId, userId, enabled: true, state: { in: ['gone', 'otherAccount'] }, nativeCalendar: { ownerUserId: userId, isDeleted: false } },
      select: { id: true },
    });
    if (!link) return false;
    await tx.googleSyncItem.updateMany({
      where: { linkId },
      data: { googleEventId: null, masterHash: null, slotHashes: {}, dirtySeq: { increment: 1 }, attempts: 0, nextAttemptAt: null, status: 'ok', lastError: null },
    });
    await tx.googleSyncLink.update({
      where: { id: linkId },
      data: { googleCalendarId: null, googleAccount: null, state: 'creating', backfilledAt: null, pushedName: null, lastError: null, dirtySeq: { increment: 1 } },
    });
    return true;
  });
  if (done) {
    console.log(`[google-sync] user ${userId}: copy ${linkId} is made again from scratch`);
    await clearLinkRetries([linkId]);
    openSyncGate();
  } else {
    console.warn(`[google-sync] user ${userId}: no copy ${linkId} to make again (not theirs, off, or not gone or another account)`);
  }
  return done;
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

/** What FamCal's Google lists hide of one user: the copy calendars by id, and by token. */
export interface SyncCopyFilter {
  /** Whether a Google calendar (a calendarList entry) is one of this user's copy calendars. */
  isCopy(calendar: { id?: string | null; description?: string | null }): boolean;
}

/**
 * Every Google calendar a link of the user holds, on or off, by its stored id; and one whose
 * id was never stored (a create that crashed mid-'creating', until the worker adopts it) by
 * the [famcal:<linkId>] token its description carries. One query, as syncCopyCalendarIds.
 */
export async function syncCopyFilter(userId: number): Promise<SyncCopyFilter> {
  const links = await prisma.googleSyncLink.findMany({ where: { userId }, select: { id: true, googleCalendarId: true } });
  const ids = new Set(links.flatMap((l) => (l.googleCalendarId ? [l.googleCalendarId] : [])));
  const tokens = links.map((l) => linkToken(l.id));
  return {
    isCopy: (cal) => Boolean((cal.id && ids.has(cal.id)) || (cal.description && tokens.some((t) => cal.description!.includes(t)))),
  };
}
