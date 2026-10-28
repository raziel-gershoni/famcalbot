// Modality-mirrored TTS for outcome messages (PR 12).
//
// When the user dictated a voice message and the bot just completed a CRUD
// (create / edit / delete success), we speak the 1-2-sentence outcome back
// via Gemini TTS, in the voice of the language's show anchor.
// Text-input flows continue with text-only outcomes.
//
// Difference from telegram/voice.ts:sendVoiceMessage: this path SKIPS the
// LLM condensation step. The outcome line is already short and crafted by
// the caller; passing it directly to TTS keeps cost down and latency low.

import { UserConfig } from '../../types';
import type { IMessagingService } from '../messaging/types';
import type { ParsedEvent } from '../event-parser';
import type { ReminderCreator } from '../native-reminders/resolve';
import { captureError } from '../../lib/error-capture';
import { reminderCreatedLine } from './confirmations';

/**
 * Read-through cached AdminSettings flag (voiceTtsOutcome). Admin can flip
 * on/off from the panel without redeploys; defaults false so this is a
 * no-op on first deploy.
 */
export async function isTtsOutcomeEnabled(): Promise<boolean> {
  const { getVoiceTtsOutcome } = await import('../reminder-cache');
  return getVoiceTtsOutcome();
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
  if (!(await isTtsOutcomeEnabled())) return;
  if (!spokenLine.trim()) return;

  try {
    const language = user.language || 'en';
    const { generateVoiceMessage, cleanupVoiceFile } = await import('../voice-generator');
    // The single voice is the show's anchor, so the bot sounds the same in summaries
    // and replies.
    const result = await generateVoiceMessage(spokenLine, language);
    try {
      await service.sendVoice(chatId, result.filePath);
    } finally {
      // The voice note is a /tmp file; remove it once sent.
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

/**
 * The spoken outcome for a created reminder: the reply's own line ("I'll remind Dana
 * tomorrow at 10:00"), read without its emoji, then what it is about.
 */
export async function formatReminderOutcomeLine(event: ParsedEvent, language: string, timezone: string, creator?: ReminderCreator): Promise<string> {
  const line = await reminderCreatedLine(event, language, timezone, false, creator);
  return `${line.replace(/^⏰\s*/u, '')} ${event.title}.`;
}
