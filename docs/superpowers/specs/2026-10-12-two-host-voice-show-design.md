# Two-host voice show

**Date:** 2026-10-12
**Status:** Design approved in chat; spec pending review

Every summary voice note stops being one narrator in a user-chosen voice and
style. It becomes a short show: two energetic hosts, excited sports-commentator
style, trading lines about the user's day, with an occasional laugh, sigh or
gasp. Users no longer choose a voice or a style. Hebrew ships first; English and
Russian follow with their own host pairs.

## Why

A blind trial and a by-ear review (2026-10-08 to 10-12) showed that
Voice-design voices on Gemini 3.8 Flash beat the prebuilt default (Algieba) for
Hebrew. The owner's favourite demo was a two-host morning show built line by
line, and the "excited sports commentator" style. The findings and samples are
at https://claude.ai/artifact/KnuTuSNF8MSG6PnU1uDUXQ.

## Decisions

| Question | Decision |
|---|---|
| Hosts | Two men. Hebrew: **A** `voice_33yuo333h4y2` (warm, late 30s), **B** `voice_zrrafp34tgt8` (young, energetic, 20s) |
| How audio is made | Each line synthesized separately, in parallel, then joined. One multi-speaker request blurs the two male voices and pulls B's pitch toward A |
| Which messages | Daily, tomorrow, weekly (This Week / Next Week) and `/weather`, on Telegram and WhatsApp. The admin-only "added your event" line stays a single line, in host A's voice |
| Length | About 45-60 s. Busy days may run over; banter never pushes out content |
| Addressing | Hosts talk to the listener by first name in the correct grammatical gender, and name family members with their gender. Unknown gender: name plus neutral phrasing. Hosts speak of themselves in the masculine |
| Emotion | Per-line **mood** from a fixed list, plus rare inline **sounds** (see below) |
| User choice | Removed for all languages. The voice on/off toggle stays |
| TTS model | The admin TTS model setting (production: `gemini-3.8-flash-tts`). The legacy 3.1 preview cannot use designed voices, so the show substitutes Flash for it |
| Where TTS runs | Same pattern as today: through the Vercel tts-service when `TTS_SERVICE_URL` is set, falling back to local synthesis on any failure; local otherwise |
| Languages without hosts | Keep the single narrator with the language's default prebuilt voice and no style |

### Moods and sounds

Each line carries one mood. The writer picks it, code maps it to a short style
string (short styles never changed words in 57 takes; long ones did):

| Mood | Style string sent |
|---|---|
| `hype` (default) | `excited sports commentator` |
| `triumph` | `triumphant, loud and celebratory` |
| `suspense` | `slow and suspenseful, building tension` |
| `amused` | `amused, laughing a little` |
| `surprised` | `surprised, high pitch` |
| `mock_disappointed` | `mock-disappointed, deflated` |
| `secret` | `whispering, secretive` |
| `warm` | `warm and relaxed, slower` |

Allowed inline sounds: `<chuckle>`, `<laugh>`, `<sigh>`, `<gasp>`, `<whispers>`,
`<throat-clearing>`. These were heard by a blind listener on both hosts in sports
style; giggle and snicker collapse into a laugh, groan and phew into a sigh, and
cheer, shout, tsk and pff did nothing. At most two sounds per show, never on
consecutive lines. Backchannels (`|wow|`) are banned: in single-voice requests
they produce a phantom extra voice. A reaction becomes its own short line by the
other host instead.

## How it works

```
summary text ──► show writer (LLM, JSON turns) ──► validate + Hebrew number pointing
            ──► TTS: remote tts-service if TTS_SERVICE_URL, else local
                    ├─ synthesize every line in parallel (designed voice, mood style)
                    ├─ trim edges, match host loudness, ~0.2 s gaps, join PCM
                    └─ encode OGG Opus once
            ──► sendVoice (Telegram / WhatsApp) + admin caption
```

### 1. Show writer — `src/prompts/voice-show/` (new)

Per-language prompt builders for three kinds: `daily` (daily and tomorrow),
`weekly`, `weather`. Hebrew first. Input: the finished text summary, listener
first name and gender (`user.gender`, always set), spouse name and gender
(`personGender`, optional), kids' names from kids calendars, culture, global
rules, and `isNextWeek` for weekly. Output, enforced with a JSON response
schema: `{ "turns": [{ "host": "A" | "B", "mood": "<mood>", "text": "..." }] }`.

The prompt carries over today's condenser rules: every event kept, every
clock time written as words, weather right after the date (daily), birthday
names, global rules. It adds the show rules: sports energy, banter that never
adds or drops facts, personal address, mood list, sound budget, no backchannels,
no Telegram HTML or emoji in the output. The existing
`src/prompts/voice-condenser/` stays for languages without hosts.

### 2. Script validation — `src/services/voice-show/script.ts` (new)

The writer is called through `generateAICompletion` extended with an options
argument for `responseSchema` and `temperature`. The admin default model stays
in charge. The parser enforces:

- hosts only `A` or `B`, 4 to 30 turns, no empty text, at most 400 characters
  per turn;
- moods from the list (unknown becomes `hype`);
- sounds from the whitelist only (others are stripped), at most two, not on
  consecutive turns;
- no `|...|`, no leftover HTML tags, no `A:` / `B:` speaker labels inside text.

A malformed result is regenerated once; a second failure takes the existing
"voice unavailable" path. For Hebrew, a fixed table then points the time words
that the trial caught being misread (`אחת עשרה`, `עשר`, `ורבע`, `שתים עשרה` and
the like). This is deterministic code, not the LLM.

### 3. Dialogue TTS — shared library

Today's TTS code exists twice, byte-identical, in `src/` and `tts-service/lib/`.
The dialogue code follows the same rule:

- `gemini-tts.ts`: designed-voice request shape (`speechConfig.voiceConfig.voice`,
  which also accepts prebuilt names); concatenate every returned audio part;
  return audio-token usage.
- `dialogue-tts.ts` (new): `synthesizeDialogue(lines, voices, model, apiKey)`
  synthesizes all lines in parallel with a per-line timeout of about 20 s and
  retries on 429, 5xx, timeouts and "no audio". It returns PCM plus audio
  seconds and tokens.
- `pcm-mix.ts` (new): trim each line's leading and trailing silence, short
  fades against clicks, one gain per host so the two match in loudness (whisper
  lines keep their dynamics), about 0.2 s gaps, a peak guard against clipping.
- OGG encoding happens once per show, with the existing `pcm-to-ogg-opus.ts`.

### 4. Remote path — `tts-service/api/dialogue.ts` (new)

Same auth (`TTS_API_KEY`) and the same `vercel.json` function settings
(maxDuration 60, opusscript bundled). It accepts `{ language, model, voices,
lines }` and returns OGG with headers for audio seconds, token usage and model.
The app calls it with a longer timeout than the single-voice call and falls back
to local synthesis on any error, as `voice-generator.ts` does today.

### 5. App wiring

- `voice-generator.ts`: new `generateShowVoice(script, language)` beside the
  existing single-voice function. It holds the per-language host table (code
  constants with an env override per id, like today's `GEMINI_TTS_VOICE_*`) and
  a process-wide limit on concurrent TTS calls, so the hourly summary run can't
  burst into rate limits.
- `telegram/voice.ts`: languages with hosts take the show path, others the
  narrator path. The user's `voicePreference` and `voiceStyle` are no longer
  read. `/weather` passes the `weather` kind.
- Admin caption: hosts, line count, audio seconds, TTS time, model and estimated
  cost. Analytics `duration_seconds` comes from the real audio length.
- `tts-outcome.ts`: languages with hosts speak the line in host A's voice.

### 6. Removing the choice

- `SettingsClient.tsx` and `settings/page.tsx`: the voice and style pickers go;
  the on/off toggle and usage badge stay, with a new description of the show
  in he, en and ru.
- `/api/settings`: stops reading and writing `voicePreference` and `voiceStyle`.
- `voice-options.ts`: `VOICE_OPTIONS`, `VOICE_STYLES`, `VOICE_STYLE_PROMPTS` and
  `getVoiceForUser` are removed once nothing uses them.
- The two DB columns stay in this release. Railway's zero-downtime deploys
  overlap old and new instances, so they are dropped in a later migration.

## Failure handling

| Failure | Behaviour |
|---|---|
| Writer returns malformed JSON or breaks the rules | Regenerate once, then "voice unavailable" text and admin warning (today's path) |
| A line fails after retries | Whole show fails over: remote → local; local failure → "voice unavailable" |
| tts-service fails or times out | Local synthesis (as today) |
| Host voice unknown to the project (`No matching speaker voice`) | Single narrator with the language default voice; one admin alert per day |
| Legacy 3.1 model selected in admin | Show uses `gemini-3.8-flash-tts` |
| User blocked the bot | Unchanged (recorded silently) |

## Testing

- `scripts/smoke-voice-show-script.ts`: parser and validator cases (bad JSON,
  unknown host or mood, foreign and excess sounds, consecutive sounds,
  backchannels, HTML remnants, speaker labels, empty turns) and the Hebrew
  pointing table.
- `scripts/smoke-pcm-mix.ts`: trim, per-host gain, gap length, total length =
  lines + gaps, no clipping.
- `scripts/smoke-tts.ts`: designed-voice request shape, multi-part audio
  concatenation, legacy-model substitution; the `src/` and `tts-service/lib/`
  copies are byte-identical.
- `scripts/eval-voice-show.ts` (live, costs money): realistic Hebrew summaries
  through the writer and TTS. Checks every event and time survives, times are
  words, length lands near 45-60 s, sounds stay within budget, listener gender
  agreement; saves the audio for listening.
- Samples go to the owner before the change ships.

## Rollout

1. Hebrew show, picker removal, tts-service dialogue endpoint (Vercel redeploys
   from main on push).
2. English and Russian: design two male hosts each, owner approves samples, add
   them to the host table. Prompt builders for en and ru.
3. Later release: migration dropping `voicePreference` and `voiceStyle`.

## Production facts to confirm

- Whether `TTS_SERVICE_URL` is set on Railway. It was on Koyeb (log of
  2026-03-18); a passive timing probe of the Vercel service is running. The
  design works either way.
- That production's `GEMINI_API_KEY` belongs to the project holding the
  designed voices. The owner believes it does; the voice-missing fallback covers
  the case where it doesn't.

## Out of scope

Weekly voice not counting toward usage and weather/weekly skipping the plan
gate (pre-existing inconsistencies); deleting the tts-service; a test framework
(scripts follow the existing smoke-script pattern).
