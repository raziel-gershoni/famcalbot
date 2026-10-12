/**
 * Hebrew two-host show prompt
 * תסריט לשני מגישים בסגנון שדרני ספורט, כפלט JSON של תורות.
 *
 * Content rules carry over from ../voice-condenser/he.ts and week-he.ts: every event
 * kept, every time in words, weather right after the date, birthday names, the user's
 * own rules. The show rules add the hosts, personal address, moods and sounds.
 */

import { sanitizeForPrompt } from '../shared-builders';
import { buildRulesSection } from '../voice-condenser/template';
import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS } from '../../services/voice-show/types';
import type { ShowPerson, ShowPromptContext } from './types';

const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');

function personLine(label: string, person: ShowPerson): string {
  const name = sanitizeForPrompt(person.name);
  if (person.gender === 'male') return `${label}: ${name} (זכר — דברו עליו בלשון זכר)`;
  if (person.gender === 'female') return `${label}: ${name} (נקבה — דברו עליה בלשון נקבה)`;
  return `${label}: ${name} (מין לא ידוע — השתמשו בשם ובניסוח שלא מסגיר מין, למשל "ל${name} יש..." במקום "הוא" או "היא")`;
}

function listenerLine(context: ShowPromptContext): string {
  const name = sanitizeForPrompt(context.listener.name);
  return context.listener.gender === 'female'
    ? `המאזינה: ${name}. היא אישה — פנו אליה בשמה ובלשון נקבה ("את", "יש לך", "תזכרי", "מוכנה").`
    : `המאזין: ${name}. הוא גבר — פנו אליו בשמו ובלשון זכר ("אתה", "יש לך", "תזכור", "מוכן").`;
}

interface KindRules {
  goal: string;
  content: string[];
  length: string;
  /** Turn count asked for in the output line. */
  turns: [min: number, max: number];
}

function kindRules(context: ShowPromptContext): KindRules {
  const female = context.listener.gender === 'female';
  if (context.kind === 'weekly') {
    const weekRef = context.isNextWeek ? 'בשבוע הבא' : 'השבוע';
    return {
      goal: `מה שמחכה ${female ? 'למאזינה' : 'למאזין'} ${weekRef}`,
      content: [
        `פתחו בסקירה קצרה (למשל "הנה מה שמחכה לך ${weekRef}").`,
        context.culture === 'jewish'
          ? 'השתמשו בתאריכים עבריים (בלי תאריכים לועזיים ובלי שנה עברית).'
          : 'השתמשו בתאריכים לועזיים.',
        'עברו יום אחרי יום, עם ימים יחסיים ("ביום שלישי", "ביום חמישי"), והדגישו את האירועים החשובים.',
        'כל אירוע מהסיכום נכנס, עם היום והשעה שלו. מותר לאחד כמה אירועים של אותו יום בתור אחד.',
        'לאירועי משפחה ציינו בטבעיות של מי האירוע.',
        'שבוע בלי אירועים: אמרו שהיומן פנוי. אל תמציאו אירועים.',
      ],
      length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). בשבוע עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
      turns: [6, 20],
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
        'השבוע: תור או שניים, רק המגמה והשינויים הבולטים. כאן מותר לסכם ולקבץ ימים.',
        'התחזית המורחבת: לכל היותר משפט אחד, בזהירות ("כנראה", "צפוי").',
        'סיימו בטיפ מעשי אחד (מטרייה, קרם הגנה, שכבה נוספת).',
      ],
      length: 'כ-35-50 שניות דיבור (בערך 85-120 מילים), 6-10 תורות.',
      turns: [6, 10],
    };
  }

  // The tomorrow summary goes out in the evening. Without these rules the writer opened
  // with "בוקר טוב" and "היום" even when the summary itself said "ערב טוב" and "מחר".
  if (context.kind === 'tomorrow') {
    return {
      goal: `מה שמחכה ${female ? 'למאזינה' : 'למאזין'} מחר`,
      content: [
        'ברכת הפתיחה מתאימה לערב: אותה ברכה שהסיכום נפתח בה (בדרך כלל "ערב טוב"). לעולם לא "בוקר טוב" — אם הסיכום נפתח בה, פתחו בשם בלי ברכה של שעה ביום.',
        context.culture === 'jewish'
          ? 'אמרו "מחר" כבר במשפט הפתיחה: זה הלוח של מחר. אחריו התאריך העברי של מחר עם היום בשבוע (בלי תאריך לועזי ובלי שנה עברית), למשל "מחר, יום שני, ...".'
          : 'אמרו "מחר" כבר במשפט הפתיחה: זה הלוח של מחר. אחריו התאריך של מחר עם היום בשבוע, למשל "מחר, יום שני, ...".',
        'כל מה שבסיכום קורה מחר. לעולם אל תקראו לו "היום": לא "היום יום שני", לא "בהמשך היום", ולא "הערב" על ערב של מחר. אמרו "מחר", "מחר בבוקר", "מחר בערב".',
        'מזג האוויר של מחר מגיע מיד אחרי התאריך, לפני לוח הזמנים: משפט או שניים עם טיפ מעשי.',
        'כל אירוע מהסיכום נכנס, עם השעה שלו. מותר לאחד כמה אירועים קטנים בתור אחד.',
        'ילדים: בקצרה ובטבעיות (למשל "לאסוף את דני בשתיים").',
        'מבט לשבוע, אם יש בסיכום: בקצרה, רק האירועים המרכזיים.',
        'מחר בלי אירועים: אמרו שהיומן של מחר פנוי וחגגו את זה. אל תמציאו אירועים.',
        'סגירה שמתאימה לערב ומכינה למחר.',
      ],
      length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). ביום עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
      turns: [6, 20],
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
      'כל אירוע מהסיכום נכנס, עם השעה שלו. מותר לאחד כמה אירועים קטנים בתור אחד.',
      'ילדים: בקצרה ובטבעיות (למשל "לאסוף את דני בשתיים").',
      'מבט לשבוע, אם יש בסיכום: בקצרה, רק האירועים המרכזיים.',
      'יום בלי אירועים: אמרו שהיומן פנוי וחגגו את זה. אל תמציאו אירועים.',
    ],
    length: 'כ-45-60 שניות דיבור (בערך 110-150 מילים). ביום עמוס מותר יותר, אבל אף פעם לא על חשבון אירועים.',
    turns: [6, 20],
  };
}

export function buildShowPrompt(context: ShowPromptContext): string {
  const female = context.listener.gender === 'female';
  const listener = female ? 'המאזינה' : 'המאזין';
  const toListener = female ? 'אליה' : 'אליו';
  const { goal, content, length, turns: [minTurns, maxTurns] } = kindRules(context);

  const family = [listenerLine(context)];
  if (context.spouse) family.push(personLine('בן או בת הזוג', context.spouse));
  for (const kid of context.kids) family.push(personLine('ילד או ילדה', kid));
  if (!context.kids.length && context.hasKidsCalendars) family.push('יש יומנים של ילדים.');

  const rules = buildRulesSection(context.globalRules, 'כללים אישיים של המשתמש (יש ליישם):');

  const allContent = [
    ...content,
    'כל השעות במילים מלאות, לא בספרות: "תשע בבוקר", "עשר ורבע", "אחת עשרה וחצי", "ארבע וחצי אחר הצהריים".',
    'גם שאר המספרים במילים, למשל טמפרטורות ("עשרים ושמונה מעלות").',
    'ימי הולדת: הוציאו את שם האדם מהאירוע ("יום ההולדת של יוחנן").',
    'שמות מלאים, בלי קיצורים.',
    'ההתלהבות והבדיחות לא מוסיפות ולא משמיטות עובדות: אין אירועים, שעות, שמות או פרטים שלא מופיעים בסיכום.',
  ];

  return `אתם כותבים תסריט לתוכנית אודיו קצרה בעברית על ${goal}: שני מגישים נלהבים, בסגנון שדרני ספורט.

**המשפחה:**
${family.join('\n')}
${rules}
**המגישים:**
- A: המגיש המוביל. חם, בטוח, סוף שנות השלושים.
- B: המגיש הצעיר. אנרגטי, שנות העשרים.
שניהם גברים ומדברים על עצמם בלשון זכר. אין להם שמות, ואל תמציאו להם.

**תוכן (חובה):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**סגנון:**
- אנרגיה של שידור ספורט: קצב, התלהבות, מסירות בין המגישים, "יאללה", "איזה יום!".
- פנייה אישית: הזכירו את השם כבר בפתיחה, ודברו ${toListener} ישירות בגוף שני ובלשון הנכונה. לא "יש לכם" — "יש לך".
- רק ${listener} מקבל${female ? 'ת' : ''} פנייה בגוף שני. המגישים לא אומרים זה לזה "לך", "שלך", "אותך", "עליך", "איתך".
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
- secret: לחישה סודית (רמז, הפתעה)
- warm: חם ורגוע (סגירה, רגע נוגע)
רוב התורות hype. שלבו 2-4 מצבי רוח אחרים במקומות שהתוכן מצדיק.

**צלילים:**
- אפשר להכניס לתוך הטקסט צליל אחד או שניים מהרשימה הזאת בלבד: ${SOUND_LIST}
- לכל היותר ${MAX_SOUNDS_PER_SHOW} בכל התוכנית, ולא בשני תורות רצופים. רק ברגע שמצדיק אותם.
- אין שום תגית אחרת: אין HTML, אין אימוג'י, אין markdown.
- אין קריאות ביניים בין קווים אנכיים כמו |וואו|. תגובה של מגיש היא תור קצר משלו.
- אל תכתבו "A:" או "B:" בתוך הטקסט.

**פלט:** JSON בלבד, בין ${minTurns} ל-${maxTurns} תורות:
{"turns":[{"host":"A","mood":"hype","text":"..."},{"host":"B","mood":"amused","text":"..."}]}

**הסיכום המקורי (עם עיצוב — התעלמו מהעיצוב):**
${context.summary}`;
}
