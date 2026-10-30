// Creating a native reminder (spec §3.2): the calendar it goes on, who it is for and,
// for "an hour before the dentist", when it fires. The model's calendar pick is never
// used: for "remind Dana" it picks the calendar named Dana, which is the partner's. A
// reminder always goes on its creator's main calendar, with forUserId naming the
// partner. An anchored reminder keeps no link to its anchor (R11): moving the dentist
// doesn't move it.

import { formatInTimeZone } from 'date-fns-tz';
import { getCalendarAssignmentsForUser } from '../calendar-provider';
import type { CreateEventInput } from '../calendar-provider/types';
import type { ParsedEvent, VoiceIntentResult, ZmanChoice, ZmanPause } from '../event-parser';
import { encodeCalendarId, getMainNativeCalendar, normalizeReminderTimes } from '../native-calendar/event-store';
import { prisma } from '../../utils/prisma';
import { findMatchingEvent } from '../voice/event-resolution';
import type { ReminderPromptContext } from '../voice/gemini-voice';
import type { CalendarEvent, UserConfig } from '../../types';
import { addDaysToDate, localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { wallTimeToInstant } from '../../utils/wall-time';
import { isAllDayEvent, isReminderEvent } from '../../utils/event-formatter';
import { resolveUserTimezone } from '../../lib/timezone';
import { sameZmanSpec, type ZmanOpinion, type ZmanSpecValue } from '../../lib/calendar-view/zman-spec';
import { communityOfUser, readZmanFromModel, zmanKeyOpinion, zmanNameOfKey, type ModelZman, type ZmanRefusal } from '../zmanim/spec';
import { zmanimSet, type ZmanKey } from '../zmanim/sets';
import { candleLightingDaysFor, zmanClockFor, type ZmanClock, type ZmanUser } from '../zmanim/reminder-clock';
import { buildRecurrenceRule } from '../calendar';
import { occurrenceDays } from '../native-calendar/recurrence';
import { isPaused } from '../zmanim/pause';
import { ARMED_GRACE_MS, dueAtForOccurrence, zmanDueForOccurrence, type ZmanRule } from './due';
import { getActivePartnerSummary } from './ownership';
import type { PartnerSummary } from './ownership';

/**
 * Why a reminder can't be created as asked. The anchor's: its event is not found, is ambiguous, or is all day with an
 * offset in hours. A zman's: the writer's set has no such zman (or opinion, or the number is out of range), there is no
 * place to count it from, or (a one-off) there is no such time on its day.
 */
export type ReminderError =
  | 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time'
  | 'zman_not_offered' | 'zman_no_place' | 'zman_no_time';

/** What a refused zman reminder tells the person, besides its error (ReminderFailure). */
export interface ZmanFailureDetail {
  /** zman_no_place: the partner whose place is missing; absent, it is the person's own. */
  name?: string;
  /** zman_not_offered: the mapper's reason (an opinion or zman the set lacks, a name it does not know, a number out of range). */
  zmanRefusal?: ZmanRefusal;
  /** zman_not_offered: the rules the writer's set has for the zman named (offset 0), in its order; empty when none. */
  offered?: ZmanSpecValue[];
  /** zman_not_offered: the opinion the writer's set names each of `offered` with, in the same order (null for none). */
  offeredOpinions?: Array<ZmanOpinion | null>;
}

export type ResolvedReminder =
  | { ok: true; calendarId: string; forUserId: number | null; forBoth: boolean; startTime: Date; endTime: Date; allDay: boolean;
      notice?: 'partner_not_on_telegram' | 'time_passed' | 'no_time_set';
      /** A reminder by zman: the rule it is created with. */
      zmanSpec?: ZmanSpecValue;
      /** A reminder by zman whose opinion the person is to choose (never with zmanSpec). */
      zmanChoices?: ZmanChoice[];
      /** A one-off by zman inside its recipient's paused Shabbat or Yom Tov: it will not be sent. */
      paused?: ZmanPause }
  | ({ ok: false; error: ReminderError } & ZmanFailureDetail);

/** A reminder that can't be created as asked: the bot asks about it instead of showing a card. */
export interface ReminderFailure extends ZmanFailureDetail {
  error: ReminderError;
  description: string; // the event it was anchored to, as the user named it (a zman reminder: its title)
}

/**
 * What resolution and a card need of a reminder's creator: the place and pause fields the zman clock and the pause
 * read, and their reminder time. A UserConfig is one.
 */
export type ReminderCreator = ZmanUser & { reminderTime?: string | null };

const MINUTES_PER_DAY = 24 * 60;

/**
 * Where a parsed reminder goes, for whom and when. `forPerson: 'partner'` makes it the
 * ACTIVE partner's when they are on the built-in calendar and on Telegram; 'both', the
 * creator's and theirs. A partner who isn't on Telegram can't be pinged, so it stays the
 * creator's and the card asks about it. Unpaired, or a partner on Google: the creator's.
 */
export async function resolveReminderForCreate(
  user: UserConfig,
  event: ParsedEvent,
  timezone: string,
  now: Date = new Date()
): Promise<ResolvedReminder> {
  const partner = wantsPartner(event) ? await getActivePartnerSummary(user.id, user.pairingId ?? null) : null;
  return resolveWithPartner(user, event, timezone, now, partner);
}

/** Whether the reminder is for the partner, alone or with the creator. */
const wantsPartner = (event: ParsedEvent) => event.forPerson === 'partner' || event.forPerson === 'both';

async function resolveWithPartner(
  user: UserConfig,
  event: ParsedEvent,
  timezone: string,
  now: Date,
  partner: PartnerSummary | null
): Promise<ResolvedReminder> {
  if (isByZman(event)) return resolveByZman(user, event, timezone, now, partner);
  let { startTime, allDay } = event;
  if (event.anchor) {
    const anchored = await anchoredTime(user, event.anchor, timezone, now);
    if (!anchored.ok) return anchored;
    ({ startTime, allDay } = anchored);
  }
  const calendar = await getMainNativeCalendar(user.id);
  const target = targetFor(event, partner);
  const times = normalizeReminderTimes(startTime, allDay, timezone);
  const notice = target.notice ?? timeNotice(times.startsAt, allDay, event.recurrence, timezone, now, target.forUserId !== null && !target.forBoth ? partner?.reminderTime : user.reminderTime);
  return {
    ok: true,
    calendarId: encodeCalendarId(calendar.id),
    forUserId: target.forUserId,
    forBoth: target.forBoth,
    startTime: times.startsAt,
    endTime: times.endsAt,
    allDay,
    ...(notice ? { notice } : {}),
  };
}

/**
 * Who "remind Dana…" or "remind us…" is for: the active partner (and the creator, for both),
 * only when they can be pinged (on Telegram). Otherwise the creator alone.
 */
function targetFor(
  event: ParsedEvent,
  partner: PartnerSummary | null
): { forUserId: number | null; forBoth: boolean; notice?: 'partner_not_on_telegram' } {
  if (!wantsPartner(event) || !partner) return { forUserId: null, forBoth: false };
  if (partner.telegramId === null) return { forUserId: null, forBoth: false, notice: 'partner_not_on_telegram' };
  return { forUserId: partner.id, forBoth: event.forPerson === 'both' };
}

/**
 * Why a reminder made now won't ping, if it won't (spec §3.3). The pass still pings one
 * whose time passed less than ARMED_GRACE_MS ago (due.ts isEligible), so only an older
 * one gets a notice. A repeating one gets none, since its later occurrences ping. A
 * date-only one for today past the user's reminder time: "no time set". Any other: "time passed"; it
 * stays in the summaries until done.
 */
function timeNotice(
  startsAt: Date,
  allDay: boolean,
  recurrence: ParsedEvent['recurrence'],
  timezone: string,
  now: Date,
  reminderTime?: string | null,
  zman?: ZmanRule
): 'time_passed' | 'no_time_set' | undefined {
  // A reminder by zman is due at its zman time, not at the reminder time (the one due-time function, due.ts)
  const due = dueAtForOccurrence({ startsAt, allDay, timeZone: timezone }, timezone, reminderTime, zman);
  if (due.getTime() >= now.getTime() - ARMED_GRACE_MS || recurrence) return undefined;
  // A reminder by zman has a time: once it has passed, it is "time passed", never "no time set"
  return allDay && !zman && localDate(startsAt, timezone) === localDate(now, timezone) ? 'no_time_set' : 'time_passed';
}

/**
 * A resolved reminder with its card notice as of now. A quick fix or a reply can give a
 * reminder a time, or move it to another day, so the card works the notice out again
 * each time it is shown. A partner who can't be pinged stays noted, ahead of the time.
 */
export async function refreshReminderNotice(event: ParsedEvent, timezone: string, now: Date, creator: ReminderCreator): Promise<ParsedEvent> {
  if (event.zmanSpec || event.zmanChoices?.length) return refreshZmanNotice(event, timezone, now, creator);
  // The pinged person's time: a reminder for the partner pings at the partner's, one for both
  // at the creator's (the creator is pinged too).
  const reminderTime = event.forUserId != null && !event.forBoth
    ? (await prisma.user.findUnique({ where: { id: event.forUserId }, select: { reminderTime: true } }))?.reminderTime
    : creator.reminderTime;
  const notice = event.reminderNotice === 'partner_not_on_telegram'
    ? event.reminderNotice
    : timeNotice(event.startTime, event.allDay, event.recurrence, timezone, now, reminderTime);
  return { ...event, reminderNotice: notice };
}

// ---- Reminders by zman (zman reminders by voice and text plan, Task 5) ----

/** Whether a reminder is set by zman: the model's words not yet mapped, or the rule or the choices already resolved. */
export const isByZman = (event: ParsedEvent) => event.zman !== undefined || !!event.zmanSpec || !!event.zmanChoices?.length;

/** Whose zman time a reminder's card shows: that person, their zone and their clock (null where no place can be had). */
export interface ZmanTiming {
  person: ReminderCreator;
  zone: string;
  clock: ZmanClock | null;
}

/** The fields of a recipient the zman timing reads (ReminderCreator's, from the database). */
const RECIPIENT_SELECT = {
  id: true, reminderTime: true, location: true, latitude: true, longitude: true, elevationM: true, zmanimCommunity: true, pauseOnShabbat: true,
} as const;

/**
 * A person's zman timing. The creator's zone is the one the reminder is resolved in; another person's is their own,
 * found as the reminder pass finds it, so the card's time is the one the pass pings at.
 */
async function timingOf(person: ReminderCreator, creatorZone: string | null): Promise<ZmanTiming> {
  const zone = creatorZone ?? (await resolveUserTimezone({ id: person.id, location: person.location ?? '' }));
  return { person, zone, clock: await zmanClockFor(person, zone) };
}

/**
 * Whose place a reminder by zman is timed at on its card and in its notice: the partner's for a reminder for the
 * partner alone (their own place, zone and pause), else the creator's (a reminder for both shows the creator's, each
 * being pinged at their own place). `partner` is used when it is that partner; otherwise they are read by id.
 */
export async function zmanTimingFor(
  creator: ReminderCreator,
  event: Pick<ParsedEvent, 'forUserId' | 'forBoth'>,
  timezone: string,
  partner?: PartnerSummary | null
): Promise<ZmanTiming> {
  if (event.forUserId == null || event.forBoth) return timingOf(creator, timezone);
  const recipient = await recipientOf(event.forUserId, partner);
  if (!recipient) {
    console.warn(`[zman-voice] reminder for user ${event.forUserId} (creator ${creator.id}): no such user, timed at the creator's place`);
    return timingOf(creator, timezone);
  }
  return timingOf(recipient, null);
}

/** The person a reminder is for besides its creator: `partner` when it is them, else read by id (null where there is no such user). */
async function recipientOf(forUserId: number, partner?: PartnerSummary | null): Promise<ReminderCreator | null> {
  return partner?.id === forUserId ? partner : await prisma.user.findUnique({ where: { id: forUserId }, select: RECIPIENT_SELECT });
}

/**
 * The partner's own timing for a reminder to both (their place, zone and pause), the creator's being zmanTimingFor's;
 * null for any other reminder. Each is pinged at their own place, so each has their own pause to ask.
 */
async function partnerTimingFor(
  creator: ReminderCreator,
  event: Pick<ParsedEvent, 'forUserId' | 'forBoth'>,
  partner?: PartnerSummary | null
): Promise<ZmanTiming | null> {
  if (event.forUserId == null || !event.forBoth) return null;
  const recipient = await recipientOf(event.forUserId, partner);
  if (!recipient) {
    console.warn(`[zman-voice] reminder for both, with user ${event.forUserId} (creator ${creator.id}): no such user, their pause is not asked`);
    return null;
  }
  return timingOf(recipient, null);
}

/**
 * A rule's time on a civil day (yyyy-MM-dd in the creator's zone, the day the reminder is stored on) for a timing, or
 * null where there is none (no place, or the sun does not make that zman that day). Through the one due-time code
 * (due.ts), as the pass, the home and the digests read it.
 */
export function zmanTimeOn(day: string, spec: ZmanSpecValue, timing: ZmanTiming, timezone: string): Date | null {
  return zmanDueForOccurrence({ startsAt: startOfLocalDay(day, timezone), allDay: true, timeZone: timezone }, { spec, clock: timing.clock }) ?? null;
}

/** How far ahead the days a reminder can start on are looked for: past any gap between two eves, or two occurrences of a rule that skips weeks. */
const START_SPAN_DAYS = 400;
/** The days after the first one a repeat is tried on for a time still ahead (a rule whose time does not exist on some days). */
const START_TRIES = 10;
/** The days from today a candle lighting is looked for (an eve is never more than a week away). */
const EVE_SPAN_DAYS = 15;

/**
 * The days a reminder by zman can start on, in order, from `from` (a civil day in the creator's zone): the days its
 * repeat has an occurrence on (the store's own rrule expansion), else the days that have the zman (candle lighting:
 * the eves, from the rest-day blocks the sun sheet's candle row reads too), else every day. Never a day the series would
 * not fire on, so the card and the reply name the first time that will ping.
 */
async function startDays(spec: ZmanSpecValue, timing: ZmanTiming, event: ParsedEvent, timezone: string, from: string): Promise<string[]> {
  if (event.recurrence && event.recurrence.calendar !== 'hebrew') {
    const [rule] = buildRecurrenceRule(event.recurrence);
    const days = rule ? occurrenceDays(rule, from, timezone, START_SPAN_DAYS, START_TRIES) : [];
    if (days.length > 0) return days;
    console.warn(`[zman-voice] the repeat ${JSON.stringify(event.recurrence)} has no occurrence from ${from}; started on that day`);
  } else if (!event.recurrence && 'zman' in spec && spec.zman === 'CANDLE_LIGHTING') {
    const days = await candleLightingDaysFor(timing.person, timing.zone, from, EVE_SPAN_DAYS);
    if (days.length > 0) return days;
    console.warn(`[zman-voice] user ${timing.person.id}: no candle lighting day from ${from}; started on that day`);
  }
  return [from, nextDate(from)];
}

/**
 * The day a rule is created on, and its time that day. A said day is kept (a repeat starts on its first occurrence
 * from it). Otherwise the next time that has not passed: the first day the reminder can start on whose time is still
 * ahead (today or tomorrow; for a repeat its first occurrence, for candle lighting the next eve). With no such time
 * (the sun does not make it), the first day with no time.
 */
async function pickZmanDay(spec: ZmanSpecValue, timing: ZmanTiming, event: ParsedEvent, timezone: string, now: Date): Promise<{ day: string; at: Date | null }> {
  if (event.zmanDaySaid) {
    const said = localDate(event.startTime, timezone);
    // A said day that a repeat does not fire on starts the series on its first occurrence after it
    const day = event.recurrence ? ((await startDays(spec, timing, event, timezone, said))[0] ?? said) : said;
    return { day, at: zmanTimeOn(day, spec, timing, timezone) };
  }
  const today = localDate(now, timezone);
  const days = await startDays(spec, timing, event, timezone, today);
  for (const day of days) {
    const at = zmanTimeOn(day, spec, timing, timezone);
    if (at && at.getTime() > now.getTime()) return { day, at };
  }
  return { day: days[0] ?? today, at: null };
}

/**
 * The rules a writer's set has for a model zman's name (offset 0), for the refusal to name, with the opinion the set
 * names each by. Empty for hours or a name it lacks.
 */
function offeredFor(modelZman: ModelZman | undefined, community: ReturnType<typeof communityOfUser>): { offered: ZmanSpecValue[]; offeredOpinions: Array<ZmanOpinion | null> } {
  if (!modelZman || !('name' in modelZman)) return { offered: [], offeredOpinions: [] };
  const all = readZmanFromModel({ name: modelZman.name, opinion: null, offsetMinutes: 0 }, community);
  const offered = all.kind === 'spec' ? [all.spec] : all.kind === 'choose' ? all.specs : [];
  const set = zmanimSet(community);
  return {
    offered,
    offeredOpinions: offered.map((spec) => ('zman' in spec ? (set.zmanim[spec.zman as ZmanKey]?.opinion ?? zmanKeyOpinion(spec.zman)) : null)),
  };
}

/** A one-off's time inside its recipient's paused Shabbat or Yom Tov: read through the pause's own function, never logged as a skip. */
async function pausedAt(timing: ZmanTiming, at: Date | null, recurrence: ParsedEvent['recurrence']): Promise<boolean> {
  return !recurrence && at !== null && (await isPaused(timing.person, at));
}

/**
 * What the pause says of a one-off on `day` for everyone it pings, each asked at their own time and place: the rule's
 * time at the creator's (or, for a reminder to the partner alone, the partner's) and, for a reminder to both, also at
 * the partner's. `true` when every one of them is paused, 'one' when only one of two is, nothing when none is.
 */
async function pauseOf(
  day: string,
  spec: ZmanSpecValue,
  timing: ZmanTiming,
  partnerTiming: ZmanTiming | null,
  timezone: string,
  recurrence: ParsedEvent['recurrence']
): Promise<ZmanPause | undefined> {
  const mine = await pausedAt(timing, zmanTimeOn(day, spec, timing, timezone), recurrence);
  if (!partnerTiming) return mine ? true : undefined;
  const theirs = await pausedAt(partnerTiming, zmanTimeOn(day, spec, partnerTiming, timezone), recurrence);
  return mine && theirs ? true : mine || theirs ? 'one' : undefined;
}

/**
 * A reminder by zman, resolved: the rule under the WRITER's community (readZmanFromModel; a rule or choices already
 * resolved are kept), the recipient's clock (the partner's own place for a reminder for them alone), the day per rule
 * or per choice, the notice counted at the rule's time, and the pause note. Refused, with a reason the person is told:
 * a zman the set does not offer, no place to count from (theirs, or for both, the partner's), or a one-off with no
 * such time on its day. A repeating one with no time some day is created: the pass skips those days, logged.
 */
async function resolveByZman(
  user: UserConfig,
  event: ParsedEvent,
  timezone: string,
  now: Date,
  partner: PartnerSummary | null
): Promise<ResolvedReminder> {
  const community = communityOfUser(user);
  let specs: ZmanSpecValue[];
  let choose: boolean;
  if (event.zman !== undefined) {
    const mapped = readZmanFromModel(event.zman, community);
    if (mapped.kind === 'refuse') {
      console.warn(`[zman-voice] user ${user.id} (${community}): ${JSON.stringify(event.zman)} refused, ${mapped.reason}`);
      return { ok: false, error: 'zman_not_offered', zmanRefusal: mapped.reason, ...offeredFor(event.zman, community) };
    }
    specs = mapped.kind === 'spec' ? [mapped.spec] : mapped.specs;
    choose = mapped.kind === 'choose';
  } else if (event.zmanSpec) {
    specs = [event.zmanSpec];
    choose = false;
  } else {
    specs = (event.zmanChoices ?? []).map((c) => c.spec);
    choose = true;
  }

  const calendar = await getMainNativeCalendar(user.id);
  const target = targetFor(event, partner);
  const forPartnerAlone = target.forUserId !== null && !target.forBoth;
  const timing = await zmanTimingFor(user, target, timezone, partner);
  if (!timing.clock) {
    console.warn(`[zman-voice] user ${user.id}: no place to count ${JSON.stringify(specs)} from for user ${timing.person.id}; refused`);
    return { ok: false, error: 'zman_no_place', ...(forPartnerAlone && partner ? { name: partner.name } : {}) };
  }
  // Each is pinged at their own place: one with none would never be, and each has their own pause
  const partnerTiming = target.forBoth && partner ? await timingOf(partner, null) : null;
  if (partnerTiming && !partnerTiming.clock) {
    console.warn(`[zman-voice] user ${user.id}: no place to count ${JSON.stringify(specs)} from for partner ${partnerTiming.person.id}; refused`);
    return { ok: false, error: 'zman_no_place', name: partner!.name };
  }

  const picks = await Promise.all(specs.map(async (spec) => ({ spec, ...(await pickZmanDay(spec, timing, event, timezone, now)) })));
  // A one-off is created only on a day with its time; a choice with none that day is not offered
  const usable = event.recurrence ? picks : picks.filter((p) => p.at !== null);
  if (usable.length === 0) {
    console.warn(`[zman-voice] user ${user.id}: ${JSON.stringify(picks.map((p) => [p.spec, p.day]))} has no time for user ${timing.person.id}; refused`);
    return { ok: false, error: 'zman_no_time' };
  }

  const reminderTime = timing.person.reminderTime;
  const noticeOf = (p: { spec: ZmanSpecValue; day: string }) =>
    timeNotice(startOfLocalDay(p.day, timezone), true, event.recurrence, timezone, now, reminderTime, { spec: p.spec, clock: timing.clock });
  const first = usable.reduce((a, b) => (b.day < a.day ? b : a));
  const startTime = startOfLocalDay(first.day, timezone);
  const common = {
    ok: true as const,
    calendarId: encodeCalendarId(calendar.id),
    forUserId: target.forUserId,
    forBoth: target.forBoth,
    startTime,
    endTime: new Date(startTime.getTime()),
    allDay: true,
  };

  if (!choose) {
    const [only] = usable;
    const notice = target.notice ?? noticeOf(only);
    const paused = await pauseOf(only.day, only.spec, timing, partnerTiming, timezone, event.recurrence);
    console.log(`[zman-voice] user ${user.id}: ${JSON.stringify(only.spec)} on ${only.day} for user ${timing.person.id} (${timing.clock.source})${paused ? `, paused (${paused})` : ''}`);
    return { ...common, zmanSpec: only.spec, ...(notice ? { notice } : {}), ...(paused ? { paused } : {}) };
  }

  const choices: ZmanChoice[] = [];
  for (const p of usable) {
    const paused = await pauseOf(p.day, p.spec, timing, partnerTiming, timezone, event.recurrence);
    choices.push({ spec: p.spec, day: p.day, ...(paused ? { paused } : {}) });
  }
  const passed = usable.every((p) => noticeOf(p) === 'time_passed');
  const notice = target.notice ?? (passed ? 'time_passed' : undefined);
  console.log(`[zman-voice] user ${user.id}: ${choices.length} opinions to choose from, ${JSON.stringify(choices)}, for user ${timing.person.id} (${timing.clock.source})`);
  return { ...common, zmanChoices: choices, ...(notice ? { notice } : {}) };
}

/**
 * refreshReminderNotice for a reminder by zman: the notice at the rule's time at the recipient's place (each choice's,
 * all of them passed for "time passed"), and the pause note again, for the rule or for each choice.
 */
async function refreshZmanNotice(event: ParsedEvent, timezone: string, now: Date, creator: ReminderCreator): Promise<ParsedEvent> {
  const timing = await zmanTimingFor(creator, event, timezone);
  const partnerTiming = await partnerTimingFor(creator, event);
  const keep = event.reminderNotice === 'partner_not_on_telegram' ? event.reminderNotice : undefined;
  const reminderTime = timing.person.reminderTime;
  const noticeOn = (day: string, spec: ZmanSpecValue) =>
    timeNotice(startOfLocalDay(day, timezone), true, event.recurrence, timezone, now, reminderTime, { spec, clock: timing.clock });
  if (event.zmanSpec) {
    const day = localDate(event.startTime, timezone);
    const paused = await pauseOf(day, event.zmanSpec, timing, partnerTiming, timezone, event.recurrence);
    return { ...event, reminderNotice: keep ?? noticeOn(day, event.zmanSpec), reminderPaused: paused };
  }
  const choices: ZmanChoice[] = [];
  for (const c of event.zmanChoices ?? []) {
    const paused = await pauseOf(c.day, c.spec, timing, partnerTiming, timezone, event.recurrence);
    choices.push({ spec: c.spec, day: c.day, ...(paused ? { paused } : {}) });
  }
  const passed = choices.length > 0 && choices.every((c) => noticeOn(c.day, c.spec) === 'time_passed');
  return { ...event, zmanChoices: choices, reminderNotice: keep ?? (passed ? 'time_passed' : undefined) };
}

/**
 * The pending reminder with choice `index` chosen (a tap on its button): that rule on that choice's day, its pause
 * note, and no choices left. Null for an index it does not have. Its notice is the card's to work out again
 * (refreshReminderNotice), as for any change.
 */
export function withZmanChoice(event: ParsedEvent, index: number, timezone: string): ParsedEvent | null {
  const choice = event.zmanChoices?.[index];
  if (!choice) return null;
  const start = startOfLocalDay(choice.day, timezone);
  return {
    ...event,
    zmanSpec: choice.spec,
    zmanChoices: undefined,
    startTime: start,
    endTime: new Date(start.getTime()),
    allDay: true,
    reminderPaused: choice.paused,
  };
}

/** The fields of a reminder that say it is by zman: what an edit carries over or clears. */
export type ZmanFields = Pick<ParsedEvent, 'zmanSpec' | 'zmanChoices' | 'zmanDaySaid' | 'reminderPaused'>;

/**
 * What an edit of a pending reminder (a reply to its card, a Time or Day quick fix) does to its zman rule, given the
 * reminder before and the one with the edit's times (`after`: startTime, endTime, allDay):
 *  - a clock time given (`after` is not date-only) makes it a fixed time: the rule, the choices and the pause note go;
 *  - a day change keeps the rule and says the day was said (`zmanDaySaid`), and moves every choice to the new day;
 *  - anything else carries the rule and the choices over as they were.
 * Spread the result over the edited event. A reminder that is not by zman gets nothing (empty), so a plain one is
 * edited as before.
 */
export function zmanAfterEdit(before: ParsedEvent, after: Pick<ParsedEvent, 'startTime' | 'allDay'>, timezone: string): Partial<ZmanFields> {
  if (before.kind !== 'reminder' || !(before.zmanSpec || before.zmanChoices?.length)) return {};
  if (!after.allDay) {
    console.log(`[zman-voice] a clock time was given to a reminder by zman; it is a fixed time now, the rule is dropped`);
    return { zmanSpec: undefined, zmanChoices: undefined, zmanDaySaid: undefined, reminderPaused: undefined };
  }
  const day = localDate(after.startTime, timezone);
  const moved = day !== localDate(before.startTime, timezone);
  return {
    zmanSpec: before.zmanSpec,
    zmanChoices: moved ? before.zmanChoices?.map((c) => ({ spec: c.spec, day })) : before.zmanChoices,
    zmanDaySaid: moved ? true : before.zmanDaySaid,
    // The pause note is worked out again for the day it now has (refreshReminderNotice)
    reminderPaused: moved ? undefined : before.reminderPaused,
  };
}

/**
 * A reminder whose opinion is to be chosen, with the opinion a reply named: the one choice that opinion is, as if it
 * had been tapped (withZmanChoice), or null when the reply names none the choices have (the card stays as it was).
 * The opinion goes through readZmanFromModel under the writer's community, as everything the model says.
 */
export function zmanChoiceByOpinion(event: ParsedEvent, said: unknown, community: ReturnType<typeof communityOfUser>, timezone: string): ParsedEvent | null {
  const choices = event.zmanChoices;
  const first = choices?.[0]?.spec;
  if (!choices || !first || !('zman' in first)) return null;
  const mapped = readZmanFromModel({ name: zmanNameOfKey(first.zman), opinion: said, offsetMinutes: first.offsetMin }, community);
  if (mapped.kind !== 'spec') {
    console.warn(`[zman-voice] a reply named the opinion ${JSON.stringify(said)}, which is none of the choices (${mapped.kind}); the choices stay`);
    return null;
  }
  const index = choices.findIndex((c) => sameZmanSpec(c.spec, mapped.spec));
  return index < 0 ? null : withZmanChoice(event, index, timezone);
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
      return { ok: true, startTime: wallTimeToInstant(`${day}T${wall.slice(11)}`, timezone), allDay: false };
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
  const needsPartner = asked.some(i => isReminder(i) && wantsPartner(i.event!));
  const partner = needsPartner ? await getActivePartnerSummary(user.id, user.pairingId ?? null) : null;

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
      const { ok: _ok, error, ...detail } = result;
      failures.push({ error, description: event.anchor?.description || event.title, ...detail });
      resolved.push({ intent: 'create', confidence: intent.confidence, error });
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
        forBoth: result.forBoth,
        forName: named && partner ? partner.name : undefined,
        reminderNotice: result.notice,
        // A reminder by zman: the model's words are now the rule, or the choices the card offers
        ...(isByZman(event)
          ? { zman: undefined, zmanSpec: result.zmanSpec, zmanChoices: result.zmanChoices, reminderPaused: result.paused }
          : {}),
      },
    });
  }
  return { intents: resolved, failures };
}

/**
 * The intent a message's single-card flow answers: the first that isn't a reminder
 * resolution couldn't place (those are asked about after the card), so an edit or a
 * delete still counts. Falls back to the first intent; undefined only when there are none.
 */
export function primaryIntent(resolved: { intents: VoiceIntentResult[]; failures: ReminderFailure[] }): VoiceIntentResult | undefined {
  const unplaced = (i: VoiceIntentResult) =>
    i.intent === 'create' && !i.event && !!i.error && resolved.failures.some(x => x.error === i.error);
  return resolved.intents.find(i => !unplaced(i)) ?? resolved.intents[0];
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
export function reminderCreateFields(event: ParsedEvent): Partial<Pick<CreateEventInput, 'kind' | 'forUserId' | 'forBoth' | 'endTime' | 'zmanSpec'>> {
  if (event.kind !== 'reminder') return {};
  // Choices not yet chosen: creating it would make a plain date-only reminder at the reminder time. Never silently.
  if (event.allDay && !event.zmanSpec && event.zmanChoices?.length) {
    console.error(`[zman-voice] a reminder with ${event.zmanChoices.length} unchosen zman opinions reached a create; refused`);
    throw new Error('A reminder by zman whose opinion is not chosen cannot be created');
  }
  return {
    kind: 'reminder',
    forUserId: event.forUserId ?? null,
    forBoth: event.forBoth === true,
    endTime: event.startTime,
    // The rule, on a date-only reminder only: a clock time given since (a quick fix, a correction) makes it a fixed time
    ...(event.zmanSpec && event.allDay ? { zmanSpec: event.zmanSpec } : {}),
  };
}

/** The `by_zman` flag of a created reminder's analytics (native_reminder_created): set when it is created with a rule. */
export function zmanAnalytics(event: ParsedEvent): { by_zman?: true } {
  return event.kind === 'reminder' && event.zmanSpec && event.allDay ? { by_zman: true } : {};
}
