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

  await check('daily prompt reuses the summary greeting and says nothing about tomorrow', () => {
    const p = buildShowPrompt(context());
    assert(p.includes('היום של המאזין'), 'today goal');
    assert(p.includes('אותה ברכה שהסיכום נפתח בה'), 'greeting rule');
    assert(!p.includes('מחר'), 'tomorrow wording in the daily prompt');
  });

  await check('tomorrow prompt: about tomorrow, opens with מחר, evening greeting, never "today"', () => {
    const p = buildShowPrompt(context({ kind: 'tomorrow', summary: '<b>ערב טוב, דני!</b>\n<b>מחר - יום שני</b>\n• 07:00 - חדר כושר' }));
    assert(p.includes('מה שמחכה למאזין מחר'), 'tomorrow goal');
    assert(!p.includes('היום של המאזין'), 'today goal in the tomorrow prompt');
    assert(p.includes('"מחר" כבר במשפט הפתיחה'), 'opening rule');
    assert(p.includes('לעולם לא "בוקר טוב"'), 'no good morning');
    assert(p.includes('לעולם אל תקראו לו "היום"'), 'never today');
    assert(p.includes('מזג האוויר של מחר'), 'tomorrow weather rule');
    assert(p.includes('אל תמציאו אירועים') && p.includes('לא בספרות'), 'shared content rules');
    assert(p.includes('בין 6 ל-20 תורות'), 'turn count');
    const female = buildShowPrompt(context({ kind: 'tomorrow', listener: { name: 'מיכל', gender: 'female' } }));
    assert(female.includes('מה שמחכה למאזינה מחר'), 'feminine tomorrow goal');
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

  await check('weather prompt covers the whole forecast, evening leads with tomorrow', () => {
    const p = buildShowPrompt(context({ kind: 'weather' }));
    assert(!p.includes('תחזית מזג האוויר של היום'), 'today-only goal');
    assert(p.includes('תחזית מזג האוויר כולה'), 'whole-forecast goal');
    assert(p.includes('קודם עכשיו ושאר היום, אחר כך מחר'), 'now, today, then tomorrow');
    assert(p.includes('פתחו במחר'), 'evening leads with tomorrow');
    assert(p.includes('השבוע: תור או שניים'), 'week in a turn or two');
    assert(p.includes('התחזית המורחבת: לכל היותר משפט אחד'), 'one hedged line on the extended outlook');
    assert(p.includes('כ-35-50 שניות'), 'length');
    assert(p.includes('אותה ברכה שהתחזית נפתחת בה'), 'greeting rule');
  });

  await check('the output line asks for the turn count of the kind', () => {
    const weather = buildShowPrompt(context({ kind: 'weather' }));
    assert(weather.includes('בין 6 ל-10 תורות') && weather.includes('6-10 תורות') && !weather.includes('בין 6 ל-20'), 'weather turns');
    for (const kind of ['daily', 'tomorrow', 'weekly'] as const) {
      assert(buildShowPrompt(context({ kind })).includes('בין 6 ל-20 תורות'), `${kind} turns`);
    }
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
    const tomorrow = buildShowContext('s', user, 'tomorrow', true);
    assert(tomorrow.kind === 'tomorrow' && tomorrow.isNextWeek === undefined, `tomorrow ${tomorrow.kind} ${tomorrow.isNextWeek}`);
    assert(buildShowPrompt(tomorrow).includes('מה שמחכה למאזין מחר'), 'tomorrow context does not reach the prompt');
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
