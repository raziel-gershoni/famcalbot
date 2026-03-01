/**
 * Hebrew Calendar Summary Prompt
 * כל ההוראות בעברית כדי שכללים בעברית יובנו בצורה טבעית
 */

import { SummaryPromptData } from './types';
import {
  buildGlobalRulesSection,
  buildCalendarRulesSection,
  buildDateInfoSection,
  DateInfoLabels
} from '../shared-builders';

// Hebrew labels for date info section
const DATE_INFO_LABELS: DateInfoLabels = {
  header: 'מידע על תאריכים:',
  currentDate: 'תאריך נוכחי (היום)',
  summaryDate: 'תאריך הסיכום',
  hebrewDate: 'תאריך עברי (סיכום)',
  roshChodesh: 'ראש חודש',
  yes: 'כן',
  no: 'לא'
};

function buildSpouseContext(data: SummaryPromptData): string {
  if (!data.hasSpouseCalendar) return '';

  const spouseLabel = data.spouseName || 'בן/בת הזוג';
  return `
2. **אירועי בן/בת הזוג** - אלו אירועים של בן/בת הזוג
   - כשמתייחסים לבן/בת הזוג בשם, השתמש ב: ${spouseLabel}
   - התאם את הפנייה מנקודת המבט של המשתמש (לדוגמה: "ל${spouseLabel} יש פגישה ב...")
`;
}

function buildKidsContext(data: SummaryPromptData): string {
  if (!data.hasKidsCalendars) {
    return `
3. **אירועים אחרים** - אירועים משפחתיים משותפים ויומנים אחרים
   - כלול אותם בסעיף "אירועים אחרים" אם יש כאלה
`;
  }

  if (data.kidsNames && data.kidsNames.length > 0) {
    return `
3. **אירועים אחרים** - אירועי ילדים ואירועים משפחתיים
   - אירועים עם תגית [Calendar: Child: שם] שייכים לאותו ילד
   - **קריטי: אל תחלץ שמות ילדים מכותרות אירועים.** כותרת האירוע היא שם האירוע/המוסד המלא.
   - דוגמה: "תלא גן גלעד אמצע שנה [Calendar: Child: גלעד]" → לגלעד יש אירוע אמצע שנה בתלא גן גלעד
     (ולא: "לגלעד יש מפגש תלא בגן" — "תלא גן גלעד" הוא שם המוסד)
   - **בסדר האיסוף: השתמש בשם הילד, ואחריו המיקום בסוגריים**
`;
  }

  return `
3. **אירועים אחרים** - אירועי ילדים ואירועים משפחתיים
   - **חשוב: אל תבלבל בין שמות מיקומים/מוסדות לשמות ילדים**
   - שמות שמופיעים בתוך שמות אירועים (כגון "גן גלעד", "תלא", "בית ספר רמון") הם שמות מוסדות, לא שמות ילדים
   - **זהה שמות ילדים משמות היומנים בלבד** (לדוגמה: אם היומן נקרא "שירה", הילדה נקראת שירה)
   - **בסדר האיסוף: השתמש בשם הילד, ואחריו המיקום בסוגריים**
`;
}

function buildHebrewDateContext(data: SummaryPromptData): string {
  if (data.culture !== 'jewish') return '';

  return `
## לוח עברי
- כלול את התאריך העברי בכותרת הסיכום
- תאריך עברי: ${data.summaryHebrewDate}
- ${data.isRoshChodesh ? 'היום ראש חודש - ציין זאת בכותרת' : ''}
- השתמש בגימטריה לתאריך העברי (כ"ח כסלו תשפ"ה)
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
  const kidsContext = buildKidsContext(data);
  const hebrewDateContext = buildHebrewDateContext(data);
  const globalRules = buildGlobalRulesSection(data.globalRules, '## כללים מותאמים אישית (יש ליישם תמיד)');
  const calendarRules = buildCalendarRulesSection(data.calendarRules, '## כללים ספציפיים ליומן');
  const dateInfo = buildDateInfoSection(
    data.currentGregorianDate,
    data.summaryGregorianDate,
    data.culture,
    data.summaryHebrewDate,
    data.isRoshChodesh,
    DATE_INFO_LABELS
  );

  const spouseLabel = data.spouseName || 'בן/בת הזוג';
  const genderText = data.spouseGender ? (data.spouseGender === 'male' ? 'זכר' : 'נקבה') : null;
  const spouseNameLine = data.hasSpouseCalendar
    ? `- בן/בת זוג: ${spouseLabel}${genderText ? ` (${genderText} - השתמש בצורות דקדוק מתאימות)` : ''}`
    : '';

  const kidsNamesLine = data.kidsNames && data.kidsNames.length > 0
    ? `- ילדים: ${data.kidsNames.map(k => k.name).join(', ')}`
    : '';

  const spouseScheduleHeader = data.hasSpouseCalendar
    ? `<b>לוח הזמנים של ${spouseLabel}:</b> [רק אם ל${spouseLabel} יש אירועים]
- HH:MM-HH:MM - [פעילות/עבודה] ([מיקום אם זמין])
[סדר כרונולוגי לפי שעת התחלה, כלול מיקום כשיש]

`
    : '';

  const kidsScheduleSection = data.hasKidsCalendars
    ? `<b>שעות התחלה של הילדים:</b>
- HH:MM - [שם1] ([מיקום1]), [שם2] ([מיקום2])
[קבץ ילדים עם אותה שעת התחלה בשורה אחת, ממוין כרונולוגית]

<b>אירועים מיוחדים:</b> [רק אם לילדים יש אירועים מיוחדים במהלך היום]
- HH:MM-HH:MM - [שם] [פעילות] ([מיקום])

<b>סדר איסוף:</b> [רק ילדים - אל תכלול בן/בת זוג]

**קריטי: כל הילדים חייבים להופיע בסעיף הזה - אל תשים איסופי ילדים בסעיף ההערות!**

**אלגוריתם:**
1. חלץ את כל שעות הסיום של איסוף ילדים מהאירועים (כל ילד חייב להיכלל)
2. מיין את השעות בסדר עולה (לדוגמה: 13:50 < 14:00 < 16:00)
3. לכל משבצת זמן (בסדר ממוין), רשום את כל הילדים עם אותה שעה בשורה אחת
4. פלט בסדר הזמנים הממוין
5. אל תדלג על ילדים - כולם חייבים להופיע ברשימה

- HH:MM - [שם] ([מיקום])
- HH:MM - [שם1] ([מיקום1]), [שם2] ([מיקום2])

`
    : '';

  const insightSection = data.hasKidsCalendars
    ? `<b>תובנה:</b> [משפט אחד קצר (מקסימום 10-15 מילים) עם תצפית מועילה, כגון:]
- לוגיסטיקת איסוף: מי פנוי בהתאם ללוחות זמנים של עבודה
- שהייה רציפה: אם לילד יש אירועים רצופים באותו מיקום
- התנגשויות: אם איסופים חופפים או התזמון צפוף
- השמט סעיף זה לחלוטין אם אין תובנות משמעותיות

`
    : '';

  const spouseEventsSection = data.hasSpouseCalendar && data.spouseEventsText
    ? `**אירועי בן/בת הזוג:**
${data.spouseEventsText}

`
    : '';

  const otherEventsHeader = data.hasKidsCalendars
    ? '**אירועים אחרים (ילדים ומשפחה):**'
    : '**אירועים אחרים:**';

  return `# סיכום יומן עבור ${data.userName}

צור סיכום לוח זמנים יומי מותאם אישית בעברית.

**חשוב: שמות ודקדוק:**
- משתמש: ${data.userName} (${data.userGender === 'male' ? 'זכר' : 'נקבה'} - השתמש בצורות דקדוק מתאימות)
${spouseNameLine}${kidsNamesLine ? `\n${kidsNamesLine}` : ''}

## קטגוריות אירועים והתאמה אישית
האירועים מחולקים מראש לקבוצות:

1. **האירועים שלך** - אלו האירועים שלך (יומנים אישיים ועבודה)
   - פנה אליהם כ"יש לך..." או "ה... שלך"
   - כשמזכירים בשם, השתמש ב: ${data.userName}
${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}${calendarRules}
## פורמט פלט
**חשוב: כתוב הכל בעברית.**

<b>${data.greeting}</b>

<b>[תווית יום] - [יום], [תאריך לועזי]${data.culture === 'jewish' ? ' ([תאריך עברי])' : ''}</b>
(השווה את התאריך הנוכחי לתאריך הסיכום, השתמש בתווית מתאימה)

<b>לוח הזמנים שלך:</b> [רק אם ל${data.userName} יש אירועים]
- HH:MM-HH:MM - [פעילות] ([מיקום אם זמין])
[סדר כרונולוגי לפי שעת התחלה, כלול מיקום כשיש]

${spouseScheduleHeader}${kidsScheduleSection}${insightSection}<b>מזג אוויר:</b> [רק אם יש מידע על מזג אוויר למטה]
**צור תדריך מזג אוויר מעשי ומועיל (2-4 משפטים) שמשלב מזג אוויר עם לוח הזמנים:**

מבנה:
1. תנאים נוכחיים וסקירת היום (טווח טמפרטורות, תנאים)
2. **קריטי: אם צפוי גשם, כלול שעות ספציפיות (לדוגמה: "גשם 14:00-18:00")**
3. המלצות מעשיות בהתאם לתזמון הלוח

**היה ספציפי לגבי תזמון וטמפרטורות. הצלב עם אירועי הלוח. הפוך את זה לשימושי לתכנון היום.**
${data.weekLookahead ? `
<b>מבט לשבוע:</b>
**הוסף סקירה קצרה של 2-3 משפטים על אירועים מרכזיים בהמשך השבוע:**
- הדגש רק את האירועים החשובים ביותר (פגישות, מועדים, אירועים מיוחדים)
- השתמש בהתייחסויות יחסיות לימים (לדוגמה: "ביום רביעי...", "ביום חמישי יש לך...")
- שמור על קיצור - זו רק תצוגה מקדימה, לא סיכום שבועי מלא
- דלג על אירועים שגרתיים חוזרים אלא אם הם חשובים
` : ''}
## הנחיות
- **קריטי: הכל חייב להיות בעברית**
- **קריטי: תמיד השתמש בפורמט HH:MM (24 שעות, בלי AM/PM) - לדוגמה: 08:00, 13:45, 20:15**
${data.hasKidsCalendars ? `- **קריטי: סדר האיסוף חייב להיות ממוין כרונולוגית לפי שעה (הכי מוקדם קודם)**
- **קריטי: סדר איסוף: קבץ ילדים עם אותה שעת איסוף בשורה אחת**
` : ''}- השתמש בתגיות HTML של טלגרם לעיצוב: <b>מודגש</b>, <i>נטוי</i>, <u>קו תחתון</u>

---

${dateInfo}

**האירועים של ${data.userName}:**
${data.userEventsText}

${spouseEventsSection}${otherEventsHeader}
${data.otherEventsText}
${data.weatherSummary ? `
**מידע על מזג אוויר:**
${data.weatherSummary}` : ''}
${data.weekLookahead ? `
**תצוגה שבועית (אירועים אחרי מחר):**
${data.weekLookahead}` : ''}

**קריטי: ענה בעברית בלבד. כתוב את כל הסיכום בעברית.**`;
}
