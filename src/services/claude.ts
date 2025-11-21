import Anthropic from '@anthropic-ai/sdk';
import { HDate, months } from 'hebcal';
import { CalendarEvent } from '../types';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Get Hebrew date information and check if today is Rosh Chodesh
 */
function getHebrewDateInfo(date: Date = new Date()): { hebrewDate: string; isRoshChodesh: boolean; hebrewDateFormatted: string } {
  const hdate = new HDate(date);

  const day = hdate.getDate();
  const monthName = hdate.getMonthName('h'); // Hebrew month name
  const year = hdate.getFullYear();

  // Check if it's Rosh Chodesh
  // Rosh Chodesh is on day 1 of any month, or day 30 of a 30-day month
  const isRoshChodesh = day === 1 || day === 30;

  const hebrewDate = `${day} ${monthName} ${year}`;
  const hebrewDateFormatted = `${day} ב${monthName} ${year}`;

  return { hebrewDate, isRoshChodesh, hebrewDateFormatted };
}

/**
 * Generate a natural language summary of calendar events using Claude
 */
export async function generateSummary(
  userEvents: CalendarEvent[],
  spouseEvents: CalendarEvent[],
  otherEvents: CalendarEvent[],
  userName: string,
  userHebrewName: string,
  spouseName: string,
  spouseHebrewName: string,
  primaryCalendar: string,
  date: Date = new Date()
): Promise<string> {
  const allEvents = [...userEvents, ...spouseEvents, ...otherEvents];

  if (allEvents.length === 0) {
    return "אין לך אירועים מתוכננים להיום. תהנה מיום פנוי!";
  }

  // Get current date (today) for comparison
  const currentDate = new Date();
  const currentGregorianDate = currentDate.toLocaleDateString('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Determine greeting based on current time in Asia/Jerusalem
  const currentHour = parseInt(currentDate.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    hour12: false
  }));

  let greeting: string;
  if (currentHour < 12) {
    greeting = 'Good morning!';
  } else if (currentHour < 18) {
    greeting = 'Good afternoon!';
  } else {
    greeting = 'Good evening!';
  }

  // Get summary date and Hebrew date information
  const { hebrewDate, isRoshChodesh, hebrewDateFormatted } = getHebrewDateInfo(date);
  const gregorianDate = date.toLocaleDateString('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Format events for the prompt
  const formatEventList = (events: CalendarEvent[]) => {
    return events.map((event, index) => {
      const startTime = new Date(event.start).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      });
      const endTime = new Date(event.end).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      });

      let eventStr = `${index + 1}. ${event.summary} (${startTime} - ${endTime}) [Calendar: ${event.calendarName}]`;
      if (event.location) {
        eventStr += ` at ${event.location}`;
      }
      if (event.description) {
        eventStr += `\n   Description: ${event.description}`;
      }
      return eventStr;
    }).join('\n');
  };

  const userEventsText = userEvents.length > 0 ? formatEventList(userEvents) : 'None';
  const spouseEventsText = spouseEvents.length > 0 ? formatEventList(spouseEvents) : 'None';
  const otherEventsText = otherEvents.length > 0 ? formatEventList(otherEvents) : 'None';

  const prompt = `# Calendar Summary for ${userName}

Generate a personalized daily schedule summary in Hebrew.

**IMPORTANT: When translating to Hebrew, use these exact names in your output:**
- User: ${userHebrewName}
- Spouse: ${spouseHebrewName}

## Event Categories & Personalization
Events have been pre-categorized into three groups:

1. **${userName}'s Events** - These are YOUR events (personal and work calendars)
   - Address these as "You have..." or "Your..."

2. **${spouseName}'s Events** - These belong to ${spouseName} (${userName}'s spouse)
   - Use ${spouseName}'s name when referring to these events
   - Personalize from ${userName}'s perspective (e.g., "${spouseName} has a meeting at...")

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

<b>${greeting}</b>

<b>📅 [DAY LABEL] - [Day], [Gregorian Date] ([Hebrew Date]) - [Regular Schedule/Rosh Chodesh if applicable]</b>
(Compare current date with summary date, use appropriate label for DAY LABEL)

<b>Your Schedule:</b> [Only if ${userName} has events]
- HH:MM-HH:MM - [Activity] ([Location if available])
[Chronological order by start time, include location when event has one]

<b>${spouseName} Schedule:</b> [Only if ${spouseName} has events]
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

<b>Note:</b> [ONLY for general observations NOT about pickup times/logistics - otherwise OMIT this section entirely]

## Guidelines
- **CRITICAL: EVERYTHING must be in Hebrew - translate ALL headers and content**
- **CRITICAL: Always use HH:MM format (24-hour, no AM/PM) - e.g., 08:00, 13:45, 20:15**
- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
- **Pickup Order: Group kids with SAME pickup time on ONE line together, just like start times**
- Always display Hebrew date using Gematria (Hebrew numerals) not Arabic numbers
- Use Telegram HTML tags for formatting: &lt;b&gt;bold&lt;/b&gt;, &lt;i&gt;italic&lt;/i&gt;, &lt;u&gt;underline&lt;/u&gt;

---

**DATE INFORMATION:**
- Current Date (Today): ${currentGregorianDate}
- Summary Date: ${gregorianDate}
- Hebrew Date (Summary): ${hebrewDateFormatted}
- Rosh Chodesh: ${isRoshChodesh ? 'YES ⭐ - Apply early dismissal rule (שירה לאה: 13:50→13:05 ONLY if her time is 13:50)' : 'NO'}

**${userName}'S EVENTS:**
${userEventsText}

**SPOUSE'S EVENTS:**
${spouseEventsText}

**OTHER EVENTS (Kids & Family):**
${otherEventsText}

**CRITICAL: Respond in Hebrew only. Write your entire summary in Hebrew.**`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const textContent = message.content.find(block => block.type === 'text');
    return textContent && 'text' in textContent ? textContent.text : 'Unable to generate summary.';
  } catch (error) {
    console.error('Error generating summary with Claude:', error);
    return 'Sorry, I could not generate a summary at this time.';
  }
}
