/**
 * Telegram voice message functions
 * 2-step pipeline: LLM condenses summary text, then Gemini TTS speaks it
 */

import { UserConfig } from '../../types';
import { IMessagingService } from '../messaging';
import { sendAnimatedProgress } from '../progress-message';
import { getBot, getMessagingService } from './bot';
import { trackActivityAsync } from '../analytics-service';
import { incrementUsage } from '../subscription-service';
import { formatVoiceCaption } from '../../utils/ai-footer';
import type { AICompletionResult } from '../ai-provider';
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
  userId: number,
  summary: string,
  user: UserConfig,
  service?: IMessagingService,
  showProgress: boolean = true
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || getMessagingService();
  const userLanguage = user.language || 'en';

  // Send animated hourglass progress (if enabled)
  let messageId: number | string | null = null;

  if (showProgress) {
    messageId = await sendAnimatedProgress(userId, 'voice', userLanguage, msgService);
  }

  try {
    const { generateVoiceMessage } = await import('../voice-generator');
    const { buildVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
    const { generateAICompletion } = await import('../ai-provider');

    console.log(`[Voice] Generating voice message for user ${userId}...`);

    // Extract spouse name from calendar assignments
    const spouseCalendar = user.calendarAssignments?.find(cal =>
      cal.labels.includes('spouse')
    );
    const spouseName = spouseCalendar?.personName;

    // Check if user has kids calendars
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

    // Delete progress message
    if (messageId) await msgService.deleteMessage(userId, messageId);

    // Send as voice message to Telegram with optional admin caption
    const botInstance = getBot();
    const caption = formatVoiceCaption(condensedResult, ttsMs, ttsModel, user.isAdmin, voiceName);
    await botInstance.sendVoice(userId, voiceFilePath!, {
      ...(caption && { caption, parse_mode: 'HTML' as const }),
    }, {
      contentType: 'audio/ogg'
    });

    // Track voice summary generated and increment usage (use internal DB user.id)
    trackActivityAsync(user.id, 'voice_summary_generated', {
      duration_seconds: Math.ceil(condensedText.length / 15), // ~15 chars/sec speech rate
    });
    incrementUsage(user.id, 'voiceSummaries').catch(err =>
      console.error('[Subscription] Failed to increment voice usage:', err)
    );

    console.log(`[Voice] Voice message sent successfully to user ${userId}`);
  } catch (error) {
    console.error(`[Voice] Voice generation failed for user ${userId}:`, error);

    // Replace progress message with friendly error instead of deleting
    if (messageId) {
      try {
        const { getBotMessages } = await import('../../lib/bot-messages');
        const t = await getBotMessages(userLanguage);
        const errorText = t.errors?.voiceGenerationFailed || 'Voice message unavailable — your text summary is above.';
        await msgService.updateMessage(userId, messageId, errorText);
      } catch (updateErr) {
        console.error('[Voice] Failed to update progress with error:', updateErr);
      }
    }

    // Notify admin but don't interrupt user experience
    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Voice Generation',
      `Failed to generate voice message:\n${error instanceof Error ? error.message : 'Unknown error'}\n\nText summary was delivered successfully.`
    );
  } finally {
    // Always attempt cleanup
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
  userId: number,
  summary: string,
  user: UserConfig,
  isNextWeek: boolean = false,
  service?: IMessagingService
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || getMessagingService();
  const userLanguage = user.language || 'en';

  // Send animated hourglass progress
  const messageId = await sendAnimatedProgress(userId, 'voice', userLanguage, msgService);

  try {
    const { generateVoiceMessage } = await import('../voice-generator');
    const { buildWeeklyVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
    const { generateAICompletion } = await import('../ai-provider');

    console.log(`[Voice] Generating weekly voice message for user ${userId}...`);

    // Extract spouse name from calendar assignments
    const spouseCalendar = user.calendarAssignments?.find(cal =>
      cal.labels.includes('spouse')
    );
    const spouseName = spouseCalendar?.personName;

    // Check if user has kids calendars
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
      isNextWeek,
    };
    const condenserPrompt = buildWeeklyVoiceCondenserPrompt(condenserContext);
    const condensedResult = await generateAICompletion(condenserPrompt);
    const condensedText = condensedResult.text;

    console.log(`[Voice] Weekly summary condensed: ${summary.length} → ${condensedText.length} chars`);

    // Step 2: Generate voice from condensed text
    const ttsResult = await generateVoiceMessage(condensedText, userLanguage, user.voicePreference);
    voiceFilePath = ttsResult.filePath;

    const { ttsMs, ttsModel, voiceName } = ttsResult;

    // Delete progress message before sending voice
    await msgService.deleteMessage(userId, messageId);

    // Send as voice message to Telegram with optional admin caption
    const botInstance = getBot();
    const caption = formatVoiceCaption(condensedResult, ttsMs, ttsModel, user.isAdmin, voiceName);
    await botInstance.sendVoice(userId, voiceFilePath!, {
      ...(caption && { caption, parse_mode: 'HTML' as const }),
    }, {
      contentType: 'audio/ogg'
    });

    console.log(`[Voice] Weekly voice message sent successfully to user ${userId}`);
  } catch (error) {
    console.error(`[Voice] Weekly voice generation failed for user ${userId}:`, error);

    // Replace progress message with friendly error instead of deleting
    try {
      const { getBotMessages } = await import('../../lib/bot-messages');
      const t = await getBotMessages(userLanguage);
      const errorText = t.errors?.voiceGenerationFailed || 'Voice message unavailable — your text summary is above.';
      await msgService.updateMessage(userId, messageId, errorText);
    } catch (updateErr) {
      console.error('[Voice] Failed to update progress with error:', updateErr);
    }

    // Notify admin but don't interrupt user experience
    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Weekly Voice Generation',
      `Failed to generate weekly voice message:\n${error instanceof Error ? error.message : 'Unknown error'}\n\nText summary was delivered successfully.`
    );
  } finally {
    // Always attempt cleanup
    if (voiceFilePath) {
      const { cleanupVoiceFile } = await import('../voice-generator');
      await cleanupVoiceFile(voiceFilePath).catch(err =>
        console.warn('[Voice] Voice file cleanup failed:', err)
      );
    }
  }
}
