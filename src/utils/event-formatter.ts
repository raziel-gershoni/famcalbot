import { CalendarEvent } from '../types';
import { TIMEZONE } from '../config/constants';

/**
 * Format a single event for inclusion in the Claude prompt
 */
export function formatEventForPrompt(event: CalendarEvent, index: number): string {
  const startTime = new Date(event.start).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
  const endTime = new Date(event.end).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });

  let eventStr = `${index + 1}. ${event.summary} (${startTime} - ${endTime}) [Calendar: ${event.calendarName}]`;

  if (event.location) {
    eventStr += ` at ${event.location}`;
  }

  if (event.description) {
    eventStr += `\n   Description: ${event.description}`;
  }

  return eventStr;
}

/**
 * Format a list of events for the prompt
 * Returns 'None' if the list is empty
 */
export function formatEventList(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return 'None';
  }

  return events.map((event, index) => formatEventForPrompt(event, index)).join('\n');
}
