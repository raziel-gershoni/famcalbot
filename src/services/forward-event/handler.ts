/**
 * Forwarded message handler
 * Processes forwarded text messages for event creation, editing, and deletion
 */

import { getBot, getMessagingService } from '../telegram';
import { getUserByTelegramId } from '../user-service';
import { MessageFormat } from '../messaging/types';
import { processTextWithGemini } from './gemini-text';
import { resolveUserTimezone } from '../../lib/timezone';
import { buildUrl } from '../../config/urls';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb, setUserContext } from '../analytics-service';
import { checkFeatureAccess } from '../subscription-service';
import { showEventConfirmation } from '../voice/confirmations';
import { handleEditIntent, handleDeleteIntent } from '../voice';
import { captureError } from '../../lib/error-capture';
import { startTypingInterval } from '../telegram/command-pipeline';

const MAX_TEXT_LENGTH = 2000;

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

/**
 * Handle forwarded text message for event creation
 */
export async function handleForwardedMessage(
  chatId: number,
  userId: number,
  messageText: string,
  from: TelegramUser
): Promise<void> {
  console.log(`[Forward] Starting forward handler for user ${userId}`);
  const messagingService = getMessagingService();
  let user: Awaited<ReturnType<typeof getUserByTelegramId>> | null = null;
  let stopTyping: (() => void) | null = null;

  setUserContext(userId, from.first_name);

  addBreadcrumb('forward_processing_started', {
    user_id: userId,
    text_length: messageText.length,
  }, 'forward');

  try {
    user = await getUserByTelegramId(userId);

    if (!user) {
      console.log(`[Forward] User ${userId} not found in database`);
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId, t.voice.notRegistered, { format: MessageFormat.PLAIN });
      return;
    }

    const t = await getBotMessages(user.language || 'en');

    if (!user.voiceInputEnabled) {
      console.log(`[Forward] Voice input disabled for user ${userId}`);
      const bot = getBot();
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${user.id}`);
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
      console.log(`[Forward] Voice events not available for user ${userId}`);
      const bot = getBot();
      const upgradeUrl = buildUrl(`/${user.language || 'en'}/subscription?user_id=${user.id}`);
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

    trackActivityAsync(user.id, 'forward_event_started', {
      language: user.language,
    });

    if (!user.googleRefreshToken) {
      console.log(`[Forward] User ${userId} has no Google refresh token`);
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }

    if (messageText.length > MAX_TEXT_LENGTH) {
      await messagingService.sendMessage(chatId, t.voice.forwardTooLong, { format: MessageFormat.PLAIN });
      return;
    }

    console.log(`[Forward] Starting typing indicator for chat ${chatId}`);
    stopTyping = startTypingInterval(chatId, messagingService);

    const timezone = await resolveUserTimezone(user);
    const { intentResult, metrics } = await processTextWithGemini(
      messageText,
      user.language || 'en',
      user.calendarAssignments || [],
      timezone
    );

    // Build admin footer from processing metrics
    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;

    addBreadcrumb('forward_intent_detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      has_event: !!intentResult.event,
    }, 'forward');

    console.log(`[Forward] Intent detected: ${intentResult.intent}, confidence: ${intentResult.confidence}`);

    // Stop typing before sending confirmation UI
    stopTyping();

    if (intentResult.intent === 'create') {
      if (!intentResult.event) {
        // No event found or low confidence
        await messagingService.sendMessage(chatId, t.voice.forwardNotUnderstood, { format: MessageFormat.HTML });
        return;
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, messageText, user, adminFooter);

    } else if (intentResult.intent === 'edit') {
      await handleEditIntent(chatId, undefined, intentResult, messageText, user, t, adminFooter);

    } else if (intentResult.intent === 'delete') {
      await handleDeleteIntent(chatId, undefined, intentResult, messageText, user, t, adminFooter);
    }

  } catch (error) {
    if (stopTyping) stopTyping();
    console.error('[Forward] Error handling forwarded message:', error);
    captureError(error, 'forward-handler');

    if (user) {
      trackActivityAsync(user.id, 'forward_event_failed', {
        error_type: error instanceof Error ? error.message : 'unknown',
      });
    }

    const errorMessages = await getBotMessages(user?.language || 'en');
    await messagingService.sendMessage(chatId, errorMessages.voice.forwardNotUnderstood || errorMessages.voice.geminiError, { format: MessageFormat.PLAIN });
  }
}
