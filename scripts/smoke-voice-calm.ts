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
