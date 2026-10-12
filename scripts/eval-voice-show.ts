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
  {
    name: 'tomorrow-male',
    kind: 'daily',
    user: { name: 'עומר', gender: 'male', culture: 'default', calendarAssignments: [] },
    summary: `<b>ערב טוב, עומר! 🌙</b>

<b>מחר - יום שני, 19 באוקטובר</b>

<b>לוח הזמנים שלך:</b>
• 07:00 - חדר כושר
• 11:00 - תור לרופא
• 18:30 - ארוחת ערב עם חברים

<b>מזג אוויר:</b> ⛅ 26°/18°, מעונן חלקית.`,
    facts: [['מחר'], ['עומר'], ['רופא'], ['ספורט', 'כושר', 'חדר כושר'], ['אחת עשרה']],
    seconds: [30, 85],
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

  // @hebcal/core is ESM-only (exports has only an "import" condition) and tsx loads src/
  // as CommonJS, so point require() at its ESM entry (Node 22+ can require ESM).
  const Module = (await import('module')).default as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };

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
