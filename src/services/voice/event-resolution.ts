/**
 * Voice event resolution and matching
 * Handles finding/matching events and tracking created events
 */

import { redis } from '../../utils/redis';
import { getBot } from '../telegram';
import { ParsedEvent, EventReference, EditRequest } from '../event-parser';
import { fetchEventsInRange, CalendarEvent, UpdateEventData } from '../calendar';
import { generateAICompletion } from '../ai-provider';
import { fromZonedTime } from 'date-fns-tz';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';

/**
 * Download voice file from Telegram CDN
 */
export async function downloadVoiceFile(fileId: string): Promise<Buffer> {
  const bot = getBot();

  const fileInfo = await bot.getFile(fileId);
  const filePath = fileInfo.file_path;

  if (!filePath) {
    throw new Error('Could not get file path from Telegram');
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download voice file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Track last created event per user for "edit that" / "cancel that" references
 */
export interface CreatedEventTracker {
  eventId: string;
  calendarId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  createdAt: Date;
}

const LAST_CREATED_TTL_SECONDS = 1800; // 30 minutes

/**
 * Store a created event for "last created" reference
 */
export async function trackCreatedEvent(
  userId: number,
  eventId: string,
  calendarId: string,
  event: ParsedEvent
): Promise<void> {
  try {
    await redis.set(
      REDIS_KEYS.lastCreatedEvent(userId),
      {
        eventId,
        calendarId,
        title: event.title,
        startTime: event.startTime,
        endTime: event.endTime,
        location: event.location,
        createdAt: new Date(),
      },
      { ex: LAST_CREATED_TTL_SECONDS }
    );
  } catch (error) {
    console.error('[Voice] Error tracking created event in Redis:', error);
    captureError(error, 'voice-event-resolution');
  }
}

/**
 * Get the last created event for a user
 */
export async function getLastCreatedEvent(userId: number): Promise<CreatedEventTracker | undefined> {
  try {
    const data = await redis.get<CreatedEventTracker>(REDIS_KEYS.lastCreatedEvent(userId));
    if (!data) return undefined;
    // Reconstruct Date objects from JSON strings
    data.startTime = new Date(data.startTime);
    data.endTime = new Date(data.endTime);
    data.createdAt = new Date(data.createdAt);
    return data;
  } catch (error) {
    console.error('[Voice] Error getting last created event from Redis:', error);
    captureError(error, 'voice-event-resolution');
    return undefined;
  }
}

/**
 * Find a matching event based on description and time hint
 * Uses AI to match event titles and returns the best match
 */
export async function findMatchingEvent(
  refreshToken: string,
  calendarIds: string[],
  reference: EventReference,
  language: string
): Promise<{ event: CalendarEvent; calendarId: string } | { error: string; multiple?: CalendarEvent[] }> {
  // Determine date range based on timeHint
  const now = new Date();
  let startDate = new Date(now);
  let endDate = new Date(now);

  // Default: search 2 weeks ahead and 1 week back
  startDate.setDate(startDate.getDate() - 7);
  endDate.setDate(endDate.getDate() + 14);

  // If timeHint is provided, narrow the search
  if (reference.timeHint) {
    const hint = reference.timeHint.toLowerCase();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    if (hint.includes('today') || hint.includes('היום') || hint.includes('сегодня')) {
      startDate = today;
      endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);
    } else if (hint.includes('tomorrow') || hint.includes('מחר') || hint.includes('завтра')) {
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() + 1);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
    } else if (hint.includes('next week') || hint.includes('שבוע הבא') || hint.includes('следующ')) {
      startDate = new Date(today);
      endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 14);
    }
  }

  // Fetch events from all calendars
  const events = await fetchEventsInRange(refreshToken, calendarIds, startDate, endDate);

  if (events.length === 0) {
    return { error: 'no_events_found' };
  }

  // If no description, can't match
  if (!reference.description) {
    return { error: 'no_description' };
  }

  // Use AI to find the best matching event
  const eventList = events.map((e, i) => {
    const startDate = new Date(e.start);
    const timeStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${i + 1}. "${e.summary}" on ${startDate.toLocaleDateString()} at ${timeStr} (calendar: ${e.calendarId})`;
  }).join('\n');

  const prompt = `Find the event that best matches the user's description.

User's description: "${reference.description}"
${reference.timeHint ? `Date hint: "${reference.timeHint}"` : ''}
${reference.originalTime ? `Original event time: "${reference.originalTime}" (IMPORTANT: strongly prefer events starting at this exact time)` : ''}
User language: ${language}

Available events:
${eventList}

MATCHING CRITERIA (in priority order):
1. Title must contain the user's description keywords (partial match OK, e.g., "dentist" matches "Dentist appointment")
2. If originalTime is provided (e.g., "15:00"):
   - STRONG MATCH: Event starts at exactly that time
   - WEAK MATCH: Event starts within ±1 hour
   - If multiple title matches exist, the time match MUST be used to disambiguate
3. If timeHint is provided (e.g., "tomorrow"), prefer events on that date
4. If multiple events match ALL criteria equally, return "multiple"
5. If no event matches the description, return "none"

RESPOND IN JSON:
{
  "match": "single" | "multiple" | "none",
  "eventIndex": <1-based index if single match>,
  "matchedIndexes": [<indexes if multiple>],
  "confidence": "high" | "medium" | "low"
}`;

  try {
    const result = await generateAICompletion(prompt);
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return { error: 'ai_parse_error' };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.match === 'none') {
      return { error: 'no_match' };
    }

    if (parsed.match === 'multiple') {
      const matchedEvents = (parsed.matchedIndexes || []).map((i: number) => events[i - 1]).filter(Boolean);
      return { error: 'multiple_matches', multiple: matchedEvents };
    }

    if (parsed.match === 'single' && parsed.eventIndex) {
      const matchedEvent = events[parsed.eventIndex - 1];
      if (matchedEvent) {
        return { event: matchedEvent, calendarId: matchedEvent.calendarId };
      }
    }

    return { error: 'no_match' };
  } catch (error) {
    console.error('[Voice] Error matching event:', error);
    captureError(error, 'voice-event-resolution');
    return { error: 'ai_error' };
  }
}

/**
 * Helper to convert EditRequest to UpdateEventData
 */
export function convertEditRequestToUpdates(
  editRequest: EditRequest | undefined,
  originalEvent: CalendarEvent,
  timezone: string
): UpdateEventData {
  const updates: UpdateEventData = {};

  if (!editRequest) return updates;

  if (editRequest.newTitle) {
    updates.title = editRequest.newTitle;
  }

  // Handle time changes
  const originalStart = new Date(originalEvent.start);
  const originalEnd = new Date(originalEvent.end);
  const duration = originalEnd.getTime() - originalStart.getTime();

  // Get original times in user's timezone
  const originalStartLocal = originalStart.toLocaleString('sv-SE', { timeZone: timezone });
  const [originalDatePart, originalTimePart] = originalStartLocal.split(' ');
  const originalEndLocal = originalEnd.toLocaleString('sv-SE', { timeZone: timezone });
  const [originalEndDatePart, originalEndTimePart] = originalEndLocal.split(' ');

  if (editRequest.newStartDate || editRequest.newStartTime) {
    const newStartDate = editRequest.newStartDate || originalDatePart;
    const newStartTime = editRequest.newStartTime || originalTimePart.substring(0, 5);
    updates.startTime = fromZonedTime(`${newStartDate}T${newStartTime}:00`, timezone);

    if (editRequest.newEndDate || editRequest.newEndTime) {
      const newEndDate = editRequest.newEndDate || originalEndDatePart;
      const newEndTime = editRequest.newEndTime || originalEndTimePart.substring(0, 5);
      updates.endTime = fromZonedTime(`${newEndDate}T${newEndTime}:00`, timezone);
    } else {
      updates.endTime = new Date(updates.startTime.getTime() + duration);
    }
  } else if (editRequest.newEndDate || editRequest.newEndTime) {
    const newEndDate = editRequest.newEndDate || originalEndDatePart;
    const newEndTime = editRequest.newEndTime || originalEndTimePart.substring(0, 5);
    updates.endTime = fromZonedTime(`${newEndDate}T${newEndTime}:00`, timezone);
  }

  if (editRequest.newLocation) {
    updates.location = editRequest.newLocation;
  }

  if (editRequest.newAllDay !== undefined) {
    updates.allDay = editRequest.newAllDay;
  }

  return updates;
}
