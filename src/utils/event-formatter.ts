import { formatInTimeZone } from 'date-fns-tz';
import { CalendarEvent } from '../types';
import { TIMEZONE } from '../config/constants';
import { daySpanOf, localDate, nextDate } from './day-events';

/** Light sanitizer for event fields — strips newlines and markdown links, preserves legitimate text */
function sanitizeEventField(text: string, maxLen = 500): string {
  return text.replace(/\n/g, ' ').replace(/\[.*?\]/g, '').trim().slice(0, maxLen);
}

/** Check if a CalendarEvent is an all-day event (start is date-only, no time component) */
export function isAllDayEvent(event: CalendarEvent): boolean {
  return !!event.start && !event.start.includes('T');
}

/** Check if a CalendarEvent is a birthday event */
export function isBirthdayEvent(event: CalendarEvent): boolean {
  return event.eventType === 'birthday';
}

const clock = (iso: string, timezone: string) => formatInTimeZone(new Date(iso), timezone, 'HH:mm');
const weekdayOf = (iso: string, timezone: string) => formatInTimeZone(new Date(iso), timezone, 'EEE');
const weekdayOfDate = (date: string) => formatInTimeZone(new Date(`${date}T12:00:00Z`), 'UTC', 'EEE');

/** The day before yyyy-MM-dd. */
function previousDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The time part of an event line. An event that crosses the summary day's edges says
 * so: on its own, "22:00 - 02:00" on the day after a late party reads as that evening.
 */
function timeLabel(event: CalendarEvent, timezone: string, day?: string): string {
  // Shaped events carry their span; anything else is worked out here when the day is
  // known, so the line is right even if a caller skipped shapeEventsForDay.
  const span = event.daySpan ?? (day ? daySpanOf(event, day, timezone) ?? undefined : undefined);
  if (isAllDayEvent(event)) {
    const lastDay = event.end && !event.end.includes('T') ? previousDate(event.end) : event.start;
    switch (span) {
      case 'endsLater': return `All day, through ${weekdayOfDate(lastDay)}`;
      case 'continues': return `All day (last day; began ${weekdayOfDate(event.start)})`;
      case 'spansDay': return `All day (began ${weekdayOfDate(event.start)}, through ${weekdayOfDate(lastDay)})`;
      default: return 'All day';
    }
  }

  const start = clock(event.start, timezone);
  const end = clock(event.end, timezone);
  const startDay = localDate(new Date(event.start), timezone);
  const endDay = localDate(new Date(event.end), timezone);
  switch (span) {
    case 'endsLater':
      return endDay === nextDate(startDay) ? `${start} - ${end} next day` : `from ${start} until ${weekdayOf(event.end, timezone)} ${end}`;
    case 'continues': {
      const began = day && startDay === previousDate(day) ? 'yesterday' : weekdayOf(event.start, timezone);
      return `until ${end} (started ${began} ${start})`;
    }
    case 'spansDay':
      return `all day (${weekdayOf(event.start, timezone)} ${start} - ${weekdayOf(event.end, timezone)} ${end})`;
    default:
      return `${start} - ${end}`;
  }
}

/**
 * Format a single event for inclusion in the Claude prompt
 * @param day - The summary day (yyyy-MM-dd), so a carried-over event can say "yesterday"
 */
export function formatEventForPrompt(event: CalendarEvent, index: number, timezone: string = TIMEZONE, day?: string): string {
  const timeStr = isBirthdayEvent(event) ? 'Birthday' : timeLabel(event, timezone, day);

  const summary = sanitizeEventField(event.summary);
  const calendarName = sanitizeEventField(event.calendarName);
  let eventStr = `${index + 1}. ${summary} (${timeStr}) [Calendar: ${calendarName}]`;

  if (event.location) {
    eventStr += ` at ${sanitizeEventField(event.location)}`;
  }

  if (event.description) {
    eventStr += `\n   Description: ${sanitizeEventField(event.description, 200)}`;
  }

  return eventStr;
}

/**
 * Format a list of events for the prompt
 * Returns 'None' if the list is empty
 */
export function formatEventList(events: CalendarEvent[], timezone?: string, day?: string): string {
  if (events.length === 0) {
    return 'None';
  }

  return events.map((event, index) => formatEventForPrompt(event, index, timezone, day)).join('\n');
}
