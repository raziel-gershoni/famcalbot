/**
 * Hebrew Weekly Voice Condenser Prompt
 * מייצר טקסט שבועי מקוצר להאזנה קולית
 */

import { VoiceCondenserContext } from './types';

export function buildWeeklyVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const { summary, userName, spouseName, hasKidsCalendars, culture, globalRules, isNextWeek } = context;

  const weekRef = isNextWeek ? 'לשבוע הבא' : 'השבוע';

  // Build context section in Hebrew
  let familyContext = `שם המשתמש: ${userName}.`;
  if (spouseName) {
    familyContext += ` שם בן/בת הזוג: ${spouseName}.`;
  }
  if (hasKidsCalendars) {
    familyContext += ` יש יומנים של ילדים.`;
  }

  // Build rules section if applicable
  const rulesSection = globalRules?.length
    ? `\n**כללים מותאמים אישית (יש ליישם):**\n${globalRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
    : '';

  // Date format based on culture
  const dateNote = culture === 'jewish'
    ? 'השתמש בתאריכים עבריים (הסר תאריכים לועזיים ושנה עברית)'
    : 'השתמש בתאריכים לועזיים';

  return `אתה מקצר תצוגה שבועית של יומן להאזנה קולית (יעד: 30-45 שניות) בעברית.

**הקשר:**
${familyContext}
${rulesSection}
**כללים:**
1. התחל עם סקירת השבוע (לדוגמה: "הנה מה שמחכה לך ${weekRef}")
2. ${dateNote}
3. **כתוב את כל השעות כמילים מלאות, לעולם לא כספרות. דוגמאות: "תשע בבוקר", "שתים עשרה וארבעים וחמש", "ארבע וחצי אחר הצהריים".**
4. קבץ לפי יום, הדגש את האירועים הכי חשובים
5. השתמש בהתייחסויות יום יחסיות (לדוגמה: "ביום שלישי", "ביום חמישי")
6. לאירועי משפחה: ציין של מי בצורה טבעית ("ל${spouseName || 'בן/בת הזוג'} יש..." או "לילדים יש...")
7. שמות מלאים - אל תקצר
8. **ימי הולדת**: חלץ את שם האדם מאירוע יום הולדת (לדוגמה: "יום ההולדת של יוחנן" → אמור "יום הולדת של יוחנן")
9. הסר את כל העיצוב (HTML, אימוג'י, markdown) לטקסט נקי

**הסיכום השבועי המקורי:**
${summary}

פלט את הגרסה הקולית המקוצרת (טקסט פשוט, ישיר, בעברית):`;
}
