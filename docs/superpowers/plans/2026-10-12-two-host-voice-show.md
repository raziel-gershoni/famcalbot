# Two-Host Voice Show Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Hebrew single-narrator summary voice note with a two-host, sports-commentator show (per-line moods, rare inline sounds), remove the user's voice and style pickers, and keep the remote-first TTS pattern.

**Architecture:** An LLM writes the show as JSON turns; code validates and repairs it, maps moods to short style strings and points tricky Hebrew words with niqqud. Each line is synthesized separately (designed voices, in parallel), trimmed, level-matched and joined into one PCM stream, then encoded to OGG once. The synthesis/mixing library exists twice, byte-identical, in `src/` and `tts-service/lib/`; the app calls the Vercel tts-service's new `/api/dialogue` when `TTS_SERVICE_URL` is set and falls back to local synthesis on any failure, exactly like the narrator path.

**Tech Stack:** TypeScript, Next.js 16 app on Railway, Vercel serverless tts-service, Gemini 3.8 TTS REST API (designed voices), `@google/genai` for the writer LLM, opusscript, tsx smoke scripts (no test framework).

**Spec:** `docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md`

## Global Constraints

- Hebrew hosts: A = `voice_33yuo333h4y2` (warm, late 30s), B = `voice_zrrafp34tgt8` (young, energetic, 20s); env overrides `GEMINI_SHOW_VOICE_HE_A`, `GEMINI_SHOW_VOICE_HE_B`.
- Mood → style strings, verbatim: hype `excited sports commentator`; triumph `triumphant, loud and celebratory`; suspense `slow and suspenseful, building tension`; amused `amused, laughing a little`; surprised `surprised, high pitch`; mock_disappointed `mock-disappointed, deflated`; secret `whispering, secretive`; warm `warm and relaxed, slower`. Unknown mood → `hype`.
- Sound whitelist, verbatim: `<chuckle>`, `<laugh>`, `<sigh>`, `<gasp>`, `<whispers>`, `<throat-clearing>`. At most 2 per show, never on consecutive turns. Backchannels `|...|` banned.
- Script limits: 4-30 turns, at most 400 characters per turn, hosts only `A`/`B`, both hosts speak.
- The writer is regenerated once on a malformed result; a second failure takes the existing "voice unavailable" path.
- TTS model: the admin setting; a legacy model (`gemini-3.1-flash-tts-preview` etc.) is replaced by `gemini-3.8-flash-tts` whenever a designed voice speaks.
- Where TTS runs: remote tts-service when `TTS_SERVICE_URL` is set, local on any remote failure, local otherwise. The narrator path keeps working exactly as today for languages without hosts.
- `tts-service/lib/*.ts` are byte-identical copies of `src/services/gemini-tts.ts`, `src/utils/pcm-to-ogg-opus.ts`, `src/services/dialogue-tts.ts`, `src/utils/pcm-mix.ts`. Library files have no runtime imports from the repo (type-only imports are allowed); tts-service runtime imports use the `.js` extension.
- DB columns `voicePreference` and `voiceStyle` stay; no migration in this release.
- Tests are tsx smoke scripts in `scripts/` in the style of `scripts/smoke-tts.ts`: `check(name, fn)`, print `OK`/`FAIL`, exit 1 on any failure. Run with `npx tsx scripts/<name>.ts`.
- After every task both type-checks pass: `npx tsc --noEmit` and `npx tsc -p tts-service/tsconfig.json --noEmit`.
- Commit messages: conventional style (`feat(voice): ...`), ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Work on branch `feat/two-host-voice-show`. Do not push, do not touch `main`, do not call production URLs, do not run `gh api`.
- Comments explain why, at the density of the surrounding code.

### Deliberate deviations from the spec

1. `generateAICompletion` gains `responseJsonSchema` only, not `temperature`: Gemini 3 guidance is to keep the default temperature, and nothing needs it.
2. The settings description changes for Hebrew only. English and Russian users keep the narrator until their hosts ship (spec Rollout step 2), so their description stays accurate as is.
3. Library placement: `src/services/dialogue-tts.ts` and `src/utils/pcm-mix.ts`, beside their existing twins. `dialogue-tts` receives the synthesize function as a parameter so both copies stay byte-identical without a runtime import.
4. Added: second-person suffix words (`לך`, `שלך`, `אותך`, ...) are pointed for the listener's gender, because unpointed they are ambiguous to TTS and a female listener would hear the masculine form.
5. The designed-voice request shape (`voiceConfig.voice`) is used only for `voice_...` ids; prebuilt voices keep `prebuiltVoiceConfig`, so narrator requests are unchanged byte for byte.

## Review Focus

1. **Empty day** (no events): the show must still be valid and must not invent events. → prompt test in Task 5, eval fixture `daily-female-empty` in Task 10.
2. **Very busy day or week** near the limits (30 turns × 400 characters): the parser must accept the maximum, and the writer must group events instead of failing. → parser test in Task 4, eval fixture `weekly-busy` in Task 10.
3. **Female listener, spouse of unknown gender**: feminine address and neutral phrasing in the text, and the right reading of `לך`/`שלך` in audio. → prompt tests in Task 5, pointing tests in Task 4, eval gender judge in Task 10.
4. **Times written as digits in the summary** (`10:15`): they must reach TTS as words; leftover digits are only a warning in the parser. → parser warning test in Task 4, eval "no digits" check in Task 10.
5. **tts-service without `/api/dialogue`** (it only redeploys from `main`) or down: the show must fall back to local synthesis. → Task 7 smoke test with a local HTTP server answering 404.

---

### Task 1: Gemini TTS library: designed voices, multi-part audio, token usage

**Files:**
- Modify: `src/services/gemini-tts.ts` (full replacement below)
- Modify: `tts-service/lib/gemini-tts.ts` (copy of the above)
- Test: `scripts/smoke-tts.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (both copies):
  - `isDesignedVoice(voiceName: string): boolean`
  - `DESIGNED_VOICE_FALLBACK_MODEL = 'gemini-3.8-flash-tts'`
  - `modelForDesignedVoices(model: string): string`
  - `isVoiceMissingError(error: unknown): boolean`
  - `SpeechAudio` gains `audioTokens?: number`
  - `TtsResponseBody` (exported type) and `extractSpeechAudio(body: TtsResponseBody, model: string): SpeechAudio`
  - `buildTtsRequestBody` sends `voiceConfig.voice` for `voice_...` ids and throws for a legacy model with a designed voice.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-tts.ts`, change the import line to:

```ts
import fs from 'fs';
import {
  buildTtsRequestBody, decodeSpeechAudio, extractSpeechAudio, isDesignedVoice, isLegacyTtsModel,
  isVoiceMissingError, modelForDesignedVoices, TtsHttpError,
} from '../src/services/gemini-tts';
```

and insert these checks just before the `// Print results` line:

```ts
// 8. Designed voices (Voice design ids) use voiceConfig.voice; prebuilt names keep prebuiltVoiceConfig.
check('designed voice id goes in voiceConfig.voice', () => {
  const body = buildTtsRequestBody({ apiKey: 'x', model: 'gemini-3.8-flash-tts', text: 'שלום', voiceName: 'voice_33yuo333h4y2' }) as {
    generationConfig: { speechConfig: Record<string, unknown> };
  };
  const json = JSON.stringify(body.generationConfig.speechConfig);
  assert(json === '{"voiceConfig":{"voice":"voice_33yuo333h4y2"}}', `speechConfig was ${json}`);
});

check('prebuilt voice keeps prebuiltVoiceConfig (narrator request unchanged)', () => {
  const body = buildTtsRequestBody({ apiKey: 'x', model: 'gemini-3.8-flash-tts', text: 'Hi', voiceName: 'Algieba' }) as {
    generationConfig: { speechConfig: Record<string, unknown> };
  };
  const json = JSON.stringify(body.generationConfig.speechConfig);
  assert(json === '{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Algieba"}}}', `speechConfig was ${json}`);
});

check('legacy model with a designed voice is refused', () => {
  let threw = false;
  try {
    buildTtsRequestBody({ apiKey: 'x', model: 'gemini-3.1-flash-tts-preview', text: 'Hi', voiceName: 'voice_abc123' });
  } catch { threw = true; }
  assert(threw, 'legacy + designed voice accepted');
});

check('designed voice detection and model substitution', () => {
  assert(isDesignedVoice('voice_33yuo333h4y2'), 'voice_ id');
  assert(!isDesignedVoice('Algieba'), 'prebuilt name');
  assert(modelForDesignedVoices('gemini-3.1-flash-tts-preview') === 'gemini-3.8-flash-tts', 'legacy not replaced');
  assert(modelForDesignedVoices('gemini-3.8-flash-lite-tts') === 'gemini-3.8-flash-lite-tts', '3.8 lite replaced');
  assert(modelForDesignedVoices('gemini-3.8-flash-tts') === 'gemini-3.8-flash-tts', '3.8 replaced');
});

// 9. Multi-part responses: every audio part, in order; tokens from usageMetadata.
check('all audio parts are joined in order, tokens read', () => {
  const a = Buffer.from([1, 0, 2, 0]);
  const b = Buffer.from([3, 0, 4, 0]);
  const audio = extractSpeechAudio({
    candidates: [{ content: { parts: [
      { inlineData: { mimeType: 'audio/l16; rate=24000', data: a.toString('base64') } },
      { inlineData: { mimeType: 'audio/l16; rate=24000', data: b.toString('base64') } },
    ] } }],
    usageMetadata: { candidatesTokenCount: 125 },
  }, 'gemini-3.8-flash-tts');
  assert(audio.pcm.equals(Buffer.concat([a, b])), `pcm ${audio.pcm.toString('hex')}`);
  assert(audio.sampleRate === 24000, `rate ${audio.sampleRate}`);
  assert(audio.audioTokens === 125, `tokens ${audio.audioTokens}`);
});

check('response without audio parts throws "returned no audio"', () => {
  let message = '';
  try { extractSpeechAudio({ candidates: [{ content: { parts: [] } }] }, 'm'); } catch (e) { message = (e as Error).message; }
  assert(/returned no audio/.test(message), `message ${message}`);
});

check('audio parts at different rates are refused', () => {
  let threw = false;
  try {
    extractSpeechAudio({ candidates: [{ content: { parts: [
      { inlineData: { mimeType: 'audio/l16; rate=24000', data: 'AQA=' } },
      { inlineData: { mimeType: 'audio/l16; rate=16000', data: 'AQA=' } },
    ] } }] }, 'm');
  } catch { threw = true; }
  assert(threw, 'mixed rates accepted');
});

check('missing token count leaves audioTokens undefined', () => {
  const audio = extractSpeechAudio({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/l16', data: 'AQA=' } }] } }] }, 'm');
  assert(audio.audioTokens === undefined, `tokens ${audio.audioTokens}`);
});

// 10. A designed voice the project cannot see answers 404 "The voice was not found ...".
check('voice-missing errors are recognised, others are not', () => {
  const missing = new TtsHttpError('Gemini TTS gemini-3.8-flash-tts returned 404: The voice was not found or the caller does not have permission to access it.', 404);
  assert(isVoiceMissingError(missing), 'TtsHttpError 404 voice');
  assert(isVoiceMissingError({ status: 404, message: 'The voice was not found' }), 'duck-typed copy');
  assert(!isVoiceMissingError(new TtsHttpError('Gemini TTS x returned 404: models/x is not found', 404)), 'model 404');
  assert(!isVoiceMissingError(new TtsHttpError('Gemini TTS x returned 400: The voice was not found', 400)), '400');
  assert(!isVoiceMissingError(null), 'null');
});

// 11. tts-service deploys separately and carries verbatim copies of the shared library.
const TWINS: Array<[string, string]> = [
  ['src/services/gemini-tts.ts', 'tts-service/lib/gemini-tts.ts'],
  ['src/utils/pcm-to-ogg-opus.ts', 'tts-service/lib/pcm-to-ogg-opus.ts'],
];
for (const [app, service] of TWINS) {
  check(`${service} is identical to ${app}`, () => {
    assert(fs.readFileSync(app).equals(fs.readFileSync(service)), 'copies differ - copy the src/ file over the tts-service one');
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/smoke-tts.ts`
Expected: FAIL. The import of `extractSpeechAudio` (and the other new names) does not exist, so the script errors before printing results, or the new checks print `FAIL`.

- [ ] **Step 3: Implement**

Replace `src/services/gemini-tts.ts` with:

```ts
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
 * Voices come in two kinds. Prebuilt voices are names (Algieba) and go in
 * `prebuiltVoiceConfig.voiceName`, as they always have. Designed voices, made with the
 * Voice design API and stored in the Gemini project, are ids (voice_33yuo333h4y2) and
 * go in `voiceConfig.voice`; `prebuiltVoiceConfig` rejects them with a 400. Only 3.8
 * and later can speak designed voices.
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

/** True for a Voice design id (voice_...), false for a prebuilt voice name. */
export function isDesignedVoice(voiceName: string): boolean {
  return voiceName.startsWith('voice_');
}

/** Speaks designed voices when a legacy model is configured, since legacy models cannot. */
export const DESIGNED_VOICE_FALLBACK_MODEL = 'gemini-3.8-flash-tts';

export function modelForDesignedVoices(model: string): string {
  return isLegacyTtsModel(model) ? DESIGNED_VOICE_FALLBACK_MODEL : model;
}

export interface SynthesizeSpeechInput {
  apiKey: string;
  model: string;
  /** Exactly the words to speak. Must contain no stage directions. */
  text: string;
  /** A prebuilt voice name (Algieba) or a designed voice id (voice_...). */
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
  /** Output audio tokens as billed, when the API reports them. */
  audioTokens?: number;
}

/** Carries the HTTP status so a retry wrapper can tell 429/503 from a hard failure. */
export class TtsHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TtsHttpError';
  }
}

/**
 * A designed voice this API key's project cannot use: deleted, expired after a year
 * unused, or stored in another project. Gemini answers 404 "The voice was not found or
 * the caller does not have permission to access it." Duck-typed so it also recognises
 * errors thrown by the other copy of this file.
 */
export function isVoiceMissingError(error: unknown): boolean {
  const e = error as { status?: unknown; message?: unknown } | null;
  return e?.status === 404 && typeof e.message === 'string' && /voice was not found/i.test(e.message);
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_PCM_RATE = 24_000;

export function buildTtsRequestBody(input: SynthesizeSpeechInput): Record<string, unknown> {
  const designed = isDesignedVoice(input.voiceName);
  const speechConfig = designed
    ? { voiceConfig: { voice: input.voiceName } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voiceName } } };

  if (isLegacyTtsModel(input.model)) {
    if (designed) {
      throw new Error(`${input.model} cannot speak designed voice ${input.voiceName}; use modelForDesignedVoices()`);
    }
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

export interface TtsResponseBody {
  error?: { message?: string };
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
  usageMetadata?: { candidatesTokenCount?: number };
}

export async function synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SpeechAudio> {
  const response = await fetch(`${ENDPOINT}/${encodeURIComponent(input.model)}:generateContent`, {
    method: 'POST',
    // Header rather than ?key= so the credential never lands in a URL or a log line.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.apiKey },
    body: JSON.stringify(buildTtsRequestBody(input)),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

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

  return extractSpeechAudio(body ?? {}, input.model);
}

/**
 * Pull the audio out of a successful response. Every audio part is decoded and joined
 * in order: reading only the first would silently drop the rest of the speech if the
 * API ever splits it.
 */
export function extractSpeechAudio(body: TtsResponseBody, model: string): SpeechAudio {
  const parts = (body.candidates?.[0]?.content?.parts ?? []).filter(p => p.inlineData?.data);
  if (!parts.length) {
    throw new Error(`Gemini TTS ${model} returned no audio`);
  }

  const decoded = parts.map(p => decodeSpeechAudio(Buffer.from(p.inlineData!.data!, 'base64'), p.inlineData!.mimeType || ''));
  const sampleRate = decoded[0].sampleRate;
  if (decoded.some(d => d.sampleRate !== sampleRate)) {
    throw new Error(`Gemini TTS ${model} returned audio parts at different sample rates`);
  }

  const tokens = body.usageMetadata?.candidatesTokenCount;
  return {
    pcm: decoded.length === 1 ? decoded[0].pcm : Buffer.concat(decoded.map(d => d.pcm)),
    sampleRate,
    mimeType: parts[0].inlineData!.mimeType || '',
    audioTokens: typeof tokens === 'number' ? tokens : undefined,
  };
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
```

Then copy it over the service twin:

```bash
cp src/services/gemini-tts.ts tts-service/lib/gemini-tts.ts
```

- [ ] **Step 4: Run the tests and type-checks**

Run: `npx tsx scripts/smoke-tts.ts && npx tsc --noEmit && npx tsc -p tts-service/tsconfig.json --noEmit`
Expected: every line `OK`, `N/N passed`, and both type-checks silent.

- [ ] **Step 5: Commit**

```bash
git add src/services/gemini-tts.ts tts-service/lib/gemini-tts.ts scripts/smoke-tts.ts
git commit -F - <<'MSG'
feat(tts): speak designed voices, join multi-part audio, report audio tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---

### Task 2: Dialogue synthesis (one request per line, in parallel, with retries)

**Files:**
- Create: `src/services/dialogue-tts.ts`
- Create: `tts-service/lib/dialogue-tts.ts` (copy)
- Create: `scripts/smoke-dialogue-tts.ts`
- Modify: `scripts/smoke-tts.ts` (add the twin)

**Interfaces:**
- Consumes: `SynthesizeSpeechInput`, `SpeechAudio` (types only) from `./gemini-tts`.
- Produces (both copies):
  - `interface DialogueLine { voice: string; text: string; style?: string }`
  - `interface SynthesizeDialogueInput { apiKey: string; model: string; lines: DialogueLine[]; synthesize: (input: SynthesizeSpeechInput) => Promise<SpeechAudio>; concurrency?: number; lineTimeoutMs?: number; maxAttempts?: number; baseDelayMs?: number }`
  - `interface DialogueAudio { pcms: Buffer[]; sampleRate: number; audioTokens: number; requests: number }`
  - `synthesizeDialogue(input: SynthesizeDialogueInput): Promise<DialogueAudio>`. `pcms[i]` belongs to `lines[i]`.
  - `isRetryableTtsError(error: unknown): boolean`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-dialogue-tts.ts`:

```ts
// Smoke test for src/services/dialogue-tts.ts: ordering, concurrency, retries, failure.
// No network - a fake synthesize function stands in for Gemini.
//
// Run: npx tsx scripts/smoke-dialogue-tts.ts

import { isRetryableTtsError, synthesizeDialogue, type DialogueLine } from '../src/services/dialogue-tts';
import type { SpeechAudio, SynthesizeSpeechInput } from '../src/services/gemini-tts';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function httpError(status: number, message = `status ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const lines = (n: number): DialogueLine[] =>
  Array.from({ length: n }, (_, i) => ({ voice: i % 2 ? 'voice_b' : 'voice_a', text: `line ${i}`, style: `style ${i}` }));
const audio = (byte: number, tokens = 10, sampleRate = 24000): SpeechAudio =>
  ({ pcm: Buffer.from([byte, 0]), sampleRate, mimeType: 'audio/l16', audioTokens: tokens });
const indexOf = (input: SynthesizeSpeechInput) => Number(input.text.split(' ')[1]);

async function main() {
  await check('results keep line order and tokens add up', async () => {
    const out = await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(6), baseDelayMs: 1,
      synthesize: async input => { await sleep((6 - indexOf(input)) * 3); return audio(indexOf(input)); },
    });
    assert(out.pcms.map(p => p[0]).join(',') === '0,1,2,3,4,5', `order ${out.pcms.map(p => p[0]).join(',')}`);
    assert(out.audioTokens === 60, `tokens ${out.audioTokens}`);
    assert(out.requests === 6, `requests ${out.requests}`);
    assert(out.sampleRate === 24000, `rate ${out.sampleRate}`);
  });

  await check('voice, text, style, model, key and line timeout reach synthesize', async () => {
    const seen: SynthesizeSpeechInput[] = [];
    await synthesizeDialogue({
      apiKey: 'key-1', model: 'gemini-3.8-flash-tts', lines: lines(2), lineTimeoutMs: 1234,
      synthesize: async input => { seen.push(input); return audio(0); },
    });
    const first = seen.find(s => s.text === 'line 1')!;
    assert(first.voiceName === 'voice_b' && first.style === 'style 1', JSON.stringify(first));
    assert(first.apiKey === 'key-1' && first.model === 'gemini-3.8-flash-tts' && first.timeoutMs === 1234, JSON.stringify(first));
  });

  await check('never more requests in flight than the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(10), concurrency: 3,
      synthesize: async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(5); inFlight--; return audio(0); },
    });
    assert(peak === 3, `peak ${peak}`);
  });

  await check('429 then success is retried', async () => {
    let calls = 0;
    const out = await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(1), baseDelayMs: 1,
      synthesize: async () => { calls++; if (calls === 1) throw httpError(429); return audio(7); },
    });
    assert(out.pcms[0][0] === 7 && out.requests === 2, `requests ${out.requests}`);
  });

  await check('timeouts, network errors and "no audio" are retried', async () => {
    const failures: Error[] = [
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      new TypeError('fetch failed'),
      new Error('Gemini TTS m returned no audio'),
    ];
    let calls = 0;
    const out = await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(1), maxAttempts: 4, baseDelayMs: 1,
      synthesize: async () => { const f = failures[calls++]; if (f) throw f; return audio(1); },
    });
    assert(out.requests === 4, `requests ${out.requests}`);
  });

  await check('a 400 fails at once without retry', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(1), baseDelayMs: 1,
        synthesize: async () => { calls++; throw httpError(400); } });
    } catch (e) { caught = e; }
    assert((caught as { status?: number })?.status === 400, 'error not passed through');
    assert(calls === 1, `calls ${calls}`);
  });

  await check('persistent 503 gives up after maxAttempts', async () => {
    let calls = 0;
    let threw = false;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(1), maxAttempts: 3, baseDelayMs: 1,
        synthesize: async () => { calls++; throw httpError(503); } });
    } catch { threw = true; }
    assert(threw && calls === 3, `threw ${threw} calls ${calls}`);
  });

  await check('after a failure no new lines are started', async () => {
    let calls = 0;
    let threw = false;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(5), concurrency: 1,
        synthesize: async () => { calls++; throw httpError(404, 'The voice was not found'); } });
    } catch { threw = true; }
    assert(threw && calls === 1, `threw ${threw} calls ${calls}`);
  });

  await check('lines at different sample rates are refused', async () => {
    let threw = false;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(2),
        synthesize: async input => audio(0, 1, indexOf(input) ? 16000 : 24000) });
    } catch { threw = true; }
    assert(threw, 'mixed rates accepted');
  });

  await check('a dialogue with no lines is refused', async () => {
    let threw = false;
    try { await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: [], synthesize: async () => audio(0) }); } catch { threw = true; }
    assert(threw, 'empty accepted');
  });

  await check('retry classification', () => {
    assert(isRetryableTtsError(httpError(429)), '429');
    assert(isRetryableTtsError(httpError(500)) && isRetryableTtsError(httpError(503)), '5xx');
    assert(!isRetryableTtsError(httpError(400)) && !isRetryableTtsError(httpError(404)), '4xx');
    assert(isRetryableTtsError(Object.assign(new Error('x'), { name: 'AbortError' })), 'abort');
    assert(!isRetryableTtsError(new Error('Unsupported TTS audio format: audio/mpeg')), 'format error');
    assert(!isRetryableTtsError(null), 'null');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-dialogue-tts.ts`
Expected: FAIL with a module-not-found error for `../src/services/dialogue-tts`.

- [ ] **Step 3: Implement**

Create `src/services/dialogue-tts.ts`:

```ts
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
```

Copy it and register the twin:

```bash
cp src/services/dialogue-tts.ts tts-service/lib/dialogue-tts.ts
```

In `scripts/smoke-tts.ts`, add to the `TWINS` array:

```ts
  ['src/services/dialogue-tts.ts', 'tts-service/lib/dialogue-tts.ts'],
```

- [ ] **Step 4: Run the tests and type-checks**

Run: `npx tsx scripts/smoke-dialogue-tts.ts && npx tsx scripts/smoke-tts.ts && npx tsc --noEmit && npx tsc -p tts-service/tsconfig.json --noEmit`
Expected: all `OK`, both type-checks silent.

- [ ] **Step 5: Commit**

```bash
git add src/services/dialogue-tts.ts tts-service/lib/dialogue-tts.ts scripts/smoke-dialogue-tts.ts scripts/smoke-tts.ts
git commit -F - <<'MSG'
feat(tts): synthesize a two-host dialogue line by line, in parallel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---

### Task 3: PCM mixing (trim, fades, per-host gain, gaps, peak guard)

**Files:**
- Create: `src/utils/pcm-mix.ts`
- Create: `tts-service/lib/pcm-mix.ts` (copy)
- Create: `scripts/smoke-pcm-mix.ts`
- Modify: `scripts/smoke-tts.ts` (add the twin)

**Interfaces:**
- Consumes: nothing.
- Produces (both copies):
  - `interface MixLine { pcm: Buffer; speaker: string; keepDynamics?: boolean }`
  - `interface MixOptions { sampleRate: number; gapMs?: number; fadeMs?: number; edgeMs?: number; silenceDb?: number; maxGainDb?: number; peakCeiling?: number }`
  - `trimSilence(pcm: Buffer, sampleRate: number, silenceDb?: number, edgeMs?: number): Buffer`
  - `activeRms(pcm: Buffer, sampleRate: number, silenceDb?: number): number`
  - `mixDialogue(lines: MixLine[], options: MixOptions): Buffer`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-pcm-mix.ts`:

```ts
// Smoke test for src/utils/pcm-mix.ts with synthetic tones. No network.
//
// Run: npx tsx scripts/smoke-pcm-mix.ts

import { activeRms, mixDialogue, trimSilence } from '../src/utils/pcm-mix';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const RATE = 24000;
const samples = (ms: number) => Math.round((RATE * ms) / 1000);

function tone(ms: number, amp: number, freq = 220): Buffer {
  const n = samples(ms);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(samples(ms) * 2);
const padded = (amp: number, ms = 1000) => Buffer.concat([silence(500), tone(ms, amp), silence(400)]);
const db = (ratio: number) => 20 * Math.log10(ratio);

function segments(lines: Buffer[], gapMs = 200): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let pos = 0;
  lines.forEach((pcm, i) => {
    if (i > 0) pos += samples(gapMs);
    const n = trimSilence(pcm, RATE).length / 2;
    out.push([pos, pos + n]);
    pos += n;
  });
  return out;
}
const slice = (pcm: Buffer, [from, to]: [number, number]) => pcm.subarray(from * 2, to * 2);

check('trimSilence keeps the sound plus a 40 ms edge each side', () => {
  const trimmed = trimSilence(padded(8000), RATE);
  const ms = (trimmed.length / 2 / RATE) * 1000;
  assert(ms >= 1060 && ms <= 1110, `trimmed to ${ms.toFixed(0)} ms`);
});

check('trimSilence of pure silence is empty', () => {
  assert(trimSilence(silence(300), RATE).length === 0, 'not empty');
});

check('total length = trimmed lines + gaps', () => {
  const lines = [padded(8000), padded(8000, 600), padded(8000, 800)];
  const mixed = mixDialogue(lines.map((pcm, i) => ({ pcm, speaker: i % 2 ? 'B' : 'A' })), { sampleRate: RATE });
  const expected = lines.reduce((s, l) => s + trimSilence(l, RATE).length, 0) + 2 * samples(200) * 2;
  assert(mixed.length === expected, `length ${mixed.length} expected ${expected}`);
});

check('gaps are silent and lines fade in and out', () => {
  const lines = [padded(8000), padded(8000)];
  const mixed = mixDialogue([{ pcm: lines[0], speaker: 'A' }, { pcm: lines[1], speaker: 'B' }], { sampleRate: RATE });
  const [first, second] = segments(lines);
  for (let i = first[1]; i < second[0]; i++) assert(mixed.readInt16LE(i * 2) === 0, `gap sample ${i} not silent`);
  assert(mixed.readInt16LE(first[0] * 2) === 0, 'first sample of a line is not 0');
  assert(mixed.readInt16LE((first[1] - 1) * 2) === 0, 'last sample of a line is not 0');
});

check('hosts recorded 6 dB apart come out level', () => {
  const lines = [padded(6000), padded(3000), padded(6000), padded(3000)];
  const mixed = mixDialogue(lines.map((pcm, i) => ({ pcm, speaker: i % 2 ? 'B' : 'A' })), { sampleRate: RATE });
  const segs = segments(lines);
  const a = activeRms(slice(mixed, segs[0]), RATE);
  const b = activeRms(slice(mixed, segs[1]), RATE);
  assert(Math.abs(db(a / b)) < 0.5, `A/B differ by ${db(a / b).toFixed(2)} dB`);
});

check('gain never exceeds maxGainDb', () => {
  const lines = [padded(16000), padded(1000)];
  const mixed = mixDialogue(lines.map((pcm, i) => ({ pcm, speaker: i ? 'B' : 'A' })), { sampleRate: RATE, maxGainDb: 6 });
  const segs = segments(lines);
  const before = activeRms(trimSilence(lines[1], RATE), RATE);
  const after = activeRms(slice(mixed, segs[1]), RATE);
  assert(db(after / before) <= 6.05, `B boosted by ${db(after / before).toFixed(2)} dB`);
});

check('whispered lines keep their level below the host', () => {
  const lines = [padded(6000), padded(3000), padded(600)];
  const mixed = mixDialogue([
    { pcm: lines[0], speaker: 'A' },
    { pcm: lines[1], speaker: 'B' },
    { pcm: lines[2], speaker: 'B', keepDynamics: true },
  ], { sampleRate: RATE });
  const segs = segments(lines);
  const normal = activeRms(slice(mixed, segs[1]), RATE);
  const whisper = activeRms(slice(mixed, segs[2]), RATE);
  assert(Math.abs(db(whisper / normal) - db(600 / 3000)) < 0.5, `whisper at ${db(whisper / normal).toFixed(2)} dB`);
});

check('peak guard scales the whole show below 95% of full scale', () => {
  // B's gain (x1.5, from its normal line) would push its loud keepDynamics line to 48000.
  const lines = [padded(6000), padded(3000), padded(32000)];
  const mixed = mixDialogue([
    { pcm: lines[0], speaker: 'A' },
    { pcm: lines[1], speaker: 'B' },
    { pcm: lines[2], speaker: 'B', keepDynamics: true },
  ], { sampleRate: RATE });
  let peak = 0;
  for (let i = 0; i < mixed.length; i += 2) peak = Math.max(peak, Math.abs(mixed.readInt16LE(i)));
  assert(peak <= Math.ceil(32767 * 0.95), `peak ${peak}`);
  assert(peak >= 31000, `peak ${peak}: the loud line should sit at the ceiling, not below it`);
});

check('silent lines are dropped; all-silent dialogue throws', () => {
  const mixed = mixDialogue([{ pcm: padded(8000), speaker: 'A' }, { pcm: silence(500), speaker: 'B' }], { sampleRate: RATE });
  assert(mixed.length === trimSilence(padded(8000), RATE).length, `length ${mixed.length}`);
  let threw = false;
  try { mixDialogue([{ pcm: silence(500), speaker: 'A' }], { sampleRate: RATE }); } catch { threw = true; }
  assert(threw, 'all-silent accepted');
});

check('odd-length input is tolerated', () => {
  const odd = Buffer.concat([padded(8000), Buffer.from([1])]);
  const mixed = mixDialogue([{ pcm: odd, speaker: 'A' }], { sampleRate: RATE });
  assert(mixed.length % 2 === 0 && mixed.length > 0, `length ${mixed.length}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-pcm-mix.ts`
Expected: FAIL with a module-not-found error for `../src/utils/pcm-mix`.

- [ ] **Step 3: Implement**

Create `src/utils/pcm-mix.ts`:

```ts
/**
 * Joins the separately synthesized lines of a two-host dialogue into one PCM stream.
 *
 * Deliberately self-contained - no imports - so tts-service/ can carry a verbatim copy
 * at tts-service/lib/pcm-mix.ts. Keep the two copies identical.
 *
 * Each TTS line arrives with its own lead-in and tail of silence and its own loudness.
 * Joined raw, the show has long dead air between turns and one host louder than the
 * other. So each line is trimmed to its sound, faded at both ends against clicks,
 * scaled by one gain per host, and separated by a short gap; a final peak guard keeps
 * the sum below full scale. 16-bit little-endian mono PCM throughout.
 */

export interface MixLine {
  pcm: Buffer;
  /** Lines with the same speaker share one gain. */
  speaker: string;
  /** Leave out of the host's level measurement (whispers), so it stays quieter. */
  keepDynamics?: boolean;
}

export interface MixOptions {
  sampleRate: number;
  /** Silence between lines. Default 200 ms. */
  gapMs?: number;
  /** Fade in and out at each line's edges. Default 8 ms. */
  fadeMs?: number;
  /** Audio kept beyond the first and last sound of a line, so soft onsets survive. Default 40 ms. */
  edgeMs?: number;
  /** A 10 ms window quieter than this (dBFS) counts as silence. Default -45. */
  silenceDb?: number;
  /** Largest boost or cut applied to a host. Default 6 dB. */
  maxGainDb?: number;
  /** Peak limit as a fraction of full scale. Default 0.95. */
  peakCeiling?: number;
}

const FULL_SCALE = 32767;
const WINDOW_MS = 10;

const sampleCount = (pcm: Buffer) => pcm.length >> 1;
const windowSize = (sampleRate: number) => Math.max(1, Math.round((sampleRate * WINDOW_MS) / 1000));
const thresholdFor = (silenceDb: number) => FULL_SCALE * 10 ** (silenceDb / 20);

/** Calls fn for each 10 ms window with its start, end and sum of squares. */
function forEachWindow(pcm: Buffer, sampleRate: number, fn: (start: number, end: number, sumSq: number) => void): void {
  const total = sampleCount(pcm);
  const size = windowSize(sampleRate);
  for (let start = 0; start < total; start += size) {
    const end = Math.min(total, start + size);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * 2);
      sumSq += v * v;
    }
    fn(start, end, sumSq);
  }
}

/** The line from its first to its last audible window, plus edgeMs each side. Empty if silent. */
export function trimSilence(pcm: Buffer, sampleRate: number, silenceDb = -45, edgeMs = 40): Buffer {
  const threshold = thresholdFor(silenceDb);
  let first = -1;
  let last = -1;
  forEachWindow(pcm, sampleRate, (start, end, sumSq) => {
    if (Math.sqrt(sumSq / (end - start)) >= threshold) {
      if (first < 0) first = start;
      last = end;
    }
  });
  if (first < 0) return pcm.subarray(0, 0);
  const edge = Math.round((sampleRate * edgeMs) / 1000);
  const from = Math.max(0, first - edge);
  const to = Math.min(sampleCount(pcm), last + edge);
  return pcm.subarray(from * 2, to * 2);
}

/** RMS over audible windows only, so pauses inside a line don't drag its level down. */
export function activeRms(pcm: Buffer, sampleRate: number, silenceDb = -45): number {
  const { sumSq, n } = activeEnergy(pcm, sampleRate, silenceDb);
  return n ? Math.sqrt(sumSq / n) : 0;
}

function activeEnergy(pcm: Buffer, sampleRate: number, silenceDb: number): { sumSq: number; n: number } {
  const threshold = thresholdFor(silenceDb);
  let total = 0;
  let n = 0;
  forEachWindow(pcm, sampleRate, (start, end, sumSq) => {
    if (Math.sqrt(sumSq / (end - start)) >= threshold) {
      total += sumSq;
      n += end - start;
    }
  });
  return { sumSq: total, n };
}

export function mixDialogue(lines: MixLine[], options: MixOptions): Buffer {
  const { sampleRate } = options;
  const gapMs = options.gapMs ?? 200;
  const fadeMs = options.fadeMs ?? 8;
  const edgeMs = options.edgeMs ?? 40;
  const silenceDb = options.silenceDb ?? -45;
  const maxGainDb = options.maxGainDb ?? 6;
  const peakCeiling = options.peakCeiling ?? 0.95;

  const trimmed = lines
    .map(line => ({ ...line, pcm: trimSilence(line.pcm, sampleRate, silenceDb, edgeMs) }))
    .filter(line => sampleCount(line.pcm) > 0);
  if (!trimmed.length) throw new Error('Dialogue has no audible lines');

  // One gain per speaker, measured on that speaker's normal lines only, toward the
  // mean level of all speakers.
  const energy = new Map<string, { sumSq: number; n: number }>();
  for (const line of trimmed) {
    if (line.keepDynamics) continue;
    const e = activeEnergy(line.pcm, sampleRate, silenceDb);
    const acc = energy.get(line.speaker) ?? { sumSq: 0, n: 0 };
    acc.sumSq += e.sumSq;
    acc.n += e.n;
    energy.set(line.speaker, acc);
  }
  const levels = new Map<string, number>();
  for (const [speaker, e] of energy) if (e.n) levels.set(speaker, Math.sqrt(e.sumSq / e.n));
  const target = levels.size ? [...levels.values()].reduce((s, v) => s + v, 0) / levels.size : 0;
  const maxGain = 10 ** (maxGainDb / 20);
  const gainOf = (speaker: string): number => {
    const level = levels.get(speaker);
    if (!level || !target) return 1;
    return Math.min(maxGain, Math.max(1 / maxGain, target / level));
  };

  const gap = Math.round((sampleRate * gapMs) / 1000);
  const total = trimmed.reduce((sum, line) => sum + sampleCount(line.pcm), 0) + gap * (trimmed.length - 1);
  const mixed = new Float64Array(total);
  let pos = 0;
  trimmed.forEach((line, index) => {
    if (index > 0) pos += gap;
    const n = sampleCount(line.pcm);
    const gain = gainOf(line.speaker);
    const fade = Math.min(Math.round((sampleRate * fadeMs) / 1000), n >> 1);
    for (let k = 0; k < n; k++) {
      let v = line.pcm.readInt16LE(k * 2) * gain;
      if (fade > 0 && k < fade) v *= k / fade;
      else if (fade > 0 && k >= n - fade) v *= (n - 1 - k) / fade;
      mixed[pos + k] = v;
    }
    pos += n;
  });

  let peak = 0;
  for (let k = 0; k < total; k++) peak = Math.max(peak, Math.abs(mixed[k]));
  const ceiling = FULL_SCALE * peakCeiling;
  const scale = peak > ceiling ? ceiling / peak : 1;

  const out = Buffer.alloc(total * 2);
  for (let k = 0; k < total; k++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mixed[k] * scale))), k * 2);
  }
  return out;
}
```

Copy it and register the twin:

```bash
cp src/utils/pcm-mix.ts tts-service/lib/pcm-mix.ts
```

In `scripts/smoke-tts.ts`, add to the `TWINS` array:

```ts
  ['src/utils/pcm-mix.ts', 'tts-service/lib/pcm-mix.ts'],
```

- [ ] **Step 4: Run the tests and type-checks**

Run: `npx tsx scripts/smoke-pcm-mix.ts && npx tsx scripts/smoke-tts.ts && npx tsc --noEmit && npx tsc -p tts-service/tsconfig.json --noEmit`
Expected: all `OK`, both type-checks silent.

- [ ] **Step 5: Commit**

```bash
git add src/utils/pcm-mix.ts tts-service/lib/pcm-mix.ts scripts/smoke-pcm-mix.ts scripts/smoke-tts.ts
git commit -F - <<'MSG'
feat(tts): mix dialogue lines with trimmed edges, matched hosts and short gaps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---
### Task 4: Show script types, validation and Hebrew pointing

**Files:**
- Create: `src/services/voice-show/types.ts`
- Create: `src/services/voice-show/hebrew-pointing.ts`
- Create: `src/services/voice-show/script.ts`
- Create: `scripts/smoke-voice-show-script.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `types.ts`: `ShowHost`, `ShowKind = 'daily' | 'weekly' | 'weather'`, `MOODS`, `Mood`, `MOOD_STYLES`, `SOUND_TAGS`, `MAX_SOUNDS_PER_SHOW`, `MIN_TURNS`, `MAX_TURNS`, `MAX_TURN_CHARS`, `ShowTurn { host; mood; text }`, `ShowScript { turns; warnings }`, `ShowLine { host; text; style?; whisper? }`, `ProducedVoice { filePath; caption?; durationSeconds }`
  - `hebrew-pointing.ts`: `pointHebrewTimes(text: string): string`, `pointSecondPerson(text: string, gender: 'male' | 'female'): string`
  - `script.ts`: `class ShowScriptError extends Error`, `SHOW_RESPONSE_SCHEMA`, `parseShowScript(raw: string): ShowScript`, `toShowLines(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female'): ShowLine[]`, `scriptToNarration(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female'): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-voice-show-script.ts`:

```ts
// Smoke test for the show script validator and the Hebrew pointing table. No network.
//
// Run: npx tsx scripts/smoke-voice-show-script.ts

import {
  parseShowScript, scriptToNarration, SHOW_RESPONSE_SCHEMA, ShowScriptError, toShowLines,
} from '../src/services/voice-show/script';
import { pointHebrewTimes, pointSecondPerson } from '../src/services/voice-show/hebrew-pointing';
import { MOODS, type ShowTurn } from '../src/services/voice-show/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

type RawTurn = { host?: unknown; mood?: unknown; text?: unknown };
const turn = (host: string, text: string, mood = 'hype'): RawTurn => ({ host, mood, text });
const show = (...turns: RawTurn[]) => JSON.stringify({ turns });
const base = (): RawTurn[] => [turn('A', 'בוקר טוב דני!'), turn('B', 'יום ענק מחכה לך!'), turn('A', 'בשמונה וחצי ישיבת צוות.'), turn('B', 'יאללה, שיהיה יום מנצח!')];

function rejects(raw: string, pattern: RegExp) {
  let error: unknown;
  try { parseShowScript(raw); } catch (e) { error = e; }
  assert(error instanceof ShowScriptError, `expected ShowScriptError, got ${String(error)}`);
  assert(pattern.test((error as Error).message), `message "${(error as Error).message}" does not match ${pattern}`);
}

const same = (a: string, b: string) => a.normalize('NFC') === b.normalize('NFC');

// --- parsing and hard failures ---
check('a valid show parses and keeps moods', () => {
  const s = parseShowScript(show(...base().map((t, i) => (i === 1 ? { ...t, mood: 'amused' } : t))));
  assert(s.turns.length === 4, `turns ${s.turns.length}`);
  assert(s.turns[1].mood === 'amused' && s.turns[0].mood === 'hype', 'moods');
  assert(s.warnings.length === 0, `warnings ${s.warnings.join('; ')}`);
});

check('a ```json fence is accepted', () => {
  assert(parseShowScript('```json\n' + show(...base()) + '\n```').turns.length === 4, 'fenced');
});

check('bad JSON, no turns, too few and too many turns are rejected', () => {
  rejects('{"turns": [', /not valid JSON/);
  rejects('{"lines": []}', /no "turns" array/);
  rejects(show(...base().slice(0, 3)), /4-30 turns, got 3/);
  rejects(show(...Array.from({ length: 31 }, (_, i) => turn(i % 2 ? 'B' : 'A', 'שלום'))), /got 31/);
});

check('30 turns of 400 characters are accepted (busy day)', () => {
  const long = 'א'.repeat(399) + '.';
  const s = parseShowScript(show(...Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'B' : 'A', long))));
  assert(s.turns.length === 30, `turns ${s.turns.length}`);
});

check('401 characters in a turn is rejected', () => {
  rejects(show(...base(), turn('A', 'א'.repeat(401))), /401 characters/);
});

check('bad host, non-string text, empty and tag-only text are rejected', () => {
  rejects(show(...base(), turn('C', 'שלום')), /Turn 5: host/);
  rejects(show(...base(), { host: 'A', mood: 'hype', text: 5 }), /Turn 5: text/);
  rejects(show(...base(), turn('B', '   ')), /Turn 5: nothing to say/);
  rejects(show(...base(), turn('B', '<laugh>')), /Turn 5: nothing to say/);
});

check('a show where only one host speaks is rejected', () => {
  rejects(show(...base().map(t => ({ ...t, host: 'A' }))), /Both hosts/);
});

check('a second speaker label inside a turn is rejected', () => {
  rejects(show(...base(), turn('A', 'איזה יום! B: באמת יום ענק')), /Turn 5: contains another speaker label/);
});

// --- repairs ---
check('unknown mood becomes hype with a warning', () => {
  const s = parseShowScript(show(...base(), turn('A', 'וואו', 'ecstatic')));
  assert(s.turns[4].mood === 'hype', `mood ${s.turns[4].mood}`);
  assert(s.warnings.some(w => /unknown mood/.test(w)), 'no warning');
});

check('leading label stripped, "Plan B:" left alone', () => {
  const s = parseShowScript(show(...base(), turn('A', 'A: שלום לכולם'), turn('B', 'Plan B: go')));
  assert(s.turns[4].text === 'שלום לכולם', `text "${s.turns[4].text}"`);
  assert(s.turns[5].text === 'Plan B: go', `text "${s.turns[5].text}"`);
});

check('HTML, foreign tags, closing sound tags, cues and backchannels are stripped', () => {
  const s = parseShowScript(show(...base(),
    turn('A', '<b>שלום</b> <cheer> עולם'),
    turn('B', 'איזה |וואו| יום [laughs] נהדר </laugh>'),
  ));
  assert(s.turns[4].text === 'שלום עולם', `text "${s.turns[4].text}"`);
  assert(s.turns[5].text === 'איזה יום נהדר', `text "${s.turns[5].text}"`);
  assert(s.warnings.length >= 5, `warnings ${s.warnings.length}`);
});

check('sound tags are normalised, emoji and markdown removed, entities decoded', () => {
  const s = parseShowScript(show(...base(), turn('A', '<Laugh> *יופי* 🎉 טום &amp; ג׳רי')));
  assert(s.turns[4].text === '<laugh> יופי טום & ג׳רי', `text "${s.turns[4].text}"`);
});

check('sound budget: at most two, never on consecutive turns', () => {
  const s = parseShowScript(show(
    turn('A', '<chuckle> אחת'), turn('B', '<laugh> שתיים'), turn('A', '<sigh> שלוש'), turn('B', '<gasp> ארבע'),
  ));
  const texts = s.turns.map(t => t.text);
  assert(texts[0] === '<chuckle> אחת', texts[0]);
  assert(texts[1] === 'שתיים', `consecutive kept: ${texts[1]}`);
  assert(texts[2] === '<sigh> שלוש', texts[2]);
  assert(texts[3] === 'ארבע', `over budget kept: ${texts[3]}`);
  assert(s.warnings.filter(w => /sound budget/.test(w)).length === 2, s.warnings.join('; '));
});

check('digits are a warning, not a failure', () => {
  const s = parseShowScript(show(...base(), turn('A', 'ב-10:15 פגישה')));
  assert(s.turns.length === 5, 'rejected');
  assert(s.warnings.some(w => /digits/.test(w)), 'no digits warning');
});

check('the response schema offers every mood and both hosts', () => {
  const item = SHOW_RESPONSE_SCHEMA.properties.turns.items.properties;
  assert(JSON.stringify(item.mood.enum) === JSON.stringify(MOODS), 'moods');
  assert(JSON.stringify(item.host.enum) === '["A","B"]', 'hosts');
});

// --- TTS lines ---
check('toShowLines maps moods to styles, marks whispers and points Hebrew', () => {
  const turns: ShowTurn[] = [
    { host: 'A', mood: 'hype', text: 'בעשר ורבע יש לך פגישה' },
    { host: 'B', mood: 'secret', text: 'ויש הפתעה' },
    { host: 'A', mood: 'warm', text: '<whispers> רק בינינו' },
  ];
  const lines = toShowLines(turns, 'he', 'female');
  assert(lines[0].style === 'excited sports commentator', `style ${lines[0].style}`);
  assert(same(lines[0].text, 'בְּעֶשֶׂר וָרֶבַע יש לָךְ פגישה'), `text ${lines[0].text}`);
  assert(lines[1].style === 'whispering, secretive' && lines[1].whisper === true, 'secret');
  assert(lines[2].whisper === true && lines[0].whisper === false, 'whisper flags');
});

check('toShowLines leaves other languages untouched', () => {
  const lines = toShowLines([{ host: 'A', mood: 'triumph', text: 'At ten fifteen' }], 'en', 'male');
  assert(lines[0].text === 'At ten fifteen' && lines[0].style === 'triumphant, loud and celebratory', JSON.stringify(lines[0]));
});

check('scriptToNarration drops sound tags and joins the turns', () => {
  const text = scriptToNarration([
    { host: 'A', mood: 'hype', text: '<chuckle> בוקר טוב' },
    { host: 'B', mood: 'hype', text: 'באחת עשרה פגישה' },
  ], 'he', 'male');
  assert(same(text, 'בוקר טוב בְּאַחַת עֶשְׂרֵה פגישה'), `text ${text}`);
});

// --- Hebrew pointing ---
const TIMES: Array<[string, string]> = [
  ['באחת עשרה', 'בְּאַחַת עֶשְׂרֵה'],
  ['בעשר ורבע', 'בְּעֶשֶׂר וָרֶבַע'],
  ['בשתים עשרה', 'בִּשְׁתֵּים עֶשְׂרֵה'],
  ['בשתיים עשרה', 'בִּשְׁתֵּים עֶשְׂרֵה'],
  ['בחמש עשרה', 'בַּחֲמֵשׁ עֶשְׂרֵה'],
  ['ושמונה עשרה', 'וּשְׁמוֹנֶה עֶשְׂרֵה'],
  ['ובאחת עשרה', 'וּבְאַחַת עֶשְׂרֵה'],
  ['ולשתים עשרה', 'וְלִשְׁתֵּים עֶשְׂרֵה'],
  ['ארבע עשרה', 'אַרְבַּע עֶשְׂרֵה'],
  ['ושש עשרה', 'וְשֵׁשׁ עֶשְׂרֵה'],
  ['רבע לאחת עשרה', 'רֶבַע לְאַחַת עֶשְׂרֵה'],
  ['עשר', 'עֶשֶׂר'],
  ['ועשר', 'וְעֶשֶׂר'],
];
for (const [plain, pointed] of TIMES) {
  check(`points "${plain}"`, () => {
    const out = pointHebrewTimes(`פגישה ${plain} במשרד`);
    assert(same(out, `פגישה ${pointed} במשרד`), `got ${out}`);
  });
}

const UNTOUCHED = ['אחד עשר שחקנים', 'שמונה עשר', 'עשרה אנשים', 'עשרים ושמונה מעלות', 'בעשרים', 'ארבע', 'ארבעה', 'עשרות', 'בשבע', 'בְּאַחַת עֶשְׂרֵה'];
for (const text of UNTOUCHED) {
  check(`leaves "${text}" alone`, () => {
    assert(pointHebrewTimes(text) === text, `got ${pointHebrewTimes(text)}`);
  });
}

check('second person is pointed for the listener', () => {
  assert(same(pointSecondPerson('יש לך פגישה', 'male'), 'יש לְךָ פגישה'), 'male לך');
  assert(same(pointSecondPerson('יש לך פגישה', 'female'), 'יש לָךְ פגישה'), 'female לך');
  assert(same(pointSecondPerson('והיום שלך', 'female'), 'והיום שֶׁלָּךְ'), 'female שלך');
  assert(same(pointSecondPerson('ולך', 'male'), 'וּלְךָ'), 'male ולך');
  assert(same(pointSecondPerson('ולך', 'female'), 'וְלָךְ'), 'female ולך');
  assert(same(pointSecondPerson('מחכה בשבילך', 'female'), 'מחכה בִּשְׁבִילֵךְ'), 'female בשבילך');
});

check('second-person pointing leaves other words alone', () => {
  for (const text of ['הולך', 'מלך', 'ללכת', 'לכת', 'הלך']) {
    assert(pointSecondPerson(text, 'female') === text, `${text} → ${pointSecondPerson(text, 'female')}`);
  }
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-voice-show-script.ts`
Expected: FAIL with a module-not-found error for `../src/services/voice-show/script`.

- [ ] **Step 3: Implement the types**

Create `src/services/voice-show/types.ts`:

```ts
/**
 * Two-host voice show: shapes shared by the writer, the validator and TTS.
 * See docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md.
 */

export type ShowHost = 'A' | 'B';

/** Which summary the show is about. Daily also covers the tomorrow summary. */
export type ShowKind = 'daily' | 'weekly' | 'weather';

export const MOODS = [
  'hype',
  'triumph',
  'suspense',
  'amused',
  'surprised',
  'mock_disappointed',
  'secret',
  'warm',
] as const;

export type Mood = (typeof MOODS)[number];

/**
 * The style string each mood sends in speechMetadata. Kept short on purpose: in the
 * trial, short styles never changed the spoken words (0 of 57 takes) while long
 * director's notes did (4 of 5).
 */
export const MOOD_STYLES: Record<Mood, string> = {
  hype: 'excited sports commentator',
  triumph: 'triumphant, loud and celebratory',
  suspense: 'slow and suspenseful, building tension',
  amused: 'amused, laughing a little',
  surprised: 'surprised, high pitch',
  mock_disappointed: 'mock-disappointed, deflated',
  secret: 'whispering, secretive',
  warm: 'warm and relaxed, slower',
};

/**
 * Inline sounds the hosts may use. Each was heard by a blind listener on both hosts in
 * sports style. Giggle and snicker collapse into a laugh, groan and phew into a sigh,
 * and cheer, shout, tsk and pff did nothing, so they are not offered.
 */
export const SOUND_TAGS = ['chuckle', 'laugh', 'sigh', 'gasp', 'whispers', 'throat-clearing'] as const;

export const MAX_SOUNDS_PER_SHOW = 2;
export const MIN_TURNS = 4;
export const MAX_TURNS = 30;
export const MAX_TURN_CHARS = 400;

export interface ShowTurn {
  host: ShowHost;
  mood: Mood;
  /** Words to speak, possibly with whitelisted <sound> tags. No HTML, no labels. */
  text: string;
}

export interface ShowScript {
  turns: ShowTurn[];
  /** What the validator repaired silently (stripped tags, unknown moods). For logs. */
  warnings: string[];
}

/** One line as TTS receives it. Also the wire format of tts-service's /api/dialogue. */
export interface ShowLine {
  host: ShowHost;
  text: string;
  style?: string;
  /** Whispered lines keep their level below the host's normal voice when mixed. */
  whisper?: boolean;
}

/** A voice note ready to send. */
export interface ProducedVoice {
  filePath: string;
  /** Admin-only metrics caption, Telegram HTML. */
  caption?: string;
  /** For analytics. */
  durationSeconds: number;
}
```

- [ ] **Step 4: Implement the Hebrew pointing table**

Create `src/services/voice-show/hebrew-pointing.ts`:

```ts
/**
 * Niqqud for the Hebrew words Gemini TTS reads wrong. A fixed table applied in code;
 * the writer LLM never adds niqqud.
 *
 * Clock words: in the 2026-10 trial the hosts misread "עשר ורבע" and, even spelled
 * out, "אחת עשרה" (3 of 24 takes). With niqqud, "עשר ורבע" went 0 of 19 wrong.
 * - feminine teens, as clock times use them: (unit) עשרה → אַחַת עֶשְׂרֵה
 * - ten on its own: עשר → עֶשֶׂר, except after a masculine unit (אחד עשר is "asar")
 * - quarter: רבע → רֶבַע, ורבע → וָרֶבַע
 *
 * Second person: "לך", "שלך", "אותך" and the like are spelled the same for a man and
 * a woman, so TTS has to guess and defaults to the masculine. The show addresses only
 * the listener in the second person, so they are pointed for the listener's gender.
 *
 * A prefix ו/ב/ל/כ (or ו plus one of the others) is pointed too; מ, ש and ה prefixes
 * are left bare. Words that already carry niqqud are left alone.
 */

const LETTER = '\\u05D0-\\u05EA';
const MARK = '\\u0591-\\u05C7';
const START = `(?<![${LETTER}${MARK}])`;
const END = `(?![${LETTER}${MARK}])`;
const PREFIX = '(ו?[בלכמשה]?)';

const SHVA = 'ְ';
const HATAF_PATAH = 'ֲ';
const HIRIQ = 'ִ';
const PATAH = 'ַ';
const QAMATS = 'ָ';
const DAGESH = 'ּ';

const FEMININE_UNITS: Record<string, string> = {
  'אחת': 'אַחַת',
  'שתים': 'שְׁתֵּים',
  'שתיים': 'שְׁתֵּים',
  'שלוש': 'שְׁלוֹשׁ',
  'ארבע': 'אַרְבַּע',
  'חמש': 'חֲמֵשׁ',
  'שש': 'שֵׁשׁ',
  'שבע': 'שְׁבַע',
  'שמונה': 'שְׁמוֹנֶה',
  'תשע': 'תְּשַׁע',
};
const TEEN = 'עֶשְׂרֵה';
const TEN = 'עֶשֶׂר';
const QUARTER = 'רֶבַע';
const MASCULINE_UNITS = ['אחד', 'שנים', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה'];

const SECOND_PERSON: Record<string, { male: string; female: string }> = {
  'לך': { male: 'לְךָ', female: 'לָךְ' },
  'שלך': { male: 'שֶׁלְּךָ', female: 'שֶׁלָּךְ' },
  'אותך': { male: 'אוֹתְךָ', female: 'אוֹתָךְ' },
  'עליך': { male: 'עָלֶיךָ', female: 'עָלַיִךְ' },
  'אליך': { male: 'אֵלֶיךָ', female: 'אֵלַיִךְ' },
  'בשבילך': { male: 'בִּשְׁבִילְךָ', female: 'בִּשְׁבִילֵךְ' },
  'איתך': { male: 'אִתְּךָ', female: 'אִתָּךְ' },
  'אצלך': { male: 'אֶצְלְךָ', female: 'אֶצְלֵךְ' },
  'ממך': { male: 'מִמְּךָ', female: 'מִמֵּךְ' },
};

const TEEN_RE = new RegExp(`${START}${PREFIX}(${Object.keys(FEMININE_UNITS).join('|')})\\s+עשרה${END}`, 'g');
const TEN_RE = new RegExp(`(?<!(?:${MASCULINE_UNITS.join('|')})\\s+)${START}${PREFIX}עשר${END}`, 'g');
const QUARTER_RE = new RegExp(`${START}${PREFIX}רבע${END}`, 'g');
const SECOND_PERSON_RE = new RegExp(`${START}(ו?)(${Object.keys(SECOND_PERSON).join('|')})${END}`, 'g');

type Lead = 'shva' | 'hataf' | 'vowel';

/** How the pointed word's first letter is voweled, which decides the prefix vowel. */
function leadOf(pointed: string): Lead {
  const marks = /^[֑-ׇ]*/.exec(pointed.slice(1))![0];
  if (marks.includes(SHVA)) return 'shva';
  if (marks.includes(HATAF_PATAH)) return 'hataf';
  return 'vowel';
}

/** Points a bare prefix for the pointed word it attaches to. */
function pointPrefix(prefix: string, pointed: string): string {
  if (!prefix) return '';
  const lead = leadOf(pointed);
  const letters = [...prefix];
  const last = letters[letters.length - 1];

  if (letters.length === 1 && last === 'ו') {
    // Shuruk before a shva or a labial (ב, מ, פ); patah before a hataf; else shva.
    if (lead === 'shva' || 'במפ'.includes(pointed[0])) return 'ו' + DAGESH;
    return 'ו' + (lead === 'hataf' ? PATAH : SHVA);
  }
  if (last !== 'ב' && last !== 'כ' && last !== 'ל') return prefix;

  // A word-initial ב or כ takes dagesh; after a ו it no longer starts the word.
  const dagesh = letters.length === 1 && last !== 'ל' ? DAGESH : '';
  const vowel = lead === 'shva' ? HIRIQ : lead === 'hataf' ? PATAH : SHVA;
  const pointedLast = last + dagesh + vowel;
  if (letters.length === 1) return pointedLast;
  // Leading ו: shuruk before ב or before a shva, else shva.
  return 'ו' + (last === 'ב' || vowel === SHVA ? DAGESH : SHVA) + pointedLast;
}

const nfc = (s: string) => s.normalize('NFC');

export function pointHebrewTimes(text: string): string {
  return text
    .replace(TEEN_RE, (_m, prefix: string, unit: string) => {
      const pointed = FEMININE_UNITS[unit];
      return nfc(`${pointPrefix(prefix, pointed)}${pointed} ${TEEN}`);
    })
    .replace(TEN_RE, (_m, prefix: string) => nfc(pointPrefix(prefix, TEN) + TEN))
    .replace(QUARTER_RE, (_m, prefix: string) => nfc((prefix === 'ו' ? 'ו' + QAMATS : pointPrefix(prefix, QUARTER)) + QUARTER));
}

export function pointSecondPerson(text: string, gender: 'male' | 'female'): string {
  return text.replace(SECOND_PERSON_RE, (_m, vav: string, word: string) => {
    const pointed = SECOND_PERSON[word][gender];
    return nfc(pointPrefix(vav, pointed) + pointed);
  });
}
```

- [ ] **Step 5: Implement the validator**

Create `src/services/voice-show/script.ts`:

```ts
/**
 * Parses and polices the show writer's JSON before any of it reaches TTS.
 *
 * Hard failures throw ShowScriptError so the writer can regenerate once: bad JSON,
 * a host other than A/B, too few or too many turns, a turn with nothing to say or over
 * the length limit, two speakers merged into one turn, a show where one host never
 * speaks. Everything else is repaired in place and noted in `warnings`: unknown moods
 * become hype, HTML and unlisted tags are stripped, |backchannels| and [cues] removed,
 * sounds over budget dropped.
 */

import { pointHebrewTimes, pointSecondPerson } from './hebrew-pointing';
import {
  MAX_SOUNDS_PER_SHOW, MAX_TURN_CHARS, MAX_TURNS, MIN_TURNS, MOOD_STYLES, MOODS, SOUND_TAGS,
  type Mood, type ShowLine, type ShowScript, type ShowTurn,
} from './types';

export class ShowScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShowScriptError';
  }
}

/**
 * JSON Schema handed to the writer model. Turn-count and length limits are enforced by
 * the parser instead, so the schema only uses keywords every Gemini model accepts.
 */
export const SHOW_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          host: { type: 'string', enum: ['A', 'B'] },
          mood: { type: 'string', enum: [...MOODS] },
          text: { type: 'string' },
        },
        required: ['host', 'mood', 'text'],
      },
    },
  },
  required: ['turns'],
};

const SOUNDS: ReadonlySet<string> = new Set(SOUND_TAGS);
const ANY_TAG = /<\s*(\/?)\s*([A-Za-z][\w-]*)[^<>]*>/g;
const SOUND_TAG = /<([a-z-]+)>/g;
const LEADING_LABEL = /^\s*(?:host\s*)?[AB]\s*[:：]\s*/i;
const INNER_LABEL = /(?:^|[.!?]\s+)(?:host\s*)?[AB]\s*[:：]\s/i;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function parseShowScript(raw: string): ShowScript {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new ShowScriptError('Response is not valid JSON');
  }

  const rawTurns = (data as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(rawTurns)) throw new ShowScriptError('Response has no "turns" array');
  if (rawTurns.length < MIN_TURNS || rawTurns.length > MAX_TURNS) {
    throw new ShowScriptError(`Expected ${MIN_TURNS}-${MAX_TURNS} turns, got ${rawTurns.length}`);
  }

  const warnings: string[] = [];
  const turns = rawTurns.map((value, i) => normalizeTurn(value, i + 1, warnings));
  if (!turns.some(t => t.host === 'A') || !turns.some(t => t.host === 'B')) {
    throw new ShowScriptError('Both hosts must speak');
  }
  enforceSoundBudget(turns, warnings);
  return { turns, warnings };
}

function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(raw);
  return fenced ? fenced[1] : raw.trim();
}

function normalizeTurn(value: unknown, n: number, warnings: string[]): ShowTurn {
  const t = (value ?? {}) as { host?: unknown; mood?: unknown; text?: unknown };
  if (t.host !== 'A' && t.host !== 'B') throw new ShowScriptError(`Turn ${n}: host must be "A" or "B"`);
  if (typeof t.text !== 'string') throw new ShowScriptError(`Turn ${n}: text must be a string`);

  let mood: Mood = 'hype';
  if (typeof t.mood === 'string' && (MOODS as readonly string[]).includes(t.mood)) {
    mood = t.mood as Mood;
  } else {
    warnings.push(`Turn ${n}: unknown mood ${JSON.stringify(t.mood)}, using hype`);
  }

  const text = cleanText(t.text, n, warnings);
  if (!/\p{L}/u.test(text.replace(SOUND_TAG, ''))) throw new ShowScriptError(`Turn ${n}: nothing to say`);
  if (text.length > MAX_TURN_CHARS) {
    throw new ShowScriptError(`Turn ${n}: ${text.length} characters, limit ${MAX_TURN_CHARS}`);
  }
  if (/\d/.test(text)) warnings.push(`Turn ${n}: contains digits (numbers should be words)`);
  return { host: t.host, mood, text };
}

function cleanText(input: string, n: number, warnings: string[]): string {
  let text = input.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, entity: string) => ENTITIES[entity]);

  text = text.replace(LEADING_LABEL, '');
  if (INNER_LABEL.test(text)) {
    throw new ShowScriptError(`Turn ${n}: contains another speaker label; one host per turn`);
  }

  // |wow| backchannels make a phantom second voice in a single-voice request.
  text = text.replace(/\|[^|\n]{0,40}\|/g, m => {
    warnings.push(`Turn ${n}: removed backchannel ${m}`);
    return ' ';
  }).replace(/\|/g, ' ');

  // Keep whitelisted sounds, normalised to <name>. HTML and any other tag go.
  text = text.replace(ANY_TAG, (m, slash: string, name: string) => {
    const tag = name.toLowerCase();
    if (!slash && SOUNDS.has(tag)) return ` <${tag}> `;
    warnings.push(`Turn ${n}: removed tag ${m}`);
    return ' ';
  });

  // [laughs]-style cues would be read aloud.
  text = text.replace(/\[[^\]\n]{0,30}\]/g, m => {
    warnings.push(`Turn ${n}: removed cue ${m}`);
    return ' ';
  });

  text = text.replace(/\p{Extended_Pictographic}️?/gu, '').replace(/[*_#`~]/g, '');
  return text.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}

/** At most MAX_SOUNDS_PER_SHOW sounds, never on consecutive turns. Later ones are dropped. */
function enforceSoundBudget(turns: ShowTurn[], warnings: string[]): void {
  let used = 0;
  let lastTurn = -2;
  turns.forEach((turn, i) => {
    turn.text = turn.text
      .replace(SOUND_TAG, tag => {
        if (used < MAX_SOUNDS_PER_SHOW && (lastTurn === i || lastTurn < i - 1)) {
          used++;
          lastTurn = i;
          return tag;
        }
        warnings.push(`Turn ${i + 1}: dropped ${tag} (sound budget)`);
        return ' ';
      })
      .replace(/\s+/g, ' ')
      .trim();
  });
}

function speakable(text: string, language: string, listenerGender: 'male' | 'female'): string {
  return language === 'he' ? pointSecondPerson(pointHebrewTimes(text), listenerGender) : text;
}

/** Turns as TTS lines: mood becomes its style string; Hebrew words get their niqqud. */
export function toShowLines(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female'): ShowLine[] {
  return turns.map(turn => ({
    host: turn.host,
    text: speakable(turn.text, language, listenerGender),
    style: MOOD_STYLES[turn.mood],
    whisper: turn.mood === 'secret' || turn.text.includes('<whispers>'),
  }));
}

/** The whole show as one paragraph without sounds, for the single-narrator fallback. */
export function scriptToNarration(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female'): string {
  const text = turns.map(t => t.text.replace(SOUND_TAG, ' ').replace(/\s+/g, ' ').trim()).join(' ');
  return speakable(text, language, listenerGender);
}
```

- [ ] **Step 6: Run the tests and type-checks**

Run: `npx tsx scripts/smoke-voice-show-script.ts && npx tsc --noEmit`
Expected: all `OK`, type-check silent. If a pointing case fails, fix `hebrew-pointing.ts`, not the expected strings: the expected strings are the trial's winning forms and standard Hebrew pointing.

- [ ] **Step 7: Commit**

```bash
git add src/services/voice-show/types.ts src/services/voice-show/hebrew-pointing.ts src/services/voice-show/script.ts scripts/smoke-voice-show-script.ts
git commit -F - <<'MSG'
feat(voice): validate show scripts and point Hebrew time and second-person words

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---
### Task 5: Show writer: JSON-mode completion, Hebrew prompt, context, regenerate-once

**Files:**
- Modify: `src/services/ai-provider.ts` (`callGemini`, `generateAICompletion`, new `AICompletionOptions`)
- Create: `src/prompts/voice-show/types.ts`
- Create: `src/prompts/voice-show/he.ts`
- Create: `src/prompts/voice-show/index.ts`
- Create: `src/services/voice-show/context.ts`
- Create: `src/services/voice-show/writer.ts`
- Create: `scripts/smoke-voice-show-writer.ts`

**Interfaces:**
- Consumes: `parseShowScript`, `ShowScriptError`, `SHOW_RESPONSE_SCHEMA` (Task 4); `ShowKind`, `ShowScript`, `SOUND_TAGS`, `MAX_SOUNDS_PER_SHOW` (Task 4); `sanitizeForPrompt` from `src/prompts/shared-builders.ts`; `buildRulesSection` from `src/prompts/voice-condenser/template.ts`.
- Produces:
  - `ai-provider.ts`: `interface AICompletionOptions { responseJsonSchema?: object }`; `generateAICompletion(prompt: string, modelId?: string, options?: AICompletionOptions)`
  - `prompts/voice-show/types.ts`: `ShowPerson { name; gender? }`, `ShowPromptContext { kind; summary; locale; listener: { name; gender }; spouse?; kids: ShowPerson[]; hasKidsCalendars; culture?; globalRules?; isNextWeek? }`
  - `prompts/voice-show/index.ts`: `hasShowPrompt(locale: string): boolean`, `buildShowPrompt(context: ShowPromptContext): string`
  - `context.ts`: `buildShowContext(summary: string, user: UserConfig, kind: ShowKind, isNextWeek?: boolean): ShowPromptContext`
  - `writer.ts`: `type CompletionFn`, `interface WrittenShow { script: ShowScript; completion: AICompletionResult; attempts: number }`, `interface WriteShowOptions { complete?: CompletionFn; modelId?: string }`, `writeShowScript(context: ShowPromptContext, options?: WriteShowOptions): Promise<WrittenShow>`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-voice-show-writer.ts`:

```ts
// Smoke test for the show prompt, the context builder and the writer's regenerate-once
// loop. A fake completion function stands in for the LLM. No network.
//
// Run: npx tsx scripts/smoke-voice-show-writer.ts

import type { AICompletionOptions, AICompletionResult } from '../src/services/ai-provider';
import { buildShowPrompt, hasShowPrompt } from '../src/prompts/voice-show';
import type { ShowPromptContext } from '../src/prompts/voice-show/types';
import { buildShowContext } from '../src/services/voice-show/context';
import { ShowScriptError, SHOW_RESPONSE_SCHEMA } from '../src/services/voice-show/script';
import { writeShowScript } from '../src/services/voice-show/writer';
import type { UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const context = (over: Partial<ShowPromptContext> = {}): ShowPromptContext => ({
  kind: 'daily',
  summary: '<b>בוקר טוב</b>\n• 10:15 - פגישה עם עו"ד לוי',
  locale: 'he',
  listener: { name: 'דני', gender: 'male' },
  kids: [],
  hasKidsCalendars: false,
  ...over,
});

const VALID = JSON.stringify({ turns: [
  { host: 'A', mood: 'hype', text: 'בוקר טוב דני!' },
  { host: 'B', mood: 'amused', text: 'יום ענק!' },
  { host: 'A', mood: 'hype', text: 'בעשר ורבע פגישה עם עורך הדין לוי.' },
  { host: 'B', mood: 'warm', text: 'שיהיה יום מנצח!' },
] });

function completion(text: string): AICompletionResult {
  return { text, usage: { inputTokens: 10, outputTokens: 20 }, stopReason: 'STOP', model: 'Fake', durationMs: 5 };
}

async function main() {
  await check('Hebrew has a show prompt, English and Russian do not yet', () => {
    assert(hasShowPrompt('he'), 'he');
    assert(!hasShowPrompt('en') && !hasShowPrompt('ru') && !hasShowPrompt('__proto__'), 'en/ru/proto');
  });

  await check('daily prompt carries the summary, the listener and the rules', () => {
    const p = buildShowPrompt(context());
    assert(p.includes('• 10:15 - פגישה עם עו"ד לוי'), 'summary missing');
    assert(p.includes('דני') && p.includes('לשון זכר'), 'male listener');
    assert(p.includes('"turns"') && p.includes('"host"'), 'JSON shape');
    for (const mood of ['hype', 'triumph', 'suspense', 'amused', 'surprised', 'mock_disappointed', 'secret', 'warm']) {
      assert(p.includes(mood), `mood ${mood} missing`);
    }
    for (const sound of ['<chuckle>', '<laugh>', '<sigh>', '<gasp>', '<whispers>', '<throat-clearing>']) {
      assert(p.includes(sound), `sound ${sound} missing`);
    }
    assert(p.includes('לא בספרות'), 'times-as-words rule');
    assert(p.includes('|וואו|'), 'backchannel ban');
    assert(p.includes('מזג האוויר מגיע מיד אחרי התאריך'), 'weather-first rule');
    assert(p.includes('אל תמציאו אירועים'), 'empty-day rule');
    assert(p.includes('יש לכם'), 'personal-address rule');
  });

  await check('female listener is addressed in the feminine', () => {
    const p = buildShowPrompt(context({ listener: { name: 'מיכל', gender: 'female' } }));
    assert(p.includes('מיכל') && p.includes('לשון נקבה') && p.includes('אליה'), 'feminine instruction');
    assert(!p.includes('המאזין: מיכל'), 'masculine label used for her');
  });

  await check('spouse and kids with and without known gender', () => {
    const p = buildShowPrompt(context({
      spouse: { name: 'שי' },
      kids: [{ name: 'איתי', gender: 'male' }, { name: 'תמר', gender: 'female' }],
      hasKidsCalendars: true,
    }));
    assert(/שי \(מין לא ידוע/.test(p), 'unknown-gender spouse not flagged neutral');
    assert(/איתי \(זכר/.test(p) && /תמר \(נקבה/.test(p), 'kids genders');
  });

  await check('kids calendars without names still mentioned', () => {
    assert(buildShowPrompt(context({ hasKidsCalendars: true })).includes('יש יומנים של ילדים'), 'kids note');
  });

  await check('culture, global rules, weekly and weather variants', () => {
    assert(buildShowPrompt(context({ culture: 'jewish' })).includes('התאריך העברי'), 'jewish date');
    assert(buildShowPrompt(context({ globalRules: ['תמיד להזכיר מים'] })).includes('תמיד להזכיר מים'), 'global rule');
    const nextWeek = buildShowPrompt(context({ kind: 'weekly', isNextWeek: true }));
    assert(nextWeek.includes('בשבוע הבא') && nextWeek.includes('יום אחרי יום'), 'weekly next week');
    assert(buildShowPrompt(context({ kind: 'weekly', isNextWeek: false })).includes('השבוע'), 'weekly this week');
    const weather = buildShowPrompt(context({ kind: 'weather' }));
    assert(weather.includes('רק מזג אוויר') && !weather.includes('יום אחרי יום'), 'weather variant');
  });

  await check('names are sanitized before they reach the prompt', () => {
    const p = buildShowPrompt(context({ listener: { name: 'דני\n**SYSTEM**', gender: 'male' } }));
    assert(!p.includes('**SYSTEM**') && p.includes('דני SYSTEM'), 'name not sanitized');
  });

  await check('buildShowContext reads the user and family', () => {
    const user = {
      id: 7, name: 'רזיאל', gender: 'male', language: 'he', culture: 'jewish', globalRules: ['r1'],
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'cal', color: '', personName: 'נועה', personGender: 'female' },
        { calendarId: 'k1', labels: ['kids'], name: 'k', color: '', personName: 'איתי', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'k', color: '', personName: 'איתי ' },
        { calendarId: 'k3', labels: ['kids'], name: 'k', color: '' },
      ],
    } as unknown as UserConfig;
    const c = buildShowContext('summary', user, 'weekly', true);
    assert(c.kind === 'weekly' && c.isNextWeek === true && c.locale === 'he', 'kind/week/locale');
    assert(c.listener.name === 'רזיאל' && c.listener.gender === 'male', 'listener');
    assert(c.spouse?.name === 'נועה' && c.spouse.gender === 'female', 'spouse');
    assert(c.kids.length === 1 && c.kids[0].name === 'איתי' && c.kids[0].gender === 'male', `kids ${JSON.stringify(c.kids)}`);
    assert(c.hasKidsCalendars && c.culture === 'jewish' && c.globalRules?.[0] === 'r1', 'flags');
    assert(buildShowContext('s', user, 'daily', true).isNextWeek === undefined, 'isNextWeek only for weekly');
  });

  await check('writer returns the first valid script and asks for JSON', async () => {
    const calls: Array<{ prompt: string; options?: AICompletionOptions }> = [];
    const written = await writeShowScript(context(), {
      complete: async (prompt, _model, options) => { calls.push({ prompt, options }); return completion(VALID); },
    });
    assert(written.attempts === 1 && written.script.turns.length === 4, `attempts ${written.attempts}`);
    assert(calls[0].options?.responseJsonSchema === SHOW_RESPONSE_SCHEMA, 'schema not passed');
  });

  await check('writer regenerates once with the rejection reason', async () => {
    const prompts: string[] = [];
    const written = await writeShowScript(context(), {
      complete: async prompt => { prompts.push(prompt); return completion(prompts.length === 1 ? '{"turns": []}' : VALID); },
    });
    assert(written.attempts === 2, `attempts ${written.attempts}`);
    assert(prompts[1].includes('Your previous answer was rejected') && prompts[1].includes('got 0'), 'reason not passed back');
  });

  await check('writer gives up after the second bad answer', async () => {
    let calls = 0;
    let error: unknown;
    try {
      await writeShowScript(context(), { complete: async () => { calls++; return completion('not json'); } });
    } catch (e) { error = e; }
    assert(error instanceof ShowScriptError && calls === 2, `calls ${calls} error ${String(error)}`);
  });

  await check('writer passes the model override and lets API errors through', async () => {
    let model: string | undefined;
    await writeShowScript(context(), { modelId: 'gemini-3.8-flash', complete: async (_p, m) => { model = m; return completion(VALID); } });
    assert(model === 'gemini-3.8-flash', `model ${model}`);
    let error: unknown;
    try {
      await writeShowScript(context(), { complete: async () => { throw Object.assign(new Error('quota'), { status: 429 }); } });
    } catch (e) { error = e; }
    assert((error as { status?: number })?.status === 429, 'API error swallowed');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-voice-show-writer.ts`
Expected: FAIL with a module-not-found error for `../src/prompts/voice-show`.

- [ ] **Step 3: Add JSON mode to `generateAICompletion`**

In `src/services/ai-provider.ts`, after the `AICompletionResult` interface, add:

```ts
/**
 * Extra request options. Gemini only: every model in the catalog is Gemini, and the
 * Claude and OpenAI paths ignore these.
 */
export interface AICompletionOptions {
  /** JSON Schema the answer must follow. Also sets responseMimeType to application/json. */
  responseJsonSchema?: object;
}
```

Change `callGemini`'s signature and its request config:

```ts
async function callGemini(prompt: string, modelId?: string, options: AICompletionOptions = {}): Promise<AICompletionResult> {
```

```ts
    config: {
      abortSignal: AbortSignal.timeout(45_000),
      ...(thinkingLevel && {
        thinkingConfig: { thinkingLevel: ThinkingLevel[thinkingLevel as keyof typeof ThinkingLevel] },
      }),
      ...(options.responseJsonSchema && {
        responseMimeType: 'application/json',
        responseJsonSchema: options.responseJsonSchema,
      }),
    },
```

Change `generateAICompletion`'s signature, JSDoc and Gemini call:

```ts
 * @param prompt - The prompt to send to the AI
 * @param modelId - Optional model ID to override default model
 * @param options - Optional request options (JSON mode); Gemini only
 * @returns AI completion result with text and usage statistics
 * @throws Original error if all retries fail (preserves .status for downstream detection)
 */
export async function generateAICompletion(prompt: string, modelId?: string, options?: AICompletionOptions): Promise<AICompletionResult> {
```

```ts
      } else if (config.MODEL_CONFIG.provider === 'gemini') {
        result = await callGemini(prompt, modelId, options);
```

- [ ] **Step 4: Create the prompt types and the Hebrew prompt**

Create `src/prompts/voice-show/types.ts`:

```ts
/**
 * Context for the two-host show writer prompts.
 */

import type { ShowKind } from '../../services/voice-show/types';

export interface ShowPerson {
  name: string;
  /** Unknown gender means: name plus neutral phrasing. */
  gender?: 'male' | 'female';
}

export interface ShowPromptContext {
  kind: ShowKind;
  /** The text summary exactly as the user received it (Telegram HTML). */
  summary: string;
  /** Locale code: 'he' today. */
  locale: string;
  listener: { name: string; gender: 'male' | 'female' };
  spouse?: ShowPerson;
  /** Kids with a name on their calendar. */
  kids: ShowPerson[];
  /** Kids calendars exist, named or not. */
  hasKidsCalendars: boolean;
  /** 'jewish' | 'default' */
  culture?: string;
  globalRules?: string[];
  /** Weekly only: next week rather than this one. */
  isNextWeek?: boolean;
}
```

Create `src/prompts/voice-show/he.ts`:

```ts
/**
 * Hebrew two-host show prompt
 * תסריט לשני מגישים בסגנון שדרני ספורט, כפלט JSON של תורות.
 *
 * Content rules carry over from ../voice-condenser/he.ts and week-he.ts: every event
 * kept, every time in words, weather right after the date, birthday names, the user's
 * own rules. The show rules add the hosts, personal address, moods and sounds.
 */

import { sanitizeForPrompt } from '../shared-builders';
import { buildRulesSection } from '../voice-condenser/template';
import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS } from '../../services/voice-show/types';
import type { ShowPerson, ShowPromptContext } from './types';

const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');

function personLine(label: string, person: ShowPerson): string {
  const name = sanitizeForPrompt(person.name);
  if (person.gender === 'male') return `${label}: ${name} (זכר — דברו עליו בלשון זכר)`;
  if (person.gender === 'female') return `${label}: ${name} (נקבה — דברו עליה בלשון נקבה)`;
  return `${label}: ${name} (מין לא ידוע — השתמשו בשם ובניסוח שלא מסגיר מין, למשל "ל${name} יש..." במקום "הוא" או "היא")`;
}

function listenerLine(context: ShowPromptContext): string {
  const name = sanitizeForPrompt(context.listener.name);
  return context.listener.gender === 'female'
    ? `המאזינה: ${name}. היא אישה — פנו אליה בשמה ובלשון נקבה ("את", "יש לך", "תזכרי", "מוכנה").`
    : `המאזין: ${name}. הוא גבר — פנו אליו בשמו ובלשון זכר ("אתה", "יש לך", "תזכור", "מוכן").`;
}

function kindRules(context: ShowPromptContext): { goal: string; content: string[]; length: string } {
  const female = context.listener.gender === 'female';
  if (context.kind === 'weekly') {
    const weekRef = context.isNextWeek ? 'בשבוע הבא' : 'השבוע';
    return {
      goal: `מה שמחכה ${female ? 'למאזינה' : 'למאזין'} ${weekRef}`,
      content: [
        `פתחו בסקירה קצרה (למשל "הנה מה שמחכה לך ${weekRef}").`,
        context.culture === 'jewish'
          ? 'השתמשו בתאריכים עבריים (בלי תאריכים לועזיים ובלי שנה עברית).'
          : 'השתמשו בתאריכים לועזיים.',
        'עברו יום אחרי יום, עם ימים יחסיים ("ביום שלישי", "ביום חמישי"), והדגישו את האירועים החשובים.',
        'כל אירוע מהסיכום נכנס, עם היום והשעה שלו. מותר לאחד כמה אירועים של אותו יום בתור אחד.',
        'לאירועי משפחה ציינו בטבעיות של מי האירוע.',
        'שבוע בלי אירועים: אמרו שהיומן פנוי. אל תמציאו אירועים.',
      ],
      length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). בשבוע עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
    };
  }

  if (context.kind === 'weather') {
    return {
      goal: 'תחזית מזג האוויר של היום',
      content: [
        'רק מזג אוויר: טמפרטורות, גשם, רוח, ואיכות אוויר אם היא מופיעה בסיכום.',
        'סיימו בטיפ מעשי אחד (מטרייה, קרם הגנה, שכבה נוספת).',
      ],
      length: 'כ-20-35 שניות דיבור (בערך 50-90 מילים), 4-8 תורות.',
    };
  }

  return {
    goal: `היום של ${female ? 'המאזינה' : 'המאזין'}`,
    content: [
      context.culture === 'jewish'
        ? 'אמרו רק את התאריך העברי עם היום בשבוע (בלי תאריך לועזי ובלי שנה עברית).'
        : 'אמרו את התאריך עם היום בשבוע.',
      'מזג האוויר מגיע מיד אחרי התאריך, לפני לוח הזמנים: משפט או שניים עם טיפ מעשי.',
      'כל אירוע מהסיכום נכנס, עם השעה שלו. מותר לאחד כמה אירועים קטנים בתור אחד.',
      'ילדים: בקצרה ובטבעיות (למשל "לאסוף את דני בשתיים").',
      'מבט לשבוע, אם יש בסיכום: בקצרה, רק האירועים המרכזיים.',
      'יום בלי אירועים: אמרו שהיומן פנוי וחגגו את זה. אל תמציאו אירועים.',
    ],
    length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). ביום עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
  };
}

export function buildShowPrompt(context: ShowPromptContext): string {
  const female = context.listener.gender === 'female';
  const listener = female ? 'המאזינה' : 'המאזין';
  const toListener = female ? 'אליה' : 'אליו';
  const { goal, content, length } = kindRules(context);

  const family = [listenerLine(context)];
  if (context.spouse) family.push(personLine('בן או בת הזוג', context.spouse));
  for (const kid of context.kids) family.push(personLine('ילד או ילדה', kid));
  if (!context.kids.length && context.hasKidsCalendars) family.push('יש יומנים של ילדים.');

  const rules = buildRulesSection(context.globalRules, 'כללים אישיים של המשתמש (יש ליישם):');

  const allContent = [
    ...content,
    'כל השעות במילים מלאות, לא בספרות: "תשע בבוקר", "עשר ורבע", "אחת עשרה וחצי", "ארבע וחצי אחר הצהריים".',
    'גם שאר המספרים במילים, למשל טמפרטורות ("עשרים ושמונה מעלות").',
    'ימי הולדת: הוציאו את שם האדם מהאירוע ("יום ההולדת של יוחנן").',
    'שמות מלאים, בלי קיצורים.',
    'ההתלהבות והבדיחות לא מוסיפות ולא משמיטות עובדות: אין אירועים, שעות, שמות או פרטים שלא מופיעים בסיכום.',
  ];

  return `אתם כותבים תסריט לתוכנית אודיו קצרה בעברית על ${goal}: שני מגישים נלהבים, בסגנון שדרני ספורט.

**המשפחה:**
${family.join('\n')}
${rules}
**המגישים:**
- A: המגיש המוביל. חם, בטוח, סוף שנות השלושים.
- B: המגיש הצעיר. אנרגטי, שנות העשרים.
שניהם גברים ומדברים על עצמם בלשון זכר. אין להם שמות, ואל תמציאו להם.

**תוכן (חובה):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**סגנון:**
- אנרגיה של שידור ספורט: קצב, התלהבות, מסירות בין המגישים, "יאללה", "איזה יום!".
- פנייה אישית: הזכירו את השם כבר בפתיחה, ודברו ${toListener} ישירות בגוף שני ובלשון הנכונה. לא "יש לכם" — "יש לך".
- רק ${listener} מקבל${female ? 'ת' : ''} פנייה בגוף שני. המגישים לא אומרים זה לזה "לך", "שלך", "אותך", "עליך", "איתך".
- תורות קצרים: משפט או שניים בכל תור. המגישים מתחלפים ומגיבים זה לזה.
- אורך: ${length}
- פתיחה קצרה וסגירה קצרה ואנרגטית.

**מצב רוח (mood) לכל תור, אחד מהרשימה:**
- hype: ברירת המחדל, התלהבות של שדרן
- triumph: חגיגה (משהו משמח, סוף יום מוצלח)
- suspense: מתח לפני משהו גדול
- amused: משועשע
- surprised: מופתע
- mock_disappointed: אכזבה משחקית (גשם, השכמה מוקדמת)
- secret: לחישה סודית (רמז, הפתעה)
- warm: חם ורגוע (סגירה, רגע נוגע)
רוב התורות hype. שלבו 2-4 מצבי רוח אחרים במקומות שהתוכן מצדיק.

**צלילים:**
- אפשר להכניס לתוך הטקסט צליל אחד או שניים מהרשימה הזאת בלבד: ${SOUND_LIST}
- לכל היותר ${MAX_SOUNDS_PER_SHOW} בכל התוכנית, ולא בשני תורות רצופים. רק ברגע שמצדיק אותם.
- אין שום תגית אחרת: אין HTML, אין אימוג'י, אין markdown.
- אין קריאות ביניים בין קווים אנכיים כמו |וואו|. תגובה של מגיש היא תור קצר משלו.
- אל תכתבו "A:" או "B:" בתוך הטקסט.

**פלט:** JSON בלבד, בין 6 ל-20 תורות:
{"turns":[{"host":"A","mood":"hype","text":"..."},{"host":"B","mood":"amused","text":"..."}]}

**הסיכום המקורי (עם עיצוב — התעלמו מהעיצוב):**
${context.summary}`;
}
```

Create `src/prompts/voice-show/index.ts`:

```ts
/**
 * Two-host show prompts, per language. A language gets the show only when it has a
 * prompt here and host voices in voice-generator's table.
 */

import { buildShowPrompt as buildHebrewShowPrompt } from './he';
import type { ShowPromptContext } from './types';

export type { ShowPromptContext, ShowPerson } from './types';

const builders: Record<string, (context: ShowPromptContext) => string> = {
  he: buildHebrewShowPrompt,
};

export function hasShowPrompt(locale: string): boolean {
  return Object.hasOwn(builders, locale);
}

export function buildShowPrompt(context: ShowPromptContext): string {
  if (!hasShowPrompt(context.locale)) throw new Error(`No show prompt for locale "${context.locale}"`);
  return builders[context.locale](context);
}
```

- [ ] **Step 5: Create the context builder and the writer**

Create `src/services/voice-show/context.ts`:

```ts
/**
 * Builds the show writer's context from the user: who is listening, and the family
 * the hosts may mention, with genders where the calendars record them.
 */

import type { UserConfig } from '../../types';
import type { ShowPerson, ShowPromptContext } from '../../prompts/voice-show/types';
import type { ShowKind } from './types';

export function buildShowContext(summary: string, user: UserConfig, kind: ShowKind, isNextWeek = false): ShowPromptContext {
  const calendars = user.calendarAssignments ?? [];
  const spouse = calendars.find(cal => cal.labels.includes('spouse') && cal.personName?.trim());

  // A kid can have several calendars; name each kid once.
  const kids: ShowPerson[] = [];
  const seen = new Set<string>();
  for (const cal of calendars) {
    const name = cal.personName?.trim();
    if (!cal.labels.includes('kids') || !name || seen.has(name)) continue;
    seen.add(name);
    kids.push({ name, gender: cal.personGender });
  }

  return {
    kind,
    summary,
    locale: user.language || 'en',
    listener: { name: user.name, gender: user.gender === 'female' ? 'female' : 'male' },
    spouse: spouse ? { name: spouse.personName!.trim(), gender: spouse.personGender } : undefined,
    kids,
    hasKidsCalendars: calendars.some(cal => cal.labels.includes('kids')),
    culture: user.culture,
    globalRules: user.globalRules,
    isNextWeek: kind === 'weekly' ? isNextWeek : undefined,
  };
}
```

Create `src/services/voice-show/writer.ts`:

```ts
/**
 * Writes the show script: one LLM call through generateAICompletion (the admin's
 * default model) in JSON mode, then ./script's validator. A rejected answer is
 * regenerated once with the reason attached; a second rejection throws, and the caller
 * takes the "voice unavailable" path.
 */

import type { AICompletionOptions, AICompletionResult } from '../ai-provider';
import { buildShowPrompt } from '../../prompts/voice-show';
import type { ShowPromptContext } from '../../prompts/voice-show/types';
import { parseShowScript, ShowScriptError, SHOW_RESPONSE_SCHEMA } from './script';
import type { ShowScript } from './types';

export type CompletionFn = (prompt: string, modelId?: string, options?: AICompletionOptions) => Promise<AICompletionResult>;

export interface WrittenShow {
  script: ShowScript;
  /** The completion that produced the accepted script. */
  completion: AICompletionResult;
  attempts: number;
}

export interface WriteShowOptions {
  /** Defaults to generateAICompletion. Tests inject a fake. */
  complete?: CompletionFn;
  /** Overrides the admin default model. Used by the eval script. */
  modelId?: string;
}

const MAX_ATTEMPTS = 2;

export async function writeShowScript(context: ShowPromptContext, options: WriteShowOptions = {}): Promise<WrittenShow> {
  // Imported lazily so the prompt and validator stay loadable without the SDKs.
  const complete = options.complete ?? (await import('../ai-provider')).generateAICompletion;
  const prompt = buildShowPrompt(context);
  let rejection: ShowScriptError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const request = rejection
      ? `${prompt}\n\nYour previous answer was rejected: ${rejection.message}. Answer again with valid JSON that follows every rule above.`
      : prompt;
    const completion = await complete(request, options.modelId, { responseJsonSchema: SHOW_RESPONSE_SCHEMA });
    try {
      return { script: parseShowScript(completion.text), completion, attempts: attempt };
    } catch (error) {
      if (!(error instanceof ShowScriptError)) throw error;
      console.warn(`[VoiceShow] Script rejected (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}`);
      rejection = error;
    }
  }
  throw rejection!;
}
```

- [ ] **Step 6: Run the tests and type-checks**

Run: `npx tsx scripts/smoke-voice-show-writer.ts && npx tsx scripts/smoke-voice-show-script.ts && npx tsc --noEmit`
Expected: all `OK`, type-check silent.

- [ ] **Step 7: Commit**

```bash
git add src/services/ai-provider.ts src/prompts/voice-show src/services/voice-show/context.ts src/services/voice-show/writer.ts scripts/smoke-voice-show-writer.ts
git commit -F - <<'MSG'
feat(voice): write the two-host show script in JSON mode, regenerating once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---
### Task 6: tts-service `/api/dialogue` endpoint

**Files:**
- Create: `tts-service/api/dialogue.ts`
- Modify: `tts-service/vercel.json`
- Create: `scripts/smoke-tts-dialogue-endpoint.ts`

**Interfaces:**
- Consumes (service copies, `.js` imports): `encodePcmToOggOpus`, `SAMPLE_RATE`; `synthesizeSpeech`, `modelForDesignedVoices`, `isVoiceMissingError`; `synthesizeDialogue`; `mixDialogue`.
- Produces: `POST /api/dialogue`, body `{ language?: string, model?: string, voices: { A: string, B: string }, lines: Array<{ host: 'A' | 'B', text: string, style?: string, whisper?: boolean }> }`, header `Authorization: Bearer <TTS_API_KEY>`.
  - 200 `audio/ogg` with headers `X-TTS-Duration-Ms`, `X-TTS-Model`, `X-TTS-Audio-Seconds` (two decimals), `X-TTS-Audio-Tokens`
  - 400 `{ error }` for a malformed body, 401 bad auth, 405 non-POST, 422 `{ error: 'voice_not_found' }`, 502 wrong sample rate, 500 anything else.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-tts-dialogue-endpoint.ts`:

```ts
// Auth and request validation of tts-service/api/dialogue.ts, in-process. No network:
// every case here is refused before any TTS call. The success path runs live in
// scripts/eval-voice-show.ts.
//
// Run: npx tsx scripts/smoke-tts-dialogue-endpoint.ts

type Captured = { status?: number; json?: { error?: string }; headers: Record<string, string> };

function fakeRes() {
  const out: Captured = { headers: {} };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(value: { error?: string }) { out.json = value; return res; },
    send() { return res; },
    setHeader(name: string, value: string) { out.headers[name] = value; return res; },
  };
  return { res, out };
}

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
  const { default: handler } = await import('../tts-service/api/dialogue');

  async function call(req: { method: string; headers?: Record<string, string>; body?: unknown }): Promise<Captured> {
    const { res, out } = fakeRes();
    await handler({ headers: {}, ...req } as never, res as never);
    return out;
  }

  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const auth = { authorization: 'Bearer test-key' };
  const voices = { A: 'voice_33yuo333h4y2', B: 'voice_zrrafp34tgt8' };
  const line = { host: 'A', text: 'שלום', style: 'excited sports commentator' };
  const post = (body: unknown) => call({ method: 'POST', headers: auth, body });
  const expect400 = async (body: unknown, pattern: RegExp) => {
    const out = await post(body);
    assert(out.status === 400, `status ${out.status}`);
    assert(pattern.test(out.json?.error ?? ''), `error "${out.json?.error}"`);
  };

  delete process.env.TTS_API_KEY;
  await check('401 when the service has no TTS_API_KEY', async () => {
    assert((await post({ voices, lines: [line] })).status === 401, 'not 401');
  });

  process.env.TTS_API_KEY = 'test-key';
  await check('405 for GET', async () => {
    assert((await call({ method: 'GET', headers: auth })).status === 405, 'not 405');
  });
  await check('401 for a wrong key', async () => {
    assert((await call({ method: 'POST', headers: { authorization: 'Bearer nope' }, body: { voices, lines: [line] } })).status === 401, 'not 401');
  });
  await check('400 without voices or with a bad voice id', async () => {
    await expect400({ lines: [line] }, /voices/);
    await expect400({ voices: { A: 'voice_ok1234', B: 'voice bad!' }, lines: [line] }, /voices/);
  });
  await check('400 for no lines and for 31 lines', async () => {
    await expect400({ voices, lines: [] }, /lines/);
    await expect400({ voices, lines: Array.from({ length: 31 }, () => line) }, /lines/);
  });
  await check('400 for a bad host, empty or overlong text, overlong style', async () => {
    await expect400({ voices, lines: [{ ...line, host: 'C' }] }, /line 1: host/);
    await expect400({ voices, lines: [line, { ...line, text: '  ' }] }, /line 2: text/);
    await expect400({ voices, lines: [{ ...line, text: 'א'.repeat(1001) }] }, /line 1: text/);
    await expect400({ voices, lines: [{ ...line, style: 's'.repeat(301) }] }, /line 1: style/);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-tts-dialogue-endpoint.ts`
Expected: FAIL with a module-not-found error for `../tts-service/api/dialogue`.

- [ ] **Step 3: Implement**

Create `tts-service/api/dialogue.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { encodePcmToOggOpus, SAMPLE_RATE } from '../lib/pcm-to-ogg-opus.js';
import { isVoiceMissingError, modelForDesignedVoices, synthesizeSpeech } from '../lib/gemini-tts.js';
import { synthesizeDialogue } from '../lib/dialogue-tts.js';
import { mixDialogue } from '../lib/pcm-mix.js';

// The two-host show: every line synthesized in parallel in its host's voice, mixed,
// and encoded once. Same auth and function limits as api/tts.ts. The main app falls
// back to local synthesis on any non-200 from here.

// Used only when the caller sends no valid model. The main app always sends one.
const DEFAULT_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';

// The model id becomes part of the upstream URL, so accept only the TTS id shape.
const TTS_MODEL_ID = /^gemini-[a-z0-9.-]+-tts(?:-preview)?$/;
// A designed voice id (voice_...) or a prebuilt voice name (Algieba).
const VOICE_ID = /^(?:voice_[A-Za-z0-9]{4,64}|[A-Z][a-z]{2,20})$/;
const MAX_LINES = 30;
// The app caps a turn at 400 characters; niqqud added after that makes lines longer.
const MAX_LINE_CHARS = 1000;
const MAX_STYLE_LENGTH = 300;
const LINE_CONCURRENCY = 8;

interface Line {
  host: 'A' | 'B';
  text: string;
  style?: string;
  whisper: boolean;
}

interface ShowRequest {
  model: string;
  voices: { A: string; B: string };
  lines: Line[];
}

/** The validated request, or the reason it was refused. */
function parseRequest(body: unknown): ShowRequest | string {
  const b = (body ?? {}) as { model?: unknown; voices?: unknown; lines?: unknown };
  const voices = (b.voices ?? {}) as { A?: unknown; B?: unknown };
  if (typeof voices.A !== 'string' || !VOICE_ID.test(voices.A) || typeof voices.B !== 'string' || !VOICE_ID.test(voices.B)) {
    return 'voices must be { A, B } voice ids';
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > MAX_LINES) {
    return `lines must be an array of 1-${MAX_LINES} lines`;
  }

  const lines: Line[] = [];
  for (const [i, raw] of b.lines.entries()) {
    const l = (raw ?? {}) as { host?: unknown; text?: unknown; style?: unknown; whisper?: unknown };
    if (l.host !== 'A' && l.host !== 'B') return `line ${i + 1}: host must be A or B`;
    if (typeof l.text !== 'string' || !l.text.trim() || l.text.length > MAX_LINE_CHARS) {
      return `line ${i + 1}: text must be 1-${MAX_LINE_CHARS} characters`;
    }
    if (l.style !== undefined && (typeof l.style !== 'string' || l.style.length > MAX_STYLE_LENGTH)) {
      return `line ${i + 1}: style must be a string of at most ${MAX_STYLE_LENGTH} characters`;
    }
    lines.push({ host: l.host, text: l.text, style: l.style, whisper: l.whisper === true });
  }

  const requested = typeof b.model === 'string' && TTS_MODEL_ID.test(b.model) ? b.model : DEFAULT_TTS_MODEL;
  // Legacy models cannot speak designed voices.
  return { model: modelForDesignedVoices(requested), voices: { A: voices.A, B: voices.B }, lines };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedKey = process.env.TTS_API_KEY;
  if (!expectedKey || req.headers['authorization'] !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parsed = parseRequest(req.body);
  if (typeof parsed === 'string') {
    return res.status(400).json({ error: parsed });
  }
  const { model, voices, lines } = parsed;

  console.log('[TTS] Generating show:', { lines: lines.length, model, voices });
  const startTime = Date.now();

  try {
    const audio = await synthesizeDialogue({
      apiKey: process.env.GEMINI_API_KEY || '',
      model,
      lines: lines.map(line => ({ voice: voices[line.host], text: line.text, style: line.style })),
      synthesize: synthesizeSpeech,
      concurrency: LINE_CONCURRENCY,
    });

    // The Opus encoder is fixed at 24 kHz; anything else would play at the wrong speed.
    if (audio.sampleRate !== SAMPLE_RATE) {
      console.error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; encoder needs ${SAMPLE_RATE} Hz`);
      return res.status(502).json({ error: `Unsupported sample rate ${audio.sampleRate}` });
    }

    const pcm = mixDialogue(
      audio.pcms.map((p, i) => ({ pcm: p, speaker: lines[i].host, keepDynamics: lines[i].whisper })),
      { sampleRate: SAMPLE_RATE },
    );
    const oggBuffer = encodePcmToOggOpus(pcm);
    const elapsed = Date.now() - startTime;
    const audioSeconds = pcm.length / 2 / SAMPLE_RATE;

    console.log('[TTS] Show generated:', {
      requests: audio.requests,
      audioSeconds: audioSeconds.toFixed(1),
      oggKB: (oggBuffer.length / 1024).toFixed(2),
      durationMs: elapsed,
    });

    res.setHeader('Content-Type', 'audio/ogg');
    res.setHeader('X-TTS-Duration-Ms', String(elapsed));
    res.setHeader('X-TTS-Model', model);
    res.setHeader('X-TTS-Audio-Seconds', audioSeconds.toFixed(2));
    res.setHeader('X-TTS-Audio-Tokens', String(audio.audioTokens));
    return res.status(200).send(oggBuffer);
  } catch (error) {
    console.error('[TTS] Show generation failed:', error);
    if (isVoiceMissingError(error)) {
      return res.status(422).json({ error: 'voice_not_found' });
    }
    return res.status(500).json({ error: 'TTS generation failed' });
  }
}
```

Replace `tts-service/vercel.json` with:

```json
{
  "functions": {
    "api/tts.ts": {
      "maxDuration": 60,
      "includeFiles": "node_modules/opusscript/build/**"
    },
    "api/dialogue.ts": {
      "maxDuration": 60,
      "includeFiles": "node_modules/opusscript/build/**"
    }
  }
}
```

- [ ] **Step 4: Run the tests and type-checks**

Run: `npx tsx scripts/smoke-tts-dialogue-endpoint.ts && npx tsx scripts/smoke-tts.ts && npx tsc -p tts-service/tsconfig.json --noEmit && npx tsc --noEmit`
Expected: all `OK`, both type-checks silent.

- [ ] **Step 5: Commit**

```bash
git add tts-service/api/dialogue.ts tts-service/vercel.json scripts/smoke-tts-dialogue-endpoint.ts
git commit -F - <<'MSG'
feat(tts-service): add /api/dialogue for the two-host show

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---

### Task 7: Voice generator: host table, show generation (remote first, local fallback), narrator voice override

**Files:**
- Create: `src/utils/semaphore.ts`
- Modify: `src/services/voice-generator.ts` (full replacement below)
- Modify: `src/services/telegram/voice.ts` (two `generateVoiceMessage` calls)
- Modify: `src/services/voice/tts-outcome.ts` (one `generateVoiceMessage` call)
- Create: `scripts/smoke-voice-generator.ts`

**Interfaces:**
- Consumes: Task 1 (`isDesignedVoice`, `modelForDesignedVoices`, `synthesizeSpeech`, `SpeechAudio`, `SynthesizeSpeechInput`), Task 2 (`synthesizeDialogue`), Task 3 (`mixDialogue`), Task 4 (`ShowLine`).
- Produces:
  - `semaphore.ts`: `createSemaphore(max: number): <T>(task: () => Promise<T>) => Promise<T>`
  - `voice-generator.ts`:
    - `interface ShowVoices { A: string; B: string }`, `getShowVoices(language: string): ShowVoices | null`
    - `interface ShowVoiceResult { filePath; ttsMs; ttsModel; voices: ShowVoices; lineCount; audioSeconds; audioTokens; via: 'remote' | 'local' }`
    - `interface ShowVoiceDeps { synthesize?: (input: SynthesizeSpeechInput) => Promise<SpeechAudio> }`
    - `generateShowVoice(lines: ShowLine[], language: string, deps?: ShowVoiceDeps): Promise<ShowVoiceResult>`
    - `interface VoiceMessageOptions { voiceName?: string }`
    - `generateVoiceMessage(condensedText: string, language?: string, options?: VoiceMessageOptions): Promise<VoiceGenerationResult>` (the `voicePreference`/`voiceStyle` parameters are gone)
    - unchanged: `resolveTtsModel`, `VoiceGenerationResult`, `cleanupVoiceFile`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-voice-generator.ts`:

```ts
// Show generation in src/services/voice-generator.ts with Gemini faked: the semaphore,
// the host table, and remote-first with local fallback - including a tts-service that
// predates /api/dialogue and answers 404. Only a local HTTP server; no real network.
//
// Run: npx tsx scripts/smoke-voice-generator.ts

import fs from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import { createSemaphore } from '../src/utils/semaphore';
import type { SpeechAudio, SynthesizeSpeechInput } from '../src/services/gemini-tts';
import type { ShowLine } from '../src/services/voice-show/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const RATE = 24000;

function tone(ms: number, amp = 8000): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);

const synthCalls: SynthesizeSpeechInput[] = [];
const fakeSynth = async (input: SynthesizeSpeechInput): Promise<SpeechAudio> => {
  synthCalls.push(input);
  return { pcm: Buffer.concat([silence(100), tone(600), silence(100)]), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 15 };
};

const LINES: ShowLine[] = [
  { host: 'A', text: 'בוקר טוב', style: 'excited sports commentator' },
  { host: 'B', text: 'יאללה', style: 'amused, laughing a little' },
  { host: 'A', text: 'פגישה', style: 'excited sports commentator' },
  { host: 'B', text: 'סוד', style: 'whispering, secretive', whisper: true },
];

type Seen = { method?: string; url?: string; auth?: string; body?: { voices?: { A: string; B: string }; lines?: unknown[]; model?: string } };

async function withServer(respond: (res: http.ServerResponse) => void, fn: (url: string, seen: Seen) => Promise<void>) {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      respond(res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function main() {
  // Before voice-generator loads: its host table reads the env at import.
  process.env.GEMINI_SHOW_VOICE_HE_B = 'voice_override123';
  process.env.TTS_API_KEY = 'test-key';
  const { generateShowVoice, getShowVoices } = await import('../src/services/voice-generator');

  await check('semaphore caps concurrency and runs every task', async () => {
    const run = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const out = await Promise.all([1, 2, 3, 4, 5, 6].map(n => run(async () => {
      active++; peak = Math.max(peak, active); await sleep(5); active--; return n * 10;
    })));
    assert(peak === 2, `peak ${peak}`);
    assert(out.join(',') === '10,20,30,40,50,60', `out ${out.join(',')}`);
  });

  await check('semaphore frees the slot when a task throws', async () => {
    const run = createSemaphore(1);
    const first = run(async () => { throw new Error('boom'); }).catch(() => 'caught');
    const second = run(async () => 'ran');
    assert((await first) === 'caught' && (await second) === 'ran', 'slot leaked');
  });

  await check('semaphore refuses a non-positive size', () => {
    let threw = false;
    try { createSemaphore(0); } catch { threw = true; }
    assert(threw, 'size 0 accepted');
  });

  await check('host table: Hebrew defaults with env override, nothing elsewhere', () => {
    const he = getShowVoices('he');
    assert(he?.A === 'voice_33yuo333h4y2', `A ${he?.A}`);
    assert(he?.B === 'voice_override123', `B ${he?.B}`);
    assert(getShowVoices('en') === null && getShowVoices('ru') === null, 'en/ru');
    assert(getShowVoices('__proto__') === null && getShowVoices('constructor') === null, 'prototype keys');
  });

  await check('remote 404 (tts-service without /api/dialogue) falls back to local', async () => {
    await withServer(res => { res.statusCode = 404; res.end('Not Found'); }, async (url, seen) => {
      process.env.TTS_SERVICE_URL = url;
      synthCalls.length = 0;
      const result = await generateShowVoice(LINES, 'he', { synthesize: fakeSynth });
      try {
        assert(seen.method === 'POST' && seen.url === '/api/dialogue', `${seen.method} ${seen.url}`);
        assert(seen.auth === 'Bearer test-key', `auth ${seen.auth}`);
        assert(seen.body?.voices?.B === 'voice_override123' && seen.body.lines?.length === 4, 'remote body');
        assert(typeof seen.body?.model === 'string', 'model not sent');
        assert(result.via === 'local' && result.lineCount === 4 && result.audioTokens === 60, JSON.stringify(result));
        assert(synthCalls.length === 4, `synth calls ${synthCalls.length}`);
        assert(synthCalls.every((c, i) => c.voiceName === (LINES[i].host === 'A' ? 'voice_33yuo333h4y2' : 'voice_override123')), 'voices');
        assert(synthCalls[1].style === 'amused, laughing a little', `style ${synthCalls[1].style}`);
        // 4 lines of 0.6 s tone + 2 x 40 ms kept edges, 3 gaps of 0.2 s.
        assert(Math.abs(result.audioSeconds - 3.32) < 0.05, `audioSeconds ${result.audioSeconds}`);
        const file = await fs.readFile(result.filePath);
        assert(file.subarray(0, 4).toString('ascii') === 'OggS', 'not an Ogg file');
      } finally {
        await fs.unlink(result.filePath).catch(() => {});
      }
    });
  });

  await check('remote 200 is used as is', async () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 1)]);
    await withServer(res => {
      res.setHeader('Content-Type', 'audio/ogg');
      res.setHeader('X-TTS-Model', 'gemini-3.8-flash-tts');
      res.setHeader('X-TTS-Audio-Seconds', '12.50');
      res.setHeader('X-TTS-Audio-Tokens', '300');
      res.end(ogg);
    }, async url => {
      process.env.TTS_SERVICE_URL = url;
      synthCalls.length = 0;
      const result = await generateShowVoice(LINES, 'he', { synthesize: fakeSynth });
      try {
        assert(result.via === 'remote' && synthCalls.length === 0, `via ${result.via}, synth ${synthCalls.length}`);
        assert(result.audioSeconds === 12.5 && result.audioTokens === 300, JSON.stringify(result));
        assert(result.ttsModel === 'gemini-3.8-flash-tts', `model ${result.ttsModel}`);
        assert((await fs.readFile(result.filePath)).equals(ogg), 'file differs from the response');
      } finally {
        await fs.unlink(result.filePath).catch(() => {});
      }
    });
  });

  await check('without TTS_SERVICE_URL the show is made locally', async () => {
    delete process.env.TTS_SERVICE_URL;
    const result = await generateShowVoice(LINES.slice(0, 2), 'he', { synthesize: fakeSynth });
    await fs.unlink(result.filePath).catch(() => {});
    assert(result.via === 'local' && result.lineCount === 2, JSON.stringify(result));
  });

  await check('a language without hosts and an empty show are refused', async () => {
    let enThrew = false;
    let emptyThrew = false;
    try { await generateShowVoice(LINES, 'en', { synthesize: fakeSynth }); } catch { enThrew = true; }
    try { await generateShowVoice([], 'he', { synthesize: fakeSynth }); } catch { emptyThrew = true; }
    assert(enThrew && emptyThrew, `en ${enThrew} empty ${emptyThrew}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-voice-generator.ts`
Expected: FAIL with a module-not-found error for `../src/utils/semaphore`. (Redis "url is missing" warnings and `[Reminder Cache]` errors in the output are expected throughout: the smoke run has no Upstash env, and `resolveTtsModel` falls back to the default model.)

- [ ] **Step 3: Implement the semaphore**

Create `src/utils/semaphore.ts`:

```ts
/**
 * Limits how many async tasks run at once. Tasks over the limit wait in FIFO order.
 */
export function createSemaphore(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`Semaphore size must be a positive integer, got ${max}`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>(resolve => waiting.push(resolve));
  };

  // A finishing task hands its slot straight to the next waiter, so `active` only
  // drops when nobody is queued.
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
```

- [ ] **Step 4: Rewrite the voice generator**

Replace `src/services/voice-generator.ts` with:

```ts
/**
 * Voice Generation Service
 * Generates speech from text using Gemini TTS. The model is chosen per request - see
 * resolveTtsModel() - and the request shape per model lives in ./gemini-tts.
 *
 * Two products:
 * - generateVoiceMessage: one narrator reads one text. Languages without show hosts,
 *   the show's fallback when a host voice is missing, and the spoken CRUD outcome.
 * - generateShowVoice: the two-host show. One TTS request per line, mixed into one
 *   voice note. See docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md.
 *
 * Both run on the Vercel tts-service when TTS_SERVICE_URL is set and fall back to
 * local synthesis on any failure there.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { encodePcmToOggOpus, SAMPLE_RATE } from '../utils/pcm-to-ogg-opus';
import { mixDialogue } from '../utils/pcm-mix';
import { createSemaphore } from '../utils/semaphore';
import { DEFAULT_TTS_MODEL, getTtsModelConfig } from '../config/tts-models';
import {
  isDesignedVoice, modelForDesignedVoices, synthesizeSpeech, type SpeechAudio, type SynthesizeSpeechInput,
} from './gemini-tts';
import { synthesizeDialogue } from './dialogue-tts';
import { getTtsModelSetting } from './reminder-cache';
import type { ShowLine } from './voice-show/types';

/**
 * Which TTS model to use: the admin panel setting, then the GEMINI_TTS_MODEL env var,
 * then the code default. Resolved per request, not at import, so a change in the admin
 * panel takes effect on the next voice message without a redeploy.
 */
export async function resolveTtsModel(): Promise<string> {
  const fromAdmin = await getTtsModelSetting();
  // The admin route validates on write; re-check here so a stale or hand-edited row
  // can't route every voice message to a model id that doesn't exist.
  if (fromAdmin && getTtsModelConfig(fromAdmin)) return fromAdmin;
  return process.env.GEMINI_TTS_MODEL || DEFAULT_TTS_MODEL;
}

// Narrator voice per language (with env var overrides)
// All male voices, matching previous Google TTS Wavenet-D male voices
const VOICE_CONFIG: Record<string, string> = {
  he: process.env.GEMINI_TTS_VOICE_HE || 'Algieba',   // Smooth male — Hebrew
  en: process.env.GEMINI_TTS_VOICE_EN || 'Achird',     // Friendly male — English
  ru: process.env.GEMINI_TTS_VOICE_RU || 'Schedar',    // Even male — Russian
};

/** The two show hosts' voices for a language: designed voices stored in the Gemini project. */
export interface ShowVoices {
  A: string;
  B: string;
}

// Hebrew hosts chosen by ear in the 2026-10 trial. A language without an entry keeps
// the narrator. The env overrides allow a swap without a code change.
const SHOW_VOICES: Record<string, ShowVoices> = {
  he: {
    A: process.env.GEMINI_SHOW_VOICE_HE_A || 'voice_33yuo333h4y2', // warm, late 30s
    B: process.env.GEMINI_SHOW_VOICE_HE_B || 'voice_zrrafp34tgt8', // young, energetic, 20s
  },
};

/** Host voices for a language, or null when the language has no show yet. */
export function getShowVoices(language: string): ShowVoices | null {
  return Object.hasOwn(SHOW_VOICES, language) ? SHOW_VOICES[language] : null;
}

// Retry configuration
const TTS_MAX_RETRIES = 1;
const TTS_BASE_DELAY_MS = 500;

/**
 * Retry wrapper for transient TTS errors (503/429).
 * No artificial timeout — relies on SDK-level timeouts and Vercel's maxDuration.
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error as { status?: number };
      const isRetryable = err.status === 503 || err.status === 429;
      if (attempt === maxRetries || !isRetryable) throw error;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw new Error('Unreachable');
}

// Language names for TTS prompt
const LANGUAGE_NAMES: Record<string, string> = {
  he: 'Hebrew',
  en: 'English',
  ru: 'Russian',
};

export interface VoiceGenerationResult {
  filePath: string;
  ttsMs: number;
  ttsModel: string;
  voiceName: string;
}

export interface VoiceMessageOptions {
  /** A prebuilt voice name or a designed voice id. Defaults to the language's narrator. */
  voiceName?: string;
}

// Remote TTS timeout (30s — generous but below Vercel's 60s maxDuration)
const REMOTE_TTS_TIMEOUT_MS = 30_000;

/** Writes an OGG voice note to /tmp and returns its path. */
async function writeVoiceFile(oggBuffer: Buffer): Promise<string> {
  const randomId = randomBytes(4).toString('hex');
  const filePath = path.join('/tmp', `voice-${Date.now()}-${randomId}.opus`);
  await fs.writeFile(filePath, oggBuffer);
  return filePath;
}

/**
 * Generate voice via remote serverless TTS function.
 * Returns OGG OPUS binary written to /tmp.
 */
async function generateVoiceRemote(
  text: string,
  language: string,
  voiceName: string,
  model: string,
): Promise<VoiceGenerationResult> {
  const startTime = Date.now();
  const url = `${process.env.TTS_SERVICE_URL}/api/tts`;

  console.log('[TTS] Calling remote TTS service:', {
    url,
    textLength: text.length,
    language,
    voice: voiceName,
    model,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_TTS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TTS_API_KEY}`,
      },
      // The model travels with the request so the admin panel setting applies on the
      // remote path too. A tts-service deployed before model selection existed ignores
      // it and uses its own GEMINI_TTS_MODEL.
      body: JSON.stringify({ text, language, voiceName, model }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Remote TTS returned ${response.status}: ${body}`);
    }

    const oggBuffer = Buffer.from(await response.arrayBuffer());
    const remoteDurationMs = response.headers.get('X-TTS-Duration-Ms');
    // The model that actually spoke. A tts-service deployed before model selection
    // existed sends no header and uses its own GEMINI_TTS_MODEL, so the requested
    // model is only a best guess in that case - log both so it's visible.
    const remoteModel = response.headers.get('X-TTS-Model');

    const filePath = await writeVoiceFile(oggBuffer);

    const elapsed = Date.now() - startTime;
    console.log('[TTS] Remote TTS completed:', {
      filePath,
      oggKB: (oggBuffer.length / 1024).toFixed(2),
      remoteDurationMs,
      requestedModel: model,
      remoteModel: remoteModel ?? '(not reported - tts-service predates model selection)',
      totalMs: elapsed,
    });

    return { filePath, ttsMs: elapsed, ttsModel: remoteModel ?? model, voiceName };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a voice message from plain text with one narrator.
 * @param condensedText - Plain text already condensed by LLM
 * @param language - Language code (e.g., 'he', 'en', 'ru')
 * @param options - voiceName overrides the language's narrator voice
 * @returns Path to generated OGG OPUS audio file in /tmp
 */
export async function generateVoiceMessage(
  condensedText: string,
  language: string = 'en',
  options: VoiceMessageOptions = {},
): Promise<VoiceGenerationResult> {
  const voiceName = options.voiceName || VOICE_CONFIG[language] || VOICE_CONFIG['en'] || 'Achird';

  const configuredModel = await resolveTtsModel();
  // Legacy models cannot speak designed voices.
  const model = isDesignedVoice(voiceName) ? modelForDesignedVoices(configuredModel) : configuredModel;

  // If TTS_SERVICE_URL is set, offload to remote serverless function
  if (process.env.TTS_SERVICE_URL) {
    try {
      return await generateVoiceRemote(condensedText, language, voiceName, model);
    } catch (error) {
      console.warn('[TTS] Remote TTS failed, falling back to local:', error);
    }
  }

  const startTime = Date.now();

  console.log('[TTS] Generating voice message (Gemini TTS):', {
    textLength: condensedText.length,
    language,
    voice: voiceName,
    model,
  });

  const audio = await callWithRetry(
    () => synthesizeSpeech({
      apiKey: process.env.GEMINI_API_KEY || '',
      model,
      text: condensedText,
      voiceName,
      languageName: LANGUAGE_NAMES[language] || 'English',
    }),
    TTS_MAX_RETRIES,
    TTS_BASE_DELAY_MS,
  );

  // The Opus encoder is fixed at 24 kHz. Audio at any other rate would play at the
  // wrong speed and pitch with no error, so refuse it instead.
  if (audio.sampleRate !== SAMPLE_RATE) {
    throw new Error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; the encoder needs ${SAMPLE_RATE} Hz`);
  }

  const pcmBuffer = audio.pcm;
  console.log(`[TTS] Received ${pcmBuffer.length} bytes of PCM audio (MIME: ${audio.mimeType || 'unspecified'})`);

  // Convert PCM to OGG OPUS — encoder handles frame truncation internally
  const oggBuffer = encodePcmToOggOpus(pcmBuffer);
  const filePath = await writeVoiceFile(oggBuffer);

  const elapsed = Date.now() - startTime;
  console.log('[TTS] Voice generated successfully:', {
    filePath,
    pcmKB: (pcmBuffer.length / 1024).toFixed(2),
    oggKB: (oggBuffer.length / 1024).toFixed(2),
    durationMs: elapsed,
  });

  return { filePath, ttsMs: elapsed, ttsModel: model, voiceName };
}

export interface ShowVoiceResult {
  filePath: string;
  ttsMs: number;
  ttsModel: string;
  voices: ShowVoices;
  lineCount: number;
  audioSeconds: number;
  /** Output audio tokens across all lines; 0 when not reported. */
  audioTokens: number;
  via: 'remote' | 'local';
}

/** Test seam: replaces the Gemini call on the local path. */
export interface ShowVoiceDeps {
  synthesize?: (input: SynthesizeSpeechInput) => Promise<SpeechAudio>;
}

// The hourly summary run can start many shows at once, and each show already sends up
// to SHOW_LINE_CONCURRENCY requests. Capping shows per process keeps the burst near
// the 24 requests in flight that ran clean in the trial.
const MAX_CONCURRENT_SHOWS = 3;
const SHOW_LINE_CONCURRENCY = 8;
const withShowSlot = createSemaphore(MAX_CONCURRENT_SHOWS);

// Below Vercel's 60s maxDuration, and longer than the narrator's 30s because a show is
// many requests.
const REMOTE_SHOW_TIMEOUT_MS = 55_000;

/**
 * Generate the two-host show from validated lines.
 * @param lines - From voice-show/script toShowLines(): host, text, style, whisper
 * @param language - Must have hosts (getShowVoices)
 * @returns Path to the OGG OPUS file in /tmp, with metrics for the admin caption
 */
export async function generateShowVoice(
  lines: ShowLine[],
  language: string,
  deps: ShowVoiceDeps = {},
): Promise<ShowVoiceResult> {
  const voices = getShowVoices(language);
  if (!voices) throw new Error(`[TTS] No show hosts for language "${language}"`);
  if (!lines.length) throw new Error('[TTS] Show has no lines');

  const model = modelForDesignedVoices(await resolveTtsModel());

  return withShowSlot(async () => {
    if (process.env.TTS_SERVICE_URL) {
      try {
        return await generateShowRemote(lines, language, voices, model);
      } catch (error) {
        console.warn('[TTS] Remote show failed, falling back to local:', error);
      }
    }
    return generateShowLocal(lines, voices, model, deps);
  });
}

async function generateShowRemote(
  lines: ShowLine[],
  language: string,
  voices: ShowVoices,
  model: string,
): Promise<ShowVoiceResult> {
  const startTime = Date.now();
  const url = `${process.env.TTS_SERVICE_URL}/api/dialogue`;
  console.log('[TTS] Calling remote show service:', { url, lines: lines.length, language, model });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TTS_API_KEY}`,
    },
    body: JSON.stringify({ language, model, voices, lines }),
    // Also bounds reading the body below.
    signal: AbortSignal.timeout(REMOTE_SHOW_TIMEOUT_MS),
  });

  if (!response.ok) {
    // A 404 means the deployed tts-service predates /api/dialogue.
    const body = await response.text().catch(() => '');
    throw new Error(`Remote show returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const oggBuffer = Buffer.from(await response.arrayBuffer());
  const filePath = await writeVoiceFile(oggBuffer);
  const result: ShowVoiceResult = {
    filePath,
    ttsMs: Date.now() - startTime,
    ttsModel: response.headers.get('X-TTS-Model') ?? model,
    voices,
    lineCount: lines.length,
    audioSeconds: Number(response.headers.get('X-TTS-Audio-Seconds')) || 0,
    audioTokens: Number(response.headers.get('X-TTS-Audio-Tokens')) || 0,
    via: 'remote',
  };
  console.log('[TTS] Remote show completed:', { ...result, oggKB: (oggBuffer.length / 1024).toFixed(2) });
  return result;
}

async function generateShowLocal(
  lines: ShowLine[],
  voices: ShowVoices,
  model: string,
  deps: ShowVoiceDeps,
): Promise<ShowVoiceResult> {
  const startTime = Date.now();
  console.log('[TTS] Generating show locally:', { lines: lines.length, model, voices });

  const audio = await synthesizeDialogue({
    apiKey: process.env.GEMINI_API_KEY || '',
    model,
    lines: lines.map(line => ({ voice: voices[line.host], text: line.text, style: line.style })),
    synthesize: deps.synthesize ?? synthesizeSpeech,
    concurrency: SHOW_LINE_CONCURRENCY,
  });

  // The Opus encoder is fixed at 24 kHz; anything else would play at the wrong speed.
  if (audio.sampleRate !== SAMPLE_RATE) {
    throw new Error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; the encoder needs ${SAMPLE_RATE} Hz`);
  }

  const pcm = mixDialogue(
    audio.pcms.map((p, i) => ({ pcm: p, speaker: lines[i].host, keepDynamics: lines[i].whisper })),
    { sampleRate: SAMPLE_RATE },
  );
  const oggBuffer = encodePcmToOggOpus(pcm);
  const filePath = await writeVoiceFile(oggBuffer);

  const result: ShowVoiceResult = {
    filePath,
    ttsMs: Date.now() - startTime,
    ttsModel: model,
    voices,
    lineCount: lines.length,
    audioSeconds: pcm.length / 2 / SAMPLE_RATE,
    audioTokens: audio.audioTokens,
    via: 'local',
  };
  console.log('[TTS] Local show completed:', { ...result, requests: audio.requests, oggKB: (oggBuffer.length / 1024).toFixed(2) });
  return result;
}

/**
 * Clean up temporary voice file
 */
export async function cleanupVoiceFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
    console.log('[TTS] Voice file cleaned up:', filePath);
  } catch (error) {
    console.warn('[TTS] Failed to cleanup voice file:', filePath, error);
  }
}
```

- [ ] **Step 5: Update the three callers of the old signature**

In `src/services/telegram/voice.ts`, both occurrences of

```ts
generateVoiceMessage(condensedText, userLanguage, user.voicePreference, user.voiceStyle);
```

become

```ts
generateVoiceMessage(condensedText, userLanguage);
```

In `src/services/voice/tts-outcome.ts`, the call

```ts
    const result = await generateVoiceMessage(
      spokenLine,
      user.language || 'en',
      user.voicePreference,
      user.voiceStyle
    );
```

becomes

```ts
    const result = await generateVoiceMessage(spokenLine, user.language || 'en');
```

(Task 8 rewrites both files properly; this keeps the build green in between.)

- [ ] **Step 6: Run the tests and type-checks**

Run: `npx tsx scripts/smoke-voice-generator.ts && npx tsx scripts/smoke-tts.ts && npx tsc --noEmit`
Expected: all `OK` (Redis/Reminder Cache error logs are expected noise), type-check silent.

- [ ] **Step 7: Commit**

```bash
git add src/utils/semaphore.ts src/services/voice-generator.ts src/services/telegram/voice.ts src/services/voice/tts-outcome.ts scripts/smoke-voice-generator.ts
git commit -F - <<'MSG'
feat(voice): generate the two-host show remote-first with local fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---
### Task 8: Wire the show into delivery: produce, captions, routing, `/weather`, outcome voice

**Files:**
- Create: `src/services/voice-show/produce.ts`
- Modify: `src/utils/ai-footer.ts`
- Modify: `src/config/redis-keys.ts`
- Modify: `src/services/telegram/voice.ts` (full replacement below)
- Modify: `src/services/telegram/commands.ts:452` (the `/weather` voice call)
- Modify: `src/services/voice/tts-outcome.ts` (`speakOutcome`)
- Create: `scripts/smoke-voice-show-produce.ts`

**Interfaces:**
- Consumes: Task 4 (`toShowLines`, `scriptToNarration`, `ProducedVoice`, `ShowKind`), Task 5 (`buildShowContext`, `writeShowScript`, `CompletionFn`, `hasShowPrompt`), Task 7 (`generateShowVoice`, `generateVoiceMessage`, `getShowVoices`, `ShowVoiceResult`, `ShowVoiceDeps`), Task 1 (`isVoiceMissingError`).
- Produces:
  - `produce.ts`: `isShowLanguage(language: string): boolean`; `interface ProduceShowDeps { complete?: CompletionFn; synthesize?: ShowVoiceDeps['synthesize']; narrate?: typeof generateVoiceMessage }`; `produceShowVoice(summary: string, user: UserConfig, kind: ShowKind, isNextWeek?: boolean, deps?: ProduceShowDeps): Promise<ProducedVoice>`
  - `ai-footer.ts`: `formatVoiceCaption(condenserResult, ttsMs, ttsModel, isAdmin, voiceName?)` (no `voiceStyle`); `formatShowCaption(writer, writerAttempts, show, isAdmin): string | undefined`; `estimateTtsCost(model: string, audioTokens: number): number | null`
  - `redis-keys.ts`: `REDIS_KEYS.showVoiceMissing(date: string)`
  - `telegram/voice.ts`: `sendVoiceMessage(..., waMessageId?, kind: 'daily' | 'weather' = 'daily')`; `sendWeeklyVoiceMessage` signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-voice-show-produce.ts`:

```ts
// The show pipeline wired end to end with the LLM and Gemini faked: captions, cost,
// routing by language, and the narrator fallback when a host voice is missing.
// No network.
//
// Run: npx tsx scripts/smoke-voice-show-produce.ts

import fs from 'fs/promises';
import type { AICompletionResult } from '../src/services/ai-provider';
import { TtsHttpError, type SpeechAudio, type SynthesizeSpeechInput } from '../src/services/gemini-tts';
import type { UserConfig } from '../src/types';
import { estimateTtsCost, formatShowCaption, formatVoiceCaption } from '../src/utils/ai-footer';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const RATE = 24000;
function tone(ms: number): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return b;
}

const writer: AICompletionResult = {
  text: '', usage: { inputTokens: 1200, outputTokens: 300 }, stopReason: 'STOP', model: 'Gemini 3.8 Flash', durationMs: 4200,
};
const SCRIPT = JSON.stringify({ turns: [
  { host: 'A', mood: 'hype', text: 'בוקר טוב דני! <chuckle>' },
  { host: 'B', mood: 'amused', text: 'יש לך יום ענק!' },
  { host: 'A', mood: 'hype', text: 'באחת עשרה פגישה עם לוי.' },
  { host: 'B', mood: 'warm', text: 'שיהיה יום מנצח!' },
] });
const user = { id: 1, name: 'דני', gender: 'male', language: 'he', isAdmin: true, calendarAssignments: [] } as unknown as UserConfig;
const fakeComplete = async () => ({ ...writer, text: SCRIPT });
const fakeSynth = async (_input: SynthesizeSpeechInput): Promise<SpeechAudio> =>
  ({ pcm: tone(500), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 12 });

async function main() {
  delete process.env.TTS_SERVICE_URL;
  const { isShowLanguage, produceShowVoice } = await import('../src/services/voice-show/produce');

  await check('cost estimate: 1500 audio tokens on 3.8 Flash TTS', () => {
    assert(Math.abs((estimateTtsCost('gemini-3.8-flash-tts', 1500) ?? 0) - 0.0135) < 1e-9, 'cost');
    assert(estimateTtsCost('gemini-unknown-tts', 1500) === null, 'unknown model');
    assert(estimateTtsCost('gemini-3.8-flash-tts', 0) === null, 'no tokens');
  });

  await check('show caption: admin only, with hosts, lines, length, model, cost', () => {
    const show = {
      ttsMs: 6100, ttsModel: 'gemini-3.8-flash-tts', voices: { A: 'voice_a1', B: 'voice_b2' },
      lineCount: 12, audioSeconds: 52.4, audioTokens: 1500, via: 'local' as const,
    };
    assert(formatShowCaption(writer, 1, show, false) === undefined, 'shown to a non-admin');
    const caption = formatShowCaption(writer, 2, show, true)!;
    for (const part of ['🎙 Gemini 3.8 Flash', 'rewritten x1', '🔊 TTS gemini-3.8-flash-tts', 'A:voice_a1 B:voice_b2', '12 lines', '52s audio', '6.1s', 'local', '~$0.0135']) {
      assert(caption.includes(part), `"${part}" missing from: ${caption}`);
    }
  });

  await check('narrator caption no longer takes a style', () => {
    const caption = formatVoiceCaption(writer, 3000, 'gemini-3.8-flash-tts', true, 'Algieba')!;
    assert(caption.includes('| Algieba |') && !caption.includes('style:'), caption);
  });

  await check('only Hebrew has the show', () => {
    assert(isShowLanguage('he') && !isShowLanguage('en') && !isShowLanguage('ru'), 'routing');
  });

  await check('produceShowVoice: script → lines → mixed OGG with admin caption', async () => {
    const voice = await produceShowVoice('summary', user, 'daily', false, { complete: fakeComplete, synthesize: fakeSynth });
    try {
      assert((await fs.readFile(voice.filePath)).subarray(0, 4).toString('ascii') === 'OggS', 'not Ogg');
      assert(voice.durationSeconds >= 2, `duration ${voice.durationSeconds}`);
      assert(!!voice.caption && voice.caption.includes('4 lines') && voice.caption.includes('local'), `caption ${voice.caption}`);
    } finally {
      await fs.unlink(voice.filePath).catch(() => {});
    }
  });

  await check('missing host voice: the narrator reads the same script', async () => {
    const narrated: string[] = [];
    const missing = async (): Promise<SpeechAudio> => {
      throw new TtsHttpError('Gemini TTS gemini-3.8-flash-tts returned 404: The voice was not found or the caller does not have permission to access it.', 404);
    };
    const voice = await produceShowVoice('summary', user, 'daily', false, {
      complete: fakeComplete,
      synthesize: missing,
      narrate: async text => { narrated.push(text); return { filePath: '/tmp/narrator-fake.opus', ttsMs: 900, ttsModel: 'gemini-3.8-flash-tts', voiceName: 'Algieba' }; },
    });
    assert(narrated.length === 1, `narrate calls ${narrated.length}`);
    assert(!narrated[0].includes('<') && narrated[0].includes('בוקר טוב דני'), `narration ${narrated[0]}`);
    assert(narrated[0].normalize('NFC').includes('בְּאַחַת עֶשְׂרֵה'.normalize('NFC')), 'narration not pointed');
    assert(voice.filePath === '/tmp/narrator-fake.opus', voice.filePath);
    assert(!!voice.caption && voice.caption.includes('narrator fallback'), `caption ${voice.caption}`);
  });

  await check('other TTS errors are not hidden by the fallback', async () => {
    let error: unknown;
    try {
      await produceShowVoice('summary', user, 'daily', false, {
        complete: fakeComplete,
        synthesize: async () => { throw new TtsHttpError('Gemini TTS x returned 400: bad request', 400); },
        narrate: async () => { throw new Error('narrator must not be used'); },
      });
    } catch (e) { error = e; }
    assert((error as { status?: number })?.status === 400, `error ${String(error)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-voice-show-produce.ts`
Expected: FAIL: `estimateTtsCost`/`formatShowCaption` are not exported from `ai-footer`, and `voice-show/produce` does not exist.

- [ ] **Step 3: Captions and the Redis key**

Replace `src/utils/ai-footer.ts` with:

```ts
import type { AICompletionResult } from '../services/ai-provider';
import type { ShowVoiceResult } from '../services/voice-generator';
import { getTtsModelConfig } from '../config/tts-models';

export function formatAdminFooter(result: AICompletionResult, isAdmin: boolean): string {
  if (!isAdmin) return '';
  return `\n\n<i>📊 ${buildMetricsParts(result).join(' | ')}</i>`;
}

export function formatVoiceCaption(
  condenserResult: AICompletionResult,
  ttsMs: number,
  ttsModel: string,
  isAdmin: boolean,
  voiceName?: string,
): string | undefined {
  if (!isAdmin) return undefined;
  const condenser = `🎙 ${buildMetricsParts(condenserResult).join(' | ')}`;
  const voicePart = voiceName ? ` | ${voiceName}` : '';
  const tts = `🔊 TTS ${ttsModel}${voicePart} | ${(ttsMs / 1000).toFixed(1)}s`;
  return `${condenser}\n${tts}`;
}

/** Admin caption for the two-host show: the writer's metrics, then the TTS side. */
export function formatShowCaption(
  writer: AICompletionResult,
  writerAttempts: number,
  show: Pick<ShowVoiceResult, 'ttsMs' | 'ttsModel' | 'voices' | 'lineCount' | 'audioSeconds' | 'audioTokens' | 'via'>,
  isAdmin: boolean,
): string | undefined {
  if (!isAdmin) return undefined;
  const rewritten = writerAttempts > 1 ? ` | rewritten x${writerAttempts - 1}` : '';
  const tts = [
    `🔊 TTS ${show.ttsModel}`,
    `A:${show.voices.A} B:${show.voices.B}`,
    `${show.lineCount} lines`,
    `${show.audioSeconds.toFixed(0)}s audio`,
    `${(show.ttsMs / 1000).toFixed(1)}s`,
    show.via,
  ];
  const cost = estimateTtsCost(show.ttsModel, show.audioTokens);
  if (cost !== null) tts.push(`~$${cost.toFixed(4)}`);
  return `🎙 ${buildMetricsParts(writer).join(' | ')}${rewritten}\n${tts.join(' | ')}`;
}

/** USD for a TTS call's output audio tokens; null when the model or the count is unknown. */
export function estimateTtsCost(model: string, audioTokens: number): number | null {
  const config = getTtsModelConfig(model);
  if (!config || !audioTokens) return null;
  return (audioTokens * config.costPer1MAudioTokens) / 1_000_000;
}

function buildMetricsParts(result: AICompletionResult): string[] {
  const parts: string[] = [result.model];
  if (result.thinkingLevel) parts.push(`think:${result.thinkingLevel}`);
  let tok = `${result.usage.inputTokens}→${result.usage.outputTokens}`;
  if (result.usage.thinkingTokens) tok += `+${result.usage.thinkingTokens}t`;
  if (result.usage.cacheReadTokens) tok += ` (cache:${result.usage.cacheReadTokens})`;
  parts.push(tok + ' tok');
  parts.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  return parts;
}
```

In `src/config/redis-keys.ts`, after the `voiceLock` entry, add:

```ts
  // Voice show: one admin alert per day when a host voice is missing from the Gemini project
  showVoiceMissing: (date: string) => `voice:show:voice_missing:${date}`,
```

- [ ] **Step 4: Create the show producer**

Create `src/services/voice-show/produce.ts`:

```ts
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
        'Check GEMINI_SHOW_VOICE_* and that GEMINI_API_KEY belongs to the Gemini project holding the designed voices.\n' +
        (error instanceof Error ? error.message : String(error)),
    );
  } catch (alertError) {
    console.error('[VoiceShow] Failed to send the voice-missing alert:', alertError);
  }
}
```

- [ ] **Step 5: Route delivery through the producer**

Replace `src/services/telegram/voice.ts` with:

```ts
/**
 * Telegram voice message functions
 *
 * Languages with show hosts (Hebrew today) get the two-host show: an LLM writes the
 * script and each line is spoken by its host - see ../voice-show/produce.ts. Other
 * languages keep the 2-step narrator pipeline: an LLM condenses the summary, then
 * Gemini TTS reads it in the language's default voice.
 */

import { UserConfig } from '../../types';
import { IMessagingService, MessagingPlatform, MessageFormat } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import { startTypingInterval } from './command-pipeline';
import { getMessagingService } from './bot';
import { trackActivityAsync } from '../analytics-service';
import { incrementUsage } from '../subscription-service';
import { formatVoiceCaption } from '../../utils/ai-footer';
import type { VoiceCondenserContext } from '../../prompts/voice-condenser';
import type { ProducedVoice, ShowKind } from '../voice-show/types';

/**
 * Make the voice note for a summary: the show where the language has hosts, the
 * single narrator elsewhere.
 */
async function produceVoice(summary: string, user: UserConfig, kind: ShowKind, isNextWeek = false): Promise<ProducedVoice> {
  const { isShowLanguage, produceShowVoice } = await import('../voice-show/produce');
  if (isShowLanguage(user.language || 'en')) {
    return produceShowVoice(summary, user, kind, isNextWeek);
  }
  return produceNarratorVoice(summary, user, kind, isNextWeek);
}

/**
 * Step 1: LLM condenses the summary via generateAICompletion
 * Step 2: Gemini TTS speaks the condensed plain text
 */
async function produceNarratorVoice(summary: string, user: UserConfig, kind: ShowKind, isNextWeek: boolean): Promise<ProducedVoice> {
  const userLanguage = user.language || 'en';
  const { generateVoiceMessage } = await import('../voice-generator');
  const { buildVoiceCondenserPrompt, buildWeeklyVoiceCondenserPrompt } = await import('../../prompts/voice-condenser');
  const { generateAICompletion } = await import('../ai-provider');

  const spouseCalendar = user.calendarAssignments?.find(cal =>
    cal.labels.includes('spouse')
  );
  const hasKidsCalendars = user.calendarAssignments?.some(cal =>
    cal.labels.includes('kids')
  ) ?? false;

  const condenserContext: VoiceCondenserContext = {
    summary,
    locale: userLanguage,
    userName: user.name,
    spouseName: spouseCalendar?.personName,
    hasKidsCalendars,
    culture: user.culture,
    globalRules: user.globalRules,
    isNextWeek: kind === 'weekly' ? isNextWeek : undefined,
  };
  // Weather has no condenser of its own; it has always used the daily one.
  const condenserPrompt = kind === 'weekly'
    ? buildWeeklyVoiceCondenserPrompt(condenserContext)
    : buildVoiceCondenserPrompt(condenserContext);
  const condensedResult = await generateAICompletion(condenserPrompt);
  const condensedText = condensedResult.text;

  console.log(`[Voice] ${kind} summary condensed: ${summary.length} → ${condensedText.length} chars`);

  const { filePath, ttsMs, ttsModel, voiceName } = await generateVoiceMessage(condensedText, userLanguage);
  return {
    filePath,
    caption: formatVoiceCaption(condensedResult, ttsMs, ttsModel, user.isAdmin, voiceName),
    durationSeconds: Math.ceil(condensedText.length / 15),
  };
}

/**
 * Generate and send voice version of summary
 * Shows animated progress that gets deleted when voice arrives (optional)
 * Non-blocking - errors logged but don't affect text summary delivery
 * @param kind - 'weather' for /weather; anything else is a daily or tomorrow summary
 */
export async function sendVoiceMessage(
  chatId: number | string,
  summary: string,
  user: UserConfig,
  service?: IMessagingService,
  showProgress: boolean = true,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  waMessageId?: string,
  kind: 'daily' | 'weather' = 'daily'
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || (platform === MessagingPlatform.WHATSAPP
    ? getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP)
    : getMessagingService());
  const userLanguage = user.language || 'en';

  // Resolve WA message ID from Redis if not provided
  let msgId = waMessageId;
  if (!msgId && platform === MessagingPlatform.WHATSAPP) {
    const { redis } = await import('../../utils/redis');
    const { REDIS_KEYS } = await import('../../config/redis-keys');
    msgId = await redis.get<string>(REDIS_KEYS.waLastMsg(String(chatId))) || undefined;
  }

  // Start typing indicator if enabled
  let stopTyping: (() => void) | null = null;
  if (showProgress) {
    stopTyping = startTypingInterval(chatId, msgService, platform === MessagingPlatform.WHATSAPP ? 'text' : 'audio', msgId);
  }

  try {
    console.log(`[Voice] Generating ${kind} voice message for user ${chatId}...`);

    const voice = await produceVoice(summary, user, kind);
    voiceFilePath = voice.filePath;

    // Stop typing indicator
    if (stopTyping) stopTyping();

    // Send voice via platform-agnostic service
    await msgService.sendVoice(chatId, voiceFilePath);

    // Send admin caption as separate text (WhatsApp doesn't support captions on audio)
    if (voice.caption && user.isAdmin) {
      await msgService.sendMessage(chatId, voice.caption, { format: MessageFormat.HTML });
    }

    trackActivityAsync(user.id, 'voice_summary_generated', {
      duration_seconds: voice.durationSeconds,
    });
    incrementUsage(user.id, 'voiceSummaries').catch(err =>
      console.error('[Subscription] Failed to increment voice usage:', err)
    );

    console.log(`[Voice] Voice message sent successfully to user ${chatId}`);
  } catch (error) {
    console.error(`[Voice] Voice generation failed for user ${chatId}:`, error);

    if (stopTyping) stopTyping();

    // A 403 from Telegram means this chat will never accept our messages again. It is
    // not a voice-generation fault and there is nothing an admin can act on, so record
    // it and stay quiet - otherwise every scheduled run pages about the same user
    // forever. Checked before the apology below, which would simply be a third 403.
    const { isUnreachableError, describeDeliveryError } = await import('../../lib/delivery-errors');
    if (isUnreachableError(error)) {
      const { markUserUnreachable } = await import('../../lib/user-reachability');
      await markUserUnreachable(user.id, describeDeliveryError(error));
      return;
    }

    try {
      const { getBotMessages } = await import('../../lib/bot-messages');
      const t = await getBotMessages(userLanguage);
      const errorText = t.errors?.voiceGenerationFailed || 'Voice message unavailable — your text summary is above.';
      await msgService.sendMessage(chatId, errorText);
    } catch (sendErr) {
      console.error('[Voice] Failed to send error message:', sendErr);
    }

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Voice Generation',
      // Previously this asserted "Text summary was delivered successfully" as a
      // hardcoded string. It was not a check, and in the blocked-user case the text
      // send had already failed - so the warning reported a failure as a success.
      `Failed to generate voice message:\n${describeDeliveryError(error)}`,
      { userId: user.id, name: user.name }
    );
  } finally {
    if (voiceFilePath) {
      const { cleanupVoiceFile } = await import('../voice-generator');
      await cleanupVoiceFile(voiceFilePath).catch(err =>
        console.warn('[Voice] Voice file cleanup failed:', err)
      );
    }
  }
}

/**
 * Send a voice message for weekly summary (lookahead/next week)
 * Uses the weekly show (or the weekly condenser for languages without hosts)
 */
export async function sendWeeklyVoiceMessage(
  chatId: number | string,
  summary: string,
  user: UserConfig,
  isNextWeek: boolean = false,
  service?: IMessagingService,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  waMessageId?: string
): Promise<void> {
  let voiceFilePath: string | null = null;
  const msgService = service || (platform === MessagingPlatform.WHATSAPP
    ? getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP)
    : getMessagingService());
  const userLanguage = user.language || 'en';

  // Resolve WA message ID from Redis if not provided
  let msgId = waMessageId;
  if (!msgId && platform === MessagingPlatform.WHATSAPP) {
    const { redis } = await import('../../utils/redis');
    const { REDIS_KEYS } = await import('../../config/redis-keys');
    msgId = await redis.get<string>(REDIS_KEYS.waLastMsg(String(chatId))) || undefined;
  }

  const stopTyping = startTypingInterval(chatId, msgService, platform === MessagingPlatform.WHATSAPP ? 'text' : 'audio', msgId);

  try {
    console.log(`[Voice] Generating weekly voice message for user ${chatId}...`);

    const voice = await produceVoice(summary, user, 'weekly', isNextWeek);
    voiceFilePath = voice.filePath;

    if (stopTyping) stopTyping();

    // Send voice via platform-agnostic service
    await msgService.sendVoice(chatId, voiceFilePath);

    // Send admin caption as separate text
    if (voice.caption && user.isAdmin) {
      await msgService.sendMessage(chatId, voice.caption, { format: MessageFormat.HTML });
    }

    console.log(`[Voice] Weekly voice message sent successfully to user ${chatId}`);
  } catch (error) {
    console.error(`[Voice] Weekly voice generation failed for user ${chatId}:`, error);

    if (stopTyping) stopTyping();

    // Same terminal-403 handling as sendVoiceMessage above.
    const { isUnreachableError: isUnreachableWeekly, describeDeliveryError: describeWeekly } =
      await import('../../lib/delivery-errors');
    if (isUnreachableWeekly(error)) {
      const { markUserUnreachable } = await import('../../lib/user-reachability');
      await markUserUnreachable(user.id, describeWeekly(error));
      return;
    }

    try {
      const { getBotMessages } = await import('../../lib/bot-messages');
      const t = await getBotMessages(userLanguage);
      const errorText = t.errors?.voiceGenerationFailed || 'Voice message unavailable — your text summary is above.';
      await msgService.sendMessage(chatId, errorText);
    } catch (sendErr) {
      console.error('[Voice] Failed to send error message:', sendErr);
    }

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Weekly Voice Generation',
      `Failed to generate weekly voice message:\n${describeWeekly(error)}`,
      { userId: user.id, name: user.name }
    );
  } finally {
    if (voiceFilePath) {
      const { cleanupVoiceFile } = await import('../voice-generator');
      await cleanupVoiceFile(voiceFilePath).catch(err =>
        console.warn('[Voice] Voice file cleanup failed:', err)
      );
    }
  }
}
```

In `src/services/telegram/commands.ts` (the `/weather` handler, around line 452), change

```ts
        sendVoiceMessage(chatId, result.detailed, user, undefined, true, platform).catch(err =>
```

to

```ts
        sendVoiceMessage(chatId, result.detailed, user, undefined, true, platform, undefined, 'weather').catch(err =>
```

- [ ] **Step 6: Speak CRUD outcomes in host A's voice**

In `src/services/voice/tts-outcome.ts`, replace the body of `speakOutcome`'s `try` block (from `const { generateVoiceMessage, cleanupVoiceFile } = ...` through the inner `finally`) with:

```ts
    const language = user.language || 'en';
    const { generateVoiceMessage, cleanupVoiceFile, getShowVoices } = await import('../voice-generator');
    // Where the language has show hosts, host A says the outcome, so the bot keeps one
    // voice across summaries and replies.
    const hostVoice = getShowVoices(language)?.A;
    let result;
    try {
      result = await generateVoiceMessage(spokenLine, language, { voiceName: hostVoice });
    } catch (err) {
      const { isVoiceMissingError } = await import('../gemini-tts');
      if (!hostVoice || !isVoiceMissingError(err)) throw err;
      result = await generateVoiceMessage(spokenLine, language);
    }
    try {
      await service.sendVoice(chatId, result.filePath);
    } finally {
      // Local-generation paths leave a /tmp file; remote TTS handles its own.
      cleanupVoiceFile(result.filePath).catch(() => {});
    }
```

and change the file's header comment line

```ts
// via Gemini TTS. Text-input flows continue with text-only outcomes.
```

to

```ts
// via Gemini TTS, in show host A's voice where the language has hosts.
// Text-input flows continue with text-only outcomes.
```

- [ ] **Step 7: Run the tests, type-check and lint**

Run: `npx tsx scripts/smoke-voice-show-produce.ts && npx tsx scripts/smoke-voice-generator.ts && npx tsc --noEmit && npx eslint src/services/telegram/voice.ts src/services/voice-show src/utils/ai-footer.ts src/services/voice/tts-outcome.ts`
Expected: all `OK`, type-check and lint silent (Redis warnings in smoke output are expected).

- [ ] **Step 8: Commit**

```bash
git add src/services/voice-show/produce.ts src/utils/ai-footer.ts src/config/redis-keys.ts src/services/telegram/voice.ts src/services/telegram/commands.ts src/services/voice/tts-outcome.ts scripts/smoke-voice-show-produce.ts
git commit -F - <<'MSG'
feat(voice): deliver Hebrew summaries and /weather as the two-host show

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---
### Task 9: Remove the voice and style pickers

**Files:**
- Modify: `app/[locale]/settings/SettingsClient.tsx`
- Modify: `app/[locale]/settings/page.tsx:105-106`
- Modify: `app/api/settings/route.ts:14,65-66`
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`
- Modify: `src/types.ts`
- Delete: `src/config/voice-options.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Task 7 already stopped `voice-generator.ts` from importing `voice-options.ts`, and Task 8 removed `formatVoiceCaption`'s `voiceStyle` parameter.
- Produces: no picker UI. `/api/settings` ignores `voicePreference` and `voiceStyle` if an old cached client still sends them. The DB columns stay.

- [ ] **Step 1: Write the failing check**

Run:

```bash
grep -rn -e "voice-options" -e "VOICE_OPTIONS" -e "VOICE_STYLES" -e "VOICE_STYLE_PROMPTS" -e "getVoiceForUser" -e "voicePreference" -e "voiceStyle" src app scripts messages
```

Expected now: matches in `SettingsClient.tsx`, `settings/page.tsx`, `api/settings/route.ts`, `messages/*.json`, `src/types.ts` and `src/config/voice-options.ts`. After this task: no output at all.

- [ ] **Step 2: Settings page client**

In `app/[locale]/settings/SettingsClient.tsx`:

1. Delete the import line `import { VOICE_OPTIONS, VOICE_STYLES } from '@/src/config/voice-options';`
2. In the props type, delete `    voicePreference: string;` and `    voiceStyle: string;`
3. Delete the two state lines:
   ```tsx
     const [voicePreference, setVoicePreference] = useState(currentSettings.voicePreference);
     const [voiceStyle, setVoiceStyle] = useState(currentSettings.voiceStyle);
   ```
4. In `isDirty`, replace
   ```tsx
       voiceInputEnabled !== currentSettings.voiceInputEnabled ||
       voicePreference !== currentSettings.voicePreference ||
       voiceStyle !== currentSettings.voiceStyle;
   ```
   with
   ```tsx
       voiceInputEnabled !== currentSettings.voiceInputEnabled;
   ```
5. In the save request body, delete the lines `          voicePreference,` and `          voiceStyle,`
6. Delete the whole picker block that follows the voice summary toggle row: it starts with `            {voiceSummaryEnabled && (<>` and ends with `            </>)}` (two `form-group` divs with the `voicePreference` and `voiceStyle` selects). The voice summary toggle row and its usage badge above it stay.

- [ ] **Step 3: Settings page server component and API**

In `app/[locale]/settings/page.tsx`, replace

```tsx
        voiceInputEnabled: user.voiceInputEnabled,
        voicePreference: user.voicePreference || 'default',
        voiceStyle: user.voiceStyle || 'natural'
```

with

```tsx
        voiceInputEnabled: user.voiceInputEnabled
```

In `app/api/settings/route.ts`, remove `voicePreference, voiceStyle, ` from the destructuring on line 14 (so it ends `..., pickupRemindersEnabled, voiceInputEnabled, initData } = body;`), and replace

```ts
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined,
      voicePreference: typeof voicePreference === 'string' ? voicePreference : undefined,
      voiceStyle: typeof voiceStyle === 'string' ? voiceStyle : undefined
```

with

```ts
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined
```

- [ ] **Step 4: Translations**

Delete the four picker keys from each locale (each appears exactly once per file, inside `settings`, followed by other keys, so no trailing-comma fix is needed):

```bash
for f in en he ru; do
  sed -i '' -E '/^[[:space:]]*"(voicePreference|voicePreferenceDescription|voiceStyle|voiceStyleDescription)":/d' messages/$f.json
done
```

In `messages/he.json`, replace

```json
    "voiceSummaryDescription": "קבל סיכום יומי כהודעה קולית",
```

with

```json
    "voiceSummaryDescription": "קבל את הסיכום היומי כתוכנית רדיו קצרה עם שני מגישים",
```

English and Russian keep their description: those users still get the single narrator until their hosts ship.

- [ ] **Step 5: Types and the options file**

In `src/types.ts`, delete `  voicePreference?: string;` and `  voiceStyle?: string;` from `UserConfig`, and delete `    voicePreference: user.voicePreference,` and `    voiceStyle: user.voiceStyle,` from `convertPrismaUserToConfig`. (The columns still arrive through `...user`; nothing reads them.)

Delete the options file:

```bash
git rm src/config/voice-options.ts
```

- [ ] **Step 6: Verify**

Run:

```bash
grep -rn -e "voice-options" -e "VOICE_OPTIONS" -e "VOICE_STYLES" -e "VOICE_STYLE_PROMPTS" -e "getVoiceForUser" -e "voicePreference" -e "voiceStyle" src app scripts messages
for f in en he ru; do node -e "JSON.parse(require('fs').readFileSync('messages/$f.json','utf8'))" && echo "$f.json ok"; done
npx tsc --noEmit
npx eslint "app/[locale]/settings/SettingsClient.tsx" "app/[locale]/settings/page.tsx" app/api/settings/route.ts src/types.ts
```

Expected: the grep prints nothing; three `ok` lines; type-check and lint silent.

- [ ] **Step 7: Commit**

```bash
git add -A "app/[locale]/settings/SettingsClient.tsx" "app/[locale]/settings/page.tsx" app/api/settings/route.ts messages/en.json messages/he.json messages/ru.json src/types.ts src/config/voice-options.ts
git commit -F - <<'MSG'
feat(settings): remove the voice and style pickers

The show decides the voices now. The voicePreference and voiceStyle columns stay
until a later migration, since Railway's zero-downtime deploys overlap old and new
instances.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---

### Task 10: Live evaluation and samples

**Files:**
- Create: `scripts/eval-voice-show.ts`

**Interfaces:**
- Consumes: `buildShowContext`, `writeShowScript`, `toShowLines`, `generateShowVoice`, `getShowVoices`, `generateAICompletion` (with `responseJsonSchema`), the tts-service `/api/dialogue` handler.
- Produces: a manual eval run. Exit code 1 if any check fails. Writes `<outDir>/<fixture>.json`, `<outDir>/<fixture>.ogg`, `<outDir>/endpoint.ogg`.

- [ ] **Step 1: Write the eval script**

Create `scripts/eval-voice-show.ts`:

```ts
// Live evaluation of the Hebrew two-host show. Costs money: an LLM call or two and up
// to about a minute of Gemini TTS audio per fixture (roughly $0.02 each).
//
// Run: npx tsx -r dotenv/config scripts/eval-voice-show.ts <outDir> [--model gemini-3.8-flash]
//
// Needs GEMINI_API_KEY for the Gemini project that holds the designed voices. For each
// fixture: writes the script with the real writer; checks facts survive, no digits are
// left, sounds stay in budget and genders are right (an LLM judge); synthesizes the
// show locally with Flash TTS and checks its length. Then runs tts-service's
// /api/dialogue handler in-process once. Scripts, results and audio go to outDir.

import fs from 'fs/promises';
import path from 'path';
import type { UserConfig } from '../src/types';
import type { ShowKind, ShowTurn } from '../src/services/voice-show/types';
import type { ShowPromptContext } from '../src/prompts/voice-show/types';

interface Fixture {
  name: string;
  kind: ShowKind;
  isNextWeek?: boolean;
  user: Record<string, unknown>;
  summary: string;
  /** Each group is satisfied when any of its strings appears in the script. */
  facts: string[][];
  seconds: [number, number];
}

const FIXTURES: Fixture[] = [
  {
    name: 'daily-male-busy',
    kind: 'daily',
    user: {
      name: 'דני', gender: 'male', culture: 'jewish',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'נועה', color: '', personName: 'נועה', personGender: 'female' },
        { calendarId: 'k1', labels: ['kids'], name: 'איתי', color: '', personName: 'איתי', personGender: 'male' },
        { calendarId: 'k2', labels: ['kids'], name: 'תמר', color: '', personName: 'תמר', personGender: 'female' },
      ],
    },
    summary: `<b>בוקר טוב, דני! ☀️</b>

<b>היום - יום ראשון, 18 באוקטובר (ט״ז בתשרי)</b>

<b>לוח הזמנים שלך:</b>
• 08:30 - ישיבת צוות בזום
• 10:15 - פגישה עם עו"ד לוי
• 13:00 - ארוחת צהריים עם אבא

<b>לוח הזמנים של נועה:</b>
• 11:00 - רופא שיניים

<b>סדר איסוף:</b>
• 14:00 - נועה אוספת את איתי מהגן
• 16:30 - חוג שחייה לתמר

<b>מזג אוויר:</b> ☀️ 28°/19°, בהיר, בלי גשם. לחות גבוהה בצהריים.

<b>מבט לשבוע:</b>
• יום רביעי - יום ההולדת של סבתא רחל`,
    facts: [['דני'], ['צוות'], ['לוי'], ['אבא'], ['שיניים'], ['איתי'], ['תמר'], ['שחייה'], ['רחל'], ['ורבע'], ['אחת עשרה'], ['ארבע וחצי', 'שש עשרה ושלושים']],
    seconds: [35, 85],
  },
  {
    name: 'daily-female-empty',
    kind: 'daily',
    user: { name: 'מיכל', gender: 'female', culture: 'default', calendarAssignments: [] },
    summary: `<b>בוקר טוב, מיכל!</b>

<b>היום - יום שלישי, 20 באוקטובר</b>

אין אירועים ביומן היום 🎉

<b>מזג אוויר:</b> 🌧️ 22°/14°, סיכוי לגשם 60% אחר הצהריים. כדאי לקחת מטרייה.`,
    facts: [['מיכל'], ['גשם', 'מטרייה'], ['פנוי', 'אין אירועים', 'ריק', 'חופשי']],
    seconds: [15, 70],
  },
  {
    name: 'weekly-busy',
    kind: 'weekly',
    isNextWeek: false,
    user: {
      name: 'רזיאל', gender: 'male', culture: 'jewish',
      calendarAssignments: [
        { calendarId: 's', labels: ['spouse'], name: 'שי', color: '', personName: 'שי' },
        { calendarId: 'k1', labels: ['kids'], name: 'אורי', color: '', personName: 'אורי', personGender: 'male' },
      ],
    },
    summary: `<b>השבוע שלך 📅</b>

<b>יום ראשון (ט״ז בתשרי)</b>
• 09:00 - פגישת תכנון רבעונית
• 17:00 - שי: יוגה

<b>יום שני</b>
• 08:00 - אורי: טיול שנתי
• 12:30 - ארוחת צהריים עם הצוות
• 19:00 - אסיפת הורים

<b>יום שלישי</b>
• 10:00 - דוקטור כהן
• 15:45 - אורי: חוג רובוטיקה

<b>יום רביעי</b>
• 07:30 - טיסה לאילת
• 21:00 - שי: הופעה

<b>יום חמישי</b>
• 11:15 - שיחת משקיעים
• 18:00 - יום ההולדת של סבא משה

<b>יום שישי</b>
• 13:00 - ארוחת שישי אצל ההורים`,
    facts: [['תכנון'], ['יוגה'], ['טיול'], ['אסיפת הורים'], ['כהן'], ['רובוטיקה'], ['אילת'], ['הופעה'], ['משקיעים'], ['משה'], ['שישי']],
    seconds: [40, 100],
  },
  {
    name: 'weather-male',
    kind: 'weather',
    user: { name: 'יוסי', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `☀️ <b>מזג האוויר בתל אביב היום</b>
בוקר: 19°, צהריים: 28°, ערב: 23°
רוח מערבית קלה, בלי גשם.
איכות אוויר: בינונית.
מדד UV גבוה (8) — מומלץ קרם הגנה וכובע.`,
    facts: [['עשרים ושמונה'], ['קרם', 'כובע']],
    seconds: [12, 50],
  },
];

const SOUND = /<(chuckle|laugh|sigh|gasp|whispers|throat-clearing)>/g;
const JUDGE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } },
  required: ['ok', 'problems'],
};

type Check = { name: string; ok: boolean; detail: string };

function describePeople(context: ShowPromptContext): string {
  const lines = [`Listener: ${context.listener.name}, ${context.listener.gender}.`];
  if (context.spouse) {
    lines.push(`Spouse: ${context.spouse.name}, ${context.spouse.gender ?? 'gender unknown - must get name and neutral phrasing, never a gendered pronoun or verb'}.`);
  }
  for (const kid of context.kids) lines.push(`Child: ${kid.name}, ${kid.gender ?? 'gender unknown'}.`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.find(a => !a.startsWith('--')) ?? 'eval-voice-show-out';
  const modelFlag = args.indexOf('--model');
  const modelId = modelFlag >= 0 ? args[modelFlag + 1] : undefined;

  // Production runs Flash TTS (admin setting); locally there is no admin setting.
  process.env.GEMINI_TTS_MODEL ||= 'gemini-3.8-flash-tts';
  // Synthesize here, not on a deployed tts-service.
  delete process.env.TTS_SERVICE_URL;
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

  const { buildShowContext } = await import('../src/services/voice-show/context');
  const { writeShowScript } = await import('../src/services/voice-show/writer');
  const { toShowLines } = await import('../src/services/voice-show/script');
  const { generateShowVoice, getShowVoices } = await import('../src/services/voice-generator');
  const { generateAICompletion } = await import('../src/services/ai-provider');

  await fs.mkdir(outDir, { recursive: true });
  const report: Array<{ name: string; checks: Check[] }> = [];
  let firstTurns: ShowTurn[] = [];

  for (const fixture of FIXTURES) {
    console.log(`\n=== ${fixture.name} ===`);
    const checks: Check[] = [];
    const user = { id: 1, language: 'he', isAdmin: true, ...fixture.user } as unknown as UserConfig;
    const context = buildShowContext(fixture.summary, user, fixture.kind, fixture.isNextWeek);
    const record: Record<string, unknown> = { fixture: fixture.name, model: modelId ?? '(admin default)' };

    try {
      const written = await writeShowScript(context, { modelId });
      const turns = written.script.turns;
      if (!firstTurns.length) firstTurns = turns;
      const text = turns.map(t => t.text).join('\n');
      Object.assign(record, { attempts: written.attempts, warnings: written.script.warnings, turns, writerMs: written.completion.durationMs, writerUsage: written.completion.usage });

      const missing = fixture.facts.filter(group => !group.some(fact => text.includes(fact)));
      checks.push({ name: 'facts', ok: missing.length === 0, detail: missing.length ? `missing ${missing.map(g => g.join('|')).join(', ')}` : `${fixture.facts.length} groups found` });
      checks.push({ name: 'no digits', ok: !/\d/.test(text), detail: (text.match(/\S*\d\S*/g) ?? []).join(' ') || 'none' });
      const sounds = text.match(SOUND) ?? [];
      checks.push({ name: 'sounds <= 2', ok: sounds.length <= 2, detail: sounds.join(' ') || 'none' });
      checks.push({ name: 'shape', ok: true, detail: `${turns.length} turns, ${new Set(turns.map(t => t.mood)).size} moods (${[...new Set(turns.map(t => t.mood))].join(', ')}), attempts ${written.attempts}` });

      const judge = await generateAICompletion(
        `You check a Hebrew radio script for grammatical gender agreement.\n` +
        `The two hosts (A and B) are men and must speak of themselves in the masculine.\n${describePeople(context)}\n` +
        `Report every place where the listener is addressed with the wrong gender (second-person verbs, adjectives, pronouns), ` +
        `a family member is referred to with the wrong gender, a person of unknown gender is given one, or a host speaks of himself in the feminine. ` +
        `Return JSON {"ok": boolean, "problems": [string]}.\n\nScript:\n${turns.map(t => `${t.host}: ${t.text}`).join('\n')}`,
        modelId,
        { responseJsonSchema: JUDGE_SCHEMA },
      );
      const verdict = JSON.parse(judge.text) as { ok: boolean; problems: string[] };
      checks.push({ name: 'gender', ok: verdict.ok, detail: verdict.problems.join(' / ') || 'ok' });

      const lines = toShowLines(turns, 'he', context.listener.gender);
      const show = await generateShowVoice(lines, 'he');
      const [min, max] = fixture.seconds;
      checks.push({ name: 'length', ok: show.audioSeconds >= min && show.audioSeconds <= max, detail: `${show.audioSeconds.toFixed(1)}s (want ${min}-${max}), TTS ${(show.ttsMs / 1000).toFixed(1)}s, ${show.audioTokens} tokens, ${show.ttsModel}` });
      await fs.copyFile(show.filePath, path.join(outDir, `${fixture.name}.ogg`));
      await fs.unlink(show.filePath).catch(() => {});
      Object.assign(record, { lines, show: { ...show, filePath: undefined } });
    } catch (error) {
      checks.push({ name: 'run', ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }

    record.checks = checks;
    await fs.writeFile(path.join(outDir, `${fixture.name}.json`), JSON.stringify(record, null, 2));
    for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
    report.push({ name: fixture.name, checks });
  }

  // The tts-service endpoint, in-process, with the first fixture's opening lines.
  console.log('\n=== tts-service /api/dialogue (in-process) ===');
  const endpointChecks: Check[] = [];
  try {
    if (!firstTurns.length) throw new Error('no script to send (every fixture failed)');
    process.env.TTS_API_KEY = 'eval-key';
    const { default: handler } = await import('../tts-service/api/dialogue');
    const { toShowLines } = await import('../src/services/voice-show/script');
    const out = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0), json: undefined as unknown };
    const res = {
      status(code: number) { out.status = code; return res; },
      json(value: unknown) { out.json = value; return res; },
      send(body: Buffer) { out.body = Buffer.from(body); return res; },
      setHeader(name: string, value: string) { out.headers[name] = String(value); return res; },
    };
    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer eval-key' },
      body: { language: 'he', model: 'gemini-3.8-flash-tts', voices: getShowVoices('he'), lines: toShowLines(firstTurns.slice(0, 4), 'he', 'male') },
    } as never, res as never);
    const ok = out.status === 200 && out.body.subarray(0, 4).toString('ascii') === 'OggS' && Number(out.headers['X-TTS-Audio-Seconds']) > 0;
    endpointChecks.push({ name: 'endpoint', ok, detail: `status ${out.status}, ${out.headers['X-TTS-Audio-Seconds']}s, ${out.headers['X-TTS-Audio-Tokens']} tokens ${out.json ? JSON.stringify(out.json) : ''}` });
    if (out.status === 200) await fs.writeFile(path.join(outDir, 'endpoint.ogg'), out.body);
  } catch (error) {
    endpointChecks.push({ name: 'endpoint', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  for (const c of endpointChecks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  report.push({ name: 'endpoint', checks: endpointChecks });

  const failed = report.flatMap(r => r.checks.filter(c => !c.ok).map(c => `${r.name}/${c.name}`));
  console.log(`\n${failed.length ? `FAILED: ${failed.join(', ')}` : 'All checks passed'}  (output in ${outDir})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint scripts/eval-voice-show.ts`
Expected: silent.

- [ ] **Step 3: Run the eval (costs about $0.10)**

Run: `npx tsx -r dotenv/config scripts/eval-voice-show.ts <scratchpad>/eval-3.8 --model gemini-3.8-flash`
Then: `npx tsx -r dotenv/config scripts/eval-voice-show.ts <scratchpad>/eval-3.7 --model gemini-3.7-flash`
(`<scratchpad>` is the session scratchpad directory; never write eval output inside the repo.)

Expected: `All checks passed` for both, or failures that are understood. A failure in `facts`, `gender` or `length` is a prompt problem: fix `src/prompts/voice-show/he.ts` (and its smoke test if the change affects what it checks), rerun, and record what changed in the commit message. A `run` failure with `voice was not found` means the API key belongs to a project without the designed voices: stop and report it.

- [ ] **Step 4: Listen-check by transcription (optional but recommended)**

For each `.ogg`, transcribe with Gemini (any audio-capable model) and compare with the script's text: spoken sound tags, wrong times, wrong genders. Note findings in the final report.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-voice-show.ts
git commit -F - <<'MSG'
test(voice): add a live eval for the Hebrew two-host show

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
```

---

## Finishing (controller)

- [ ] Run every smoke script, both type-checks and lint on all changed files:
  ```bash
  for s in smoke-tts smoke-dialogue-tts smoke-pcm-mix smoke-voice-show-script smoke-voice-show-writer smoke-tts-dialogue-endpoint smoke-voice-generator smoke-voice-show-produce; do npx tsx scripts/$s.ts > /dev/null && echo "$s ok" || echo "$s FAILED"; done
  npx tsc --noEmit && npx tsc -p tts-service/tsconfig.json --noEmit
  npx eslint $(git diff --name-only main...HEAD | grep -E '\.(ts|tsx)$' | grep -v '^tts-service/')
  ```
- [ ] Whole-branch review against the spec and this plan.
- [ ] Push the branch (`git push -u origin feat/two-host-voice-show`). This deploys a Vercel preview of tts-service only; production changes only when `main` moves.
- [ ] Send the owner the samples (`*.ogg` from the eval) and a short report; offer the fast-forward of `main` (which deploys to Railway and Vercel production). Do not merge without the owner's yes.
