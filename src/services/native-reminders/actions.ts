// Done, undo and snooze on one native reminder occurrence (native-reminders spec §5,
// reminder-actions spec §2). The ping's buttons (callbacks.ts) and the calendar home's
// route (app/api/calendar/reminder) both come here, so the rules live once: the
// occurrence must still be live, the actor must be someone it is for (one person, or both partners) or its creator,
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
import { markUnreachableAfterSendFailure } from '../../lib/user-reachability';
import { trackActivityAsync } from '../analytics-service';
import { escapeHtml } from '../../utils/html';
import { expandSeries } from '../native-calendar/recurrence';
import { invalidateDueGate } from './due-gate';
import { tomorrowMorning } from './due';
import { getActivePartnerSummary, isForBothReachable, isPingable, pingUserFor, recipientIds } from './ownership';
import { buildDoneText, buildPingKeyboard, buildPingText, refreshPing, stripPingButtons } from './ping';
import type { UserConfig } from '../../types';

export type ReminderAction = 'done' | 'undo' | 'snooze15' | 'snooze60' | 'snoozeTomorrow';
export type ReminderActionSource = 'ping' | 'app';
export type OccurrenceKey = { seriesEventId: string; originalStartsAt: Date };

/**
 * What an action came to. `already_done` and `not_done` are not failures: the state is
 * what the other side wanted anyway (the route tells the client so). `not_yours` says
 * whether the actor was the reminder's target once (`wasTarget`): the pair unlinked, or
 * they moved to Google, and it is the creator's again. On a reminder where each marks their
 * own Done, `already_done` and `not_done` mean the actor's own, and an `ok` Done says whether
 * it `completed` the occurrence (the last of the people who can be reached).
 */
export type ReminderActionResult =
  | { status: 'ok'; title: string; until?: Date; timeZone?: string; completed?: boolean }
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

  // Anyone it is for, or its creator, may act (spec §2; "remind us both" spec: either partner).
  const creatorPartner = await getActivePartnerSummary(series.creatorUserId, series.creator.pairingId);
  const recipients = recipientIds(series, creatorPartner);
  if (!recipients.includes(actor.id) && actor.id !== series.creatorUserId) {
    return { status: 'not_yours', wasTarget: actor.id === series.forUserId };
  }
  // Pings and notes follow the recipients who can be reached (ownership.ts).
  const reachable = await prisma.user.findMany({
    where: { id: { in: recipients } },
    select: { id: true, telegramId: true, suspendedAt: true, unreachableSince: true },
  });
  const forBoth = isForBothReachable(reachable.filter(isPingable).length);
  const pingUserId = pingUserFor(recipients, actor.id);
  // Each marks their own Done (the creator is always a recipient, so the actor's own ping row is theirs).
  const eachMarksDone = series.eachMarksDone === true;

  if (action === 'undo' && eachMarksDone) {
    if (!(await undoOwnDone(key, pingUserId, now))) return { status: 'not_done', title };
    invalidateDueGate();
    trackActivityAsync(actor.id, 'native_reminder_undone', { series_event_id: key.seriesEventId, source });
    return { status: 'ok', title };
  }

  if (action === 'undo') {
    // lastPingedAt stays: an occurrence that pinged does not ping again, it is open again.
    const { count } = await prisma.nativeReminderState.updateMany({
      where: { ...key, doneAt: { not: null } },
      data: { doneAt: null, doneByUserId: null },
    });
    if (count === 0) return { status: 'not_done', title };
    // Undo reopens it for everyone, and clears only the actor's own snooze.
    await prisma.nativeReminderPing.updateMany({ where: { userId: pingUserId, state: key }, data: { snoozedUntil: null } });
    invalidateDueGate();
    trackActivityAsync(actor.id, 'native_reminder_undone', { series_event_id: key.seriesEventId, source });
    return { status: 'ok', title };
  }

  // An occurrence nobody pinged has no row yet. The unique key makes a racing create a no-op.
  await prisma.nativeReminderState.createMany({ data: [key], skipDuplicates: true });

  if (action === 'done' && eachMarksDone) {
    // Everyone whose Done is awaited: those pings go to now, and the actor.
    const counted = [...new Set([...reachable.filter(isPingable).map(u => u.id), actor.id])];
    const marked = await markOwnDone(key, actor.id, counted, now);
    if (!marked) return { status: 'already_done', title };
    trackActivityAsync(actor.id, 'native_reminder_done', {
      series_event_id: key.seriesEventId, source, ...(forBoth ? { for_both: true } : {}), each_marks_done: true, completed: marked.completed,
    });
    await afterOwnDone(series, key, marked.stateId, counted, actor, title, source, marked.completed);
    return { status: 'ok', title, completed: marked.completed };
  }

  if (action === 'done') {
    const { count } = await prisma.nativeReminderState.updateMany({
      where: { ...key, doneAt: null },
      data: { doneAt: now, doneByUserId: actor.id },
    });
    if (count === 0) return { status: 'already_done', title };
    trackActivityAsync(actor.id, 'native_reminder_done', { series_event_id: key.seriesEventId, source, ...(forBoth ? { for_both: true } : {}) });
    await afterDone(series, key, recipients, forBoth, actor, title, source);
    return { status: 'ok', title };
  }

  const state = await prisma.nativeReminderState.findUnique({ where: { seriesEventId_originalStartsAt: key }, select: { id: true } });
  if (!state) return { status: 'already_done', title };
  const timeZone = await resolveUserTimezone(actor);
  const until = action === 'snoozeTomorrow' ? tomorrowMorning(now, timeZone, actor.reminderTime) : new Date(now.getTime() + SNOOZE_MS[action]);
  // The snooze is the person's own: their ping row (made here when they were never pinged).
  // lastPingedAt stays as it is (null for a never-pinged occurrence): either way it is before
  // snoozedUntil, so the pass pings at that time. pingAttempts restarts, so the re-ping the
  // user asked for gets its full retry budget. The write is conditional on the occurrence still
  // being open, as a Done is: the state row is touched (and so locked) first with that condition,
  // so a Done landing at the same moment either finishes before it (already_done) or waits for it.
  const snoozed = await prisma.$transaction(async tx => {
    const { count } = await tx.nativeReminderState.updateMany({ where: { ...key, doneAt: null }, data: { updatedAt: now } });
    if (count === 0) return false;
    // Where each marks their own Done, a person who has marked theirs is done: nothing to snooze.
    if (eachMarksDone) {
      const own = await tx.nativeReminderPing.findUnique({ where: { stateId_userId: { stateId: state.id, userId: pingUserId } }, select: { doneAt: true } });
      if (own?.doneAt) return false;
    }
    await tx.nativeReminderPing.upsert({
      where: { stateId_userId: { stateId: state.id, userId: pingUserId } },
      create: { stateId: state.id, userId: pingUserId, snoozedUntil: until, pingAttempts: 0 },
      update: { snoozedUntil: until, pingAttempts: 0 },
    });
    return true;
  });
  if (!snoozed) return { status: 'already_done', title };
  invalidateDueGate();
  trackActivityAsync(actor.id, 'native_reminder_snoozed', { series_event_id: key.seriesEventId, snooze: SNOOZE_OP[action], source });
  if (source === 'app') await editSnoozedPing(state.id, pingUserId, actor.id, title, until, action);
  return { status: 'ok', title, until, timeZone };
}

/**
 * A Done where each marks their own: the actor's ping row gets `doneAt`, and the occurrence is
 * done for everyone (`state.doneAt`, by the actor) when every person in `counted` has marked
 * theirs. All in one transaction, the state row locked first (as the snooze does), so two Dones at
 * the same moment cannot both count the other as still open: the second to take the lock sees the
 * first's Done and completes the occurrence, and only one write can (it is conditional on
 * `doneAt` still being empty). Null when the actor's own Done is already set, whether theirs or the
 * occurrence's (done for everyone before the switch went on).
 */
async function markOwnDone(key: OccurrenceKey, actorId: number, counted: number[], now: Date): Promise<{ stateId: string; completed: boolean } | null> {
  const state = await prisma.nativeReminderState.findUnique({ where: { seriesEventId_originalStartsAt: key }, select: { id: true } });
  if (!state) return null;
  const ownRow = { stateId_userId: { stateId: state.id, userId: actorId } };
  const completed = await prisma.$transaction(async tx => {
    const { count } = await tx.nativeReminderState.updateMany({ where: { ...key, doneAt: null }, data: { updatedAt: now } });
    if (count === 0) return null;
    const own = await tx.nativeReminderPing.findUnique({ where: ownRow, select: { doneAt: true } });
    if (own?.doneAt) return null;
    await tx.nativeReminderPing.upsert({
      where: ownRow,
      create: { stateId: state.id, userId: actorId, doneAt: now },
      update: { doneAt: now },
    });
    const done = new Set((await tx.nativeReminderPing.findMany({ where: { stateId: state.id, doneAt: { not: null } }, select: { userId: true } })).map(p => p.userId));
    if (!counted.every(id => done.has(id))) return false;
    const finished = await tx.nativeReminderState.updateMany({ where: { ...key, doneAt: null }, data: { doneAt: now, doneByUserId: actorId } });
    return finished.count === 1;
  });
  return completed === null ? null : { stateId: state.id, completed };
}

/**
 * An Undo where each marks their own: the actor's Done is cleared, and so is the occurrence's
 * (it is no longer done for everyone; a Done from before the switch went on goes the same way), then
 * their own snooze. False when they had not marked it. The state row is locked first, as a Done does.
 */
async function undoOwnDone(key: OccurrenceKey, pingUserId: number, now: Date): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const { count } = await tx.nativeReminderState.updateMany({ where: key, data: { updatedAt: now } });
    if (count === 0) return false;
    const own = await tx.nativeReminderPing.updateMany({ where: { userId: pingUserId, state: key, doneAt: { not: null } }, data: { doneAt: null } });
    const shared = await tx.nativeReminderState.updateMany({ where: { ...key, doneAt: { not: null } }, data: { doneAt: null, doneByUserId: null } });
    if (own.count === 0 && shared.count === 0) return false;
    // lastPingedAt stays: an occurrence that pinged does not ping again, it is open again.
    await tx.nativeReminderPing.updateMany({ where: { userId: pingUserId, state: key }, data: { snoozedUntil: null } });
    return true;
  });
}

/**
 * After a Done where each marks their own, nobody is sent a "Done by" note. The actor's own live
 * ping closes ("✅ title"; a tap on it is the callback's to edit). Each other person still to mark theirs
 * keeps their ping as it is, with its buttons, and gains "✅ Dana is done". A ping their snooze rewrote
 * is left alone: its message reads the snooze, and the ping that wakes carries the line. Once the
 * occurrence is complete, nobody else is waiting. One person's failure never costs the others, or the Done.
 */
async function afterOwnDone(
  series: Series,
  key: OccurrenceKey,
  stateId: string,
  counted: number[],
  actor: UserConfig,
  title: string,
  source: ReminderActionSource,
  completed: boolean
): Promise<void> {
  const occurrence = key.originalStartsAt.toISOString();
  try {
    const pings = await prisma.nativeReminderPing.findMany({
      where: { stateId },
      select: { userId: true, pingChatId: true, pingMessageId: true, snoozedUntil: true, lastPingedAt: true, doneAt: true },
    });
    for (const ping of pings) {
      if (!ping.pingChatId || ping.pingMessageId == null) continue;
      if (ping.userId === actor.id) {
        if (source === 'app') await editDonePing(series.id, occurrence, ping.userId, ping.pingChatId, ping.pingMessageId, actor, title, false);
        continue;
      }
      const snoozedMessage = ping.snoozedUntil !== null && (ping.lastPingedAt === null || ping.lastPingedAt < ping.snoozedUntil);
      if (completed || ping.doneAt !== null || snoozedMessage || !counted.includes(ping.userId)) continue;
      await refreshPartnerDonePing(series.id, occurrence, stateId, ping.userId, ping.pingChatId, ping.pingMessageId, actor, title);
    }
  } catch (error) {
    captureError(error, 'native-reminder-action-ping-edit', { user_id: actor.id, series_id: series.id, occurrence }, 'warning');
  }
}

/** One person's live ping, in their language, with "✅ Dana is done" and its buttons as they were. */
async function refreshPartnerDonePing(seriesId: string, occurrence: string, stateId: string, userId: number, chatId: bigint, messageId: number, doer: UserConfig, title: string): Promise<void> {
  try {
    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { language: true } });
    const language = owner?.language || 'en';
    const text = await buildPingText({ title, forBoth: true, partnerDoneName: doer.name, language });
    await refreshPing(chatId, messageId, text, await buildPingKeyboard(stateId, language));
  } catch (error) {
    console.error(`[NativeReminders] Refreshing the ping of user ${userId} for series ${seriesId}, occurrence ${occurrence} failed`);
    captureError(error, 'native-reminder-action-ping-edit', { user_id: userId, series_id: seriesId, occurrence }, 'warning');
  }
}

/** "15:40", or "Thu 09:00" for tomorrow morning, on the actor's clock. */
export function snoozeLabel(until: Date, action: SnoozeAction, language: string, timeZone: string): string {
  const time = formatInTimeZone(until, timeZone, 'HH:mm');
  if (action !== 'snoozeTomorrow') return time;
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return `${until.toLocaleDateString(locale, { weekday: 'short', timeZone })} ${time}`;
}

/**
 * A Done is shared: everyone else it concerns hears of it, once each and never the one who
 * did it. A reminder for both partners tells the other partner; a single one tells its
 * creator (today's rule), who may not be its recipient. Then the live pings of the
 * occurrence are edited, in their owners' languages: for an in-app Done, every ping
 * (the actor's own too); for a tap on a ping, the other people's (the tap edits its own).
 * One person's failure never costs the others, or the Done.
 */
async function afterDone(
  series: Series,
  key: OccurrenceKey,
  recipients: number[],
  forBoth: boolean,
  actor: UserConfig,
  title: string,
  source: ReminderActionSource
): Promise<void> {
  const noteTo = forBoth ? recipients.filter(id => id !== actor.id) : actor.id !== series.creatorUserId ? [series.creatorUserId] : [];
  const occurrence = key.originalStartsAt.toISOString();
  for (const userId of noteTo) await notifyDone(series.id, occurrence, userId, actor, title);
  try {
    const state = await prisma.nativeReminderState.findUnique({
      where: { seriesEventId_originalStartsAt: key },
      select: { pings: { select: { userId: true, pingChatId: true, pingMessageId: true } } },
    });
    for (const ping of state?.pings ?? []) {
      if (!ping.pingChatId || ping.pingMessageId == null) continue;
      // A tap on a ping edits that ping itself (callbacks.ts), so only the other partner's is left to do.
      if (source === 'ping' && (!forBoth || ping.userId === actor.id)) continue;
      await editDonePing(series.id, occurrence, ping.userId, ping.pingChatId, ping.pingMessageId, actor, title, forBoth && ping.userId !== actor.id);
    }
  } catch (error) {
    captureError(error, 'native-reminder-action-ping-edit', { user_id: actor.id, series_id: series.id, occurrence }, 'warning');
  }
}

/** The quiet "✅ Done by Dana: Buy milk". Telegram only (R12). */
async function notifyDone(seriesId: string, occurrence: string, userId: number, doer: UserConfig, title: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, language: true, telegramId: true, suspendedAt: true, unreachableSince: true },
    });
    if (!user?.telegramId || user.suspendedAt || user.unreachableSince) return;
    try {
      const text = await getBotMessage(user.language || 'en', 'nativeReminders.doneBy', {
        name: escapeHtml(doer.name),
        title: escapeHtml(title),
      });
      await getBot().sendMessage(Number(user.telegramId), text, { parse_mode: 'HTML', disable_notification: true });
    } catch (error) {
      if (!(await markUnreachableAfterSendFailure(user, error))) throw error;
    }
  } catch (error) {
    console.error(`[NativeReminders] Done note to user ${userId} for series ${seriesId}, occurrence ${occurrence} failed`);
    captureError(error, 'native-reminder-done-notice', { user_id: userId, series_id: seriesId, occurrence }, 'warning');
  }
}

/** One person's live ping after a Done: "✅ title", or "✅ Done by Dana: title" when another partner did it. */
async function editDonePing(seriesId: string, occurrence: string, userId: number, chatId: bigint, messageId: number, doer: UserConfig, title: string, byOther: boolean): Promise<void> {
  try {
    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { language: true } });
    const text = await buildDoneText({ title, doneByName: byOther ? doer.name : undefined, language: owner?.language || 'en' });
    await stripPingButtons(chatId, messageId, text);
  } catch (error) {
    console.error(`[NativeReminders] Editing the ping of user ${userId} for series ${seriesId}, occurrence ${occurrence} failed`);
    captureError(error, 'native-reminder-action-ping-edit', { user_id: userId, series_id: seriesId, occurrence }, 'warning');
  }
}

/**
 * An in-app snooze shows on that person's live ping, as a tap on its button would:
 * "💤 title · until 15:40", buttons gone. The ping is theirs, so its text is in their
 * language and clock, whoever acted. Never fails the action.
 */
async function editSnoozedPing(stateId: string, pingUserId: number, actorId: number, title: string, until: Date, action: SnoozeAction): Promise<void> {
  try {
    const row = await prisma.nativeReminderPing.findUnique({
      where: { stateId_userId: { stateId, userId: pingUserId } },
      select: { pingChatId: true, pingMessageId: true },
    });
    if (!row?.pingChatId || row.pingMessageId == null) return;
    const owner = await prisma.user.findUnique({
      where: { id: pingUserId },
      select: { id: true, language: true, location: true, googleRefreshToken: true },
    });
    const language = owner?.language || 'en';
    // The column is encrypted: the timezone lookup needs the token itself ('' when unreadable).
    const timeZone = owner ? await resolveUserTimezone({ id: owner.id, location: owner.location ?? undefined, googleRefreshToken: readStoredToken(owner.googleRefreshToken, { userId: owner.id, column: 'googleRefreshToken' }) }) : 'UTC';
    const text = await getBotMessage(language, 'nativeReminders.snoozedUntil', {
      title: escapeHtml(title),
      time: snoozeLabel(until, action, language, timeZone),
    });
    await stripPingButtons(row.pingChatId, row.pingMessageId, text);
  } catch (error) {
    captureError(error, 'native-reminder-action-ping-edit', { user_id: actorId }, 'warning');
  }
}
