/**
 * Key sweep (secret rotation spec 2026-10-22, (a) "Key sweep").
 *
 * After ENCRYPTION_KEY is replaced and the old value is put in ENCRYPTION_KEY_PREVIOUS,
 * every stored Google token still decrypts through the fallback. This moves each one to the
 * current key, so the old key can go. Runs every 10 minutes from the scheduler:
 * - nothing before 10 minutes of uptime: during a deploy the old container may still serve;
 * - one tick at a time across containers (a Redis lock);
 * - the first tick only counts (the baseline line);
 * - every write is a compare-and-set on the value read, so a token Google refreshed in
 *   between is never overwritten: the row counts as raced and is retried next tick;
 * - legacy plaintext is encrypted too, with or without a PREVIOUS key;
 * - empty ciphers (a user with no token) and tokens neither key opens are never written.
 * When nothing needs the PREVIOUS key any more, it logs SAFE once per process and tells the
 * admins once (Redis dedup). Once it has nothing left to do in this process, it stops
 * reading the database, so Neon can scale to zero. It logs ids, counts and fingerprints,
 * never values.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { captureError } from '../lib/error-capture';
import {
  decryptDetailed,
  encrypt,
  isEmptyCipher,
  isEncrypted,
  keyFingerprint,
  previousKeyStatus,
  type PreviousKeyStatus,
} from '../utils/encryption';
import { LEGACY_REMINDER_CACHE_KEY, REMINDER_CACHE_KEY } from './reminder-cache';

/** The old container may still serve during a deploy's first minutes: nothing runs before this. */
const GATE_UPTIME_S = 600;
/** SAFE waits this long, so it is said well after any overlap with the old container. */
const SAFE_UPTIME_S = 1800;
const LOCK_KEY = 'keysweep:lock';
const LOCK_TTL_S = 300;
const SAFE_DEDUP_PREFIX = 'keysweep:safe:';
const SAFE_DEDUP_TTL_S = 30 * 24 * 60 * 60;
const BATCH_SIZE = 100;
const MAX_IDS_IN_ALERT = 30;

export interface KeySweepCounts {
  /** Under ENCRYPTION_KEY already. */
  current: number;
  /** Found under ENCRYPTION_KEY_PREVIOUS (then converted or raced). */
  previous: number;
  /** Moved to ENCRYPTION_KEY by a compare-and-set write. */
  converted: number;
  /** Legacy plaintext found (then encrypted or raced). */
  plaintext: number;
  /** Legacy plaintext encrypted by a compare-and-set write. */
  plaintextEncrypted: number;
  /** `iv:tag:` with no data: a user with no token. Never written. */
  emptyCipher: number;
  /** Compare-and-set writes that found a newer value. Retried next tick. */
  raced: number;
  /** Opens with neither key. Never written. */
  unreadable: number;
  /** Row ids of the unreadable ones, never their values. */
  unreadableIds: string[];
}

export interface KeySweepReport {
  /** The first tick after the uptime gate: it counted and wrote nothing. */
  baseline: boolean;
  previousKey: PreviousKeyStatus;
  /** User.googleRefreshToken */
  users: KeySweepCounts;
  /** GoogleSyncLink.unlinkToken */
  links: KeySweepCounts;
  /** Whether the legacy `reminders:users` key still exists; null on the baseline tick. */
  legacyCache: boolean | null;
  /** rebuildReminderCache() ran after a write and finished. */
  cacheRebuilt: boolean;
  /** The SAFE condition held on this tick. */
  safe: boolean;
}

interface SweepState {
  /** The read-only baseline tick ran. */
  baselineDone: boolean;
  /** The last pass found nothing to write: no PREVIOUS-key, plaintext or raced rows. */
  settled: boolean;
  /** The unreadable rows that pass left. SAFE can't follow them in this process. */
  settledUnreadable: number;
  safeLogged: boolean;
  unreadableReported: boolean;
  keyProblemReported: boolean;
}

/**
 * Once-per-process state. It lives on globalThis because Next 16 gives the scheduler
 * bundle and the route bundles separate copies of this module.
 */
function sweepState(): SweepState {
  const g = globalThis as { __famcalKeySweep?: SweepState };
  return (g.__famcalKeySweep ??= {
    baselineDone: false,
    settled: false,
    settledUnreadable: 0,
    safeLogged: false,
    unreadableReported: false,
    keyProblemReported: false,
  });
}

type Classified =
  | { kind: 'current' | 'empty_cipher' | 'unreadable' }
  | { kind: 'previous' | 'plaintext'; plain: string };

/** What a stored value is; null for no token (''). Never throws. */
function classify(raw: string): Classified | null {
  if (!raw) return null;
  // A user with no token, whose row the old select-calendars save wrote as encrypt('')
  if (isEmptyCipher(raw)) return { kind: 'empty_cipher' };
  if (!isEncrypted(raw)) return { kind: 'plaintext', plain: raw };
  try {
    // 'previous' comes back only while ENCRYPTION_KEY_PREVIOUS is valid and differs from
    // the key (encryption.ts), so conversion runs only then.
    const { value, key } = decryptDetailed(raw);
    return key === 'current' ? { kind: 'current' } : { kind: 'previous', plain: value };
  } catch {
    // Neither key opens it (UndecryptableError) or it is malformed. It is counted by id,
    // logged and reported once per process in reportUnreadable(), and never written.
    return { kind: 'unreadable' };
  }
}

interface TokenColumn<Id extends number | string> {
  read(after: Id | null): Promise<Array<{ id: Id; value: string }>>;
  /** Compare-and-set: writes only while the row still holds `old`. Returns the rows written (0 or 1). */
  write(id: Id, old: string, next: string): Promise<number>;
}

const USER_TOKENS: TokenColumn<number> = {
  async read(after) {
    const rows = await prisma.user.findMany({
      where: after === null ? { googleRefreshToken: { not: '' } } : { googleRefreshToken: { not: '' }, id: { gt: after } },
      select: { id: true, googleRefreshToken: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    return rows.map(r => ({ id: r.id, value: r.googleRefreshToken }));
  },
  async write(id, old, next) {
    const { count } = await prisma.user.updateMany({
      where: { id, googleRefreshToken: old },
      data: { googleRefreshToken: next },
    });
    return count;
  },
};

const LINK_TOKENS: TokenColumn<string> = {
  async read(after) {
    const rows = await prisma.googleSyncLink.findMany({
      where: after === null ? { unlinkToken: { not: null } } : { unlinkToken: { not: null }, id: { gt: after } },
      select: { id: true, unlinkToken: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    return rows.map(r => ({ id: r.id, value: r.unlinkToken ?? '' }));
  },
  async write(id, old, next) {
    const { count } = await prisma.googleSyncLink.updateMany({
      where: { id, unlinkToken: old },
      data: { unlinkToken: next },
    });
    return count;
  },
};

function emptyCounts(): KeySweepCounts {
  return { current: 0, previous: 0, converted: 0, plaintext: 0, plaintextEncrypted: 0, emptyCipher: 0, raced: 0, unreadable: 0, unreadableIds: [] };
}

/** Walks one column in batches by id. With `write`, moves PREVIOUS-key and plaintext values to the current key. */
async function sweepColumn<Id extends number | string>(column: TokenColumn<Id>, write: boolean): Promise<KeySweepCounts> {
  const counts = emptyCounts();
  let after: Id | null = null;
  for (;;) {
    const rows = await column.read(after);
    for (const row of rows) {
      const found = classify(row.value);
      if (!found) continue;
      switch (found.kind) {
        case 'current':
          counts.current++;
          break;
        case 'empty_cipher':
          counts.emptyCipher++;
          break;
        case 'unreadable':
          counts.unreadable++;
          counts.unreadableIds.push(String(row.id));
          break;
        case 'previous':
        case 'plaintext': {
          const isPrevious = found.kind === 'previous';
          if (isPrevious) counts.previous++;
          else counts.plaintext++;
          if (write) {
            if ((await column.write(row.id, row.value, encrypt(found.plain))) > 0) {
              if (isPrevious) counts.converted++;
              else counts.plaintextEncrypted++;
            } else counts.raced++;
          }
          break;
        }
      }
    }
    if (rows.length < BATCH_SIZE) return counts;
    after = rows[rows.length - 1].id;
  }
}

const baselineCounts = (c: KeySweepCounts) =>
  `current=${c.current} previous=${c.previous} plaintext=${c.plaintext} empty_cipher=${c.emptyCipher} unreadable=${c.unreadable}`;
const tickCounts = (c: KeySweepCounts) =>
  `current=${c.current} converted=${c.converted} raced=${c.raced} unreadable=${c.unreadable} plaintext_encrypted=${c.plaintextEncrypted} empty_cipher=${c.emptyCipher}`;
/** The pass found a row to write (or one it lost to a newer write). */
const hasWork = (c: KeySweepCounts) => c.previous + c.plaintext + c.raced > 0;

/** Ids only, never values. Logged every tick; captured and sent to the admins once per process. */
async function reportUnreadable(users: KeySweepCounts, links: KeySweepCounts, state: SweepState): Promise<void> {
  const total = users.unreadable + links.unreadable;
  if (total === 0) return;
  const all = (ids: string[]) => (ids.length ? ids.join(', ') : 'none');
  console.error(`[key-sweep] ${total} stored tokens decrypt with neither key (ids only): users ${all(users.unreadableIds)}; links ${all(links.unreadableIds)}`);
  if (state.unreadableReported) return;
  state.unreadableReported = true;
  captureError(
    new Error(`key sweep: ${total} stored Google tokens decrypt with neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS`),
    'key-sweep-unreadable',
    { ids: { users: users.unreadableIds, links: links.unreadableIds } },
  );
  const some = (ids: string[]) =>
    ids.length <= MAX_IDS_IN_ALERT ? all(ids) : `${ids.slice(0, MAX_IDS_IN_ALERT).join(', ')} and ${ids.length - MAX_IDS_IN_ALERT} more`;
  try {
    const { notifyAdminWarning } = await import('../utils/error-notifier');
    await notifyAdminWarning(
      'key-sweep',
      `${total} stored Google tokens decrypt with neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS, so those users count as not connected. Nothing was overwritten. Check that ENCRYPTION_KEY_PREVIOUS holds the old key.\n\nUsers: ${some(users.unreadableIds)}\nCopy links: ${some(links.unreadableIds)}`,
    );
  } catch (error) {
    console.error('[key-sweep] Unreadable-token alert failed:', error);
    captureError(error, 'key-sweep-alert', {}, 'warning');
  }
}

/** After a write: the Redis copy of the tokens moves to the current key too. */
async function rebuildCache(): Promise<boolean> {
  try {
    const { rebuildReminderCache } = await import('../cron/handlers');
    const synced = await rebuildReminderCache();
    console.log(`[key-sweep] Reminder cache rebuilt under the current key (${synced} users)`);
    return true;
  } catch (error) {
    console.error('[key-sweep] Reminder cache rebuild failed:', error);
    captureError(error, 'key-sweep-cache-rebuild');
    return false;
  }
}

/** Every reminders:users:v2 entry's googleToken is '' or opens with the current key. */
async function reminderCacheIsCurrent(): Promise<boolean> {
  const entries = await redis.get<unknown>(REMINDER_CACHE_KEY);
  if (entries === null) return true;
  if (!Array.isArray(entries)) return false;
  return entries.every(entry => {
    const token = (entry as { googleToken?: unknown } | null)?.googleToken;
    if (token === '') return true;
    if (typeof token !== 'string' || !isEncrypted(token)) return false;
    try {
      return decryptDetailed(token).key === 'current';
    } catch {
      // Opens with neither key: not current, so no SAFE. The hourly rebuild rewrites it.
      return false;
    }
  });
}

/** One Telegram message per PREVIOUS key, across processes and deploys (Redis dedup). */
async function announceSafe(fpCurrent: string, fpPrevious: string): Promise<void> {
  let first: unknown;
  try {
    first = await redis.set(`${SAFE_DEDUP_PREFIX}${fpPrevious}`, '1', { nx: true, ex: SAFE_DEDUP_TTL_S });
  } catch (error) {
    console.error('[key-sweep] SAFE message dedup failed; not sending it:', error);
    captureError(error, 'key-sweep-safe-dedup', {}, 'warning');
    return;
  }
  if (first !== 'OK') {
    console.log('[key-sweep] SAFE message already sent for this ENCRYPTION_KEY_PREVIOUS');
    return;
  }
  try {
    const { getAdminUserIds } = await import('../utils/error-notifier');
    const { getBot } = await import('./telegram/bot');
    const bot = getBot();
    const text =
      `<b>Key rotation finished</b>\n\nEvery stored Google token is under ENCRYPTION_KEY (fp <code>${fpCurrent}</code>). ` +
      `Nothing needs ENCRYPTION_KEY_PREVIOUS (fp <code>${fpPrevious}</code>) any more: remove it at the next deploy.`;
    for (const adminId of await getAdminUserIds()) {
      try {
        await bot.sendMessage(adminId, text, { parse_mode: 'HTML' });
      } catch (error) {
        console.error(`[key-sweep] SAFE message to admin ${adminId} failed:`, error);
        captureError(error, 'key-sweep-safe-notify', { admin_id: adminId }, 'warning');
      }
    }
  } catch (error) {
    console.error('[key-sweep] SAFE message failed:', error);
    captureError(error, 'key-sweep-safe-notify', {}, 'warning');
  }
}

/** Only the lock this tick took; it expires on its own within 5 minutes anyway. */
async function releaseLock(token: string): Promise<void> {
  try {
    if ((await redis.get<string>(LOCK_KEY)) === token) await redis.del(LOCK_KEY);
  } catch (error) {
    console.warn('[key-sweep] Lock release failed (it expires in 5 minutes):', error);
    captureError(error, 'key-sweep-unlock', {}, 'warning');
  }
}

async function sweep(uptime: number, state: SweepState): Promise<KeySweepReport> {
  const previousKey = previousKeyStatus();
  const baseline = !state.baselineDone;
  const users = await sweepColumn(USER_TOKENS, !baseline);
  const links = await sweepColumn(LINK_TOKENS, !baseline);
  const report: KeySweepReport = { baseline, previousKey, users, links, legacyCache: null, cacheRebuilt: false, safe: false };

  if (baseline) {
    console.log(`[key-sweep] baseline: users ${baselineCounts(users)}; links ${baselineCounts(links)}`);
    state.baselineDone = true;
    await reportUnreadable(users, links, state);
    return report;
  }

  if (users.converted + users.plaintextEncrypted + links.converted + links.plaintextEncrypted > 0) {
    report.cacheRebuilt = await rebuildCache();
  }
  report.legacyCache = (await redis.exists(LEGACY_REMINDER_CACHE_KEY)) > 0;
  console.log(`[key-sweep] users ${tickCounts(users)}; links ${tickCounts(links)}; legacy_cache=${report.legacyCache ? 1 : 0}`);
  await reportUnreadable(users, links, state);

  const work = hasWork(users) || hasWork(links);
  const unreadable = users.unreadable + links.unreadable;
  state.settled = !work;
  state.settledUnreadable = work ? 0 : unreadable;

  report.safe =
    previousKey === 'valid' &&
    uptime >= SAFE_UPTIME_S &&
    !work &&
    unreadable === 0 &&
    !report.legacyCache &&
    (await reminderCacheIsCurrent());
  if (report.safe && !state.safeLogged) {
    state.safeLogged = true;
    const fpCurrent = keyFingerprint('current') ?? 'unknown';
    const fpPrevious = keyFingerprint('previous') ?? 'unknown';
    console.log(`[key-sweep] SAFE: every stored token is under ENCRYPTION_KEY (fp ${fpCurrent}); nothing needs ENCRYPTION_KEY_PREVIOUS. You can remove it at the next deploy.`);
    await announceSafe(fpCurrent, fpPrevious);
  }
  return report;
}

/**
 * One sweep tick. Returns null when gated (under 10 minutes of uptime), idle (nothing left
 * to do in this process), skipped (ENCRYPTION_KEY missing or invalid, the lock held
 * elsewhere, or Redis failing on the lock). Database errors propagate to the scheduler,
 * which captures them as cron-key-sweep.
 */
export async function runKeySweep(opts: { uptimeSeconds?: number } = {}): Promise<KeySweepReport | null> {
  const uptime = opts.uptimeSeconds ?? process.uptime();
  if (uptime < GATE_UPTIME_S) return null;

  const state = sweepState();
  // Idle: SAFE was said, or the last pass found nothing to write and nothing more can
  // come of a pass in this process (no PREVIOUS key to retire, or rows neither key opens,
  // already reported). No database read every 10 minutes, so Neon can scale to zero.
  if (state.safeLogged) return null;
  if (state.settled && (previousKeyStatus() !== 'valid' || state.settledUnreadable > 0)) return null;

  if (keyFingerprint('current') === null) {
    // Once per process: this tick repeats every 10 minutes and the fix is a redeploy
    if (!state.keyProblemReported) {
      state.keyProblemReported = true;
      console.error('[key-sweep] ENCRYPTION_KEY is missing or invalid: skipping the sweep');
      captureError(new Error('ENCRYPTION_KEY is missing or invalid'), 'key-sweep-no-key');
    }
    return null;
  }

  const lockToken = randomUUID();
  try {
    const taken = await redis.set(LOCK_KEY, lockToken, { nx: true, ex: LOCK_TTL_S });
    if (taken !== 'OK') return null; // another container's tick holds it
  } catch (error) {
    console.warn('[key-sweep] Redis lock failed; skipping this tick:', error);
    captureError(error, 'key-sweep-lock', {}, 'warning');
    return null;
  }
  try {
    return await sweep(uptime, state);
  } finally {
    await releaseLock(lockToken);
  }
}
