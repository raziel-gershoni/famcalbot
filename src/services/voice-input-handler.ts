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
import { getBotMessages } from '../lib/bot-messages';

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
function formatEventDateTime(event: ParsedEvent, language: string, allDayText: string): string {
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
    return `📆 ${dateStr} (${allDayText})`;
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
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');

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

  const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay);
  const locationStr = event.location ? `\n📍 ${event.location}` : '';
  const calendarStr = event.calendarName ? `\n📁 ${event.calendarName}` : '';

  const confirmationMessage =
    `${t.voice.confirmTitle}\n\n` +
    `<b>${event.title}</b>\n` +
    `${dateTimeStr}${locationStr}${calendarStr}\n\n` +
    `<i>${t.voice.from} "${transcription}"</i>`;

  // Update message with confirmation buttons
  await bot.editMessageText(confirmationMessage, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: t.voice.createButton, callback_data: `event_create:${pendingId}` },
        { text: t.voice.cancelButton, callback_data: `event_cancel:${pendingId}` }
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

  // Get pending event
  const pending = pendingEvents.get(pendingId);

  if (!pending) {
    // Use English as fallback when we don't know user language
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

  // Remove from pending
  pendingEvents.delete(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: t.voice.cancelled });
    await bot.editMessageText(t.voice.cancelledMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  // Create the event
  if (action === 'create') {
    await bot.answerCallbackQuery(queryId, { text: t.voice.creating });

    // Update message to show progress
    await bot.editMessageText(t.voice.creatingInCalendar, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    // Check if user has refresh token
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
      const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay);
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
      // Need to upgrade OAuth scope
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
      // Token expired - need to re-authorize
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
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId, t.voice.notRegistered, { format: MessageFormat.PLAIN });
      return;
    }

    const t = await getBotMessages(user.language || 'en');
    console.log(`[Voice] User ${userId} found: ${user.name}, hasToken: ${!!user.googleRefreshToken}, voiceInputEnabled: ${user.voiceInputEnabled}`);

    // Check if voice input is enabled for this user
    if (!user.voiceInputEnabled) {
      console.log(`[Voice] Voice input disabled for user ${userId}, sending settings prompt`);
      const bot = getBot();
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${userId}`);
      await bot.sendMessage(chatId, t.voice.featureDisabled, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: t.voice.enableInSettings, web_app: { url: settingsUrl } }
          ]]
        }
      });
      return;
    }

    // Check if user has Google token
    if (!user.googleRefreshToken) {
      console.log(`[Voice] User ${userId} has no Google refresh token`);
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }

    // Send processing message
    console.log(`[Voice] Sending processing message to chat ${chatId}`);
    let processingMsg: number | string;
    try {
      processingMsg = await messagingService.sendMessage(chatId, t.voice.processing, { format: MessageFormat.PLAIN });
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
    await messagingService.updateMessage(chatId, processingMsgId, t.voice.transcribing, { format: MessageFormat.PLAIN });

    // Transcribe the voice message
    const transcription = await transcribeVoice(audioBuffer, user.language || 'en');

    if (!transcription.text || transcription.text.trim() === '') {
      await messagingService.updateMessage(chatId, processingMsgId, t.voice.transcriptionFailed, { format: MessageFormat.PLAIN });
      return;
    }

    // Update progress
    await messagingService.updateMessage(chatId, processingMsgId, t.voice.understanding, { format: MessageFormat.PLAIN });

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
          `${t.voice.iHeard} "<i>${transcription.text}</i>"\n\n` +
          `❓ ${parseResult.clarificationQuestion}`,
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.updateMessage(chatId, processingMsgId,
          `${t.voice.notUnderstood}\n\n` +
          `${t.voice.iHeard} "<i>${transcription.text}</i>"\n\n` +
          `${t.voice.tryExamples}\n` +
          `• "${t.voice.example1}"\n` +
          `• "${t.voice.example2}"\n` +
          `• "${t.voice.example3}"`,
          { format: MessageFormat.HTML }
        );
      }
      return;
    }

    // Show confirmation with inline keyboard
    await showEventConfirmation(chatId, processingMsgId, parseResult.event, transcription.text, user);

  } catch (error) {
    console.error('[Voice] Error handling voice message:', error);

    const t = await getBotMessages('en');
    await messagingService.sendMessage(chatId, t.voice.genericError, { format: MessageFormat.PLAIN });
  }
}
