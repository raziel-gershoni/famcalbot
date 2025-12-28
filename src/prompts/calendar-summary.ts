/**
 * Calendar Summary Prompt Template
 * Separated from business logic for easier maintenance, testing, and versioning
 */

import { getLanguageFromLocale } from '../utils/locale';

export interface SummaryPromptData {
  userName: string;
  userEnglishName: string;
  userGender: 'male' | 'female';
  spouseName?: string;        // Optional - only if spouse calendar exists
  spouseEnglishName?: string; // Optional - only if spouse calendar exists
  spouseGender?: 'male' | 'female'; // Optional - only if spouse calendar exists
  currentGregorianDate: string;
  summaryGregorianDate: string;
  summaryHebrewDate: string;
  isRoshChodesh: boolean;
  greeting: string;
  userEventsText: string;
  spouseEventsText: string;
  otherEventsText: string;
  weatherSummary?: string;  // AI-generated weather summary with tips
  language?: string;  // Target language for summary (e.g., "Hebrew", "English", "Spanish"). If not set, defaults to English.
  // New fields for public release
  culture?: string;  // 'jewish' | 'default'
  globalRules?: string[];  // User's global rules (max 3)
  calendarRules?: { calendarName: string; rule: string }[];  // Per-calendar rules
  hasKidsCalendars?: boolean;  // Whether user has kids calendars configured
}

/**
 * Build spouse context section (only if spouse calendar exists)
 */
function buildSpouseContext(data: SummaryPromptData, targetLanguage: string): string {
  if (!data.spouseName) {
    return '';
  }

  return `
2. **Spouse's Events** - These belong to the spouse
   - When referring to spouse by name, use: ${data.spouseName}
   - Personalize from user's perspective (e.g., "${data.spouseName} has a meeting at...")
`;
}

/**
 * Build kids context section
 */
function buildKidsContext(data: SummaryPromptData): string {
  if (!data.hasKidsCalendars) {
    return `
3. **Other Events** - Shared family events and other calendars
   - Include these in a general "Other Events" section if any exist
`;
  }

  return `
3. **Other Events** - Kids' events and shared family events
   - **Identify children's names from calendar names or event content** (e.g., if calendar is named "Shira" or event is "Shira's dentist", the child is named Shira)
   - **IMPORTANT: Do NOT confuse location names with people's names**
   - Example: A location ending in "kindergarten" or "gan" is a LOCATION, not a person
   - **In pickup order: use the child's name, followed by location in parentheses**
`;
}

/**
 * Build Hebrew date section (only for Jewish culture)
 */
function buildHebrewDateContext(data: SummaryPromptData, localeCode: string): string {
  if (data.culture !== 'jewish') {
    return '';
  }

  const hebrewDateFormat = localeCode === 'he'
    ? '- Always display Hebrew date using Gematria (Hebrew numerals) not Arabic numbers'
    : '- Display Hebrew date using standard numerals (e.g., "28 Kislev 5785")';

  return `
## Hebrew Calendar
- Include the Hebrew date in the summary header
- Hebrew Date: ${data.summaryHebrewDate}
- ${data.isRoshChodesh ? 'TODAY IS ROSH CHODESH - mention this in the header' : ''}
${hebrewDateFormat}
`;
}

/**
 * Build global rules section
 */
function buildGlobalRules(data: SummaryPromptData): string {
  if (!data.globalRules || data.globalRules.length === 0) {
    return '';
  }

  const rules = data.globalRules
    .filter(r => r.trim())
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');

  if (!rules) {
    return '';
  }

  return `
## User's Custom Rules (ALWAYS apply these)
${rules}
`;
}

/**
 * Build per-calendar rules section
 */
function buildCalendarRules(data: SummaryPromptData): string {
  if (!data.calendarRules || data.calendarRules.length === 0) {
    return '';
  }

  const rules = data.calendarRules
    .filter(r => r.rule?.trim())
    .map(r => `- **${r.calendarName}**: ${r.rule}`)
    .join('\n');

  if (!rules) {
    return '';
  }

  return `
## Calendar-Specific Rules
${rules}
`;
}

/**
 * Build the date information section
 */
function buildDateInfo(data: SummaryPromptData): string {
  let dateInfo = `**DATE INFORMATION:**
- Current Date (Today): ${data.currentGregorianDate}
- Summary Date: ${data.summaryGregorianDate}`;

  if (data.culture === 'jewish') {
    dateInfo += `
- Hebrew Date (Summary): ${data.summaryHebrewDate}
- Rosh Chodesh: ${data.isRoshChodesh ? 'YES' : 'NO'}`;
  }

  return dateInfo;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const localeCode = data.language || 'en';
  const targetLanguage = getLanguageFromLocale(localeCode);

  // Build conditional sections
  const spouseContext = buildSpouseContext(data, targetLanguage);
  const kidsContext = buildKidsContext(data);
  const hebrewDateContext = buildHebrewDateContext(data, localeCode);
  const globalRules = buildGlobalRules(data);
  const calendarRules = buildCalendarRules(data);
  const dateInfo = buildDateInfo(data);

  // Build spouse name line conditionally
  const spouseNameLine = data.spouseName
    ? `- Spouse: ${data.spouseName} (${data.spouseGender} - use appropriate ${targetLanguage} grammar forms)`
    : '';

  // Build spouse schedule section conditionally
  const spouseScheduleHeader = data.spouseName
    ? `<b>${data.spouseEnglishName || data.spouseName} Schedule:</b> [Only if ${data.spouseName} has events]
- HH:MM-HH:MM - [Activity/Work] ([Location if available])
[Chronological order by start time, include location when event has one]

`
    : '';

  // Build pickup/kids sections conditionally
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

  // Build insight section
  const insightSection = data.hasKidsCalendars
    ? `<b>Insight:</b> [ONE concise sentence (max 10-15 words) with a helpful observation, such as:]
- Pickup logistics: Who's available based on work schedules
- Continuous stays: If kid has back-to-back events at same location
- Conflicts: If pickups overlap or timing is tight
- OMIT this section entirely if there are no meaningful insights

`
    : '';

  // Build spouse events section conditionally
  const spouseEventsSection = data.spouseName && data.spouseEventsText
    ? `**SPOUSE'S EVENTS:**
${data.spouseEventsText}

`
    : '';

  // Build other events section header
  const otherEventsHeader = data.hasKidsCalendars
    ? '**OTHER EVENTS (Kids & Family):**'
    : '**OTHER EVENTS:**';

  return `# Calendar Summary for ${data.userName}

Generate a personalized daily schedule summary in ${targetLanguage}.

**IMPORTANT: Names and grammar:**
- User: ${data.userName} (${data.userGender} - use appropriate ${targetLanguage} grammar forms)
${spouseNameLine}

## Event Categories & Personalization
Events have been pre-categorized into groups:

1. **User's Events** - These are YOUR events (personal and work calendars)
   - Address these as "You have..." or "Your..." (in ${targetLanguage})
   - When mentioning by name, use: ${data.userName}
${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}${calendarRules}
## Output Format
**IMPORTANT: Output EVERYTHING in ${targetLanguage}.**

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

## Guidelines
- **CRITICAL: EVERYTHING must be in ${targetLanguage} - translate ALL headers and content to ${targetLanguage}**
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

**CRITICAL: Respond in ${targetLanguage} only. Write your entire summary in ${targetLanguage}.**`;
}
