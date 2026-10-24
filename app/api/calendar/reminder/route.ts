/**
 * POST /api/calendar/reminder: done, undo and snooze on one reminder occurrence, from the
 * calendar home (reminder actions spec §3).
 *
 *   body { user_id, initData?, seriesId, originalStart, action }, action being
 *   done | undo | snooze15 | snooze60 | snoozeTomorrow
 *   X-Telegram-Init-Data: <initData>   (or the famcal_session cookie in a browser)
 *
 * The route acts for the authenticated user only; the body never says whose reminder it
 * is. The answer is { status, reminder? }: reminder is the occurrence's new state as the
 * range route would list it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { reminderActionRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { applyReminderAction, type ReminderAction } from '@/src/services/native-reminders/actions';
import { reminderDueAt } from '@/src/services/native-reminders/due';
import { readFamcal } from '@/src/services/calendar-read/famcal';
import { toItemDto } from '@/src/services/calendar-read/dto';
import { prisma } from '@/src/utils/prisma';
import { localDate } from '@/src/utils/day-events';
import type { ItemReminderDTO } from '@/src/lib/calendar-view/types';
import type { UserConfig } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = 'private, no-store';
const ACTIONS: readonly ReminderAction[] = ['done', 'undo', 'snooze15', 'snooze60', 'snoozeTomorrow'];
const SERIES_ID = /^c[a-z0-9]{20,31}$/;
/** How far around an occurrence the DTO read looks, so an all-day one or a moved one is in it. */
const READ_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': NO_STORE } });
}

type Body = { seriesId: string; originalStart: Date; action: ReminderAction };

/** An ISO instant that parses to the same instant it was written as ("2026-10-19T09:00:00.000Z"). */
function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value ? date : null;
}

/** The body's user_id (the Telegram id, or the account's id for a browser session), as a string. */
function userIdOf(raw: unknown): string | null {
  const id = (raw as { user_id?: unknown } | null)?.user_id;
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : null;
}

function parseBody(raw: unknown): Body | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const { seriesId, action } = body;
  const originalStart = parseInstant(body.originalStart);
  if (typeof seriesId !== 'string' || !SERIES_ID.test(seriesId) || !originalStart) return null;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) return null;
  return { seriesId, originalStart, action: action as ReminderAction };
}

/**
 * The occurrence as the range route lists it for this user, or undefined when the user's
 * legend does not hold it. It is read by the same reader and DTO code, so the two never
 * disagree. `open` follows the home's rule: past due and not done.
 */
async function reminderOf(user: UserConfig, seriesId: string, originalStart: Date, now: Date): Promise<ItemReminderDTO | undefined> {
  const series = await prisma.nativeEvent.findUnique({
    where: { id: seriesId },
    select: { startsAt: true, instances: { where: { originalStartsAt: originalStart }, select: { startsAt: true } } },
  });
  const moved = series?.instances[0]?.startsAt ?? originalStart;
  const from = new Date(Math.min(originalStart.getTime(), moved.getTime()) - READ_MARGIN_MS);
  const to = new Date(Math.max(originalStart.getTime(), moved.getTime()) + READ_MARGIN_MS);
  const { read, items } = await readFamcal(user, { from, to }, {});
  if (read.status !== 'ok') return undefined;
  const item = items.find((i) => i.seriesId === seriesId && i.originalStart === originalStart.toISOString());
  if (!item) return undefined;
  const tz = await resolveUserTimezone(user);
  const due = reminderDueAt(item.event, tz, user.reminderTime);
  const done = (item.state?.doneAt ?? null) !== null;
  const open = !done && due < now;
  // Only an older open reminder (a carry-over) has an openSince; today's has none.
  const day = localDate(due, tz);
  return toItemDto(item, null, { now, open, openSince: open && day < localDate(now, tz) ? day : null }).reminder;
}

export async function POST(request: NextRequest) {
  const raw: unknown = await request.json().catch(() => null);
  const auth = await verifyUserAuth(request, userIdOf(raw), requestInitData(request, raw), reminderActionRateLimiter, 'calendar-reminder');
  if (!auth.success) {
    auth.response.headers.set('Cache-Control', NO_STORE);
    return auth.response;
  }
  const user = auth.user;
  const body = parseBody(raw);
  if (!body) return json({ error: 'bad_request' }, 400);

  try {
    const now = new Date();
    const key = { seriesEventId: body.seriesId, originalStartsAt: body.originalStart };
    const result = await applyReminderAction(user, key, body.action, now, 'app');
    if (result.status === 'changed' || result.status === 'not_yours') return json({ status: result.status });
    const reminder = await reminderOf(user, body.seriesId, body.originalStart, now).catch((err) => {
      // The write stands; the client refetches and gets the state from the range.
      captureError(err, 'calendar-reminder-dto', { user_id: user.id }, 'warning');
      return undefined;
    });
    return json({ status: result.status, ...(reminder ? { reminder } : {}) });
  } catch (err) {
    // No titles in the context: the user id only.
    captureError(err, 'calendar-reminder', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}
