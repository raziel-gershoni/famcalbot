// Creating a native reminder (spec §3.2): the calendar it goes on, who it is for and,
// for "an hour before the dentist", when it fires. The model's calendar pick is never
// used: for "remind Dana" it picks the calendar named Dana, which is the partner's. A
// reminder always goes on its creator's main calendar, with forUserId naming the
// partner. An anchored reminder keeps no link to its anchor (R11): moving the dentist
// doesn't move it.

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getCalendarAssignmentsForUser } from '../calendar-provider';
import type { CreateEventInput } from '../calendar-provider/types';
import type { ParsedEvent, VoiceIntentResult } from '../event-parser';
import { encodeCalendarId, getMainNativeCalendar, normalizeReminderTimes } from '../native-calendar/event-store';
import { findMatchingEvent } from '../voice/event-resolution';
import type { ReminderPromptContext } from '../voice/gemini-voice';
import type { CalendarEvent, UserConfig } from '../../types';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { isAllDayEvent, isReminderEvent } from '../../utils/event-formatter';
import { ARMED_GRACE_MS, dueAtForOccurrence } from './due';
import { getActivePartnerSummary } from './ownership';
import type { PartnerSummary } from './ownership';

export type ResolvedReminder =
  | { ok: true; calendarId: string; forUserId: number | null; startTime: Date; endTime: Date; allDay: boolean;
      notice?: 'partner_not_on_telegram' | 'time_passed' | 'no_time_set' }
  | { ok: false; error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time' };

type ReminderError = Extract<ResolvedReminder, { ok: false }>['error'];

/** A reminder that can't be created as asked: the bot asks for a time instead of showing a card. */
export interface ReminderFailure {
  error: ReminderError;
  description: string; // the event it was anchored to, as the user named it
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Where a parsed reminder goes, for whom and when. `forPerson: 'partner'` makes it the
 * ACTIVE partner's when they are on the built-in calendar and on Telegram. A partner
 * who isn't on Telegram can't be pinged, so it stays the creator's and the card asks
 * about it. Unpaired, or a partner on Google: the creator's.
 */
export async function resolveReminderForCreate(
  user: UserConfig,
  event: ParsedEvent,
  timezone: string,
  now: Date = new Date()
): Promise<ResolvedReminder> {
  const partner = event.forPerson === 'partner' ? await getActivePartnerSummary(user.id, user.pairingId ?? null) : null;
  return resolveWithPartner(user, event, timezone, now, partner);
}

async function resolveWithPartner(
  user: UserConfig,
  event: ParsedEvent,
  timezone: string,
  now: Date,
  partner: PartnerSummary | null
): Promise<ResolvedReminder> {
  let { startTime, allDay } = event;
  if (event.anchor) {
    const anchored = await anchoredTime(user, event.anchor, timezone, now);
    if (!anchored.ok) return anchored;
    ({ startTime, allDay } = anchored);
  }
  const calendar = await getMainNativeCalendar(user.id);
  const target = targetFor(event, partner);
  const times = normalizeReminderTimes(startTime, allDay, timezone);
  const notice = target.notice ?? timeNotice(times.startsAt, allDay, event.recurrence, timezone, now);
  return {
    ok: true,
    calendarId: encodeCalendarId(calendar.id),
    forUserId: target.forUserId,
    startTime: times.startsAt,
    endTime: times.endsAt,
    allDay,
    ...(notice ? { notice } : {}),
  };
}

/** Who "remind Dana…" is for: the partner only when they are on the built-in calendar and can be pinged. */
function targetFor(
  event: ParsedEvent,
  partner: PartnerSummary | null
): { forUserId: number | null; notice?: 'partner_not_on_telegram' } {
  if (event.forPerson !== 'partner' || !partner || partner.calendarSource !== 'NATIVE') return { forUserId: null };
  if (partner.telegramId === null) return { forUserId: null, notice: 'partner_not_on_telegram' };
  return { forUserId: partner.id };
}

/**
 * Why a reminder made now won't ping, if it won't (spec §3.3). The pass still pings one
 * whose time passed less than ARMED_GRACE_MS ago (due.ts isEligible), so only an older
 * one gets a notice. A date-only reminder for today past its 09:00: "no time set". Any
 * other one-off: "time passed"; it stays in the summaries until done. A repeating one
 * gets none, since its later occurrences ping.
 */
function timeNotice(
  startsAt: Date,
  allDay: boolean,
  recurrence: ParsedEvent['recurrence'],
  timezone: string,
  now: Date
): 'time_passed' | 'no_time_set' | undefined {
  const due = dueAtForOccurrence({ startsAt, allDay, timeZone: timezone }, timezone);
  if (due.getTime() >= now.getTime() - ARMED_GRACE_MS) return undefined;
  if (allDay && localDate(startsAt, timezone) === localDate(now, timezone)) return 'no_time_set';
  return recurrence ? undefined : 'time_passed';
}

/**
 * A resolved reminder with its card notice as of now. A quick fix or a reply can give a
 * reminder a time, or move it to another day, so the card works the notice out again
 * each time it is shown. A partner who can't be pinged stays noted, ahead of the time.
 */
export function refreshReminderNotice(event: ParsedEvent, timezone: string, now: Date = new Date()): ParsedEvent {
  const notice = event.reminderNotice === 'partner_not_on_telegram'
    ? event.reminderNotice
    : timeNotice(event.startTime, event.allDay, event.recurrence, timezone, now);
  return { ...event, reminderNotice: notice };
}

/**
 * The events a reminder's anchor can name: not reminders, not started yet, and a
 * repeating one only at its next occurrence, so "before piano" doesn't match every
 * lesson of the series.
 */
export function anchorCandidates(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[] {
  const today = localDate(now, timezone);
  const startOf = (e: CalendarEvent) => (isAllDayEvent(e) ? startOfLocalDay(e.start, timezone) : new Date(e.start)).getTime();
  const upcoming = events
    .filter(e => !isReminderEvent(e) && (isAllDayEvent(e) ? e.start >= today : new Date(e.start) >= now))
    .sort((a, b) => startOf(a) - startOf(b));
  const seen = new Set<string>();
  return upcoming.filter(e => {
    if (!e.recurringEventId) return true;
    if (seen.has(e.recurringEventId)) return false;
    seen.add(e.recurringEventId);
    return true;
  });
}

/**
 * When a reminder set relative to `anchorEvent` fires: its start plus the offset. An
 * all-day event has no hour to count from, so an offset in hours needs a time from the
 * user, and one in whole days gives a date-only reminder on that day.
 */
export function reminderTimeFromAnchor(
  anchorEvent: CalendarEvent,
  offsetMinutes: number,
  timezone: string
): { ok: true; startTime: Date; allDay: boolean } | { ok: false; error: 'anchor_needs_time' } {
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  if (!isAllDayEvent(anchorEvent)) {
    if (offset !== 0 && offset % MINUTES_PER_DAY === 0) {
      // Whole days move on the calendar at the same wall-clock time, so a DST change
      // in between doesn't land the reminder an hour off
      const wall = formatInTimeZone(new Date(anchorEvent.start), timezone, "yyyy-MM-dd'T'HH:mm:ss");
      const day = addDaysToDate(wall.slice(0, 10), offset / MINUTES_PER_DAY);
      return { ok: true, startTime: fromZonedTime(`${day}T${wall.slice(11)}`, timezone), allDay: false };
    }
    return { ok: true, startTime: new Date(new Date(anchorEvent.start).getTime() + offset * 60_000), allDay: false };
  }
  if (offset % MINUTES_PER_DAY !== 0) return { ok: false, error: 'anchor_needs_time' };
  const day = addDaysToDate(anchorEvent.start, offset / MINUTES_PER_DAY);
  return { ok: true, startTime: startOfLocalDay(day, timezone), allDay: true };
}

/** The time of an anchored reminder: the one upcoming event its anchor names, plus the offset. */
async function anchoredTime(
  user: UserConfig,
  anchor: NonNullable<ParsedEvent['anchor']>,
  timezone: string,
  now: Date
): Promise<{ ok: true; startTime: Date; allDay: boolean } | { ok: false; error: ReminderError }> {
  const calendars = await getCalendarAssignmentsForUser(user);
  const match = await findMatchingEvent(
    user,
    calendars.map(c => c.calendarId),
    { type: 'by_description', description: anchor.description },
    user.language || 'en',
    now,
    { eligible: events => anchorCandidates(events, now, timezone) }
  );
  if ('error' in match) return { ok: false, error: match.error === 'multiple_matches' ? 'anchor_ambiguous' : 'anchor_not_found' };
  return reminderTimeFromAnchor(match.event, anchor.offsetMinutes, timezone);
}

/**
 * A message's intents with each reminder resolved in place: the calendar, target and
 * time it will be created with, kept on the event so the card shows them and its
 * confirm creates exactly that. A reminder that can't be placed leaves the creates
 * (no card for it) and comes back as a failure to ask about. Other intents pass
 * through untouched. `selfOnly` is for forwarded text, where "me" is whoever
 * forwarded it, so every reminder is theirs (spec §3.1).
 */
export async function resolveReminderIntents(
  user: UserConfig,
  intents: VoiceIntentResult[],
  timezone: string,
  options: { selfOnly?: boolean; now?: Date } = {}
): Promise<{ intents: VoiceIntentResult[]; failures: ReminderFailure[] }> {
  const now = options.now ?? new Date();
  const isReminder = (i: VoiceIntentResult) => i.intent === 'create' && i.event?.kind === 'reminder';
  const asked = options.selfOnly
    ? intents.map(i => (isReminder(i) ? { ...i, event: { ...i.event!, forPerson: 'self' as const } } : i))
    : intents;
  const wantsPartner = asked.some(i => isReminder(i) && i.event!.forPerson === 'partner');
  const partner = wantsPartner ? await getActivePartnerSummary(user.id, user.pairingId ?? null) : null;

  const failures: ReminderFailure[] = [];
  const resolved: VoiceIntentResult[] = [];
  for (const intent of asked) {
    if (!isReminder(intent)) {
      resolved.push(intent);
      continue;
    }
    const event = intent.event!;
    const result = await resolveWithPartner(user, event, timezone, now, partner);
    if (!result.ok) {
      failures.push({ error: result.error, description: event.anchor?.description || event.title });
      resolved.push({ intent: 'create', confidence: intent.confidence, error: result.error });
      continue;
    }
    const named = result.forUserId !== null || result.notice === 'partner_not_on_telegram';
    resolved.push({
      ...intent,
      event: {
        ...event,
        calendarId: result.calendarId,
        calendarName: undefined,
        startTime: result.startTime,
        endTime: result.endTime,
        allDay: result.allDay,
        anchor: undefined,
        forUserId: result.forUserId,
        forName: named && partner ? partner.name : undefined,
        reminderNotice: result.notice,
      },
    });
  }
  return { intents: resolved, failures };
}

/**
 * The names the extraction prompt's reminder rules use to tell "remind me" from "remind
 * Dana": the user's and the ACTIVE partner's. `withPartner: false` leaves the partner
 * out, for forwarded text.
 */
export async function reminderPromptContext(
  user: UserConfig,
  options: { withPartner?: boolean } = {}
): Promise<ReminderPromptContext> {
  const partner = options.withPartner === false ? null : await getActivePartnerSummary(user.id, user.pairingId ?? null);
  return {
    userName: user.name,
    userEnglishName: user.englishName || null,
    partnerName: partner?.name ?? null,
    partnerEnglishName: partner?.englishName || null,
  };
}

/**
 * A reminder's part of a provider create, spread after the event's own fields. An
 * event gets nothing, so its input is unchanged. A reminder has one time: it ends
 * where it starts (the store enforces that too).
 */
export function reminderCreateFields(event: ParsedEvent): Partial<Pick<CreateEventInput, 'kind' | 'forUserId' | 'endTime'>> {
  if (event.kind !== 'reminder') return {};
  return { kind: 'reminder', forUserId: event.forUserId ?? null, endTime: event.startTime };
}
