/**
 * Turns a text summary into the two-host show voice note: writer → validator →
 * pointing → TTS (remote or local) → OGG. If a host voice is missing from the Gemini
 * project, the same script is read by the single narrator and admins get one alert a
 * day. Any other failure propagates to the caller's "voice unavailable" path.
 */

import type { UserConfig } from '../../types';
import { hasShowPrompt } from '../../prompts/voice-show';
import { formatShowCaption, formatVoiceCaption } from '../../utils/ai-footer';
import { isVoiceMissingError } from '../gemini-tts';
import { generateShowVoice, generateVoiceMessage, getShowVoices, type ShowVoiceDeps } from '../voice-generator';
import { buildShowContext } from './context';
import { scriptToNarration, toShowLines } from './script';
import type { ProducedVoice, ShowKind } from './types';
import { writeShowScript, type CompletionFn } from './writer';

/** A language gets the show when it has both a writer prompt and host voices. */
export function isShowLanguage(language: string): boolean {
  return hasShowPrompt(language) && getShowVoices(language) !== null;
}

/** Test seams for the LLM, the per-line TTS call and the narrator fallback. */
export interface ProduceShowDeps {
  complete?: CompletionFn;
  synthesize?: ShowVoiceDeps['synthesize'];
  narrate?: typeof generateVoiceMessage;
}

export async function produceShowVoice(
  summary: string,
  user: UserConfig,
  kind: ShowKind,
  isNextWeek = false,
  deps: ProduceShowDeps = {},
): Promise<ProducedVoice> {
  const language = user.language || 'en';
  const context = buildShowContext(summary, user, kind, isNextWeek);
  const written = await writeShowScript(context, { complete: deps.complete });
  const { turns, warnings } = written.script;
  if (warnings.length) console.warn(`[VoiceShow] Script repaired for user ${user.id}:`, warnings);
  console.log(`[VoiceShow] ${kind} script for user ${user.id}: ${turns.length} turns from ${summary.length} chars`);

  try {
    const show = await generateShowVoice(toShowLines(turns, language, context.listener.gender), language, {
      synthesize: deps.synthesize,
    });
    return {
      filePath: show.filePath,
      caption: formatShowCaption(written.completion, written.attempts, show, user.isAdmin),
      durationSeconds: Math.max(1, Math.round(show.audioSeconds)),
    };
  } catch (error) {
    if (!isVoiceMissingError(error)) throw error;
    await alertVoiceMissing(language, error);

    const narration = scriptToNarration(turns, language, context.listener.gender);
    const tts = await (deps.narrate ?? generateVoiceMessage)(narration, language);
    const caption = formatVoiceCaption(written.completion, tts.ttsMs, tts.ttsModel, user.isAdmin, tts.voiceName);
    return {
      filePath: tts.filePath,
      caption: caption && `${caption}\n⚠️ show host voice missing - narrator fallback`,
      durationSeconds: Math.ceil(narration.length / 15),
    };
  }
}

/** One admin warning a day: every show would hit the same missing voice. */
async function alertVoiceMissing(language: string, error: unknown): Promise<void> {
  try {
    const { redis } = await import('../../utils/redis');
    const { REDIS_KEYS } = await import('../../config/redis-keys');
    const day = new Date().toISOString().slice(0, 10);
    const first = await redis.set(REDIS_KEYS.showVoiceMissing(day), '1', { nx: true, ex: 26 * 3600 });
    if (first !== 'OK') return;

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Voice Show',
      `A show host voice for "${language}" was not found, so shows fall back to the single narrator.\n` +
        'Check GEMINI_SHOW_VOICE_*, and set GEMINI_VOICES_API_KEY (or GEMINI_API_KEY) to a key of the Gemini project holding the designed voices.\n' +
        (error instanceof Error ? error.message : String(error)),
    );
  } catch (alertError) {
    console.error('[VoiceShow] Failed to send the voice-missing alert:', alertError);
  }
}
