// The Jewish times API's keys in the database (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5): the one
// file that reads or writes ApiKey rows (scripts/smoke-api-keys.ts fences the table to it). The admin route calls it.
//
// - A key is made here and returned once, by createApiKey: only its SHA-256 and its first 10 characters (the prefix, for
//   the list) are kept. It never reaches a log, Redis or Sentry.
// - After each write the mirror is rebuilt: the active keys read back from the table, written to Redis as one value
//   (REDIS_KEYS.API_KEYS, no TTL), then put in this process's memory (mirror.ts), in that order. A failed SET deletes the
//   mirror (the next cold read rebuilds it from the table); a failed delete too is MIRROR_FAILED for a revoke (a create
//   still answers its key: this process's copy has it). The memory copy is always replaced.
// - At most 50 active keys: a guard, not a product limit.
// - Logs name a key by its id and the admin by theirs: never the key, its hash, its prefix, its app's name or its origins.

import crypto from 'node:crypto';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { safeErrorSummary } from '../web-signin/safe-error';
import { KEY_PREFIX, PREFIX_LENGTH, hashKey, installKeyCopy, type MirrorEntry } from './mirror';

export const MAX_ACTIVE_KEYS = 50;
export const MAX_APP_NAME = 40;

export type ApiKeyErrorCode = 'INVALID_NAME' | 'INVALID_ORIGIN' | 'NOT_FOUND' | 'MIRROR_FAILED' | 'TOO_MANY_KEYS';

/** A refusal the admin route answers with its code. */
export class ApiKeyError extends Error {
  constructor(readonly code: ApiKeyErrorCode) {
    super(code);
    this.name = 'ApiKeyError';
  }
}

/** A key as the admin list shows it. */
export type ApiKeyListItem = { id: number; appName: string; prefix: string; origins: string[]; createdAt: string; revokedAt: string | null };

/** The app's name as stored: trimmed, 1 to 40 characters, no control character. */
export function checkAppName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiKeyError('INVALID_NAME');
  const name = value.trim();
  const length = [...name].length;
  if (length === 0 || length > MAX_APP_NAME || /\p{Cc}/u.test(name)) throw new ApiKeyError('INVALID_NAME');
  return name;
}

/** One origin as a browser sends it (https://host[:port], or http://localhost:port), or null for anything else. */
function originOf(line: string): string | null {
  if (/[\s?#@]/.test(line)) return null;
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    // Not a URL at all: the caller refuses the whole list with INVALID_ORIGIN
    return null;
  }
  const secure = url.protocol === 'https:';
  const local = url.protocol === 'http:' && url.hostname === 'localhost' && url.port !== '';
  if (!secure && !local) return null;
  const rest = line.replace(/^https?:\/\/[^/]+/i, '');
  if (rest !== '' && rest !== '/') return null;
  return url.origin;
}

/** The origins a key is locked to: one per line (or a list), blank lines dropped, each as a browser sends it, each once. */
export function readOrigins(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const lines: unknown[] | null = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : null;
  if (!lines) throw new ApiKeyError('INVALID_ORIGIN');
  const out: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') throw new ApiKeyError('INVALID_ORIGIN');
    const line = raw.trim();
    if (line === '') continue;
    const origin = originOf(line);
    if (!origin) throw new ApiKeyError('INVALID_ORIGIN');
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The active keys as the mirror holds them, by id. */
async function activeEntries(): Promise<MirrorEntry[]> {
  const rows = await prisma.apiKey.findMany({ where: { revokedAt: null }, orderBy: { id: 'asc' }, select: { id: true, appName: true, keyHash: true, origins: true } });
  return rows.map((row) => ({ id: row.id, app: row.appName, hash: row.keyHash, origins: row.origins }));
}

/** Writes the mirror; a failed SET deletes it. False only when neither went through (Redis holds an old list). */
async function publishMirror(entries: MirrorEntry[]): Promise<boolean> {
  try {
    await redis.set(REDIS_KEYS.API_KEYS, JSON.stringify(entries));
    return true;
  } catch (error) {
    captureError(new Error(`[api-keys] the mirror was not written (${safeErrorSummary(error)}): deleting it`), 'api-keys', { step: 'mirror-set' });
    try {
      await redis.del(REDIS_KEYS.API_KEYS);
      return true;
    } catch (again) {
      captureError(new Error(`[api-keys] the mirror was not deleted either (${safeErrorSummary(again)})`), 'api-keys', { step: 'mirror-del' });
      return false;
    }
  }
}

/** The active keys from the table into Redis (lookup.ts calls it when Redis has no list). Throws what the table throws. */
export async function rebuildMirror(): Promise<{ entries: MirrorEntry[]; published: boolean }> {
  const entries = await activeEntries();
  return { entries, published: await publishMirror(entries) };
}

/** After a write: the table, then Redis, then this process's copy. False when the mirror could be neither written nor deleted. */
async function afterWrite(now: number): Promise<boolean> {
  const { entries, published } = await rebuildMirror();
  installKeyCopy(entries, now);
  return published;
}

/** A new key for an app: answered once, with its row id and its prefix. Throws ApiKeyError for a bad name or origin, or 50 active keys. */
export async function createApiKey(appName: unknown, origins: unknown, adminId: number): Promise<{ key: string; id: number; prefix: string }> {
  const name = checkAppName(appName);
  const allowed = readOrigins(origins);
  const active = await prisma.apiKey.count({ where: { revokedAt: null } });
  if (active >= MAX_ACTIVE_KEYS) throw new ApiKeyError('TOO_MANY_KEYS');
  const key = `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const row = await prisma.apiKey.create({
    data: { appName: name, keyHash: hashKey(key), prefix: key.slice(0, PREFIX_LENGTH), origins: allowed, createdBy: adminId },
    select: { id: true, prefix: true },
  });
  console.log(`[api-keys] key ${row.id} created by admin ${adminId}`);
  // A mirror that could not be written is reported in publishMirror; this process's copy has the key either way
  await afterWrite(Date.now());
  return { key, id: row.id, prefix: row.prefix };
}

/** Revokes a key: final. Again on a revoked key writes the list again and succeeds. Throws NOT_FOUND, or MIRROR_FAILED. */
export async function revokeApiKey(id: number, adminId: number): Promise<void> {
  const now = Date.now();
  const done = await prisma.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(now) } });
  if (done.count === 0) {
    const row = await prisma.apiKey.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new ApiKeyError('NOT_FOUND');
    console.log(`[api-keys] key ${id} was already revoked (admin ${adminId}): the key list is written again`);
  } else {
    console.log(`[api-keys] key ${id} revoked by admin ${adminId}`);
  }
  if (!(await afterWrite(now))) throw new ApiKeyError('MIRROR_FAILED');
}

/** Every key, newest first, as the admin list shows it (never a hash). */
export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  const rows = await prisma.apiKey.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, appName: true, prefix: true, origins: true, createdAt: true, revokedAt: true },
  });
  return rows.map((row) => ({ id: row.id, appName: row.appName, prefix: row.prefix, origins: row.origins, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null }));
}
