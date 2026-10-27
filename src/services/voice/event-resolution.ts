/**
 * Voice event resolution and matching
 * Handles finding/matching events and tracking created events
 */

import { redis } from '../../utils/redis';
import { getBot } from '../telegram';
import { ParsedEvent, EventReference, EditRequest } from '../event-parser';
import { CalendarEvent, UpdateEventData } from '../calendar';
import { fetchEventsInRange, type SplitFetch } from '../calendar-provider';
import type { UnifiedEvent } from '../calendar-provider/types';
import { isNativeCalendarId } from '../native-calendar/event-store';
import type { UserConfig } from '../../types';
import { generateAICompletion } from '../ai-provider';
import { formatInTimeZone } from 'date-fns-tz';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { resolveUserTimezone } from '../../lib/timezone';
import { addDaysToDate, daySpanOf, localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { wallTimeToInstant } from '../../utils/wall-time';
import { isAllDayEvent, isReminderEvent } from '../../utils/event-formatter';
import { loadViewerContext } from '../native-reminders/ownership';
import { fetchOpenReminders } from '../native-reminders/open-reminders';
import { DEFAULT_REMINDER_TIME, isValidReminderTime } from '../../lib/reminder-time';

/**
 * Download any file from the Telegram CDN by file_id (voice, photo, document).
 */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
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
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Download a voice file from Telegram CDN (thin alias over downloadTelegramFile).
 */
export async function downloadVoiceFile(fileId: string): Promise<Buffer> {
  return downloadTelegramFile(fileId);
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
 * Whether a fetched event is the one created last. A repeating native item was created,
 * and tracked, as its series ("<cuid>"), while each of its fetched occurrences is
 * "<cuid>#<start>" with the series as its recurringEventId (spec §11.3).
 */
export function isLastCreatedEvent(event: CalendarEvent, last: Pick<CreatedEventTracker, 'eventId' | 'calendarId'>): boolean {
  if (event.eventId === last.eventId) return true;
  return isNativeCalendarId(last.calendarId) && event.recurringEventId === last.eventId;
}

/** The part of a reference that says which day: the model's date for it, or the user's words. */
type DayReference = Pick<EventReference, 'timeHint' | 'originalDate'>;

/**
 * Weekday names as a time hint says them, Sunday first: English, Hebrew ("ביום חמישי",
 * "בשבת") and Russian in the forms it takes after a preposition ("в среду", "до пятницы").
 */
const WEEKDAY_NAMES: RegExp[] = [
  /\bsunday\b|יום ראשון(?![א-ת])|(?<![а-яё])воскресень[еяю](?![а-яё])/,
  /\bmonday\b|יום שני(?![א-ת])|(?<![а-яё])понедельник[аеу]?(?![а-яё])/,
  /\btuesday\b|יום שלישי(?![א-ת])|(?<![а-яё])вторник[аеу]?(?![а-яё])/,
  /\bwednesday\b|יום רביעי(?![א-ת])|(?<![а-яё])сред[аеуы](?![а-яё])/,
  /\bthursday\b|יום חמישי(?![א-ת])|(?<![а-яё])четверг[аеу]?(?![а-яё])/,
  /\bfriday\b|יום שישי(?![א-ת])|(?<![а-яё])пятниц[аеуы](?![а-яё])/,
  /\bsaturday\b|(?<![א-ת])[בהלו]?שבת(?![א-ת])|(?<![а-яё])суббот[аеуы](?![а-яё])/,
];

/**
 * Words that make a weekday some other one than the coming one: "last Thursday", "next
 * Thursday" (this week's or the one after), "the Thursday before", "יום חמישי שעבר",
 * "в прошлый четверг", and "ערב שבת", which is Friday evening.
 */
const NOT_THE_COMING_ONE = /\b(last|previous|past|next|following|after|before|ago)\b|שעבר|הקודם|הבא|אחרי|לפני|ערב שבת|прошл|предыдущ|следующ|после|перед/;

/**
 * The day a reference names, yyyy-MM-dd on the user's clock: the date the model read for
 * it, else today, tomorrow, the day after or the coming weekday its time hint names.
 * Other hints name no single day ("next week", "last Thursday") or are left to the matcher.
 */
export function hintedDay(reference: DayReference, now: Date, timezone: string): string | undefined {
  const { originalDate, timeHint } = reference;
  // The model sends null, a placeholder or a date that does not exist (02-30) too
  if (originalDate && /^\d{4}-\d{2}-\d{2}$/.test(originalDate)) {
    const parsed = new Date(`${originalDate}T00:00:00Z`);
    if (!isNaN(parsed.getTime()) && parsed.toISOString().startsWith(originalDate)) return originalDate;
  }
  if (!timeHint) return undefined;
  const hint = timeHint.toLowerCase();
  const today = localDate(now, timezone);

  // Before "tomorrow", which each of these contains
  if (hint.includes('day after tomorrow') || hint.includes('מחרתיים') || hint.includes('послезавтра')) {
    return addDaysToDate(today, 2);
  }
  if (hint.includes('today') || hint.includes('היום') || hint.includes('сегодня')) return today;
  if (hint.includes('tomorrow') || hint.includes('מחר') || hint.includes('завтра')) return nextDate(today);

  // One weekday, with no date or word that makes it another: today when it is that day
  const named = WEEKDAY_NAMES.flatMap((pattern, weekday) => (pattern.test(hint) ? [weekday] : []));
  if (named.length !== 1 || /\d/.test(hint) || NOT_THE_COMING_ONE.test(hint)) return undefined;
  const todaysWeekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDaysToDate(today, (named[0] - todaysWeekday + 7) % 7);
}

/** yyyy-MM-dd with its weekday, "Thursday 2026-10-15", as the matcher reads a date. */
function withWeekday(day: string): string {
  return `${formatInTimeZone(new Date(`${day}T12:00:00Z`), 'UTC', 'EEEE')} ${day}`;
}

/**
 * Where to look for the event a voice edit or delete refers to: a week back to two weeks
 * ahead, or the days a reference names. "Today" is the user's day, not the server's.
 */
export function matchSearchRange(
  reference: DayReference,
  now: Date,
  timezone: string
): { startDate: Date; endDate: Date } {
  let startDate = new Date(now);
  let endDate = new Date(now);

  // Default: search 2 weeks ahead and 1 week back
  startDate.setDate(startDate.getDate() - 7);
  endDate.setDate(endDate.getDate() + 14);

  // If the reference names a day or a time hint is provided, narrow the search
  const { timeHint } = reference;
  const day = hintedDay(reference, now, timezone);
  if (day) {
    startDate = startOfLocalDay(day, timezone);
    endDate = startOfLocalDay(nextDate(day), timezone);
  } else if (timeHint) {
    const hint = timeHint.toLowerCase();
    const today = localDate(now, timezone);

    if (hint.includes('next week') || hint.includes('שבוע הבא') || hint.includes('следующ')) {
      startDate = startOfLocalDay(today, timezone);
      endDate = startOfLocalDay(addDaysToDate(today, 14), timezone);
    }
  }

  return { startDate, endDate };
}

/**
 * One candidate event as the matcher reads it, on the user's clock, its dates with their
 * weekdays for a hint like "Thursday". An all-day event keeps its own date: read as an
 * instant it is UTC midnight, the day before west of UTC. One that runs into a later day
 * says until when, so the matcher can tell tonight's sleepover from tomorrow's.
 */
export function describeEventForMatching(event: CalendarEvent, index: number, timezone: string): string {
  const span = localSpan(event, timezone);
  const allDay = isAllDayEvent(event);
  let when = allDay ? `on ${withWeekday(span.startDate)} (all day)` : `on ${withWeekday(span.startDate)} at ${span.startTime}`;
  if (span.lastDay !== span.startDate) {
    when += allDay ? ` until ${withWeekday(span.lastDay)}` : ` until ${withWeekday(span.endDate)} ${span.endTime}`;
  }
  return `${index + 1}. ${reminderTag(event)}"${event.summary}" ${when} (calendar: ${event.calendarId})`;
}

/** "[reminder] ", or "[reminder for Dana] " when it is the partner's, before a reminder's title. */
function reminderTag(event: CalendarEvent): string {
  if (!isReminderEvent(event)) return '';
  const owner = event.reminder && !event.reminder.ownerIsViewer ? event.reminder.ownerName : undefined;
  return owner ? `[reminder for ${owner}] ` : '[reminder] ';
}

/**
 * Words that name a reminder in English, Hebrew and Russian: "reminder", "remind",
 * "תזכורת", "להזכיר", "תזכיר", "напоминание", "напомни".
 */
const REMINDER_WORDS = /remind|תזכור|הזכיר|תזכיר|напомин|напомн/i;

/** Whether the user's words ask about a reminder rather than an event. */
function asksForReminder(text: string): boolean {
  return REMINDER_WORDS.test(text);
}

/**
 * The matcher's tie rule when reminders are among the candidates (spec §7): an event
 * wins a tie with a reminder of the same title, unless the user asked about a reminder.
 */
const REMINDER_RULES = {
  preferEvents: '6. Items tagged [reminder] are reminders ("[reminder for Dana]" is one for Dana); the others are events. When an event and a reminder match equally, choose the event',
  preferReminders: '6. Items tagged [reminder] are reminders ("[reminder for Dana]" is one for Dana); the others are events. The user is asking about a reminder: when an event and a reminder match equally, choose the reminder',
} as const;

export type ReminderRule = keyof typeof REMINDER_RULES;

/**
 * The matcher's prompt. It states the user's date and the day the reference names: the
 * search returns every event overlapping that day, and told only "tomorrow" the matcher
 * could not tell tomorrow's sleepover from tonight's, which runs into it.
 */
export function buildMatchPrompt(
  reference: EventReference,
  language: string,
  eventList: string,
  now: Date,
  timezone: string,
  reminderRule?: ReminderRule
): string {
  const day = hintedDay(reference, now, timezone);
  const today = `Today is ${withWeekday(localDate(now, timezone))}`;
  const meaning = reference.timeHint ? `"${reference.timeHint}" means` : 'the user means';

  return `Find the event that best matches the user's description.

User's description: "${reference.description}"
${day ? `${today}; ${meaning} ${withWeekday(day)}.` : `${today}.`}
${reference.timeHint && !day ? `Date hint: "${reference.timeHint}"` : ''}
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
3. If a date is meant (e.g., "tomorrow"), prefer events that start on that date; count one carried over from an earlier day only when none starting on it matches
4. If multiple events match ALL criteria equally, return "multiple"
5. If no event matches the description, return "none"${reminderRule ? `\n${REMINDER_RULES[reminderRule]}` : ''}

RESPOND IN JSON:
{
  "match": "single" | "multiple" | "none",
  "eventIndex": <1-based index if single match>,
  "matchedIndexes": [<indexes if multiple>],
  "confidence": "high" | "medium" | "low"
}`;
}

type MatchResult = { event: CalendarEvent; calendarId: string } | { error: string; multiple?: CalendarEvent[] };

/** What a caller adds to the search. */
export interface MatchOptions {
  /** Which of the events in range may match (a reminder's anchor: upcoming events only, never reminders). */
  eligible?: (events: CalendarEvent[]) => CalendarEvent[];
  /** A chat edit or delete: the user's own words. Naming a reminder in them lets a reminder win a tie with an event. */
  request?: string;
  /** A chat edit or delete: offer the user's open reminders too, however old (built-in calendar only). */
  openReminders?: boolean;
}

/** What every round of one search shares: the open reminders, whether a reminder is meant, and the caller's filter. */
interface MatchExtras {
  open: CalendarEvent[];
  wantsReminder: boolean;
  eligible?: MatchOptions['eligible'];
}

/**
 * Find a matching event based on description and time hint
 * Uses AI to match event titles and returns the best match
 */
export async function findMatchingEvent(
  user: UserConfig,
  calendarIds: string[],
  reference: EventReference,
  language: string,
  now: Date = new Date(),
  options: MatchOptions = {}
): Promise<MatchResult> {
  const timezone = await resolveUserTimezone(user);
  const day = hintedDay(reference, now, timezone);
  const extras: MatchExtras = {
    open: options.openReminders ? await openReminderCandidates(user, now, timezone) : [],
    wantsReminder: asksForReminder(`${options.request ?? ''} ${reference.description ?? ''}`),
    eligible: options.eligible,
  };
  const narrowed = await matchInRange(user, calendarIds, reference, language, now, timezone, day, extras);

  // A day taken from a weekday name or the model's own date is a guess the old search never
  // made: it looked three weeks around today. When that guess finds nothing, look there
  // too, so a wrong date costs a second search rather than the user's edit. "Today" and
  // "tomorrow" narrowed the search before and still do, without this fallback. A half that
  // couldn't be read doesn't stop the widening: the event may sit on another day of the half
  // that could.
  const guessedDay = day !== undefined && !/today|tomorrow|היום|מחר|сегодня|завтра/i.test(reference.timeHint ?? '');
  if (guessedDay && foundNothing(narrowed.result)) {
    const wide = { ...reference, originalDate: undefined, timeHint: undefined };
    const widened = await matchInRange(user, calendarIds, wide, language, now, timezone, undefined, extras);
    return unlessUnread(user, widened.result, [...new Set([...narrowed.failed, ...widened.failed])]);
  }
  return unlessUnread(user, narrowed.result, narrowed.failed);
}

function foundNothing(result: MatchResult): boolean {
  return 'error' in result && (result.error === 'no_events_found' || result.error === 'no_match');
}

/**
 * A search that found nothing while a half couldn't be read: "not found" would be a guess,
 * since that half may hold the event. Say which calendar couldn't be checked instead (the
 * user is told Google couldn't be reached).
 */
function unlessUnread(user: UserConfig, result: MatchResult, failed: SplitFetch['failed']): MatchResult {
  if (!foundNothing(result) || failed.length === 0) return result;
  console.warn(`[EventResolution] user ${user.id}: no match while ${failed.join(', ')} could not be read`);
  return { error: failed.includes('google') ? UNAVAILABLE.google : UNAVAILABLE.famcal };
}

/**
 * The user's open reminders, however old: an undone one stays in their digests ("open
 * since Monday") until it is done, so it must stay reachable by voice after the search's
 * week back. Only the built-in calendar has reminders. A failed lookup costs only these.
 */
async function openReminderCandidates(user: UserConfig, now: Date, timezone: string): Promise<CalendarEvent[]> {
  try {
    const ctx = await loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null });
    const { events } = await fetchOpenReminders(user, ctx, now, localDate(now, timezone), timezone, Infinity);
    return events;
  } catch (error) {
    captureError(error, 'voice-event-resolution', { user_id: user.id }, 'warning');
    return [];
  }
}

/** The open reminders the search's range did not already bring, ahead of its events. */
function withOpenReminders(events: CalendarEvent[], open: CalendarEvent[]): CalendarEvent[] {
  const fetched = new Set(events.map(e => e.eventId));
  const added = open.filter(e => !fetched.has(e.eventId));
  return added.length > 0 ? [...added, ...events] : events;
}

/** yyyy-MM-dd HH:mm on the user's clock, which orders one series' occurrences. */
function startKey(event: CalendarEvent, timezone: string): string {
  const span = localSpan(event, timezone);
  return `${span.startDate} ${span.startTime}`;
}

/** Whether an occurrence is still ahead: a date-only one all through its day. */
function isUpcoming(event: CalendarEvent, now: Date, timezone: string): boolean {
  return isAllDayEvent(event) ? event.start >= localDate(now, timezone) : new Date(event.start) >= now;
}

/**
 * One candidate per repeating reminder: its nearest occurrence from now on, else its
 * latest one before now. A daily reminder would otherwise put three weeks of identical
 * lines before the matcher, which could only answer "multiple". Events, one-off
 * reminders and the order are left as they are.
 */
export function collapseReminderSeries(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[] {
  const seriesOf = (e: CalendarEvent) => (isReminderEvent(e) ? e.recurringEventId : undefined);
  const chosen = new Map<string, CalendarEvent>();
  for (const event of events) {
    const series = seriesOf(event);
    if (!series) continue;
    const current = chosen.get(series);
    if (!current) {
      chosen.set(series, event);
      continue;
    }
    const ahead = isUpcoming(event, now, timezone);
    if (ahead !== isUpcoming(current, now, timezone)) {
      if (ahead) chosen.set(series, event);
      continue;
    }
    const earlier = startKey(event, timezone) < startKey(current, timezone);
    // Ahead: the soonest. Behind: the latest.
    if (ahead === earlier) chosen.set(series, event);
  }
  return events.filter(e => {
    const series = seriesOf(e);
    return !series || chosen.get(series) === e;
  });
}

/**
 * When the matcher cannot choose between events and reminders, the event wins, unless the
 * user asked about a reminder (spec §7). A tie among events alone, or among reminders
 * alone, stays "multiple".
 */
function settleKindTie(result: MatchResult, wantsReminder: boolean): MatchResult {
  if (!('error' in result) || result.error !== 'multiple_matches' || !result.multiple) return result;
  const reminders = result.multiple.filter(isReminderEvent);
  if (reminders.length === 0 || reminders.length === result.multiple.length) return result;
  const preferred = wantsReminder ? reminders : result.multiple.filter(e => !isReminderEvent(e));
  return preferred.length === 1
    ? { event: preferred[0], calendarId: preferred[0].calendarId }
    : { error: 'multiple_matches', multiple: preferred };
}

/**
 * The errors of a search that could not read one half of the user's calendars and found
 * nothing in the other: the voice handlers answer them with "couldn't reach Google Calendar"
 * and the calendar fetch error.
 */
export const UNAVAILABLE = { google: 'google_unavailable', famcal: 'calendar_unavailable' } as const;

/**
 * The match within the range `reference` names, its own day's events tried first, and the
 * halves that couldn't be read.
 */
async function matchInRange(
  user: UserConfig,
  calendarIds: string[],
  reference: EventReference,
  language: string,
  now: Date,
  timezone: string,
  day: string | undefined,
  extras: MatchExtras,
): Promise<{ result: MatchResult; failed: SplitFetch['failed'] }> {
  const { startDate, endDate } = matchSearchRange(reference, now, timezone);

  // Fetch events from all calendars, split by calendar id (spec §4 Providers)
  const { events: fetched, failed } = await fetchEventsInRange(user, calendarIds, startDate, endDate);
  const merged = withOpenReminders(fetched, extras.open);
  const events = collapseReminderSeries(extras.eligible ? extras.eligible(merged) : merged, now, timezone);

  const result = await matchAmong(events, reference, language, now, timezone, day, extras);
  return { result, failed };
}

/** The match among `events`, its own day's events tried first. */
async function matchAmong(
  events: CalendarEvent[],
  reference: EventReference,
  language: string,
  now: Date,
  timezone: string,
  day: string | undefined,
  extras: MatchExtras,
): Promise<MatchResult> {
  if (events.length === 0) {
    return { error: 'no_events_found' };
  }

  // If no description, can't match
  if (!reference.description) {
    return { error: 'no_description' };
  }

  // The day a reference names is matched against its own events first: "tomorrow's
  // sleepover" or "Thursday's" is the one starting that day, not the night before's that
  // runs into it. Those carried over from an earlier day are tried only when none of its
  // own is the one meant.
  const own = day ? events.filter(e => localSpan(e, timezone).startDate === day) : events;
  const rounds = own.length > 0 && own.length < events.length ? [own, events.filter(e => !own.includes(e))] : [events];

  let result: MatchResult = { error: 'no_match' };
  for (const candidates of rounds) {
    const eventList = candidates.map((e, i) => describeEventForMatching(e, i, timezone)).join('\n');
    const rule: ReminderRule | undefined = candidates.some(isReminderEvent)
      ? extras.wantsReminder ? 'preferReminders' : 'preferEvents'
      : undefined;
    const prompt = buildMatchPrompt(reference, language, eventList, now, timezone, rule);
    result = settleKindTie(await askMatcher(prompt, candidates), extras.wantsReminder);
    if (!('error' in result) || result.error !== 'no_match') break;
  }
  return result;
}

/** Use AI to find the best matching event among `candidates`, listed in that order in `prompt`. */
async function askMatcher(prompt: string, candidates: CalendarEvent[]): Promise<MatchResult> {
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
      const matchedEvents = (parsed.matchedIndexes || []).map((i: number) => candidates[i - 1]).filter(Boolean);
      return { error: 'multiple_matches', multiple: matchedEvents };
    }

    if (parsed.match === 'single' && parsed.eventIndex) {
      const matchedEvent = candidates[parsed.eventIndex - 1];
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
 * An event's first and last day (yyyy-MM-dd) and its start and end (HH:mm) on the user's
 * clock. An all-day event's days are its own date strings - Google's end date is
 * exclusive - read as 00:00 to 23:59, the shape the bot creates one in. Read as instants
 * they are UTC midnight, 03:00 in Israel and the evening before west of UTC. `lastDay` is
 * the last day it covers: a timed event ending at midnight does not reach the next one,
 * though its end (endDate, endTime) is there.
 */
function localSpan(event: CalendarEvent, timezone: string) {
  if (isAllDayEvent(event)) {
    const end = event.end && !event.end.includes('T') && event.end > event.start ? event.end : nextDate(event.start);
    const lastDay = addDaysToDate(end, -1);
    return { startDate: event.start, startTime: '00:00', endDate: lastDay, endTime: '23:59', lastDay };
  }
  const start = new Date(event.start);
  const end = new Date(event.end || event.start);
  return {
    startDate: localDate(start, timezone),
    startTime: formatInTimeZone(start, timezone, 'HH:mm'),
    endDate: localDate(end, timezone),
    endTime: formatInTimeZone(end, timezone, 'HH:mm'),
    lastDay: localDate(end > start ? new Date(end.getTime() - 1) : end, timezone),
  };
}

/** Calendar days from yyyy-MM-dd `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The day an event ends as people count it: its last day, but a timed one that ends by
 * OVERNIGHT_CUTOFF_HOUR the next morning belongs to the evening it starts (day-events),
 * so a party until 02:00 is one day's. An all-day event's last day is its own.
 */
function closingDay(event: CalendarEvent, span: { startDate: string; lastDay: string }, timezone: string): string {
  const lastNightsTail = span.lastDay > span.startDate && daySpanOf(event, span.lastDay, timezone) === null;
  return lastNightsTail ? addDaysToDate(span.lastDay, -1) : span.lastDay;
}

/**
 * An end at `time` (HH:mm) on `day`, or on the day after when that is not after `start`:
 * an evening party "until 02:00" ends the next morning.
 */
function endAfter(start: Date, day: string, time: string, timezone: string): Date {
  const end = wallTimeToInstant(`${day}T${time}:00`, timezone);
  return end > start ? end : wallTimeToInstant(`${nextDate(day)}T${time}:00`, timezone);
}

/** How long an all-day event made timed lasts when not given an end. */
const DEFAULT_TIMED_LENGTH_MS = 60 * 60 * 1000;

/**
 * An all-day event from `firstDay` to `lastDay` as creation saves one, for either
 * calendar: 00:00 local on the first day (startOfLocalDay) to 23:59 local on the last.
 * The native calendar stores the instants; the Google provider turns them into Google's
 * dates on the user's clock (calendar.ts).
 */
function allDayRange(firstDay: string, lastDay: string, timezone: string): { start: Date; end: Date } {
  return { start: startOfLocalDay(firstDay, timezone), end: wallTimeToInstant(`${lastDay}T23:59:00`, timezone) };
}

/**
 * The timezone an all-day edit is written in, which has to be the one its dates are read
 * back in: a native event's own (toUnifiedEvent reads its dates there, and it differs
 * from the user's on a shared calendar or after a move), else the user's, which the
 * Google provider reads them in.
 */
function allDayZone(event: CalendarEvent, timezone: string): string {
  const own = isNativeCalendarId(event.calendarId) ? (event as Partial<UnifiedEvent>).timeZone : undefined;
  return own || timezone;
}

/** An event's days and times as an edit confirmation shows them. */
export interface EditSpan {
  allDay: boolean;
  firstDay: string;
  lastDay: string;
  startTime: string;
  endTime: string;
}

/**
 * An event before and after `updates`, on the user's clock, for the edit confirmation.
 * New all-day days are read the way convertEditRequestToUpdates writes them, in the same
 * timezone: as instants on the user's clock a native 00:00 looked like a time change, and
 * a Google date like the day before west of UTC.
 */
export function describeEdit(
  originalEvent: CalendarEvent,
  updates: UpdateEventData,
  timezone: string
): { before: EditSpan; after: EditSpan } {
  const original = localSpan(originalEvent, timezone);
  const before: EditSpan = {
    allDay: isAllDayEvent(originalEvent),
    firstDay: original.startDate,
    lastDay: original.lastDay,
    startTime: original.startTime,
    endTime: original.endTime,
  };
  const allDay = updates.allDay ?? before.allDay;
  const zone = allDay ? allDayZone(originalEvent, timezone) : timezone;
  const { startTime, endTime } = updates;
  const firstDay = startTime ? localDate(startTime, zone) : before.firstDay;
  // The day of its last moment, as in localSpan: an end at midnight is the day before's
  const lastDay = endTime ? localDate(new Date(endTime.getTime() - 1), zone) : before.lastDay;
  return {
    before,
    after: {
      allDay,
      firstDay,
      lastDay: lastDay < firstDay ? firstDay : lastDay,
      startTime: startTime ? formatInTimeZone(startTime, zone, 'HH:mm') : before.startTime,
      endTime: endTime ? formatInTimeZone(endTime, zone, 'HH:mm') : before.endTime,
    },
  };
}

/**
 * Helper to convert EditRequest to UpdateEventData
 */
export function convertEditRequestToUpdates(
  editRequest: EditRequest | undefined,
  originalEvent: CalendarEvent,
  timezone: string,
  reminderTime?: string | null
): UpdateEventData {
  const updates: UpdateEventData = {};

  if (!editRequest) return updates;
  if (isReminderEvent(originalEvent)) return reminderUpdates(editRequest, originalEvent, timezone, reminderTime);

  if (editRequest.newTitle) {
    updates.title = editRequest.newTitle;
  }

  // Handle time changes
  const originalStart = new Date(originalEvent.start);
  const originalEnd = new Date(originalEvent.end);
  const duration = originalEnd.getTime() - originalStart.getTime();

  // Get original dates and times in user's timezone
  const original = localSpan(originalEvent, timezone);

  const wasAllDay = isAllDayEvent(originalEvent);
  // The model sends null for what it leaves alone, and allDay is a required Boolean
  const newAllDay = typeof editRequest.newAllDay === 'boolean' ? editRequest.newAllDay : undefined;
  // Its last day as people count it: a party until 02:00 made all-day is that evening's
  const lastDay = closingDay(originalEvent, original, timezone);
  if (newAllDay ?? wasAllDay) {
    // An all-day event has no time of day to move. Without a new end it keeps its length.
    // A timed event made all-day gets both ends, on its own days unless given others: its
    // timed instants would otherwise be saved as the all-day ones.
    if (editRequest.newStartDate || editRequest.newEndDate || !wasAllDay) {
      const newStartDate = editRequest.newStartDate || original.startDate;
      const newEndDate = editRequest.newEndDate || addDaysToDate(newStartDate, daysBetween(original.startDate, lastDay));
      const range = allDayRange(newStartDate, newEndDate, allDayZone(originalEvent, timezone));
      if (editRequest.newStartDate || !wasAllDay) {
        updates.startTime = range.start;
      }
      updates.endTime = range.end;
    }
  } else if (wasAllDay) {
    // An all-day event made timed gets times of its own: its all-day length is whole days,
    // and a Google date read as an instant is UTC midnight. It starts at the time given,
    // else at the start of its day as an all-day event is created, and lasts an hour
    // unless given an end time.
    const newStartDate = editRequest.newStartDate || original.startDate;
    updates.startTime = editRequest.newStartTime
      ? wallTimeToInstant(`${newStartDate}T${editRequest.newStartTime}:00`, timezone)
      : startOfLocalDay(newStartDate, timezone);
    if (!editRequest.newEndTime) {
      updates.endTime = new Date(updates.startTime.getTime() + DEFAULT_TIMED_LENGTH_MS);
    } else if (editRequest.newEndDate) {
      updates.endTime = wallTimeToInstant(`${editRequest.newEndDate}T${editRequest.newEndTime}:00`, timezone);
    } else {
      updates.endTime = endAfter(updates.startTime, newStartDate, editRequest.newEndTime, timezone);
    }
  } else if (editRequest.newStartDate || editRequest.newStartTime) {
    const newStartDate = editRequest.newStartDate || original.startDate;
    const newStartTime = editRequest.newStartTime || original.startTime;
    updates.startTime = wallTimeToInstant(`${newStartDate}T${newStartTime}:00`, timezone);

    if (editRequest.newEndDate) {
      updates.endTime = wallTimeToInstant(`${editRequest.newEndDate}T${editRequest.newEndTime || original.endTime}:00`, timezone);
    } else if (editRequest.newEndTime) {
      // Without a new end date the end keeps its day relative to the start: "the lesson
      // from tomorrow 15:00 to today 20:00, until 21:00" ends today, not tomorrow
      const endDay = addDaysToDate(newStartDate, daysBetween(original.startDate, lastDay));
      updates.endTime = endAfter(updates.startTime, endDay, editRequest.newEndTime, timezone);
    } else {
      updates.endTime = new Date(updates.startTime.getTime() + duration);
    }
  } else if (editRequest.newEndDate) {
    updates.endTime = wallTimeToInstant(`${editRequest.newEndDate}T${editRequest.newEndTime || original.endTime}:00`, timezone);
  } else if (editRequest.newEndTime) {
    updates.endTime = endAfter(originalStart, lastDay, editRequest.newEndTime, timezone);
  }

  if (editRequest.newLocation) {
    updates.location = editRequest.newLocation;
  }

  if (newAllDay !== undefined) {
    updates.allDay = newAllDay;
  }

  return updates;
}

/**
 * A reminder's edit. A reminder has one time and no length (spec §7): its end is its
 * start, a date-only one stays at 00:00 of its day, and an end the model sends out of
 * habit (an hour after the new start) is dropped. Given a time, a date-only reminder
 * becomes a timed one; made timed with no time, it rings at the requesting user's reminder time (09:00 unless set).
 */
function reminderUpdates(editRequest: EditRequest, originalEvent: CalendarEvent, timezone: string, reminderTime?: string | null): UpdateEventData {
  const updates: UpdateEventData = {};
  if (editRequest.newTitle) updates.title = editRequest.newTitle;
  if (editRequest.newLocation) updates.location = editRequest.newLocation;

  const original = localSpan(originalEvent, timezone);
  const wasAllDay = isAllDayEvent(originalEvent);
  // The model sends null for what it leaves alone, and allDay is a required Boolean
  const newAllDay = typeof editRequest.newAllDay === 'boolean' ? editRequest.newAllDay : undefined;
  const allDay = newAllDay ?? (wasAllDay && !editRequest.newStartTime);
  const day = editRequest.newStartDate || original.startDate;

  if (allDay) {
    if (editRequest.newStartDate || !wasAllDay) {
      updates.startTime = startOfLocalDay(day, allDayZone(originalEvent, timezone));
    }
  } else if (wasAllDay || editRequest.newStartDate || editRequest.newStartTime) {
    const time = editRequest.newStartTime || (wasAllDay ? (isValidReminderTime(reminderTime) ? reminderTime : DEFAULT_REMINDER_TIME) : original.startTime);
    updates.startTime = wallTimeToInstant(`${day}T${time}:00`, timezone);
  }
  if (updates.startTime) updates.endTime = updates.startTime;
  if (newAllDay !== undefined || allDay !== wasAllDay) updates.allDay = allDay;
  return updates;
}
