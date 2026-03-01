/**
 * English Calendar Summary Prompt
 */

import { SummaryPromptData } from './types';
import {
  buildGlobalRulesSection,
  buildCalendarRulesSection,
  buildDateInfoSection,
  DateInfoLabels
} from '../shared-builders';

// English labels for date info section
const DATE_INFO_LABELS: DateInfoLabels = {
  header: 'DATE INFORMATION:',
  currentDate: 'Current Date (Today)',
  summaryDate: 'Summary Date',
  hebrewDate: 'Hebrew Date (Summary)',
  roshChodesh: 'Rosh Chodesh',
  yes: 'YES',
  no: 'NO'
};

function buildSpouseContext(data: SummaryPromptData): string {
  if (!data.hasSpouseCalendar) return '';

  const spouseLabel = data.spouseName || 'Spouse';
  return `
2. **Spouse's Events** - These belong to the spouse
   - When referring to spouse by name, use: ${spouseLabel}
   - Personalize from user's perspective (e.g., "${spouseLabel} has a meeting at...")
`;
}

function buildKidsContext(data: SummaryPromptData): string {
  if (!data.hasKidsCalendars) {
    return `
3. **Other Events** - Shared family events and other calendars
   - Include these in a general "Other Events" section if any exist
`;
  }

  if (data.kidsNames && data.kidsNames.length > 0) {
    return `
3. **Other Events** - Kids' events and shared family events
   - Events tagged [Calendar: Child: Name] belong to that child
   - **CRITICAL: Do NOT extract child names from event titles.** The event title is the full event/institution name.
   - Example: "Tala Gan Gilad Mid-Year [Calendar: Child: Gilad]" → Gilad has a mid-year event at Tala Gan Gilad
     (NOT: "Gilad has a Tala meeting at Gan" — "Tala Gan Gilad" is the institution name)
   - **In pickup order: use the child's name, followed by location in parentheses**
`;
  }

  return `
3. **Other Events** - Kids' events and shared family events
   - **IMPORTANT: Do NOT confuse institution/location names with children's names**
   - Names appearing inside event titles (e.g., "Gan Gilad", "Tala", "Ramon School") are institution names, NOT children's names
   - **Identify children's names from calendar names only** (e.g., if calendar is named "Shira", the child is named Shira)
   - **In pickup order: use the child's name, followed by location in parentheses**
`;
}

function buildHebrewDateContext(data: SummaryPromptData): string {
  if (data.culture !== 'jewish') return '';

  return `
## Hebrew Calendar
- Include the Hebrew date in the summary header
- Hebrew Date: ${data.summaryHebrewDate}
- ${data.isRoshChodesh ? 'TODAY IS ROSH CHODESH - mention this in the header' : ''}
- Display Hebrew date using standard numerals (e.g., "28 Kislev 5785")
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
  const kidsContext = buildKidsContext(data);
  const hebrewDateContext = buildHebrewDateContext(data);
  const globalRules = buildGlobalRulesSection(data.globalRules, '## User\'s Custom Rules (ALWAYS apply these)');
  const calendarRules = buildCalendarRulesSection(data.calendarRules, '## Calendar-Specific Rules');
  const dateInfo = buildDateInfoSection(
    data.currentGregorianDate,
    data.summaryGregorianDate,
    data.culture,
    data.summaryHebrewDate,
    data.isRoshChodesh,
    DATE_INFO_LABELS
  );

  const spouseLabel = data.spouseName || 'Spouse';
  const spouseNameLine = data.hasSpouseCalendar
    ? `- Spouse: ${spouseLabel}${data.spouseGender ? ` (${data.spouseGender} - use appropriate English grammar forms)` : ''}`
    : '';

  const kidsNamesLine = data.kidsNames && data.kidsNames.length > 0
    ? `- Children: ${data.kidsNames.map(k => k.name).join(', ')}`
    : '';

  const spouseScheduleHeader = data.hasSpouseCalendar
    ? `<b>${data.spouseEnglishName || spouseLabel}'s Schedule:</b> [Only if ${spouseLabel} has events]
- HH:MM-HH:MM - [Activity/Work] ([Location if available])
[Chronological order by start time, include location when event has one]

`
    : '';

  const kidsScheduleSection = data.hasKidsCalendars
    ? `<b>Kids Start Times:</b>
- HH:MM - [Name1] ([Location1]), [Name2] ([Location2])
[Group children with same start time together on one line, sorted chronologically by time]

<b>Special Events:</b> [Only if kids have special events during the day]
- HH:MM-HH:MM - [Name] [Activity] ([Location])

<b>Pickup Order:</b> [ONLY KIDS - do NOT include spouse]

**CRITICAL: ALL kids MUST appear in this section - do NOT put any kid pickups in the note section!**

**ALGORITHM:**
1. Extract ALL kid pickup END times from events (every single kid must be included)
2. Sort times numerically in ascending order (e.g., 13:50 < 14:00 < 16:00)
3. For each time slot (in sorted order), list all kids with that exact time on one line
4. Output in this sorted time order
5. Do NOT skip any kids - ALL must be in this list

- HH:MM - [Name] ([Location])
- HH:MM - [Name1] ([Location1]), [Name2] ([Location2])

`
    : '';

  const insightSection = data.hasKidsCalendars
    ? `<b>Insight:</b> [ONE concise sentence (max 10-15 words) with a helpful observation, such as:]
- Pickup logistics: Who's available based on work schedules
- Continuous stays: If kid has back-to-back events at same location
- Conflicts: If pickups overlap or timing is tight
- OMIT this section entirely if there are no meaningful insights

`
    : '';

  const spouseEventsSection = data.hasSpouseCalendar && data.spouseEventsText
    ? `**SPOUSE'S EVENTS:**
${data.spouseEventsText}

`
    : '';

  const otherEventsHeader = data.hasKidsCalendars
    ? '**OTHER EVENTS (Kids & Family):**'
    : '**OTHER EVENTS:**';

  return `# Calendar Summary for ${data.userName}

Generate a personalized daily schedule summary in English.

**IMPORTANT: Names and grammar:**
- User: ${data.userName} (${data.userGender} - use appropriate English grammar forms)
${spouseNameLine}${kidsNamesLine ? `\n${kidsNamesLine}` : ''}

## Event Categories & Personalization
Events have been pre-categorized into groups:

1. **User's Events** - These are YOUR events (personal and work calendars)
   - Address these as "You have..." or "Your..."
   - When mentioning by name, use: ${data.userName}
${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}${calendarRules}
## Output Format
**IMPORTANT: Output EVERYTHING in English.**

<b>${data.greeting}</b>

<b>[DAY LABEL] - [Day], [Gregorian Date]${data.culture === 'jewish' ? ' ([Hebrew Date])' : ''}</b>
(Compare current date with summary date, use appropriate label for DAY LABEL)

<b>Your Schedule:</b> [Only if ${data.userName} has events]
- HH:MM-HH:MM - [Activity] ([Location if available])
[Chronological order by start time, include location when event has one]

${spouseScheduleHeader}${kidsScheduleSection}${insightSection}<b>Weather:</b> [ONLY if weather data is provided below]
**Create an insightful, actionable weather briefing (2-4 sentences) that integrates weather with the day's schedule:**

STRUCTURE:
1. Current conditions and day overview (temperature range, conditions)
2. **CRITICAL: If rain expected, include SPECIFIC hour spans (e.g., "Rain 14:00-18:00")**
3. Actionable recommendations based on schedule timing

**Be specific about timing and temperatures. Cross-reference weather timing with schedule events. Make it useful for planning the day.**
${data.weekLookahead ? `
<b>Looking Ahead:</b>
**Add a brief 2-3 sentence overview of key events coming up later in the week:**
- Highlight only the MOST important upcoming events (appointments, deadlines, special events)
- Use relative day references (e.g., "On Wednesday...", "Thursday you have...")
- Keep it brief - this is just a preview, not a full week summary
- Skip routine recurring events unless notable
` : ''}
## Guidelines
- **CRITICAL: EVERYTHING must be in English**
- **CRITICAL: Always use HH:MM format (24-hour, no AM/PM) - e.g., 08:00, 13:45, 20:15**
${data.hasKidsCalendars ? `- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
- **CRITICAL: Pickup Order: Group kids with SAME pickup time on ONE line together**
` : ''}- Use Telegram HTML tags for formatting: <b>bold</b>, <i>italic</i>, <u>underline</u>

---

${dateInfo}

**${data.userName}'S EVENTS:**
${data.userEventsText}

${spouseEventsSection}${otherEventsHeader}
${data.otherEventsText}
${data.weatherSummary ? `
**WEATHER INFORMATION:**
${data.weatherSummary}` : ''}
${data.weekLookahead ? `
**WEEK LOOKAHEAD (events after tomorrow):**
${data.weekLookahead}` : ''}

**CRITICAL: Respond in English only. Write your entire summary in English.**`;
}
