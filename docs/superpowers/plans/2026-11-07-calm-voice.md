# Calm Single Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings "Voice style" choice between the two-host radio show (default) and one calm male presenter who reads the same summary content, for every summary voice note (morning, evening, /lookahead, /nextweek, /weather), on Telegram and WhatsApp.

**Architecture:** One pipeline with a mode. `User.voiceFormat` ('show' | 'calm', default 'show') is read through `voiceFormatOf` into `ShowPromptContext.format` by `buildShowContext`; the same `writeShowScript` → `parseShowScript` → `toShowLines` → `generateShowVoice` path takes a `format` argument at each step. Calm gets its own prompt per language (`calm-{he,en,ru}.ts`) built from the show modules' shared facts rules, a paragraphs-only JSON schema, a parser branch that strips every tag, one voice per language (`CALM_VOICES`) with one style string (`CALM_STYLE`) on every paragraph, and a 400 ms gap in the mix. The show's bytes are pinned by a golden recorded before any refactor.

**Tech Stack:** Next.js 16, TypeScript, Prisma 5 (Neon Postgres), next-intl messages, Gemini (`generateAICompletion`, `gemini-3.8-flash-tts` over REST), offline tsx smoke scripts.

**Spec:** `docs/superpowers/specs/2026-11-07-calm-voice-design.md` (APPROVED 2026-11-07; decision 2 changed by the owner: the calm voice is **male** in every language). Executors read both.

## Global Constraints

- Work only in the worktree `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/wt-calm`, branch `feat/calm-voice`. Every command below runs from that directory.
- One smoke runs as: `bash -c 'source /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fake-env.sh; env $E npx tsx scripts/smoke-<name>.ts'` (written below as **SMOKE `<name>`**). Prefix `TZ=Asia/Jerusalem` inside the `env` call when the smoke says so (`env TZ=Asia/Jerusalem $E npx tsx ...`).
- Typecheck: `npx tsc --noEmit -p .`. Lint the files you touched: `npx eslint <files>`.
- Never `npm run build` (it migrates prod), never `prisma migrate` (any subcommand), never `scripts/setup-webhook.ts`, never read `.env*` files (grep with `--exclude='.env*'`). `npx prisma generate` is fine.
- Never run `scripts/eval-voice-show.ts` with `--yes`. The live calm eval is **controller only, after the owner's OK (given 2026-11-07 per the spec's status line, at the spec's estimate of ~$0.08)**.
- `CALM_STYLE = 'calm, warm radio presenter'` exactly. `CALM_VOICES` starts with `'Charon'`, gender `'male'`, for he, en and ru (provisional until the owner's blind pick; the controller swaps the names). **No test may hardcode a calm voice name**: tests read `getCalmVoice(locale)!.voice` / `CALM_VOICES`.
- The show must stay byte for byte: `scripts/fixtures/voice-show-golden.json` (Task 1) must pass after every later task. Never re-record it after Task 1.
- Migration: `prisma/migrations/20261107000000_voice_format/migration.sql`, hand-written. Column `"voiceFormat" TEXT NOT NULL DEFAULT 'show'` on table `"User"`.
- The column is not named `voicePreference` or `voiceStyle` (`scripts/smoke-dead-columns.ts` fails on them).
- Every user-facing string lives in `messages/{en,he,ru}.json`: natively written Hebrew, gender-neutral; Russian with a no-break space (` ` written as the JSON escape) after one-letter prepositions, as the file already does. No emoji. The exact copy is in Task 7.
- The legal texts (`legal.*`) and `LEGAL_UPDATED` are **not** touched (spec decision 6). Marketing and bot copy stay unchanged.
- No console line or Sentry field holds an email, a code, a token, a name, an endpoint, a key, a notification's title or body, or a summary's text. Log user ids, kinds, formats, counts.
- Parallel branch `feat/b-features` edits `messages/{en,he,ru}.json`, `app/[locale]/(app)/settings/SettingsClient.tsx`, `app/api/settings/route.ts`, `src/lib/page-data.ts` and `src/services/account-linking.ts`. In those files only **insert** lines at the places named below; never reorder, reformat or rewrite neighbouring lines.
- Commit after each task with this trailer, exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```

## Review Focus

1. **Voice switched off and on again while the style is Calm**: the "Voice style" row disappears with the switch and comes back showing Calm, and with nothing else changed Save stays off (Task 7, S14).
2. **The writer answers a calm prompt in the show's shape** (host B turns, moods): the parser refuses host B, the writer regenerates once with the reason, a second show-shaped answer reaches the caller's "voice unavailable" path; a host A with a mood is accepted and the mood ignored (Task 6, R2).
3. **A WhatsApp voice note for a calm user** goes through the same producer once and counts once, like Telegram (Task 6, voice-limits check).
4. **Linking a WhatsApp account that chose Calm into a Telegram account that never touched the setting** carries Calm over; an established Telegram account that still has the default takes it too (Task 2, account-merge #23/#24).
5. **A stored value other than exactly `calm`** (`''`, `'Calm'`, `'loud'`, missing) is the show everywhere: the user config, the voice context, the Settings props (Tasks 2, 6, 7: D2, A8, R1, #6c3).

---

## File map

| File | Change | Task |
|---|---|---|
| `scripts/smoke-voice-calm.ts` | Create: show goldens (G1, G2), later the calm checks | 1, 2-6 |
| `scripts/fixtures/voice-show-golden.json` | Create (recorded once) | 1 |
| `prisma/schema.prisma`, `prisma/migrations/20261107000000_voice_format/migration.sql` | Column `voiceFormat` | 2 |
| `src/services/voice-show/types.ts` | `ShowFormat`, `isVoiceFormat`, `voiceFormatOf`, `CALM_STYLE`, paragraph bounds | 2 |
| `src/types.ts` | `UserConfig.voiceFormat` narrowed | 2 |
| `app/api/settings/route.ts` | Validate and save `voiceFormat` | 2 |
| `src/services/account-linking.ts` | `voiceFormat: 'show'` in `NEW_ACCOUNT` | 2 |
| `scripts/smoke-address-me-as.ts`, `scripts/smoke-account-merge.ts` | A8, A9; W_SETUP and #24 | 2 |
| `src/services/voice-show/script.ts` | `CALM_RESPONSE_SCHEMA`, `parseShowScript(raw, source, format)`, `toShowLines(..., format)` | 3 |
| `src/services/voice-generator.ts` | `CALM_VOICES`, `getCalmVoice`, `ShowCast`, `generateShowVoice(..., format)` | 4 |
| `src/utils/ai-footer.ts` | `calm A:<voice>` caption | 4 |
| `src/prompts/voice-show/{he,en,ru}.ts` | `kindRules(context, format)`, exported shared pieces | 5 |
| `src/prompts/voice-show/{calm-he,calm-en,calm-ru}.ts` | Create | 5 |
| `src/prompts/voice-show/{index,types}.ts` | Dispatch by format; `format`, `presenterGender` | 5 |
| `src/services/voice-show/{context,writer,produce}.ts` | Route the format | 6 |
| `src/services/telegram/voice.ts` | Header comment only | 6 |
| `scripts/smoke-voice-limits.ts` | Calm counted once, WhatsApp too | 6 |
| `README.md`, `CLAUDE.md` | Stale voices line; the calm rule | 6 |
| `app/[locale]/(app)/settings/{settings-body.ts,SettingsClient.tsx}`, `src/lib/page-data.ts`, `messages/{en,he,ru}.json` | The row | 7 |
| `scripts/smoke-settings-render.ts`, `scripts/smoke-page-auth.ts` | S3, S14, #6c3 | 7 |
| `scripts/eval-voice-show.ts`, `scripts/smoke-eval-voice-show.ts` | `--format calm`, dry-run guards | 8 |

---

### Task 1: Record the show goldens (before any refactor)

**Files:**
- Create: `scripts/smoke-voice-calm.ts`
- Create: `scripts/fixtures/voice-show-golden.json` (written by the smoke's `--write-show-golden`)

**Interfaces:**
- Consumes: current `buildShowPrompt(context)` (`src/prompts/voice-show/index.ts`), `produceShowVoice(summary, user, kind, isNextWeek, { complete, synthesize })` (`src/services/voice-show/produce.ts`), `buildTtsRequestBody(input)` (`src/services/gemini-tts.ts`).
- Produces: `scripts/smoke-voice-calm.ts` with helpers `check`, `assert`, `show`, `sha`, `tone`, `quiet`, `ROOT`, `RATE`, `PEOPLE`, `SUMMARY`, `SCRIPTS`, and the marker line `// ---- Calm checks (added by later tasks) go here, above the report ----` inside `main()`. Later tasks add their checks right above that marker, in task order.

- [ ] **Step 1: Write the smoke (golden part only)**

Create `scripts/smoke-voice-calm.ts`:

```ts
// The calm single voice (spec docs/superpowers/specs/2026-11-07-calm-voice-design.md) and the show it must leave
// alone. G1 and G2 pin the two-host show byte for byte against scripts/fixtures/voice-show-golden.json, recorded on
// main before the calm refactor: every show prompt of the matrix (he/en/ru × daily, tomorrow, this week, next week,
// weather × listener gender × culture × with and without ⏰, plus one listener alone per kind), and a faked show run
// per language and listener gender: the writer's prompt and schema, and every TTS request Gemini gets (voice, text,
// style). The checks after them are the calm voice's: data, parser and lines, voice and caption, prompts, routing.
// The LLM and Gemini are faked. No network, no DB (the calendars lookup fails on the fake database URL and the show
// goes on without them, as in production).
//
// Run: bash -c 'source <scratchpad>/fake-env.sh; env $E npx tsx scripts/smoke-voice-calm.ts'
// Re-record the show goldens ONLY when the show itself is meant to change:
//   ... npx tsx scripts/smoke-voice-calm.ts --write-show-golden

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AICompletionOptions, AICompletionResult } from '../src/services/ai-provider';
import { buildTtsRequestBody, type SpeechAudio, type SynthesizeSpeechInput } from '../src/services/gemini-tts';
import { buildShowPrompt } from '../src/prompts/voice-show';
import type { ShowPerson, ShowPromptContext } from '../src/prompts/voice-show/types';
import type { ShowKind } from '../src/services/voice-show/types';
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
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (value: unknown) => JSON.stringify(value);
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const ROOT = path.resolve(__dirname, '..');
const GOLDEN = path.join(ROOT, 'scripts/fixtures/voice-show-golden.json');
const RATE = 24000;
function tone(ms: number): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return b;
}
/** Runs fn with console.log/warn/error silenced (the calendars lookup warns on the fake database). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

// ---- The show's matrix ----

type Locale = 'he' | 'en' | 'ru';
const LOCALES: Locale[] = ['he', 'en', 'ru'];
const KINDS: Array<{ name: string; kind: ShowKind; isNextWeek?: boolean }> = [
  { name: 'daily', kind: 'daily' },
  { name: 'tomorrow', kind: 'tomorrow' },
  { name: 'weekly', kind: 'weekly', isNextWeek: false },
  { name: 'nextweek', kind: 'weekly', isNextWeek: true },
  { name: 'weather', kind: 'weather' },
];
const PEOPLE: Record<Locale, { male: string; female: string; spouse: string; kids: ShowPerson[]; rule: string }> = {
  he: { male: 'דני', female: 'נועה', spouse: 'שי', kids: [{ name: 'איתי', gender: 'male' }, { name: 'מאיה', gender: 'female' }], rule: 'מאיה היא הבת שלי' },
  en: { male: 'Danny', female: 'Noa', spouse: 'Shai', kids: [{ name: 'Itai', gender: 'male' }, { name: 'Maya', gender: 'female' }], rule: 'Maya is my daughter' },
  ru: { male: 'Денис', female: 'Ноа', spouse: 'Шай', kids: [{ name: 'Итай', gender: 'male' }, { name: 'Майя', gender: 'female' }], rule: 'Майя — моя дочь' },
};
const SUMMARY: Record<Locale, string> = {
  he: '<b>בוקר טוב, דני!</b>\n• 10:15 - פגישה עם עו"ד לוי\n• 16:30 - חוג שחייה לתמר\n<b>מזג אוויר:</b> 28°/19°, בהיר',
  en: "<b>Good morning, Danny!</b>\n• 10:15 - Meeting with Levi\n• 16:30 - Tamar's swimming\n<b>Weather:</b> 28°/19°, clear",
  ru: '<b>Доброе утро, Денис!</b>\n• 10:15 - Встреча с Леви\n• 16:30 - Бассейн Тамары\n<b>Погода:</b> 28°/19°, ясно',
};
const REMINDER: Record<Locale, string> = {
  he: '\n⏰ 09:00 - לשלם את חשבון החשמל',
  en: '\n⏰ 09:00 - Pay the electricity bill',
  ru: '\n⏰ 09:00 - Оплатить счёт за свет',
};

/** Every case of the matrix, by name: the context the show's writer gets. 3 × 5 × (2 × 2 × 2 + 1) = 135. */
function showContexts(): Array<[string, ShowPromptContext]> {
  const cases: Array<[string, ShowPromptContext]> = [];
  for (const locale of LOCALES) {
    const p = PEOPLE[locale];
    for (const k of KINDS) {
      const week = k.kind === 'weekly' ? { isNextWeek: k.isNextWeek } : {};
      for (const gender of ['male', 'female'] as const) {
        for (const culture of ['jewish', 'default']) {
          for (const reminders of [false, true]) {
            cases.push([`${locale}-${k.name}-${gender}-${culture}-${reminders ? 'reminders' : 'plain'}`, {
              kind: k.kind,
              summary: SUMMARY[locale] + (reminders ? REMINDER[locale] : ''),
              locale,
              listener: { name: p[gender], gender },
              spouse: { name: p.spouse },
              kids: p.kids,
              hasKidsCalendars: true,
              culture,
              globalRules: [p.rule],
              ...week,
            }]);
          }
        }
      }
      // Alone: no partner, kids' calendars with no names, no rules of their own
      cases.push([`${locale}-${k.name}-alone`, {
        kind: k.kind, summary: SUMMARY[locale], locale, listener: { name: p.male, gender: 'male' },
        kids: [], hasKidsCalendars: true, culture: 'default', ...week,
      }]);
    }
  }
  return cases;
}

/** A clean show script per language: both hosts, moods, one sound mid-show, a whisper, times and second person. */
const SCRIPTS: Record<Locale, Array<{ host: 'A' | 'B'; mood: string; text: string }>> = {
  he: [
    { host: 'A', mood: 'hype', text: 'בוקר טוב! יש לך יום מלא.' },
    { host: 'B', mood: 'amused', text: 'בעשר ורבע פגישה עם עורך הדין לוי. <chuckle> רציני.' },
    { host: 'A', mood: 'suspense', text: 'ובאחת עשרה וחצי עוד משהו בדרך.' },
    { host: 'B', mood: 'secret', text: '<whispers> ובארבע וחצי חוג שחייה לתמר.' },
    { host: 'A', mood: 'triumph', text: 'איזה יום, והוא כולו שלך!' },
    { host: 'B', mood: 'warm', text: 'שיהיה לך יום מצוין!' },
  ],
  en: [
    { host: 'A', mood: 'hype', text: 'Good morning! Big day for you.' },
    { host: 'B', mood: 'amused', text: 'Ten fifteen in the morning, the meeting with Levi. <chuckle> Serious stuff.' },
    { host: 'A', mood: 'suspense', text: 'And at eleven thirty, something else is on the way.' },
    { host: 'B', mood: 'secret', text: "<whispers> Four thirty in the afternoon, Tamar's swimming." },
    { host: 'A', mood: 'triumph', text: "What a day, and it's all yours!" },
    { host: 'B', mood: 'warm', text: 'Have a great one!' },
  ],
  ru: [
    { host: 'A', mood: 'hype', text: 'Доброе утро! У тебя большой день.' },
    { host: 'B', mood: 'amused', text: 'В десять пятнадцать утра встреча с Леви. <chuckle> Серьёзно.' },
    { host: 'A', mood: 'suspense', text: 'А в половине двенадцатого ещё кое-что.' },
    { host: 'B', mood: 'secret', text: '<whispers> В половине пятого бассейн Тамары.' },
    { host: 'A', mood: 'triumph', text: 'Вот это день, и он весь твой!' },
    { host: 'B', mood: 'warm', text: 'Хорошего дня!' },
  ],
};

type ProduceRecord = { prompt: string; options: string; requests: string[] };

/** A faked show run per language and listener gender: what the writer and Gemini were sent. */
async function produceRecords(): Promise<Record<string, ProduceRecord>> {
  const { produceShowVoice } = await import('../src/services/voice-show/produce');
  const out: Record<string, ProduceRecord> = {};
  for (const locale of LOCALES) {
    for (const gender of ['male', 'female'] as const) {
      const prompts: Array<{ prompt: string; options: string }> = [];
      const requests: string[] = [];
      const user = {
        id: 7, name: PEOPLE[locale][gender], gender, language: locale, isAdmin: false,
        culture: 'jewish', globalRules: [], calendarAssignments: [],
      } as unknown as UserConfig;
      const voice = await quiet(() => produceShowVoice(SUMMARY[locale], user, 'daily', false, {
        complete: async (prompt: string, _model?: string, options?: AICompletionOptions): Promise<AICompletionResult> => {
          prompts.push({ prompt, options: show(options ?? null) });
          return { text: show({ turns: SCRIPTS[locale] }), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'STOP', model: 'Fake', durationMs: 1 };
        },
        synthesize: async (input: SynthesizeSpeechInput): Promise<SpeechAudio> => {
          requests.push(show({ model: input.model, body: buildTtsRequestBody(input) }));
          return { pcm: tone(300), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 10 };
        },
      }));
      await fsp.unlink(voice.filePath).catch(() => {});
      assert(prompts.length === 1, `${locale} ${gender}: ${prompts.length} writer calls`);
      out[`produce-${locale}-${gender}`] = { prompt: sha(prompts[0].prompt), options: prompts[0].options, requests: [...requests].sort() };
    }
  }
  return out;
}

async function main() {
  const prompts = Object.fromEntries(showContexts().map(([name, context]) => [name, sha(buildShowPrompt(context))]));
  const produce = await produceRecords();

  if (process.argv.includes('--write-show-golden')) {
    fs.writeFileSync(GOLDEN, JSON.stringify({ prompts, produce }, null, 2) + '\n');
    console.log(`Wrote ${Object.keys(prompts).length} show prompts and ${Object.keys(produce).length} show runs to ${path.relative(ROOT, GOLDEN)}`);
    process.exit(0);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as { prompts: Record<string, string>; produce: Record<string, ProduceRecord> };

  await check('G1 every show prompt of the matrix (135 cases) is byte for byte the one recorded before the calm voice', () => {
    assert(Object.keys(prompts).length === 135, `${Object.keys(prompts).length} cases`);
    assert(show(Object.keys(prompts).sort()) === show(Object.keys(golden.prompts).sort()), 'the set of cases differs from the golden');
    const changed = Object.keys(prompts).filter((name) => prompts[name] !== golden.prompts[name]);
    assert(changed.length === 0, `changed: ${show(changed)}`);
  });

  await check('G2 a faked show run (he/en/ru × listener gender) sends the writer the recorded prompt and schema, and Gemini the recorded TTS requests (voice, text, style), byte for byte', () => {
    assert(show(Object.keys(produce).sort()) === show(Object.keys(golden.produce).sort()), 'the set of runs differs from the golden');
    for (const name of Object.keys(golden.produce)) {
      assert(show(produce[name]) === show(golden.produce[name]), `${name}: now ${show(produce[name])}`);
    }
  });

  // ---- Calm checks (added by later tasks) go here, above the report ----

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it before recording to see it fail**

Run: **SMOKE `voice-calm`**
Expected: exits 1 with `ENOENT ... voice-show-golden.json` (no golden yet).

- [ ] **Step 3: Record the golden on the unchanged code**

Run: `bash -c 'source /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fake-env.sh; env $E npx tsx scripts/smoke-voice-calm.ts --write-show-golden'`
Expected: `Wrote 135 show prompts and 6 show runs to scripts/fixtures/voice-show-golden.json`. Open the file: each `produce-*` entry has 6 requests whose bodies carry `"voiceName"` of the show hosts (he/ru `Schedar`/`Puck`, en `Rasalgethi`/`Sadachbia`) and styles starting `high-energy, excited sports commentator`; the `options` string contains `"responseJsonSchema"` with `"host"` and `"mood"`.

- [ ] **Step 4: Run the check**

Run: **SMOKE `voice-calm`**
Expected: `2/2 passed`. Run it twice more: still `2/2` (deterministic).

- [ ] **Step 5: Prove the golden bites**

Temporarily change one character inside the Hebrew show template in `src/prompts/voice-show/he.ts` (e.g. `'שמות מלאים, בלי קיצורים.'` → `'שמות מלאים, בלי קיצורים!'`). Run **SMOKE `voice-calm`**: G1 FAIL listing he cases, G2 FAIL for `produce-he-*`. Revert with `git checkout src/prompts/voice-show/he.ts`; run again: `2/2 passed`. Then temporarily change `'high-energy, excited sports commentator'` in `src/services/voice-show/types.ts` to `'high-energy, excited sports commentator.'`: G2 FAIL. Revert with `git checkout src/services/voice-show/types.ts`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npx tsc --noEmit -p .` (clean) and `npx eslint scripts/smoke-voice-calm.ts` (clean).

```bash
git add scripts/smoke-voice-calm.ts scripts/fixtures/voice-show-golden.json
git commit -m "test(voice): pin the two-host show's prompts and TTS requests before the calm voice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 2: The voiceFormat column, the format helpers, the settings API and the merge

**Files:**
- Modify: `prisma/schema.prisma` (the `User` model, after `voiceSummaryEnabled`)
- Create: `prisma/migrations/20261107000000_voice_format/migration.sql`
- Modify: `src/services/voice-show/types.ts` (append)
- Modify: `src/types.ts` (import, `UserConfig`, `convertPrismaUserToConfig`)
- Modify: `app/api/settings/route.ts` (insertions only)
- Modify: `src/services/account-linking.ts:122-129` (`NEW_ACCOUNT`, one inserted line)
- Test: `scripts/smoke-voice-calm.ts` (D1, D2), `scripts/smoke-address-me-as.ts` (A8, A9), `scripts/smoke-account-merge.ts` (W_SETUP, baseUser, #24)

**Interfaces:**
- Produces (in `src/services/voice-show/types.ts`):
  - `export type ShowFormat = 'show' | 'calm'`
  - `export function isVoiceFormat(value: unknown): value is ShowFormat`
  - `export function voiceFormatOf(user: { voiceFormat?: string | null }): ShowFormat`
  - `export const CALM_STYLE = 'calm, warm radio presenter'`
  - `export const MIN_CALM_PARAGRAPHS = 2`, `export const MAX_CALM_PARAGRAPHS = 12`
- Produces: `UserConfig.voiceFormat: ShowFormat` (narrowed in `convertPrismaUserToConfig` via `voiceFormatOf`).
- Produces: `POST /api/settings` accepts `voiceFormat` ('show' | 'calm'); anything else → 400 `{ error: 'Invalid voiceFormat' }`, nothing written.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-voice-calm.ts`, above the marker line, add:

```ts
  await check('D1 the migration adds exactly User.voiceFormat (text, not null, default show), idempotent; the schema declares the same', () => {
    const file = path.join(ROOT, 'prisma/migrations/20261107000000_voice_format/migration.sql');
    assert(fs.existsSync(file), 'no prisma/migrations/20261107000000_voice_format/migration.sql');
    const sql = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.trim().startsWith('--')).join(' ').replace(/\s+/g, ' ').trim();
    assert(sql === `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "voiceFormat" TEXT NOT NULL DEFAULT 'show';`, `the SQL: ${sql}`);
    const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    assert(/\n\s+voiceFormat\s+String\s+@default\("show"\)/.test(schema), 'the schema has no voiceFormat String @default("show")');
  });

  await check('D2 the format: only exactly "calm" is calm, a missing, empty or unknown value is the show; the route\'s closed set is show and calm; CALM_STYLE is the frozen string', async () => {
    const { CALM_STYLE, MAX_CALM_PARAGRAPHS, MIN_CALM_PARAGRAPHS, isVoiceFormat, voiceFormatOf } = await import('../src/services/voice-show/types');
    assert(voiceFormatOf({ voiceFormat: 'calm' }) === 'calm', 'calm');
    for (const value of ['show', '', 'Calm', 'CALM', ' calm', 'loud', null, undefined]) {
      assert(voiceFormatOf({ voiceFormat: value }) === 'show', `${show(value)} is not the show`);
    }
    assert(voiceFormatOf({}) === 'show', 'no field');
    assert(isVoiceFormat('show') && isVoiceFormat('calm'), 'the two');
    for (const value of ['', 'Calm', 'loud', null, undefined, 0, true, ['calm'], { calm: true }]) assert(!isVoiceFormat(value), `${show(value)} accepted`);
    assert(CALM_STYLE === 'calm, warm radio presenter', `CALM_STYLE ${show(CALM_STYLE)}`);
    assert(MIN_CALM_PARAGRAPHS === 2 && MAX_CALM_PARAGRAPHS === 12, 'paragraph bounds');
  });
```

In `scripts/smoke-address-me-as.ts`:
- In the header comment, after the `//  - A7 ...` two lines, insert:
  ```ts
  //  - A8 the voice style (Settings "Voice style", User.voiceFormat): the route saves "calm" and "show", logs the field's
  //    name only, the next read narrows it, a save without one leaves it alone, and a stored unknown value reads as the show;
  //  - A9 any other voice style is refused with 400 and writes nothing.
  ```
- Add these two checks right after the A7 check's closing `});`:

```ts
  await check('A8 the voice style: the route saves "calm" and "show" (200, the row holds it, the activity log gets the field\'s name voiceFormat, never its value), the next read says what was saved, a save without one leaves it alone, and a stored unknown value reads as the show', async () => {
    seed();
    eq((await configOf(3)).voiceFormat, 'show', 'where everyone starts');
    const toCalm = await save(3, { voiceFormat: 'calm' });
    assert(toCalm.status === 200, `calm: ${show(toCalm)}`);
    eq(userRow(3).voiceFormat, 'calm', 'the row after calm');
    eq(activities.map(a => [a.userId, a.type, a.meta]), [[3, 'settings_changed', { changed_fields: ['voiceFormat'] }]], 'activity');
    assert(!JSON.stringify(activities).includes('calm'), 'the activity carries the value');
    eq((await configOf(3)).voiceFormat, 'calm', 'reloaded');
    assert((await save(3, { weatherEnabled: false })).status === 200, 'a save without a voice style');
    eq((await configOf(3)).voiceFormat, 'calm', 'still calm');
    assert((await save(3, { voiceFormat: 'show' })).status === 200, 'and back');
    eq((await configOf(3)).voiceFormat, 'show', 'back to the show');
    userRow(3).voiceFormat = 'loud';
    eq((await configOf(3)).voiceFormat, 'show', 'a stored unknown value');
  });

  await check('A9 a voice style other than "show" or "calm" is refused with 400 "Invalid voiceFormat" and writes nothing, not even the other settings of that request', async () => {
    const bad: unknown[] = ['', 'Calm', 'CALM', ' calm', 'loud', 'radio', null, 0, 1, true, ['calm'], { voiceFormat: 'calm' }];
    for (const value of bad) {
      seed();
      const res = await save(3, { voiceFormat: value, language: 'he', weatherEnabled: false });
      assert(res.status === 400 && res.body.error === 'Invalid voiceFormat', `${show(value)}: ${show(res)}`);
      eq([userRow(3).voiceFormat, userRow(3).language, userRow(3).weatherEnabled], [undefined, 'en', true], `${show(value)}: the row`);
      assert(userWrites.length === 0 && activities.length === 0, `${show(value)}: wrote ${show(userWrites)} ${show(activities)}`);
    }
  });
```

In `scripts/smoke-account-merge.ts`:
- In `baseUser`, after `pickupRemindersEnabled: true, reminderStartAt: null,` insert a line `    voiceFormat: 'show',`.
- In `W_SETUP`, after `latitude: 32.794, longitude: 34.9896, elevationM: 120, zmanimCommunity: 'ashkenazi', pauseOnShabbat: true,` insert a line `  voiceFormat: 'calm',`.
- In check `#24`, after the line `    assert(t.pauseOnShabbat === true, ...);` insert:
  ```ts
    assert(t.voiceFormat === 'calm', `T never changed the voice style, so it takes W's: ${show(t.voiceFormat)}`);
  ```

- [ ] **Step 2: Run them to see them fail**

Run: **SMOKE `voice-calm`** → D1 FAIL (no migration), D2 FAIL (`isVoiceFormat` is not a function / import error).
Run: **SMOKE `address-me-as`** (with `TZ=Asia/Jerusalem`) → A8 FAIL (`undefined` vs `"show"`), A9 FAIL (status 200).
Run: **SMOKE `account-merge`** → #23 FAIL (voiceFormat not carried over), #24 FAIL.

- [ ] **Step 3: Schema, migration, generate**

In `prisma/schema.prisma`, right after the line `  voiceSummaryEnabled        Boolean   @default(true) // Receive voice summaries`, insert:

```prisma
  voiceFormat                String    @default("show") // Voice style of the summary voice notes: 'show' (two hosts) | 'calm' (one presenter); read only through voiceFormatOf
```

Create `prisma/migrations/20261107000000_voice_format/migration.sql`:

```sql
-- The calm single voice (spec docs/superpowers/specs/2026-11-07-calm-voice-design.md §3, Technical choices).
--
-- "voiceFormat": how a person's summary voice notes sound: 'show' (the two-host radio show, everyone's default,
-- existing accounts included) or 'calm' (one calm presenter reading the same content). A closed set the settings
-- route enforces (isVoiceFormat, src/services/voice-show/types.ts); the voice code reads anything but 'calm' as the
-- show (voiceFormatOf).
--
-- An addition only, so one push is enough: the previous build, still serving while this runs, never reads it.
-- Hand-written and idempotent, like the other recent migrations: a re-run is a no-op.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "voiceFormat" TEXT NOT NULL DEFAULT 'show';
```

Run: `bash -c 'source /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fake-env.sh; env $E npx prisma generate'` → `Generated Prisma Client`.

- [ ] **Step 4: The format helpers**

Append to `src/services/voice-show/types.ts`:

```ts

/**
 * How a person's summary voice notes sound (User.voiceFormat, Settings "Voice style"): the two-host show, or one
 * calm presenter reading the same content (spec docs/superpowers/specs/2026-11-07-calm-voice-design.md).
 */
export type ShowFormat = 'show' | 'calm';

/** The closed set the settings route accepts; anything else is refused with 400 and never stored. */
export function isVoiceFormat(value: unknown): value is ShowFormat {
  return value === 'show' || value === 'calm';
}

/** A row's format, the one reader of User.voiceFormat: only exactly 'calm' is calm; missing or unknown is the show. */
export function voiceFormatOf(user: { voiceFormat?: string | null }): ShowFormat {
  return user.voiceFormat === 'calm' ? 'calm' : 'show';
}

/**
 * The calm presenter's persona, the same on every paragraph. It is picked by ear with the voice in the owner's blind
 * round (spec §4) and frozen there: no mood colour, no pace word ("slowly" ran about 40% slower), no "morning"
 * (evening notes use it too). The style changes the timbre, so changing it means listening again.
 */
export const CALM_STYLE = 'calm, warm radio presenter';

/** Calm paragraphs per voice note (each is one TTS request). The prompt asks for 4-8 (weather 3-6). */
export const MIN_CALM_PARAGRAPHS = 2;
export const MAX_CALM_PARAGRAPHS = 12;
```

- [ ] **Step 5: Narrow UserConfig**

In `src/types.ts`:
- After `import { pushDeviceCountOf } from './services/web-push/reach';` insert `import { voiceFormatOf, type ShowFormat } from './services/voice-show/types';`
- In the `UserConfig` `Omit<PrismaUser, ...>` list, change `'gender' | 'calendarAssignments'` to `'gender' | 'voiceFormat' | 'calendarAssignments'`.
- After the line `  gender: 'male' | 'female';  // Narrow type for type safety` insert `  voiceFormat: ShowFormat;  // Narrowed by voiceFormatOf: anything but 'calm' is the show`
- In `convertPrismaUserToConfig`, after the line `    gender: user.gender as 'male' | 'female',` insert `    voiceFormat: voiceFormatOf(user),`

- [ ] **Step 6: The settings route (insertions only)**

In `app/api/settings/route.ts`:
- After `import { isCommunity } from '@/src/services/zmanim/sets';` insert `import { isVoiceFormat } from '@/src/services/voice-show/types';`
- After the long destructuring line `    const { language, gender, ... initData } = body;` insert:
  ```ts
    // "Voice style" (Settings, under the voice switch): the two-host show or the calm single voice
    const { voiceFormat } = body;
  ```
- After the gender validation block (the `if (gender !== undefined && !isGender(gender)) { ... }` three lines) insert:
  ```ts
    // A closed set: show or calm (src/services/voice-show/types.ts). Anything else is refused, never stored.
    if (voiceFormat !== undefined && !isVoiceFormat(voiceFormat)) {
      return NextResponse.json({ error: 'Invalid voiceFormat' }, { status: 400 });
    }
  ```
- In the `update` object, after the line `      voiceSummaryEnabled: typeof voiceSummaryEnabled === 'boolean' ? voiceSummaryEnabled : undefined,` insert:
  ```ts
      // The voice notes read the row at send time (voiceFormatOf): nothing caches it
      voiceFormat: isVoiceFormat(voiceFormat) ? voiceFormat : undefined,
  ```

- [ ] **Step 7: The merge default**

In `src/services/account-linking.ts`, inside `NEW_ACCOUNT`, after the line `  textSummaryEnabled: true, voiceSummaryEnabled: true, voiceInputEnabled: true,` insert the line `  voiceFormat: 'show',`.

- [ ] **Step 8: Typecheck and fix the typed fixtures it names**

Run: `npx tsc --noEmit -p .`
If it reports an object literal typed as `UserConfig` or Prisma `User` missing `voiceFormat`, add `voiceFormat: 'show'` to that literal only (no other change). Re-run until clean.

- [ ] **Step 9: Run the tests**

Run: **SMOKE `voice-calm`** → `4/4 passed` (G1, G2, D1, D2).
Run: **SMOKE `address-me-as`** (TZ=Asia/Jerusalem) → all pass, A8 and A9 included.
Run: **SMOKE `account-merge`**, **SMOKE `dead-columns`**, **SMOKE `account-create`**, **SMOKE `signin-data`**, **SMOKE `page-auth`** → all pass.
Run: `npx eslint src/services/voice-show/types.ts src/types.ts app/api/settings/route.ts src/services/account-linking.ts scripts/smoke-voice-calm.ts scripts/smoke-address-me-as.ts scripts/smoke-account-merge.ts` → clean.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261107000000_voice_format src/services/voice-show/types.ts src/types.ts app/api/settings/route.ts src/services/account-linking.ts scripts/smoke-voice-calm.ts scripts/smoke-address-me-as.ts scripts/smoke-account-merge.ts
git add -u scripts   # only if Step 8 touched fixtures
git commit -m "feat(voice): User.voiceFormat (show or calm), saved by the settings route and carried by the merge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 3: The calm script: schema, parser and lines

**Files:**
- Modify: `src/services/voice-show/script.ts`
- Test: `scripts/smoke-voice-calm.ts` (C1-C7, L1-L3); existing `scripts/smoke-voice-show-script.ts` must still pass

**Interfaces:**
- Consumes: `ShowFormat`, `CALM_STYLE`, `MIN_CALM_PARAGRAPHS`, `MAX_CALM_PARAGRAPHS` (Task 2).
- Produces:
  - `export const CALM_RESPONSE_SCHEMA` (`{ turns: [{ text }] }`)
  - `export function parseShowScript(raw: string, source = '', format: ShowFormat = 'show'): ShowScript` — calm turns are `{ host: 'A', mood: 'warm', text }` (host and mood unused by calm).
  - `export function toShowLines(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female', format: ShowFormat = 'show'): ShowLine[]` — calm lines are `{ host: 'A', text, style: CALM_STYLE }` (no `whisper` key).

- [ ] **Step 1: Write the failing tests**

Above the marker in `scripts/smoke-voice-calm.ts`:

```ts
  const calmJson = (texts: unknown[]) => show({ turns: texts.map((text) => ({ text })) });

  await check('C1 a calm answer is paragraphs read by host A: four clean paragraphs parse with no warnings; a mood or a host A on a paragraph is accepted and ignored', async () => {
    const { parseShowScript } = await import('../src/services/voice-show/script');
    const s = parseShowScript(calmJson(['בוקר טוב, דני.', 'בעשר ורבע פגישה.', 'בערב ארוחה אצל סבתא.', 'שיהיה יום טוב.']), '', 'calm');
    assert(s.turns.length === 4 && s.turns.every((t) => t.host === 'A') && s.warnings.length === 0, show(s));
    const withExtras = parseShowScript(show({ turns: [{ host: 'A', mood: 'hype', text: 'אחת.' }, { mood: 'nope', text: 'שתיים.' }] }), '', 'calm');
    assert(withExtras.turns.length === 2 && withExtras.warnings.length === 0, show(withExtras));
  });

  await check('C2 one presenter: a paragraph for host B (or any host but A), or a speaker label inside the text, is refused', async () => {
    const { parseShowScript, ShowScriptError } = await import('../src/services/voice-show/script');
    for (const raw of [
      show({ turns: [{ host: 'A', text: 'שלום.' }, { host: 'B', text: 'יאללה.' }] }),
      show({ turns: [{ host: 'C', text: 'שלום.' }, { text: 'עוד.' }] }),
      calmJson(['Good morning. B: and over to you!', 'Bye.']),
    ]) {
      let error: unknown;
      try { parseShowScript(raw, '', 'calm'); } catch (e) { error = e; }
      assert(error instanceof ShowScriptError, `accepted: ${raw}`);
    }
  });

  await check('C3 calm strips every tag (the sounds the show keeps, <yawn>, <short pause>, HTML) and every stage direction, and notes each in the warnings', async () => {
    const { parseShowScript } = await import('../src/services/voice-show/script');
    const s = parseShowScript(calmJson([
      '<laugh> Good morning, Danny. <whispers> Here is your day.',
      'At ten <yawn> fifteen, <short pause> the <b>meeting</b> with Levi.',
      '(laughs) And tonight, dinner. *sighs*',
    ]), '', 'calm');
    const text = s.turns.map((t) => t.text).join(' ');
    assert(!/[<>]/.test(text), `a bracket left: ${text}`);
    assert(!/laugh|whisper|yawn|pause|sigh/i.test(text), `a cue left: ${text}`);
    assert(text.includes('meeting') && text.includes('dinner'), `words lost: ${text}`);
    assert(s.warnings.filter((w) => w.includes('removed')).length >= 6, show(s.warnings));
  });

  await check('C4 paragraph bounds: 2 and 12 parse; 1, 13 and none are refused; a paragraph over 400 characters is refused; a paragraph with no words is dropped, and too few left is refused', async () => {
    const { parseShowScript, ShowScriptError } = await import('../src/services/voice-show/script');
    const p = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen'][i]}.`);
    assert(parseShowScript(calmJson(p(2)), '', 'calm').turns.length === 2, '2');
    assert(parseShowScript(calmJson(p(12)), '', 'calm').turns.length === 12, '12');
    const refused = (raw: string) => {
      try { parseShowScript(raw, '', 'calm'); } catch (e) { return e instanceof ShowScriptError; }
      return false;
    };
    assert(refused(calmJson(p(1))) && refused(calmJson(p(13))) && refused(show({ turns: [] })) && refused('{"nope":1}') && refused('not json'), 'bounds');
    assert(refused(calmJson(['a'.repeat(401), 'Fine.'])), 'over 400');
    const dropped = parseShowScript(calmJson(['<laugh>', 'One.', 'Two.']), '', 'calm');
    assert(dropped.turns.length === 2 && dropped.warnings.some((w) => w.includes('dropped')), show(dropped));
    assert(refused(calmJson(['<laugh>', 'One.'])), 'one left');
  });

  await check('C5 the show is untouched: its parser still keeps whitelisted sounds, needs both hosts, and refuses a calm-shaped answer', async () => {
    const { parseShowScript, ShowScriptError } = await import('../src/services/voice-show/script');
    const s = parseShowScript(show({ turns: SCRIPTS.en }));
    assert(s.turns.length === 6 && s.turns.some((t) => t.text.includes('<chuckle>')) && s.turns.some((t) => t.host === 'B'), show(s));
    let error: unknown;
    try { parseShowScript(calmJson(['One.', 'Two.', 'Three.', 'Four.'])); } catch (e) { error = e; }
    assert(error instanceof ShowScriptError, 'the show took paragraphs with no host');
  });

  await check('C6 CALM_RESPONSE_SCHEMA asks for turns of text only; SHOW_RESPONSE_SCHEMA is unchanged', async () => {
    const { CALM_RESPONSE_SCHEMA, SHOW_RESPONSE_SCHEMA } = await import('../src/services/voice-show/script');
    assert(show(CALM_RESPONSE_SCHEMA) === show({ type: 'object', properties: { turns: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }, required: ['turns'] }), show(CALM_RESPONSE_SCHEMA));
    assert(show(Object.keys(SHOW_RESPONSE_SCHEMA.properties.turns.items.properties)) === show(['host', 'mood', 'text']), 'the show schema');
  });

  await check('C7 a summary\'s own bracketed words stay in a calm paragraph (the show\'s rule): "(ערב צחוק)" from the summary is spoken, a bare "(צוחק)" is not', async () => {
    const { parseShowScript } = await import('../src/services/voice-show/script');
    const s = parseShowScript(calmJson(['בשמונה (ערב צחוק) במתנ"ס.', 'שיהיה ערב טוב (צוחק).']), '• 20:00 - (ערב צחוק) במתנ"ס', 'calm');
    assert(s.turns[0].text.includes('(ערב צחוק)') && !s.turns[1].text.includes('צוחק'), show(s.turns));
  });

  await check('L1 calm lines: one voice (host A), CALM_STYLE on every line, no whisper, and Hebrew pointed for the listener as the show points it', async () => {
    const { toShowLines } = await import('../src/services/voice-show/script');
    const { pointHebrewTimes, pointSecondPerson } = await import('../src/services/voice-show/hebrew-pointing');
    const { CALM_STYLE } = await import('../src/services/voice-show/types');
    const texts = ['בוקר טוב, נועה. יש לך יום רגוע.', 'בעשר ורבע פגישה, ובאחת עשרה הפסקה.', 'שיהיה לך יום טוב.'];
    const turns = texts.map((text) => ({ host: 'A' as const, mood: 'warm' as const, text }));
    const lines = toShowLines(turns, 'he', 'female', 'calm');
    assert(lines.every((l) => l.host === 'A' && l.style === CALM_STYLE && !('whisper' in l)), show(lines));
    assert(show(lines.map((l) => l.text)) === show(texts.map((t) => pointSecondPerson(pointHebrewTimes(t), 'female'))), show(lines));
    assert(lines[0].text !== texts[0], 'nothing was pointed');
  });

  await check('L2 calm lines in English and Russian are the text as written; the show\'s lines still carry the mood style and the whisper flag', async () => {
    const { toShowLines } = await import('../src/services/voice-show/script');
    const { CALM_STYLE } = await import('../src/services/voice-show/types');
    for (const language of ['en', 'ru']) {
      const turns = [{ host: 'A' as const, mood: 'warm' as const, text: language === 'en' ? 'Good morning.' : 'Доброе утро.' }];
      const [line] = toShowLines(turns, language, 'female', 'calm');
      assert(line.text === turns[0].text && line.style === CALM_STYLE, show(line));
    }
    const showLines = toShowLines([{ host: 'B', mood: 'secret', text: '<whispers> a secret' }], 'en', 'male');
    assert(showLines[0].style === 'high-energy, excited sports commentator, leaning in close' && showLines[0].whisper === true, show(showLines));
  });
```

- [ ] **Step 2: Run to see them fail**

Run: **SMOKE `voice-calm`** → C1-C4, C6, C7, L1, L2 FAIL (no third argument; `CALM_RESPONSE_SCHEMA` undefined). C5 passes.

- [ ] **Step 3: Implement**

In `src/services/voice-show/script.ts`:

1. Replace the types import block

```ts
import {
  MAX_SOUNDS_PER_SHOW, MAX_TURN_CHARS, MAX_TURNS, MIN_TURNS, MOODS, SOUND_TAGS, moodStyle,
  type Mood, type ShowLine, type ShowScript, type ShowTurn,
} from './types';
```

with

```ts
import {
  CALM_STYLE, MAX_CALM_PARAGRAPHS, MAX_SOUNDS_PER_SHOW, MAX_TURN_CHARS, MAX_TURNS, MIN_CALM_PARAGRAPHS, MIN_TURNS, MOODS,
  SOUND_TAGS, moodStyle, type Mood, type ShowFormat, type ShowLine, type ShowScript, type ShowTurn,
} from './types';
```

2. Add to the file's top comment, after its last line (` * (a lone <laugh>) is dropped.`):

```ts
 *
 * The calm single voice (format 'calm') is paragraphs read by one presenter: {"turns":[{"text":"..."}]}, 2-12 of up
 * to 400 characters. A host other than A is refused; every tag goes, the show's sounds included (a <yawn>-type tag
 * also slows the whole read); the cleanup is otherwise the same.
```

3. After the `SHOW_RESPONSE_SCHEMA` constant, add:

```ts

/** The calm writer's JSON: paragraphs only, read by one presenter. Bounds are the parser's, as for the show. */
export const CALM_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  required: ['turns'],
};
```

4. Replace the signature line and the array check at the start of `parseShowScript`:

```ts
export function parseShowScript(raw: string, source = ''): ShowScript {
```
→
```ts
export function parseShowScript(raw: string, source = '', format: ShowFormat = 'show'): ShowScript {
```

and

```ts
  if (!Array.isArray(rawTurns)) throw new ShowScriptError('Response has no "turns" array');
```
→
```ts
  if (!Array.isArray(rawTurns)) throw new ShowScriptError('Response has no "turns" array');
  if (format === 'calm') return parseCalmParagraphs(rawTurns, source);
```

Also extend its doc comment (above it) with one line: ` * @param format 'calm' reads the calm single voice's paragraphs (parseCalmParagraphs); the show is the default.`

5. After `parseShowScript`'s closing brace, add:

```ts

/** The calm voice's paragraphs, cleaned: one presenter (A), no tag of any kind, 2-12 left with words. */
function parseCalmParagraphs(rawTurns: unknown[], source: string): ShowScript {
  if (rawTurns.length < MIN_CALM_PARAGRAPHS || rawTurns.length > MAX_CALM_PARAGRAPHS) {
    throw new ShowScriptError(`Expected ${MIN_CALM_PARAGRAPHS}-${MAX_CALM_PARAGRAPHS} paragraphs, got ${rawTurns.length}`);
  }
  const warnings: string[] = [];
  const turns: ShowTurn[] = [];
  rawTurns.forEach((value, i) => {
    const n = i + 1;
    const t = (value ?? {}) as { host?: unknown; text?: unknown };
    // One presenter: a paragraph may name host A or no host, never anyone else. A mood is ignored.
    if (t.host !== undefined && t.host !== 'A') throw new ShowScriptError(`Paragraph ${n}: one presenter only, host must be "A" or absent`);
    if (typeof t.text !== 'string') throw new ShowScriptError(`Paragraph ${n}: text must be a string`);
    const text = cleanText(t.text, n, warnings, source, false);
    if (!/\p{L}/u.test(text)) {
      warnings.push(`Paragraph ${n}: dropped, no words to speak (${JSON.stringify(t.text)})`);
      return;
    }
    if (text.length > MAX_TURN_CHARS) throw new ShowScriptError(`Paragraph ${n}: ${text.length} characters, limit ${MAX_TURN_CHARS}`);
    if (/\d/.test(text)) warnings.push(`Paragraph ${n}: contains digits (numbers should be words)`);
    // Host and mood are unused by calm; they keep the ShowTurn shape the rest of the pipeline reads.
    turns.push({ host: 'A', mood: 'warm', text });
  });
  if (turns.length < MIN_CALM_PARAGRAPHS) {
    throw new ShowScriptError(`Only ${turns.length} paragraphs left after dropping ones with no words; need ${MIN_CALM_PARAGRAPHS}`);
  }
  return { turns, warnings };
}
```

6. In `cleanText`, change the signature

```ts
function cleanText(input: string, n: number, warnings: string[], source: string): string {
```
→
```ts
function cleanText(input: string, n: number, warnings: string[], source: string, keepSounds = true): string {
```

change the sound keep line inside the `ANY_TAG` replace

```ts
    if (!slash && SOUNDS.has(tag)) return ` <${tag}> `;
```
→
```ts
    if (keepSounds && !slash && SOUNDS.has(tag)) return ` <${tag}> `;
```

and the last guard

```ts
  // Last guard: only exact sound tags may carry angle brackets.
  text = text.replace(KEPT_SOUND_OR_BRACKET, m => {
```
→
```ts
  // Last guard: only exact sound tags may carry angle brackets (and none at all without sounds).
  text = text.replace(keepSounds ? KEPT_SOUND_OR_BRACKET : /[<>]/g, m => {
```

Extend `cleanText`'s doc comment with: ` * keepSounds false (calm): every tag goes, the whitelisted sounds too.`

7. Replace `toShowLines`:

```ts
/** Turns as TTS lines: mood becomes its style string; Hebrew words get their niqqud. */
export function toShowLines(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female'): ShowLine[] {
  return turns.map(turn => ({
```
→
```ts
/**
 * Turns as TTS lines: mood becomes its style string; Hebrew words get their niqqud. Calm: one voice (A) and
 * CALM_STYLE on every line, the same pointing.
 */
export function toShowLines(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female', format: ShowFormat = 'show'): ShowLine[] {
  if (format === 'calm') {
    return turns.map(turn => ({ host: 'A', text: speakable(turn.text, language, listenerGender), style: CALM_STYLE }));
  }
  return turns.map(turn => ({
```

(the rest of the function stays as it is).

- [ ] **Step 4: Run the tests**

Run: **SMOKE `voice-calm`** → all pass (G1, G2, D1, D2, C1-C7, L1, L2).
Run: **SMOKE `voice-show-script`**, **SMOKE `voice-show-writer`**, **SMOKE `voice-show-produce`** → all pass.
Run: `npx tsc --noEmit -p .` and `npx eslint src/services/voice-show/script.ts scripts/smoke-voice-calm.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/voice-show/script.ts scripts/smoke-voice-calm.ts
git commit -m "feat(voice): calm paragraphs: their schema, a parser that keeps one presenter and strips every tag, and calm lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 4: The calm voice: CALM_VOICES, the cast in generateShowVoice, the caption

**Files:**
- Modify: `src/services/voice-generator.ts`
- Modify: `src/utils/ai-footer.ts:24-43`
- Test: `scripts/smoke-voice-calm.ts` (V1-V5); existing `smoke-voice-generator`, `smoke-voice-show-produce`, `smoke-dialogue-tts`, `smoke-tts` must pass

**Interfaces:**
- Consumes: `ShowFormat`, `CALM_STYLE` (Task 2); calm `ShowLine`s (Task 3).
- Produces (in `src/services/voice-generator.ts`):
  - `export interface CalmVoice { voice: string; gender: 'male' | 'female' }`
  - `export const CALM_VOICES: Readonly<Record<string, CalmVoice>>`
  - `export function getCalmVoice(language: string): CalmVoice | null`
  - `export interface ShowCast { A: string; B?: string }`
  - `export async function generateShowVoice(lines: ShowLine[], language: string, deps: ShowVoiceDeps = {}, format: ShowFormat = 'show'): Promise<ShowVoiceResult>`
  - `ShowVoiceResult.voices: ShowCast`, `ShowVoiceResult.format: ShowFormat`
- Produces: `formatShowCaption(writer, attempts, show: Pick<ShowVoiceResult, ...> & { format?: ShowFormat }, isAdmin)` prints `calm A:<voice>` for calm.

- [ ] **Step 1: Write the failing tests**

Above the marker in `scripts/smoke-voice-calm.ts`:

```ts
  await check('V1 CALM_VOICES: one built-in voice for he, en and ru, male (the owner\'s choice), never one of the show\'s hosts, nothing elsewhere', async () => {
    const { CALM_VOICES, getCalmVoice, getShowVoices } = await import('../src/services/voice-generator');
    for (const locale of LOCALES) {
      const calm = getCalmVoice(locale);
      assert(calm && /^[A-Z][a-z]+$/.test(calm.voice) && calm.gender === 'male', `${locale}: ${show(calm)}`);
      assert(calm === CALM_VOICES[locale], `${locale}: getCalmVoice reads CALM_VOICES`);
      const hosts = getShowVoices(locale)!;
      assert(calm.voice !== hosts.A && calm.voice !== hosts.B, `${locale}: ${calm.voice} is a show host`);
    }
    assert(getCalmVoice('fr') === null && getCalmVoice('__proto__') === null && getCalmVoice('constructor') === null, 'other keys');
  });

  await check('V2 a calm note is made line by line on the calm voice with CALM_STYLE, mixed into one OGG; the result names the calm cast and format', async () => {
    const { generateShowVoice, getCalmVoice } = await import('../src/services/voice-generator');
    const { CALM_STYLE } = await import('../src/services/voice-show/types');
    const calls: SynthesizeSpeechInput[] = [];
    const lines = ['בוקר טוב.', 'בעשר פגישה.', 'יום טוב.'].map((text) => ({ host: 'A' as const, text, style: CALM_STYLE }));
    const result = await quiet(() => generateShowVoice(lines, 'he', {
      synthesize: async (input) => { calls.push(input); return { pcm: tone(400), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 9 }; },
    }, 'calm'));
    try {
      const voice = getCalmVoice('he')!.voice;
      assert(calls.length === 3 && calls.every((c) => c.voiceName === voice && c.style === CALM_STYLE), show(calls.map((c) => [c.voiceName, c.style])));
      assert(show(calls.map((c) => c.text).sort()) === show(lines.map((l) => l.text).sort()), 'texts');
      assert(show(result.voices) === show({ A: voice }) && result.format === 'calm' && result.lineCount === 3 && result.audioTokens === 27, show(result));
      assert((await fsp.readFile(result.filePath)).subarray(0, 4).toString('ascii') === 'OggS', 'not Ogg');
    } finally {
      await fsp.unlink(result.filePath).catch(() => {});
    }
  });

  await check('V3 calm refuses a host B line and a language with no calm voice; the show still refuses a language with no hosts', async () => {
    const { generateShowVoice } = await import('../src/services/voice-generator');
    const synth = async () => ({ pcm: tone(200), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 1 });
    const fails = async (fn: () => Promise<unknown>, what: RegExp) => {
      try { await quiet(fn as () => Promise<unknown>); } catch (e) { return what.test(String(e)); }
      return false;
    };
    assert(await fails(() => generateShowVoice([{ host: 'B', text: 'x' }], 'he', { synthesize: synth }, 'calm'), /No voice for host B/), 'host B');
    assert(await fails(() => generateShowVoice([{ host: 'A', text: 'x' }], 'fr', { synthesize: synth }, 'calm'), /No calm voice/), 'fr calm');
    assert(await fails(() => generateShowVoice([{ host: 'A', text: 'x' }], 'fr', { synthesize: synth }), /No show hosts/), 'fr show');
  });

  await check('V4 calm paragraphs are 400 ms apart, the show\'s lines 200 ms: the same three lines run 0.4 s longer as calm', async () => {
    const { generateShowVoice } = await import('../src/services/voice-generator');
    const synth = async () => ({ pcm: Buffer.concat([Buffer.alloc(4800), tone(500), Buffer.alloc(4800)]), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 1 });
    const lines = ['one', 'two', 'three'].map((text) => ({ host: 'A' as const, text }));
    const asShow = await quiet(() => generateShowVoice(lines, 'en', { synthesize: synth }));
    const asCalm = await quiet(() => generateShowVoice(lines, 'en', { synthesize: synth }, 'calm'));
    await Promise.all([asShow, asCalm].map((r) => fsp.unlink(r.filePath).catch(() => {})));
    const extra = asCalm.audioSeconds - asShow.audioSeconds;
    assert(Math.abs(extra - 0.4) < 0.02, `calm ran ${extra.toFixed(3)} s longer (want 0.4)`);
    assert(asShow.format === 'show' && show(Object.keys(asShow.voices)) === show(['A', 'B']), show(asShow.voices));
  });

  await check('V5 the admin caption: calm says "calm A:<voice>" with no B; the show\'s caption is unchanged, with or without a format', async () => {
    const { formatShowCaption } = await import('../src/utils/ai-footer');
    const writer: AICompletionResult = { text: '', usage: { inputTokens: 1200, outputTokens: 300 }, stopReason: 'STOP', model: 'Gemini 3.8 Flash', durationMs: 4200 };
    const base = { ttsMs: 6100, ttsModel: 'gemini-3.8-flash-tts', lineCount: 5, audioSeconds: 50.2, audioTokens: 1500 };
    const calm = formatShowCaption(writer, 1, { ...base, voices: { A: 'VoiceX' }, format: 'calm' }, true)!;
    assert(calm.includes('| calm A:VoiceX |') && !calm.includes(' B:') && calm.includes('5 lines') && calm.includes('~$0.0135'), calm);
    const asShow = formatShowCaption(writer, 1, { ...base, voices: { A: 'a1', B: 'b2' } }, true)!;
    assert(asShow.includes('| A:a1 B:b2 |') && !asShow.includes('calm'), asShow);
    assert(formatShowCaption(writer, 1, { ...base, voices: { A: 'a1', B: 'b2' }, format: 'show' }, true) === asShow, 'format show');
    assert(formatShowCaption(writer, 1, { ...base, voices: { A: 'VoiceX' }, format: 'calm' }, false) === undefined, 'non-admin');
  });
```

- [ ] **Step 2: Run to see them fail**

Run: **SMOKE `voice-calm`** → V1-V5 FAIL (`getCalmVoice` not exported; no 4th argument; caption prints `B:undefined`).

- [ ] **Step 3: Implement the voice table and the cast**

In `src/services/voice-generator.ts`:

1. Header comment: after the line ` *   voice note. See docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md.` add:
```ts
 *   The calm single voice (format 'calm', docs/superpowers/specs/2026-11-07-calm-voice-design.md) goes the same
 *   way with a cast of one: CALM_VOICES, CALM_STYLE on every paragraph, a longer gap between them.
```

2. Replace `import type { ShowLine } from './voice-show/types';` with `import type { ShowFormat, ShowLine } from './voice-show/types';`

3. After `getShowVoices` (its closing brace), add:

```ts

/** The calm single voice for a language: one Gemini built-in voice, and its gender (how the presenter speaks of themself). */
export interface CalmVoice {
  voice: string;
  gender: 'male' | 'female';
}

// Built-in voices only. Male in every language (the owner, 2026-11-07). PROVISIONAL until the owner's blind round
// (spec §4: Umbriel, Achird, Iapetus, Charon, each heard with CALM_STYLE); the pick replaces the names here, and
// nothing else names a calm voice. Never Schedar or Puck: the show's hosts would make calm sound like the show.
export const CALM_VOICES: Readonly<Record<string, CalmVoice>> = {
  he: { voice: 'Charon', gender: 'male' },
  en: { voice: 'Charon', gender: 'male' },
  ru: { voice: 'Charon', gender: 'male' },
};

/** The calm voice for a language, or null when it has none. */
export function getCalmVoice(language: string): CalmVoice | null {
  return Object.hasOwn(CALM_VOICES, language) ? CALM_VOICES[language] : null;
}

/** Who speaks a voice note: the show's two hosts, or calm's one presenter (A only). */
export interface ShowCast {
  A: string;
  B?: string;
}

/** Silence between calm paragraphs; the show keeps the mixer's default 200 ms. Tuned in the listening round. */
const CALM_GAP_MS = 400;

function voiceFor(cast: ShowCast, host: ShowLine['host']): string {
  const voice = cast[host];
  if (!voice) throw new Error(`[TTS] No voice for host ${host} in this cast`);
  return voice;
}
```

4. In `ShowVoiceResult`, replace `  voices: ShowVoices;` with:
```ts
  voices: ShowCast;
  /** Which voice note this was: the show or the calm single voice. */
  format: ShowFormat;
```

5. Replace the whole `generateShowVoice` function and the `generateShowLocal` signature, synthesize-lines line, mix call and result:

```ts
/**
 * Generate the two-host show, or the calm single voice, from validated lines.
 * @param lines - From voice-show/script toShowLines(): host, text, style, whisper
 * @param language - Must have hosts (getShowVoices), or for calm a calm voice (getCalmVoice)
 * @param format - 'calm' speaks every line in the language's calm voice; the show is the default
 * @returns Path to the OGG OPUS file in /tmp, with metrics for the admin caption
 */
export async function generateShowVoice(
  lines: ShowLine[],
  language: string,
  deps: ShowVoiceDeps = {},
  format: ShowFormat = 'show',
): Promise<ShowVoiceResult> {
  let voices: ShowCast | null;
  if (format === 'calm') {
    const calm = getCalmVoice(language);
    if (!calm) throw new Error(`[TTS] No calm voice for language "${language}"`);
    voices = { A: calm.voice };
  } else {
    voices = getShowVoices(language);
    if (!voices) throw new Error(`[TTS] No show hosts for language "${language}"`);
  }
  if (!lines.length) throw new Error('[TTS] Show has no lines');

  const cast = voices;
  const model = TTS_MODEL;
  const queuedAt = Date.now();

  return withShowSlot(async () => {
    const deadline = Date.now() + (deps.deadlineMs ?? SHOW_DEADLINE_MS);
    console.log('[TTS] Show got a slot:', { waitedMs: Date.now() - queuedAt, lines: lines.length, format });
    // Only the time left: synthesizeDialogue fails fast when too little remains.
    return generateShowLocal(lines, cast, model, deps, deadline, format);
  });
}

async function generateShowLocal(
  lines: ShowLine[],
  voices: ShowCast,
  model: string,
  deps: ShowVoiceDeps,
  deadline: number,
  format: ShowFormat,
): Promise<ShowVoiceResult> {
```

Inside `generateShowLocal` change:

```ts
    lines: lines.map(line => ({ voice: voices[line.host], text: line.text, style: line.style })),
```
→
```ts
    lines: lines.map(line => ({ voice: voiceFor(voices, line.host), text: line.text, style: line.style })),
```

```ts
  const pcm = mixDialogue(
    audio.pcms.map((p, i) => ({ pcm: p, speaker: lines[i].host, keepDynamics: lines[i].whisper })),
    { sampleRate: SAMPLE_RATE },
  );
```
→
```ts
  const pcm = mixDialogue(
    audio.pcms.map((p, i) => ({ pcm: p, speaker: lines[i].host, keepDynamics: lines[i].whisper })),
    format === 'calm' ? { sampleRate: SAMPLE_RATE, gapMs: CALM_GAP_MS } : { sampleRate: SAMPLE_RATE },
  );
```

and in the `result` object, after `    voices,` add `    format,`.

Note: `voiceFor` throws inside `synthesizeDialogue`'s argument building, before any request, so a host B line in calm sends nothing.

- [ ] **Step 4: The caption**

In `src/utils/ai-footer.ts`:
- After `import type { ShowVoiceResult } from '../services/voice-generator';` add `import type { ShowFormat } from '../services/voice-show/types';`
- Replace

```ts
/** Admin caption for the two-host show: the writer's metrics, then the TTS side. */
export function formatShowCaption(
  writer: AICompletionResult,
  writerAttempts: number,
  show: Pick<ShowVoiceResult, 'ttsMs' | 'ttsModel' | 'voices' | 'lineCount' | 'audioSeconds' | 'audioTokens'>,
  isAdmin: boolean,
): string | undefined {
```
with
```ts
/** Admin caption for the two-host show or the calm single voice: the writer's metrics, then the TTS side. */
export function formatShowCaption(
  writer: AICompletionResult,
  writerAttempts: number,
  show: Pick<ShowVoiceResult, 'ttsMs' | 'ttsModel' | 'voices' | 'lineCount' | 'audioSeconds' | 'audioTokens'> & { format?: ShowFormat },
  isAdmin: boolean,
): string | undefined {
```
- Replace `    \`A:${show.voices.A} B:${show.voices.B}\`,` with
```ts
    show.format === 'calm' ? `calm A:${show.voices.A}` : `A:${show.voices.A} B:${show.voices.B}`,
```

- [ ] **Step 5: Run the tests**

Run: **SMOKE `voice-calm`** → all pass, G2 included.
Run: **SMOKE `voice-generator`**, **SMOKE `voice-show-produce`**, **SMOKE `dialogue-tts`**, **SMOKE `tts`** → all pass.
Run: `npx tsc --noEmit -p .` and `npx eslint src/services/voice-generator.ts src/utils/ai-footer.ts scripts/smoke-voice-calm.ts` → clean. (`scripts/eval-voice-show.ts` still compiles: it calls `generateShowVoice(lines, language)`.)

- [ ] **Step 6: Commit**

```bash
git add src/services/voice-generator.ts src/utils/ai-footer.ts scripts/smoke-voice-calm.ts
git commit -m "feat(voice): the calm voice per language, a one-voice cast with a longer gap, and its admin caption

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 5: The calm prompts (he, en, ru) on the show's shared rules

**Files:**
- Modify: `src/prompts/voice-show/types.ts`, `src/prompts/voice-show/index.ts`
- Modify: `src/prompts/voice-show/he.ts`, `en.ts`, `ru.ts` (refactor; show bytes unchanged)
- Create: `src/prompts/voice-show/calm-he.ts`, `calm-en.ts`, `calm-ru.ts`
- Test: `scripts/smoke-voice-calm.ts` (P1-P7); G1 must stay green; `smoke-voice-show-writer`, `smoke-native-reminder-digest` must pass

**Interfaces:**
- Consumes: `ShowFormat` (Task 2).
- Produces in `ShowPromptContext`: `format?: ShowFormat`, `presenterGender?: 'male' | 'female'`.
- Produces in each of `he.ts`, `en.ts`, `ru.ts`: `export interface KindRules`, `export function kindRules(context, format: ShowFormat = 'show'): KindRules`, `export function familyLines(context): string[]`, `export function factRules(context): string[]`, `export function addressRule(context): string`; `he.ts` also `export const POINTING_RULE: string`.
- Produces: `buildCalmPrompt(context)` in each `calm-*.ts`; `hasCalmPrompt(locale)` and `buildShowPrompt` dispatching on `context.format === 'calm'` in `index.ts`.

- [ ] **Step 1: Write the failing tests**

Above the marker in `scripts/smoke-voice-calm.ts`:

```ts
  /** A calm context: the matrix's family, rules and summary, with the presenter's gender. */
  const calmContext = (locale: Locale, over: Partial<ShowPromptContext> = {}): ShowPromptContext => ({
    kind: 'daily', summary: SUMMARY[locale], locale, listener: { name: PEOPLE[locale].male, gender: 'male' },
    spouse: { name: PEOPLE[locale].spouse }, kids: PEOPLE[locale].kids, hasKidsCalendars: true, culture: 'jewish',
    globalRules: [PEOPLE[locale].rule], format: 'calm', presenterGender: 'male', ...over,
  });

  await check('P1 every show language has a calm prompt; format calm builds it, format show or none builds the show', async () => {
    const { hasCalmPrompt, hasShowPrompt } = await import('../src/prompts/voice-show');
    for (const locale of LOCALES) {
      assert(hasShowPrompt(locale) && hasCalmPrompt(locale), `${locale}: no calm prompt`);
      const calm = buildShowPrompt(calmContext(locale));
      const asShow = buildShowPrompt(calmContext(locale, { format: 'show' }));
      const none = buildShowPrompt(calmContext(locale, { format: undefined }));
      assert(calm.includes('{"turns":[{"text":"..."}') && !calm.includes('"host"'), `${locale}: not the calm prompt`);
      assert(asShow === none && asShow.includes('"host":"A"'), `${locale}: format show is not the show`);
    }
    assert(!hasCalmPrompt('fr') && !hasCalmPrompt('__proto__'), 'other keys');
  });

  await check('P2 the calm prompt carries the show\'s facts: every content rule of the kind (calm wording), every facts rule, the family lines, the user\'s rule and the summary, for every kind, with and without ⏰', async () => {
    const prompts = { he: await import('../src/prompts/voice-show/he'), en: await import('../src/prompts/voice-show/en'), ru: await import('../src/prompts/voice-show/ru') };
    for (const locale of LOCALES) {
      for (const k of KINDS) {
        for (const reminders of [false, true]) {
          const context = calmContext(locale, { kind: k.kind, isNextWeek: k.isNextWeek, summary: SUMMARY[locale] + (reminders ? REMINDER[locale] : '') });
          const calm = buildShowPrompt(context);
          const mod = prompts[locale];
          const wanted = [...mod.kindRules(context, 'calm').content, ...mod.factRules(context), ...mod.familyLines(context), PEOPLE[locale].rule, context.summary];
          const missing = wanted.filter((line) => !calm.includes(line));
          assert(missing.length === 0, `${locale} ${k.name} ${reminders}: missing ${show(missing)}`);
          assert(reminders === calm.includes('⏰'), `${locale} ${k.name}: the reminders rule follows ⏰`);
        }
      }
    }
  });

  await check('P3 the calm prompt has no moods, no sound list, no second host and none of the show\'s energy lines', async () => {
    const banned: Record<Locale, string[]> = {
      he: ['"mood"', 'hype', '<chuckle>', '<whispers>', '<throat-clearing>', '"host"', 'וחגגו', 'נלהבים', 'מגיש צעיר'],
      en: ['"mood"', 'hype', '<chuckle>', '<whispers>', '<throat-clearing>', '"host"', 'celebrate', 'excited', 'young host'],
      ru: ['"mood"', 'hype', '<chuckle>', '<whispers>', '<throat-clearing>', '"host"', 'порадуйтесь', 'азартных', 'молодой ведущий'],
    };
    for (const locale of LOCALES) {
      for (const k of KINDS) {
        const calm = buildShowPrompt(calmContext(locale, { kind: k.kind, isNextWeek: k.isNextWeek }));
        const found = banned[locale].filter((word) => calm.includes(word));
        assert(found.length === 0, `${locale} ${k.name}: ${show(found)}`);
      }
    }
  });

  await check('P4 the presenter speaks of themself in the voice table\'s gender (he and ru), and English names the presenter; the listener is addressed in their own gender', async () => {
    const self: Record<Locale, Record<'male' | 'female', string>> = {
      he: { male: 'שמדבר על עצמו בלשון זכר', female: 'שמדברת על עצמה בלשון נקבה' },
      en: { male: 'One presenter, a man', female: 'One presenter, a woman' },
      ru: { male: 'говорит о себе в мужском роде', female: 'говорит о себе в женском роде' },
    };
    for (const locale of LOCALES) {
      for (const presenterGender of ['male', 'female'] as const) {
        const calm = buildShowPrompt(calmContext(locale, { presenterGender, listener: { name: PEOPLE[locale].female, gender: 'female' } }));
        const other = presenterGender === 'male' ? 'female' : 'male';
        assert(calm.includes(self[locale][presenterGender]) && !calm.includes(self[locale][other]), `${locale} ${presenterGender}`);
      }
    }
    const he = buildShowPrompt(calmContext('he', { listener: { name: 'נועה', gender: 'female' } }));
    assert(he.includes('ודברו אליה ישירות בגוף שני') && he.includes('היא אישה'), 'he: a female listener');
    const ru = buildShowPrompt(calmContext('ru', { listener: { name: 'Ноа', gender: 'female' } }));
    assert(ru.includes('ты готова') && ru.includes('в женском роде. Не "у вас", а "у тебя"') && ru.includes('пол неизвестен'), 'ru: "ты", her gender, the unknown-gender spouse');
  });

  await check('P5 the Hebrew calm prompt carries the show\'s pointing rule word for word (מְחַכֶּה/מְחַכָּה by subject, תּוֹרֵךְ, אַתְּ)', async () => {
    const { POINTING_RULE } = await import('../src/prompts/voice-show/he');
    const calm = buildShowPrompt(calmContext('he'));
    const asShow = buildShowPrompt(calmContext('he', { format: 'show' }));
    assert(calm.includes(POINTING_RULE) && asShow.includes(POINTING_RULE), 'the rule is not in both');
    for (const word of ['מְחַכֶּה', 'מְחַכָּה', 'תּוֹרֵךְ', 'אַתְּ']) assert(POINTING_RULE.includes(word), word);
  });

  await check('P6 calm asks for paragraphs: 4 to 8 (the weather 3 to 6) in each language, and says a free day calmly', async () => {
    const counts: Record<Locale, [string, string]> = {
      he: ['בין 4 ל-8 פסקאות', 'בין 3 ל-6 פסקאות'],
      en: ['4 to 8 paragraphs', '3 to 6 paragraphs'],
      ru: ['от 4 до 8 абзацев', 'от 3 до 6 абзацев'],
    };
    const calmly: Record<Locale, string> = { he: 'אמרו ברוגע שהיומן פנוי', en: 'say calmly that the calendar is clear', ru: 'спокойно скажите, что календарь свободен' };
    for (const locale of LOCALES) {
      assert(buildShowPrompt(calmContext(locale)).includes(counts[locale][0]), `${locale}: daily count`);
      assert(buildShowPrompt(calmContext(locale, { kind: 'weather' })).includes(counts[locale][1]), `${locale}: weather count`);
      assert(buildShowPrompt(calmContext(locale)).includes(calmly[locale]), `${locale}: the free day`);
    }
  });

  await check('P7 an empty rules list adds no rules header, as in the show', async () => {
    for (const locale of LOCALES) {
      const calm = buildShowPrompt(calmContext(locale, { globalRules: [] }));
      assert(!calm.includes(PEOPLE[locale].rule) && !/\*\*[^*]*(כללים אישיים|own rules|Личные правила)/.test(calm), `${locale}: a rules header`);
    }
  });
```

- [ ] **Step 2: Run to see them fail**

Run: **SMOKE `voice-calm`** → tsc-level error or P1-P7 FAIL (`format` not on `ShowPromptContext`, `hasCalmPrompt` missing). Run `npx tsc --noEmit -p .` → errors in `smoke-voice-calm.ts` only.

- [ ] **Step 3: The context fields**

In `src/prompts/voice-show/types.ts`:
- Replace `import type { ShowKind } from '../../services/voice-show/types';` with `import type { ShowFormat, ShowKind } from '../../services/voice-show/types';`
- Change the top comment ` * Context for the two-host show writer prompts.` to ` * Context for the voice-note writer prompts: the two-host show and the calm single voice.`
- After `  isNextWeek?: boolean;` add:
```ts
  /** Which voice note: absent or 'show' is the two-host show, 'calm' one presenter (buildShowContext, from User.voiceFormat). */
  format?: ShowFormat;
  /** Calm only: the presenter's gender (CALM_VOICES in voice-generator.ts), which sets how they speak of themself in he and ru. */
  presenterGender?: 'male' | 'female';
```

- [ ] **Step 4: Refactor `he.ts` (show bytes unchanged)**

Move text, never retype it: cut each quoted rule out of the template or the array and paste it into its new place, so the bytes stay identical (G1 checks).

1. `import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS } from '../../services/voice-show/types';` → `import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS, type ShowFormat } from '../../services/voice-show/types';`
2. File comment: after ` * own rules. The show rules add the hosts, personal address, moods and sounds.` add
```ts
 * The calm single voice (./calm-he.ts) reads the same rules from here: kindRules with format 'calm', familyLines,
 * factRules, addressRule and POINTING_RULE, so a fix here reaches both.
```
3. `interface KindRules {` → `export interface KindRules {`, and its `turns` doc → `  /** Turn count asked for in the output line (paragraphs for calm). */`
4. Replace

```ts
function kindRules(context: ShowPromptContext): KindRules {
  const female = context.listener.gender === 'female';
```
with
```ts
/**
 * The kind's own content. Calm (format 'calm') swaps only the show's energy and its turns: a free day is said
 * calmly instead of celebrated, and paragraphs are counted instead of turns. Every other word is the same.
 */
export function kindRules(context: ShowPromptContext, format: ShowFormat = 'show'): KindRules {
  const female = context.listener.gender === 'female';
  const calm = format === 'calm';
  const oneUnit = calm ? 'בפסקה אחת' : 'בתור אחד';
  const turns: [number, number] = calm ? [4, 8] : [6, 20];
```
5. Replace (replace_all: three occurrences) `      turns: [6, 20],` with `      turns,`
6. `        'כל אירוע מהסיכום נכנס, עם היום והשעה שלו. מותר לאחד כמה אירועים של אותו יום בתור אחד.',` → `` `        \`כל אירוע מהסיכום נכנס, עם היום והשעה שלו. מותר לאחד כמה אירועים של אותו יום ${oneUnit}.\`,` ``
7. `        'השבוע: תור או שניים, רק המגמה והשינויים הבולטים. כאן מותר לסכם ולקבץ ימים.',` → `` `        \`השבוע: ${calm ? 'פסקה או שתיים' : 'תור או שניים'}, רק המגמה והשינויים הבולטים. כאן מותר לסכם ולקבץ ימים.\`,` ``
8. `      length: 'כ-35-50 שניות דיבור (בערך 70-95 מילים), 6-10 תורות.',` → `` `      length: \`כ-35-50 שניות דיבור (בערך 70-95 מילים), ${calm ? '3-6 פסקאות' : '6-10 תורות'}.\`,` ``
9. `      turns: [6, 10],` → `      turns: calm ? [3, 6] : [6, 10],`
10. Replace (replace_all: tomorrow and daily) `'כל אירוע מהסיכום נכנס, עם השעה שלו. מותר לאחד כמה אירועים קטנים בתור אחד.',` with `` `כל אירוע מהסיכום נכנס, עם השעה שלו. מותר לאחד כמה אירועים קטנים ${oneUnit}.`, `` (keep the leading spaces).
11. `        'מחר בלי אירועים: אמרו שהיומן של מחר פנוי וחגגו את זה. אל תמציאו אירועים.',` → `        calm ? 'מחר בלי אירועים: אמרו ברוגע שהיומן של מחר פנוי. אל תמציאו אירועים.' : 'מחר בלי אירועים: אמרו שהיומן של מחר פנוי וחגגו את זה. אל תמציאו אירועים.',`
12. `      'יום בלי אירועים: אמרו שהיומן פנוי וחגגו את זה. אל תמציאו אירועים.',` → `      calm ? 'יום בלי אירועים: אמרו ברוגע שהיומן פנוי. אל תמציאו אירועים.' : 'יום בלי אירועים: אמרו שהיומן פנוי וחגגו את זה. אל תמציאו אירועים.',`
13. Right before `export function buildShowPrompt`, add the shared pieces (strings moved from `buildShowPrompt`):

```ts
/** The family block: the listener, the partner and the kids, each with how to speak of them. Shared with ./calm-he.ts. */
export function familyLines(context: ShowPromptContext): string[] {
  const family = [listenerLine(context)];
  if (context.spouse) family.push(personLine('בן או בת הזוג', context.spouse));
  for (const kid of context.kids) family.push(personLine('ילד או ילדה', kid));
  if (!context.kids.length && context.hasKidsCalendars) family.push('יש יומנים של ילדים.');
  return family;
}

/** The facts every voice note keeps, after the kind's own content. Shared with ./calm-he.ts. */
export function factRules(context: ShowPromptContext): string[] {
  return [
    ...(context.summary.includes('⏰') ? [REMINDERS_RULE] : []),
    'כל השעות במילים מלאות, לא בספרות: "תשע בבוקר", "עשר ורבע", "אחת עשרה וחצי", "ארבע וחצי אחר הצהריים".',
    'גם שאר המספרים במילים, למשל טמפרטורות ("עשרים ושמונה מעלות").',
    'ימי הולדת: הוציאו את שם האדם מהאירוע ("יום ההולדת של יוחנן").',
    'שמות מלאים, בלי קיצורים.',
    'שמרו את מה שהסיכום אומר על חצות: אירוע שנמשך "אחרי חצות" נגמר בלילה שאחרי היום הזה, ואירוע ש"התחיל אתמול" לא מתחיל היום.',
  ];
}

/** Second person, by name, in the listener's gender. Shared with ./calm-he.ts. */
export function addressRule(context: ShowPromptContext): string {
  return `פנייה אישית: הזכירו את השם כבר בפתיחה, ודברו ${context.listener.gender === 'female' ? 'אליה' : 'אליו'} ישירות בגוף שני ובלשון הנכונה. לא "יש לכם" — "יש לך".`;
}

/**
 * The writer points the words only their subject genders (the code points the rest: hebrew-pointing.ts). Shared with
 * ./calm-he.ts word for word: it also covers the calm presenter speaking of themself.
 */
export const POINTING_RULE = 'ניקוד: כשמילה נכתבת אותו דבר בזכר ובנקבה, הקריינות מנחשת ולעתים קרובות טועה. נקדו ניקוד מלא כל מילה כזאת, לפי מי שהיא מתארת: פועל בהווה מגזרת ל״ה ("יום מְחַכֶּה", "ישיבה מְחַכָּה", "מה שֶׁמְּחַכֶּה"), סיומת שייכות בגוף שני על שם עצם ("תּוֹרֵךְ" למאזינה, "תּוֹרְךָ" למאזין), והכינוי "אַתְּ". את שאר המילים אל תנקדו.';
```

(For `POINTING_RULE`, cut the text after `- ` of the template's `- ניקוד: ...` line; do not retype the niqqud.)

14. In `buildShowPrompt`: delete `  const toListener = female ? 'אליה' : 'אליו';`; replace the four `family` lines (`const family = [listenerLine(context)];` through `if (!context.kids.length && ...) family.push('יש יומנים של ילדים.');`) with nothing; replace the `allContent` array with

```ts
  const allContent = [
    ...content,
    ...factRules(context),
    'ההתלהבות והבדיחות לא מוסיפות ולא משמיטות עובדות: אין אירועים, שעות, שמות או פרטים שלא מופיעים בסיכום.',
  ];
```

and in the template replace `${family.join('\n')}` with `${familyLines(context).join('\n')}`, the line `- פנייה אישית: ...` with `- ${addressRule(context)}`, and the line `- ניקוד: ...` with `- ${POINTING_RULE}`.

Run **SMOKE `voice-calm`** now: G1 and G2 must pass before going on (the calm checks still fail).

- [ ] **Step 5: Refactor `en.ts` the same way**

1. Import: `import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS, type ShowFormat } from '../../services/voice-show/types';`
2. `interface KindRules {` → `export interface KindRules {`
3. Replace
```ts
function kindRules(context: ShowPromptContext): KindRules {
  if (context.kind === 'weekly') {
```
with
```ts
/** The kind's own content; calm (format 'calm') says a free day calmly and counts paragraphs (see ./he.ts). */
export function kindRules(context: ShowPromptContext, format: ShowFormat = 'show'): KindRules {
  const calm = format === 'calm';
  const oneUnit = calm ? 'one paragraph' : 'one turn';
  const turns: [number, number] = calm ? [4, 8] : [6, 20];
  if (context.kind === 'weekly') {
```
4. replace_all `      turns: [6, 20],` → `      turns,`
5. `        'Every event in the summary goes in, with its day and time. Several events on the same day may share one turn.',` → `` `        \`Every event in the summary goes in, with its day and time. Several events on the same day may share ${oneUnit}.\`,` ``
6. `        'The week: a turn or two, only the trend and the notable changes. Here you may group days.',` → `` `        \`The week: ${calm ? 'a paragraph or two' : 'a turn or two'}, only the trend and the notable changes. Here you may group days.\`,` ``
7. `      length: 'about 35-50 seconds of speech (roughly 85-115 words), 6-10 turns.',` → `` `      length: \`about 35-50 seconds of speech (roughly 85-115 words), ${calm ? '3-6 paragraphs' : '6-10 turns'}.\`,` ``
8. `      turns: [6, 10],` → `      turns: calm ? [3, 6] : [6, 10],`
9. replace_all `'Every event in the summary goes in, with its time. Several small events may share one turn.',` → `` `Every event in the summary goes in, with its time. Several small events may share ${oneUnit}.`, ``
10. `        "Nothing on tomorrow: say tomorrow's calendar is clear and celebrate it. Never invent events.",` → `        calm ? "Nothing on tomorrow: say calmly that tomorrow's calendar is clear. Never invent events." : "Nothing on tomorrow: say tomorrow's calendar is clear and celebrate it. Never invent events.",`
11. `      'A day with no events: say the calendar is clear and celebrate it. Never invent events.',` → `      calm ? 'A day with no events: say calmly that the calendar is clear. Never invent events.' : 'A day with no events: say the calendar is clear and celebrate it. Never invent events.',`
12. Before `export function buildShowPrompt` add:

```ts
/** The family block. Shared with ./calm-en.ts. */
export function familyLines(context: ShowPromptContext): string[] {
  const family = [`The listener: ${sanitizeForPrompt(context.listener.name)}. Address them by name and as "you".`];
  if (context.spouse) family.push(personLine('Spouse or partner', context.spouse));
  for (const kid of context.kids) family.push(personLine('Child', kid));
  if (!context.kids.length && context.hasKidsCalendars) family.push("There are kids' calendars.");
  return family;
}

/** The facts every voice note keeps, after the kind's own content. Shared with ./calm-en.ts. */
export function factRules(context: ShowPromptContext): string[] {
  return [
    ...(context.summary.includes('⏰') ? [REMINDERS_RULE] : []),
    'Every time in full words, never digits, 12-hour, with the part of day whenever the hour alone could be morning or evening: "nine in the morning", "ten fifteen in the morning", "four thirty in the afternoon", "six forty-five in the evening".',
    'Other numbers in words too, e.g. temperatures ("twenty-eight degrees").',
    'Birthdays: take the person\'s name from the event ("it\'s John\'s birthday").',
    'Full names, no abbreviations.',
    'Keep what the summary says about midnight: an event that runs "past midnight" ends in the small hours after this day, and one that "started yesterday" is not starting today.',
  ];
}

/** Second person, by name. Shared with ./calm-en.ts. */
export function addressRule(context: ShowPromptContext): string {
  const listener = sanitizeForPrompt(context.listener.name);
  return `Personal: say ${listener}'s name in the opening and talk to ${listener} directly as "you". Not "you all" or "folks".`;
}
```

13. In `buildShowPrompt`: delete the four `family` lines; `allContent` becomes `[...content, ...factRules(context), 'The hype and the jokes never add or drop facts: no events, times, names or details that are not in the summary.']` (cut the last string from the old array); in the template `${family.join('\n')}` → `${familyLines(context).join('\n')}` and the line `- Personal: say ...` → `- ${addressRule(context)}`. Keep `const listener = sanitizeForPrompt(context.listener.name);` (the next template line uses it).

- [ ] **Step 6: Refactor `ru.ts` the same way**

1. Import: `import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS, type ShowFormat } from '../../services/voice-show/types';`
2. `interface KindRules {` → `export interface KindRules {`
3. Replace
```ts
function kindRules(context: ShowPromptContext): KindRules {
  const listener = context.listener.gender === 'female' ? 'слушательницу' : 'слушателя';
```
with
```ts
/** The kind's own content; calm (format 'calm') says a free day calmly and counts paragraphs (see ./he.ts). */
export function kindRules(context: ShowPromptContext, format: ShowFormat = 'show'): KindRules {
  const listener = context.listener.gender === 'female' ? 'слушательницу' : 'слушателя';
  const calm = format === 'calm';
  const oneUnit = calm ? 'в один абзац' : 'в одну реплику';
  const turns: [number, number] = calm ? [4, 8] : [6, 20];
```
4. replace_all `      turns: [6, 20],` → `      turns,`
5. `        'Каждое событие из сводки попадает в выпуск, с днём и временем. Несколько событий одного дня можно объединить в одну реплику.',` → `` `        \`Каждое событие из сводки попадает в выпуск, с днём и временем. Несколько событий одного дня можно объединить ${oneUnit}.\`,` ``
6. `        'Неделя: одна-две реплики, только тенденция и заметные перемены. Здесь можно обобщать и группировать дни.',` → `` `        \`Неделя: ${calm ? 'один-два абзаца' : 'одна-две реплики'}, только тенденция и заметные перемены. Здесь можно обобщать и группировать дни.\`,` ``
7. `      length: 'около 35-50 секунд речи (примерно 70-95 слов), 6-10 реплик.',` → `` `      length: \`около 35-50 секунд речи (примерно 70-95 слов), ${calm ? '3-6 абзацев' : '6-10 реплик'}.\`,` ``
8. `      turns: [6, 10],` → `      turns: calm ? [3, 6] : [6, 10],`
9. replace_all `'Каждое событие из сводки попадает в выпуск, со временем. Несколько мелких событий можно объединить в одну реплику.',` → `` `Каждое событие из сводки попадает в выпуск, со временем. Несколько мелких событий можно объединить ${oneUnit}.`, ``
10. `        'Завтра без событий: скажите, что календарь на завтра свободен, и порадуйтесь этому. Не придумывайте события.',` → `        calm ? 'Завтра без событий: спокойно скажите, что календарь на завтра свободен. Не придумывайте события.' : 'Завтра без событий: скажите, что календарь на завтра свободен, и порадуйтесь этому. Не придумывайте события.',`
11. `      'День без событий: скажите, что календарь свободен, и порадуйтесь этому. Не придумывайте события.',` → `      calm ? 'День без событий: спокойно скажите, что календарь свободен. Не придумывайте события.' : 'День без событий: скажите, что календарь свободен, и порадуйтесь этому. Не придумывайте события.',`
12. Before `export function buildShowPrompt` add:

```ts
/** The family block. Shared with ./calm-ru.ts. */
export function familyLines(context: ShowPromptContext): string[] {
  const family = [listenerLine(context)];
  if (context.spouse) family.push(personLine('Супруг или супруга', context.spouse));
  for (const kid of context.kids) family.push(personLine('Ребёнок', kid));
  if (!context.kids.length && context.hasKidsCalendars) family.push('Есть календари детей.');
  return family;
}

/** The facts every voice note keeps, after the kind's own content. Shared with ./calm-ru.ts. */
export function factRules(context: ShowPromptContext): string[] {
  return [
    ...(context.summary.includes('⏰') ? [REMINDERS_RULE] : []),
    'Всё время словами, никогда цифрами, по-разговорному в 12-часовом виде с частью суток: "в девять утра", "в десять пятнадцать утра", "в половине пятого дня". Целый час иногда можно подчеркнуть словом "ровно" ("ровно в семь вечера"), но не больше двух раз за выпуск. Не "в девятнадцать ноль-ноль".',
    'Остальные числа тоже словами, например температура ("двадцать восемь градусов").',
    'Дни рождения: возьмите имя человека из события ("день рождения Ивана").',
    'Имена — точно как в сводке: без сокращений и без замены на полную или уменьшительную форму.',
    'Сохраняйте то, что сводка говорит о полуночи: событие "за полночь" заканчивается уже ночью после этого дня, а начавшееся "вчера" не начинается сегодня.',
  ];
}

/** "Ты", by name, in the listener's gender. Shared with ./calm-ru.ts. */
export function addressRule(context: ShowPromptContext): string {
  const female = context.listener.gender === 'female';
  return `Лично: уже в начале обратитесь по имени (${sanitizeForPrompt(context.listener.name)}), а дальше говорите с ${female ? 'ней' : 'ним'} напрямую на "ты", в ${female ? 'женском' : 'мужском'} роде. Не "у вас", а "у тебя".`;
}
```

13. In `buildShowPrompt`: delete `  const name = sanitizeForPrompt(context.listener.name);` and the four `family` lines; `allContent` becomes `[...content, ...factRules(context), 'Азарт и шутки не добавляют и не убирают факты: никаких событий, времени, имён или деталей, которых нет в сводке.']`; in the template `${family.join('\n')}` → `${familyLines(context).join('\n')}` and the line `- Лично: ...` → `- ${addressRule(context)}`. Keep `const female = ...` (the next line uses it).

Run **SMOKE `voice-calm`**: G1 and G2 pass. Run **SMOKE `voice-show-writer`**: passes.

- [ ] **Step 7: The calm prompts**

Create `src/prompts/voice-show/calm-he.ts`:

```ts
/**
 * Hebrew calm prompt: one calm, warm presenter reads what the two-host show covers (spec
 * docs/superpowers/specs/2026-11-07-calm-voice-design.md). The kind's content, the family lines, the facts rules,
 * the personal address and the pointing rule are the show's own (./he.ts), so a fix there reaches both; only the
 * energy lines and the shape (paragraphs, one voice, no sounds) are calm's.
 */

import { buildRulesSection } from '../voice-condenser/template';
import { addressRule, factRules, familyLines, kindRules, POINTING_RULE } from './he';
import type { ShowPromptContext } from './types';

export function buildCalmPrompt(context: ShowPromptContext): string {
  const woman = context.presenterGender === 'female';
  const listener = context.listener.gender === 'female' ? 'המאזינה' : 'המאזין';
  const { goal, content, length, turns: [minParagraphs, maxParagraphs] } = kindRules(context, 'calm');
  const rules = buildRulesSection(context.globalRules, 'כללים אישיים של המשתמש (יש ליישם):');

  const allContent = [
    ...content,
    ...factRules(context),
    'הטון הרגוע לא מוסיף ולא משמיט עובדות: אין אירועים, שעות, שמות או פרטים שלא מופיעים בסיכום.',
  ];

  return `אתם כותבים טקסט קצר להקראה בעברית על ${goal}: ${woman ? 'מגישת רדיו אחת, רגועה וחמה, שמקריאה' : 'מגיש רדיו אחד, רגוע וחם, שמקריא'} את הסיכום.

**המשפחה:**
${familyLines(context).join('\n')}
${rules}
**${woman ? 'המגישה' : 'המגיש'}:**
- ${woman ? 'מגישה אחת, אישה, שמדברת על עצמה בלשון נקבה. אין לה שם, ואל תמציאו לה.' : 'מגיש אחד, גבר, שמדבר על עצמו בלשון זכר. אין לו שם, ואל תמציאו לו.'}
- קול אחד בלבד: בלי דיאלוג, בלי מגיש נוסף, ובלי פנייה למישהו מלבד ${listener}.

**תוכן (חובה):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**סגנון:**
- רגוע, חם ונינוח, בקצב אחיד של רדיו בבוקר שקט. בלי התלהבות, בלי קריאות כמו "יאללה" או "איזה יום!", בלי בדיחות ובלי דימויים מעולם הספורט.
- ${addressRule(context)}
- ${POINTING_RULE}
- פסקאות: בכל פסקה משפט אחד עד שלושה, על נושא אחד (הפתיחה והתאריך, מזג האוויר, האירועים, המבט לשבוע, הסגירה).
- אורך: ${length}
- פתיחה קצרה, וסגירה קצרה ושקטה.

**בלי צלילים ובלי תגיות:**
- בלי צלילים כמו <laugh> או <sigh>, ובלי שום תגית אחרת: אין HTML, אין אימוג'י, אין markdown.
- בלי הוראות במה במילים, כמו (מחייך) או *בשקט*.
- אל תכתבו "A:" או "B:" בתוך הטקסט.

**פלט:** JSON בלבד, בין ${minParagraphs} ל-${maxParagraphs} פסקאות:
{"turns":[{"text":"..."},{"text":"..."}]}

**הסיכום המקורי (עם עיצוב — התעלמו מהעיצוב):**
${context.summary}`;
}
```

Create `src/prompts/voice-show/calm-en.ts`:

```ts
/**
 * English calm prompt: one calm, warm presenter reads what the two-host show covers (spec
 * docs/superpowers/specs/2026-11-07-calm-voice-design.md). The kind's content, the family lines, the facts rules and
 * the personal address are the show's own (./en.ts); only the energy lines and the shape are calm's.
 */

import { sanitizeForPrompt } from '../shared-builders';
import { buildRulesSection } from '../voice-condenser/template';
import { addressRule, factRules, familyLines, kindRules } from './en';
import type { ShowPromptContext } from './types';

export function buildCalmPrompt(context: ShowPromptContext): string {
  const { goal, content, length, turns: [minParagraphs, maxParagraphs] } = kindRules(context, 'calm');
  const listener = sanitizeForPrompt(context.listener.name);
  const rules = buildRulesSection(context.globalRules, "The user's own rules (apply these):");

  const allContent = [
    ...content,
    ...factRules(context),
    'The calm tone never adds or drops facts: no events, times, names or details that are not in the summary.',
  ];

  return `You are writing a short English text to be read aloud about ${goal}: one calm, warm radio presenter reading the summary.

**The family:**
${familyLines(context).join('\n')}
${rules}
**The presenter:**
- One presenter, ${context.presenterGender === 'female' ? 'a woman' : 'a man'}, with no name; don't invent one.
- One voice only: no dialogue, no second host, and no one is addressed but ${listener}.

**Content (required):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**Style:**
- Calm, warm and unhurried, at the even pace of quiet morning radio. No excitement, no exclamations like "Let's go!" or "What a day!", no jokes and no sports images.
- Talk naturally, with contractions ("it's", "here's", "you've got").
- ${addressRule(context)}
- Paragraphs: one to three sentences each, one topic per paragraph (the opening and the date, the weather, the events, the week ahead, the close).
- Length: ${length}
- A short opening and a short, quiet close.

**No sounds and no tags:**
- No sounds like <laugh> or <sigh>, and no other tags at all: no HTML, no emoji, no markdown, no stage directions like (smiles) or *softly*.
- Don't write "A:" or "B:" inside the text.

**Output:** JSON only, ${minParagraphs} to ${maxParagraphs} paragraphs:
{"turns":[{"text":"..."},{"text":"..."}]}

**The original summary (with formatting — ignore the formatting):**
${context.summary}`;
}
```

Create `src/prompts/voice-show/calm-ru.ts`:

```ts
/**
 * Russian calm prompt: one calm, warm presenter reads what the two-host show covers (spec
 * docs/superpowers/specs/2026-11-07-calm-voice-design.md). The kind's content, the family lines (with "ты" and the
 * unknown-gender rule), the facts rules and the personal address are the show's own (./ru.ts); only the energy
 * lines and the shape are calm's. The presenter's gender sets how they speak of themself.
 */

import { buildRulesSection } from '../voice-condenser/template';
import { addressRule, factRules, familyLines, kindRules } from './ru';
import type { ShowPromptContext } from './types';

export function buildCalmPrompt(context: ShowPromptContext): string {
  const woman = context.presenterGender === 'female';
  const listener = context.listener.gender === 'female' ? 'слушательницы' : 'слушателя';
  const { goal, content, length, turns: [minParagraphs, maxParagraphs] } = kindRules(context, 'calm');
  const rules = buildRulesSection(context.globalRules, 'Личные правила пользователя (применить):');

  const allContent = [
    ...content,
    ...factRules(context),
    'Спокойный тон не добавляет и не убирает факты: никаких событий, времени, имён или деталей, которых нет в сводке.',
  ];

  return `Вы пишете короткий текст для чтения вслух на русском. Тема: ${goal}. Читает ${woman ? 'одна ведущая' : 'один ведущий'} спокойной радиопрограммы, тепло и неторопливо.

**Семья:**
${familyLines(context).join('\n')}
${rules}
**${woman ? 'Ведущая' : 'Ведущий'}:**
- ${woman ? 'Одна ведущая, женщина, говорит о себе в женском роде. Имени у неё нет, не придумывайте.' : 'Один ведущий, мужчина, говорит о себе в мужском роде. Имени у него нет, не придумывайте.'}
- Голос один: без диалога, без второго ведущего и без обращений к кому-либо, кроме ${listener}.

**Содержание (обязательно):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**Стиль:**
- Спокойно, тепло и неторопливо, в ровном темпе утреннего радио. Без азарта, без восклицаний вроде "Поехали!" или "Вот это день!", без шуток и без спортивных образов.
- ${addressRule(context)}
- Абзацы: в каждом от одного до трёх предложений на одну тему (начало и дата, погода, события, взгляд на неделю, финал).
- Длина: ${length}
- Короткое начало и короткий спокойный финал.

**Без звуков и без тегов:**
- Никаких звуков вроде <laugh> или <sigh> и никаких других тегов: ни HTML, ни эмодзи, ни markdown, ни ремарок вроде (улыбается) или *тихо*.
- Не пишите "A:" или "B:" внутри текста.

**Вывод:** только JSON, от ${minParagraphs} до ${maxParagraphs} абзацев:
{"turns":[{"text":"..."},{"text":"..."}]}

**Исходная сводка (с форматированием — игнорируйте форматирование):**
${context.summary}`;
}
```

- [ ] **Step 8: Dispatch by format**

Replace `src/prompts/voice-show/index.ts` with:

```ts
/**
 * Voice-note writer prompts, per language: the two-host show, and the calm single voice (format 'calm'). A language
 * gets the show only when it has a prompt here and host voices in voice-generator's table; calm has a prompt in
 * every show language.
 */

import { buildCalmPrompt as buildEnglishCalmPrompt } from './calm-en';
import { buildCalmPrompt as buildHebrewCalmPrompt } from './calm-he';
import { buildCalmPrompt as buildRussianCalmPrompt } from './calm-ru';
import { buildShowPrompt as buildEnglishShowPrompt } from './en';
import { buildShowPrompt as buildHebrewShowPrompt } from './he';
import { buildShowPrompt as buildRussianShowPrompt } from './ru';
import type { ShowPromptContext } from './types';

export type { ShowPromptContext, ShowPerson } from './types';

const builders: Record<string, (context: ShowPromptContext) => string> = {
  en: buildEnglishShowPrompt,
  he: buildHebrewShowPrompt,
  ru: buildRussianShowPrompt,
};

const calmBuilders: Record<string, (context: ShowPromptContext) => string> = {
  en: buildEnglishCalmPrompt,
  he: buildHebrewCalmPrompt,
  ru: buildRussianCalmPrompt,
};

export function hasShowPrompt(locale: string): boolean {
  return Object.hasOwn(builders, locale);
}

export function hasCalmPrompt(locale: string): boolean {
  return Object.hasOwn(calmBuilders, locale);
}

/** The writer's prompt: calm's for format 'calm', else the show's. */
export function buildShowPrompt(context: ShowPromptContext): string {
  if (!hasShowPrompt(context.locale)) throw new Error(`No show prompt for locale "${context.locale}"`);
  if (context.format === 'calm') {
    if (!hasCalmPrompt(context.locale)) throw new Error(`No calm prompt for locale "${context.locale}"`);
    return calmBuilders[context.locale](context);
  }
  return builders[context.locale](context);
}
```

- [ ] **Step 9: Run the tests**

Run: **SMOKE `voice-calm`** → all pass (G1, G2 and P1-P7 included).
Run: **SMOKE `voice-show-writer`**, **SMOKE `native-reminder-digest`** (TZ=Asia/Jerusalem), **SMOKE `voice-show-produce`** → pass.
Run: `npx tsc --noEmit -p .` and `npx eslint src/prompts/voice-show scripts/smoke-voice-calm.ts` → clean (no unused variables left in `he.ts`, `en.ts`, `ru.ts`).

- [ ] **Step 10: Commit**

```bash
git add src/prompts/voice-show scripts/smoke-voice-calm.ts
git commit -m "feat(voice): calm prompts in Hebrew, English and Russian on the show's shared facts rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 6: Route the format through the pipeline; docs

**Files:**
- Modify: `src/services/voice-show/context.ts`, `src/services/voice-show/writer.ts`, `src/services/voice-show/produce.ts`
- Modify: `src/services/telegram/voice.ts:1-8` (comment only)
- Modify: `README.md:28`, `CLAUDE.md` (one new bullet)
- Test: `scripts/smoke-voice-calm.ts` (R1-R3), `scripts/smoke-voice-limits.ts` (one check)

**Interfaces:**
- Consumes: `voiceFormatOf` (Task 2), `CALM_RESPONSE_SCHEMA`, `parseShowScript(..., format)`, `toShowLines(..., format)` (Task 3), `getCalmVoice`, `generateShowVoice(..., format)` (Task 4), `ShowPromptContext.format/presenterGender`, calm `buildShowPrompt` (Task 5).
- Produces: `buildShowContext` sets `format: voiceFormatOf(user)` and, for calm, `presenterGender: getCalmVoice(locale)?.gender ?? 'male'`. `writeShowScript` picks schema and parser by `context.format`. `produceShowVoice` passes the format to the lines and the TTS. `src/services/telegram/voice.ts` code is unchanged.

- [ ] **Step 1: Write the failing tests**

Above the marker in `scripts/smoke-voice-calm.ts`:

```ts
  await check('R1 the context: a user with no voiceFormat, "show" or an unknown one gets the show; "calm" gets calm with the presenter\'s gender from CALM_VOICES', async () => {
    const { buildShowContext } = await import('../src/services/voice-show/context');
    const { getCalmVoice } = await import('../src/services/voice-generator');
    for (const voiceFormat of [undefined, 'show', '', 'loud', 'Calm']) {
      const context = buildShowContext('s', { id: 1, name: 'Dana', gender: 'female', language: 'he', voiceFormat } as unknown as UserConfig, 'daily', false, []);
      assert(context.format === 'show' && context.presenterGender === undefined, `${show(voiceFormat)}: ${show(context)}`);
    }
    for (const locale of LOCALES) {
      const context = buildShowContext('s', { id: 1, name: 'Dana', gender: 'female', language: locale, voiceFormat: 'calm' } as unknown as UserConfig, 'weekly', true, []);
      assert(context.format === 'calm' && context.presenterGender === getCalmVoice(locale)!.gender && context.isNextWeek === true, `${locale}: ${show(context)}`);
    }
  });

  await check('R2 the calm writer asks with the calm schema; a show-shaped answer (host B) is refused and regenerated once with the reason; a second one reaches the caller', async () => {
    const { writeShowScript } = await import('../src/services/voice-show/writer');
    const { CALM_RESPONSE_SCHEMA, ShowScriptError } = await import('../src/services/voice-show/script');
    const context = calmContext('he');
    const showShaped = show({ turns: [{ host: 'A', mood: 'hype', text: 'בוקר טוב!' }, { host: 'B', mood: 'amused', text: 'יאללה!' }] });
    const good = calmJson(['בוקר טוב, דני.', 'בעשר ורבע פגישה.', 'שיהיה יום טוב.']);
    const sent: Array<{ prompt: string; options?: AICompletionOptions }> = [];
    const answers = [showShaped, good];
    const written = await quiet(() => writeShowScript(context, {
      complete: async (prompt, _model, options) => {
        sent.push({ prompt, options });
        return { text: answers.shift()!, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'STOP', model: 'Fake', durationMs: 1 };
      },
    }));
    assert(written.attempts === 2 && written.script.turns.length === 3 && written.script.turns.every((t) => t.host === 'A'), show(written));
    assert(sent.every((s) => show(s.options?.responseJsonSchema) === show(CALM_RESPONSE_SCHEMA)), 'not the calm schema');
    assert(sent[0].prompt === buildShowPrompt(context) && sent[1].prompt.includes('Your previous answer was rejected: Paragraph 2: one presenter only'), sent[1].prompt.slice(-200));
    let error: unknown;
    await quiet(async () => {
      try {
        await writeShowScript(context, { complete: async () => ({ text: showShaped, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'STOP', model: 'Fake', durationMs: 1 }) });
      } catch (e) { error = e; }
    });
    assert(error instanceof ShowScriptError, `a second show-shaped answer: ${String(error)}`);
  });

  await check('R3 a calm user end to end: the calm prompt and schema, every TTS request on the calm voice with CALM_STYLE and the Hebrew pointed for her, one OGG, the admin caption "calm A:<voice>"', async () => {
    const { produceShowVoice } = await import('../src/services/voice-show/produce');
    const { CALM_RESPONSE_SCHEMA } = await import('../src/services/voice-show/script');
    const { getCalmVoice } = await import('../src/services/voice-generator');
    const { CALM_STYLE } = await import('../src/services/voice-show/types');
    const { pointHebrewTimes, pointSecondPerson } = await import('../src/services/voice-show/hebrew-pointing');
    const texts = ['בוקר טוב, נועה. יש לך יום רגוע.', 'בעשר ורבע פגישה עם עורך הדין לוי.', 'שיהיה לך יום טוב.'];
    const user = { id: 8, name: 'נועה', gender: 'female', language: 'he', isAdmin: true, voiceFormat: 'calm', calendarAssignments: [] } as unknown as UserConfig;
    const prompts: Array<{ prompt: string; options?: AICompletionOptions }> = [];
    const calls: SynthesizeSpeechInput[] = [];
    const voice = await quiet(() => produceShowVoice(SUMMARY.he, user, 'daily', false, {
      complete: async (prompt, _model, options) => { prompts.push({ prompt, options }); return { text: calmJson(texts), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'STOP', model: 'Fake', durationMs: 1 }; },
      synthesize: async (input) => { calls.push(input); return { pcm: tone(300), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 10 }; },
    }));
    try {
      const calm = getCalmVoice('he')!;
      assert(prompts.length === 1 && show(prompts[0].options?.responseJsonSchema) === show(CALM_RESPONSE_SCHEMA), 'the schema');
      const self = calm.gender === 'female' ? 'שמדברת על עצמה בלשון נקבה' : 'שמדבר על עצמו בלשון זכר';
      assert(prompts[0].prompt.includes('{"turns":[{"text":"..."}') && prompts[0].prompt.includes(self) && prompts[0].prompt.includes('ודברו אליה'), 'the prompt');
      assert(calls.length === 3 && calls.every((c) => c.voiceName === calm.voice && c.style === CALM_STYLE), show(calls.map((c) => [c.voiceName, c.style])));
      assert(show(calls.map((c) => c.text).sort()) === show(texts.map((t) => pointSecondPerson(pointHebrewTimes(t), 'female')).sort()), show(calls.map((c) => c.text)));
      assert((await fsp.readFile(voice.filePath)).subarray(0, 4).toString('ascii') === 'OggS', 'not Ogg');
      assert(!!voice.caption && voice.caption.includes(`calm A:${calm.voice}`) && voice.caption.includes('3 lines') && !voice.caption.includes(' B:'), `caption ${voice.caption}`);
    } finally {
      await fsp.unlink(voice.filePath).catch(() => {});
    }
  });
```

In `scripts/smoke-voice-limits.ts`:
- After `const cleaned: string[] = [];` add `const producedFor: string[] = [];`
- In the `produceShowVoice` stub, replace `    produceShowVoice: async (_s: string, _u: unknown, kind: string) => {\n      produced.push(kind);` with
```ts
    produceShowVoice: async (_s: string, u: unknown, kind: string) => {
      produced.push(kind);
      producedFor.push(String((u as { voiceFormat?: string }).voiceFormat ?? 'none'));
```
- In `reset()`, change the list `[captured, featureChecks, usage, produced, voicesSent, rows, cleaned]` to `[captured, featureChecks, usage, produced, voicesSent, rows, cleaned, producedFor]`.
- After the last check (`the daily voice still counts once ...`), add:

```ts
  await check('a calm voice is a voice summary like the show: the daily (Telegram and WhatsApp) and the weekly each go through the one producer with the calm user, are sent and count once', async () => {
    reset();
    const calmUser = { ...user, voiceFormat: 'calm' } as unknown as UserConfig;
    await quiet(() => sendVoiceMessage(7031, 'the day', calmUser, undefined, false));
    await quiet(() => sendVoiceMessage('972500000031', 'the day', calmUser, undefined, false, MessagingPlatform.WHATSAPP));
    await quiet(() => sendWeeklyVoiceMessage(7031, 'the week', calmUser, false));
    await settle();
    assert(produced.join() === 'daily,daily,weekly' && producedFor.join() === 'calm,calm,calm', `produced ${produced.join()} for ${producedFor.join()}`);
    assert(voicesSent.length === 3 && usage.join() === '31:voiceSummaries,31:voiceSummaries,31:voiceSummaries', `sent ${voicesSent.length} usage ${usage.join()}`);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: **SMOKE `voice-calm`** → R1 FAIL (`format` undefined), R2 FAIL (show schema sent), R3 FAIL (show prompt / hosts' voices).
Run: **SMOKE `voice-limits`** (TZ=Asia/Jerusalem) → the new check passes already (voice.ts passes the user row through; it pins that this stays so). The other checks pass.

- [ ] **Step 3: Implement the context**

In `src/services/voice-show/context.ts`:
- Top comment: replace ` * Builds the show writer's context from the user: who is listening, and the family` / ` * the hosts may mention, with genders where the calendars record them.` with
```ts
 * Builds the writer's context from the user: who is listening, the family the hosts (or the calm presenter) may
 * mention, with genders where the calendars record them, and which voice note the user chose (voiceFormatOf).
```
- Replace `import type { ShowKind } from './types';` with
```ts
import { voiceFormatOf, type ShowKind } from './types';
import { getCalmVoice } from '../voice-generator';
```
- In `buildShowContext`, before `return {` add:
```ts
  const locale = user.language || 'en';
  const format = voiceFormatOf(user);
```
  and in the returned object replace `    locale: user.language || 'en',` with `    locale,`, and after `    isNextWeek: kind === 'weekly' ? isNextWeek : undefined,` add:
```ts
    format,
    // How the calm presenter speaks of themself (he, ru): the gender of the language's calm voice
    ...(format === 'calm' ? { presenterGender: getCalmVoice(locale)?.gender ?? 'male' } : {}),
```

- [ ] **Step 4: Implement the writer**

In `src/services/voice-show/writer.ts`:
- Top comment, after line ` * unavailable" path.` add ` * The calm single voice (context.format 'calm') asks with CALM_RESPONSE_SCHEMA and is parsed as paragraphs.`
- Replace `import { parseShowScript, ShowScriptError, SHOW_RESPONSE_SCHEMA } from './script';` with `import { CALM_RESPONSE_SCHEMA, parseShowScript, ShowScriptError, SHOW_RESPONSE_SCHEMA } from './script';`
- After `  const prompt = buildShowPrompt(context);` add:
```ts
  const format = context.format ?? 'show';
  const responseJsonSchema = format === 'calm' ? CALM_RESPONSE_SCHEMA : SHOW_RESPONSE_SCHEMA;
```
- Replace `    const completion = await complete(request, options.modelId, { responseJsonSchema: SHOW_RESPONSE_SCHEMA });` with `    const completion = await complete(request, options.modelId, { responseJsonSchema });`
- Replace `      return { script: parseShowScript(completion.text, context.summary), completion, attempts: attempt };` with `      return { script: parseShowScript(completion.text, context.summary, format), completion, attempts: attempt };`
- Replace `      console.warn(\`[VoiceShow] Script rejected (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}\`);` with `      console.warn(\`[VoiceShow] ${format} script rejected (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}\`);`

- [ ] **Step 5: Implement produce**

In `src/services/voice-show/produce.ts`:
- Top comment: replace ` * Turns a text summary into the two-host show voice note: writer → validator →` with ` * Turns a text summary into the voice note, the two-host show or the calm single voice (User.voiceFormat, through\n * buildShowContext): writer → validator →`
- Replace the lines from `  console.log(\`[VoiceShow] ${kind} script for user ...` through the `generateShowVoice(...)` call:

```ts
  console.log(`[VoiceShow] ${kind} script for user ${user.id}: ${turns.length} turns from ${summary.length} chars`);

  const show = await generateShowVoice(toShowLines(turns, language, context.listener.gender), language, {
    synthesize: deps.synthesize,
  });
```
with
```ts
  const format = context.format ?? 'show';
  console.log(`[VoiceShow] ${kind} ${format} script for user ${user.id}: ${turns.length} turns from ${summary.length} chars`);

  const show = await generateShowVoice(toShowLines(turns, language, context.listener.gender, format), language, {
    synthesize: deps.synthesize,
  }, format);
```

In `src/services/telegram/voice.ts`, replace the header lines ` * Languages with show hosts (Hebrew, English, Russian) get the two-host show: an LLM` / ` * writes the script and each line is spoken by its host - see ../voice-show/produce.ts.` with
```ts
 * Languages with show hosts (Hebrew, English, Russian) get the two-host show, or the calm single voice when the
 * person chose it in Settings (User.voiceFormat): an LLM writes the script and each line is spoken in its voice -
 * see ../voice-show/produce.ts.
```

- [ ] **Step 6: Docs**

`README.md` line 28: replace `- **Natural voice replies** — optional spoken summaries via Gemini TTS in the user's language, with selectable voices and styles.` with
`- **Natural voice replies** — optional spoken summaries via Gemini TTS in the user's language: a short two-host radio show, or one calm presenter reading the same summary, chosen in Settings.`

`CLAUDE.md` (repo root): add this bullet right after the bullet that starts `- The bot turns what the model said about a zman`:

```md
- A summary voice note is the two-host show or the calm single voice by `User.voiceFormat`, read only through `voiceFormatOf` (`src/services/voice-show/types.ts`: anything but `'calm'` is the show) and made by the one pipeline (`produceShowVoice` → `writeShowScript` → `toShowLines` → `generateShowVoice`, each taking the format; the calm prompts in `src/prompts/voice-show/calm-*.ts` read the show modules' `kindRules`, `factRules`, `familyLines`, `addressRule` and `POINTING_RULE`, so a facts fix is made once). The show's prompts and TTS requests are pinned byte for byte by `scripts/fixtures/voice-show-golden.json` (`scripts/smoke-voice-calm.ts`; re-record with `--write-show-golden` only when the show itself is meant to change). The calm voice per language is `CALM_VOICES` (`src/services/voice-generator.ts`, the owner's pick by ear) and its style `CALM_STYLE`, one string on every paragraph, frozen with that pick: changing either means a new listening round.
```

- [ ] **Step 7: Run the tests**

Run: **SMOKE `voice-calm`** → all pass (G1, G2 still).
Run (TZ=Asia/Jerusalem where they say so): **SMOKE `voice-limits`**, **SMOKE `voice-show-writer`**, **SMOKE `voice-show-produce`**, **SMOKE `partner-labels`**, **SMOKE `address-me-as`**, **SMOKE `weather-command`**, **SMOKE `week-commands`**, **SMOKE `week-lookahead`**, **SMOKE `summary-seam`** → all pass.
Run: `npx tsc --noEmit -p .` and `npx eslint src/services/voice-show src/services/telegram/voice.ts scripts/smoke-voice-calm.ts scripts/smoke-voice-limits.ts` → clean.

- [ ] **Step 8: Commit**

```bash
git add src/services/voice-show src/services/telegram/voice.ts scripts/smoke-voice-calm.ts scripts/smoke-voice-limits.ts README.md CLAUDE.md
git commit -m "feat(voice): every summary voice note follows the person's voice style through the one pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 7: The Settings row "Voice style" (UI)

**Implementer invokes the frontend-design skill first** (`frontend-design:frontend-design`), then stays inside the existing kit: `ValueRow` from `components/app-ui/form-kit.tsx`, the Summaries card, no new component, no new CSS, no icon, no emoji.

**Files:**
- Modify: `app/[locale]/(app)/settings/settings-body.ts`
- Modify: `app/[locale]/(app)/settings/SettingsClient.tsx` (insertions only)
- Modify: `src/lib/page-data.ts` (one inserted line pair)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (`settings.voice.hint` value, new `settings.voiceFormat` block)
- Test: `scripts/smoke-settings-render.ts` (fixture, S3, new S14), `scripts/smoke-page-auth.ts` (#6c3)

**Interfaces:**
- Consumes: `UserConfig.voiceFormat` (Task 2), `POST /api/settings` `voiceFormat` (Task 2).
- Produces: `export type VoiceFormat = 'show' | 'calm'` and `SettingsValues.voiceFormat` (settings-body); `currentSettings.voiceFormat` in the settings page props; the body posts `voiceFormat` right after `voiceSummaryEnabled`.

Copy (exact; Russian ` ` written as the JSON escape):

| key | en | he | ru |
|---|---|---|---|
| `settings.voice.hint` | Your summary as a short voice note | הסיכום כהודעה קולית קצרה | Сводка в виде короткого голосового сообщения |
| `settings.voiceFormat.label` | Voice style | סגנון הקול | Стиль озвучки |
| `settings.voiceFormat.show` | Radio show, two hosts | תוכנית רדיו, שני מגישים | Радиошоу с двумя ведущими |
| `settings.voiceFormat.calm` | Calm, one voice | קול אחד רגוע | Один спокойный голос |

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-settings-render.ts`:
- Header comment: after the `//  - S9 React logs no warning; S10 ...` line insert `//  - S14 the "Voice style" row: right under the voice switch while it is on, its copy in en/he/ru, a pick posted as "show" or "calm".`
- In the `settings` fixture, after `  voiceSummaryEnabled: false,` insert `  voiceFormat: 'show' as SettingsValues['voiceFormat'],`
- In S3: in `values` after `      voiceSummaryEnabled: true,` insert `      voiceFormat: 'calm',`; in both expected objects after `          voiceSummaryEnabled: true,` insert `          voiceFormat: 'calm',`; in the page-post expected object after `            voiceSummaryEnabled: false,` insert `            voiceFormat: 'show',`.
- Insert this check right before the line `  await check("S8 the header's own back`:

```ts
  await check('S14 "Voice style" (voiceFormat): a row right under the Voice summary switch only while the switch is on (and never for an account with no chat), in the person\'s language with the show and calm in it, the saved one shown; the switch\'s hint no longer names two hosts; a pick enables Save and is posted as "show" or "calm"; switched off and on again it comes back as it was, with Save off', async () => {
    // Written out, so a change of wording is seen here
    const copy: Record<Locale, { label: string; show: string; calm: string; hint: string }> = {
      en: { label: 'Voice style', show: 'Radio show, two hosts', calm: 'Calm, one voice', hint: 'Your summary as a short voice note' },
      he: { label: 'סגנון הקול', show: 'תוכנית רדיו, שני מגישים', calm: 'קול אחד רגוע', hint: 'הסיכום כהודעה קולית קצרה' },
      ru: { label: 'Стиль озвучки', show: 'Радиошоу с двумя ведущими', calm: 'Один спокойный голос', hint: 'Сводка в виде короткого голосового сообщения' },
    };
    for (const locale of LOCALES) {
      const want = copy[locale];
      assert(word(locale, 'voiceFormat.label') === want.label && word(locale, 'voiceFormat.show') === want.show && word(locale, 'voiceFormat.calm') === want.calm && word(locale, 'voice.hint') === want.hint, `${locale}: the messages`);
      const off = renderToString(tree(locale, propsOf({}, { language: locale, voiceSummaryEnabled: false })));
      assert(!off.includes(want.label), `${locale}: the row shows while voice is off`);
      for (const voiceFormat of ['show', 'calm'] as const) {
        const html = renderToString(tree(locale, propsOf({}, { language: locale, voiceSummaryEnabled: true, voiceFormat })));
        const at = html.indexOf(want.label);
        assert(at > html.indexOf(word(locale, 'voice.label')) && at < html.indexOf(word(locale, 'weather.label')), `${locale}: not right under the voice switch`);
        assert(!/settings\./.test(textOf(html)), `${locale}: a raw key`);
        const m = open(locale, propsOf({}, { language: locale, voiceSummaryEnabled: true, voiceFormat }));
        try {
          const row = rowOf(m.m, want.label);
          assert(row, `${locale}: no row ${want.label}`);
          const shown = elements(row).find((e) => e.className.split(' ').includes('ch-form-value-text'));
          assert(shown && flat(shown) === want[voiceFormat], `${locale} ${voiceFormat}: the row shows ${shown ? flat(shown) : '(nothing)'}`);
          const options = elements(selectOf(m.m, want.label) as FakeElement).filter((e) => e.localName === 'option');
          assert(show(options.map((o) => [o.getAttribute('value'), o.textContent])) === show([['show', want.show], ['calm', want.calm]]), `${locale}: the options ${show(options.map((o) => [o.getAttribute('value'), o.textContent]))}`);
          assert(saveButton(m.m)?.hasAttribute('disabled'), `${locale}: Save is off while nothing differs`);
        } finally {
          close(m);
        }
      }
    }
    // No chat: no voice, so no style, even saved with voice on
    assert(!renderToString(tree('en', propsOf({ hasChat: false }, { voiceSummaryEnabled: true }))).includes('Voice style'), 'shown to an account with no chat');
    // A pick enables Save and is posted; picking back leaves Save off; switched off and on again it is as it was
    reset();
    const a = open('en', propsOf({}, { voiceSummaryEnabled: true, voiceFormat: 'calm' }));
    try {
      const select = () => selectOf(a.m, 'Voice style') as FakeElement;
      a.m.click(switchOf(a.m, word('en', 'voice.label')) as FakeElement);
      assert(!rowOf(a.m, 'Voice style'), 'the row stays with voice off');
      a.m.click(switchOf(a.m, word('en', 'voice.label')) as FakeElement);
      const back = rowOf(a.m, 'Voice style');
      // The value the row shows (the select inside it holds both options, so the row's whole text proves nothing)
      const backShown = back && elements(back).find((e) => e.className.split(' ').includes('ch-form-value-text'));
      assert(backShown && flat(backShown) === 'Calm, one voice' && saveButton(a.m)?.hasAttribute('disabled'), 'off and on again: not as it was');
      a.m.change(select(), 'show');
      assert(!saveButton(a.m)?.hasAttribute('disabled'), 'a pick enables Save');
      a.m.change(select(), 'calm');
      assert(saveButton(a.m)?.hasAttribute('disabled'), 'back to the saved value: Save is off');
      a.m.change(select(), 'show');
      a.m.click(saveButton(a.m) as FakeElement);
      await settle();
      const body = JSON.parse(String(posts()[0].init.body));
      assert(posts().length === 1 && body.voiceFormat === 'show' && body.voiceSummaryEnabled === true, `the request: ${show(body)}`);
      assert(saveButton(a.m)?.hasAttribute('disabled'), 'saved: Save is off');
    } finally {
      close(a);
    }
  });
```

In `scripts/smoke-page-auth.ts`, right after the `#6c2` check's closing `});`, add:

```ts
  await check('#6c3 page-data settings: the props carry the voice style (currentSettings.voiceFormat) as the row has it, show or calm; a row holding anything else reads as the show, as the voice notes read it', async () => {
    for (const [stored, want] of [['calm', 'calm'], ['show', 'show'], ['', 'show'], ['Calm', 'show'], ['loud', 'show']] as const) {
      seed();
      Object.assign(DB.user.find((u: Row) => u.id === 42) as Row, { voiceFormat: stored });
      const res = await pageData({ page: 'settings', user_id: 42, locale: 'ru' }, waCookie);
      assert(res.status === 200, `status ${res.status} ${await bodyOf(res)}`);
      const body = await fullBody(res);
      const voiceFormat = body.match(/"currentSettings":\{[^}]*?"voiceFormat":"(\w+)"/)?.[1];
      assert(voiceFormat === want, `stored ${JSON.stringify(stored)}: the props say ${voiceFormat} (want ${want}) in ${await bodyOf(res)}`);
    }
  });
```

- [ ] **Step 2: Run to see them fail**

Run: **SMOKE `settings-render`** (TZ=UTC, then TZ=Asia/Jerusalem) → S3 FAIL (no `voiceFormat` in the body), S14 FAIL (no message `settings.voiceFormat.label`).
Run: **SMOKE `page-auth`** → #6c3 FAIL (no `voiceFormat` in the props).

- [ ] **Step 3: settings-body.ts**

- After `export type Gender = 'male' | 'female';` insert:
```ts

/** How the summary voice notes sound (User.voiceFormat): the two-host radio show or one calm presenter. The only two the server accepts. */
export type VoiceFormat = 'show' | 'calm';
```
- In `SettingsValues`, after `  voiceSummaryEnabled: boolean;` insert:
```ts
  /** "Voice style": shown under the voice switch while it is on, posted always (the server keeps a closed set). */
  voiceFormat: VoiceFormat;
```
- In `buildSettingsBody`, after `    voiceSummaryEnabled: values.voiceSummaryEnabled,` insert `    voiceFormat: values.voiceFormat,`
- In `sameSettings`, after `    a.voiceSummaryEnabled === b.voiceSummaryEnabled &&` insert `    a.voiceFormat === b.voiceFormat &&`

- [ ] **Step 4: SettingsClient.tsx (insertions only)**

- Header comment: after the two lines of the `"Address me as"` bullet (ending `calendar speak of the person in that gender.`) insert:
```tsx
// - The "Voice style" row (the two-host radio show or one calm voice) sits right under the Voice summary switch, only
//   while the switch is on; the voice notes of every kind follow it.
```
- In `SettingsClientProps.currentSettings`, after `    voiceSummaryEnabled: boolean;` insert:
```tsx
    /** "Voice style": the two-host show or one calm presenter (User.voiceFormat). */
    voiceFormat: SettingsValues['voiceFormat'];
```
- Right after the voice `SwitchRow` (the element whose `label={t('voice.label')}`, ending with `onChange={(on) => set('voiceSummaryEnabled', on)}` and `/>`), insert:
```tsx
                  {/* How the voice notes sound: only while there are voice notes. The show stays everyone's default. */}
                  {form.voiceSummaryEnabled ? (
                    <ValueRow
                      label={t('voiceFormat.label')}
                      value={form.voiceFormat}
                      options={[
                        { value: 'show', text: t('voiceFormat.show') },
                        { value: 'calm', text: t('voiceFormat.calm') },
                      ]}
                      onChange={(value) => set('voiceFormat', value === 'calm' ? 'calm' : 'show')}
                    />
                  ) : null}
```

- [ ] **Step 5: page-data.ts (one inserted pair)**

In `src/lib/page-data.ts`, inside `currentSettings`, after `      voiceSummaryEnabled: user.voiceSummaryEnabled,` insert:
```ts
      // "Voice style": already narrowed by voiceFormatOf (convertPrismaUserToConfig), as the voice notes read it
      voiceFormat: user.voiceFormat,
```

- [ ] **Step 6: Messages**

`messages/en.json`: replace
```json
      "hint": "A short radio show with two hosts"
    },
```
with
```json
      "hint": "Your summary as a short voice note"
    },
    "voiceFormat": {
      "label": "Voice style",
      "show": "Radio show, two hosts",
      "calm": "Calm, one voice"
    },
```

`messages/he.json`: replace
```json
      "hint": "תוכנית רדיו קצרה עם שני מגישים"
    },
```
with
```json
      "hint": "הסיכום כהודעה קולית קצרה"
    },
    "voiceFormat": {
      "label": "סגנון הקול",
      "show": "תוכנית רדיו, שני מגישים",
      "calm": "קול אחד רגוע"
    },
```

`messages/ru.json`: replace
```json
      "hint": "Короткое радиошоу с двумя ведущими"
    },
```
with
```json
      "hint": "Сводка в виде короткого голосового сообщения"
    },
    "voiceFormat": {
      "label": "Стиль озвучки",
      "show": "Радиошоу с двумя ведущими",
      "calm": "Один спокойный голос"
    },
```

- [ ] **Step 7: Run the tests**

Run: **SMOKE `settings-render`** under `TZ=UTC` and `TZ=Asia/Jerusalem` → all pass (S1, S9, S10, S13 too).
Run: **SMOKE `page-auth`**, **SMOKE `web-push-ui`**, **SMOKE `browser-only-ui`** → pass.
Run: `npx tsx scripts/check-i18n-parity.ts` → no missing keys.
Run: `npx tsc --noEmit -p .` and `npx eslint "app/[locale]/(app)/settings" src/lib/page-data.ts scripts/smoke-settings-render.ts scripts/smoke-page-auth.ts` → clean.

- [ ] **Step 8: Commit**

```bash
git add "app/[locale]/(app)/settings/settings-body.ts" "app/[locale]/(app)/settings/SettingsClient.tsx" src/lib/page-data.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-settings-render.ts scripts/smoke-page-auth.ts
git commit -m "feat(settings): Voice style, the radio show or one calm voice, under the voice summary switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 8: The paid eval learns `--format calm` (built and dry-run tested only)

**Files:**
- Modify: `scripts/eval-voice-show.ts`
- Test: `scripts/smoke-eval-voice-show.ts` (#5, #6)

**Interfaces:**
- Consumes: `isVoiceFormat` (Task 2), `toShowLines(..., format)` (Task 3), `generateShowVoice(..., format)` (Task 4), `ShowPromptContext.presenterGender` (Task 6's `buildShowContext`).
- Produces: `--format show|calm`; unknown → exits 1 before the spend notice; calm runs check "no tags" and the presenter's gender; output files `<fixture>-calm.json/.ogg`.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-eval-voice-show.ts`, after check `#4` add:

```ts
  await check('#5 the real script with --format calm, the three Hebrew daily cases and no --yes: it prints 3 cases and the estimate, exits non-zero and runs none', () => {
    const run = spawnSync(process.execPath, ['-r', 'tsx/cjs', 'scripts/eval-voice-show.ts', path.join(ROOT, 'node_modules/.cache/eval-voice-show-smoke'), '--format', 'calm', '--lang', 'he', '--only', 'daily-male-busy,daily-female-empty,daily-female-busy'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ...process.env, GEMINI_API_KEY: 'fake' },
    });
    const out = `${run.stdout}${run.stderr}`;
    assert(run.status === 1 && run.signal === null, `exit ${run.status} (signal ${run.signal}): ${out}`);
    assert(out.includes('3 case') && /\$\d/.test(out) && out.includes('--yes'), `the notice: ${out}`);
    assert(!out.includes('===') && !out.includes('FAIL') && !out.includes('OK  '), `a case ran: ${out}`);
  });

  await check('#6 an unknown --format stops before the spend notice and runs nothing', () => {
    const run = spawnSync(process.execPath, ['-r', 'tsx/cjs', 'scripts/eval-voice-show.ts', path.join(ROOT, 'node_modules/.cache/eval-voice-show-smoke'), '--format', 'loud', '--yes'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ...process.env, GEMINI_API_KEY: 'fake' },
    });
    const out = `${run.stdout}${run.stderr}`;
    assert(run.status === 1 && out.includes('Unknown --format') && !out.includes('case(s) to run') && !out.includes('==='), `exit ${run.status}: ${out}`);
  });
```

Also extend its header comment's first sentence with: `With --format calm it runs the calm single voice; an unknown format stops before the spend notice.`

- [ ] **Step 2: Run to see them fail**

Run: **SMOKE `eval-voice-show`** → #5 FAIL (`--format` is read as the out dir, or 0 cases), #6 FAIL (`loud` passes through, and `--yes` would start paid calls: the 20 s kill and the fake key stop it; `Unknown --format` missing).

- [ ] **Step 3: Implement**

In `scripts/eval-voice-show.ts`:

1. Header: replace the two `// Run:` lines with
```ts
// Run: npx tsx -r dotenv/config scripts/eval-voice-show.ts <outDir> [--model gemini-3.8-flash] [--lang he,en]
//      [--only name1,name2] [--format show|calm] [--no-audio] [--yes]   (--no-audio writes and checks scripts only: no TTS, no length check)
//
// --format calm runs the calm single voice (spec docs/superpowers/specs/2026-11-07-calm-voice-design.md) on the same
// fixtures: the calm writer and parser, no tag at all instead of the sound budget, the presenter's gender in the judge,
// one voice (CALM_VOICES) with CALM_STYLE. Its files are <fixture>-calm.json and .ogg. An unknown format runs nothing.
```

2. After `import type { ShowKind } from '../src/services/voice-show/types';` add `import { isVoiceFormat } from '../src/services/voice-show/types';`

3. After `  const audio = !args.includes('--no-audio');` add:
```ts
  // --format calm runs the calm single voice instead of the show.
  const formatFlag = args.indexOf('--format');
  const format = formatFlag >= 0 ? args[formatFlag + 1] : 'show';
  if (!isVoiceFormat(format)) {
    console.log(`Unknown --format ${JSON.stringify(format)}: use show or calm. Nothing was run.`);
    process.exit(1);
  }
  const calm = format === 'calm';
```

4. Replace `['--model', '--lang', '--only'].includes(args[i - 1])` with `['--model', '--lang', '--only', '--format'].includes(args[i - 1])`.

5. Replace `    const user = { id: 1, language, isAdmin: true, ...fixture.user } as unknown as UserConfig;` with `    const user = { id: 1, language, isAdmin: true, ...fixture.user, voiceFormat: format } as unknown as UserConfig;`
   and `    const record: Record<string, unknown> = { fixture: fixture.name, model: modelId ?? AI_MODEL };` with
```ts
    const record: Record<string, unknown> = { fixture: fixture.name, model: modelId ?? AI_MODEL, format };
    const outName = calm ? `${fixture.name}-calm` : fixture.name;
```

6. Replace

```ts
      const sounds = text.match(SOUND) ?? [];
      checks.push({ name: 'sounds <= 2', ok: sounds.length <= 2, detail: sounds.join(' ') || 'none' });
      checks.push({ name: 'shape', ok: true, detail: `${turns.length} turns, ${new Set(turns.map(t => t.mood)).size} moods (${[...new Set(turns.map(t => t.mood))].join(', ')}), attempts ${written.attempts}` });
```
with
```ts
      if (calm) {
        // One presenter: no sound and no tag may reach TTS (a <yawn>-type tag slows the whole read).
        const tags = text.match(/<[^>]*>|[<>]/g) ?? [];
        checks.push({ name: 'no tags', ok: tags.length === 0, detail: tags.join(' ') || 'none' });
        checks.push({ name: 'shape', ok: turns.every(t => t.host === 'A'), detail: `${turns.length} paragraphs, one presenter, attempts ${written.attempts}` });
      } else {
        const sounds = text.match(SOUND) ?? [];
        checks.push({ name: 'sounds <= 2', ok: sounds.length <= 2, detail: sounds.join(' ') || 'none' });
        checks.push({ name: 'shape', ok: true, detail: `${turns.length} turns, ${new Set(turns.map(t => t.mood)).size} moods (${[...new Set(turns.map(t => t.mood))].join(', ')}), attempts ${written.attempts}` });
      }
```

7. In the judge prompt, replace
```ts
        `The two hosts (A and B) are men and must speak of themselves in the masculine.\n${describePeople(context)}\n` +
```
with
```ts
        (calm
          ? `The one presenter (A) is a ${context.presenterGender === 'female' ? 'woman' : 'man'} and must speak of themself in the ${context.presenterGender === 'female' ? 'feminine' : 'masculine'}.\n`
          : 'The two hosts (A and B) are men and must speak of themselves in the masculine.\n') +
        `${describePeople(context)}\n` +
```
and `a host speaks of himself in the feminine. ` with `${calm ? 'or the presenter speaks of themself in the wrong gender. ' : 'or a host speaks of himself in the feminine. '}` (keep the surrounding template literal intact: the line becomes
`` `a family member is referred to with the wrong gender, a person of unknown gender is given one, ${calm ? 'or the presenter speaks of themself in the wrong gender. ' : 'or a host speaks of himself in the feminine. '}` + ``).

8. Replace `      const lines = toShowLines(turns, language, context.listener.gender);` with `      const lines = toShowLines(turns, language, context.listener.gender, format);`, `      const show = await generateShowVoice(lines, language);` with `      const show = await generateShowVoice(lines, language, {}, format);`, `path.join(outDir, \`${fixture.name}.ogg\`)` with `path.join(outDir, \`${outName}.ogg\`)` and `path.join(outDir, \`${fixture.name}.json\`)` with `path.join(outDir, \`${outName}.json\`)`.

- [ ] **Step 4: Run the tests (no paid call)**

Run: **SMOKE `eval-voice-show`** → `6/6 passed`.
Dry run by hand, spends nothing (no `--yes`): `bash -c 'source /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fake-env.sh; env $E GEMINI_API_KEY=fake npx tsx scripts/eval-voice-show.ts /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/eval-calm-dry --format calm --lang he --only daily-male-busy,daily-female-empty,daily-female-busy --no-audio'` → prints `3 case(s) to run without audio, estimated about $0.0…` and `Nothing was run. Run again with --yes to spend it.`, exits 1, and writes no case file. Never add `--yes`.
Run: `npx tsc --noEmit -p .` and `npx eslint scripts/eval-voice-show.ts scripts/smoke-eval-voice-show.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-voice-show.ts scripts/smoke-eval-voice-show.ts
git commit -m "test(eval): the voice eval runs the calm single voice with --format calm (paid; gated, never run here)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

- [ ] **Step 6: Live calm eval — controller only, after the owner's OK (given)**

Not an implementer step. After the owner's blind pick is in `CALM_VOICES`, the controller runs, once, stopping at the first failed case:
`npx tsx -r dotenv/config scripts/eval-voice-show.ts <scratchpad>/eval-calm --format calm --lang he --only daily-male-busy,daily-female-empty,daily-female-busy --yes`
(3 Hebrew daily runs, ~$0.08 at the spec's estimate; check the Flash text rate on the pricing page first), converts the `.ogg` files to m4a for the owner, and reports.

---

## Branch wrap-up (controller)

1. Full gate: `npx tsc --noEmit -p .`, `npm run lint`, `bash scripts/ci-smokes.sh`, `npx next build` (never `npm run build`).
2. Whole-branch review (opus), then fix every valid finding.
3. After the owner's blind round: swap the three names in `CALM_VOICES` (one edit), re-run **SMOKE `voice-calm`**, then Task 8 Step 6.
4. Native-ear check of the Hebrew and Russian copy (Task 7 table) before ship.
5. Rebase on `feat/b-features` if it landed first (expected small conflicts only in the five shared files), re-run the gate, land on main.
