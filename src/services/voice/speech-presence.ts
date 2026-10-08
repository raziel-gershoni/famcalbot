/**
 * Does a voice note actually contain speech?
 *
 * Without this, non-speech audio became calendar actions. Measured through the real
 * extraction path: 7 kinds of non-speech clip (digital silence, room tone, an
 * accidental tap, pocket rustle, noise, a tone, music) produced a create, edit or
 * delete in 21 of 21 runs, on both 3.7 and 3.8, all at confidence "high" - often
 * naming the user's real recent events ("cancel the shift").
 *
 * Two mechanisms, so two gates:
 *
 * - Near-silent audio makes the model hear words whatever it is asked. Even a bare
 *   "transcribe or say [NO_SPEECH]" prompt invented sentences for silence. Telling
 *   the extraction prompt "never invent words" changed nothing. So quiet audio is
 *   rejected acoustically, before any model call.
 *
 * - Loud non-speech the model judges correctly when asked on its own, but the
 *   extraction prompt - command examples, calendar names, recent events - primes it
 *   to hear a command anyway. So presence is asked separately, with no calendar
 *   context, alongside extraction.
 *
 * Both fail open: if a check cannot run, the audio is treated as speech. Dropping a
 * real command because a gate broke would be worse than the bug.
 */

import { ThinkingLevel } from '@google/genai';
import { getGemini } from '../ai-provider';

export { isSilent, measureLoudnessDbfs, SILENCE_THRESHOLD_DBFS } from './audio-level';

/** Result marker for "the voice note had no speech" - see VoiceIntentResult.error. */
export const NO_SPEECH = 'no_speech';

const SPEECH_GATE_TIMEOUT_MS = 15_000;
const SPEECH_QUESTION =
  'Does this audio contain human speech (spoken words)? Answer with exactly one word: YES or NO.';

/**
 * Ask the model, with no calendar context, whether the clip contains speech.
 * Resolves false only on a clear NO. Never rejects - it is awaited after extraction
 * has already started, so a rejection here must not surface as an unhandled error.
 */
export async function detectSpeech(ogg: Buffer, modelId: string): Promise<boolean> {
  try {
    const response = await getGemini().models.generateContent({
      model: modelId,
      contents: [{
        role: 'user',
        parts: [
          { text: SPEECH_QUESTION },
          { inlineData: { mimeType: 'audio/ogg', data: ogg.toString('base64') } },
        ],
      }],
      config: {
        // LOW is accepted by every model in the catalog; MINIMAL is not.
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        // Thinking tokens count against this, so leave room beyond the one-word answer.
        maxOutputTokens: 1024,
        abortSignal: AbortSignal.timeout(SPEECH_GATE_TIMEOUT_MS),
      },
    });
    const answer = (response.text ?? '').trim().toUpperCase();
    // Anything other than a clear NO - YES, an empty reply, a hedge - counts as speech.
    return !(/\bNO\b/.test(answer) && !/\bYES\b/.test(answer));
  } catch (error) {
    console.warn('[SpeechGate] Check failed, treating audio as speech:', error);
    return true;
  }
}
