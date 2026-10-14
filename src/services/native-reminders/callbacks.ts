// ✅ Done and 💤 Snooze on a native reminder ping (spec §5).
//
// The buttons never expire. A tap can come days later, after the reminder was
// moved, deleted or marked done, or after the pair unlinked, so every tap reads
// the state row and its series afresh and checks who is tapping. Every tap is
// answered exactly once, and nothing here throws: an error would fail the
// webhook with a 500, and Telegram would deliver the same tap again and again.

import type TelegramBot from 'node-telegram-bot-api';
import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../../utils/prisma';
import { getBot } from '../telegram/bot';
import { getUserByTelegramId } from '../user-service';
import { getBotMessage } from '../../lib/bot-messages';
import { resolveUserTimezone } from '../../lib/timezone';
import { captureError } from '../../lib/error-capture';
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

type NativeReminderOp = 'd' | 's15' | 's60' | 'st';
type SnoozeOp = Exclude<NativeReminderOp, 'd'>;

// nr:<op>:<state row id>, as ping.ts builds it; the webhook routes on the same `nr:`.
// Telegram caps callback data at 64 bytes, and `nr:s15:` leaves 57.
const CALLBACK_DATA = /^nr:(d|s15|s60|st):([A-Za-z0-9_-]{1,57})$/;

const SNOOZE_MS = { s15: 15 * 60 * 1000, s60: 60 * 60 * 1000 } as const;

export function parseNativeReminderCallback(data: string): { op: NativeReminderOp; stateId: string } | null {
  const match = CALLBACK_DATA.exec(data);
  return match ? { op: match[1] as NativeReminderOp, stateId: match[2] } : null;
}

/**
 * Handle a tap on a ping's button. `now` is for smoke scripts. The toast carries
 * the outcome, so the callback is answered once the outcome is known, in a finally:
 * exactly once, whatever happens in between.
 */
export async function handleNativeReminderCallback(
  query: TelegramBot.CallbackQuery,
  now: Date = new Date()
): Promise<void> {
  let toast: string | undefined;
  try {
    toast = await handleTap(query, now);
  } catch (error) {
    captureError(error, 'native-reminder-callback', { user_id: query.from.id, callback_data: query.data });
  } finally {
    await answer(query.id, toast);
  }
}

type Say = (key: string, params?: Record<string, string>) => Promise<string>;
type PingMessage = { chatId: number; messageId: number };

/** What a tap does. Returns the toast, or undefined when the edited ping says it all. */
async function handleTap(query: TelegramBot.CallbackQuery, now: Date): Promise<string | undefined> {
  const parsed = parseNativeReminderCallback(query.data ?? '');
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!parsed || chatId === undefined || messageId === undefined) return undefined;
  const ping: PingMessage = { chatId, messageId };

  const tapper = await getUserByTelegramId(query.from.id);
  const language = tapper?.language || 'en';
  const say: Say = (key, params) => getBotMessage(language, `nativeReminders.${key}`, params);

  const state = await loadTap(parsed.stateId);
  const title = state && liveOccurrenceTitle(state);
  if (!state || !title) {
    await removeButtons(ping);
    return say('changed');
  }

  // The effective owner or the creator may tap (spec §2).
  const series = state.seriesEvent;
  if (!tapper) return say('notYours');
  const creatorPartner = await getActivePartnerSummary(series.creatorUserId, series.creator.pairingId);
  if (tapper.id !== effectiveOwnerId(series, creatorPartner) && tapper.id !== series.creatorUserId) {
    // It was theirs when it pinged them. Since then the pair unlinked, or they moved
    // to Google, and it is the creator's again.
    if (tapper.id === series.forUserId) {
      await removeButtons(ping);
      return say('changed');
    }
    return say('notYours');
  }

  return parsed.op === 'd'
    ? markDone(state, title, tapper, ping, say, now)
    : snooze(state, title, parsed.op, tapper, ping, say, now);
}

/** The state row behind a button, with what re-validation and the replies need. */
function loadTap(stateId: string) {
  return prisma.nativeReminderState.findUnique({
    where: { id: stateId },
    include: {
      seriesEvent: {
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
      },
    },
  });
}

type TapState = NonNullable<Awaited<ReturnType<typeof loadTap>>>;

/**
 * The title of the occurrence a state row names, or null when its buttons no longer
 * apply: the series was deleted or is no longer a reminder, its calendar was deleted,
 * or the occurrence was cancelled, exdated or cut off by a "following" edit. A time
 * change deletes the row itself (the event store's re-arm). The occurrence is looked
 * up by its key alone, so one moved to another time is still found.
 */
function liveOccurrenceTitle(state: TapState): string | null {
  const series = state.seriesEvent;
  if (series.isDeleted || series.calendar.isDeleted || series.kind !== 'REMINDER') return null;
  const key = state.originalStartsAt.getTime();
  const override = series.instances.find(o => o.originalStartsAt.getTime() === key);
  if (override?.status === 'CANCELLED') return null;
  const slot = expandSeries(series, { from: state.originalStartsAt, to: new Date(key + 1) });
  if (!slot.some(occurrence => occurrence.instanceStartsAt.getTime() === key)) return null;
  return override?.title ?? series.title;
}

/** ✅ Done, once. When the owner is not the creator, the creator hears about it. */
async function markDone(
  state: TapState, title: string, tapper: UserConfig, ping: PingMessage, say: Say, now: Date
): Promise<string | undefined> {
  const { count } = await prisma.nativeReminderState.updateMany({
    where: { id: state.id, doneAt: null },
    data: { doneAt: now, doneByUserId: tapper.id },
  });
  await editPing(ping, await say('done', { title: escapeHtml(title) }));
  if (count === 0) return say('alreadyDone');

  trackActivityAsync(tapper.id, 'native_reminder_done', { series_event_id: state.seriesEventId });
  if (tapper.id !== state.seriesEvent.creatorUserId) await notifyCreator(state.seriesEvent.creator, tapper, title);
  return undefined;
}

/** 💤 Snooze for 15 minutes, an hour, or until tomorrow 09:00 on the tapper's clock (R6). */
async function snooze(
  state: TapState, title: string, op: SnoozeOp, tapper: UserConfig, ping: PingMessage, say: Say, now: Date
): Promise<string | undefined> {
  const timeZone = await resolveUserTimezone(tapper);
  const until = op === 'st' ? tomorrowMorning(now, timeZone) : new Date(now.getTime() + SNOOZE_MS[op]);
  // lastPingedAt stays as it is: it is now before snoozedUntil, so the pass pings again then.
  // pingAttempts restarts, so the re-ping the user asked for gets its full retry budget.
  const { count } = await prisma.nativeReminderState.updateMany({
    where: { id: state.id, doneAt: null },
    data: { snoozedUntil: until, pingAttempts: 0 },
  });
  if (count === 0) {
    await editPing(ping, await say('done', { title: escapeHtml(title) }));
    return say('alreadyDone');
  }

  invalidateDueGate();
  const time = snoozeLabel(until, op, tapper.language || 'en', timeZone);
  await editPing(ping, await say('snoozedUntil', { title: escapeHtml(title), time }));
  trackActivityAsync(tapper.id, 'native_reminder_snoozed', { snooze: op });
  return undefined;
}

/** "15:40", or "Thu 09:00" for tomorrow morning, on the tapper's clock. */
function snoozeLabel(until: Date, op: SnoozeOp, language: string, timeZone: string): string {
  const time = formatInTimeZone(until, timeZone, 'HH:mm');
  if (op !== 'st') return time;
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return `${until.toLocaleDateString(locale, { weekday: 'short', timeZone })} ${time}`;
}

/** The creator's quiet "✅ Done by Dana: Buy milk". Telegram only (R12). */
async function notifyCreator(
  creator: TapState['seriesEvent']['creator'], doer: UserConfig, title: string
): Promise<void> {
  if (!creator.telegramId || creator.suspendedAt || creator.unreachableSince) return;
  const text = await getBotMessage(creator.language || 'en', 'nativeReminders.doneBy', {
    name: escapeHtml(doer.name),
    title: escapeHtml(title),
  });
  try {
    await getBot().sendMessage(Number(creator.telegramId), text, { parse_mode: 'HTML', disable_notification: true });
  } catch (error) {
    if (isUnreachableError(error)) await markUserUnreachable(creator.id, describeDeliveryError(error));
    else captureError(error, 'native-reminder-done-notice', { user_id: creator.id }, 'warning');
  }
}

/** Show the outcome on the ping and drop its buttons. A failed edit must not cost the answer. */
async function editPing(ping: PingMessage, text: string): Promise<void> {
  try {
    await stripPingButtons(ping.chatId, ping.messageId, text);
  } catch (error) {
    captureError(error, 'native-reminder-callback-edit', { chat_id: ping.chatId }, 'warning');
  }
}

/** Drop a stale ping's buttons and leave its text as it was. */
async function removeButtons(ping: PingMessage): Promise<void> {
  try {
    await getBot().editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ping.chatId, message_id: ping.messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('message is not modified') || message.includes('message to edit not found')) return;
    captureError(error, 'native-reminder-callback-edit', { chat_id: ping.chatId }, 'warning');
  }
}

/** Answer the tap. It fails harmlessly when the tap waited too long ("query is too old"). */
async function answer(queryId: string, text?: string): Promise<void> {
  try {
    await getBot().answerCallbackQuery(queryId, text ? { text } : undefined);
  } catch (error) {
    console.warn('[NativeReminders] Could not answer a button tap:', error instanceof Error ? error.message : error);
  }
}
