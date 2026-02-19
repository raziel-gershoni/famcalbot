/**
 * Voice callback handlers
 * Processes user confirmation/cancellation of event creation, editing, and deletion
 */

import { getBot } from '../telegram';
import { createEvent, CreateEventResult, updateEvent, UpdateEventResult, deleteEvent, DeleteEventResult, buildRecurrenceRule } from '../calendar';
import { buildUrl } from '../../config/urls';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync } from '../analytics-service';
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

    if (!user.googleRefreshToken) {
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

    const result: CreateEventResult = await createEvent(
      user.googleRefreshToken,
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
        trackCreatedEvent(user.telegramId, result.eventId, event.calendarId || 'primary', event)
          .catch(err => console.error('[Voice] Failed to track created event:', err));
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

    if (!user.googleRefreshToken) {
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

    const result: UpdateEventResult = await updateEvent(
      user.googleRefreshToken,
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

    if (!user.googleRefreshToken) {
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

    const result: DeleteEventResult = await deleteEvent(
      user.googleRefreshToken,
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
