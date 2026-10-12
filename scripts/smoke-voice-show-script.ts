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
