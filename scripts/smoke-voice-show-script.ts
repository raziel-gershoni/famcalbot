// Smoke test for the show script validator and the Hebrew pointing table. No network.
//
// Run: npx tsx scripts/smoke-voice-show-script.ts

import {
  parseShowScript, SHOW_RESPONSE_SCHEMA, ShowScriptError, toShowLines,
} from '../src/services/voice-show/script';
import { pointHebrewTimes, pointSecondPerson } from '../src/services/voice-show/hebrew-pointing';
import { HOST_STYLE, MOOD_STYLES, MOODS, type ShowTurn } from '../src/services/voice-show/types';

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

check('bad host and non-string text are rejected', () => {
  rejects(show(...base(), turn('C', 'שלום')), /Turn 5: host/);
  rejects(show(...base(), { host: 'A', mood: 'hype', text: 5 }), /Turn 5: text/);
});

check('a turn with no words (only a sound, or blank) is dropped with a warning', () => {
  const s = parseShowScript(show(...base(), turn('B', '<laugh>'), turn('A', '   ')));
  assert(s.turns.length === 4, `turns ${s.turns.length}`);
  assert(s.turns.every(t => /\p{L}/u.test(t.text)), 'a wordless turn was kept');
  assert(s.warnings.some(w => /Turn 5: dropped/.test(w)) && s.warnings.some(w => /Turn 6: dropped/.test(w)), s.warnings.join('; '));
});

check('dropping wordless turns still rejects too short a show or a missing host', () => {
  const [a1, , a2, b2] = base();
  rejects(show(a1, turn('B', '<laugh>'), a2, b2), /3 turns left/);
  rejects(show(a1, turn('B', '<chuckle>'), a2, turn('A', 'עוד משהו'), turn('A', 'וסיום')), /Both hosts/);
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

// Each of these used to reach TTS, which reads leftovers aloud: a label, a tag, a cue
// word, an emoji piece or an undecoded entity.
const CLEANUP: Array<[string, string]> = [
  ['**B:** בוקר טוב דני', 'בוקר טוב דני'],
  ['<*cheer*> יאללה', 'יאללה'],
  ['כל הכבוד 👍🏽', 'כל הכבוד'],
  ['חג שמח 🇮🇱', 'חג שמח'],
  ['1️⃣ פגישה ראשונה', 'פגישה ראשונה'],
  ['משפחה 👨‍👩‍👧 שלמה', 'משפחה שלמה'],
  ['<laugh> A: שלום', '<laugh> שלום'],
  ['|וואו| B: יאללה', 'יאללה'],
  ['[צוחק] B: יאללה', 'יאללה'],
  ['<b>B:</b> יאללה', 'יאללה'],
  ['*צוחק* איזה יום', 'איזה יום'],
  ['(צוחק) איזה יום', 'איזה יום'],
  ['איזה יום (laughs)', 'איזה יום'],
  ['<צחוק> איזה יום', 'איזה יום'],
  ['רוק&#8217;נרול', 'רוק’נרול'],
  ['ג&#x27;רי', "ג'רי"],
  ['פגישה (בזום) עם לוי', 'פגישה (בזום) עם לוי'],
  // A cue anywhere in the span marks a stage direction, nested or not.
  ['(צוחקת) איזה יום', 'איזה יום'],
  ['(בצחוק) איזה יום', 'איזה יום'],
  ['איזה יום (laughs softly)', 'איזה יום'],
  ['(in a whisper) סוד קטן', 'סוד קטן'],
  ['*נאנח* שוב גשם', 'שוב גשם'],
  ['*(צוחק)* איזה יום', 'איזה יום'],
  ['(*צוחק*) בוקר', 'בוקר'],
  ['*(sighs dramatically)* שוב גשם', 'שוב גשם'],
  ['(nervous laugh) טוב', 'טוב'],
  ['(with a little laugh) טוב', 'טוב'],
  ['(פורץ בצחוק) טוב', 'טוב'],
  ['(שניהם צוחקים) טוב', 'טוב'],
  ['(תוך כדי צחוק) טוב', 'טוב'],
  ['(כמעט לוחש) סוד', 'סוד'],
  ['(אנחת רווחה) סוף סוף', 'סוף סוף'],
  ['(בלחישות) סוד', 'סוד'],
  ['(smiling) יופי', 'יופי'],
  ['(clears throat) ובכן', 'ובכן'],
  ['(מפהק) בוקר', 'בוקר'],
  ['(מגחכת) נו', 'נו'],
  ['(מגחכים) נו באמת', 'נו באמת'],
  ['(מתאנח) שוב גשם', 'שוב גשם'],
  ['(מתנשפת) מה', 'מה'],
  ['(מתלחשים) סוד', 'סוד'],
  ['(בקול מחויך) יופי', 'יופי'],
  ['(צחק) נו', 'נו'],
  ['(צחקה) נו', 'נו'],
  ['(חחח) איזה יום', 'איזה יום'],
  ['(haha) איזה יום', 'איזה יום'],
  ['(נשימה עמוקה) יאללה', 'יאללה'],
  ['(צוֹחֵק) איזה יום', 'איזה יום'],
  ['_צוחק_ בוקר', 'בוקר'],
  ['(לוחש כאילו זה הסוד הכי גדול בעולם) מחר', 'מחר'],
  // Everyday words that share letters with a cue keep their words.
  ['תשלום ארנונה (לחשבון העירייה) עד מחר', 'תשלום ארנונה (לחשבון העירייה) עד מחר'],
  ['בעשר תור (לחשמלאי)', 'בעשר תור (לחשמלאי)'],
  ['(אנחנו בדרך) יאללה', '(אנחנו בדרך) יאללה'],
  ['רואה חשבון (לחישוב החזר המס) בעשר', 'רואה חשבון (לחישוב החזר המס) בעשר'],
  ['ביקור (אצל יצחק) בחמש', 'ביקור (אצל יצחק) בחמש'],
  ['(sightseeing tour) מחר', '(sightseeing tour) מחר'],
  ['יותר > פחות', 'יותר פחות'],
];
for (const [input, expected] of CLEANUP) {
  check(`cleans ${JSON.stringify(input)}`, () => {
    const s = parseShowScript(show(...base(), turn('A', input)));
    assert(s.turns[4].text === expected, `got ${JSON.stringify(s.turns[4].text)}`);
  });
}

// What the user's own summary holds is content: an event called "(ערב צחוק)" is copied
// into the show, not performed.
const SUMMARY = '<b>היום</b>\n• 20:00 סטנדאפ (ערב צחוק) בתל אביב\n• 18:00 Laugh Factory\n• 09:00 חוג (צחוק)\n• 17:00 טום &amp; ג׳רי (smile clinic)';
const FROM_SUMMARY: Array<[string, string]> = [
  ['בשמונה סטנדאפ (ערב צחוק) בתל אביב', 'בשמונה סטנדאפ (ערב צחוק) בתל אביב'],
  ['*ערב צחוק* בשמונה', 'ערב צחוק בשמונה'],
  ['*(ערב צחוק)* בשמונה', '(ערב צחוק) בשמונה'],
  ['בשש (Laugh Factory)', 'בשש (Laugh Factory)'],
  ['בתשע חוג (צחוק)', 'בתשע חוג (צחוק)'],
  ['בחמש (Smile Clinic)', 'בחמש (Smile Clinic)'],
  // A stage direction is still one, even when the summary is about laughing.
  ['(צוחק) איזה ערב', 'איזה ערב'],
  ['(nervous laugh) טוב', 'טוב'],
];
for (const [input, expected] of FROM_SUMMARY) {
  check(`with the summary, cleans ${JSON.stringify(input)}`, () => {
    const s = parseShowScript(show(...base(), turn('A', input)), SUMMARY);
    assert(s.turns[4].text === expected, `got ${JSON.stringify(s.turns[4].text)}`);
  });
}

// The writer may add or drop a prefix letter, and the summary may hyphenate or point.
const NEAR_COPIES: Array<[string, string, string]> = [
  ['• 20:00 הולכים לערב צחוק בקאמרי', '(ערב צחוק) בשמונה', '(ערב צחוק) בשמונה'],
  ['• 20:00 ערב צחוק בקאמרי', '(בערב צחוק) בשמונה', '(בערב צחוק) בשמונה'],
  ['• 19:00 הופעה במועדון הצחוק', 'בשבע הופעה (מועדון הצחוק)', 'בשבע הופעה (מועדון הצחוק)'],
  ['• 20:00 ערב־צחוק בקאמרי', '(ערב צחוק) בשמונה', '(ערב צחוק) בשמונה'],
  ['• 10:00 רופא שיניים ד"ר חיוך', 'בעשר (ד״ר חיוך)', 'בעשר (ד״ר חיוך)'],
  ['סטנדאפ (ערב צחוק) בתל אביב', 'בשמונה (ערב צחוק!)', 'בשמונה (ערב צחוק!)'],
  ["• 21:00 צחוקים עם החבר'ה", '(צחוקים עם החבר׳ה) בתשע', '(צחוקים עם החבר׳ה) בתשע'],
  // A manner word plus a cue is a stage direction even if the summary's sign-off says it.
  ['שיהיה יום מלא חיוכים! עם חיוך', '(עם חיוך) שיהיה יום מעולה', 'שיהיה יום מעולה'],
];
for (const [summary, input, expected] of NEAR_COPIES) {
  check(`with summary ${JSON.stringify(summary)}, cleans ${JSON.stringify(input)}`, () => {
    const s = parseShowScript(show(...base(), turn('A', input)), summary);
    assert(s.turns[4].text === expected, `got ${JSON.stringify(s.turns[4].text)}`);
  });
}

check('one cue word counts as content only when the summary brackets it too', () => {
  const s = parseShowScript(show(...base(), turn('A', '*צחוק* בשמונה')), 'סטנדאפ ערב צחוק');
  assert(s.turns[4].text === 'בשמונה', `got ${JSON.stringify(s.turns[4].text)}`);
});

check('a speaker label right after a sound mid-turn is rejected', () => {
  rejects(show(...base(), turn('A', 'איזה יום! <laugh> B: באמת')), /Turn 5: contains another speaker label/);
});

check('a stray angle bracket is removed with a warning', () => {
  const s = parseShowScript(show(...base(), turn('A', 'יותר > פחות')));
  assert(s.warnings.some(w => /Turn 5: removed stray >/.test(w)), s.warnings.join('; '));
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
  assert(lines[0].style === HOST_STYLE, `style ${lines[0].style}`);
  assert(same(lines[0].text, 'בְּעֶשֶׂר וָרֶבַע יש לָךְ פגישה'), `text ${lines[0].text}`);
  assert(lines[1].style === `${HOST_STYLE}, leaning in close` && lines[1].whisper === false, 'secret');
  assert(lines[2].whisper === true && lines[0].whisper === false, 'whisper flags');
});

// Each host must stay one person: a mood may colour the read but never replace the
// persona, or the host's pitch and pace jump between lines.
check('every mood style keeps the sports-commentator persona', () => {
  for (const [mood, style] of Object.entries(MOOD_STYLES)) {
    assert(style.startsWith(HOST_STYLE), `${mood}: ${style}`);
    assert(!/slow|fast|rapid|whisper|loud|pitch|quiet/i.test(style), `${mood} sets pace, pitch or volume: ${style}`);
  }
});

check('toShowLines leaves other languages untouched', () => {
  const lines = toShowLines([{ host: 'A', mood: 'triumph', text: 'At ten fifteen' }], 'en', 'male');
  assert(lines[0].text === 'At ten fifteen' && lines[0].style === MOOD_STYLES.triumph, JSON.stringify(lines[0]));
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
  assert(same(pointSecondPerson('יש לך פגישה', 'female'), 'יש לָךְ פגישה'), 'female לך');
  assert(same(pointSecondPerson('והיום שלך', 'female'), 'והיום שֶׁלָּךְ'), 'female שלך');
  assert(same(pointSecondPerson('והיום שלך', 'male'), 'והיום שֶׁלְּךָ'), 'male שלך');
  assert(same(pointSecondPerson('ולך', 'female'), 'וְלָךְ'), 'female ולך');
  assert(same(pointSecondPerson('מחכה בשבילך', 'female'), 'מחכה בִּשְׁבִילֵךְ'), 'female בשבילך');
});

check('bare "לך" stays unpointed for a man: "לך על זה" (go for it) is spelled the same', () => {
  for (const text of ['יש לך פגישה', 'ולך', 'לך על זה דני!']) {
    assert(pointSecondPerson(text, 'male') === text, `${text} → ${pointSecondPerson(text, 'male')}`);
  }
});

const MORE_SECOND_PERSON: Array<[string, string, string]> = [
  ['לפניך', 'לְפָנֶיךָ', 'לְפָנַיִךְ'],
  ['אחריך', 'אַחֲרֶיךָ', 'אַחֲרַיִךְ'],
  ['מאחוריך', 'מֵאֲחוֹרֶיךָ', 'מֵאֲחוֹרַיִךְ'],
  ['לידך', 'לְיָדְךָ', 'לְיָדֵךְ'],
  ['כמוך', 'כָּמוֹךָ', 'כָּמוֹךְ'],
  ['בך', 'בְּךָ', 'בָּךְ'],
  ['עבורך', 'עֲבוּרְךָ', 'עֲבוּרֵךְ'],
  ['אתך', 'אִתְּךָ', 'אִתָּךְ'],
];
for (const [word, male, female] of MORE_SECOND_PERSON) {
  check(`points "${word}" for a man and for a woman`, () => {
    const m = pointSecondPerson(`זה ${word}!`, 'male');
    const f = pointSecondPerson(`זה ${word}!`, 'female');
    assert(same(m, `זה ${male}!`), `male ${m}`);
    assert(same(f, `זה ${female}!`), `female ${f}`);
  });
}

check('after a prefix, a leading ב, כ or פ loses its dagesh', () => {
  assert(same(pointSecondPerson('ובך', 'male'), 'וּבְךָ'), `ובך male ${pointSecondPerson('ובך', 'male')}`);
  assert(same(pointSecondPerson('ובך', 'female'), 'וּבָךְ'), `ובך female ${pointSecondPerson('ובך', 'female')}`);
  assert(same(pointSecondPerson('ובשבילך', 'male'), 'וּבִשְׁבִילְךָ'), `ובשבילך male ${pointSecondPerson('ובשבילך', 'male')}`);
  assert(same(pointSecondPerson('ובשבילך', 'female'), 'וּבִשְׁבִילֵךְ'), `ובשבילך female ${pointSecondPerson('ובשבילך', 'female')}`);
  assert(same(pointSecondPerson('וכמוך', 'male'), 'וְכָמוֹךָ'), `וכמוך male ${pointSecondPerson('וכמוך', 'male')}`);
  // Without a prefix the dagesh stays.
  assert(same(pointSecondPerson('גאים בך', 'female'), 'גאים בָּךְ'), `בך female ${pointSecondPerson('גאים בך', 'female')}`);
  assert(same(pointSecondPerson('ולפניך', 'female'), 'וּלְפָנַיִךְ'), `ולפניך female ${pointSecondPerson('ולפניך', 'female')}`);
});

check('second-person pointing leaves other words alone', () => {
  for (const text of ['הולך', 'מלך', 'ללכת', 'לכת', 'הלך', 'לבך', 'שבך', 'לפני', 'כמו', 'בכך', 'אתכם', 'עבור']) {
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
