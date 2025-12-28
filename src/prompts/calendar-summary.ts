/**
 * Calendar Summary Prompt Template
 * Separated from business logic for easier maintenance, testing, and versioning
 */

import { getLanguageFromLocale } from '../utils/locale';

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
  language?: string;  // Target language for summary (e.g., "Hebrew", "English", "Spanish"). If not set, defaults to English.
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const localeCode = data.language || 'en';
  const targetLanguage = getLanguageFromLocale(localeCode);

  return `# Calendar Summary for ${data.userName}

Generate a personalized daily schedule summary in ${targetLanguage}.

**IMPORTANT: Names and grammar:**
- User: ${data.userName} (${data.userGender} - use appropriate ${targetLanguage} grammar forms)
- Spouse: ${data.spouseName} (${data.spouseGender} - use appropriate ${targetLanguage} grammar forms)

## Event Categories & Personalization
Events have been pre-categorized into three groups:

1. **User's Events** - These are YOUR events (personal and work calendars)
   - Address these as "You have..." or "Your..." (in ${targetLanguage})
   - When mentioning by name, use: ${data.userName}

2. **Spouse's Events** - These belong to the spouse
   - When referring to spouse by name, use: ${data.spouseName}
   - Personalize from user's perspective (e.g., "${data.spouseName} has a meeting at...")

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
**Create an insightful, actionable weather briefing (2-4 sentences) that integrates weather with the day's schedule:**

STRUCTURE:
1. Current conditions and day overview (temperature range, conditions)
2. **CRITICAL: If rain expected, include SPECIFIC hour spans (e.g., "Rain 14:00-18:00")**
3. Actionable recommendations based on schedule timing:
   - Consider pickup times and commutes
   - Morning vs afternoon conditions
   - Temperature changes throughout the day
   - UV/sun exposure if relevant

EXAMPLES:
- "Clear skies, 18-25°C today. Morning will be cool (18°C) during school dropoff, warming to 25°C by afternoon pickup. Perfect weather for outdoor activities."
- "Rain expected 14:00-18:00 with temperatures dropping from 22°C to 16°C. Morning activities will be dry, but bring umbrella and light jacket for afternoon pickups. Roads may be slippery during evening commute."
- "Hot day ahead, 28-35°C with high UV (8.5). Morning starts pleasant at 28°C, but will reach 35°C by midday. Bring water for kids, apply sunscreen, and consider shade for outdoor waiting during pickups. Evening cools to 30°C."
- "Cool morning (12°C) warming to 20°C by afternoon. Dress kids in layers - jacket for morning dropoff, but they'll want to remove it by lunchtime. Sunny and pleasant for outdoor play."

**Be specific about timing and temperatures. Cross-reference weather timing with schedule events. Make it useful for planning the day.**

## Guidelines
- **CRITICAL: EVERYTHING must be in ${targetLanguage} - translate ALL headers and content to ${targetLanguage}**
- **CRITICAL: Always use HH:MM format (24-hour, no AM/PM) - e.g., 08:00, 13:45, 20:15**
- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
- **CRITICAL: Pickup Order: Group kids with SAME pickup time on ONE line together, just like start times**
${localeCode === 'he' ? '- Always display Hebrew date using Gematria (Hebrew numerals) not Arabic numbers' : '- Display Hebrew date using standard numerals (e.g., "28 Kislev 5785")'}
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

**CRITICAL: Respond in ${targetLanguage} only. Write your entire summary in ${targetLanguage}.**`;
}
