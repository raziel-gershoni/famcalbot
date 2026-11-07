/**
 * Hebrew two-host show prompt
 * תסריט לשני מגישים נלהבים של תוכנית רדיו, כפלט JSON של תורות. ההגשה בקול נשארת אנרגטית
 * (HOST_STYLE ב-voice-show/types.ts); התוכן לא ממוסגר כשידור ספורט.
 *
 * Content rules carry over from ../voice-condenser/he.ts and week-he.ts: every event
 * kept, every time in words, weather right after the date, birthday names, the user's
 * own rules. The show rules add the hosts, personal address, moods and sounds.
 * The calm single voice (./calm-he.ts) reads the same rules from here: kindRules with format 'calm', familyLines,
 * factRules, addressRule and POINTING_RULE, so a fix here reaches both.
 */

import { sanitizeForPrompt } from '../shared-builders';
import { buildRulesSection } from '../voice-condenser/template';
import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS, type ShowFormat } from '../../services/voice-show/types';
import type { ShowPerson, ShowPromptContext } from './types';

const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');

// The digests mark built-in calendar reminders with ⏰; only a summary that has one gets this rule.
const REMINDERS_RULE =
  'תזכורות (מסומנות ⏰ בסיכום) נכנסות גם הן, שורה קצרה לכל אחת ולעולם לא קטע משלהן: המשימה, והשעה אם יש לה. תזכורת שהסיכום אומר שהיא עדיין פתוחה נאמרת כפתוחה (למשל "עדיין פתוחה מיום שלישי"), ולעולם לא כאחד מאירועי היום.';

function personLine(label: string, person: ShowPerson): string {
  const name = sanitizeForPrompt(person.name);
  if (person.gender === 'male') return `${label}: ${name} (זכר — דברו עליו בלשון זכר)`;
  if (person.gender === 'female') return `${label}: ${name} (נקבה — דברו עליה בלשון נקבה)`;
  // Pronouns alone were not enough: the eval writer still gave such a spouse masculine
  // present-tense verbs ("שי אוסף"), which Hebrew genders like adjectives.
  return `${label}: ${name} (מין לא ידוע — אל תנחשו: בלי "הוא" או "היא", ובלי פועל או תואר בזכר או בנקבה, לא "${name} אוסף" ולא "${name} אוספת". נסחו עם השם ושם עצם: "ל${name} יש...", "האיסוף על ${name}", "אצל ${name}...")`;
}

function listenerLine(context: ShowPromptContext): string {
  const name = sanitizeForPrompt(context.listener.name);
  return context.listener.gender === 'female'
    ? `המאזינה: ${name}. היא אישה — פנו אליה בשמה ובלשון נקבה ("את", "יש לך", "תזכרי", "מוכנה").`
    : `המאזין: ${name}. הוא גבר — פנו אליו בשמו ובלשון זכר ("אתה", "יש לך", "תזכור", "מוכן").`;
}

export interface KindRules {
  goal: string;
  content: string[];
  length: string;
  /** Turn count asked for in the output line (paragraphs for calm). */
  turns: [min: number, max: number];
}

/**
 * The kind's own content. Calm (format 'calm') swaps only the show's energy and its turns: a free day is said
 * calmly instead of celebrated, and paragraphs are counted instead of turns. Every other word is the same.
 */
export function kindRules(context: ShowPromptContext, format: ShowFormat = 'show'): KindRules {
  const female = context.listener.gender === 'female';
  const calm = format === 'calm';
  const oneUnit = calm ? 'בפסקה אחת' : 'בתור אחד';
  const turns: [number, number] = calm ? [4, 8] : [6, 20];
  if (context.kind === 'weekly') {
    const weekRef = context.isNextWeek ? 'בשבוע הבא' : 'השבוע';
    return {
      goal: `מה שבלוח ${female ? 'של המאזינה' : 'של המאזין'} ${weekRef}`,
      content: [
        `פתחו בסקירה קצרה (למשל "הנה מה שיש לך ${weekRef}").`,
        context.culture === 'jewish'
          ? 'השתמשו בתאריכים עבריים (בלי תאריכים לועזיים ובלי שנה עברית).'
          : 'השתמשו בתאריכים לועזיים.',
        'עברו יום אחרי יום, עם ימים יחסיים ("ביום שלישי", "ביום חמישי"), והדגישו את האירועים החשובים.',
        `כל אירוע מהסיכום נכנס, עם היום והשעה שלו. מותר לאחד כמה אירועים של אותו יום ${oneUnit}.`,
        'לאירועי משפחה ציינו בטבעיות של מי האירוע.',
        'שבוע בלי אירועים: אמרו שהיומן פנוי. אל תמציאו אירועים.',
      ],
      length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). בשבוע עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
      turns,
    };
  }

  // /weather sends the whole forecast text: today and tomorrow, the week, and a 16-day
  // outlook, written around the time it was asked for.
  if (context.kind === 'weather') {
    return {
      goal: 'תחזית מזג האוויר כולה — עכשיו, מחר והימים הבאים',
      content: [
        'ברכת הפתיחה: אותה ברכה שהתחזית נפתחת בה. אם אין בה ברכה של שעה ביום, אל תמציאו כזאת.',
        'רק מזג אוויר: טמפרטורות, גשם, רוח, ואיכות אוויר אם היא מופיעה בתחזית.',
        'קודם עכשיו ושאר היום, אחר כך מחר. אם התחזית נכתבה בערב (היא נפתחת ב"ערב טוב" או מדברת על הערב והלילה), הפכו את הסדר: פתחו במחר, ועל הערב והלילה מספיק משפט קצר.',
        'בתחזית של ערב, הבוקר הבא הוא "מחר בבוקר", לעולם לא "הבוקר": הבוקר כבר עבר. כך גם בשאר חלקי מחר ("מחר בצהריים", "מחר בערב").',
        `השבוע: ${calm ? 'פסקה או שתיים' : 'תור או שניים'}, רק המגמה והשינויים הבולטים. כאן מותר לסכם ולקבץ ימים.`,
        'התחזית המורחבת: לכל היותר משפט אחד, בזהירות ("כנראה", "צפוי").',
        'סיימו בטיפ מעשי אחד (מטרייה, קרם הגנה, שכבה נוספת).',
      ],
      // The hosts speak about two words a second (eval: 1.9-2.0).
      length: `כ-35-50 שניות דיבור (בערך 70-95 מילים), ${calm ? '3-6 פסקאות' : '6-10 תורות'}.`,
      turns: calm ? [3, 6] : [6, 10],
    };
  }

  // The tomorrow summary goes out in the evening. Without these rules the writer opened
  // with "בוקר טוב" and "היום" even when the summary itself said "ערב טוב" and "מחר".
  if (context.kind === 'tomorrow') {
    return {
      goal: `מה שבלוח ${female ? 'של המאזינה' : 'של המאזין'} למחר`,
      content: [
        'ברכת הפתיחה מתאימה לערב: אותה ברכה שהסיכום נפתח בה (בדרך כלל "ערב טוב"). לעולם לא "בוקר טוב" — אם הסיכום נפתח בה, פתחו בשם בלי ברכה של שעה ביום.',
        context.culture === 'jewish'
          ? 'אמרו "מחר" כבר במשפט הפתיחה: זה הלוח של מחר. אחריו התאריך העברי של מחר עם היום בשבוע (בלי תאריך לועזי ובלי שנה עברית), למשל "מחר, יום שני, ...".'
          : 'אמרו "מחר" כבר במשפט הפתיחה: זה הלוח של מחר. אחריו התאריך של מחר עם היום בשבוע, למשל "מחר, יום שני, ...".',
        'כל מה שבסיכום קורה מחר. לעולם אל תקראו לו "היום": לא "היום יום שני", לא "בהמשך היום", ולא "הערב" על ערב של מחר. אמרו "מחר", "מחר בבוקר", "מחר בערב".',
        'מזג האוויר של מחר מגיע מיד אחרי התאריך, לפני לוח הזמנים: משפט או שניים עם טיפ מעשי.',
        `כל אירוע מהסיכום נכנס, עם השעה שלו. מותר לאחד כמה אירועים קטנים ${oneUnit}.`,
        'ילדים: בקצרה ובטבעיות (למשל "לאסוף את דני בשתיים").',
        'מבט לשבוע, אם יש בסיכום: בקצרה, רק האירועים המרכזיים.',
        calm ? 'מחר בלי אירועים: אמרו ברוגע שהיומן של מחר פנוי. אל תמציאו אירועים.' : 'מחר בלי אירועים: אמרו שהיומן של מחר פנוי וחגגו את זה. אל תמציאו אירועים.',
        'סגירה שמתאימה לערב ומכינה למחר.',
      ],
      length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). ביום עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
      turns,
    };
  }

  return {
    goal: `היום של ${female ? 'המאזינה' : 'המאזין'}`,
    content: [
      'ברכת הפתיחה: אותה ברכה שהסיכום נפתח בה ("בוקר טוב", "צהריים טובים" או "ערב טוב"). אם אין בו ברכה כזו, אל תמציאו ברכה לפי שעה ביום.',
      context.culture === 'jewish'
        ? 'אמרו רק את התאריך העברי עם היום בשבוע (בלי תאריך לועזי ובלי שנה עברית).'
        : 'אמרו את התאריך עם היום בשבוע.',
      'מזג האוויר מגיע מיד אחרי התאריך, לפני לוח הזמנים: משפט או שניים עם טיפ מעשי.',
      `כל אירוע מהסיכום נכנס, עם השעה שלו. מותר לאחד כמה אירועים קטנים ${oneUnit}.`,
      'ילדים: בקצרה ובטבעיות (למשל "לאסוף את דני בשתיים").',
      'מבט לשבוע, אם יש בסיכום: בקצרה, רק האירועים המרכזיים.',
      calm ? 'יום בלי אירועים: אמרו ברוגע שהיומן פנוי. אל תמציאו אירועים.' : 'יום בלי אירועים: אמרו שהיומן פנוי וחגגו את זה. אל תמציאו אירועים.',
    ],
    length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). ביום עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
    turns,
  };
}

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

export function buildShowPrompt(context: ShowPromptContext): string {
  const female = context.listener.gender === 'female';
  const listener = female ? 'המאזינה' : 'המאזין';
  const { goal, content, length, turns: [minTurns, maxTurns] } = kindRules(context);

  const rules = buildRulesSection(context.globalRules, 'כללים אישיים של המשתמש (יש ליישם):');

  const allContent = [
    ...content,
    ...factRules(context),
    'ההתלהבות והבדיחות לא מוסיפות ולא משמיטות עובדות: אין אירועים, שעות, שמות או פרטים שלא מופיעים בסיכום.',
  ];

  return `אתם כותבים תסריט לתוכנית אודיו קצרה בעברית על ${goal}: שני מגישים נלהבים של תוכנית רדיו קצבית.

**המשפחה:**
${familyLines(context).join('\n')}
${rules}
**המגישים:**
- A: המגיש המוביל. חם, בטוח, סוף שנות השלושים.
- B: המגיש הצעיר. אנרגטי, שנות העשרים.
שניהם גברים ומדברים על עצמם בלשון זכר. אין להם שמות, ואל תמציאו להם.

**תוכן (חובה):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**סגנון:**
- אנרגיה של רדיו: קצב, התלהבות, מסירות בין המגישים, "יאללה", "איזה יום!". התוכנית היא לא שידור ספורט: אל תמסגרו את היום כמשחק. דימוי מעולם הספורט מותר רק כשהוא מתאים באופן טבעי למה שנאמר.
- ${addressRule(context)}
- רק ${listener} מקבל${female ? 'ת' : ''} פנייה בגוף שני. המגישים לא אומרים זה לזה "לך", "שלך", "אותך", "עליך", "איתך".
- ${POINTING_RULE}
- תורות קצרים: משפט או שניים בכל תור. המגישים מתחלפים ומגיבים זה לזה.
- אורך: ${length}
- פתיחה קצרה וסגירה קצרה ואנרגטית.

**מצב רוח (mood) לכל תור, אחד מהרשימה:**
- hype: ברירת המחדל, התלהבות של שדרן
- triumph: חגיגה (משהו משמח, סוף יום מוצלח)
- suspense: מתח לפני משהו גדול
- amused: משועשע
- surprised: מופתע
- mock_disappointed: אכזבה משחקית (גשם, השכמה מוקדמת)
- secret: סוד או רמז להפתעה
- warm: חם ורגוע (סגירה, רגע נוגע)
רוב התורות hype. שלבו 2-4 מצבי רוח אחרים במקומות שהתוכן מצדיק.

**צלילים:**
- ברירת המחדל היא בלי צלילים: ברוב התוכניות אין אף צליל, וזה בסדר.
- צליל בא רק כתגובה למשהו ממשי בתסריט: <laugh> או <chuckle> מיד אחרי משהו שבאמת מצחיק, באותו תור או בתור שלפניו; <sigh> כשהיום באמת כבד; <gasp> כשיש הפתעה אמיתית; <whispers> כשמגלים סוד אמיתי או רומזים על הפתעה שבסיכום; <throat-clearing> רגע לפני הכרזה גדולה באמת.
- אף פעם לא סתם בשביל האווירה, לא על משפט ניטרלי (אירוע ושעה ותו לא), ולא בתור הראשון או בתור האחרון של התוכנית.
- רק מהרשימה הזאת: ${SOUND_LIST}
- לכל היותר ${MAX_SOUNDS_PER_SHOW} בכל התוכנית, ולא בשני תורות רצופים.
- אין שום תגית אחרת: אין HTML, אין אימוג'י, אין markdown.
- אין קריאות ביניים בין קווים אנכיים כמו |וואו|. תגובה של מגיש היא תור קצר משלו, עם מילים: צליל לבד הוא לא תור.
- אל תכתבו "A:" או "B:" בתוך הטקסט.

**פלט:** JSON בלבד, בין ${minTurns} ל-${maxTurns} תורות:
{"turns":[{"host":"A","mood":"hype","text":"..."},{"host":"B","mood":"amused","text":"..."}]}

**הסיכום המקורי (עם עיצוב — התעלמו מהעיצוב):**
${context.summary}`;
}
