/**
 * Telegram voice message functions
 * 2-step pipeline: LLM condenses summary text, then Gemini TTS speaks it
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

/**
 * Generate and send voice version of summary
 * Step 1: LLM condenses the summary via generateAICompletion
 * Step 2: Gemini TTS speaks the condensed plain text
 *
 * Shows animated progress that gets deleted when voice arrives (optional)
 * Non-blocking - errors logged but don't affect text summary delivery
 */
export async function sendVoiceMessage(
  chatId: number | string,
  summary: string,
  user: UserConfig,
  service?: IMessagingService,
  showProgress: boolean = true,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  waMessageId?: string
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || (platform === MessagingPlatform.WHATSAPP
    ? getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP)
    : getMessagingService());
  const userLanguage = user.language || 'en';

  // Start audio typing indicator if enabled (TG only — WA typing handled by early fire in deliverSummary)
  let stopTyping: (() => void) | null = null;
  if (showProgress && platform !== MessagingPlatform.WHATSAPP) {
    stopTyping = startTypingInterval(chatId, msgService, 'audio');
  }

  try {
    const { generateVoiceMessage } = await import('../voice-generator');
    const { buildVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
    const { generateAICompletion } = await import('../ai-provider');

    console.log(`[Voice] Generating voice message for user ${chatId}...`);

    const spouseCalendar = user.calendarAssignments?.find(cal =>
      cal.labels.includes('spouse')
    );
    const spouseName = spouseCalendar?.personName;

    const hasKidsCalendars = user.calendarAssignments?.some(cal =>
      cal.labels.includes('kids')
    ) ?? false;

    // Step 1: Condense summary via LLM
    const condenserContext: VoiceCondenserContext = {
      summary,
      locale: userLanguage,
      userName: user.name,
      spouseName,
      hasKidsCalendars,
      culture: user.culture,
      globalRules: user.globalRules,
    };
    const condenserPrompt = buildVoiceCondenserPrompt(condenserContext);
    const condensedResult = await generateAICompletion(condenserPrompt);
    const condensedText = condensedResult.text;

    console.log(`[Voice] Summary condensed: ${summary.length} → ${condensedText.length} chars`);

    // Step 2: Generate voice from condensed text
    const ttsResult = await generateVoiceMessage(condensedText, userLanguage, user.voicePreference);
    voiceFilePath = ttsResult.filePath;

    const { ttsMs, ttsModel, voiceName } = ttsResult;

    // Stop typing indicator
    if (stopTyping) stopTyping();

    // Send voice via platform-agnostic service
    await msgService.sendVoice(chatId, voiceFilePath!);

    // Send admin caption as separate text (WhatsApp doesn't support captions on audio)
    const caption = formatVoiceCaption(condensedResult, ttsMs, ttsModel, user.isAdmin, voiceName);
    if (caption && user.isAdmin) {
      await msgService.sendMessage(chatId, caption, { format: MessageFormat.HTML });
    }

    trackActivityAsync(user.id, 'voice_summary_generated', {
      duration_seconds: Math.ceil(condensedText.length / 15),
    });
    incrementUsage(user.id, 'voiceSummaries').catch(err =>
      console.error('[Subscription] Failed to increment voice usage:', err)
    );

    console.log(`[Voice] Voice message sent successfully to user ${chatId}`);
  } catch (error) {
    console.error(`[Voice] Voice generation failed for user ${chatId}:`, error);

    if (stopTyping) stopTyping();

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
      `Failed to generate voice message:\n${error instanceof Error ? error.message : 'Unknown error'}\n\nText summary was delivered successfully.`
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
 * Uses weekly-specific TTS prompts via single Gemini call
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

  // TG only — WA typing handled by early fire in deliverSummary
  const stopTyping = platform !== MessagingPlatform.WHATSAPP
    ? startTypingInterval(chatId, msgService, 'audio')
    : null;

  try {
    const { generateVoiceMessage } = await import('../voice-generator');
    const { buildWeeklyVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
    const { generateAICompletion } = await import('../ai-provider');

    console.log(`[Voice] Generating weekly voice message for user ${chatId}...`);

    const spouseCalendar = user.calendarAssignments?.find(cal =>
      cal.labels.includes('spouse')
    );
    const spouseName = spouseCalendar?.personName;

    const hasKidsCalendars = user.calendarAssignments?.some(cal =>
      cal.labels.includes('kids')
    ) ?? false;

    const condenserContext: VoiceCondenserContext = {
      summary,
      locale: userLanguage,
      userName: user.name,
      spouseName,
      hasKidsCalendars,
      culture: user.culture,
      globalRules: user.globalRules,
      isNextWeek,
    };
    const condenserPrompt = buildWeeklyVoiceCondenserPrompt(condenserContext);
    const condensedResult = await generateAICompletion(condenserPrompt);
    const condensedText = condensedResult.text;

    console.log(`[Voice] Weekly summary condensed: ${summary.length} → ${condensedText.length} chars`);

    const ttsResult = await generateVoiceMessage(condensedText, userLanguage, user.voicePreference);
    voiceFilePath = ttsResult.filePath;

    const { ttsMs, ttsModel, voiceName } = ttsResult;

    if (stopTyping) stopTyping();

    // Send voice via platform-agnostic service
    await msgService.sendVoice(chatId, voiceFilePath!);

    // Send admin caption as separate text
    const caption = formatVoiceCaption(condensedResult, ttsMs, ttsModel, user.isAdmin, voiceName);
    if (caption && user.isAdmin) {
      await msgService.sendMessage(chatId, caption, { format: MessageFormat.HTML });
    }

    console.log(`[Voice] Weekly voice message sent successfully to user ${chatId}`);
  } catch (error) {
    console.error(`[Voice] Weekly voice generation failed for user ${chatId}:`, error);

    if (stopTyping) stopTyping();

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
      `Failed to generate weekly voice message:\n${error instanceof Error ? error.message : 'Unknown error'}\n\nText summary was delivered successfully.`
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
