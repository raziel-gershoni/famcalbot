/**
 * The browsers that get an account's notifications (spec docs/superpowers/specs/2026-11-05-web-push-design.md §3.1,
 * §2.4): one PushDevice row per browser, on one account at a time, at most MAX_DEVICES per account. The only file that
 * reads or writes the table (scripts/smoke-push-devices.ts D9 fences it, as smoke-signin-setup fences SignInIdentity).
 *
 * An endpoint and its keys are a credential: no console line, Sentry field, cache entry or admin view holds one. Lines
 * name the user id, the device id and counts. A failure is told by its kind only (safe-error.ts): a Prisma error's
 * message can print the query's values. The functions a route calls (addDevice, isOwnDevice, deleteOwnDevice,
 * deleteDevicesOf) let a database error through to it; deleteGoneDevice and afterDevicesChanged never throw.
 *
 * Every change of an account's devices re-syncs its event alert cache entry (afterDevicesChanged), since a device is
 * what lets an account with no chat get alerts. A change made inside a caller's transaction is re-synced by the caller,
 * after the commit.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { captureError } from '../../lib/error-capture';
import { SafeSignInError, safeErrorSummary } from '../web-signin/safe-error';
import { isPushServiceUrl } from './config';

export const MAX_DEVICES = 10;

export interface PushKeys {
  p256dh: string;
  auth: string;
}

/** What a browser's PushSubscription.toJSON() carries that we keep. */
export interface PushDeviceInput {
  endpoint: string;
  keys: PushKeys;
}

export interface StoredDevice {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const MAX_ENDPOINT_LENGTH = 1024;
/** base64url, with the padding a browser may add */
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const keyOk = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'string' && value.length >= min && value.length <= max && BASE64URL.test(value);

/**
 * An endpoint we would store or keep: an https URL of a known push service (config.ts PUSH_SERVICE_HOSTS) of at most
 * 1024 characters. The one endpoint rule: isValidDeviceInput reads it, and so does Remove a way (Task 6).
 */
export function isValidEndpoint(x: unknown): x is string {
  if (typeof x !== 'string' || x.length > MAX_ENDPOINT_LENGTH) return false;
  try {
    return isPushServiceUrl(new URL(x));
  } catch {
    return false; // not a URL: refused, and the route logs the refusal
  }
}

/**
 * A subscription we can store: a valid endpoint (isValidEndpoint), a p256dh of 80-100 characters (65 bytes) and an
 * auth of 16-32 (16 bytes), both base64url.
 */
export function isValidDeviceInput(x: unknown): x is PushDeviceInput {
  if (!x || typeof x !== 'object') return false;
  const { endpoint, keys } = x as { endpoint?: unknown; keys?: unknown };
  if (!isValidEndpoint(endpoint)) return false;
  if (!keys || typeof keys !== 'object') return false;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  return keyOk(p256dh, 80, 100) && keyOk(auth, 16, 32);
}

/**
 * Stores this browser for the account: a new row, or the row of the same endpoint with its new keys, its new account
 * (it moves from another one: the browser proved it holds it) and a new turn-on time. Then the account's oldest
 * devices beyond MAX_DEVICES are removed. Re-syncs every account touched after the commit.
 */
export async function addDevice(userId: number, input: PushDeviceInput): Promise<{ moved: boolean; count: number }> {
  const { endpoint, keys: { p256dh, auth } } = input;
  const { from, count, dropped } = await prisma.$transaction(async (tx) => {
    const before = await tx.pushDevice.findUnique({ where: { endpoint }, select: { userId: true } });
    await tx.pushDevice.upsert({
      where: { endpoint },
      create: { userId, endpoint, p256dh, auth },
      update: { userId, p256dh, auth, createdAt: new Date() },
    });
    const mine = await tx.pushDevice.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    const extra = mine.slice(MAX_DEVICES).map((device) => device.id);
    if (extra.length > 0) await tx.pushDevice.deleteMany({ where: { id: { in: extra } } });
    return { from: before?.userId ?? null, count: mine.length - extra.length, dropped: extra.length };
  });
  const others = from !== null && from !== userId ? [from] : [];
  console.log(
    `[push-devices] user ${userId}: a device turned on (${count} of ${MAX_DEVICES})` +
      (others.length > 0 ? `, moved from user ${others[0]}` : '') +
      (dropped > 0 ? `; the oldest ${dropped} removed` : ''),
  );
  await afterDevicesChanged([userId, ...others]);
  return { moved: others.length > 0, count };
}

/** Whether this endpoint is one of the account's devices. Another account's and an unknown one read the same. */
export async function isOwnDevice(userId: number, endpoint: string): Promise<boolean> {
  const row = await prisma.pushDevice.findUnique({ where: { endpoint }, select: { userId: true } });
  return row?.userId === userId;
}

/** Deletes this endpoint only when it is the account's own; true when a row went. */
export async function deleteOwnDevice(userId: number, endpoint: string): Promise<boolean> {
  const { count } = await prisma.pushDevice.deleteMany({ where: { userId, endpoint } });
  if (count === 0) return false;
  console.log(`[push-devices] user ${userId}: a device turned off`);
  await afterDevicesChanged([userId]);
  return true;
}

/**
 * Deletes every device of these accounts, except the endpoint `keep` (the browser a Remove was pressed in). Inside the
 * caller's transaction (`tx`) it re-syncs nothing: the caller calls afterDevicesChanged after the commit. Returns how
 * many went.
 */
export async function deleteDevicesOf(
  userIds: number | number[],
  opts: { keep?: string | null; tx?: Prisma.TransactionClient } = {},
): Promise<number> {
  const ids = [...new Set(([] as number[]).concat(userIds))];
  if (ids.length === 0) return 0;
  const client = opts.tx ?? prisma;
  const { count } = await client.pushDevice.deleteMany({
    where: { userId: { in: ids }, ...(opts.keep ? { endpoint: { not: opts.keep } } : {}) },
  });
  if (count > 0) console.log(`[push-devices] users ${ids.join(', ')}: ${count} devices deleted${opts.keep ? ' (the device in use kept)' : ''}`);
  if (!opts.tx && count > 0) await afterDevicesChanged(ids);
  return count;
}

/** The account's devices, oldest first, for one send (send.ts reads them at send time). */
export async function devicesForSend(userId: number): Promise<StoredDevice[]> {
  return prisma.pushDevice.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
}

/** A device its push service called gone (404 or 410): deleted, and its account re-synced. Never throws. */
export async function deleteGoneDevice(id: string): Promise<void> {
  let userId: number;
  try {
    ({ userId } = await prisma.pushDevice.delete({ where: { id }, select: { userId: true } }));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'P2025') {
      console.log(`[push-devices] device ${id} was already gone`);
      return;
    }
    console.error(`[push-devices] device ${id}: could not delete it: ${safeErrorSummary(error)}`);
    captureError(new SafeSignInError(`push-devices: ${safeErrorSummary(error)}`), 'push-devices', { purpose: 'delete-gone' });
    return;
  }
  console.log(`[push-devices] user ${userId}: device ${id} deleted (its push service says it is gone)`);
  await afterDevicesChanged([userId]);
}

/**
 * Puts each account's event alert cache entry in line with its row (reminder-cache.ts syncReminderCacheEntry, the
 * hourly sync's rule). Never throws: a failure is logged and reported, and the hourly sync mends the entry.
 */
export async function afterDevicesChanged(userIds: number[]): Promise<void> {
  for (const userId of [...new Set(userIds)]) {
    try {
      // Loaded here: user-service imports user-moderation, which deletes devices through this file
      const { getUserById } = await import('../user-service');
      const { syncReminderCacheEntry } = await import('../reminder-cache');
      const user = await getUserById(userId);
      if (!user) {
        console.log(`[push-devices] user ${userId}: no account, no alert cache entry to sync`);
        continue;
      }
      await syncReminderCacheEntry(user);
    } catch (error) {
      console.error(`[push-devices] user ${userId}: the alert cache entry was not synced: ${safeErrorSummary(error)}`);
      captureError(new SafeSignInError(`push-devices: ${safeErrorSummary(error)}`), 'push-devices', { user_id: userId, purpose: 'cache-sync' });
    }
  }
}

/** How many devices the account has on: the page props' `devices` (pushPropsFor). */
export async function countDevices(userId: number): Promise<number> {
  return prisma.pushDevice.count({ where: { userId } });
}
