# AI Model Configuration Guide

## Quick Start

Set the `AI_MODEL` environment variable to switch models — no code changes needed:

```bash
AI_MODEL=gemini-3.7-flash
```

## Available Models

The catalog in `src/config/ai-models.ts` lists only the models actually in use.
The provider layer still supports Claude and GPT — see [Adding a model](#adding-a-model).

| Identifier | Model | Max output | Context | Cost (per 1M tokens) | Notes |
|------------|-------|-----------|---------|---------------------|-------|
| `gemini-3.7-flash` | Gemini 3.7 Flash | 64K | 1M | $0.75/$3.75 (in/out) | **Default.** Introductory rate through 2026-12-31; $1.50/$7.50 after |
| `gemini-3.5-flash` | Gemini 3.5 Flash | 64K | 1M | $1.50/$9.00 (in/out) | Rollback target for 3.7 |

## How the model is chosen

Two different resolution paths, which is worth knowing before you change anything:

**Text completions** (`generateAICompletion`, `streamAICompletion`):

```
AdminSettings.defaultAiModel  →  process.env.AI_MODEL  →  FALLBACK_AI_MODEL
```

An identifier that isn't in the catalog logs a warning and falls back rather than
throwing — a stale value in the DB or the env shouldn't take the app down.

**Media pipelines** (voice, image, forward-event, correction) resolve separately and
never read `DEFAULT_AI_MODEL`:

```
AdminSettings.defaultAiModel  →  process.env.AI_MODEL  →  per-service hardcoded fallback
```

Each service's fallback is `FALLBACK_MODEL_ID` from `src/config/ai-models.ts` — the
raw provider ID for `FALLBACK_AI_MODEL`, since these services call the Gemini SDK
directly and need the API-side ID rather than the catalog key. Don't paste literals
here: the previous per-file literals drifted until one of them (`gemini-2.0-flash-exp`)
had been retired by the provider and would 404 on every call that reached it.

## Gemini thinking level

`AdminSettings.geminiThinkingLevel` accepts `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`, and is
sent as `thinkingConfig.thinkingLevel`. Support differs by model — 3.7 Flash rejects
`MINIMAL` with a 400 — so `resolveThinkingLevel()` coerces an unsupported level to the
nearest one the model accepts (`MINIMAL` → `LOW`, the floor on 3.7). Declare exclusions
per model via `unsupportedThinkingLevels`.

Note that 3.7 thinks by default. Levels reduce it but don't reliably zero it: on a
trivial prompt, unset averaged ~90 thought tokens, `LOW` ranged 0–62.

Thinking tokens are billed as output tokens and are reported separately in the
completion result.

## Environment variables

```bash
# Which model to use (optional — defaults to gemini-3.7-flash)
AI_MODEL=gemini-3.7-flash

# API key for your chosen model's provider
GEMINI_API_KEY=...

# Optional: cap output tokens (defaults to the model's maxOutputTokens)
AI_MAX_TOKENS=8192

# Optional: retry attempts on API failure (default: 1, i.e. 2 total attempts)
AI_MAX_RETRIES=1
```

SDK-level retries are disabled (`maxRetries: 0`), so `AI_MAX_RETRIES` is the only
retry layer. Streaming completions are not retried — partial streams can't be safely
replayed, so callers fall back to the buffered path.

## Switching models in production

The admin panel (Settings → AI Model) writes `AdminSettings.defaultAiModel` and takes
effect immediately — it overrides `AI_MODEL`. Use the Railway environment variable
only to change the floor for when no admin setting is present.

## Adding a model

Add an entry to `src/config/ai-models.ts`:

```typescript
'gemini-4-flash': {
  provider: 'gemini',            // 'claude' | 'openai' | 'gemini'
  modelId: 'gemini-4-flash',     // exact API model ID
  displayName: 'Gemini 4 Flash',
  maxOutputTokens: 65536,
  contextWindow: 1048576,
  costPer1MTokens: { input: 0.75, output: 3.75 },
  description: 'What it is good for',
},
```

It appears in the admin panel dropdown automatically. Verify the `modelId` against the
provider's live model list first — a wrong ID only surfaces as a 404 at call time.

## Monitoring

Token usage is logged per call, and hitting the output ceiling sends a Telegram alert
to the admin. Usage is tracked per provider, including cache and thinking tokens.
