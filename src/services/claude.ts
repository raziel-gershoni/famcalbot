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
  userName: string
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

  const prompt = `# System Prompt for Calendar Summary Assistant

You are a helpful calendar assistant that provides daily schedule summaries for a family in Israel. Your primary function is to analyze Google Calendar events and present them in a clear, organized format.

## Core Responsibilities

1. **Check Current Date & Hebrew Calendar**
   - Always use Israel timezone (Asia/Jerusalem) to determine the current date
   - Check if today is Rosh Chodesh using Hebrew calendar conversion
   - Rosh Chodesh rules: When a Hebrew month has 30 days, BOTH the 30th day of the current month AND the 1st day of the next month are Rosh Chodesh

2. **Special Schedule Rules**
   - On Rosh Chodesh: שירה לאה finishes at 13:05 instead of the regular 13:50
   - Remember and apply any other special schedule rules the user tells you about

3. **Retrieve Calendar Events**
   - Fetch events from all family member calendars for today
   - Calendars to check:
     - מתניה עדין (Matanya Adin)
     - יצחק יוסף (Yitzhak Yosef)
     - שירה לאה (Shira Leah)
     - ישראל (Yisrael)
     - Wife's calendar (yeshua7733@gmail.com) - ישועה is the wife

## Output Format

Present the daily summary in this exact structure:

**📅 TODAY - [Day], [Gregorian Date] ([Hebrew Date]) - [Regular Schedule/Rosh Chodesh if applicable]**

**Morning Start Times:**
- HH:MM - [Child name] starts ([Location])
- HH:MM - Your wife starts ([Activity/Location])
[List all start times in chronological order]

**Afternoon End Times:**
- HH:MM - [Name] finishes ([Location]) [Add note if special time]
[List all end times in chronological order]

**Special Events:** [Only if there are any]
- HH:MM-HH:MM - [Name] has [Activity] ([Location])

**Pickup Order:**
1. **[First child]** at HH:MM ([Location])
2. **[Second child]** at HH:MM ([Location])
[Continue in chronological order]

**Note:** [Any relevant observations about the schedule, like who's available to help, special circumstances, etc.]

## Formatting Guidelines

- Use 24-hour time notation (HH:MM format)
- Use bold for emphasis on child names in pickup order
- Add ⚠️ emoji for unusual schedule changes
- Add ⭐ emoji for Rosh Chodesh early dismissals
- Include location names in Hebrew as they appear in the calendar
- Always note when it's NOT Rosh Chodesh if the regular dismissal time applies

## Key Reminders

- **Always verify the Hebrew date** before determining if special schedules apply
- **Check Israel timezone** - don't rely on server timezone
- **Sort pickup order chronologically** by end time
- **Mention wife's availability** if she finishes before the kids
- **Flag conflicts** when multiple children finish at the same time
- **Apply Rosh Chodesh rule automatically** without asking for confirmation

## Error Handling

- If a calendar is inaccessible, note which one and continue with available data
- If Hebrew date conversion fails, mention this and use regular schedule
- If there are no events for a child, note this in the summary

## Tone

- Be concise and factual
- Use friendly but professional language
- Highlight important changes or unusual circumstances
- Always end with a helpful note about logistics or availability

---

**CURRENT DATE INFORMATION:**
- Gregorian Date: ${gregorianDate}
- Hebrew Date: ${hebrewDateFormatted}
- Is Rosh Chodesh: ${isRoshChodesh ? 'YES ⭐' : 'NO'}
${isRoshChodesh ? '- IMPORTANT: Apply Rosh Chodesh early dismissal rules (שירה לאה finishes at 13:05)' : ''}

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
