// A request's key (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5): `findApiKey` hashes it and looks the
// hash up in the process's copy (mirror.ts), which holds every active key, so an unknown key is a miss in memory.
//
// - A copy under 5 minutes old: memory only (the steady state: no Redis command, no database query).
// - Older: the request is served from it, and one Redis GET refreshes it in the background (one at a time; after a failed
//   one the next waits 5 minutes), so at most one Redis command per 5 minutes, and only while requests come. A failing
//   Redis keeps the copy (reported once per failure); a refresh never reads the table unless Redis has no list.
// - No copy (a restart, a deploy): one Redis GET before answering, shared by the requests that arrive meanwhile.
// - Redis has no list (never written, flushed) or one that is not a list: one table read rebuilds it and writes it back
//   (store.ts rebuildMirror), logged `[api-keys] rebuilt the key list from the database`. The only table read on a
//   request's path, never in the steady state. With no copy and Redis failing, the table is read the same way; if that
//   fails too it is KeysUnavailable (the route answers 503 KEYS_UNAVAILABLE), reported to Sentry.
// No key, hash or origin reaches a log.

import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { redis } from '../../utils/redis';
import { safeErrorSummary } from '../web-signin/safe-error';
import { KEY_PATTERN, hashKey, installKeyCopy, keyCopy, parseMirror, type KeyCopy, type MirrorEntry } from './mirror';
import { rebuildMirror } from './store';

/** How long a copy answers alone before a request refreshes it. */
export const COPY_FRESH_MS = 5 * 60 * 1000;

/** A request's key as the handler reads it. */
export type FoundKey = { id: number; app: string; origins: readonly string[] };

/** No copy, and neither Redis nor the table could give the list. */
export class KeysUnavailable extends Error {
  constructor() {
    super('The key list could not be read from Redis or the database');
    this.name = 'KeysUnavailable';
  }
}

type LookupState = { loading: Promise<KeyCopy> | null; refreshing: Promise<void> | null; lastAttempt: number };

function state(): LookupState {
  const g = globalThis as { __apiKeysLookup?: LookupState };
  return (g.__apiKeysLookup ??= { loading: null, refreshing: null, lastAttempt: 0 });
}

const reportRedis = (error: unknown) =>
  captureError(new Error(`[api-keys] the key list could not be read from Redis (${safeErrorSummary(error)})`), 'api-keys', { step: 'redis-get' });

/** Redis's list; null when it has none or one that is not a list (logged). Throws what Redis throws. */
async function mirrorList(): Promise<MirrorEntry[] | null> {
  const value = await redis.get<unknown>(REDIS_KEYS.API_KEYS);
  if (value === null || value === undefined) return null;
  const entries = parseMirror(value);
  if (!entries) console.warn('[api-keys] the key list in Redis is not one: rebuilding it from the database');
  return entries;
}

async function fromDatabase(now: number): Promise<KeyCopy> {
  const { entries } = await rebuildMirror();
  console.log(`[api-keys] rebuilt the key list from the database: ${entries.length} active`);
  return installKeyCopy(entries, now);
}

/** The first read of a process: Redis, else the table. Throws what the table throws. */
async function coldRead(now: number): Promise<KeyCopy> {
  let entries: MirrorEntry[] | null = null;
  try {
    entries = await mirrorList();
  } catch (error) {
    reportRedis(error);
  }
  return entries ? installKeyCopy(entries, now) : fromDatabase(now);
}

/** A refresh of an old copy: Redis only, unless Redis has no list. A failing Redis leaves the copy as it is. */
async function refresh(now: number): Promise<void> {
  let entries: MirrorEntry[] | null;
  try {
    entries = await mirrorList();
  } catch (error) {
    reportRedis(error);
    return;
  }
  if (entries) installKeyCopy(entries, now);
  else await fromDatabase(now);
}

function refreshInBackground(now: number): void {
  const s = state();
  if (s.refreshing) return;
  s.lastAttempt = now;
  s.refreshing = refresh(now)
    .catch((error: unknown) => {
      captureError(new Error(`[api-keys] the key list was not refreshed (${safeErrorSummary(error)}): the copy keeps serving`), 'api-keys', { step: 'refresh' });
    })
    .finally(() => {
      state().refreshing = null;
    });
}

async function currentCopy(now: number): Promise<KeyCopy> {
  const copy = keyCopy();
  if (copy) {
    if (now - Math.max(copy.loadedAt, state().lastAttempt) >= COPY_FRESH_MS) refreshInBackground(now);
    return copy;
  }
  const s = state();
  s.loading ??= coldRead(now).finally(() => {
    state().loading = null;
  });
  try {
    return await s.loading;
  } catch (error) {
    captureError(new Error(`[api-keys] the key list could not be read (${safeErrorSummary(error)})`), 'api-keys', { step: 'cold-read' });
    throw new KeysUnavailable();
  }
}

/** The active key `rawKey` is, or null (unknown, revoked or not a key's shape). Throws KeysUnavailable. */
export async function findApiKey(rawKey: string, now: number = Date.now()): Promise<FoundKey | null> {
  if (!KEY_PATTERN.test(rawKey)) return null;
  const entry = (await currentCopy(now)).byHash.get(hashKey(rawKey));
  return entry ? { id: entry.id, app: entry.app, origins: entry.origins } : null;
}

/** Whether some active key lists `origin` (the preflight's answer, which carries no key). Throws KeysUnavailable. */
export async function anyKeyListsOrigin(origin: string, now: number = Date.now()): Promise<boolean> {
  return (await currentCopy(now)).origins.has(origin);
}

/** Smoke scripts only: the background refresh under way, to wait for. */
export function __pendingKeyRefreshForTests(): Promise<void> | null {
  return state().refreshing;
}
