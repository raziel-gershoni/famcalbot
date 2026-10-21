// The copy-to-Google worker (google-sync spec §3, §4): one pass, run each minute while the gate
// is open (src/cron/handlers.ts handleGoogleSync), that brings every copy with work in line
// with FamCal.
//
// Pace:
// - Users with work run at most 3 at a time, each under a fail-closed Redis NX lock of its own
//   prefix (10-minute TTL, renewed per item, released in finally). The lock holds the run's
//   own token, and renewing or releasing it checks the token first (a Lua script), so a run
//   whose lock lapsed and was taken by a newer run stops, and never frees the newer run's
//   lock. A locked user is skipped; a Redis error skips the user's run.
// - Each user's run makes at most 100 Google calls; the rest waits for the next tick.
// - Calendars are created one at a time (serially, across the users running).
// - A rate-limit answer ends the user's run without counting an attempt.
//
// Per user: a suspended user is skipped. Copies turned off with a Remove/Keep queued are
// carried out first (link.unlinkToken ?? the user's token). Then, for the copies that are on:
// a lapsed plan sets 'plan' and pauses them (and they come back when it returns); no token
// or no calendar.app.created sets 'token' or 'scopes' on every link of the user, with the
// reconnect message once per outage (User.googleSyncNotifiedAt; a commit clears it and puts
// the links back); a token of another Google account than the copy's sets 'otherAccount'
// (a copy with no account yet adopts the token's; a commit puts it back to be checked again). Each copy: its Google calendar created or
// adopted ('creating' or no googleCalendarId), renamed when FamCal's name moved on, backfilled
// when backfilledAt is null, and its dirty items pushed (push.ts).
//
// Failures: an item's transient error backs off exponentially with jitter, and its 10th
// attempt in a row alerts the admin once per link per day; a transient error also ends the
// user's run (Google is likely down for the rest). A copy's own steps (the account check,
// creating or renaming its calendar, a queued Remove/Keep) back off the same way per link
// (retries.ts), with the same alert; a failure there that isn't transient only skips that
// copy, so the user's other copies still run. The copy calendar gone (a write's 404 split,
// or a rename's 404/410) sets 'gone'. A bare 401 (no OAuth error) on a request after the
// account check is a dead token only when the token fails a check too (tokenStillWorks: a
// fresh client's account call, once per run): while it works, Google refused that one
// request, which no reconnect fixes, so only that copy backs off.
// An 'unsupported' or 'error' item is tried again only once FamCal changed it (its dirtySeq
// moved past pushedSeq), with its attempts reset. Every catch logs ids, never a title.

import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { TIMEZONE } from '../../config/constants';
import { REDIS_KEYS } from '../../config/redis-keys';
import { buildUrl } from '../../config/urls';
import { getBotMessages } from '../../lib/bot-messages';
import { captureError } from '../../lib/error-capture';
import { resolveUserTimezone } from '../../lib/timezone';
import { safeDecrypt } from '../../utils/encryption';
import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { scrubbedGoogleError } from '../calendar';
import { classifyGoogleError, googleErrorFacts, isGoogleRateLimit, type GoogleErrorClass } from '../calendar-read/google-map';
import { peekFeatureAccess } from '../subscription-service';
import { ensureCopyCalendar, findCopyCalendarId, keepCopyCalendar, removeCopyCalendar, renameCopyCalendar, type TurnOffOutcome } from './calendars';
import { BudgetSpent, CALLS_PER_RUN, counted, syncGoogle, type CallBudget, type SyncGoogle } from './client';
import { hebrewHorizonFrom, storedHebrewFrom } from './hebrew';
import { markSyncDirty, markedTransaction, type UnlinkChoice } from './marks';
import { CalendarGone, ONE_OFF_LOOKBACK_MS, pushItem, type PushItem } from './push';
import { clearLinkRetries, readLinkRetries, writeLinkRetry, type LinkRetry } from './retries';
import { hasSyncScope } from './scopes';

/** The lock outlives any one item; it is renewed before each. */
export const SYNC_LOCK_TTL_S = 600;
export const USERS_AT_ONCE = 3;
/** The admin hears of an item (or a copy's own step) failing this many times in a row. */
export const ALERT_AFTER_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
/** A run cut short (budget, rate limit, lock, Google down) goes on at the next tick. */
const AGAIN_MS = 60_000;
const HEBREW_CHECK_MS = 24 * 60 * 60 * 1000;
/** Rows per backfill statement (Postgres caps bind parameters; each row is three). */
const BACKFILL_CHUNK = 1000;
/** The hard delete's Remove isn't paced by runs: a generous ceiling all the same. */
const HARD_DELETE_CALLS = 10_000;

/** The states a copy that is on works in; any other waits for the user or a commit. */
const WORKING = ['ok', 'creating', 'plan'];
/** A turned-off copy's queued Remove/Keep waits in these: the token or the account must change first. */
const WAITING = ['token', 'scopes', 'otherAccount'];

const LINK_SELECT = {
  id: true, userId: true, nativeCalendarId: true, googleCalendarId: true, googleAccount: true, enabled: true, state: true,
  unlinkChoice: true, unlinkToken: true, dirtySeq: true, pushedSeq: true, pushedName: true, backfilledAt: true, lastError: true,
  nativeCalendar: { select: { name: true, ownerUserId: true, isDeleted: true } },
} as const;
type LinkRow = Prisma.GoogleSyncLinkGetPayload<{ select: typeof LINK_SELECT }>;

const USER_SELECT = {
  id: true, name: true, language: true, location: true, telegramId: true, whatsappPhone: true, whatsappBsuid: true,
  suspendedAt: true, unreachableSince: true, googleRefreshToken: true, googleScopes: true, googleSyncNotifiedAt: true,
} as const;
type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

const ITEM_SELECT = {
  id: true, nativeEventId: true, googleEventId: true, generation: true, masterHash: true, slotHashes: true,
  dirtySeq: true, status: true, lastError: true, attempts: true,
} as const;

/** The user's run lost its lock (the TTL ran out, or Redis failed renewing it): it stops, fail-closed. */
class LockLost extends Error {}
/** Google failed for a reason that likely holds for the user's other items too: the run stops here. */
class TransientStop extends Error {}

interface UserRun {
  user: UserRow;
  budget: CallBudget;
  now: Date;
  lockKey: string;
  /** This run's own value in the lock: renew and release act only while the lock still holds it. */
  lockToken: string;
  /** The user's backed-off links (retries.ts), read by the pass. */
  retries: Map<string, LinkRetry>;
  pushed: number;
  failed: number;
  /** Work is left that the next tick should take: the gate stays open. */
  again: boolean;
  /** The token check after a bare 401 on one request (tokenStillWorks); asked at most once per run. */
  tokenCheck?: 'works' | 'dead' | 'inconclusive';
}

export interface SyncPassResult {
  users: number;
  pushed: number;
  failed: number;
  /** When the next pass should read the database, or null for the gate's ceiling. */
  next: Date | null;
}

// ---- Shared state on globalThis (Next 16 gives the scheduler and the routes separate module instances) ----

type WorkerState = { creation: Promise<unknown>; hebrewCheckedAt: number };
const shared = ((globalThis as { __googleSyncWorker?: WorkerState }).__googleSyncWorker ??= { creation: Promise.resolve(), hebrewCheckedAt: 0 });

/** Calendar creation is serial (spec §4 Pace): one calendars.insert at a time in the process. */
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = shared.creation.then(task, task);
  shared.creation = run.then(() => undefined, () => undefined);
  return run;
}

/** Smoke scripts only: a fresh process's worker state. */
export function __resetSyncWorkerForTests(): void {
  shared.creation = Promise.resolve();
  shared.hebrewCheckedAt = 0;
}

// ---- Small helpers ----

const classOf = (error: unknown): GoogleErrorClass => classifyGoogleError(error);
/** A Google error as logged (class, status, reasons, Google's message), never its request; anything else as it is. */
function loggable(error: unknown): unknown {
  const e = error as { response?: unknown; config?: unknown } | null;
  return e && typeof e === 'object' && ('response' in e || 'config' in e) ? scrubbedGoogleError(error, classOf(error)) : error;
}

/** Exponential with jitter: 1 min, 2, 4 … up to 6 h, each between half and all of it. */
export function backoffMs(attempts: number, random = Math.random): number {
  const full = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(full / 2 + random() * (full / 2));
}

/** Run `work` over `items`, at most `limit` at once. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(lanes);
}

const tokenOf = (encrypted: string | null | undefined) => (encrypted ? safeDecrypt(encrypted) : '');
const NO_TOKEN = 'no Google token stored';
/** An error as one log line: a Google error's facts (loggable), anything else its message. */
const describe = (error: unknown): string => {
  const e = loggable(error);
  return e instanceof Error ? e.message : String(e);
};

// ---- The pass ----

/**
 * One pass over every copy with work. Returns the counts and when the next pass is due (the
 * earliest retry, or the next tick when a run was cut short), for the gate.
 */
export async function runGoogleSyncPass(now: Date = new Date()): Promise<SyncPassResult> {
  await refreshHebrewHorizons(now);
  const itemFields = prisma.googleSyncItem.fields;
  const links = await prisma.googleSyncLink.findMany({
    where: {
      OR: [
        { enabled: true, state: { in: WORKING } },
        { enabled: false, unlinkChoice: { not: null }, dirtySeq: { gt: prisma.googleSyncLink.fields.pushedSeq }, state: { notIn: WAITING } },
      ],
    },
    select: LINK_SELECT,
  });
  if (links.length === 0) return { users: 0, pushed: 0, failed: 0, next: null };
  const ids = links.map((l) => l.id);
  const dirty = { linkId: { in: ids }, dirtySeq: { gt: itemFields.pushedSeq } };
  const [due, later] = await Promise.all([
    prisma.googleSyncItem.groupBy({ by: ['linkId'], where: { ...dirty, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, _count: { _all: true } }),
    prisma.googleSyncItem.groupBy({ by: ['linkId'], where: { ...dirty, nextAttemptAt: { gt: now } }, _min: { nextAttemptAt: true } }),
  ]);
  const dueLinks = new Set(due.map((d) => d.linkId));
  let next: Date | null = null;
  const sooner = (d: Date | null | undefined) => {
    if (d && (!next || d < next)) next = d;
  };
  for (const l of later) sooner(l._min.nextAttemptAt);

  const hasWork = (l: LinkRow) =>
    !l.enabled || l.state === 'plan' || !l.googleCalendarId || !l.backfilledAt || l.dirtySeq > l.pushedSeq
    || (l.nativeCalendar !== null && l.nativeCalendar.name !== l.pushedName) || dueLinks.has(l.id);
  const withWork = links.filter(hasWork);
  // A copy whose own step failed waits out its backoff (retries.ts); its time is the gate's next.
  const retries = await readLinkRetries(withWork.map((l) => l.id));
  const byUser = new Map<number, LinkRow[]>();
  for (const l of withWork) {
    const retry = retries.get(l.id);
    if (retry && retry.at > now.getTime()) {
      sooner(new Date(retry.at));
      continue;
    }
    byUser.set(l.userId, [...(byUser.get(l.userId) ?? []), l]);
  }
  if (byUser.size === 0) return { users: 0, pushed: 0, failed: 0, next };

  const users = await prisma.user.findMany({ where: { id: { in: [...byUser.keys()] } }, select: USER_SELECT });
  let pushed = 0;
  let failed = 0;
  await pool(users, USERS_AT_ONCE, async (user) => {
    const own = byUser.get(user.id) ?? [];
    const run = await runUser(user, own, now, new Map(own.flatMap((l) => (retries.has(l.id) ? [[l.id, retries.get(l.id)!] as const] : []))));
    pushed += run.pushed;
    failed += run.failed;
    if (run.again) sooner(new Date(now.getTime() + AGAIN_MS));
  });
  return { users: users.length, pushed, failed, next };
}

/** One user's run, under the user's lock. Never throws: what stops it is logged here. */
async function runUser(user: UserRow, links: LinkRow[], now: Date, retries: Map<string, LinkRetry>): Promise<UserRun> {
  const run: UserRun = {
    user, budget: { left: CALLS_PER_RUN }, now, lockKey: REDIS_KEYS.googleSyncLock(user.id), lockToken: randomUUID(), retries, pushed: 0, failed: 0, again: false,
  };
  if (user.suspendedAt) {
    console.log(`[google-sync] user ${user.id}: suspended; copies skipped`);
    return run;
  }
  try {
    const took = await redis.set(run.lockKey, run.lockToken, { nx: true, ex: SYNC_LOCK_TTL_S });
    if (took !== 'OK') {
      console.log(`[google-sync] user ${user.id}: another run holds the lock; skipped`);
      run.again = true;
      return run;
    }
  } catch (error) {
    // Fail closed: two runs at once could each create the calendar or insert the same event.
    captureError(error, 'google-sync-lock', { user_id: user.id, step: 'take' });
    run.again = true;
    return run;
  }
  try {
    for (const link of links.filter((l) => !l.enabled)) await turnOffLink(run, link);
    const on = links.filter((l) => l.enabled);
    if (on.length > 0) await syncLinks(run, on);
  } catch (error) {
    await stopUser(run, error);
  } finally {
    try {
      // Only while it is still this run's: a lock a newer run took after this one's lapsed stays.
      const freed = await redis.eval(RELEASE_LOCK, [run.lockKey], [run.lockToken]);
      if (freed !== 1) console.warn(`[google-sync] user ${user.id}: the lock was no longer this run's at release; left to its holder`);
    } catch (error) {
      // The TTL frees it.
      captureError(error, 'google-sync-lock', { user_id: user.id, step: 'release' }, 'warning');
    }
  }
  return run;
}

/** What ended a user's run early. */
async function stopUser(run: UserRun, error: unknown): Promise<void> {
  const userId = run.user.id;
  if (error instanceof BudgetSpent) {
    console.log(`[google-sync] user ${userId}: used the run's ${CALLS_PER_RUN} Google calls; the rest goes on next tick`);
    run.again = true;
    return;
  }
  if (error instanceof LockLost || error instanceof TransientStop) {
    run.again = true;
    return;
  }
  if (isGoogleRateLimit(error)) {
    // Not an attempt, and not a Sentry event: Google asked to slow down.
    console.warn(`[google-sync] user ${userId}: Google rate limit; paused until the next tick`);
    run.again = true;
    return;
  }
  const cls = classOf(error);
  if (cls === 'token' || cls === 'scopes') {
    await outage(run, cls, describe(error));
    return;
  }
  if (cls === 'transient') {
    console.warn(`[google-sync] user ${userId}: Google unavailable (${loggable(error) instanceof Error ? (loggable(error) as Error).message : 'error'}); tried again next tick`);
    run.again = true;
    return;
  }
  console.error(`[google-sync] user ${userId}: run failed`, loggable(error));
  captureError(loggable(error), 'google-sync-user', { user_id: userId });
}

/**
 * The user's Google stopped working for the copies: every copy that was working waits in this
 * state; the user hears once per outage. `cause` says why (Google's answer, ids masked, or no
 * token stored), so the log tells a dead token from a refused request.
 */
async function outage(run: UserRun, reason: 'token' | 'scopes', cause: string): Promise<void> {
  const { user } = run;
  const { count } = await prisma.googleSyncLink.updateMany({
    where: { userId: user.id, state: { in: [...WORKING, reason === 'token' ? 'scopes' : 'token'] } },
    data: { state: reason },
  });
  if (count > 0) {
    console.warn(`[google-sync] user ${user.id}: Google ${reason} (${cause}); ${count} copies wait for a reconnect`);
    captureError(new Error(`Google ${reason} for the copies to Google`), 'google-sync-outage', { user_id: user.id, links: count, cause }, 'warning');
  }
  if (user.googleSyncNotifiedAt) return;
  try {
    if (await sendReconnect(user, reason)) {
      // The run's snapshot too: another outage call in this run (a queued turn-off, then the copies that are on) sends nothing more.
      user.googleSyncNotifiedAt = run.now;
      await prisma.user.update({ where: { id: user.id }, data: { googleSyncNotifiedAt: run.now } });
      console.log(`[google-sync] user ${user.id}: reconnect message sent (${reason})`);
    }
  } catch (error) {
    console.error(`[google-sync] user ${user.id}: reconnect message failed`, error);
    captureError(error, 'google-sync-reconnect-message', { user_id: user.id, reason }, 'warning');
  }
}

/**
 * The sync reconnect message (spec §4 Token or scopes), in the user's language. On Telegram
 * with a button: a dead token opens /refresh-token; a missing permission opens the calendars
 * page, where "Copy to Google" asks for it. A WhatsApp-only user gets the settings template
 * (a proactive WhatsApp send must be a template). False when there was no one to send to.
 */
async function sendReconnect(user: UserRow, reason: 'token' | 'scopes'): Promise<boolean> {
  if (user.unreachableSince) {
    console.log(`[google-sync] user ${user.id}: unreachable; no reconnect message`);
    return false;
  }
  const lang = user.language || 'en';
  const t = (await getBotMessages(lang)).googleSync.reconnect;
  const userParam = `user_id=${user.telegramId ?? user.id}`;
  if (user.telegramId) {
    const url = reason === 'token' ? buildUrl(`/refresh-token?${userParam}`) : buildUrl(`/${lang}/calendars?${userParam}`);
    const { getMessagingService } = await import('../telegram');
    const { MessageFormat } = await import('../messaging/types');
    await getMessagingService().sendMessage(Number(user.telegramId), `${t.title}\n\n${reason === 'token' ? t.messageToken : t.messageScopes}`, {
      format: MessageFormat.HTML,
      replyMarkup: { inline_keyboard: [[{ text: reason === 'token' ? t.buttonReconnect : t.buttonOpen, web_app: { url } }]] },
    });
    return true;
  }
  const waChatId = user.whatsappPhone || user.whatsappBsuid;
  if (waChatId) {
    const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
    const { getWhatsAppService } = await import('../messaging/factory');
    await getWhatsAppService().sendMessage(waChatId, '', { whatsappTemplate: buildWhatsAppTemplate(lang, 'settings') });
    return true;
  }
  return false;
}

/** The lock's TTL renewed only while it still holds this run's token: 1 renewed, 0 not ours (lapsed, or a newer run's). */
const RENEW_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
/** The lock deleted only while it still holds this run's token: 1 freed, 0 not ours. */
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Renew the user's lock before an item; fail-closed when it can't be, or when it is no longer this run's. */
async function renewLock(run: UserRun): Promise<void> {
  let kept: unknown;
  try {
    kept = await redis.eval(RENEW_LOCK, [run.lockKey], [run.lockToken, String(SYNC_LOCK_TTL_S)]);
  } catch (error) {
    captureError(error, 'google-sync-lock', { user_id: run.user.id, step: 'renew' });
    throw new LockLost();
  }
  if (kept !== 1) {
    console.warn(`[google-sync] user ${run.user.id}: the run's lock lapsed or another run holds it; stopping`);
    throw new LockLost();
  }
}

// ---- A copy's own steps: backoff, alert, and back to normal ----

/** Errors that end the user's whole run, not just one copy's step. */
function stopsRun(error: unknown): boolean {
  if (error instanceof BudgetSpent || error instanceof LockLost || error instanceof TransientStop || isGoogleRateLimit(error)) return true;
  const cls = classOf(error);
  return cls === 'token' || cls === 'scopes';
}

/** The step label of a copy whose own request Google refused while the token works (linkFailed, and the admin's alert). */
const TOKEN_WORKS = '401 though the token works';

/** Marks a failed account check (a turn-off's own, turnOffInGoogle): that call is the check, so its 401 is never checked again. */
const ACCOUNT_CHECK = Symbol('google-sync account check');
const accountCheckFailed = (error: unknown): unknown => (error && typeof error === 'object' ? Object.assign(error, { [ACCOUNT_CHECK]: true }) : error);

/**
 * Whether a 401 on one request should spare the user the outage. Production (2026-10-21):
 * Google answered one request 401 "Invalid Credentials" right after the same token had listed
 * the calendars, and a reconnect can't fix that. So a bare 401 (no OAuth error: invalid_grant
 * and admin_policy_enforced stay a dead token; an account check's own 401 is the check) is
 * checked once per run with an account call on a fresh client, which mints a new access token
 * from the refresh token (the run's client would resend the same one).
 * - The check works: Google refused only that request; that copy backs off (true).
 * - The check answers 'token': the outage, as before (false). 'scopes': that outage (thrown).
 * - Cut short (the budget, a rate limit, Google down, no answer): thrown, ending the run for
 *   the next tick.
 * - Anything else says nothing about the token: logged and sent to Sentry, and the copy backs
 *   off (true), so its attempts count and the 10th tells the admin.
 */
async function tokenStillWorks(run: UserRun, token: string, error: unknown): Promise<boolean> {
  if (classOf(error) !== 'token' || googleErrorFacts(error).oauth) return false;
  if ((error as { [ACCOUNT_CHECK]?: boolean })[ACCOUNT_CHECK]) return false;
  // Asked already: a later copy's 401 is logged by linkFailed (its step and Google's answer).
  if (run.tokenCheck) return run.tokenCheck !== 'dead';
  const userId = run.user.id;
  const cause = describe(error);
  try {
    await counted(run.budget, () => syncGoogle(token).account());
  } catch (check) {
    const cls = classOf(check);
    if (check instanceof BudgetSpent || isGoogleRateLimit(check) || cls === 'transient') {
      console.warn(`[google-sync] user ${userId}: a 401 (${cause}); the token check was cut short (${describe(check)}), so the run ends for the next tick`);
      throw check;
    }
    if (cls === 'token' || cls === 'scopes') {
      run.tokenCheck = 'dead';
      console.warn(`[google-sync] user ${userId}: a 401 (${cause}), and the token check failed too (${describe(check)})`);
      if (cls === 'scopes') throw check;
      return false;
    }
    run.tokenCheck = 'inconclusive';
    console.warn(`[google-sync] user ${userId}: a 401 (${cause}); the token check was inconclusive (${describe(check)}), so only that copy backs off`);
    captureError(new Error('Google refused one request with a 401 and the token check was inconclusive'), 'google-sync-token-check', { user_id: userId, cause, check: describe(check) }, 'warning');
    return true;
  }
  run.tokenCheck = 'works';
  console.warn(`[google-sync] user ${userId}: Google refused one request with a 401 (${cause}), though the token works; only that copy backs off`);
  captureError(new Error('Google refused one request with a 401 though the token works'), 'google-sync-token-check', { user_id: userId, cause }, 'warning');
  return true;
}

/**
 * A copy's own step failed (spec §4 Failures): each link's attempt counted and its next one
 * backed off (exponential with jitter, retries.ts), lastError set, Sentry told (a warning when
 * transient), and the admin at the 10th attempt in a row, once per link per day. Throws
 * TransientStop when transient (Google is likely down for the rest of the run).
 */
async function linkFailed(run: UserRun, failing: LinkRow[], error: unknown, step: string): Promise<void> {
  const cls = classOf(error);
  run.failed += failing.length;
  const counts: string[] = [];
  for (const link of failing) {
    const attempts = (run.retries.get(link.id)?.attempts ?? 0) + 1;
    const retry = { attempts, at: run.now.getTime() + backoffMs(attempts) };
    run.retries.set(link.id, retry);
    await writeLinkRetry(link.id, retry);
    counts.push(`${link.id}#${attempts}`);
    if (attempts >= ALERT_AFTER_ATTEMPTS) {
      await alertAdminOnce(run, link, `Copy to Google: link ${link.id} failed its ${step} ${attempts} times in a row (${cls}).`);
    }
  }
  await prisma.googleSyncLink.updateMany({ where: { id: { in: failing.map((l) => l.id) } }, data: { lastError: cls } });
  console.warn(`[google-sync] user ${run.user.id}: ${step} failed (${cls}) for [${counts.join(',')}]; backed off`);
  captureError(loggable(error), 'google-sync-link', { user_id: run.user.id, links: failing.map((l) => l.id).join(','), step }, cls === 'transient' ? 'warning' : 'error');
  if (cls === 'transient') throw new TransientStop();
}

/** A copy that was backed off worked again: its retry and lastError cleared. */
async function linkRecovered(run: UserRun, link: LinkRow): Promise<void> {
  if (!run.retries.has(link.id)) return;
  run.retries.delete(link.id);
  await clearLinkRetries([link.id]);
  await prisma.googleSyncLink.update({ where: { id: link.id }, data: { lastError: null } });
  console.log(`[google-sync] link ${link.id}: works again; its backoff cleared`);
}

/** The copy calendar is gone from Google: the link waits in 'gone' for "Create it again". */
async function calendarGone(run: UserRun, link: LinkRow, error: unknown): Promise<void> {
  await prisma.googleSyncLink.update({ where: { id: link.id }, data: { state: 'gone', lastError: 'calendar_gone' } });
  console.warn(`[google-sync] link ${link.id}: its Google calendar is gone; waiting for "Create it again"`);
  captureError(loggable(error), 'google-sync-gone', { user_id: run.user.id, link_id: link.id }, 'warning');
}

// ---- Turned-off copies: the queued Remove or Keep ----

/**
 * Carry out a turned-off copy's Remove or Keep in Google, the one code path for the worker and
 * the hard delete: the token's account checked first (a copy of another account is never
 * touched), then removeCopyCalendar or keepCopyCalendar, which re-read the calendar and act only
 * on the link's own.
 */
export async function turnOffInGoogle(
  g: SyncGoogle, budget: CallBudget, link: { id: string; googleCalendarId: string | null; googleAccount: string | null }, choice: UnlinkChoice, language: string,
): Promise<{ outcome: TurnOffOutcome | 'otherAccount'; googleCalendarId: string | null }> {
  const account = await counted(budget, () => g.account()).catch((error: unknown) => { throw accountCheckFailed(error); });
  if (link.googleAccount && account !== link.googleAccount) return { outcome: 'otherAccount', googleCalendarId: link.googleCalendarId };
  // No id stored: a create may have made the calendar and failed before storing it, so the
  // user's calendar list is searched for the link's token (as a 'creating' retry adopts it).
  const googleCalendarId = link.googleCalendarId ?? (await findCopyCalendarId(g, budget, link.id));
  if (!googleCalendarId) return { outcome: 'gone', googleCalendarId: null };
  const target = { id: link.id, googleCalendarId };
  const outcome = choice === 'remove' ? await removeCopyCalendar(g, budget, target) : await keepCopyCalendar(g, budget, target, language);
  return { outcome, googleCalendarId };
}

/** A turned-off copy with its Remove/Keep queued, carried out with link.unlinkToken ?? the user's token, then unlinkToken cleared. */
async function turnOffLink(run: UserRun, link: LinkRow): Promise<void> {
  const readSeq = link.dirtySeq;
  const choice = link.unlinkChoice === 'keep' ? 'keep' : 'remove';
  const own = !link.unlinkToken;
  const token = own ? tokenOf(run.user.googleRefreshToken) : tokenOf(link.unlinkToken);
  if (!link.googleCalendarId && !token) {
    // No id and no token to look one up with: nothing known in Google (a link with no token
    // is never made 'creating', links.ts), so it is clean.
    await prisma.googleSyncLink.update({ where: { id: link.id }, data: { pushedSeq: readSeq, unlinkToken: null } });
    console.log(`[google-sync] link ${link.id}: turned off with no Google calendar and no token; nothing to ${choice}`);
    return;
  }
  if (!token) {
    if (own) return outage(run, 'token', NO_TOKEN);
    await prisma.googleSyncLink.update({ where: { id: link.id }, data: { state: 'token' } });
    return;
  }
  await renewLock(run);
  let done: Awaited<ReturnType<typeof turnOffInGoogle>>;
  try {
    done = await turnOffInGoogle(syncGoogle(token), run.budget, link, choice, run.user.language);
  } catch (error) {
    if (error instanceof BudgetSpent || isGoogleRateLimit(error)) throw error;
    const cls = classOf(error);
    if (cls === 'token' || cls === 'scopes') {
      if (own) {
        if (!(await tokenStillWorks(run, token, error))) throw error;
        await linkFailed(run, [link], error, `turn-off (${choice}; ${TOKEN_WORKS})`);
        return;
      }
      // The merged-away account's token: only this copy waits; the user's own Google is fine.
      await prisma.googleSyncLink.update({ where: { id: link.id }, data: { state: cls } });
      captureError(new Error(`Google ${cls} on a merged copy's token`), 'google-sync-turn-off', { user_id: run.user.id, link_id: link.id, choice }, 'warning');
      return;
    }
    await linkFailed(run, [link], error, `turn-off (${choice})`);
    return;
  }
  await finishTurnOff(run, link, done.outcome, done.googleCalendarId, readSeq);
  await linkRecovered(run, link);
}

/** The rows after a turn-off's Google side. */
async function finishTurnOff(run: UserRun, link: LinkRow, outcome: TurnOffOutcome | 'otherAccount', googleCalendarId: string | null, readSeq: number): Promise<void> {
  const ids = `user ${run.user.id} link ${link.id}`;
  if (outcome === 'otherAccount') {
    await prisma.googleSyncLink.update({ where: { id: link.id }, data: { state: 'otherAccount' } });
    console.warn(`[google-sync] ${ids}: the token is another Google account's; the queued ${link.unlinkChoice} waits`);
    return;
  }
  if (outcome === 'foreign') {
    // Never touched: the calendar under this id doesn't carry the link's token.
    await prisma.googleSyncLink.update({ where: { id: link.id }, data: { state: 'error', lastError: 'not_our_calendar', pushedSeq: readSeq, unlinkToken: null } });
    captureError(new Error('A copy calendar without its link token was left alone'), 'google-sync-turn-off', { user_id: run.user.id, link_id: link.id }, 'error');
    return;
  }
  const gone = outcome === 'deleted' || outcome === 'gone';
  await prisma.$transaction(async (tx) => {
    // The items before the link, the order every writer takes (marks.ts).
    if (gone) {
      await tx.googleSyncItem.deleteMany({ where: { linkId: link.id } });
    } else if (outcome === 'emptied') {
      // The calendar stays, holding FamCal's deleted events, and Google keeps a deleted
      // event's id: each item keeps its row with its generation moved on past the deleted
      // event, so a re-enable inserts under fresh ids (spec §4: no stale exception survives).
      await tx.googleSyncItem.updateMany({ where: { linkId: link.id, googleEventId: { not: null } }, data: { googleEventId: null, generation: { increment: 1 } } });
      await tx.googleSyncItem.updateMany({ where: { linkId: link.id }, data: { masterHash: null, slotHashes: {}, attempts: 0, nextAttemptAt: null, status: 'ok', lastError: null } });
    }
    await tx.googleSyncLink.update({
      where: { id: link.id },
      // A calendar found by its token (no id was stored) is kept on the link, so it stays hidden and a re-enable reuses it.
      data: { pushedSeq: readSeq, unlinkToken: null, googleCalendarId: gone ? null : googleCalendarId },
    });
  });
  run.pushed += 1;
  console.log(`[google-sync] ${ids}: turned off, ${outcome}`);
}

// ---- Copies that are on ----

async function syncLinks(run: UserRun, links: LinkRow[]): Promise<void> {
  const { user } = run;
  const access = await peekFeatureAccess(user.id, 'google_sync');
  if (!access.allowed) {
    const paused = links.filter((l) => l.state !== 'plan').map((l) => l.id);
    if (paused.length > 0) {
      await prisma.googleSyncLink.updateMany({ where: { id: { in: paused } }, data: { state: 'plan' } });
      console.log(`[google-sync] user ${user.id}: plan lacks google_sync; paused [${paused.join(',')}]`);
    }
    return;
  }
  for (const l of links.filter((x) => x.state === 'plan')) {
    l.state = l.googleCalendarId ? 'ok' : 'creating';
    await prisma.googleSyncLink.update({ where: { id: l.id }, data: { state: l.state } });
    console.log(`[google-sync] link ${l.id}: plan has google_sync again; ${l.state}`);
  }
  const token = tokenOf(user.googleRefreshToken);
  if (!token) return outage(run, 'token', NO_TOKEN);
  if (!hasSyncScope(user.googleScopes)) return outage(run, 'scopes', 'the stored grant lacks calendar.app.created');
  const g = syncGoogle(token);
  let account: string;
  try {
    account = await counted(run.budget, () => g.account());
  } catch (error) {
    if (stopsRun(error)) throw error;
    // The account check is every copy's first step: each one backs off.
    await linkFailed(run, links, error, 'account check');
    return;
  }
  for (const link of links) {
    if (!(await sameAccount(link, account))) continue;
    try {
      await syncLink(run, g, link, token);
    } catch (error) {
      // A 401 on one of this copy's requests (its create, rename or a push) while the token works: only this copy backs off.
      if (await tokenStillWorks(run, token, error)) {
        await linkFailed(run, [link], error, `calendar step or push (${TOKEN_WORKS})`);
        continue;
      }
      if (stopsRun(error)) throw error;
      // This copy's own step (create, rename) failed: it backs off, and the user's other copies still run.
      await linkFailed(run, [link], error, 'calendar step');
      continue;
    }
    await linkRecovered(run, link);
  }
}

/** Whether the token's account is the copy's: a copy with none yet adopts it; another sets 'otherAccount'. */
async function sameAccount(link: LinkRow, account: string): Promise<boolean> {
  if (link.googleAccount === null) {
    await prisma.googleSyncLink.update({ where: { id: link.id }, data: { googleAccount: account } });
    link.googleAccount = account;
    return true;
  }
  if (link.googleAccount === account) return true;
  if (link.state !== 'otherAccount') {
    await prisma.googleSyncLink.update({ where: { id: link.id }, data: { state: 'otherAccount' } });
    console.warn(`[google-sync] link ${link.id}: the token is another Google account's; the copy waits for the user`);
  }
  return false;
}

/** The zone a new copy calendar is made in: the user's (the zone their series are written in). */
async function zoneOf(user: UserRow, token: string): Promise<string> {
  try {
    return await resolveUserTimezone({ id: user.id, location: user.location, googleRefreshToken: token, telegramId: user.telegramId === null ? null : Number(user.telegramId) });
  } catch (error) {
    captureError(error, 'google-sync-zone', { user_id: user.id }, 'warning');
    return TIMEZONE;
  }
}

async function syncLink(run: UserRun, g: SyncGoogle, link: LinkRow, token: string): Promise<void> {
  const cal = link.nativeCalendar;
  if (!link.nativeCalendarId || !cal || cal.isDeleted || cal.ownerUserId !== link.userId) {
    // Never copied: a partner's data reaches only the owner's Google (spec Review focus 4).
    console.warn(`[google-sync] link ${link.id}: its calendar is gone or not the user's own; skipped`);
    return;
  }
  const facts = { language: run.user.language, name: cal.name };
  if (!link.googleCalendarId) {
    await renewLock(run);
    const zone = await zoneOf(run.user, token);
    const made = await serially(() => ensureCopyCalendar(g, run.budget, { id: link.id, googleCalendarId: null }, { ...facts, zone }));
    await prisma.googleSyncLink.update({
      where: { id: link.id },
      data: { googleCalendarId: made.googleCalendarId, state: 'ok', pushedName: cal.name, pushedSeq: link.dirtySeq, lastError: null },
    });
    console.log(`[google-sync] link ${link.id}: Google calendar ${made.adopted ? 'adopted' : 'created'}`);
    link.googleCalendarId = made.googleCalendarId;
  } else if (link.dirtySeq > link.pushedSeq || link.pushedName !== cal.name) {
    await renewLock(run);
    try {
      await renameCopyCalendar(g, run.budget, { id: link.id, googleCalendarId: link.googleCalendarId }, facts);
    } catch (error) {
      // calendars.patch names only the calendar: a 404/410 is the calendar gone (spec §4's 404 split).
      if (isGoogleRateLimit(error) || classOf(error) !== 'gone') throw error;
      await calendarGone(run, link, error);
      return;
    }
    await prisma.googleSyncLink.update({ where: { id: link.id }, data: { pushedName: cal.name, pushedSeq: link.dirtySeq, ...(link.state === 'creating' ? { state: 'ok' } : {}) } });
    console.log(`[google-sync] link ${link.id}: Google calendar renamed`);
  }
  if (!link.backfilledAt) await backfill(run, link, link.nativeCalendarId);
  await pushItems(run, g, { ...link, googleCalendarId: link.googleCalendarId, nativeCalendarId: link.nativeCalendarId });
}

/**
 * A new or re-enabled copy (backfilledAt null): every event series of the calendar marked
 * dirty, one-offs from 30 days back and series whole (spec §4 Backfill). Reminders are never
 * copied. It drains at the run's pace; syncProgress counts it.
 */
async function backfill(run: UserRun, link: LinkRow, calendarId: string): Promise<void> {
  const rows = await prisma.nativeEvent.findMany({
    where: { calendarId, isDeleted: false, kind: 'EVENT', OR: [{ rrule: { not: null } }, { endsAt: { gte: new Date(run.now.getTime() - ONE_OFF_LOOKBACK_MS) } }] },
    select: { id: true, kind: true },
  });
  for (let i = 0; i < rows.length; i += BACKFILL_CHUNK) {
    const chunk = rows.slice(i, i + BACKFILL_CHUNK);
    await markedTransaction((tx) => markSyncDirty(tx, { series: chunk.map((r) => ({ id: r.id, kind: r.kind, calendarIds: [calendarId] })) }));
  }
  await prisma.googleSyncLink.update({ where: { id: link.id }, data: { backfilledAt: run.now } });
  console.log(`[google-sync] link ${link.id}: backfill marked ${rows.length} series`);
}

async function pushItems(run: UserRun, g: SyncGoogle, link: LinkRow & { googleCalendarId: string; nativeCalendarId: string }): Promise<void> {
  const items = await prisma.googleSyncItem.findMany({
    where: { linkId: link.id, dirtySeq: { gt: prisma.googleSyncItem.fields.pushedSeq }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: run.now } }] },
    select: ITEM_SELECT,
    orderBy: { nativeEventId: 'asc' },
    take: Math.max(1, run.budget.left),
  });
  const pushLink = { id: link.id, userId: link.userId, nativeCalendarId: link.nativeCalendarId, googleCalendarId: link.googleCalendarId };
  // A full page means more may be waiting than this run's calls allow: the next tick goes on.
  if (items.length >= Math.max(1, run.budget.left)) run.again = true;
  let failures = 0;
  for (const item of items) {
    await renewLock(run);
    try {
      const outcome = await pushItem(g, run.budget, pushLink, item as PushItem, run.now);
      if (outcome !== 'clean') run.pushed += 1;
    } catch (error) {
      if (error instanceof CalendarGone) {
        await calendarGone(run, link, error);
        return;
      }
      if (error instanceof BudgetSpent || error instanceof LockLost || isGoogleRateLimit(error)) throw error;
      const cls = classOf(error);
      if (cls === 'token' || cls === 'scopes') throw error;
      failures += 1;
      run.failed += 1;
      await itemFailed(run, link, item, error, cls);
      if (cls === 'transient') throw new TransientStop();
    }
  }
  if (failures === 0) await prisma.googleSyncLink.update({ where: { id: link.id }, data: { lastSyncedAt: run.now } });
}

/** An item's failed push: one more attempt, the next one backed off, and the admin told at the 10th. */
async function itemFailed(run: UserRun, link: LinkRow, item: { id: string; nativeEventId: string; status: string; attempts: number }, error: unknown, cls: GoogleErrorClass): Promise<void> {
  // An item tried again after FamCal changed it ('unsupported' or 'error' before) counts from scratch.
  const attempts = (item.status === 'ok' ? item.attempts : 0) + 1;
  const wait = backoffMs(attempts);
  await prisma.googleSyncItem.update({
    where: { id: item.id },
    data: { attempts, nextAttemptAt: new Date(run.now.getTime() + wait), lastError: cls, status: 'ok' },
  });
  const ids = { user_id: run.user.id, link_id: link.id, item_id: item.id, series_id: item.nativeEventId, attempts };
  console.warn(`[google-sync] link ${link.id} item ${item.id}: push failed (${cls}), attempt ${attempts}; next in ${Math.round(wait / 1000)} s`);
  captureError(loggable(error), 'google-sync-push', ids, cls === 'transient' ? 'warning' : 'error');
  if (attempts >= ALERT_AFTER_ATTEMPTS) {
    await alertAdminOnce(run, link, `Copy to Google: item ${item.id} (series ${item.nativeEventId}) of link ${link.id} failed ${attempts} times in a row (${cls}).`);
  }
}

/** The admin alert for an item or a copy's step that keeps failing, once per link per day (a Redis NX key). The message carries ids, never a title. */
async function alertAdminOnce(run: UserRun, link: { id: string }, message: string): Promise<void> {
  const day = run.now.toISOString().slice(0, 10);
  try {
    const first = await redis.set(REDIS_KEYS.googleSyncAlert(link.id, day), '1', { nx: true, ex: 2 * 86_400 });
    if (first !== 'OK') return;
  } catch (error) {
    captureError(error, 'google-sync-alert', { user_id: run.user.id, link_id: link.id }, 'warning');
    return;
  }
  try {
    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning('google-sync', message, { userId: run.user.id, name: run.user.name });
  } catch (error) {
    captureError(error, 'google-sync-alert', { user_id: run.user.id, link_id: link.id }, 'warning');
  }
}

// ---- Hebrew horizons ----

/**
 * Once a day: the copies of Hebrew-date series whose listed years run short (fewer than 2
 * ahead) are marked dirty, so the next push lists the years from the current one (hebrew.ts).
 */
async function refreshHebrewHorizons(now: Date): Promise<void> {
  if (now.getTime() - shared.hebrewCheckedAt < HEBREW_CHECK_MS) return;
  const links = await prisma.googleSyncLink.findMany({ where: { enabled: true, nativeCalendarId: { not: null }, googleCalendarId: { not: null } }, select: { id: true, nativeCalendarId: true } });
  const calendarIds = [...new Set(links.flatMap((l) => (l.nativeCalendarId ? [l.nativeCalendarId] : [])))];
  if (calendarIds.length > 0) {
    const series = await prisma.nativeEvent.findMany({ where: { calendarId: { in: calendarIds }, hebrewRule: { not: null }, isDeleted: false, kind: 'EVENT' }, select: { id: true, calendarId: true, timeZone: true } });
    if (series.length > 0) {
      const byId = new Map(series.map((s) => [s.id, s]));
      const items = await prisma.googleSyncItem.findMany({
        where: { linkId: { in: links.map((l) => l.id) }, nativeEventId: { in: series.map((s) => s.id) }, googleEventId: { not: null } },
        select: { nativeEventId: true, slotHashes: true },
      });
      const stale = new Set(items.filter((i) => {
        const from = storedHebrewFrom(i.slotHashes);
        const s = byId.get(i.nativeEventId);
        return from !== null && s !== undefined && hebrewHorizonFrom(from, now, s.timeZone || TIMEZONE) !== from;
      }).map((i) => i.nativeEventId));
      if (stale.size > 0) {
        await markedTransaction((tx) => markSyncDirty(tx, { series: [...stale].map((id) => ({ id, kind: 'EVENT', calendarIds: [byId.get(id)!.calendarId] })) }));
        console.log(`[google-sync] Hebrew horizons: ${stale.size} series listed again from the current year`);
      }
    }
  }
  shared.hebrewCheckedAt = now.getTime();
}

// ---- The hard delete's Remove (spec §2 hardDeleteUser) ----

/**
 * Before a hard delete's transaction: each of the user's copies with work queued carried out in
 * Google now, since the token goes with the user and the links cascade with it. Remove for a
 * copy that is on; the queued choice for one turned off and not yet carried out. With
 * link.unlinkToken ?? the user's token, through turnOffInGoogle (the worker's own Remove and
 * Keep). A copy with no stored Google calendar id is looked up by its token first (a create
 * that failed before storing it). Best effort: a failure is logged with the link id and sent
 * to Sentry, and the delete goes on. No Google call for a user with no such copy.
 */
export async function carryOutCopiesBeforeDelete(userId: number): Promise<void> {
  const links = await prisma.googleSyncLink.findMany({
    where: { userId },
    select: { id: true, googleCalendarId: true, googleAccount: true, enabled: true, unlinkChoice: true, unlinkToken: true, dirtySeq: true, pushedSeq: true },
  });
  const queued = links.filter((l) => l.enabled || (l.unlinkChoice !== null && l.dirtySeq > l.pushedSeq));
  if (queued.length === 0) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { googleRefreshToken: true, language: true } });
  const budget: CallBudget = { left: HARD_DELETE_CALLS };
  for (const link of queued) {
    const choice: UnlinkChoice = link.enabled ? 'remove' : link.unlinkChoice === 'keep' ? 'keep' : 'remove';
    const token = link.unlinkToken ? tokenOf(link.unlinkToken) : tokenOf(user?.googleRefreshToken);
    const extra = { user_id: userId, link_id: link.id, choice };
    if (!token) {
      if (!link.googleCalendarId) {
        console.log(`[google-sync] hard delete of user ${userId}: link ${link.id} has no Google calendar and no token; nothing to carry out`);
        continue;
      }
      console.warn(`[google-sync] hard delete of user ${userId}: no token for link ${link.id}; its Google calendar stays`);
      captureError(new Error('No Google token to carry out a copy before a hard delete'), 'google-sync-hard-delete', extra, 'warning');
      continue;
    }
    try {
      // A link with no stored id is looked up by its token (a create that failed before storing it).
      const { outcome } = await turnOffInGoogle(syncGoogle(token), budget, link, choice, user?.language ?? 'en');
      console.log(`[google-sync] hard delete of user ${userId}: link ${link.id} ${choice}: ${outcome}`);
      if (outcome === 'otherAccount' || outcome === 'foreign') {
        captureError(new Error(`A copy was left in Google before a hard delete (${outcome})`), 'google-sync-hard-delete', extra, 'warning');
      }
    } catch (error) {
      const cls = classOf(error);
      console.error(`[google-sync] hard delete of user ${userId}: link ${link.id} ${choice} failed (${cls}); the delete goes on`);
      captureError(loggable(error), 'google-sync-hard-delete', extra, cls === 'unknown' || cls === 'config' ? 'error' : 'warning');
    }
  }
}

// ---- For the calendars page (S4) ----

/** How far a copy is: moved to view.ts (the calendars page's view), kept here for the worker's callers. */
export { syncProgress } from './view';
