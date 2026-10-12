/**
 * Two-host dialogue synthesis: every line is its own TTS request, run in parallel.
 *
 * Deliberately self-contained - its only import is type-only - so tts-service/ can
 * carry a verbatim copy at tts-service/lib/dialogue-tts.ts. Keep the two copies
 * identical. The synthesize function is passed in rather than imported for the same
 * reason: a runtime import would need a .js extension in the service and none here.
 *
 * Why one request per line rather than one multi-speaker request: with two male
 * designed voices, a multi-speaker request blurs them and pulls the younger host's
 * pitch toward the older one. Per-line requests were also faster in the trial (about
 * 4 s against 11-12 s for 8 lines) and drew no 429s at 24 in flight.
 */

import type { SpeechAudio, SynthesizeSpeechInput } from './gemini-tts';

export interface DialogueLine {
  /** Designed voice id or prebuilt voice name. */
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

  const results: SpeechAudio[] = new Array(lines.length);
  let requests = 0;
  let next = 0;
  let failed = false;
  let failure: unknown;

  const runLine = async (index: number): Promise<void> => {
    const line = lines[index];
    for (let attempt = 1; ; attempt++) {
      requests++;
      try {
        results[index] = await input.synthesize({
          apiKey: input.apiKey,
          model: input.model,
          text: line.text,
          voiceName: line.voice,
          style: line.style,
          timeoutMs: lineTimeoutMs,
        });
        return;
      } catch (error) {
        // Once any line has failed for good the show is lost, so stop retrying too.
        if (failed || attempt >= maxAttempts || !isRetryableTtsError(error)) throw error;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
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
