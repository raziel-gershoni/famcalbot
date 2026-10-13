import { formatInTimeZone } from 'date-fns-tz';
import { CalendarEvent } from '../types';
import { TIMEZONE } from '../config/constants';
import { addDaysToDate, daySpanOf, localDate, nextDate } from './day-events';

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
// "Sat", or "Sat 17" when the weekday alone would be ambiguous (see eventTimeLabel).
const weekdayOf = (iso: string, timezone: string, dated = false) => formatInTimeZone(new Date(iso), timezone, dated ? 'EEE d' : 'EEE');
const weekdayOfDate = (date: string, dated = false) => formatInTimeZone(new Date(`${date}T12:00:00Z`), 'UTC', dated ? 'EEE d' : 'EEE');

/**
 * The most days apart an event's first and last day can be for weekday names alone to
 * tell them apart; a week apart, "Sat 15:00 - Sat 12:00" does not say which Saturday.
 */
const WEEKDAY_ONLY_SPAN_DAYS = 6;

/** The day before yyyy-MM-dd. */
function previousDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The time part of an event line. An event that crosses the summary day's edges says
 * so: on its own, "22:00 - 02:00" on the day after a late party reads as that evening.
 * The week lookahead uses it for an event already running on its first day. Its days
 * are weekday names, with the day of the month added once the ends are more than
 * WEEKDAY_ONLY_SPAN_DAYS apart.
 */
export function eventTimeLabel(event: CalendarEvent, timezone: string, day?: string): string {
  // Shaped events carry their span; anything else is worked out here when the day is
  // known, so the line is right even if a caller skipped shapeEventsForDay.
  const span = event.daySpan ?? (day ? daySpanOf(event, day, timezone) ?? undefined : undefined);
  if (isAllDayEvent(event)) {
    const lastDay = event.end && !event.end.includes('T') ? previousDate(event.end) : event.start;
    const dated = lastDay > addDaysToDate(event.start, WEEKDAY_ONLY_SPAN_DAYS);
    switch (span) {
      case 'endsLater': return `All day, through ${weekdayOfDate(lastDay, dated)}`;
      case 'continues': return `All day (last day; began ${weekdayOfDate(event.start, dated)})`;
      case 'spansDay': return `All day (began ${weekdayOfDate(event.start, dated)}, through ${weekdayOfDate(lastDay, dated)})`;
      default: return 'All day';
    }
  }

  const start = clock(event.start, timezone);
  const end = clock(event.end, timezone);
  const startDay = localDate(new Date(event.start), timezone);
  const endDay = localDate(new Date(event.end), timezone);
  const dated = endDay > addDaysToDate(startDay, WEEKDAY_ONLY_SPAN_DAYS);
  switch (span) {
    case 'endsLater':
      return endDay === nextDate(startDay) ? `${start} - ${end} next day` : `from ${start} until ${weekdayOf(event.end, timezone, dated)} ${end}`;
    case 'continues': {
      const began = day && startDay === previousDate(day) ? 'yesterday' : weekdayOf(event.start, timezone, dated);
      return `until ${end} (started ${began} ${start})`;
    }
    case 'spansDay':
      return `all day (${weekdayOf(event.start, timezone, dated)} ${start} - ${weekdayOf(event.end, timezone, dated)} ${end})`;
    default:
      return `${start} - ${end}`;
  }
}

/**
 * Format a single event for inclusion in the Claude prompt
 * @param day - The summary day (yyyy-MM-dd), so a carried-over event can say "yesterday"
 */
export function formatEventForPrompt(event: CalendarEvent, index: number, timezone: string = TIMEZONE, day?: string): string {
  const timeStr = isBirthdayEvent(event) ? 'Birthday' : eventTimeLabel(event, timezone, day);

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
