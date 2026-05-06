// Modality-mirrored TTS for outcome messages (PR 12).
//
// When the user dictated a voice message and the bot just completed a CRUD
// (create / edit / delete success), we speak the 1-2-sentence outcome back
// via Gemini TTS. Text-input flows continue with text-only outcomes.
//
// Difference from telegram/voice.ts:sendVoiceMessage: this path SKIPS the
// LLM condensation step. The outcome line is already short and crafted by
// the caller; passing it directly to TTS keeps cost down and latency low.

import { UserConfig } from '../../types';
import type { IMessagingService } from '../messaging/types';
import { captureError } from '../../lib/error-capture';

export function isTtsOutcomeEnabled(): boolean {
  // Gated for the same reason as auto-create: this is a new audio path on
  // every CRUD; the env flag lets ops turn it on after observing TTS cost.
  return process.env.VOICE_TTS_OUTCOME === 'true';
}

/**
 * Generate and send a short TTS outcome line. Best-effort — failures are
 * logged but never thrown; the user already saw the text outcome from the
 * caller, so a missing audio reply is just a silent no-op.
 */
export async function speakOutcome(
  chatId: number | string,
  spokenLine: string,
  user: UserConfig,
  service: IMessagingService
): Promise<void> {
  if (!isTtsOutcomeEnabled()) return;
  if (!spokenLine.trim()) return;

  try {
    const { generateVoiceMessage, cleanupVoiceFile } = await import('../voice-generator');
    const result = await generateVoiceMessage(
      spokenLine,
      user.language || 'en',
      user.voicePreference,
      user.voiceStyle
    );
    try {
      await service.sendVoice(chatId, result.filePath);
    } finally {
      // Local-generation paths leave a /tmp file; remote TTS handles its own.
      cleanupVoiceFile(result.filePath).catch(() => {});
    }
  } catch (err) {
    captureError(err, 'voice-tts-outcome', { user_id: user.id }, 'warning');
  }
}

/**
 * Build a short, naturally-spoken outcome line for a CRUD result. Caller
 * passes the action and the title; we keep the sentence simple so TTS is
 * cheap and the audio is unambiguous.
 */
export function formatOutcomeLine(
  action: 'created' | 'updated' | 'removed',
  title: string,
  language: string
): string {
  // Keep sentences fragmented so TTS sounds natural in each language.
  switch (language) {
    case 'he':
      switch (action) {
        case 'created': return `סבבה. הוספתי את ${title}.`;
        case 'updated': return `עדכנתי את ${title}.`;
        case 'removed': return `הסרתי את ${title}.`;
      }
      break;
    case 'ru':
      switch (action) {
        case 'created': return `Готово. Добавил ${title}.`;
        case 'updated': return `Обновил ${title}.`;
        case 'removed': return `Удалил ${title}.`;
      }
      break;
    default:
      switch (action) {
        case 'created': return `Done. Added ${title}.`;
        case 'updated': return `Updated ${title}.`;
        case 'removed': return `Removed ${title}.`;
      }
  }
  return `Done.`;
}
