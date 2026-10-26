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
  holidays: 'Holidays',
  parasha: 'This week\'s Torah portion',
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

  return `
3. **Other Events** - Kids' events and shared family events
   - **Identify children by calendar name** in the [Calendar: Name] tag (e.g., [Calendar: Shira Leah] = Shira Leah's event)
   - Events on other calendars (family/general) containing a child's **exact full name** in the title belong to that child. Split into separate entries per child.
     Example: "dentist - Shmulik and Srulik" → Shmulik: dentist, Srulik: dentist
   - **CRITICAL: Match only exact full names of children whose names appear as calendar names. Similar-sounding words are NOT names.**
     Example: "Shirat HaBakashot" is NOT "Shira"'s event — "Shirat" is a different word
   - **IMPORTANT: Include ALL events in this section — events without an identified child name are general family events and MUST still appear**
   - **In pickup order: use the child's name, followed by location in parentheses**
`;
}

function buildHebrewDateContext(data: SummaryPromptData): string {
  if (data.culture !== 'jewish') return '';

  return `
## Hebrew Calendar
- Include the Hebrew date in the summary header
- Hebrew Date: ${data.summaryHebrewDate}
- ${data.holidays?.length ? `TODAY: ${data.holidays.join(', ')} - mention this in the header` : ''}${data.parasha ? '\n- Mention this week\'s Torah portion briefly, once, in the header' : ''}
- Display Hebrew date using standard numerals (e.g., "28 Kislev 5785")
`;
}

// Only digests with reminders get this, so every other prompt stays as it was.
function buildRemindersGuideline(data: SummaryPromptData): string {
  if (!data.hasReminders) return '';
  const n = data.openRemindersMore ?? 0;
  const line = n === 1 ? 'and 1 more open reminder' : `and ${n} more open reminders`;
  const more = n
    ? ` ${n === 1 ? '1 more open reminder is' : `${n} more open reminders are`} not in the lists, so you MUST add this exact line, as its own bullet, right after the open reminders in the user's section: "${line}".`
    : '';
  return `- **Reminders**: Items marked "Reminder" are reminders: one moment, never a time range. Show each as "HH:MM ⏰ [task]", or "⏰ [task]" when it has no time ("all day"), in the section of the person it is for, with no end time. "(open)" means its time has passed and it isn't done yet: add "(still open)". "open since Tue 12 Oct" means it is still open from that earlier day: list it briefly after the day's own items, as "⏰ [task] (open since Tuesday)", never as happening on this day. "(from [Name])" means [Name] set it for the user: keep "(from [Name])". "(for [Name], you asked)" means the user set it for [Name]: show it in [Name]'s section with "(you asked)".${more}
`;
}

// Only the outage run gets this (Google Calendar couldn't be reached at send time), so
// every other prompt stays as it was.
function buildGoogleUnavailableGuideline(data: SummaryPromptData): string {
  if (!data.googleUnavailable) return '';
  return `- **Google Calendar**: Google Calendar couldn't be reached for this summary, so the lists hold only what loaded. Don't invent events or guess what's missing, and don't say nothing is planned just because a list is empty. A note about this is added after your summary, so don't mention it yourself.
`;
}

// Only prompts with a Hebrew-calendar yearly event that has a count get this, so every other prompt stays as it was.
function buildAnniversaryGuideline(has: boolean): string {
  if (!has) return '';
  return `- **Year counts**: An event marked "[Year N since the original date]" repeats every year on its Hebrew date, and N is how many years it has been since the original date (a birthday with N = 35 is a 35th birthday; a wedding anniversary with N = 10 is a 10th anniversary). Work the number into the event's own wording naturally (e.g. "[Name]'s 35th birthday"), but only when the title makes clear what is being counted; otherwise leave it out. Never invent or change the number.
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
    data.holidays,
    DATE_INFO_LABELS,
    data.parasha
  );

  const spouseLabel = data.spouseName || 'Spouse';
  const spouseNameLine = data.hasSpouseCalendar
    ? `- Spouse: ${spouseLabel}${data.spouseGender ? ` (${data.spouseGender} - use appropriate English grammar forms)` : ''}`
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
${spouseNameLine}

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
- **Birthdays**: Events marked "(Birthday)" — show without any time. Extract the person's name from the event title (e.g., "John Doe's Birthday" → mention "John Doe's birthday"). Present naturally.
- **Events crossing midnight are marked in the event list.** "22:00 - 02:00 next day" ends after midnight: show it as "22:00-02:00 (past midnight)". "until 10:00 (started yesterday 18:00)" began the day before: show it as "until 10:00", first in the list, and never present it as starting on this day. A multi-day event shows its span: say which day of it this is. A "next day" end time is not a time on this day, also in the pickup order.
${buildRemindersGuideline(data)}${buildGoogleUnavailableGuideline(data)}${buildAnniversaryGuideline(!!data.hasAnniversaries)}${data.hasKidsCalendars ? `- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
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
