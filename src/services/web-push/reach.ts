/**
 * Who FamCal's reminders and alerts can reach (6c-2 spec §2.3, §3.5): the one rule every Telegram gate of reminders and
 * alerts reads. A person is reached on Telegram, or, when the account has no chat at all (no Telegram and no WhatsApp,
 * hasChat), by a browser notification on a device where they turned them on, while browser notifications are set up
 * (both VAPID keys, pushConfigured). WhatsApp alone reaches nobody here, as before (reminders are Telegram's there).
 *
 * The device count rides in the reads that are already there: spread PUSH_DEVICE_COUNT into a select or an include
 * (Prisma counts the relation in the same SQL statement) and read it with pushDeviceCountOf. Never a query of its own.
 * No import beyond the config and has-chat, so ownership.ts and support.ts can take it without a cycle.
 */

import { hasChat } from '../../lib/has-chat';
import { pushConfigured } from './config';

/** Spread into a user select or include: `_count.pushDevices`, in the same statement. */
export const PUSH_DEVICE_COUNT = { _count: { select: { pushDevices: true } } } as const;

/** The device count of a row read with PUSH_DEVICE_COUNT; 0 for a row read without it. */
export function pushDeviceCountOf(row: { _count?: { pushDevices?: number } } | null | undefined): number {
  const n = row?._count?.pushDevices;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** A Telegram id that is there: not null, not undefined, and not '' (the alerts cache writes '' for none). */
export function hasTelegramId(telegramId: bigint | number | string | null | undefined): boolean {
  return telegramId !== null && telegramId !== undefined && String(telegramId) !== '';
}

export interface PushReachUser {
  telegramId: bigint | number | string | null | undefined;
  whatsappPhone?: string | null;
  whatsappBsuid?: string | null;
  /** Devices with notifications on (pushDeviceCountOf, or UserConfig.pushDeviceCount). */
  pushDeviceCount: number;
}

/** Whether a browser notification can reach this person: push configured, no chat, at least one device. */
export function canReachByPush(user: PushReachUser): boolean {
  if (user.pushDeviceCount <= 0 || !pushConfigured()) return false;
  // hasChat is the one rule for "has a chat"; a cached entry's '' Telegram id counts as none
  return !hasChat({ telegramId: hasTelegramId(user.telegramId) ? 1 : null, whatsappPhone: user.whatsappPhone, whatsappBsuid: user.whatsappBsuid });
}

/** What the reminder gates hand over: any of the reach columns, the count optional (unread reads as none). */
export interface ReachUser {
  telegramId?: bigint | number | string | null;
  whatsappPhone?: string | null;
  whatsappBsuid?: string | null;
  pushDeviceCount?: number;
}

/** Whether reminders and alerts can reach this person: on Telegram, or by push (canReachByPush). */
export function reachableForReminders(user: ReachUser): boolean {
  return hasTelegramId(user.telegramId) || canReachByPush({
    telegramId: user.telegramId,
    whatsappPhone: user.whatsappPhone,
    whatsappBsuid: user.whatsappBsuid,
    pushDeviceCount: user.pushDeviceCount ?? 0,
  });
}
