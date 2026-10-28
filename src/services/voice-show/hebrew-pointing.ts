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
 * Bare "לך" is the exception for a man: the imperative "לך" (go, as in "לך על זה")
 * is spelled the same, and the masculine "to you" is Gemini's default reading anyway.
 * A woman's imperative is "לכי", so for her "לך" is always "to you".
 *
 * A prefix ו/ב/ל/כ (or ו plus one of the others) is pointed too; מ, ש and ה prefixes
 * are left bare. After a prefix the word's own ב, כ or פ no longer starts the word and
 * loses its dagesh ("ובשבילך" is "u-vi", not "u-bi"). Words that already carry niqqud
 * are left alone.
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

// No male form means: leave the word bare for a man.
const SECOND_PERSON: Record<string, { male?: string; female: string }> = {
  'לך': { female: 'לָךְ' },
  'שלך': { male: 'שֶׁלְּךָ', female: 'שֶׁלָּךְ' },
  'אותך': { male: 'אוֹתְךָ', female: 'אוֹתָךְ' },
  'עליך': { male: 'עָלֶיךָ', female: 'עָלַיִךְ' },
  'אליך': { male: 'אֵלֶיךָ', female: 'אֵלַיִךְ' },
  'בשבילך': { male: 'בִּשְׁבִילְךָ', female: 'בִּשְׁבִילֵךְ' },
  'איתך': { male: 'אִתְּךָ', female: 'אִתָּךְ' },
  'אצלך': { male: 'אֶצְלְךָ', female: 'אֶצְלֵךְ' },
  'ממך': { male: 'מִמְּךָ', female: 'מִמֵּךְ' },
  'לפניך': { male: 'לְפָנֶיךָ', female: 'לְפָנַיִךְ' },
  'אחריך': { male: 'אַחֲרֶיךָ', female: 'אַחֲרַיִךְ' },
  'מאחוריך': { male: 'מֵאֲחוֹרֶיךָ', female: 'מֵאֲחוֹרַיִךְ' },
  'לידך': { male: 'לְיָדְךָ', female: 'לְיָדֵךְ' },
  'כמוך': { male: 'כָּמוֹךָ', female: 'כָּמוֹךְ' },
  'בך': { male: 'בְּךָ', female: 'בָּךְ' },
  'עבורך': { male: 'עֲבוּרְךָ', female: 'עֲבוּרֵךְ' },
  'אתך': { male: 'אִתְּךָ', female: 'אִתָּךְ' },
  'לגביך': { male: 'לְגַבֶּיךָ', female: 'לְגַבַּיִךְ' },
  // The reflexive takes its ב and ל inside the word: "להשקיע בעצמך" (2026-10-28 sample).
  'עצמך': { male: 'עַצְמְךָ', female: 'עַצְמֵךְ' },
  'בעצמך': { male: 'בְּעַצְמְךָ', female: 'בְּעַצְמֵךְ' },
  'לעצמך': { male: 'לְעַצְמְךָ', female: 'לְעַצְמֵךְ' },
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

/** The prefix and the word joined: the prefix pointed, the word's leading ב/כ/פ softened. */
function withPrefix(prefix: string, pointed: string): string {
  if (!prefix) return pointed;
  const head = pointPrefix(prefix, pointed);
  if (!'בכפ'.includes(pointed[0])) return head + pointed;
  const marks = /^[֑-ׇ]*/.exec(pointed.slice(1))![0];
  return head + pointed[0] + marks.replace(DAGESH, '') + pointed.slice(1 + marks.length);
}

const nfc = (s: string) => s.normalize('NFC');

export function pointHebrewTimes(text: string): string {
  return text
    .replace(TEEN_RE, (_m, prefix: string, unit: string) => {
      const pointed = FEMININE_UNITS[unit];
      return nfc(`${withPrefix(prefix, pointed)} ${TEEN}`);
    })
    .replace(TEN_RE, (_m, prefix: string) => nfc(withPrefix(prefix, TEN)))
    .replace(QUARTER_RE, (_m, prefix: string) => nfc((prefix === 'ו' ? 'ו' + QAMATS : pointPrefix(prefix, QUARTER)) + QUARTER));
}

export function pointSecondPerson(text: string, gender: 'male' | 'female'): string {
  return text.replace(SECOND_PERSON_RE, (match, vav: string, word: string) => {
    const pointed = SECOND_PERSON[word][gender];
    return pointed ? nfc(withPrefix(vav, pointed)) : match;
  });
}
