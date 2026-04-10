import { CalendarEvent } from '../types';
import { TIMEZONE } from '../config/constants';

/** Light sanitizer for event fields — strips newlines and markdown links, preserves legitimate text */
function sanitizeEventField(text: string, maxLen = 500): string {
  return text.replace(/\n/g, ' ').replace(/\[.*?\]/g, '').trim().slice(0, maxLen);
}

/**
 * Format a single event for inclusion in the Claude prompt
 */
export function formatEventForPrompt(event: CalendarEvent, index: number, timezone: string = TIMEZONE): string {
  const startTime = new Date(event.start).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });
  const endTime = new Date(event.end).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });

  const summary = sanitizeEventField(event.summary);
  const calendarName = sanitizeEventField(event.calendarName);
  let eventStr = `${index + 1}. ${summary} (${startTime} - ${endTime}) [Calendar: ${calendarName}]`;

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
export function formatEventList(events: CalendarEvent[], timezone?: string): string {
  if (events.length === 0) {
    return 'None';
  }

  return events.map((event, index) => formatEventForPrompt(event, index, timezone)).join('\n');
}
