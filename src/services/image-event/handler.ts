/**
 * Image message handler
 * Processes invitation photos for automatic event creation.
 * Twin of the forwarded-text and voice handlers; converges on the same
 * confirmation / auto-create seam.
 */

import { getBot, getMessagingService } from '../telegram';
import { getUserByTelegramId } from '../user-service';
import { MessageFormat } from '../messaging/types';
import { processImageWithGemini } from './gemini-image';
import { resolveUserTimezone } from '../../lib/timezone';
import { buildUrl } from '../../config/urls';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb, setUserContext } from '../analytics-service';
import { checkFeatureAccess } from '../subscription-service';
import { showEventConfirmation } from '../voice/confirmations';
import { downloadTelegramFile } from '../voice/event-resolution';
import { captureError } from '../../lib/error-capture';
import { startTypingInterval } from '../telegram/command-pipeline';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

/** Telegram PhotoSize (the highest-resolution entry of message.photo). */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * Handle an invitation photo for event creation.
 */
export async function handleImageMessage(
  chatId: number,
  userId: number,
  photo: TelegramPhotoSize,
  from: TelegramUser,
  caption?: string
): Promise<void> {
  console.log(`[Image] Starting image handler for user ${userId}`);
  const messagingService = getMessagingService();
  let user: Awaited<ReturnType<typeof getUserByTelegramId>> | null = null;
  let stopTyping: (() => void) | null = null;

  setUserContext(userId, from.first_name);
  addBreadcrumb('image_processing_started', { user_id: userId }, 'image');

  try {
    user = await getUserByTelegramId(userId);

    if (!user) {
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId, t.voice.notRegistered, { format: MessageFormat.PLAIN });
      return;
    }

    const t = await getBotMessages(user.language || 'en');

    // Reuse the same "AI event creation" toggle as voice / forwarded text.
    if (!user.voiceInputEnabled) {
      const bot = getBot();
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.id}`);
      await bot.sendMessage(chatId, t.voice.featureDisabled, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: t.voice.enableInSettings, web_app: { url: settingsUrl } }]],
        },
      });
      return;
    }

    const eventAccess = await checkFeatureAccess(user.id, 'voice_events');
    if (!eventAccess.allowed) {
      const bot = getBot();
      const upgradeUrl = buildUrl(`/${user.language || 'en'}/subscription?user_id=${user.id}`);
      const upgradeMessage = t.subscription?.voiceEventsRequired
        || '⭐ <b>Voice event creation is a Pro feature</b>\n\nUpgrade to Pro to create calendar events using voice messages!';
      await bot.sendMessage(chatId, upgradeMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: t.subscription?.upgradeButton || '⭐ Upgrade to Pro', web_app: { url: upgradeUrl } }]],
        },
      });
      return;
    }

    trackActivityAsync(user.id, 'image_event_started', { language: user.language });

    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
    if (!(await hasUsableCalendar(user))) {
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }
    const userCalendars = await getCalendarAssignmentsForUser(user);

    stopTyping = startTypingInterval(chatId, messagingService);

    console.log(`[Image] Downloading photo for user ${userId}, file_id: ${photo.file_id}`);
    const imageBuffer = await downloadTelegramFile(photo.file_id);
    console.log(`[Image] Downloaded ${imageBuffer.length} bytes`);

    const timezone = await resolveUserTimezone(user);
    const { intentResult, intentResults, metrics } = await processImageWithGemini(
      imageBuffer,
      'image/jpeg',
      caption,
      user.language || 'en',
      userCalendars,
      timezone
    );

    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;

    addBreadcrumb('image_intent_detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      has_event: !!intentResult.event,
    }, 'image');

    console.log(`[Image] Intent detected: ${intentResult.intent}, confidence: ${intentResult.confidence}`);

    stopTyping();

    // Source label shown on the confirmation card (there is no transcription).
    const sourceLabel = caption?.trim() || t.imageEvent?.fromImage || 'an invitation image';

    // Multi-event flyer: 2+ valid CREATE intents → bulk card (never auto-creates).
    const validBulk = (intentResults || []).filter(r => r.intent === 'create' && r.event && !r.error);
    if (validBulk.length > 1) {
      const { showBulkConfirmation } = await import('../voice/bulk-confirmations');
      await showBulkConfirmation(chatId, validBulk, user, sourceLabel, t, messagingService, timezone);
      return;
    }

    if (intentResult.intent === 'create' && intentResult.event) {
      // Auto-create only for HIGH-confidence, non-recurring single events, and
      // only when the shared admin flag is on. The image prompt already
      // downgrades confidence on any ambiguity (RSVP-vs-event date, inferred
      // year), so "high" here means the date/time were explicit — the approved
      // ambiguity guard, expressed through the confidence channel.
      const { isAutoCreateEnabled, autoCreateEvent } = await import('../voice/auto-create');
      if (
        intentResult.confidence === 'high' &&
        !intentResult.event.recurrence &&
        (await isAutoCreateEnabled())
      ) {
        const handled = await autoCreateEvent(user, intentResult.event, t, messagingService, chatId);
        if (handled) return;
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, sourceLabel, user, adminFooter, 'image');
      return;
    }

    // intent === 'none' (or no event) → friendly reply, nothing created.
    await messagingService.sendMessage(
      chatId,
      t.imageEvent?.noEventFound || "🤔 I couldn't find an event in that image.",
      { format: MessageFormat.PLAIN }
    );

  } catch (error) {
    if (stopTyping) stopTyping();
    console.error('[Image] Error handling image message:', error);
    captureError(error, 'image-handler');

    if (user) {
      trackActivityAsync(user.id, 'image_event_failed', {
        error_type: error instanceof Error ? error.message : 'unknown',
      });
    }

    // A genuine failure (download / Gemini error) — report an error, NOT the
    // "no event found" copy, which is reserved for the intent === 'none' path.
    const errorMessages = await getBotMessages(user?.language || 'en');
    await messagingService.sendMessage(
      chatId,
      errorMessages.voice.geminiError,
      { format: MessageFormat.PLAIN }
    );
  }
}
