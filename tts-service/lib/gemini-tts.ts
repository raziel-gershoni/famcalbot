/**
 * Gemini text-to-speech: request building and response decoding.
 *
 * Deliberately self-contained - no imports from this repo - so tts-service/ can carry
 * a verbatim copy at tts-service/lib/gemini-tts.ts. That service deploys separately
 * and cannot import from src/. Keep the two copies identical.
 *
 * Two request shapes exist, because Gemini 3.8 TTS changed the contract:
 *
 * - Legacy models (3.1 preview and earlier) take a prompt and follow directions in
 *   it: "Read the following text aloud <style> in <Language>: ...". They return
 *   headerless PCM (audio/l16) and reject both fields below with a 400.
 *
 * - 3.8 and later read their input as a verbatim transcript, so that same prompt gets
 *   spoken aloud - measured at 6/20 samples on Flash TTS and 13/20 on Flash-Lite TTS,
 *   and in 9 of those Lite dropped the actual text entirely. Style must travel in a
 *   per-part `speechMetadata`. They also default to WAV with a ~6 KB C2PA metadata
 *   chunk after the audio, which a fixed 44-byte header strip encodes as a burst of
 *   full-scale noise at the end of every message. Requesting AUDIO_L16 returns the
 *   same headerless PCM the legacy models always did.
 *
 * The REST API is called directly because @google/genai 1.x drops both
 * `speechMetadata` and `responseFormat` from the request.
 */

/** Models that predate the 3.8 TTS schema. Anything else gets the new shape. */
export const LEGACY_TTS_MODELS: ReadonlySet<string> = new Set([
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
]);

export function isLegacyTtsModel(model: string): boolean {
  return LEGACY_TTS_MODELS.has(model);
}

export interface SynthesizeSpeechInput {
  apiKey: string;
  model: string;
  /** Exactly the words to speak. Must contain no stage directions. */
  text: string;
  voiceName: string;
  /** Delivery style, e.g. "softly and warmly". Omit for a plain read. */
  style?: string;
  /** English name of the language. Only the legacy prompt uses it - 3.8 detects language itself. */
  languageName?: string;
  timeoutMs?: number;
}

export interface SpeechAudio {
  /** 16-bit little-endian mono PCM. */
  pcm: Buffer;
  sampleRate: number;
  /** As returned by the API, for logging. */
  mimeType: string;
}

/** Carries the HTTP status so a retry wrapper can tell 429/503 from a hard failure. */
export class TtsHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TtsHttpError';
  }
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_PCM_RATE = 24_000;

export function buildTtsRequestBody(input: SynthesizeSpeechInput): Record<string, unknown> {
  const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voiceName } } };

  if (isLegacyTtsModel(input.model)) {
    const style = input.style || 'naturally';
    const language = input.languageName || 'English';
    return {
      contents: [{ parts: [{ text: `Read the following text aloud ${style} in ${language}:\n\n${input.text}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig },
    };
  }

  const part: Record<string, unknown> = { text: input.text };
  if (input.style) part.speechMetadata = { style: input.style };

  return {
    contents: [{ parts: [part] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig,
      responseFormat: { audio: { mimeType: 'AUDIO_L16' } },
    },
  };
}

export async function synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SpeechAudio> {
  const response = await fetch(`${ENDPOINT}/${encodeURIComponent(input.model)}:generateContent`, {
    method: 'POST',
    // Header rather than ?key= so the credential never lands in a URL or a log line.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.apiKey },
    body: JSON.stringify(buildTtsRequestBody(input)),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  type TtsResponseBody = {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
  };
  // On an error status the body is only a nicety for the message, so tolerate a bad
  // one. On success it IS the audio: the timeout above also covers reading it, so a
  // multi-MB body cut off by the timer or a connection reset must surface as what it
  // is - not be swallowed and reported further down as "returned no audio".
  const body = response.ok
    ? ((await response.json()) as TtsResponseBody)
    : ((await response.json().catch(() => null)) as TtsResponseBody | null);

  if (!response.ok) {
    const detail = body?.error?.message || response.statusText;
    throw new TtsHttpError(`Gemini TTS ${input.model} returned ${response.status}: ${detail}`, response.status);
  }

  const inline = body?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    throw new Error(`Gemini TTS ${input.model} returned no audio`);
  }

  const mimeType = inline.mimeType || '';
  return { ...decodeSpeechAudio(Buffer.from(inline.data, 'base64'), mimeType), mimeType };
}

/**
 * Turn a TTS payload into raw PCM.
 *
 * The bytes are sniffed for a RIFF header regardless of the declared type, so a WAV
 * that arrives mislabelled is still unwrapped properly rather than encoded header and
 * all. Anything that is neither WAV nor declared raw PCM is rejected - a clear error
 * is better than an audio file full of noise.
 */
export function decodeSpeechAudio(data: Buffer, mimeType: string): { pcm: Buffer; sampleRate: number } {
  if (isWav(data)) return parseWav(data);

  const type = mimeType.toLowerCase();
  if (type === '' || type.startsWith('audio/l16') || type.startsWith('audio/pcm')) {
    const rate = /rate=(\d+)/.exec(type);
    return { pcm: data, sampleRate: rate ? Number(rate[1]) : DEFAULT_PCM_RATE };
  }

  throw new Error(`Unsupported TTS audio format: ${mimeType}`);
}

function isWav(data: Buffer): boolean {
  return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE';
}

/**
 * Extract the PCM payload from a WAV by walking its chunks.
 *
 * Takes exactly the `data` chunk's declared length. Gemini 3.8 appends a C2PA
 * content-credentials chunk after the audio, so treating "everything after byte 44"
 * as samples turns that metadata into noise. Also rejects formats the Opus encoder
 * downstream cannot take, rather than letting them through as garbled audio.
 */
function parseWav(data: Buffer): { pcm: Buffer; sampleRate: number } {
  let offset = 12;
  let sampleRate: number | null = null;

  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (id === 'fmt ') {
      const format = data.readUInt16LE(start);
      const channels = data.readUInt16LE(start + 2);
      const bits = data.readUInt16LE(start + 14);
      // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (PCM sub-format in practice).
      if ((format !== 1 && format !== 0xfffe) || channels !== 1 || bits !== 16) {
        throw new Error(`Unsupported WAV: format=${format} channels=${channels} bits=${bits}; need 16-bit mono PCM`);
      }
      sampleRate = data.readUInt32LE(start + 4);
    } else if (id === 'data') {
      if (sampleRate === null) throw new Error('WAV data chunk arrived before its fmt chunk');
      return { pcm: data.subarray(start, Math.min(start + size, data.length)), sampleRate };
    }

    // Chunks are word-aligned: an odd-sized chunk carries one pad byte.
    offset = start + size + (size % 2);
  }

  throw new Error('WAV has no data chunk');
}
