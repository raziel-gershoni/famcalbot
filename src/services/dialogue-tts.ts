/**
 * Two-host dialogue synthesis: every line is its own TTS request, run in parallel.
 *
 * The synthesize function is passed in rather than imported, so tests can fake Gemini.
 *
 * Why one request per line rather than one multi-speaker request: in the 2026-10
 * trial with two male voices, a multi-speaker request blurred them and pulled the
 * younger host's pitch toward the older one. Per-line requests were also faster (about
 * 4 s against 11-12 s for 8 lines), drew no 429s at 24 in flight, and let each line
 * carry its own mood style.
 */

import type { SpeechAudio, SynthesizeSpeechInput } from './gemini-tts';

export interface DialogueLine {
  /** Built-in voice name. */
  voice: string;
  text: string;
  style?: string;
}

export interface SynthesizeDialogueInput {
  apiKey: string;
  model: string;
  lines: DialogueLine[];
  synthesize: (input: SynthesizeSpeechInput) => Promise<SpeechAudio>;
  /** Requests in flight at once for this dialogue. Default 8. */
  concurrency?: number;
  /** Per request. A stuck line is retried rather than holding up the whole show. Default 20 s. */
  lineTimeoutMs?: number;
  /** Attempts per line, the first try included. Default 3. */
  maxAttempts?: number;
  /** Backoff before the second attempt; doubles after that. Default 500 ms. */
  baseDelayMs?: number;
  /**
   * Epoch ms by which the whole dialogue must be done. No attempt starts after it and
   * each attempt's timeout is capped at the time left, so a slow Gemini cannot stretch
   * a show past its caller's budget. Without one, only the per-line limits apply.
   */
  deadline?: number;
  /** With less time than this left, fail rather than start a request. Default 2 s. */
  minAttemptMs?: number;
}

export interface DialogueAudio {
  /** One PCM buffer per line, in line order. */
  pcms: Buffer[];
  sampleRate: number;
  /** Output audio tokens summed over the lines that reported them. */
  audioTokens: number;
  /** TTS requests sent, retries included. */
  requests: number;
}

/** The dialogue ran out of time before every line was spoken. `cause` holds the last line error, if any. */
export class DialogueDeadlineError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DialogueDeadlineError';
  }
}

/** 429, 5xx, timeouts, dropped connections and empty responses are worth another try. */
export function isRetryableTtsError(error: unknown): boolean {
  const e = error as { status?: unknown; name?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (typeof e.status === 'number') return e.status === 429 || e.status >= 500;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  if (e.name === 'TypeError' && /fetch failed/i.test(message)) return true;
  return /returned no audio/i.test(message);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function synthesizeDialogue(input: SynthesizeDialogueInput): Promise<DialogueAudio> {
  const { lines } = input;
  if (!lines.length) throw new Error('Dialogue has no lines');

  const concurrency = Math.max(1, Math.floor(input.concurrency ?? 8));
  const lineTimeoutMs = input.lineTimeoutMs ?? 20_000;
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 3));
  const baseDelayMs = input.baseDelayMs ?? 500;
  const { deadline } = input;
  // A Hebrew line takes 1-4 s to synthesize; a request with less time than this would
  // most likely be cut off and only spend a Gemini call.
  const minAttemptMs = input.minAttemptMs ?? 2_000;
  const timeLeft = () => (deadline === undefined ? Infinity : deadline - Date.now());

  const results: SpeechAudio[] = new Array(lines.length);
  let requests = 0;
  let next = 0;
  let failed = false;
  let failure: unknown;

  const runLine = async (index: number): Promise<void> => {
    const line = lines[index];
    for (let attempt = 1; ; attempt++) {
      const left = timeLeft();
      if (left < minAttemptMs) throw new DialogueDeadlineError(`Dialogue deadline reached before line ${index + 1}`);
      requests++;
      try {
        results[index] = await input.synthesize({
          apiKey: input.apiKey,
          model: input.model,
          text: line.text,
          voiceName: line.voice,
          style: line.style,
          timeoutMs: Math.min(lineTimeoutMs, left),
        });
        return;
      } catch (error) {
        // Once any line has failed for good the show is lost, so stop retrying too.
        if (failed || !isRetryableTtsError(error)) throw error;
        const delay = baseDelayMs * 2 ** (attempt - 1);
        // Checked before the attempt count so running out of time is reported as such.
        if (timeLeft() - delay < minAttemptMs) {
          throw new DialogueDeadlineError(`Dialogue deadline reached on line ${index + 1} after ${attempt} attempt(s)`, error);
        }
        if (attempt >= maxAttempts) throw error;
        await sleep(delay);
        // Another line may have failed while this one slept; a retry now would only
        // delay the rejection by a whole request and spend one more Gemini call.
        if (failed) throw failure;
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (!failed && next < lines.length) {
      const index = next++;
      try {
        await runLine(index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, lines.length) }, worker));
  if (failed) throw failure;

  const sampleRate = results[0].sampleRate;
  if (results.some(r => r.sampleRate !== sampleRate)) {
    throw new Error('Dialogue lines came back at different sample rates');
  }

  return {
    pcms: results.map(r => r.pcm),
    sampleRate,
    audioTokens: results.reduce((sum, r) => sum + (r.audioTokens ?? 0), 0),
    requests,
  };
}
