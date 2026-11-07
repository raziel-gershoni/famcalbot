// The Jewish times API's keys as a request sees them (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5):
// the key's hash, the shape of the mirror (the active keys as one Redis value, REDIS_KEYS.API_KEYS) and the process's copy
// of it. The copy is on globalThis (Next 16 gives the routes and the scheduler separate module instances), so the admin
// route's write and the API routes' reads share it. store.ts writes the copy after each change; lookup.ts reads it.
//
// A key is fcj_ and 32 random bytes in base64url (43 characters): 256 bits, so a plain SHA-256 is enough (nobody can guess
// one, so no slow hash). Server only by import discipline. Pure apart from node:crypto.

import crypto from 'node:crypto';

export const KEY_PREFIX = 'fcj_';
/** A key's whole shape: anything else is refused before any lookup. */
export const KEY_PATTERN = /^fcj_[A-Za-z0-9_-]{43}$/;
/** The characters of a key the admin list shows: fcj_ and the next 6. */
export const PREFIX_LENGTH = KEY_PREFIX.length + 6;

/** One active key in the mirror: its row id, its app's name, its SHA-256 (hex) and its origins. */
export type MirrorEntry = { id: number; app: string; hash: string; origins: string[] };

export type KeyCopy = {
  byHash: ReadonlyMap<string, MirrorEntry>;
  /** Every origin some active key lists (the browser's preflight carries no key). */
  origins: ReadonlySet<string>;
  /** When it was read (epoch ms). */
  loadedAt: number;
  count: number;
};

type Shared = { copy: KeyCopy | null };

/** The process's state, read on each call (a smoke starts it over by deleting globalThis.__apiKeys). */
function shared(): Shared {
  const g = globalThis as { __apiKeys?: Shared };
  return (g.__apiKeys ??= { copy: null });
}

/** The SHA-256 of a key, hex: what the table, the mirror and the copy hold. */
export function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

const isEntry = (value: unknown): value is MirrorEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return Number.isInteger(e.id) && typeof e.app === 'string' && typeof e.hash === 'string' && /^[0-9a-f]{64}$/.test(e.hash) && Array.isArray(e.origins) && e.origins.every((o) => typeof o === 'string');
};

/**
 * The mirror's value as Redis answers it (Upstash parses JSON on read; a string is parsed here), or null when it is not a
 * list of entries. Not a failure to report here: the caller logs that it rebuilds the list.
 */
export function parseMirror(value: unknown): MirrorEntry[] | null {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      // Unreadable text is no list: the caller rebuilds it from the table and logs that
      return null;
    }
  }
  return Array.isArray(list) && list.every(isEntry) ? list : null;
}

/** The process's copy, or null before the first read (a restart, a deploy). */
export function keyCopy(): KeyCopy | null {
  return shared().copy;
}

/** Replaces the process's copy with these entries, read at `now`. */
export function installKeyCopy(entries: readonly MirrorEntry[], now: number): KeyCopy {
  const copy: KeyCopy = {
    byHash: new Map(entries.map((entry) => [entry.hash, entry])),
    origins: new Set(entries.flatMap((entry) => entry.origins)),
    loadedAt: now,
    count: entries.length,
  };
  shared().copy = copy;
  return copy;
}
