/**
 * Voice callback handlers
 * Processes user confirmation/cancellation of event creation, editing, and deletion
 */

import { getBot } from '../telegram';
import { buildRecurrenceRule } from '../calendar';
import { getProviderForUser } from '../calendar-provider';
import type { CreateEventResult, UpdateEventResult, DeleteEventResult } from '../calendar-provider';
import { buildUrl } from '../../config/urls';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync } from '../analytics-service';
import { captureError } from '../../lib/error-capture';
import { incrementUsage } from '../subscription-service';
import { trackCreatedEvent } from './event-resolution';
import { resolveUserTimezone } from '../../lib/timezone';
import {
  getPendingEvent,
  removePendingEvent,
  getPendingEdit,
  removePendingEdit,
  getPendingDelete,
  removePendingDelete,
  formatEventDateTime,
} from './confirmations';

/**
 * Handle event creation callback (when user clicks Create or Cancel)
 */
export async function handleEventCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  const bot = getBot();

  const pending = await getPendingEvent(pendingId);

  if (!pending) {
    const t = await getBotMessages('en');
    await bot.answerCallbackQuery(queryId, { text: t.voice.expired });
    await bot.editMessageText(t.voice.expiredMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  const { event, user } = pending;
  const t = await getBotMessages(user.language || 'en');

  await removePendingEvent(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: t.voice.cancelled });
    await bot.editMessageText(t.voice.cancelledMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  if (action === 'create') {
    await bot.answerCallbackQuery(queryId, { text: t.voice.creating });

    await bot.editMessageText(t.voice.creatingInCalendar, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    if (user.calendarSource === 'GOOGLE' && !user.googleRefreshToken) {
      await bot.editMessageText(
        `${t.voice.notConnected}\n\n${t.voice.connectFirst}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    const provider = getProviderForUser(user);
    const result: CreateEventResult = await provider.createEvent(
      user,
      event.calendarId || 'primary',
      {
        title: event.title,
        startTime: event.startTime,
        endTime: event.endTime,
        location: event.location,
        description: event.description,
        allDay: event.allDay,
        recurrence: buildRecurrenceRule(event.recurrence)
      }
    );

    if (result.success) {
      if (result.eventId) {
        trackCreatedEvent(user.telegramId!, result.eventId, event.calendarId || 'primary', event)
          .catch(err => captureError(err, 'voice-track-event', { user_id: user.id }, 'warning'));

        // Recent-events: feed the sliding window so follow-ups like "move it"
        // resolve via by_description against the most recent CRUD (PR 9).
        const { pushRecentEvent } = await import('./recent-events-store');
        const calId = event.calendarId || 'primary';
        await pushRecentEvent(user.id, {
          provider: calId.startsWith('native:') ? 'native' : 'google',
          calendarId: calId,
          eventId: result.eventId,
          title: event.title,
          startsAt: event.startTime.toISOString(),
          endsAt: event.endTime.toISOString(),
          action: 'create',
        });
      }

      // PR 12: voice-in → voice-out. Mirror modality on the success outcome.
      if (pending.inputModality === 'voice') {
        const { speakOutcome, formatOutcomeLine } = await import('./tts-outcome');
        const { getMessagingService } = await import('../telegram/bot');
        const line = formatOutcomeLine('created', event.title, user.language || 'en');
        speakOutcome(chatId, line, user, getMessagingService()).catch(() => {});
      }

      trackActivityAsync(user.id, 'voice_event_created', {
        calendar_id: event.calendarId || 'primary',
      });
      incrementUsage(user.id, 'voiceEvents').catch(err =>
        console.error('[Subscription] Failed to increment voice events:', err)
      );

      const timezone = await resolveUserTimezone(user);
      const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone);
      const linkButton = result.eventLink
        ? `\n\n<a href="${result.eventLink}">${t.voice.openInCalendar}</a>`
        : '';

      await bot.editMessageText(
        `${t.voice.created}\n\n` +
        `<b>${event.title}</b>\n` +
        `${dateTimeStr}${linkButton}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );
    } else if (result.error === 'PERMISSION_DENIED') {
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        `${t.voice.permissionRequired}\n\n${t.voice.permissionMessage}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice.grantAccess, web_app: { url: upgradeUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'TOKEN_EXPIRED') {
      const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        `${t.voice.accessExpired}\n\n${t.voice.accessExpiredMessage}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice.reauthorize, web_app: { url: refreshUrl } }
            ]]
          }
        }
      );
    } else {
      await bot.editMessageText(
        `${t.voice.failedToCreate}\n\n${result.errorMessage || t.voice.unknownError}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    }
  }
}

/**
 * Handle edit callback (when user clicks Confirm Edit or Cancel)
 */
export async function handleEditCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  const bot = getBot();

  const pending = await getPendingEdit(pendingId);

  if (!pending) {
    const t = await getBotMessages('en');
    await bot.answerCallbackQuery(queryId, { text: t.voice?.expired || 'Request expired' });
    await bot.editMessageText(t.voice?.expiredMessage || '⏰ This request has expired.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  const { originalEvent, calendarId, updates, user, scope } = pending;
  const t = await getBotMessages(user.language || 'en');

  await removePendingEdit(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.cancelled || 'Cancelled' });
    await bot.editMessageText(t.voice?.cancelledMessage || '❌ Edit cancelled.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  if (action === 'confirm') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.updating || 'Updating...' });

    await bot.editMessageText(t.voice?.updatingEvent || '⏳ Updating event...', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    if (user.calendarSource === 'GOOGLE' && !user.googleRefreshToken) {
      await bot.editMessageText(
        `${t.voice?.notConnected || '❌ Not connected'}\n\n${t.voice?.connectFirst || 'Please connect your calendar first.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    const eventId = originalEvent.eventId;
    if (!eventId) {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Could not find the event to update.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    const provider = getProviderForUser(user);
    const result: UpdateEventResult = await provider.updateEvent(
      user,
      calendarId,
      eventId,
      {
        ...updates,
        scope: scope,
        recurringEventId: originalEvent.recurringEventId,
      }
    );

    if (result.success) {
      const linkButton = result.eventLink
        ? `\n\n<a href="${result.eventLink}">${t.voice?.openInCalendar || 'Open in Calendar'}</a>`
        : '';

      const editedMsg = t.voice?.edited || '✅ <b>Event updated!</b>';

      await bot.editMessageText(
        `${editedMsg}\n\n` +
        `📅 ${updates.title || originalEvent.summary}${linkButton}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );

      // Recent-events: refresh the sliding window with the edited event (PR 9).
      const { pushRecentEvent } = await import('./recent-events-store');
      await pushRecentEvent(user.id, {
        provider: calendarId.startsWith('native:') ? 'native' : 'google',
        calendarId,
        eventId: originalEvent.eventId || '',
        recurringEventId: originalEvent.recurringEventId,
        title: updates.title || originalEvent.summary,
        startsAt: (updates.startTime ?? new Date(originalEvent.start)).toISOString(),
        endsAt: (updates.endTime ?? new Date(originalEvent.end)).toISOString(),
        action: 'edit',
      });
    } else if (result.error === 'PERMISSION_DENIED') {
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.permissionRequired || '🔐 Permission required'}\n\n${t.voice?.permissionMessage || 'Please grant calendar write access.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.grantAccess || 'Grant Access', web_app: { url: upgradeUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'TOKEN_EXPIRED') {
      const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.accessExpired || '🔑 Access expired'}\n\n${t.voice?.accessExpiredMessage || 'Please re-authorize.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.reauthorize || 'Re-authorize', web_app: { url: refreshUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'NOT_FOUND') {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Event not found. It may have been deleted.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    } else {
      await bot.editMessageText(
        `${t.voice?.failedToUpdate || '❌ Failed to update event'}\n\n${result.errorMessage || t.voice?.unknownError || 'Unknown error'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    }
  }
}

/**
 * Handle delete callback (when user clicks Delete or Keep)
 */
export async function handleDeleteCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  const bot = getBot();

  const pending = await getPendingDelete(pendingId);

  if (!pending) {
    const t = await getBotMessages('en');
    await bot.answerCallbackQuery(queryId, { text: t.voice?.expired || 'Request expired' });
    await bot.editMessageText(t.voice?.expiredMessage || '⏰ This request has expired.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  const { event, calendarId, user, scope } = pending;
  const t = await getBotMessages(user.language || 'en');

  await removePendingDelete(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.kept || 'Kept' });
    await bot.editMessageText(t.voice?.keptMessage || '✅ Event kept.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  if (action === 'confirm') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.deleting || 'Deleting...' });

    await bot.editMessageText(t.voice?.deletingEvent || '⏳ Deleting event...', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    if (user.calendarSource === 'GOOGLE' && !user.googleRefreshToken) {
      await bot.editMessageText(
        `${t.voice?.notConnected || '❌ Not connected'}\n\n${t.voice?.connectFirst || 'Please connect your calendar first.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    const eventId = event.eventId;
    if (!eventId) {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Could not find the event to delete.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    const provider = getProviderForUser(user);
    const result: DeleteEventResult = await provider.deleteEvent(
      user,
      calendarId,
      eventId,
      { scope: scope, recurringEventId: event.recurringEventId }
    );

    if (result.success) {
      const deletedMsg = t.voice?.deleted || '✅ <b>Event deleted!</b>';
      await bot.editMessageText(
        `${deletedMsg}\n\n` +
        `📅 <s>${event.summary}</s>`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );

      // Recent-events: drop the deleted event from the sliding window so the
      // user doesn't see "the meeting" resolve to a tombstone (PR 9).
      const { removeRecentEvent, pushRecentEvent } = await import('./recent-events-store');
      if (event.eventId) {
        await removeRecentEvent(user.id, event.eventId);
        // Also push a 'delete' marker so any follow-up "undo" / "actually keep
        // it" has provenance. Cheap; same window.
        await pushRecentEvent(user.id, {
          provider: calendarId.startsWith('native:') ? 'native' : 'google',
          calendarId,
          eventId: event.eventId,
          recurringEventId: event.recurringEventId,
          title: event.summary,
          startsAt: event.start,
          endsAt: event.end,
          action: 'delete',
        });
      }
    } else if (result.error === 'PERMISSION_DENIED') {
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.permissionRequired || '🔐 Permission required'}\n\n${t.voice?.permissionMessage || 'Please grant calendar write access.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.grantAccess || 'Grant Access', web_app: { url: upgradeUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'TOKEN_EXPIRED') {
      const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.accessExpired || '🔑 Access expired'}\n\n${t.voice?.accessExpiredMessage || 'Please re-authorize.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.reauthorize || 'Re-authorize', web_app: { url: refreshUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'NOT_FOUND') {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Event not found. It may have already been deleted.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    } else {
      await bot.editMessageText(
        `${t.voice?.failedToDelete || '❌ Failed to delete event'}\n\n${result.errorMessage || t.voice?.unknownError || 'Unknown error'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    }
  }
}

/**
 * PR 10: Voice Undo callback — handles the "↩️ Undo (30s)" button shown after
 * a HIGH-confidence auto-created event. Looks up the undo token, deletes the
 * event via the provider, and replaces the success message with a confirmation.
 *
 * Idempotent on the user side: an expired or already-consumed token is treated
 * as a no-op with a friendly message.
 */
export async function handleVoiceUndoCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  token: string,
  callbackUserId: number
): Promise<void> {
  const bot = await getBot();
  await bot.answerCallbackQuery(queryId, { text: '⏳' });

  const { getUserByTelegramId } = await import('../user-service');
  const user = await getUserByTelegramId(callbackUserId);
  if (!user) return;
  const t = await getBotMessages(user.language || 'en');

  const { handleUndoCallback } = await import('./auto-create');
  const result = await handleUndoCallback(user, token);

  if (result.ok) {
    await bot.editMessageText(t.voice?.undone || '↩️ <b>Event removed.</b>', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
  } else if (result.reason === 'expired') {
    await bot.editMessageText(t.voice?.undoExpired || '⌛ Undo window expired — event kept.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
  } else {
    await bot.editMessageText(t.voice?.undoFailed || '❌ Could not undo. Try editing or deleting from the calendar.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
  }
}

/**
 * PR 11: Bulk multi-event confirmation callback. Confirms or cancels the
 * entire batch shown in showBulkConfirmation.
 */
export async function handleBulkCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: 'confirm' | 'cancel',
  pendingId: string
): Promise<void> {
  const bot = getBot();
  await bot.answerCallbackQuery(queryId, { text: '⏳' });

  if (action === 'cancel') {
    const { handleBulkCancel } = await import('./bulk-confirmations');
    const user = await handleBulkCancel(pendingId);
    const t = await getBotMessages(user?.language || 'en');
    await bot.editMessageText(t.voice?.bulkCancelled || '❌ Batch cancelled.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
    return;
  }

  // confirm
  try {
    const { handleBulkConfirmAll } = await import('./bulk-confirmations');
    const result = await handleBulkConfirmAll(pendingId);
    const t = await getBotMessages(result.user.language || 'en');
    let summary: string;
    if (result.failureCount === 0) {
      summary = (t.voice?.bulkAllCreated || '✅ Created {count} events.').replace('{count}', String(result.successCount));
    } else if (result.successCount === 0) {
      summary = (t.voice?.bulkAllFailed || '❌ Could not create the events. Please re-dictate.');
    } else {
      const partialMsg = t.voice?.bulkPartial || '⚠️ Created {ok} of {total}. Failures:\n{errors}';
      summary = partialMsg
        .replace('{ok}', String(result.successCount))
        .replace('{total}', String(result.successCount + result.failureCount))
        .replace('{errors}', result.failureMessages.map((e) => `• ${e}`).join('\n'));
    }
    await bot.editMessageText(summary, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
  } catch (err) {
    const t = await getBotMessages('en');
    if (err instanceof Error && err.message === 'bulk_pending_expired') {
      await bot.editMessageText(t.voice?.expiredMessage || '⏰ This confirmation has expired.', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
      });
      return;
    }
    captureError(err, 'voice-bulk-callback');
    await bot.editMessageText(t.voice?.unknownError || '❌ Something went wrong.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
  }
}
