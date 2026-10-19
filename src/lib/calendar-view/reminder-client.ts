// The calendar home's reminder actions (reminder-actions spec §3, §4): done, undo and
// snooze from the item sheet, through POST /api/calendar/reminder. Client components
// only. Nothing here touches window at import.
//
// The init data goes in the header and the body, as the other Mini App POSTs send it
// (command-client); in a browser the session cookie rides along. user_id is the page's
// own, a Telegram id or a DB id, never swapped. The route acts on the proved user only.
// The answer is read into `answered` (the route's status, with the reminder it sent back)
// or `failed` (429, any other status, a body that isn't an answer, no answer in time).

import { INIT_DATA_HEADER, readInitData } from '../read-init-data';
import type { ItemReminderDTO } from './types';

export type ReminderActionName = 'done' | 'undo' | 'snooze15' | 'snooze60' | 'snoozeTomorrow';

export type ReminderActionStatus = 'ok' | 'already_done' | 'not_done' | 'changed' | 'not_yours';

export type ReminderActionOutcome = { kind: 'answered'; status: ReminderActionStatus; reminder: ItemReminderDTO | null } | { kind: 'failed' };

/** What the dependency takes: the occurrence's key from the DTO (seriesId, originalStart), and the action. */
export interface ReminderActionRequest {
  seriesId: string;
  originalStart: string;
  action: ReminderActionName;
}

/** The home's dependency: the fetch, so a smoke can fake it. Never throws. */
export type ReminderActionFn = (userId: number, request: ReminderActionRequest) => Promise<ReminderActionOutcome>;

const STATUSES: readonly string[] = ['ok', 'already_done', 'not_done', 'changed', 'not_yours'];
/** A request that hasn't answered by then reads as failed, so the buttons never stay disabled. */
const TIME_LIMIT_MS = 15_000;

function isReminder(value: unknown): value is ItemReminderDTO {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.done === 'boolean' && typeof r.open === 'boolean' && typeof r.ownerIsViewer === 'boolean' && typeof r.creatorIsViewer === 'boolean';
}

export const postReminderAction: ReminderActionFn = async (userId, request) => {
  const initData = readInitData();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), TIME_LIMIT_MS);
  try {
    const res = await fetch('/api/calendar/reminder', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(initData ? { [INIT_DATA_HEADER]: initData } : {}) },
      body: JSON.stringify({ user_id: userId, ...request, ...(initData ? { initData } : {}) }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (res.status !== 200) return { kind: 'failed' };
    const body: unknown = await res.json();
    const status = body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined;
    if (typeof status !== 'string' || !STATUSES.includes(status)) return { kind: 'failed' };
    const reminder = (body as { reminder?: unknown }).reminder;
    return { kind: 'answered', status: status as ReminderActionStatus, reminder: isReminder(reminder) ? reminder : null };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
};
