/**
 * Voice dispatch via QStash
 * Publishes voice generation requests to a separate Vercel function
 */

import { getQStashClient } from '../../lib/qstash-client';
import { buildUrl } from '../../config/urls';

export type VoiceType = 'daily' | 'weekly' | 'weather';

interface VoicePayload {
  telegramId: number;
  text: string;
  voiceType: VoiceType;
  isNextWeek?: boolean;
}

/**
 * Dispatch voice generation to a separate function via QStash.
 * Non-blocking — catches all errors, logs them, and notifies admin.
 */
export async function dispatchVoiceGeneration(
  telegramId: number,
  text: string,
  voiceType: VoiceType,
  isNextWeek?: boolean
): Promise<void> {
  try {
    const client = getQStashClient();
    if (!client) {
      console.error('[VoiceDispatch] QStash client not configured, skipping voice dispatch');
      return;
    }

    const payload: VoicePayload = { telegramId, text, voiceType };
    if (isNextWeek !== undefined) {
      payload.isNextWeek = isNextWeek;
    }

    const url = buildUrl('/api/voice-generate');

    await client.publishJSON({
      url,
      body: payload,
    });

    console.log(`[VoiceDispatch] Dispatched ${voiceType} voice for user ${telegramId}`);
  } catch (error) {
    console.error(`[VoiceDispatch] Failed to dispatch voice for user ${telegramId}:`, error);

    try {
      const { notifyAdminWarning } = await import('../../utils/error-notifier');
      await notifyAdminWarning(
        'Voice Dispatch',
        `Failed to dispatch ${voiceType} voice generation for user ${telegramId}:\n${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } catch (notifyErr) {
      console.error('[VoiceDispatch] Failed to notify admin:', notifyErr);
    }
  }
}
