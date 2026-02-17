/**
 * Telegram voice message functions
 * Generates and sends voice versions of summaries
 */

import { UserConfig } from '../../types';
import { IMessagingService } from '../messaging';
import { sendProgressWithAnimation } from '../progress-message';
import { getBot, getMessagingService } from './bot';
import { trackActivityAsync } from '../analytics-service';
import { incrementUsage } from '../subscription-service';
import type { VoiceCondenserContext } from '../../prompts/voice-condenser';

/**
 * Generate and send voice version of summary
 * Shows animated progress that gets deleted when voice arrives (optional)
 * Non-blocking - errors logged but don't affect text summary delivery
 */
export async function sendVoiceMessage(
  userId: number,
  summary: string,
  user: UserConfig,
  modelId?: string,
  service?: IMessagingService,
  showProgress: boolean = true
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || getMessagingService();
  const userLanguage = user.language || 'en';

  // Start voice progress animation (if enabled)
  let messageId: number | string | null = null;
  let stopAnimation: (() => void) | null = null;

  if (showProgress) {
    const progress = await sendProgressWithAnimation(
      userId,
      'voice',
      userLanguage,
      msgService
    );
    messageId = progress.messageId;
    stopAnimation = progress.stopAnimation;
  }

  try {
    const { generateVoiceMessage, cleanupVoiceFile } = await import('../voice-generator');
    const { buildVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
    const { generateAICompletion } = await import('../ai-provider');

    console.log(`Generating voice message for user ${userId}...`);

    // Extract spouse name from calendar assignments
    const spouseCalendar = user.calendarAssignments?.find(cal =>
      cal.labels.includes('spouse')
    );
    const spouseName = spouseCalendar?.personName;

    // Check if user has kids calendars
    const hasKidsCalendars = user.calendarAssignments?.some(cal =>
      cal.labels.includes('kids')
    ) ?? false;

    // Build voice condenser context
    const condenserContext: VoiceCondenserContext = {
      summary,
      locale: userLanguage,
      userName: user.name,
      spouseName,
      hasKidsCalendars,
      culture: user.culture,
      globalRules: user.globalRules,
    };

    // Step 1: Condense summary for voice (ultra-brief, 30-45 seconds)
    const condenserPrompt = buildVoiceCondenserPrompt(condenserContext);
    const condensedResult = await generateAICompletion(condenserPrompt, modelId);
    const condensedSummary = condensedResult.text;

    console.log(`Voice summary condensed: ${summary.length} → ${condensedSummary.length} chars`);

    // Step 2: Generate voice file from condensed summary
    voiceFilePath = await generateVoiceMessage(condensedSummary, userLanguage);

    // Stop animation and delete progress message (if shown)
    if (stopAnimation) stopAnimation();
    if (messageId) await msgService.deleteMessage(userId, messageId);

    // Send as voice message to Telegram
    const botInstance = getBot();
    await botInstance.sendVoice(userId, voiceFilePath, {}, {
      contentType: 'audio/ogg'
    });

    // Track voice summary generated and increment usage (use internal DB user.id)
    trackActivityAsync(user.id, 'voice_summary_generated', {
      duration_seconds: Math.ceil(condensedSummary.length / 15), // Rough estimate
    });
    incrementUsage(user.id, 'voiceSummaries').catch(err =>
      console.error('[Subscription] Failed to increment voice usage:', err)
    );

    console.log(`Voice message sent successfully to user ${userId}`);
  } catch (error) {
    // Stop animation on error (if shown)
    if (stopAnimation) stopAnimation();
    // Delete progress message on error too (if shown)
    if (messageId) await msgService.deleteMessage(userId, messageId);

    console.error(`Voice generation failed for user ${userId}:`, error);

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
        console.warn('Voice file cleanup failed:', err)
      );
    }
  }
}

/**
 * Send a voice message for weekly summary (lookahead/next week)
 * Uses weekly-specific voice condensing prompts
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

  // Start voice progress animation
  const progress = await sendProgressWithAnimation(
    userId,
    'voice',
    userLanguage,
    msgService
  );
  const { messageId, stopAnimation } = progress;

  try {
    const { generateVoiceMessage, cleanupVoiceFile } = await import('../voice-generator');
    const { buildWeeklyVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
    const { generateAICompletion } = await import('../ai-provider');

    console.log(`Generating weekly voice message for user ${userId}...`);

    // Extract spouse name from calendar assignments
    const spouseCalendar = user.calendarAssignments?.find(cal =>
      cal.labels.includes('spouse')
    );
    const spouseName = spouseCalendar?.personName;

    // Check if user has kids calendars
    const hasKidsCalendars = user.calendarAssignments?.some(cal =>
      cal.labels.includes('kids')
    ) ?? false;

    // Build voice condenser context
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

    // Step 1: Condense summary for voice (ultra-brief, 30-45 seconds)
    const condenserPrompt = buildWeeklyVoiceCondenserPrompt(condenserContext);
    const condensedResult = await generateAICompletion(condenserPrompt);
    const condensedSummary = condensedResult.text;

    console.log(`Weekly voice summary condensed: ${summary.length} → ${condensedSummary.length} chars`);

    // Step 2: Generate voice file from condensed summary
    voiceFilePath = await generateVoiceMessage(condensedSummary, userLanguage);

    // Stop animation and delete progress message before sending voice
    stopAnimation();
    await msgService.deleteMessage(userId, messageId);

    // Send as voice message to Telegram
    const botInstance = getBot();
    await botInstance.sendVoice(userId, voiceFilePath, {}, {
      contentType: 'audio/ogg'
    });

    console.log(`Weekly voice message sent successfully to user ${userId}`);
  } catch (error) {
    // Stop animation on error
    stopAnimation();
    // Delete progress message on error too
    await msgService.deleteMessage(userId, messageId);

    console.error(`Weekly voice generation failed for user ${userId}:`, error);

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
        console.warn('Voice file cleanup failed:', err)
      );
    }
  }
}
