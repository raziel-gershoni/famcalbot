/**
 * Disconnect Google (docs/superpowers/specs/2026-10-25-disconnect-google-design.md).
 *
 * The one code path behind Settings' "Disconnect Google", for every platform (the Mini App
 * proves the user, Telegram initData or the WhatsApp session; POST /api/google-disconnect).
 * In this order:
 *   a. (box ticked) delete the FamCal copy calendars ("FamCal · <name>") in Google while the
 *      token still works: the worker's own Remove (turnOffInGoogle), which acts only on a
 *      calendar carrying the link's [famcal:<linkId>] token. Best effort per calendar.
 *   b. revoke the token at Google. Best effort. It cuts the whole grant, calendar.app.created
 *      included, which is why (a) comes first.
 *   c. clear the local state, whatever happened in (a) and (b): the token, the scopes, the
 *      Google calendar choices, the copy links, an unfinished consent, and every Redis cache
 *      holding the user's Google data. Only a failing database transaction surfaces (nothing
 *      was cleared then, and a retry finds the copies already gone).
 *   d. the activity row.
 * Every failure on the way is logged and sent to Sentry; none stops the clear.
 */

import { Prisma } from '@prisma/client';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { safeDecrypt } from '../utils/encryption';
import { trackActivity } from './analytics-service';
import { stampGoogleCache } from './calendar-read/google';
import { copyName } from './google-sync/calendars';
import { syncGoogle, type CallBudget } from './google-sync/client';
import { clearLinkRetries } from './google-sync/retries';
import { turnOffInGoogle } from './google-sync/worker';
import { removeUserFromCache, updateUserInCache } from './reminder-cache';
import { clearGoogleTracks } from './setup-tracks';
import { invalidateFeatureAccessCache } from './subscription-service';
import { getUserById } from './user-service';

/** Google's token revocation endpoint (OAuth 2.0 for web server apps, "Revoking a token"). */
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Plenty for any user's copy calendars; not a time limit. */
const COPY_CALLS = 10_000;

export interface DisconnectResult {
  /** The copy calendars (as named in Google) that are still there and the user can remove in Google. */
  leftover: string[];
  /** Google confirmed the token is revoked (or already was). False when there was no token or the revoke failed. */
  revoked: boolean;
}

interface LinkFacts {
  id: string;
  googleCalendarId: string | null;
  googleAccount: string | null;
  unlinkToken: string | null;
  dirtySeq: number;
  pushedSeq: number;
  pushedName: string | null;
  nativeCalendar: { name: string } | null;
}

/** A stored token (as the database holds it) opened, or '' when it is empty or no key opens it. */
function openToken(stored: string | null | undefined, extra: Record<string, unknown>): string {
  if (!stored) return '';
  try {
    return safeDecrypt(stored);
  } catch (error) {
    console.error(`[google-disconnect] user ${String(extra.user_id)}: a stored Google token can't be opened`, error);
    captureError(error, 'google-disconnect-token', extra, 'warning');
    return '';
  }
}

/**
 * Revoke one token. A 400 invalid_token means Google already has it as dead: that is the
 * outcome wanted, so it counts. Returns whether the token is revoked; a failure is logged and
 * sent to Sentry here.
 */
async function revokeToken(token: string, extra: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (res.ok) return true;
    const body = await res.json().catch(() => ({})) as { error?: unknown };
    if (res.status === 400 && body.error === 'invalid_token') {
      console.log(`[google-disconnect] user ${String(extra.user_id)}: Google already had the token as revoked`);
      return true;
    }
    throw new Error(`Google's revoke answered ${res.status}${typeof body.error === 'string' ? ` ${body.error}` : ''}`);
  } catch (error) {
    console.error(`[google-disconnect] user ${String(extra.user_id)}: revoking a token failed`, error);
    captureError(error, 'google-disconnect-revoke', extra, 'warning');
    return false;
  }
}

/** Delete these Redis keys' matches, a page of the scan at a time. */
async function deleteMatching(pattern: string): Promise<void> {
  let cursor: number | string = 0;
  do {
    const [next, keys] = (await redis.scan(cursor, { match: pattern, count: 100 })) as [number | string, string[]];
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (String(cursor) !== '0');
}

/** One cache step: a failure is logged and sent to Sentry, and the next step still runs. */
async function cacheStep(userId: number, step: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`[google-disconnect] user ${userId}: clearing ${step} failed`, error);
    captureError(error, 'google-disconnect-cache', { user_id: userId, step }, 'warning');
  }
}

/**
 * Every Redis entry holding the user's Google data: the home's read cache (the stamp, which
 * also drops the in-process recurrence cache, and the stored ranges), the live colours, the
 * gone-calendars warning, the fresh limit, the connect flag, the resolved timezone (it may
 * have come from Google's calendar), the copy links' retries, the Google setup tracks, the
 * reminder cache entry and the feature access caches.
 */
async function clearGoogleCaches(userId: number, linkIds: string[]): Promise<void> {
  await cacheStep(userId, 'the read cache stamp', () => stampGoogleCache(userId));
  await cacheStep(userId, 'the cached ranges', () => deleteMatching(`gcal:range:v1:${userId}:*`));
  await cacheStep(userId, 'the fresh limits', () => deleteMatching(`gcal:fresh:${userId}:*`));
  await cacheStep(userId, 'the live colours', () => redis.del(REDIS_KEYS.gcalColours(userId)));
  await cacheStep(userId, 'the gone-calendars warning', () => redis.del(REDIS_KEYS.gcalGoneWarned(userId)));
  await cacheStep(userId, 'the connect flag', () => redis.del(REDIS_KEYS.googleConnected(userId)));
  await cacheStep(userId, 'the resolved timezone', () => redis.del(REDIS_KEYS.userTimezone(userId)));
  await cacheStep(userId, 'the copy retries', () => clearLinkRetries(linkIds));
  await cacheStep(userId, 'the setup tracks', () => clearGoogleTracks(userId));
  // The reminder cache keeps everyone who still gets reminders (everyone has FamCal), now
  // with no token and no Google choices, by the settings route's rule; the rest leave it.
  await cacheStep(userId, 'the reminder cache entry', async () => {
    const user = await getUserById(userId);
    if (!user) return;
    const remindable = user.remindersEnabled && user.telegramId !== null && !user.suspendedAt && !user.unreachableSince;
    if (!remindable) return removeUserFromCache(user.id);
    return updateUserInCache({
      id: user.id,
      telegramId: user.telegramId?.toString() ?? '',
      googleRefreshToken: user.googleRefreshToken,
      calendarAssignments: user.calendarAssignments,
      calendarSource: user.calendarSource,
      pairingId: user.pairingId,
      defaultReminderMinutes: user.defaultReminderMinutes ?? null,
      language: user.language,
      name: user.name,
      pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
      location: user.location,
    });
  });
  await cacheStep(userId, 'the feature access caches', () => invalidateFeatureAccessCache(userId));
}

export async function disconnectGoogle(userId: number, options: { deleteCopies: boolean }): Promise<DisconnectResult> {
  const user = await getUserById(userId);
  if (!user) throw new Error(`User ${userId} not found`);
  const language = user.language ?? 'en';
  const userToken = user.googleRefreshToken;
  const links: LinkFacts[] = await prisma.googleSyncLink.findMany({
    where: { userId },
    select: {
      id: true, googleCalendarId: true, googleAccount: true, unlinkToken: true, dirtySeq: true, pushedSeq: true, pushedName: true,
      nativeCalendar: { select: { name: true } },
    },
  });
  const nameOf = async (l: LinkFacts): Promise<string> => {
    const name = l.nativeCalendar?.name ?? l.pushedName;
    return name ? copyName(language, name) : 'FamCal';
  };
  const linkTokens = new Map<string, string>(links.flatMap((l) => {
    const t = openToken(l.unlinkToken, { user_id: userId, link_id: l.id });
    return t ? [[l.id, t] as [string, string]] : [];
  }));

  // a. The copy calendars, while the token works.
  const leftover: string[] = [];
  const goneLinks = new Set<string>();
  let deleted = 0;
  if (options.deleteCopies) {
    const budget: CallBudget = { left: COPY_CALLS };
    for (const link of links) {
      const token = linkTokens.get(link.id) ?? userToken;
      const extra = { user_id: userId, link_id: link.id };
      if (!token) {
        if (!link.googleCalendarId) {
          goneLinks.add(link.id); // No calendar known and no token to look one up with: nothing in Google.
        } else {
          console.warn(`[google-disconnect] user ${userId}: no token for link ${link.id}; its Google calendar stays`);
          captureError(new Error('No Google token to delete a copy calendar with'), 'google-disconnect-copy', extra, 'warning');
          leftover.push(await nameOf(link));
        }
        continue;
      }
      try {
        const { outcome } = await turnOffInGoogle(syncGoogle(token), budget, link, 'remove', language);
        console.log(`[google-disconnect] user ${userId}: link ${link.id} remove: ${outcome}`);
        if (outcome === 'deleted' || outcome === 'gone') {
          goneLinks.add(link.id);
          if (outcome === 'deleted') deleted += 1;
        } else {
          // emptied (the user's own events stay), foreign or another account: still in Google
          if (outcome !== 'emptied') captureError(new Error(`A copy calendar was left in Google (${outcome})`), 'google-disconnect-copy', { ...extra, outcome }, 'warning');
          leftover.push(await nameOf(link));
        }
      } catch (error) {
        console.error(`[google-disconnect] user ${userId}: deleting the copy of link ${link.id} failed`, error);
        captureError(error, 'google-disconnect-copy', extra, 'warning');
        leftover.push(await nameOf(link));
      }
    }
  }

  // b. The token at Google: the user's, and any a merged-away account left on a copy.
  const tokens = [...new Set([userToken, ...linkTokens.values()].filter(Boolean))];
  let revoked = tokens.length > 0;
  for (const token of tokens) {
    if (!(await revokeToken(token, { user_id: userId }))) revoked = false;
  }

  // c. Local state, always.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { googleRefreshToken: '', googleScopes: [], googleSyncNotifiedAt: null, calendarAssignments: Prisma.DbNull },
    });
    if (goneLinks.size > 0) await tx.googleSyncLink.deleteMany({ where: { id: { in: [...goneLinks] } } });
    // The rest stay, turned off with nothing queued: the worker stops, and FamCal keeps
    // hiding their Google calendars from its Google lists if the user connects again.
    for (const link of links.filter((l) => !goneLinks.has(l.id))) {
      await tx.googleSyncLink.update({
        where: { id: link.id },
        data: { enabled: false, unlinkChoice: null, unlinkToken: null, pushedSeq: link.dirtySeq, lastError: null },
      });
    }
    await tx.oAuthState.deleteMany({ where: { userId: BigInt(userId) } });
  });
  await clearGoogleCaches(userId, links.map((l) => l.id));

  // d. The activity row.
  const kept = options.deleteCopies ? 0 : links.filter((l) => l.googleCalendarId).length;
  await trackActivity(userId, 'calendar_disconnected', { provider: 'google', copies_deleted: deleted, copies_left: leftover.length + kept, revoked });
  console.log(`[google-disconnect] user ${userId}: disconnected (${deleted} copy calendars deleted, ${leftover.length} left to remove, revoked ${revoked})`);
  return { leftover, revoked };
}
