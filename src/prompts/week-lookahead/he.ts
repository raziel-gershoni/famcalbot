/**
 * Hebrew Week Lookahead Prompt
 */

import { WeekLookaheadPromptData, LookaheadDayData } from './types';

function buildSpouseContext(data: WeekLookaheadPromptData): string {
  if (!data.hasSpouseCalendar) return '';

  const spouseLabel = data.spouseName || 'בן/בת הזוג';
  return `
- **אירועי בן/בת זוג**: שייכים ל${spouseLabel} - ציין כ"ל${spouseLabel} יש..." (אל תוסיף "מהיומן של..." - זה כבר ברור מההקשר)`;
}

function buildKidsContext(data: WeekLookaheadPromptData): string {
  if (!data.hasKidsCalendars) return '';

  return `
- **אירועי ילדים**: זהה ילדים לפי שם היומן או תוכן האירוע - ציין כ"ל[שם הילד] יש..."`;
}

function buildHebrewDateContext(data: WeekLookaheadPromptData): string {
  if (data.culture !== 'jewish') return '';

  // Use weekStartHebrew for next week summaries, todayHebrew for regular lookahead
  const startHebrew = data.weekStartHebrew || data.todayHebrew;
  return `
## לוח עברי
- כלול תאריכים עבריים לצד התאריכים הלועזיים
- תחילת השבוע: ${startHebrew}
- סוף השבוע: ${data.weekEndHebrew}`;
}

function buildGlobalRules(data: WeekLookaheadPromptData): string {
  if (!data.globalRules || data.globalRules.length === 0) return '';

  const rules = data.globalRules
    .filter(r => r.trim())
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');

  if (!rules) return '';

  return `
## כללים מותאמים של המשתמש (החל כשרלוונטי)
${rules}`;
}

function formatEventsForDay(day: LookaheadDayData): string {
  const lines = day.events.map(event => {
    const recurNote = event.isRecurring && event.recurrenceType
      ? ` [${event.recurrenceType === 'monthly' ? 'חודשי' : event.recurrenceType === 'yearly' ? 'שנתי' : 'שבועי'}]`
      : '';
    return `  - ${event.time} - ${event.summary} (${event.calendarName})${recurNote}`;
  });
  return lines.join('\n');
}

function buildEventsSection(data: WeekLookaheadPromptData): string {
  if (data.eventsByDay.length === 0) {
    return `**אירועים:**
אין אירועים מיוחדים לתקופה זו.`;
  }

  const days = data.eventsByDay.map(day => {
    const hebrewPart = day.hebrewDate ? ` (${day.hebrewDate})` : '';
    return `**${day.dayLabel}${hebrewPart}** - ${day.relativeLabel}
${formatEventsForDay(day)}`;
  });

  return `**אירועים לפי יום:**

${days.join('\n\n')}`;
}

export function buildWeekLookaheadPrompt(data: WeekLookaheadPromptData): string {
  const spouseContext = buildSpouseContext(data);
  const kidsContext = buildKidsContext(data);
  const hebrewDateContext = buildHebrewDateContext(data);
  const globalRules = buildGlobalRules(data);
  const eventsSection = buildEventsSection(data);

  const genderForm = data.userGender === 'female' ? 'לך' : 'לך';

  // Use weekStartGregorian for next week summaries, todayGregorian for regular lookahead
  const rangeStart = data.weekStartGregorian || data.todayGregorian;
  const rangeStartHebrew = data.weekStartHebrew || data.todayHebrew;
  const isNextWeek = !!data.weekStartGregorian;
  const title = isNextWeek ? 'תצוגה מקדימה לשבוע הבא' : 'תצוגה מקדימה לשבוע';
  const headerTitle = isNextWeek ? 'שבוע הבא' : 'מבט לשבוע הקרוב';

  return `# ${title} עבור ${data.userName}

צור תצוגה מקדימה תמציתית ${isNextWeek ? 'לשבוע הבא' : 'לשבוע'} בעברית.
${isNextWeek ? `\n**חשוב**: זו תצוגה של שבוע הבא (${rangeStart} - ${data.weekEndGregorian}), לא השבוע הנוכחי. היום הוא ${data.todayGregorian}.\n` : ''}
## טווח השבוע
מ: ${rangeStart} עד ${data.weekEndGregorian}
סה"כ: ${data.totalEvents} אירועים ב-${data.totalDays} ימים

## בעלות על יומנים
כשמזכירים אירועים, תמיד ציין לאיזה יומן הם שייכים:
- **האירועים שלך**: אלה האירועים של ${data.userName} - ציין כ"יש ${genderForm}..." או "ה[אירוע] שלך"${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}
## פורמט הפלט
צור תצוגה מקדימה ידידותית ושיחתית. מבנה:

<b>${headerTitle}</b>
<b>${rangeStart} - ${data.weekEndGregorian}</b>${data.culture === 'jewish' ? `
<i>${rangeStartHebrew} - ${data.weekEndHebrew}</i>` : ''}

[לכל יום עם אירועים, צור סיכום קצר שמציין:]
- יום ותאריך
- אירועים מרכזיים עם שעות בפורמט HH:MM
- מקור היומן לכל אירוע
- ציין דפוסים חוזרים (בדיקות חודשיות, חידושים שנתיים)

[סיים עם הערה קצרה על אירועים שדורשים הכנה]

## הנחיות
- **היה שיחתי אך תמציתי** - זו התראה מהירה, לא סיכום מפורט
- **ייחוס יומן** - לאירועים שלך ציין מקור (לדוגמה, "מיומן העבודה שלך"). לבן/בת זוג או ילדים, השם כבר מרמז על המקור - אל תחזור.
- **הדגש אירועים חוזרים** - אם משהו חודשי/שנתי, ציין זאת (לדוגמה, "בדיקה חודשית")
- **פורמט שעות**: תמיד השתמש ב-HH:MM (24 שעות) - לדוגמה, 08:00, 14:30
- **פורמט**: השתמש בתגי HTML של טלגרם: <b>מודגש</b>, <i>נטוי</i>
- **אם אין אירועים**: שמור על קיצור - פשוט ציין שהשבוע נראה פנוי
${isNextWeek ? '- **אל תגיד "היום"** - התייחס לימים בשמותם (ראשון, שני וכו\')' : '- **השתמש בהתייחסויות יחסיות** - "מחר", "בעוד 3 ימים" לצד תאריכים'}

---

${eventsSection}

**קריטי: ענה בעברית בלבד. היה תמציתי ושיחתי.**`;
}
