// Done, undo and snooze on one native reminder occurrence (native-reminders spec §5,
// reminder-actions spec §2). The ping's buttons (callbacks.ts) and the calendar home's
// route (app/api/calendar/reminder) both come here, so the rules live once: the
// occurrence must still be live, the actor must be its effective owner or its creator,
// and every write is conditional on the state it expects.
//
// An occurrence is named by its key, (series id, originalStartsAt), never by a state row
// id: an occurrence nobody has pinged has no row, and the first in-app action makes one.
// Nothing here throws on a stale or foreign request: those are answers. Telegram trouble
// (the live ping's edit, the creator's notice) never fails the action.

import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../../utils/prisma';
import { getBot } from '../telegram/bot';
import { getBotMessage } from '../../lib/bot-messages';
import { resolveUserTimezone } from '../../lib/timezone';
import { captureError } from '../../lib/error-capture';
import { readStoredToken } from '../../utils/encryption';
import { describeDeliveryError, isUnreachableError } from '../../lib/delivery-errors';
import { markUserUnreachable } from '../../lib/user-reachability';
import { trackActivityAsync } from '../analytics-service';
import { escapeHtml } from '../../utils/html';
import { expandSeries } from '../native-calendar/recurrence';
import { invalidateDueGate } from './due-gate';
import { tomorrowMorning } from './due';
import { effectiveOwnerId, getActivePartnerSummary } from './ownership';
import { stripPingButtons } from './ping';
import type { UserConfig } from '../../types';

export type ReminderAction = 'done' | 'undo' | 'snooze15' | 'snooze60' | 'snoozeTomorrow';
export type ReminderActionSource = 'ping' | 'app';
export type OccurrenceKey = { seriesEventId: string; originalStartsAt: Date };

/**
 * What an action came to. `already_done` and `not_done` are not failures: the state is
 * what the other side wanted anyway (the route tells the client so). `not_yours` says
 * whether the actor was the reminder's target once (`wasTarget`): the pair unlinked, or
 * they moved to Google, and it is the creator's again.
 */
export type ReminderActionResult =
  | { status: 'ok'; title: string; until?: Date; timeZone?: string }
  | { status: 'already_done'; title: string }
  | { status: 'not_done'; title: string }
  | { status: 'changed' }
  | { status: 'not_yours'; wasTarget: boolean };

const SNOOZE_MS = { snooze15: 15 * 60 * 1000, snooze60: 60 * 60 * 1000 } as const;
// The ping buttons' op names, kept as the analytics value.
const SNOOZE_OP = { snooze15: 's15', snooze60: 's60', snoozeTomorrow: 'st' } as const;
type SnoozeAction = keyof typeof SNOOZE_OP;

/** The series behind an occurrence, with what re-validation and the notices need. */
function loadSeries(seriesEventId: string) {
  return prisma.nativeEvent.findUnique({
    where: { id: seriesEventId },
    include: {
      calendar: { select: { isDeleted: true } },
      creator: {
        select: {
          id: true, name: true, language: true, pairingId: true,
          telegramId: true, suspendedAt: true, unreachableSince: true,
        },
      },
      instances: true,
    },
  });
}

type Series = NonNullable<Awaited<ReturnType<typeof loadSeries>>>;

/**
 * The title of the occurrence, or null when it no longer applies: the series was deleted
 * or is no longer a reminder, its calendar was deleted, or the occurrence was cancelled,
 * exdated or cut off by a "following" edit. A time change deletes the state row itself
 * (the event store's re-arm). The occurrence is looked up by its key alone, so one moved
 * to another time is still found.
 */
function liveOccurrenceTitle(series: Series, originalStartsAt: Date): string | null {
  if (series.isDeleted || series.calendar.isDeleted || series.kind !== 'REMINDER') return null;
  const key = originalStartsAt.getTime();
  const override = series.instances.find(o => o.originalStartsAt.getTime() === key);
  if (override?.status === 'CANCELLED') return null;
  let slot: ReturnType<typeof expandSeries>;
  try {
    slot = expandSeries(series, { from: originalStartsAt, to: new Date(key + 1) });
  } catch (error) {
    // A stored rule that can't be read: the buttons answer "changed" (3b spec §3.1).
    captureError(error, 'native-reminder-action-series', { series_id: series.id });
    return null;
  }
  if (!slot.some(occurrence => occurrence.instanceStartsAt.getTime() === key)) return null;
  return override?.title ?? series.title;
}

/** The series and title of a live occurrence, or null (what an answer of `changed` means). */
export async function loadLiveOccurrence(key: OccurrenceKey): Promise<{ series: Series; title: string } | null> {
  const series = await loadSeries(key.seriesEventId);
  const title = series && liveOccurrenceTitle(series, key.originalStartsAt);
  return series && title ? { series, title } : null;
}

/** Apply `action` to one occurrence for `actor`. `now` is for smoke scripts. */
export async function applyReminderAction(
  actor: UserConfig,
  key: OccurrenceKey,
  action: ReminderAction,
  now: Date = new Date(),
  source: ReminderActionSource = 'app'
): Promise<ReminderActionResult> {
  const live = await loadLiveOccurrence(key);
  if (!live) return { status: 'changed' };
  const { series, title } = live;

  // The effective owner or the creator may act (spec §2).
  const creatorPartner = await getActivePartnerSummary(series.creatorUserId, series.creator.pairingId);
  if (actor.id !== effectiveOwnerId(series, creatorPartner) && actor.id !== series.creatorUserId) {
    return { status: 'not_yours', wasTarget: actor.id === series.forUserId };
  }

  const ownerId = effectiveOwnerId(series, creatorPartner);
  const where = { seriesEventId_originalStartsAt: key };
  if (action === 'undo') {
    // lastPingedAt stays: an occurrence that pinged does not ping again, it is open again.
    const { count } = await prisma.nativeReminderState.updateMany({
      where: { ...key, doneAt: { not: null } },
      data: { doneAt: null, doneByUserId: null, snoozedUntil: null },
    });
    if (count === 0) return { status: 'not_done', title };
    invalidateDueGate();
    trackActivityAsync(actor.id, 'native_reminder_undone', { series_event_id: key.seriesEventId, source });
    return { status: 'ok', title };
  }

  // An occurrence nobody pinged has no row yet. The unique key makes a racing create a no-op.
  await prisma.nativeReminderState.createMany({ data: [key], skipDuplicates: true });

  if (action === 'done') {
    const { count } = await prisma.nativeReminderState.updateMany({
      where: { ...key, doneAt: null },
      data: { doneAt: now, doneByUserId: actor.id },
    });
    if (count === 0) return { status: 'already_done', title };
    trackActivityAsync(actor.id, 'native_reminder_done', { series_event_id: key.seriesEventId, source });
    if (actor.id !== series.creatorUserId) await notifyCreator(series.creator, actor, title);
    if (source === 'app') await editLivePing(where, ownerId, actor.id, title, { message: 'done' });
    return { status: 'ok', title };
  }

  const timeZone = await resolveUserTimezone(actor);
  const until = action === 'snoozeTomorrow' ? tomorrowMorning(now, timeZone) : new Date(now.getTime() + SNOOZE_MS[action]);
  // lastPingedAt stays as it is (null for a never-pinged occurrence): either way it is before
  // snoozedUntil, so the pass pings at that time. pingAttempts restarts, so the re-ping the
  // user asked for gets its full retry budget.
  const { count } = await prisma.nativeReminderState.updateMany({
    where: { ...key, doneAt: null },
    data: { snoozedUntil: until, pingAttempts: 0 },
  });
  if (count === 0) return { status: 'already_done', title };
  invalidateDueGate();
  trackActivityAsync(actor.id, 'native_reminder_snoozed', { series_event_id: key.seriesEventId, snooze: SNOOZE_OP[action], source });
  if (source === 'app') await editLivePing(where, ownerId, actor.id, title, { message: 'snoozedUntil', until, action });
  return { status: 'ok', title, until, timeZone };
}

/** "15:40", or "Thu 09:00" for tomorrow morning, on the actor's clock. */
export function snoozeLabel(until: Date, action: SnoozeAction, language: string, timeZone: string): string {
  const time = formatInTimeZone(until, timeZone, 'HH:mm');
  if (action !== 'snoozeTomorrow') return time;
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return `${until.toLocaleDateString(locale, { weekday: 'short', timeZone })} ${time}`;
}

/** The creator's quiet "✅ Done by Dana: Buy milk". Telegram only (R12). */
async function notifyCreator(creator: Series['creator'], doer: UserConfig, title: string): Promise<void> {
  if (!creator.telegramId || creator.suspendedAt || creator.unreachableSince) return;
  try {
    const text = await getBotMessage(creator.language || 'en', 'nativeReminders.doneBy', {
      name: escapeHtml(doer.name),
      title: escapeHtml(title),
    });
    await getBot().sendMessage(Number(creator.telegramId), text, { parse_mode: 'HTML', disable_notification: true });
  } catch (error) {
    if (isUnreachableError(error)) await markUserUnreachable(creator.id, describeDeliveryError(error));
    else captureError(error, 'native-reminder-done-notice', { user_id: creator.id }, 'warning');
  }
}

/**
 * An in-app done or snooze shows on the occurrence's live ping, as a tap on its button
 * would: "✅ title" or "💤 title · until 15:40", buttons gone. The ping is the owner's, so
 * its text is in the owner's language and clock, whoever acted. Never fails the action.
 */
async function editLivePing(
  where: { seriesEventId_originalStartsAt: OccurrenceKey },
  ownerId: number,
  actorId: number,
  title: string,
  edit: { message: 'done' } | { message: 'snoozedUntil'; until: Date; action: SnoozeAction }
): Promise<void> {
  try {
    const row = await prisma.nativeReminderState.findUnique({
      where,
      select: { pingChatId: true, pingMessageId: true },
    });
    if (!row?.pingChatId || row.pingMessageId == null) return;
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, language: true, location: true, googleRefreshToken: true },
    });
    const language = owner?.language || 'en';
    let time: string | undefined;
    if (edit.message === 'snoozedUntil') {
      // The column is encrypted: the timezone lookup needs the token itself ('' when unreadable).
      const timeZone = owner ? await resolveUserTimezone({ id: owner.id, location: owner.location ?? undefined, googleRefreshToken: readStoredToken(owner.googleRefreshToken, { userId: owner.id, column: 'googleRefreshToken' }) }) : 'UTC';
      time = snoozeLabel(edit.until, edit.action, language, timeZone);
    }
    const text = await getBotMessage(language, `nativeReminders.${edit.message}`, {
      title: escapeHtml(title),
      ...(time ? { time } : {}),
    });
    await stripPingButtons(row.pingChatId, row.pingMessageId, text);
  } catch (error) {
    captureError(error, 'native-reminder-action-ping-edit', { user_id: actorId }, 'warning');
  }
}
