/**
 * Voice message handler - main entry point
 * Orchestrates voice message processing: auth → feature check → download → gemini direct audio → route
 */

import { getBot, getMessagingService } from '../telegram';
import { getUserByTelegramId } from '../user-service';
import { MessageFormat } from '../messaging/types';
import { VoiceIntentResult } from '../event-parser';
import { notAddressedTelemetry, processVoiceWithGemini } from './gemini-voice';
import { CalendarEvent } from '../calendar';
import { fetchEventsInRange } from '../calendar-provider';
import { resolveUserTimezone } from '../../lib/timezone';
import { buildUrl } from '../../config/urls';
import { UserConfig } from '../../types';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb, setUserContext } from '../analytics-service';
import { checkFeatureAccess } from '../subscription-service';
import { downloadVoiceFile, getLastCreatedEvent, findMatchingEvent, convertEditRequestToUpdates, isLastCreatedEvent, UNAVAILABLE } from './event-resolution';
import { sendAnchorQuestions, showEventConfirmation, showEditConfirmation, showDeleteConfirmation } from './confirmations';
import { getReminderSupport } from '../native-reminders/support';
import { primaryIntent, reminderPromptContext, resolveReminderIntents } from '../native-reminders/resolve';
import type { ReminderFailure } from '../native-reminders/resolve';
import { NO_SPEECH } from './speech-presence';
import { captureError } from '../../lib/error-capture';
import { startTypingInterval } from '../telegram/command-pipeline';

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
 * What the user is told when their calendars could not all be read and the event wasn't in the
 * rest: Google couldn't be reached (the summaries' copy), or the calendar fetch error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unavailableText(error: string, t: any): string {
  return error === UNAVAILABLE.google ? t.errors.googleUnreachable : t.errors.calendarFetch;
}

/**
 * Handle EDIT intent - find event and show edit confirmation
 */
export async function handleEditIntent(
  chatId: number,
  messageId: number | undefined,
  intentResult: VoiceIntentResult,
  transcription: string,
  user: UserConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  adminFooter?: string
): Promise<void> {
  const messagingService = getMessagingService();

  const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
  if (!(await hasUsableCalendar(user))) {
    await messagingService.sendMessage(chatId, t.voice?.noCalendar || 'Calendar not connected.', { format: MessageFormat.PLAIN });
    return;
  }
  const userCalendars = await getCalendarAssignmentsForUser(user);

  let targetEvent: CalendarEvent | undefined;
  let targetCalendarId: string | undefined;

  if (intentResult.eventReference?.type === 'last_created') {
    const lastEvent = await getLastCreatedEvent(user.telegramId!);
    if (!lastEvent) {
      await messagingService.sendMessage(chatId,
        t.voice?.noLastEvent || "❌ No recent event found. Try specifying which event to edit.",
        { format: MessageFormat.HTML }
      );
      return;
    }

    const { events, failed } = await fetchEventsInRange(
      user,
      [lastEvent.calendarId],
      new Date(lastEvent.startTime.getTime() - 60000),
      new Date(lastEvent.endTime.getTime() + 60000)
    );

    targetEvent = events.find(e => isLastCreatedEvent(e, lastEvent));
    targetCalendarId = lastEvent.calendarId;
    // Its calendar couldn't be read: say so, not "couldn't find"
    if (!targetEvent && failed.length > 0) {
      await messagingService.sendMessage(chatId, unavailableText(failed.includes('google') ? UNAVAILABLE.google : UNAVAILABLE.famcal, t), { format: MessageFormat.HTML });
      return;
    }

  } else if (intentResult.eventReference?.type === 'by_description') {
    const calendarIds = userCalendars.map(c => c.calendarId);
    const matchResult = await findMatchingEvent(
      user,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en',
      undefined,
      { request: transcription, openReminders: true }
    );

    if ('error' in matchResult) {
      if (matchResult.error === 'no_events_found') {
        await messagingService.sendMessage(chatId,
          t.voice?.noEventsFound || "❌ No events found in that time range.",
          { format: MessageFormat.HTML }
        );
      } else if (matchResult.error === UNAVAILABLE.google || matchResult.error === UNAVAILABLE.famcal) {
        await messagingService.sendMessage(chatId, unavailableText(matchResult.error, t), { format: MessageFormat.HTML });
      } else if (matchResult.error === 'multiple_matches') {
        await messagingService.sendMessage(chatId,
          t.voice?.ambiguousEvent || "🤔 Found multiple matching events. Please be more specific.",
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.sendMessage(chatId,
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
    await messagingService.sendMessage(chatId,
      t.voice?.eventNotFound || "❌ Couldn't find the event to edit.",
      { format: MessageFormat.HTML }
    );
    return;
  }

  const timezone = await resolveUserTimezone(user);
  const updates = convertEditRequestToUpdates(intentResult.editRequest, targetEvent, timezone);

  // A series on set weekdays can't have its days moved for more than one occurrence: say so
  // now, not after a card the user would confirm for nothing.
  if ((intentResult.scope === 'all' || intentResult.scope === 'following') && targetEvent.recurringEventId && targetEvent.eventId) {
    const { wouldRefuseFixedDays } = await import('../calendar-provider/native-provider');
    if (await wouldRefuseFixedDays(user, targetCalendarId, targetEvent.eventId, { ...updates, scope: intentResult.scope, recurringEventId: targetEvent.recurringEventId })) {
      await messagingService.sendMessage(chatId,
        t.voice?.fixedDaysMove || 'To move all of them to another day, delete the series and create it again.',
        { format: MessageFormat.HTML }
      );
      return;
    }
  }

  await showEditConfirmation(chatId, messageId, targetEvent, targetCalendarId, updates, transcription, user, intentResult.scope, adminFooter);
}

/**
 * Handle DELETE intent - find event and show delete confirmation
 */
export async function handleDeleteIntent(
  chatId: number,
  messageId: number | undefined,
  intentResult: VoiceIntentResult,
  transcription: string,
  user: UserConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  adminFooter?: string
): Promise<void> {
  const messagingService = getMessagingService();

  const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
  if (!(await hasUsableCalendar(user))) {
    await messagingService.sendMessage(chatId, t.voice?.noCalendar || 'Calendar not connected.', { format: MessageFormat.PLAIN });
    return;
  }
  const userCalendars = await getCalendarAssignmentsForUser(user);

  let targetEvent: CalendarEvent | undefined;
  let targetCalendarId: string | undefined;

  if (intentResult.eventReference?.type === 'last_created') {
    const lastEvent = await getLastCreatedEvent(user.telegramId!);
    if (!lastEvent) {
      await messagingService.sendMessage(chatId,
        t.voice?.noLastEvent || "❌ No recent event found. Try specifying which event to cancel.",
        { format: MessageFormat.HTML }
      );
      return;
    }

    const { events, failed } = await fetchEventsInRange(
      user,
      [lastEvent.calendarId],
      new Date(lastEvent.startTime.getTime() - 60000),
      new Date(lastEvent.endTime.getTime() + 60000)
    );

    targetEvent = events.find(e => isLastCreatedEvent(e, lastEvent));
    targetCalendarId = lastEvent.calendarId;
    // Its calendar couldn't be read: say so, not "couldn't find"
    if (!targetEvent && failed.length > 0) {
      await messagingService.sendMessage(chatId, unavailableText(failed.includes('google') ? UNAVAILABLE.google : UNAVAILABLE.famcal, t), { format: MessageFormat.HTML });
      return;
    }

  } else if (intentResult.eventReference?.type === 'by_description') {
    const calendarIds = userCalendars.map(c => c.calendarId);
    const matchResult = await findMatchingEvent(
      user,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en',
      undefined,
      { request: transcription, openReminders: true }
    );

    if ('error' in matchResult) {
      if (matchResult.error === 'no_events_found') {
        await messagingService.sendMessage(chatId,
          t.voice?.noEventsFound || "❌ No events found in that time range.",
          { format: MessageFormat.HTML }
        );
      } else if (matchResult.error === UNAVAILABLE.google || matchResult.error === UNAVAILABLE.famcal) {
        await messagingService.sendMessage(chatId, unavailableText(matchResult.error, t), { format: MessageFormat.HTML });
      } else if (matchResult.error === 'multiple_matches') {
        await messagingService.sendMessage(chatId,
          t.voice?.ambiguousEvent || "🤔 Found multiple matching events. Please be more specific.",
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.sendMessage(chatId,
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
    await messagingService.sendMessage(chatId,
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
  let stopTyping: (() => void) | null = null;
  let audioBuffer: Buffer | null = null;

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
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.telegramId ?? user.id}`);
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
      const upgradeUrl = buildUrl(`/${user.language || 'en'}/subscription?user_id=${user.telegramId ?? user.id}`);
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

    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
    if (!(await hasUsableCalendar(user))) {
      console.log(`[Voice] User ${userId} has no usable calendar (google token: ${user.googleRefreshToken ? 'yes' : 'no'})`);
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }
    const userCalendars = await getCalendarAssignmentsForUser(user);

    if (voice.duration >= 30) {
      await messagingService.sendMessage(chatId, t.voice.tooLong, { format: MessageFormat.PLAIN });
      return;
    }

    console.log(`[Voice] Starting typing indicator for chat ${chatId}`);
    stopTyping = startTypingInterval(chatId, messagingService);

    console.log(`[Voice] Downloading voice file for user ${userId}, file_id: ${voice.file_id}, duration: ${voice.duration}s`);
    audioBuffer = await downloadVoiceFile(voice.file_id);
    console.log(`[Voice] Downloaded ${audioBuffer.length} bytes`);

    // PR 10 polish: if a previous voice attempt failed and we stashed the
    // original audio, send BOTH audios to Gemini as separate inlineData
    // parts (byte-concat would produce an invalid OGG stream). The new
    // utterance is the authoritative one; the prior one is context.
    const { isInRetryMode, readRetryAudio, clearRetryMode } = await import('./audio-retry');
    let priorAudio: Buffer | null = null;
    if (await isInRetryMode(chatId)) {
      priorAudio = await readRetryAudio(chatId);
      await clearRetryMode(chatId);
    }

    addBreadcrumb('voice_downloaded', {
      file_size: audioBuffer.length,
    }, 'voice');

    const timezone = await resolveUserTimezone(user);
    // Recent-events context: best-effort lookup; empty if Redis is missing/cold.
    const { getRecentEvents, formatRecentEventsBlock } = await import('./recent-events-store');
    const recentEvents = await getRecentEvents(user.id);
    const recentBlock = formatRecentEventsBlock(recentEvents, timezone);
    // Native reminders (spec R3), checked once per message. Without support the prompt
    // has no reminder rules and everything below runs as before.
    const support = await getReminderSupport(user);
    const extraction = await processVoiceWithGemini(
      audioBuffer,
      user.language || 'en',
      userCalendars,
      timezone,
      recentBlock,
      priorAudio ?? undefined,
      support.supported ? await reminderPromptContext(user) : undefined
    );
    const { transcription, metrics } = extraction;
    let { intentResult, intentResults } = extraction;
    // How often the addressed check holds back what may be a real command
    const unaddressed = notAddressedTelemetry(intentResults ?? [intentResult]);
    if (unaddressed) trackActivityAsync(user.id, 'voice_not_addressed', unaddressed);
    // Each reminder gets its calendar, target and time before any card shows it
    let reminderFailures: ReminderFailure[] = [];
    if (support.supported) {
      const resolved = await resolveReminderIntents(user, intentResults ?? [intentResult], timezone);
      intentResults = resolved.intents;
      // Skip only an item resolution failed (not an edit or delete): the failures are asked about after its card
      intentResult = primaryIntent(resolved) ?? intentResult;
      reminderFailures = resolved.failures;
    }

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

    // Stop typing before sending confirmation UI
    stopTyping();

    // PR 11: multi-event utterance — if Gemini returned 2+ valid CREATE intents,
    // route to the bulk confirmation card. Single-intent CREATE/EDIT/DELETE
    // continues through the existing flows below.
    const validBulk = (intentResults || []).filter(
      (r) => r.intent === 'create' && r.event && !r.error
    );
    if (validBulk.length > 1) {
      const { showBulkConfirmation } = await import('./bulk-confirmations');
      await showBulkConfirmation(chatId, validBulk, user, transcription, t, messagingService, timezone);
      await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
      return;
    }

    if (intentResult.intent === 'create') {
      if (intentResult.error === NO_SPEECH) {
        // A silent follow-up is not the clarification we invited. Retry mode was
        // already cleared to read priorAudio, so put the original recording back -
        // otherwise the clarification they send next is parsed without it.
        if (priorAudio && typeof chatId === 'number') {
          const { stashFailedAudio } = await import('./audio-retry');
          await stashFailedAudio(chatId, priorAudio);
        }
        // Silence or noise. Quoting an empty "I heard" and suggesting phrasings would
        // read as a misunderstanding; the user just needs to record again.
        await messagingService.sendMessage(chatId,
          t.voice.noSpeech || "🎤 I didn't hear anything in that voice message. Please try again.",
          { format: MessageFormat.PLAIN }
        );
        return;
      }
      if (!intentResult.event) {
        // A reminder anchored to an event that couldn't be found asks for a time instead
        if (reminderFailures.length > 0) {
          await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
          return;
        }
        const safeTranscription = transcription.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await messagingService.sendMessage(chatId,
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
      // PR 10: HIGH-confidence skip-confirmation path. Gated on env flag —
      // off by default. Only triggers for non-recurring single events; recurring
      // events still go through the confirmation card so the user can pick scope
      // before commit.
      const { isAutoCreateEnabled, autoCreateEvent } = await import('./auto-create');
      if (
        intentResult.confidence === 'high' &&
        !intentResult.event.recurrence &&
        // A reminder with a notice (partner not on Telegram, time passed, no time set) waits for its card
        !intentResult.event.reminderNotice &&
        // Speech that seemed not meant for the device (TV, radio) waits for a tap
        !intentResult.notAddressed &&
        (await isAutoCreateEnabled())
      ) {
        const handled = await autoCreateEvent(user, intentResult.event, t, messagingService, chatId);
        if (handled) {
          await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
          return;
        }
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, transcription, user, adminFooter, 'voice');
      await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);

    } else if (intentResult.intent === 'edit') {
      await handleEditIntent(chatId, undefined, intentResult, transcription, user, t, adminFooter);

    } else if (intentResult.intent === 'delete') {
      await handleDeleteIntent(chatId, undefined, intentResult, transcription, user, t, adminFooter);
    }

  } catch (error) {
    if (stopTyping) stopTyping();
    console.error('[Voice] Error handling voice message:', error);
    captureError(error, 'voice-handler');

    if (user) {
      trackActivityAsync(user.id, 'voice_event_failed', {
        error_type: error instanceof Error ? error.message : 'unknown',
      });
    }

    const errorMessages = await getBotMessages(user?.language || 'en');
    // PR 10 polish: keep the failed audio for a 5-minute retry window. The
    // user's next message can be a short addendum that we'll combine with
    // the original audio.
    if (audioBuffer && typeof chatId === 'number') {
      const { stashFailedAudio } = await import('./audio-retry');
      await stashFailedAudio(chatId, audioBuffer);
    }
    const retryHint = errorMessages.voice?.retryHint || ' (You can also send a short clarification — I\'ll combine it with what I heard.)';
    await messagingService.sendMessage(chatId, errorMessages.voice.geminiError + retryHint, { format: MessageFormat.PLAIN });
  }
}
