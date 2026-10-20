/**
 * Telegram voice message functions
 *
 * Languages with show hosts (Hebrew, English, Russian) get the two-host show: an LLM
 * writes the script and each line is spoken by its host - see ../voice-show/produce.ts.
 * Any other language keeps the 2-step narrator pipeline: an LLM condenses the summary,
 * then Gemini TTS reads it in the English anchor's voice.
 */

import { UserConfig } from '../../types';
import { IMessagingService, MessagingPlatform, MessageFormat } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import { startTypingInterval } from './command-pipeline';
import { getMessagingService } from './bot';
import { trackActivityAsync } from '../analytics-service';
import { incrementUsage } from '../subscription-service';
import { formatVoiceCaption } from '../../utils/ai-footer';
import type { VoiceCondenserContext } from '../../prompts/voice-condenser';
import type { ProducedVoice, ShowKind } from '../voice-show/types';
import { liveGoogleChoices } from '../../lib/google-state';

/**
 * Make the voice note for a summary: the show where the language has hosts, the
 * single narrator elsewhere.
 */
async function produceVoice(summary: string, user: UserConfig, kind: ShowKind, isNextWeek = false): Promise<ProducedVoice> {
  const { isShowLanguage, produceShowVoice } = await import('../voice-show/produce');
  if (isShowLanguage(user.language || 'en')) {
    return produceShowVoice(summary, user, kind, isNextWeek);
  }
  return produceNarratorVoice(summary, user, kind, isNextWeek);
}

/**
 * Step 1: LLM condenses the summary via generateAICompletion
 * Step 2: Gemini TTS speaks the condensed plain text
 */
async function produceNarratorVoice(summary: string, user: UserConfig, kind: ShowKind, isNextWeek: boolean): Promise<ProducedVoice> {
  const userLanguage = user.language || 'en';
  const { generateVoiceMessage } = await import('../voice-generator');
  const { buildVoiceCondenserPrompt, buildWeeklyVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
  const { generateAICompletion } = await import('../ai-provider');

  // The union of FamCal and the Google choices, as the voice show reads it
  const { resolveShowCalendars } = await import('../voice-show/context');
  const calendars = (await resolveShowCalendars(user)) ?? liveGoogleChoices(user);
  const spouseCalendar = calendars.find(cal => cal.labels.includes('spouse'));
  const hasKidsCalendars = calendars.some(cal => cal.labels.includes('kids'));

  const condenserContext: VoiceCondenserContext = {
    summary,
    locale: userLanguage,
    userName: user.name,
    spouseName: spouseCalendar?.personName,
    hasKidsCalendars,
    culture: user.culture,
    globalRules: user.globalRules,
    isNextWeek: kind === 'weekly' ? isNextWeek : undefined,
  };
  // Tomorrow and weather have no condenser of their own; they have always used the daily one.
  const condenserPrompt = kind === 'weekly'
    ? buildWeeklyVoiceCondenserPrompt(condenserContext)
    : buildVoiceCondenserPrompt(condenserContext);
  const condensedResult = await generateAICompletion(condenserPrompt);
  const condensedText = condensedResult.text;

  console.log(`[Voice] ${kind} summary condensed: ${summary.length} → ${condensedText.length} chars`);

  const { filePath, ttsMs, ttsModel, voiceName } = await generateVoiceMessage(condensedText, userLanguage);
  return {
    filePath,
    caption: formatVoiceCaption(condensedResult, ttsMs, ttsModel, user.isAdmin, voiceName),
    durationSeconds: Math.ceil(condensedText.length / 15),
  };
}

/**
 * Generate and send voice version of summary
 * Shows animated progress that gets deleted when voice arrives (optional)
 * Non-blocking - errors logged but don't affect text summary delivery
 * @param kind - 'tomorrow' for the tomorrow summary, 'weather' for /weather, else 'daily'
 */
export async function sendVoiceMessage(
  chatId: number | string,
  summary: string,
  user: UserConfig,
  service?: IMessagingService,
  showProgress: boolean = true,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  waMessageId?: string,
  kind: 'daily' | 'tomorrow' | 'weather' = 'daily'
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || (platform === MessagingPlatform.WHATSAPP
    ? getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP)
    : getMessagingService());
  const userLanguage = user.language || 'en';

  // Resolve WA message ID from Redis if not provided
  let msgId = waMessageId;
  if (!msgId && platform === MessagingPlatform.WHATSAPP) {
    const { redis } = await import('../../utils/redis');
    const { REDIS_KEYS } = await import('../../config/redis-keys');
    msgId = await redis.get<string>(REDIS_KEYS.waLastMsg(String(chatId))) || undefined;
  }

  // Start typing indicator if enabled
  let stopTyping: (() => void) | null = null;
  if (showProgress) {
    stopTyping = startTypingInterval(chatId, msgService, platform === MessagingPlatform.WHATSAPP ? 'text' : 'audio', msgId);
  }

  try {
    console.log(`[Voice] Generating ${kind} voice message for user ${chatId}...`);

    const voice = await produceVoice(summary, user, kind);
    voiceFilePath = voice.filePath;

    // Stop typing indicator
    if (stopTyping) stopTyping();

    // Send voice via platform-agnostic service
    await msgService.sendVoice(chatId, voiceFilePath);

    // Send admin caption as separate text (WhatsApp doesn't support captions on audio)
    if (voice.caption && user.isAdmin) {
      await msgService.sendMessage(chatId, voice.caption, { format: MessageFormat.HTML });
    }

    trackActivityAsync(user.id, 'voice_summary_generated', {
      duration_seconds: voice.durationSeconds,
    });
    incrementUsage(user.id, 'voiceSummaries').catch(err =>
      console.error('[Subscription] Failed to increment voice usage:', err)
    );

    console.log(`[Voice] Voice message sent successfully to user ${chatId}`);
  } catch (error) {
    console.error(`[Voice] Voice generation failed for user ${chatId}:`, error);

    if (stopTyping) stopTyping();

    // A 403 from Telegram means this chat will never accept our messages again. It is
    // not a voice-generation fault and there is nothing an admin can act on, so record
    // it and stay quiet - otherwise every scheduled run pages about the same user
    // forever. Checked before the apology below, which would simply be a third 403.
    const { isUnreachableError, describeDeliveryError } = await import('../../lib/delivery-errors');
    if (isUnreachableError(error)) {
      const { markUserUnreachable } = await import('../../lib/user-reachability');
      await markUserUnreachable(user.id, describeDeliveryError(error));
      return;
    }

    try {
      const { getBotMessages } = await import('../../lib/bot-messages');
      const t = await getBotMessages(userLanguage);
      const errorText = t.errors?.voiceGenerationFailed || 'Voice message unavailable — your text summary is above.';
      await msgService.sendMessage(chatId, errorText);
    } catch (sendErr) {
      console.error('[Voice] Failed to send error message:', sendErr);
    }

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Voice Generation',
      // Previously this asserted "Text summary was delivered successfully" as a
      // hardcoded string. It was not a check, and in the blocked-user case the text
      // send had already failed - so the warning reported a failure as a success.
      `Failed to generate voice message:\n${describeDeliveryError(error)}`,
      { userId: user.id, name: user.name }
    );
  } finally {
    if (voiceFilePath) {
      const { cleanupVoiceFile } = await import('../voice-generator');
      await cleanupVoiceFile(voiceFilePath).catch(err =>
        console.warn('[Voice] Voice file cleanup failed:', err)
      );
    }
  }
}

/**
 * Send a voice message for weekly summary (lookahead/next week)
 * Uses the weekly show (or the weekly condenser for languages without hosts)
 */
export async function sendWeeklyVoiceMessage(
  chatId: number | string,
  summary: string,
  user: UserConfig,
  isNextWeek: boolean = false,
  service?: IMessagingService,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  waMessageId?: string
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || (platform === MessagingPlatform.WHATSAPP
    ? getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP)
    : getMessagingService());
  const userLanguage = user.language || 'en';

  // Resolve WA message ID from Redis if not provided
  let msgId = waMessageId;
  if (!msgId && platform === MessagingPlatform.WHATSAPP) {
    const { redis } = await import('../../utils/redis');
    const { REDIS_KEYS } = await import('../../config/redis-keys');
    msgId = await redis.get<string>(REDIS_KEYS.waLastMsg(String(chatId))) || undefined;
  }

  const stopTyping = startTypingInterval(chatId, msgService, platform === MessagingPlatform.WHATSAPP ? 'text' : 'audio', msgId);

  try {
    console.log(`[Voice] Generating weekly voice message for user ${chatId}...`);

    const voice = await produceVoice(summary, user, 'weekly', isNextWeek);
    voiceFilePath = voice.filePath;

    if (stopTyping) stopTyping();

    // Send voice via platform-agnostic service
    await msgService.sendVoice(chatId, voiceFilePath);

    // Send admin caption as separate text
    if (voice.caption && user.isAdmin) {
      await msgService.sendMessage(chatId, voice.caption, { format: MessageFormat.HTML });
    }

    console.log(`[Voice] Weekly voice message sent successfully to user ${chatId}`);
  } catch (error) {
    console.error(`[Voice] Weekly voice generation failed for user ${chatId}:`, error);

    if (stopTyping) stopTyping();

    // Same terminal-403 handling as sendVoiceMessage above.
    const { isUnreachableError: isUnreachableWeekly, describeDeliveryError: describeWeekly } =
      await import('../../lib/delivery-errors');
    if (isUnreachableWeekly(error)) {
      const { markUserUnreachable } = await import('../../lib/user-reachability');
      await markUserUnreachable(user.id, describeWeekly(error));
      return;
    }

    try {
      const { getBotMessages } = await import('../../lib/bot-messages');
      const t = await getBotMessages(userLanguage);
      const errorText = t.errors?.voiceGenerationFailed || 'Voice message unavailable — your text summary is above.';
      await msgService.sendMessage(chatId, errorText);
    } catch (sendErr) {
      console.error('[Voice] Failed to send error message:', sendErr);
    }

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Weekly Voice Generation',
      `Failed to generate weekly voice message:\n${describeWeekly(error)}`,
      { userId: user.id, name: user.name }
    );
  } finally {
    if (voiceFilePath) {
      const { cleanupVoiceFile } = await import('../voice-generator');
      await cleanupVoiceFile(voiceFilePath).catch(err =>
        console.warn('[Voice] Voice file cleanup failed:', err)
      );
    }
  }
}
