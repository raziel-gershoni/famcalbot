// A reminder moved from chat (spec §7). The event store re-arms it: the state of the
// occurrences it moved is deleted, and their pings still on screen come back to the
// caller. Each of those pings is edited to say where the reminder went, without its
// buttons, which now point at a state row that no longer exists. A home edit (3b) also
// retires the pings of occurrences that no longer exist and of those now for someone else.

import { formatInTimeZone } from 'date-fns-tz';
import type { ClearedPing } from '../native-calendar/event-store';
import type { UpdateEventData } from '../calendar';
import type { CalendarEvent, UserConfig } from '../../types';
import type { UnifiedEvent } from '../calendar-provider/types';
import { getUserByTelegramId } from '../user-service';
import { getBotMessage } from '../../lib/bot-messages';
import { resolveUserTimezone } from '../../lib/timezone';
import { captureError } from '../../lib/error-capture';
import { escapeHtml } from '../../utils/html';
import { startOfLocalDay } from '../../utils/day-events';
import { isAllDayEvent } from '../../utils/event-formatter';
import { stripPingButtons } from './ping';

/**
 * Where a reminder now is, as its ping reads it: "Fri, Oct 16 10:00" on the reader's
 * clock, or "Fri, Oct 16" for a date-only one, whose day is its own (`ownZone`).
 */
export function movedWhen(startsAt: Date, allDay: boolean, language: string, readerZone: string, ownZone: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const zone = allDay ? ownZone : readerZone;
  const day = startsAt.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone });
  return allDay ? day : `${day} ${formatInTimeZone(startsAt, zone, 'HH:mm')}`;
}

/**
 * The other pings an edit retires (3b spec §3.1): those of occurrences that no longer exist
 * (a new rule, or stopping, removed them), which read "changed", and those of open
 * occurrences now for someone else, which read "⏰ <title> · now for <name>" ("now for both of you" for both partners).
 */
export interface OtherStalePings {
  changed?: ClearedPing[];
  /** `staying`: who it is still for after the change; a ping read by one of them only says it changed. */
  reassigned?: { pings: ClearedPing[]; name: string; both?: boolean; staying?: number[] };
}

/**
 * Edit each cleared ping to "⏰ <title> · moved to <when>", without buttons, and each of
 * `others` to its own copy. A ping is read by its recipient, who may be the partner: a
 * private chat's id is its user's Telegram id, so it is read in their language and on
 * their clock, else the editor's. Best-effort: the edit is already saved, so any failure
 * here (the editor's timezone lookup reads Redis) is only logged, and never fails the
 * caller's confirm.
 */
export async function stripMovedPings(
  pings: ClearedPing[],
  original: CalendarEvent,
  updates: UpdateEventData,
  editor: UserConfig,
  others?: OtherStalePings
): Promise<void> {
  const title = escapeHtml(updates.title || original.summary);
  const strip = async (ping: ClearedPing, text: (reader: UserConfig, language: string) => Promise<string>) => {
    try {
      const reader = (await getUserByTelegramId(ping.chatId)) ?? editor;
      const language = reader.language || 'en';
      await stripPingButtons(ping.chatId, ping.messageId, await text(reader, language));
    } catch (error) {
      captureError(error, 'native-reminder-moved-ping', { user_id: editor.id, chat_id: String(ping.chatId) }, 'warning');
    }
  };
  for (const ping of others?.changed ?? []) {
    await strip(ping, (_reader, language) => getBotMessage(language, 'nativeReminders.changed'));
  }
  const reassigned = others?.reassigned;
  for (const ping of reassigned?.pings ?? []) {
    await strip(ping, (reader, language) => reassigned!.staying?.includes(reader.id)
      // Still theirs (both → the partner alone, or → me, for the one it stays with): "now for <themselves>" would be wrong.
      ? getBotMessage(language, 'nativeReminders.changed')
      : reassigned!.both
        ? getBotMessage(language, 'nativeReminders.reassignedBoth', { title })
        : getBotMessage(language, 'nativeReminders.reassigned', { title, name: escapeHtml(reassigned!.name) }));
  }
  if (pings.length === 0) return;

  let editorZone: string, ownZone: string, allDay: boolean, startsAt: Date;
  try {
    editorZone = await resolveUserTimezone(editor);
    // A date-only reminder's day is read in its own timezone (native-provider toUnifiedEvent)
    ownZone = (original as Partial<UnifiedEvent>).timeZone || editorZone;
    allDay = updates.allDay ?? isAllDayEvent(original);
    startsAt = updates.startTime
      ? new Date(updates.startTime)
      : isAllDayEvent(original) ? startOfLocalDay(original.start, ownZone) : new Date(original.start);
  } catch (error) {
    captureError(error, 'native-reminder-moved-ping', { user_id: editor.id }, 'warning');
    return;
  }

  for (const ping of pings) {
    await strip(ping, async (reader, language) => {
      const readerZone = reader === editor ? editorZone : await resolveUserTimezone(reader);
      const when = movedWhen(startsAt, allDay, language, readerZone, ownZone);
      return getBotMessage(language, 'nativeReminders.moved', { title, when });
    });
  }
}
