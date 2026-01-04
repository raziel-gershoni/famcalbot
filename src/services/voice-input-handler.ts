/**
 * Voice Input Handler
 * Handles incoming voice messages from Telegram for event creation
 */

import { getBot, getMessagingService } from './telegram';
import { getUserByTelegramId } from './user-service';
import { MessageFormat } from './messaging/types';
import { transcribeVoice } from './transcription';
import { parseEventFromText, ParsedEvent } from './event-parser';
import { createEvent, CreateEventResult } from './calendar';
import { TIMEZONE } from '../config/constants';
import { buildUrl } from '../config/urls';
import { UserConfig } from '../types';

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

/**
 * Download voice file from Telegram CDN
 * @param fileId - Telegram file_id
 * @returns Buffer containing the audio data
 */
async function downloadVoiceFile(fileId: string): Promise<Buffer> {
  const bot = getBot();

  // Get file info from Telegram
  const fileInfo = await bot.getFile(fileId);
  const filePath = fileInfo.file_path;

  if (!filePath) {
    throw new Error('Could not get file path from Telegram');
  }

  // Construct download URL
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  // Download the file
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download voice file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Store pending events for confirmation (in-memory, short-lived)
// In production, this could use Redis or database
const pendingEvents: Map<string, { event: ParsedEvent; user: UserConfig; transcription: string }> = new Map();

/**
 * Format event date/time for display
 */
function formatEventDateTime(event: ParsedEvent, language: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: TIMEZONE
  };

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  };

  const dateStr = event.startTime.toLocaleDateString(locale, dateOptions);
  const startTimeStr = event.startTime.toLocaleTimeString(locale, timeOptions);
  const endTimeStr = event.endTime.toLocaleTimeString(locale, timeOptions);

  if (event.allDay) {
    return `📆 ${dateStr} (All day)`;
  }

  return `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
}

/**
 * Show event confirmation with inline keyboard
 */
async function showEventConfirmation(
  chatId: number,
  messageId: number,
  event: ParsedEvent,
  transcription: string,
  user: UserConfig
): Promise<void> {
  const messagingService = getMessagingService();
  const bot = getBot();

  // Generate unique ID for this pending event
  const pendingId = `${chatId}:${Date.now()}`;

  // Store pending event
  pendingEvents.set(pendingId, { event, user, transcription });

  // Clean up old pending events (older than 10 minutes)
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, value] of pendingEvents.entries()) {
    const timestamp = parseInt(key.split(':')[1]);
    if (timestamp < tenMinutesAgo) {
      pendingEvents.delete(key);
    }
  }

  const dateTimeStr = formatEventDateTime(event, user.language || 'en');
  const locationStr = event.location ? `\n📍 ${event.location}` : '';
  const calendarStr = event.calendarName ? `\n📁 ${event.calendarName}` : '';

  const confirmationMessage =
    `📅 <b>Create this event?</b>\n\n` +
    `<b>${event.title}</b>\n` +
    `${dateTimeStr}${locationStr}${calendarStr}\n\n` +
    `<i>From: "${transcription}"</i>`;

  // Update message with confirmation buttons
  await bot.editMessageText(confirmationMessage, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Create', callback_data: `event_create:${pendingId}` },
        { text: '❌ Cancel', callback_data: `event_cancel:${pendingId}` }
      ]]
    }
  });
}

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
  const messagingService = getMessagingService();

  // Get pending event
  const pending = pendingEvents.get(pendingId);

  if (!pending) {
    await bot.answerCallbackQuery(queryId, { text: 'This event has expired. Please try again.' });
    await bot.editMessageText('❌ This event confirmation has expired. Please send a new voice message.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  // Remove from pending
  pendingEvents.delete(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: 'Event cancelled' });
    await bot.editMessageText('❌ Event creation cancelled.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  // Create the event
  if (action === 'create') {
    await bot.answerCallbackQuery(queryId, { text: 'Creating event...' });

    // Update message to show progress
    await bot.editMessageText('⏳ Creating event in Google Calendar...', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    const { event, user } = pending;

    // Check if user has refresh token
    if (!user.googleRefreshToken) {
      await bot.editMessageText(
        '❌ Your Google Calendar is not connected.\n\n' +
        'Please connect your calendar first.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // Create the event
    const result: CreateEventResult = await createEvent(
      user.googleRefreshToken,
      event.calendarId || 'primary',
      {
        title: event.title,
        startTime: event.startTime,
        endTime: event.endTime,
        location: event.location,
        description: event.description,
        allDay: event.allDay
      }
    );

    if (result.success) {
      const dateTimeStr = formatEventDateTime(event, user.language || 'en');
      const linkButton = result.eventLink
        ? `\n\n<a href="${result.eventLink}">Open in Google Calendar</a>`
        : '';

      await bot.editMessageText(
        `✅ <b>Event created!</b>\n\n` +
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
      // Need to upgrade OAuth scope
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        '🔐 <b>Permission Required</b>\n\n' +
        'To create events, I need permission to write to your calendar.\n\n' +
        'Please tap the button below to grant access:',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔑 Grant Calendar Access', web_app: { url: upgradeUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'TOKEN_EXPIRED') {
      // Token expired - need to re-authorize
      const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        '🔑 <b>Calendar Access Expired</b>\n\n' +
        'Your Google Calendar access has expired.\n\n' +
        'Please tap the button below to re-authorize:',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔄 Re-authorize Calendar', web_app: { url: refreshUrl } }
            ]]
          }
        }
      );
    } else {
      await bot.editMessageText(
        `❌ <b>Failed to create event</b>\n\n` +
        `${result.errorMessage || 'Unknown error occurred.'}`,
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
 * Handle incoming voice message for event creation
 * @param chatId - Telegram chat ID
 * @param userId - Telegram user ID
 * @param voice - Voice message data from Telegram
 * @param from - Telegram user info
 */
export async function handleVoiceMessage(
  chatId: number,
  userId: number,
  voice: TelegramVoice,
  from: TelegramUser
): Promise<void> {
  console.log(`[Voice] Starting voice handler for user ${userId}`);
  const messagingService = getMessagingService();

  try {
    // Get user from database
    console.log(`[Voice] Looking up user ${userId} in database`);
    const user = await getUserByTelegramId(userId);

    if (!user) {
      console.log(`[Voice] User ${userId} not found in database`);
      await messagingService.sendMessage(chatId,
        '❌ Please use /start to register first before creating events.',
        { format: MessageFormat.PLAIN }
      );
      return;
    }

    console.log(`[Voice] User ${userId} found: ${user.name}, hasToken: ${!!user.googleRefreshToken}`);

    // Check if user has Google token
    if (!user.googleRefreshToken) {
      console.log(`[Voice] User ${userId} has no Google refresh token`);
      await messagingService.sendMessage(chatId,
        '❌ Please connect your Google Calendar first to create events.',
        { format: MessageFormat.PLAIN }
      );
      return;
    }

    // Send processing message
    console.log(`[Voice] Sending processing message to chat ${chatId}`);
    let processingMsg: number | string;
    try {
      processingMsg = await messagingService.sendMessage(chatId,
        '🎤 Processing your voice message...',
        { format: MessageFormat.PLAIN }
      );
      console.log(`[Voice] Processing message sent, id: ${processingMsg}`);
    } catch (sendError) {
      console.error(`[Voice] Failed to send processing message:`, sendError);
      throw sendError;
    }
    const processingMsgId = typeof processingMsg === 'number' ? processingMsg : parseInt(processingMsg);

    // Download the voice file
    console.log(`[Voice] Downloading voice file for user ${userId}, file_id: ${voice.file_id}, duration: ${voice.duration}s`);
    const audioBuffer = await downloadVoiceFile(voice.file_id);
    console.log(`[Voice] Downloaded ${audioBuffer.length} bytes`);

    // Update progress
    await messagingService.updateMessage(chatId, processingMsgId,
      '🎤 Transcribing your voice...',
      { format: MessageFormat.PLAIN }
    );

    // Transcribe the voice message
    const transcription = await transcribeVoice(audioBuffer, user.language || 'en');

    if (!transcription.text || transcription.text.trim() === '') {
      await messagingService.updateMessage(chatId, processingMsgId,
        '❌ I couldn\'t understand the voice message. Please try again or speak more clearly.',
        { format: MessageFormat.PLAIN }
      );
      return;
    }

    // Update progress
    await messagingService.updateMessage(chatId, processingMsgId,
      '📅 Understanding your event...',
      { format: MessageFormat.PLAIN }
    );

    // Parse the transcription into event details
    const parseResult = await parseEventFromText(
      transcription.text,
      user.language || 'en',
      user.calendarAssignments || []
    );

    if (!parseResult.success || !parseResult.event) {
      // Check if we need clarification
      if (parseResult.needsClarification && parseResult.clarificationQuestion) {
        await messagingService.updateMessage(chatId, processingMsgId,
          `🎤 I heard: "<i>${transcription.text}</i>"\n\n` +
          `❓ ${parseResult.clarificationQuestion}`,
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.updateMessage(chatId, processingMsgId,
          `❌ I couldn't understand that as a calendar event.\n\n` +
          `I heard: "<i>${transcription.text}</i>"\n\n` +
          `Please try saying something like:\n` +
          `• "Meeting with David tomorrow at 3pm"\n` +
          `• "Dentist appointment on Friday at 10am"\n` +
          `• "Lunch with Sarah next Tuesday at noon"`,
          { format: MessageFormat.HTML }
        );
      }
      return;
    }

    // Show confirmation with inline keyboard
    await showEventConfirmation(chatId, processingMsgId, parseResult.event, transcription.text, user);

  } catch (error) {
    console.error('[Voice] Error handling voice message:', error);

    await messagingService.sendMessage(chatId,
      '❌ Sorry, I had trouble processing your voice message. Please try again.',
      { format: MessageFormat.PLAIN }
    );
  }
}
