import Anthropic from '@anthropic-ai/sdk';
import { HDate, months } from 'hebcal';
import { CalendarEvent } from '../types';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Get Hebrew date information and check if today is Rosh Chodesh
 */
function getHebrewDateInfo(): { hebrewDate: string; isRoshChodesh: boolean; hebrewDateFormatted: string } {
  const now = new Date();
  const hdate = new HDate(now);

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
  primaryCalendar: string
): Promise<string> {
  if (events.length === 0) {
    return "אין לך אירועים מתוכננים להיום. תהנה מיום פנוי!";
  }

  // Get Hebrew date and Rosh Chodesh information
  const { hebrewDate, isRoshChodesh, hebrewDateFormatted } = getHebrewDateInfo();
  const today = new Date();
  const gregorianDate = today.toLocaleDateString('en-US', {
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

## Special Schedule Rule
**⭐ On Rosh Chodesh: שירה לאה finishes at 13:05 instead of 13:50**

## Output Format

**📅 TODAY - [Day], [Gregorian Date] ([Hebrew Date]) - [Regular Schedule/Rosh Chodesh if applicable]**

**Morning Start Times:**
- HH:MM - [Person] starts ([Location/Activity])
[Chronological order]

**Special Events:** [Only if any]
- HH:MM-HH:MM - [Name] has [Activity] ([Location])

**Pickup Order:**
1. **[Name]** at HH:MM ([Location]) [⭐ if Rosh Chodesh early dismissal]
2. **[Name]** at HH:MM ([Location])
[Chronological by finish time]

**Note:** [Personalized logistics/availability relevant to ${userName}]

## Guidelines
- Use 24-hour time, bold names in pickup order
- Add ⚠️ for unusual changes, ⭐ for Rosh Chodesh dismissals
- Flag conflicts when multiple finish at same time
- Be concise and factual in Hebrew

---

**TODAY'S DATE:**
- Gregorian: ${gregorianDate}
- Hebrew: ${hebrewDateFormatted}
- Rosh Chodesh: ${isRoshChodesh ? 'YES ⭐ - Apply early dismissal (שירה לאה at 13:05)' : 'NO'}

Today's events:
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
