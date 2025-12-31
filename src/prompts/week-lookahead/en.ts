/**
 * English Week Lookahead Prompt
 */

import { WeekLookaheadPromptData, LookaheadDayData } from './types';

function buildSpouseContext(data: WeekLookaheadPromptData): string {
  if (!data.hasSpouseCalendar) return '';

  const spouseLabel = data.spouseName || 'Spouse';
  return `
- **Spouse's events**: Belong to ${spouseLabel} - mention as "${spouseLabel} has [event]" (don't add "from calendar" - it's already clear from context)`;
}

function buildKidsContext(data: WeekLookaheadPromptData): string {
  if (!data.hasKidsCalendars) return '';

  return `
- **Kids' events**: Identify children by calendar name or event content - mention as "[Child]'s [event]"`;
}

function buildHebrewDateContext(data: WeekLookaheadPromptData): string {
  if (data.culture !== 'jewish') return '';

  return `
## Hebrew Calendar
- Include Hebrew dates alongside Gregorian dates
- Today: ${data.todayHebrew}
- Week ends: ${data.weekEndHebrew}`;
}

function buildGlobalRules(data: WeekLookaheadPromptData): string {
  if (!data.globalRules || data.globalRules.length === 0) return '';

  const rules = data.globalRules
    .filter(r => r.trim())
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');

  if (!rules) return '';

  return `
## User's Custom Rules (Apply when relevant)
${rules}`;
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
  const globalRules = buildGlobalRules(data);
  const eventsSection = buildEventsSection(data);

  return `# Week Ahead Preview for ${data.userName}

Generate a concise week-ahead preview in English.

## Week Range
From: ${data.todayGregorian} until end of week
Total: ${data.totalEvents} events across ${data.totalDays} days

## Calendar Ownership
When mentioning events, always indicate whose calendar they come from:
- **Your events**: These are ${data.userName}'s events - mention as "You have..." or "Your [event]"${spouseContext}${kidsContext}
${hebrewDateContext}${globalRules}
## Output Format
Generate a friendly, conversational preview. Structure:

<b>Week Ahead</b>
<b>${data.todayGregorian} - End of Week</b>${data.culture === 'jewish' ? `
<i>${data.todayHebrew} - סוף השבוע</i>` : ''}

[For each day with events, create a brief summary mentioning:]
- Day and date (with relative reference like "Tomorrow" or "In 3 days")
- Key events with times in HH:MM format
- Calendar source for each event
- Note recurring patterns (monthly checkups, yearly renewals)

[End with a brief heads-up about any events needing preparation]

## Guidelines
- **Be conversational but concise** - this is a quick heads-up, not a detailed summary
- **Calendar attribution** - For your events, mention source (e.g., "from your work calendar"). For spouse/kids, the name already implies source - don't repeat.
- **Use relative day references** - "Tomorrow", "In 3 days" alongside actual dates
- **Highlight recurring events** - if something is monthly/yearly, note it (e.g., "monthly checkup")
- **Time format**: Always use HH:MM (24-hour) - e.g., 08:00, 14:30
- **Format**: Use Telegram HTML tags: <b>bold</b>, <i>italic</i>
- **If no events**: Keep it brief - just note that the week looks clear

---

${eventsSection}

**CRITICAL: Respond in English only. Be brief and conversational.**`;
}
