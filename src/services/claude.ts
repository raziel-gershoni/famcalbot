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
  events: CalendarEvent[],
  userName: string,
  primaryCalendar: string,
  date: Date = new Date()
): Promise<string> {
  if (events.length === 0) {
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
  const eventsText = events.map((event, index) => {
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

    let eventStr = `${index + 1}. ${event.summary} (${startTime} - ${endTime}) [${event.calendarName}]`;
    if (event.location) {
      eventStr += ` at ${event.location}`;
    }
    if (event.description) {
      eventStr += `\n   Description: ${event.description}`;
    }
    return eventStr;
  }).join('\n');

  const prompt = `# Calendar Summary for ${userName}

Generate a personalized daily schedule summary in Hebrew.

## Personalization Rules
- Current user: **${userName}** (primary calendar: ${primaryCalendar})
- Raziel's calendar: raziel@internety.co.il
- Yeshua's calendar: yeshua7733@gmail.com (ישועה - Raziel's wife)
- Address events from ${userName}'s primary calendar as "You have..." or "Your..."
- For spouse's events, use their name and personalize notes for ${userName}'s perspective
- **IMPORTANT: Calendar name indicates WHO the event belongs to - if calendar is "ישועה", the event is for Yeshua**
- **Do NOT infer people's names from location names (e.g., "גן גלעד" is a location, not a person named גלעד)**
- **In pickup order: use the calendar owner's name, followed by location in parentheses**

## Special Schedule Rule
**⭐ On Rosh Chodesh: שירה לאה finishes at 13:05 instead of 13:50**

## Output Format
**IMPORTANT: Translate ALL section headers to Hebrew. Output EVERYTHING in Hebrew.**

<b>Good morning!</b> (or "Good evening!" for tomorrow summary)

<b>📅 [DAY LABEL] - [Day], [Gregorian Date] ([Hebrew Date]) - [Regular Schedule/Rosh Chodesh if applicable]</b>
(Compare current date with summary date, use appropriate label for DAY LABEL)

<b>Your Schedule:</b> [Only if ${userName} has events]
- HH:MM-HH:MM - [Activity] ([Location if available])
[Chronological order by start time, include location when event has one]

<b>Spouse Schedule:</b> [Only if spouse has events]
- HH:MM-HH:MM - [Activity/Work] ([Location if available])
[Chronological order by start time, include location when event has one]

<b>Kids Start Times:</b>
- HH:MM - [Name1] ([Location1]), [Name2] ([Location2])
[Group children with same start time together on one line, sorted chronologically by time]

<b>Special Events:</b> [Only if kids have special events during the day]
- HH:MM-HH:MM - [Name] [Activity] ([Location])

<b>Pickup Order:</b> [ONLY KIDS - do NOT include spouse]
- HH:MM - [Name1] ([Location1]), [Name2] ([Location2]) [⚠️ if parallel]
[**CRITICAL: Sort by pickup time chronologically (earliest to latest). Group children with SAME pickup time together on ONE line.**]

<b>Note:</b> [ONLY if general observations NOT already covered inline - otherwise OMIT entirely]

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
- Rosh Chodesh: ${isRoshChodesh ? 'YES ⭐ - Apply early dismissal (שירה לאה at 13:05)' : 'NO'}

Events for summary date:
${eventsText}

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
