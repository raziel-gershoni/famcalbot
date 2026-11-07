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
- רגוע, חם ונינוח, בקצב אחיד של רדיו שקט. בלי התלהבות, בלי קריאות כמו "יאללה" או "איזה יום!", בלי בדיחות ובלי דימויים מעולם הספורט.
- ${addressRule(context)}
- ${POINTING_RULE}
- פסקאות: בכל פסקה משפט אחד עד שלושה, עד כ-350 תווים, על נושא אחד (הפתיחה והתאריך, מזג האוויר, האירועים, המבט לשבוע, הסגירה). הרבה אירועים נפרסים על כמה פסקאות, אחד או שניים בכל פסקה, ולא כולם בפסקה אחת.
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
