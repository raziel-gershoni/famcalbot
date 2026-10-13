# AI Model Configuration Guide

## The models

Every call in the app runs on one text model and one TTS model. Both are fixed in code;
there is no admin setting and no environment variable for either.

| What | Constant | Model | Defined in |
|------|----------|-------|------------|
| Text | `AI_MODEL` / `AI_MODEL_ID` | `gemini-3.8-flash` | `src/config/ai-models.ts` |
| Speech | `TTS_MODEL` | `gemini-3.8-flash-tts` | `src/config/tts-models.ts` |

The `AdminSettings` columns `defaultAiModel`, `geminiThinkingLevel` and `ttsModel` are
still in the schema but nothing reads or writes them.

## Text model

| Identifier | Model | Max output | Context | Cost (per 1M tokens) | Notes |
|------------|-------|-----------|---------|---------------------|-------|
| `gemini-3.8-flash` | Gemini 3.8 Flash | 64K | 1M | $0.75/$3.75 (in/out) | Introductory rate through 2026-12-31; $1.50/$7.50 after |

Text completions (`generateAICompletion`, `streamAICompletion`) use `getAIConfig()`,
which defaults to `AI_MODEL`. Its optional model id exists only for the live eval's
`--model`; an id that isn't in the catalog logs a warning and falls back to `AI_MODEL`.

The media pipelines (voice, image, forward-event, correction) call the Gemini SDK
directly with `AI_MODEL_ID`, the raw API id. Don't paste literals in their place: the
old per-file literals drifted until one of them (`gemini-2.0-flash-exp`) had been
retired by the provider and would 404 on every call that reached it.

The provider layer still supports Claude and GPT - see [Changing a model](#changing-a-model).

## Thinking level

Every Gemini text call is sent at the model's own declared level,
`defaultThinkingLevel`, which is `MEDIUM` for 3.8 Flash. Text completions get it from
`thinkingLevelFor()`; the media pipelines and the voice speech gate get it from
`getExtractionThinkingLevel()`. A model that declares no level gets no
`thinkingConfig` and takes the API default. TTS calls send no thinking config.

`MEDIUM` is the owner's choice (2026-10-13). A benchmark of every path on 2026-10-12
put it at about three times `LOW`'s latency:

| Path | `LOW` median / worst | `MEDIUM` median / worst |
|------|------------------|---------------------|
| Daily summary | 3.6s / 5.2s | 12s / 17.6s |
| Streamed summary (miniapp) | 4.8s / 9.1s | 18.5s / 30.2s |
| Weather forecast | 6.4s / 14.9s | 20s / 29.8s |
| Two-host show writer | 4.4s / 6.8s | 17.1s / 23.7s |
| Voice note extraction | 3.2s / 6.2s | 4.6s / 9.4s |
| Photo extraction | 3.2s / 9.6s | 6.8s / 13.4s |

Everything fits the 45s abort and the 50s command budget. An earlier run saw 17-46s
on the Hebrew daily summary at `MEDIUM`; the benchmark did not reproduce that tail.
`HIGH` is out: three of four summaries never finished inside the 45s abort.

Quality was mixed, `MEDIUM` against `LOW`:

- Better: daily summaries (a judge preferred `MEDIUM` about 2:1) and voice note
  extraction (309/309 fields right, against 302/309).
- Worse: the two-host show script reads less naturally (the judge preferred `LOW`
  about 2:1); 8 of 18 weather forecasts passed every check, against 11; Russian week
  summaries lost 2:9 (Hebrew and English won 9:2 and 8:4).
- The same: event matching, corrections, forwarded text and the speech gate.
- Photos: 6 of 24 runs were auto-created against 10. `MEDIUM` more often answered
  "medium" confidence for invitations with no printed year, as the prompt's rule said,
  while its example said "high". On 2026-10-13 the rule changed: a date without a year
  is "high" when it falls later this year or within the next 2 months, unless it also
  fell within the last 2 months or a printed weekday doesn't match.

Thinking tokens are billed as output tokens and are reported separately in the
completion result.

## Environment variables

```bash
# API key for the Gemini models
GEMINI_API_KEY=...

# Optional: cap output tokens (defaults to the model's maxOutputTokens)
AI_MAX_TOKENS=8192

# Optional: retry attempts on API failure (default: 1, i.e. 2 total attempts)
AI_MAX_RETRIES=1
```

SDK-level retries are disabled (`maxRetries: 0`), so `AI_MAX_RETRIES` is the only
retry layer. Streaming completions are not retried - partial streams can't be safely
replayed, so callers fall back to the buffered path.

## Text-to-speech

Spoken summaries and voice replies always use `TTS_MODEL`:

| Identifier | Audio output, per 1M tokens | Notes |
|------------|-----------------------------|-------|
| `gemini-3.8-flash-tts` | $9 ($18 from 2027) | Chosen over Flash-Lite by ear |

The catalog is `src/config/tts-models.ts`; request building and decoding live in
`src/services/gemini-tts.ts`. 3.8 TTS has two quirks that fail silently if ignored:

- **It reads its input verbatim.** Directions in the text get spoken aloud, so the
  voice style goes in a per-part `speechMetadata.style`, not the prompt.
- **It returns WAV by default**, with a ~6 KB C2PA metadata chunk after the audio.
  We request `AUDIO_L16` instead: headerless 24 kHz PCM. WAV is still parsed chunk by
  chunk as a fallback, never by stripping a fixed 44-byte header - that turns the C2PA
  chunk into a burst of noise.

The REST API is called directly because `@google/genai` 1.x drops both fields.
`tts-service/` carries an identical copy of `gemini-tts.ts` and must be redeployed
separately; it honours the `model` and `style` the main app sends.

`npx tsx scripts/smoke-tts.ts` covers the decoding and the request shape.

## Changing a model

Switching models is a code change and a redeploy. For text, add the entry to
`src/config/ai-models.ts` and point `AI_MODEL` at it:

```typescript
'gemini-4-flash': {
  provider: 'gemini',            // 'claude' | 'openai' | 'gemini'
  modelId: 'gemini-4-flash',     // exact API model ID
  displayName: 'Gemini 4 Flash',
  maxOutputTokens: 65536,
  contextWindow: 1048576,
  costPer1MTokens: { input: 0.75, output: 3.75 },
  description: 'What it is good for',
  defaultThinkingLevel: 'MEDIUM',   // omit to take the API default
},
```

For speech, do the same with `TTS_MODELS` and `TTS_MODEL` in `src/config/tts-models.ts`.
The media pipelines call Gemini directly, so a non-Gemini text model would need them
reworked too.

Verify the `modelId` against the provider's live model list first - a wrong ID only
surfaces as a 404 at call time - and check the thinking level against real prompts,
since the API default can be much slower.

## Monitoring

Token usage is logged per call, and hitting the output ceiling sends a Telegram alert
to the admin. Usage is tracked per provider, including cache and thinking tokens.
