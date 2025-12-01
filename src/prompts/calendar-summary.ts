/**
 * Calendar Summary Prompt Template
 * Separated from business logic for easier maintenance, testing, and versioning
 */

export interface SummaryPromptData {
  userName: string;
  userHebrewName: string;
  userGender: 'male' | 'female';
  spouseName: string;
  spouseHebrewName: string;
  spouseGender: 'male' | 'female';
  currentGregorianDate: string;
  summaryGregorianDate: string;
  summaryHebrewDate: string;
  isRoshChodesh: boolean;
  greeting: string;
  userEventsText: string;
  spouseEventsText: string;
  otherEventsText: string;
  weatherSummary?: string;  // AI-generated weather summary with tips
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  return `# Calendar Summary for ${data.userName}

Generate a personalized daily schedule summary in Hebrew.

**IMPORTANT: Use these exact names in your output:**
- User: ${data.userHebrewName} (${data.userGender} - use correct grammar forms)
- Spouse: ${data.spouseHebrewName} (${data.spouseGender} - use correct grammar forms)

## Event Categories & Personalization
Events have been pre-categorized into three groups:

1. **User's Events** - These are YOUR events (personal and work calendars)
   - Address these as "You have..." or "Your..." (translated)
   - When mentioning by name, use: ${data.userHebrewName}

2. **Spouse's Events** - These belong to the spouse
   - When referring to spouse by name, use: ${data.spouseHebrewName}
   - Personalize from user's perspective (e.g., "${data.spouseHebrewName} has a meeting at...")

3. **Other Events** - Kids' events and shared family events
   - Infer ownership from calendar display name (e.g., "שירה לאה", "מתניה עדין", etc.)
   - **IMPORTANT: Do NOT confuse location names with people's names**
   - Example: "גן גלעד" is a LOCATION (kindergarten), not a person named גלעד
   - **In pickup order: use the calendar owner's name, followed by location in parentheses**

## Special Schedule Rule: Rosh Chodesh Early Dismissal
**⭐ On Rosh Chodesh ONLY:**
- IF שירה לאה's dismissal time is 13:50 → change to 13:05
- IF she already finishes earlier (e.g., 12:00 on Fridays) → keep the earlier time, do NOT mention Rosh Chodesh
- This rule ONLY applies when replacing the regular 13:50 dismissal with 13:05
- Do NOT apply this rule to any other times

## Output Format
**IMPORTANT: Translate ALL section headers to Hebrew. Output EVERYTHING in Hebrew.**

<b>${data.greeting}</b>

<b>📅 [DAY LABEL] - [Day], [Gregorian Date] ([Hebrew Date]) - [Regular Schedule/Rosh Chodesh if applicable]</b>
(Compare current date with summary date, use appropriate label for DAY LABEL)

<b>Your Schedule:</b> [Only if ${data.userName} has events]
- HH:MM-HH:MM - [Activity] ([Location if available])
[Chronological order by start time, include location when event has one]

<b>${data.spouseHebrewName} Schedule:</b> [Only if ${data.spouseName} has events]
- HH:MM-HH:MM - [Activity/Work] ([Location if available])
[Chronological order by start time, include location when event has one]

<b>Kids Start Times:</b>
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
4. Output in this sorted time order with ⚠️ for same-time pickups
5. Do NOT skip any kids - ALL must be in this list

- HH:MM - [Name] ([Location])
- HH:MM - [Name1] ([Location1]), [Name2] ([Location2]) [⚠️ if multiple kids]

<b>💡 Insight:</b> [ONE concise sentence (max 10-15 words) with a helpful observation, such as:]
- Pickup logistics: Who's available based on work schedules
- Continuous stays: If kid has back-to-back events at same location
- Conflicts: If pickups overlap or timing is tight
- OMIT this section entirely if there are no meaningful insights

<b>🌤️ Weather:</b> [ONLY if weather data is provided below]
[Weather summary with helpful tip when applicable]
**If rain expected today: Include specific hour spans (e.g., "Rain 14:00-18:00, bring umbrella")**
Examples of helpful tips:
- "Don't forget an umbrella" - when rain is expected (with hours)
- "Bring water" - when it's hot
- "Bring a jacket" - when it's cold or temperature drops
- Keep it concise and actionable (one sentence)

## Guidelines
- **CRITICAL: EVERYTHING must be in Hebrew - translate ALL headers and content**
- **CRITICAL: Always use HH:MM format (24-hour, no AM/PM) - e.g., 08:00, 13:45, 20:15**
- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
- **Pickup Order: Group kids with SAME pickup time on ONE line together, just like start times**
- Always display Hebrew date using Gematria (Hebrew numerals) not Arabic numbers
- Use Telegram HTML tags for formatting: <b>bold</b>, <i>italic</i>, <u>underline</u>

---

**DATE INFORMATION:**
- Current Date (Today): ${data.currentGregorianDate}
- Summary Date: ${data.summaryGregorianDate}
- Hebrew Date (Summary): ${data.summaryHebrewDate}
- Rosh Chodesh: ${data.isRoshChodesh ? 'YES ⭐ - Apply early dismissal rule (שירה לאה: 13:50→13:05 ONLY if her time is 13:50)' : 'NO'}

**${data.userName}'S EVENTS:**
${data.userEventsText}

**SPOUSE'S EVENTS:**
${data.spouseEventsText}

**OTHER EVENTS (Kids & Family):**
${data.otherEventsText}
${data.weatherSummary ? `
**WEATHER INFORMATION:**
${data.weatherSummary}` : ''}

**CRITICAL: Respond in Hebrew only. Write your entire summary in Hebrew.**`;
}
