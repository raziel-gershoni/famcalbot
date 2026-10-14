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
 * Speech from a TV or radio passes both, and a promo naming a day and a time became a
 * medium-confidence create. So whether the speech was meant for the device is asked
 * the same way. On a NO gemini-voice drops actions parsed below "high", and a "high"
 * one is kept only for the user to confirm.
 *
 * All fail open: if a check cannot run, its answer is taken as YES. Dropping a
 * real command because a gate broke would be worse than the bug.
 */

import { ThinkingLevel } from '@google/genai';
import { getGemini } from '../ai-provider';
import { getExtractionThinkingLevel } from '../../config/ai-models';

export { isSilent, loudestWindowDbfs, SILENCE_THRESHOLD_DBFS } from './audio-level';

/** Result marker for "the voice note had no speech" - see VoiceIntentResult.error. */
export const NO_SPEECH = 'no_speech';

const SPEECH_GATE_TIMEOUT_MS = 15_000;
const SPEECH_QUESTION =
  'Does this audio contain human speech (spoken words)? Answer with exactly one word: YES or NO.';
const ADDRESSED_QUESTION =
  'Is a person in this recording speaking to the device - giving a request, a command or a note meant for an assistant? ' +
  'Answer NO if the only speech is background audio not addressed to the device, such as a TV, radio, video, announcement or other people talking among themselves. ' +
  'Quiet, distant or noisy speech still counts if it is addressed to the device. Answer with exactly one word: YES or NO.';

/**
 * Ask the model, with no calendar context, whether the clip contains speech.
 * Resolves false only on a clear NO. Never rejects - it is awaited after extraction
 * has already started, so a rejection here must not surface as an unhandled error.
 */
export function detectSpeech(ogg: Buffer, modelId: string): Promise<boolean> {
  return askYesNo(ogg, modelId, SPEECH_QUESTION);
}

/**
 * Ask the model, with no calendar context, whether the speech was meant for the device.
 * TV, radio and other background talk is speech, so detectSpeech passes it, and the
 * extraction prompt turns a promo naming a day and a time into an event. Resolves false
 * only on a clear NO, and never rejects, like detectSpeech.
 */
export function detectAddressedSpeech(ogg: Buffer, modelId: string): Promise<boolean> {
  return askYesNo(ogg, modelId, ADDRESSED_QUESTION);
}

/** A one-word question about the clip. Anything but a clear NO - or a failed call - is YES. */
async function askYesNo(ogg: Buffer, modelId: string, question: string): Promise<boolean> {
  const level = getExtractionThinkingLevel(modelId);
  try {
    const response = await getGemini().models.generateContent({
      model: modelId,
      contents: [{
        role: 'user',
        parts: [
          { text: question },
          { inlineData: { mimeType: 'audio/ogg', data: ogg.toString('base64') } },
        ],
      }],
      config: {
        // The same level as extraction.
        ...(level && { thinkingConfig: { thinkingLevel: ThinkingLevel[level] } }),
        // Thinking tokens count against this. Running out leaves no answer, which reads
        // as YES, so leave room well beyond the one-word answer.
        maxOutputTokens: 8192,
        abortSignal: AbortSignal.timeout(SPEECH_GATE_TIMEOUT_MS),
      },
    });
    const answer = (response.text ?? '').trim().toUpperCase();
    // Anything other than a clear NO - YES, an empty reply, a hedge - counts as YES.
    return !(/\bNO\b/.test(answer) && !/\bYES\b/.test(answer));
  } catch (error) {
    console.warn('[SpeechGate] Check failed, treating the answer as YES:', error);
    return true;
  }
}
