/**
 * Voice message handler - main entry point
 * Orchestrates voice message processing: auth → feature check → download → gemini direct audio → route
 */

import { getBot, getMessagingService } from '../telegram';
import { getUserByTelegramId } from '../user-service';
import { MessageFormat } from '../messaging/types';
import { VoiceIntentResult } from '../event-parser';
import { processVoiceWithGemini } from './gemini-voice';
import { fetchEventsInRange, CalendarEvent } from '../calendar';
import { resolveUserTimezone } from '../../lib/timezone';
import { buildUrl } from '../../config/urls';
import { UserConfig } from '../../types';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb, setUserContext } from '../analytics-service';
import { checkFeatureAccess } from '../subscription-service';
import { downloadVoiceFile, getLastCreatedEvent, findMatchingEvent, convertEditRequestToUpdates } from './event-resolution';
import { showEventConfirmation, showEditConfirmation, showDeleteConfirmation } from './confirmations';

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
 * Handle EDIT intent - find event and show edit confirmation
 */
async function handleEditIntent(
  chatId: number,
  messageId: number,
  intentResult: VoiceIntentResult,
  transcription: string,
  user: UserConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  adminFooter?: string
): Promise<void> {
  const messagingService = getMessagingService();

  if (!user.googleRefreshToken) {
    await messagingService.updateMessage(chatId, messageId, t.voice?.noCalendar || 'Calendar not connected.', { format: MessageFormat.PLAIN });
    return;
  }

  let targetEvent: CalendarEvent | undefined;
  let targetCalendarId: string | undefined;

  if (intentResult.eventReference?.type === 'last_created') {
    const lastEvent = await getLastCreatedEvent(user.telegramId);
    if (!lastEvent) {
      await messagingService.updateMessage(chatId, messageId,
        t.voice?.noLastEvent || "❌ No recent event found. Try specifying which event to edit.",
        { format: MessageFormat.HTML }
      );
      return;
    }

    const calendarIds = (user.calendarAssignments || []).map(c => c.calendarId);
    if (!calendarIds.includes(lastEvent.calendarId)) {
      calendarIds.push(lastEvent.calendarId);
    }

    const events = await fetchEventsInRange(
      user.googleRefreshToken,
      [lastEvent.calendarId],
      new Date(lastEvent.startTime.getTime() - 60000),
      new Date(lastEvent.endTime.getTime() + 60000)
    );

    targetEvent = events.find(e => e.eventId === lastEvent.eventId);
    targetCalendarId = lastEvent.calendarId;

  } else if (intentResult.eventReference?.type === 'by_description') {
    const calendarIds = (user.calendarAssignments || []).map(c => c.calendarId);
    const matchResult = await findMatchingEvent(
      user.googleRefreshToken,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en'
    );

    if ('error' in matchResult) {
      if (matchResult.error === 'no_events_found') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.noEventsFound || "❌ No events found in that time range.",
          { format: MessageFormat.HTML }
        );
      } else if (matchResult.error === 'multiple_matches') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.ambiguousEvent || "🤔 Found multiple matching events. Please be more specific.",
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.eventNotFound || "❌ Couldn't find that event.",
          { format: MessageFormat.HTML }
        );
      }
      return;
    }

    targetEvent = matchResult.event;
    targetCalendarId = matchResult.calendarId;
  }

  if (!targetEvent || !targetCalendarId) {
    await messagingService.updateMessage(chatId, messageId,
      t.voice?.eventNotFound || "❌ Couldn't find the event to edit.",
      { format: MessageFormat.HTML }
    );
    return;
  }

  const timezone = await resolveUserTimezone(user);
  const updates = convertEditRequestToUpdates(intentResult.editRequest, targetEvent, timezone);

  await showEditConfirmation(chatId, messageId, targetEvent, targetCalendarId, updates, transcription, user, intentResult.scope, adminFooter);
}

/**
 * Handle DELETE intent - find event and show delete confirmation
 */
async function handleDeleteIntent(
  chatId: number,
  messageId: number,
  intentResult: VoiceIntentResult,
  transcription: string,
  user: UserConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  adminFooter?: string
): Promise<void> {
  const messagingService = getMessagingService();

  if (!user.googleRefreshToken) {
    await messagingService.updateMessage(chatId, messageId, t.voice?.noCalendar || 'Calendar not connected.', { format: MessageFormat.PLAIN });
    return;
  }

  let targetEvent: CalendarEvent | undefined;
  let targetCalendarId: string | undefined;

  if (intentResult.eventReference?.type === 'last_created') {
    const lastEvent = await getLastCreatedEvent(user.telegramId);
    if (!lastEvent) {
      await messagingService.updateMessage(chatId, messageId,
        t.voice?.noLastEvent || "❌ No recent event found. Try specifying which event to cancel.",
        { format: MessageFormat.HTML }
      );
      return;
    }

    const events = await fetchEventsInRange(
      user.googleRefreshToken,
      [lastEvent.calendarId],
      new Date(lastEvent.startTime.getTime() - 60000),
      new Date(lastEvent.endTime.getTime() + 60000)
    );

    targetEvent = events.find(e => e.eventId === lastEvent.eventId);
    targetCalendarId = lastEvent.calendarId;

  } else if (intentResult.eventReference?.type === 'by_description') {
    const calendarIds = (user.calendarAssignments || []).map(c => c.calendarId);
    const matchResult = await findMatchingEvent(
      user.googleRefreshToken,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en'
    );

    if ('error' in matchResult) {
      if (matchResult.error === 'no_events_found') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.noEventsFound || "❌ No events found in that time range.",
          { format: MessageFormat.HTML }
        );
      } else if (matchResult.error === 'multiple_matches') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.ambiguousEvent || "🤔 Found multiple matching events. Please be more specific.",
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.eventNotFound || "❌ Couldn't find that event.",
          { format: MessageFormat.HTML }
        );
      }
      return;
    }

    targetEvent = matchResult.event;
    targetCalendarId = matchResult.calendarId;
  }

  if (!targetEvent || !targetCalendarId) {
    await messagingService.updateMessage(chatId, messageId,
      t.voice?.eventNotFound || "❌ Couldn't find the event to delete.",
      { format: MessageFormat.HTML }
    );
    return;
  }

  await showDeleteConfirmation(chatId, messageId, targetEvent, targetCalendarId, transcription, user, intentResult.scope, adminFooter);
}

/**
 * Handle incoming voice message for event creation
 */
export async function handleVoiceMessage(
  chatId: number,
  userId: number,
  voice: TelegramVoice,
  from: TelegramUser
): Promise<void> {
  console.log(`[Voice] Starting voice handler for user ${userId}`);
  const messagingService = getMessagingService();
  let user: Awaited<ReturnType<typeof getUserByTelegramId>> | null = null;

  setUserContext(userId, from.first_name);

  addBreadcrumb('voice_processing_started', {
    user_id: userId,
    duration: voice.duration,
    file_size: voice.file_size,
  }, 'voice');

  try {
    console.log(`[Voice] Looking up user ${userId} in database`);
    user = await getUserByTelegramId(userId);

    if (!user) {
      console.log(`[Voice] User ${userId} not found in database`);
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId, t.voice.notRegistered, { format: MessageFormat.PLAIN });
      return;
    }

    const t = await getBotMessages(user.language || 'en');
    console.log(`[Voice] User ${userId} found: ${user.name}, hasToken: ${!!user.googleRefreshToken}, voiceInputEnabled: ${user.voiceInputEnabled}`);

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

    const voiceEventAccess = await checkFeatureAccess(user.id, 'voice_events');
    if (!voiceEventAccess.allowed) {
      console.log(`[Voice] Voice events not available for user ${userId}, reason: ${voiceEventAccess.reason}`);
      const bot = getBot();
      const upgradeUrl = buildUrl(`/${user.language || 'en'}/subscription?user_id=${userId}`);
      const upgradeMessage = t.subscription?.voiceEventsRequired
        || '⭐ <b>Voice event creation is a Pro feature</b>\n\nUpgrade to Pro to create calendar events using voice messages!';

      await bot.sendMessage(chatId, upgradeMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: t.subscription?.upgradeButton || '⭐ Upgrade to Pro', web_app: { url: upgradeUrl } }
          ]]
        }
      });
      return;
    }

    trackActivityAsync(user.id, 'voice_event_started', {
      language: user.language,
    });

    if (!user.googleRefreshToken) {
      console.log(`[Voice] User ${userId} has no Google refresh token`);
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }

    if (voice.duration >= 30) {
      await messagingService.sendMessage(chatId, t.voice.tooLong, { format: MessageFormat.PLAIN });
      return;
    }

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

    console.log(`[Voice] Downloading voice file for user ${userId}, file_id: ${voice.file_id}, duration: ${voice.duration}s`);
    const audioBuffer = await downloadVoiceFile(voice.file_id);
    console.log(`[Voice] Downloaded ${audioBuffer.length} bytes`);

    addBreadcrumb('voice_downloaded', {
      file_size: audioBuffer.length,
    }, 'voice');

    const timezone = await resolveUserTimezone(user);
    const { intentResult, transcription, metrics } = await processVoiceWithGemini(
      audioBuffer,
      user.language || 'en',
      user.calendarAssignments || [],
      timezone
    );

    // Build admin footer from voice processing metrics
    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;

    addBreadcrumb('voice_transcribed', {
      text_length: transcription?.length || 0,
      has_text: !!transcription,
    }, 'voice');

    console.log(`[Voice] Intent detected: ${intentResult.intent}, confidence: ${intentResult.confidence}`);

    addBreadcrumb('voice_intent_detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      has_event: !!intentResult.event,
    }, 'voice');

    if (intentResult.intent === 'create') {
      if (!intentResult.event) {
        const safeTranscription = transcription.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await messagingService.updateMessage(chatId, processingMsgId,
          `${t.voice.notUnderstood}\n\n` +
          `${t.voice.iHeard} "<i>${safeTranscription}</i>"\n\n` +
          `${t.voice.tryExamples}\n` +
          `• "${t.voice.example1}"\n` +
          `• "${t.voice.example2}"\n` +
          `• "${t.voice.example3}"`,
          { format: MessageFormat.HTML }
        );
        return;
      }
      await showEventConfirmation(chatId, processingMsgId, intentResult.event, transcription, user, adminFooter);

    } else if (intentResult.intent === 'edit') {
      await handleEditIntent(chatId, processingMsgId, intentResult, transcription, user, t, adminFooter);

    } else if (intentResult.intent === 'delete') {
      await handleDeleteIntent(chatId, processingMsgId, intentResult, transcription, user, t, adminFooter);
    }

  } catch (error) {
    console.error('[Voice] Error handling voice message:', error);

    if (user) {
      trackActivityAsync(user.id, 'voice_event_failed', {
        error_type: error instanceof Error ? error.message : 'unknown',
      });
    }

    const errorMessages = await getBotMessages(user?.language || 'en');
    await messagingService.sendMessage(chatId, errorMessages.voice.geminiError, { format: MessageFormat.PLAIN });
  }
}
