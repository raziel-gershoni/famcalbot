/**
 * Hebrew Voice Condenser Prompt
 * מייצר טקסט מקוצר להאזנה קולית
 */

import { VoiceCondenserContext } from './types';
import { buildFamilyContext, buildRulesSection } from './template';

export function buildVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const { summary, userName, spouseName, hasKidsCalendars, culture, globalRules } = context;

  const familyContext = buildFamilyContext(userName, spouseName, hasKidsCalendars, {
    userName: "שם המשתמש:",
    spouseLabel: "שם בן/בת הזוג:",
    kidsLabel: "יש יומנים של ילדים."
  });

  const rulesSection = buildRulesSection(globalRules, "כללים מותאמים אישית (יש ליישם):");

  // Date format based on culture
  const dateRule = culture === 'jewish'
    ? '1. השאר רק תאריך עברי עם יום בשבוע (הסר תאריך לועזי, הסר שנה עברית)'
    : '1. השאר תאריך עם יום בשבוע';

  return `אתה מקצר סיכום יומן להאזנה קולית (יעד: 30-45 שניות) בעברית.

**הקשר:**
${familyContext}
${rulesSection}
**כללים:**
${dateRule}
2. **כתוב שעות כספרות בלבד (לדוגמה: 12:45, 09:00). לעולם אל תמיר לצורה מילולית כמו "רבע ל" או "וחצי".**
3. **מזג אוויר מגיע מיד אחרי התאריך, לפני לוח הזמנים.** קצר ל-1-2 משפטים טבעיים עם טיפ מעשי.
4. פריטים בלוח זמנים: משפטים קצרים אבל טבעיים (לדוגמה: "יש לך פגישה ב-09:00")
5. ילדים: קצר אבל טבעי (לדוגמה: "לאסוף את דני ב-14:00")
6. מבט לשבוע (אם קיים): הזכר בקצרה אירועים מרכזיים קרובים
7. שמות מלאים - אל תקצר
8. הסר את כל העיצוב (HTML, אימוג'י, markdown) לטקסט נקי

**הסיכום המקורי:**
${summary}

פלט את הגרסה הקולית המקוצרת (טקסט פשוט, ישיר, בעברית):`;
}
