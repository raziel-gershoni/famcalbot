/**
 * English Week Lookahead Prompt
 */

import { WeekLookaheadPromptData, LookaheadDayData } from './types';
import { buildGlobalRulesSection } from '../shared-builders';

function buildSpouseContext(data: WeekLookaheadPromptData): string {
  if (!data.hasSpouseCalendar) return '';

  const spouseLabel = data.spouseName || 'Spouse';
  return `
- **Spouse's events**: Belong to ${spouseLabel} - mention as "${spouseLabel} has [event]" (don't add "from calendar" - it's already clear from context)`;
}

function buildKidsContext(data: WeekLookaheadPromptData): string {
  if (!data.hasKidsCalendars) return '';

  return `
- **Kids' events**: Events with calendar name starting with "Child:" belong to that child
- **CRITICAL: The event title is the FULL institution/event name — use it as-is.** e.g., "Tala Gan Gilad Mid-Year" → "mid-year event at Tala Gan Gilad" (NOT "mid-year meeting at Gan")`;
}

function buildHebrewDateContext(data: WeekLookaheadPromptData): string {
  if (data.culture !== 'jewish') return '';

  // Use weekStartHebrew for next week summaries, todayHebrew for regular lookahead
  const startHebrew = data.weekStartHebrew || data.todayHebrew;
  return `
## Hebrew Calendar
- Include Hebrew dates alongside Gregorian dates
- Week starts: ${startHebrew}
- Week ends: ${data.weekEndHebrew}`;
}

function formatEventsForDay(day: LookaheadDayData): string {
  const lines = day.events.map(event => {
    const recurNote = event.isRecurring && event.recurrenceType
      ? ` [${event.recurrenceType}]`
      : '';
    return `  - ${event.time} - ${event.summary} (${event.calendarName})${recurNote}`;
  });
  return lines.join('\n');
}

function buildEventsSection(data: WeekLookaheadPromptData): string {
  if (data.eventsByDay.length === 0) {
    return `**EVENTS:**
No notable events for this period.`;
  }

  const days = data.eventsByDay.map(day => {
    const hebrewPart = day.hebrewDate ? ` (${day.hebrewDate})` : '';
    return `**${day.dayLabel}${hebrewPart}** - ${day.relativeLabel}
${formatEventsForDay(day)}`;
  });

  return `**EVENTS BY DAY:**

${days.join('\n\n')}`;
}

export function buildWeekLookaheadPrompt(data: WeekLookaheadPromptData): string {
  const spouseContext = buildSpouseContext(data);
  const kidsContext = buildKidsContext(data);
  const hebrewDateContext = buildHebrewDateContext(data);
  const globalRules = buildGlobalRulesSection(data.globalRules, '## User\'s Custom Rules (Apply when relevant)');
  const eventsSection = buildEventsSection(data);

  // Use weekStartGregorian for next week summaries, todayGregorian for regular lookahead
  const rangeStart = data.weekStartGregorian || data.todayGregorian;
  const rangeStartHebrew = data.weekStartHebrew || data.todayHebrew;
  const isNextWeek = !!data.weekStartGregorian;
  const title = isNextWeek ? 'Next Week Preview' : 'Week Ahead Preview';
  const headerTitle = isNextWeek ? 'Next Week' : 'Week Ahead';

  return `# ${title} for ${data.userName}

Generate a concise ${isNextWeek ? 'next week' : 'week-ahead'} preview in English.
${isNextWeek ? `\n**IMPORTANT**: This is NEXT WEEK's schedule (${rangeStart} - ${data.weekEndGregorian}), NOT today's week. Today is ${data.todayGregorian}.\n` : ''}
## Week Range
From: ${rangeStart} to ${data.weekEndGregorian}
Total: ${data.totalEvents} events across ${data.totalDays} days

## Calendar Ownership
When mentioning events, always indicate whose calendar they come from:
- **Your events**: These are ${data.userName}'s events - mention as "You have..." or "Your [event]"${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}
## Output Format
Generate a friendly, conversational preview. Structure:

<b>${headerTitle}</b>
<b>${rangeStart} - ${data.weekEndGregorian}</b>${data.culture === 'jewish' ? `
<i>${rangeStartHebrew} - ${data.weekEndHebrew}</i>` : ''}

[For each day with events, create a brief summary mentioning:]
- Day and date
- Key events with times in HH:MM format
- Calendar source for each event
- Note recurring patterns (monthly checkups, yearly renewals)

[End with a brief heads-up about any events needing preparation]

## Guidelines
- **Be conversational but concise** - this is a quick heads-up, not a detailed summary
- **Calendar attribution** - For your events, mention source (e.g., "from your work calendar"). For spouse/kids, the name already implies source - don't repeat.
- **Highlight recurring events** - if something is monthly/yearly, note it (e.g., "monthly checkup")
- **Time format**: Always use HH:MM (24-hour) - e.g., 08:00, 14:30
- **Birthdays**: Events with time "Birthday" — present naturally with the person's name extracted from the title (e.g., "John's Birthday" → "It's John's birthday"). No time needed.
- **Format**: Use Telegram HTML tags: <b>bold</b>, <i>italic</i>
- **If no events**: Keep it brief - just note that the week looks clear
${isNextWeek ? '- **Do NOT say "today"** - refer to days by their actual names (Monday, Tuesday, etc.)' : '- **Use relative day references** - "Tomorrow", "In 3 days" alongside actual dates'}

---

${eventsSection}

**CRITICAL: Respond in English only. Be brief and conversational.**`;
}
