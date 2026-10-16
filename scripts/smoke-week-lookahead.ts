// Smoke test for the weekly lookahead (/week, /nextweek and the lookahead block of the
// tomorrow summary): src/services/week-lookahead.ts and the prompt claude.ts builds from
// it. Its days used to be Israel's or the server's: the Google fetch asked for Israel
// time, events were grouped by the server's clock, an all-day event read as UTC midnight
// landed on the day before west of UTC, an event already running said "In -1 days" (and
// then was dropped outright, a vacation included), the week's edges were set on the
// server's clock, and the tomorrow summary's lookahead skipped the day after it. A
// week-long visit already running read "Sat 15:00 - Sat 12:00", which Saturday unsaid.
//
// The series lookup behind the daily/weekly filter kept a failed lookup forever, under a
// key every user shared: one Google hiccup hid a monthly series from /week until the
// next deploy, for everyone with that calendar.
//
// Google, the native calendar, the timezone lookup and the AI are stubbed. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-week-lookahead.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-week-lookahead.ts

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { startOfLocalDay } from '../src/utils/day-events';
import type { CalendarAssignment, CalendarEvent, ReminderInfo, UserConfig } from '../src/types';
import type { WeekLookahead } from '../src/services/week-lookahead';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertList(got: string[], want: string[]) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';

// A Google event as the fixture holds it: ISO instants for timed, dates for all-day
// (end exclusive, as Google sends them).
type Fixture = { summary: string; start: string; end: string; recurringEventId?: string };

const ISRAEL_EVENTS: Fixture[] = [
  { summary: 'Night shift', start: '2026-10-12T22:00:00+03:00', end: '2026-10-13T06:00:00+03:00' },
  { summary: 'Late swim', start: '2026-10-14T00:30:00+03:00', end: '2026-10-14T01:30:00+03:00' },
  { summary: 'Shabbat dinner', start: '2026-10-16T19:00:00+03:00', end: '2026-10-16T22:00:00+03:00' },
  { summary: 'Party', start: '2026-10-17T22:00:00+03:00', end: '2026-10-18T02:00:00+03:00' },
  { summary: 'Early flight', start: '2026-10-18T01:00:00+03:00', end: '2026-10-18T03:00:00+03:00' },
  { summary: 'Motzei Shabbat', start: '2026-10-24T21:00:00+03:00', end: '2026-10-25T01:00:00+03:00' },
  { summary: 'After midnight', start: '2026-10-25T00:30:00+03:00', end: '2026-10-25T01:30:00+03:00' },
];

const NEW_YORK_EVENTS: Fixture[] = [
  { summary: 'Conference', start: '2026-10-12T09:00:00-04:00', end: '2026-10-14T17:00:00-04:00' },
  { summary: 'Vacation', start: '2026-10-12', end: '2026-10-15' },
  { summary: 'Homework club', start: '2026-10-13T22:00:00-04:00', end: '2026-10-13T23:30:00-04:00' },
  { summary: 'Gym', start: '2026-10-14T07:00:00-04:00', end: '2026-10-14T08:00:00-04:00', recurringEventId: 'gym' },
  { summary: 'Late dinner', start: '2026-10-15T21:00:00-04:00', end: '2026-10-15T23:00:00-04:00' },
  { summary: 'School trip', start: '2026-10-16', end: '2026-10-17' },
  { summary: 'Sleepover', start: '2026-10-17T22:00:00-04:00', end: '2026-10-18T02:00:00-04:00' },
  { summary: 'Movie night', start: '2026-10-18T20:00:00-04:00', end: '2026-10-18T22:00:00-04:00' },
  { summary: 'Late sleepover', start: '2026-10-18T22:00:00-04:00', end: '2026-10-19T02:00:00-04:00' },
  { summary: 'Brunch', start: '2026-10-19T10:00:00-04:00', end: '2026-10-19T11:00:00-04:00' },
  { summary: 'Book fair', start: '2026-10-23', end: '2026-10-24' },
  { summary: 'Parent meeting', start: '2026-10-25T19:00:00-04:00', end: '2026-10-25T20:00:00-04:00' },
];

// Events already running when a lookahead starts.
const RUNNING_EVENTS: Fixture[] = [
  { summary: 'Grandma visiting', start: '2026-10-10T15:00:00-04:00', end: '2026-10-17T12:00:00-04:00' },
  { summary: 'Vacation', start: '2026-10-12', end: '2026-10-16' },
  { summary: 'Thu dinner', start: '2026-10-15T19:00:00-04:00', end: '2026-10-15T21:00:00-04:00' },
  { summary: 'Sleepover', start: '2026-10-17T22:00:00-04:00', end: '2026-10-18T10:00:00-04:00' },
  { summary: 'Fall break', start: '2026-10-24', end: '2026-10-28' },
];

// Two series for the lookup-cache checks, in Israel: a monthly book club, listed once its
// rule is known, and a daily carpool on three days, never listed.
const SERIES_EVENTS: Fixture[] = [
  { summary: 'Carpool', start: '2026-10-13T16:00:00+03:00', end: '2026-10-13T16:30:00+03:00', recurringEventId: 'carpool' },
  { summary: 'Carpool', start: '2026-10-14T16:00:00+03:00', end: '2026-10-14T16:30:00+03:00', recurringEventId: 'carpool' },
  { summary: 'Carpool', start: '2026-10-15T16:00:00+03:00', end: '2026-10-15T16:30:00+03:00', recurringEventId: 'carpool' },
  { summary: 'Book club', start: '2026-10-15T19:00:00+03:00', end: '2026-10-15T21:00:00+03:00', recurringEventId: 'bookclub' },
];

const GOOGLE_EVENTS: Record<string, Fixture[]> = {
  'token-il': ISRAEL_EVENTS, 'token-ny': NEW_YORK_EVENTS, 'token-running': RUNNING_EVENTS,
  'token-series-6': SERIES_EVENTS, 'token-series-66': SERIES_EVENTS,
};
const RRULES: Record<string, string> = {
  gym: 'RRULE:FREQ=DAILY', anniv: 'FREQ=YEARLY', standup: 'FREQ=DAILY', vitamins: 'FREQ=DAILY',
  bookclub: 'RRULE:FREQ=MONTHLY', carpool: 'RRULE:FREQ=DAILY',
};

// Native events as the provider hands them over: all-day as dates in the event's own
// timezone, timed as UTC instants.
const NATIVE_EVENTS: CalendarEvent[] = [
  { summary: 'Teacher day', start: '2026-10-16', end: '2026-10-17', calendarName: 'Family', calendarId: 'native-family' },
  { summary: 'Standup', start: '2026-10-14T13:00:00.000Z', end: '2026-10-14T13:15:00.000Z', calendarName: 'Family', calendarId: 'native-family', recurringEventId: 'standup' },
  { summary: 'Anniversary', start: '2026-10-17T23:00:00.000Z', end: '2026-10-18T01:00:00.000Z', calendarName: 'Family', calendarId: 'native-family', recurringEventId: 'anniv' },
];

// Built-in calendar reminders for an Israeli native user, as the provider hands them
// over: zero length, with whose they are from the viewer's side.
const nativeReminder = (summary: string, start: string, end: string, info: ReminderInfo, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Family', calendarId: 'native-family', eventType: 'reminder', reminder: info, ...extra });
const OWN_REMINDER: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
const NATIVE_REMINDERS: CalendarEvent[] = [
  nativeReminder('Renew passport', '2026-10-14T09:00:00.000Z', '2026-10-14T09:00:00.000Z', { ...OWN_REMINDER, done: true }),
  nativeReminder('Take vitamins', '2026-10-14T05:00:00.000Z', '2026-10-14T05:00:00.000Z', OWN_REMINDER, { recurringEventId: 'vitamins' }),
  nativeReminder('Call the plumber', '2026-10-15T07:00:00.000Z', '2026-10-15T07:00:00.000Z', OWN_REMINDER),
  { summary: 'Dentist', start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T09:00:00.000Z', calendarName: 'Family', calendarId: 'native-family' },
  nativeReminder('Buy milk', '2026-10-16T14:00:00.000Z', '2026-10-16T14:00:00.000Z', { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Dana' }),
  nativeReminder('Pick up the cake', '2026-10-17', '2026-10-18', { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana' }),
];
const NATIVE_BY_USER: Record<number, CalendarEvent[]> = { 5: NATIVE_REMINDERS };

const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: NY, 4: NY, 5: IL, 6: IL, 66: IL };

/** Every events.list request, to see which timezone it asked for. */
const googleCalls: Array<{ token: string; timeMin: string; timeMax: string; timeZone?: string }> = [];
/** Every prompt sent to the AI. */
const prompts: string[] = [];
/** Every events.get request (a series' master event), as token:eventId. */
const masterCalls: string[] = [];
/** What events.get throws for a token, while set. */
const masterErrors: Record<string, Error> = {};
/** How far the cache's clock moves while events.get answers. */
let masterTookMs = 0;
/** The cache's clock: Date.now returns it during the (g) checks. */
let clock = 0;

/** A Google API error as gaxios throws it: the HTTP status on the error and on its response. */
const googleError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status, response: { status } });

/**
 * A Google client over the fixtures. Like events.list it returns what overlaps
 * [timeMin, timeMax), all-day events read in the requested timezone, and writes times
 * in that timezone.
 */
function fakeGoogleClient(token: string) {
  return {
    calendars: { get: async () => ({ data: { summary: 'Family' } }) },
    events: {
      get: async ({ eventId }: { eventId: string }) => {
        masterCalls.push(`${token}:${eventId}`);
        clock += masterTookMs;
        if (masterErrors[token]) throw masterErrors[token];
        return { data: { recurrence: [RRULES[eventId]] } };
      },
      list: async (params: { timeMin: string; timeMax: string; timeZone?: string }) => {
        googleCalls.push({ token, ...params });
        const tz = params.timeZone || 'UTC';
        const stamp = (f: string) => f.includes('T')
          ? { dateTime: formatInTimeZone(new Date(f), tz, "yyyy-MM-dd'T'HH:mm:ssXXX") }
          : { date: f };
        const items = (GOOGLE_EVENTS[token] || [])
          .filter(f => {
            const start = f.start.includes('T') ? new Date(f.start) : startOfLocalDay(f.start, tz);
            const end = f.end.includes('T') ? new Date(f.end) : startOfLocalDay(f.end, tz);
            return end > new Date(params.timeMin) && start < new Date(params.timeMax);
          })
          .map(f => ({ summary: f.summary, start: stamp(f.start), end: stamp(f.end), recurringEventId: f.recurringEventId }));
        return { data: { items } };
      },
    },
  };
}

const user = (id: number, extra: Record<string, unknown>) => ({
  id,
  name: 'Dana',
  englishName: 'Dana',
  gender: 'female',
  language: 'en',
  calendarSource: 'GOOGLE',
  includeWeeklyInLookahead: false,
  lookaheadAlways7Days: false,
  ...extra,
}) as unknown as UserConfig;

const israeli = user(1, { culture: 'jewish', googleRefreshToken: 'token-il' });
const newYorker = user(2, { culture: 'default', googleRefreshToken: 'token-ny' });
const nativeNewYorker = user(3, { culture: 'default', googleRefreshToken: '', calendarSource: 'NATIVE' });
const runningNewYorker = user(4, { culture: 'default', googleRefreshToken: 'token-running' });
const nativeIsraeli = user(5, { culture: 'default', googleRefreshToken: '', calendarSource: 'NATIVE' });
// Two Israeli Google users with the same calendar and series ids; 66 starts with 6.
const seriesUser = user(6, { culture: 'default', googleRefreshToken: 'token-series-6' });
const otherSeriesUser = user(66, { culture: 'default', googleRefreshToken: 'token-series-66' });
const calendars: CalendarAssignment[] = [{ calendarId: 'family', labels: ['primary'], name: 'Family', color: '#000' }];

/** The prompt's EVENTS BY DAY section, one line per day: header | event | event. */
function daysOf(prompt: string): string[] {
  const section = prompt.split('**EVENTS BY DAY:**\n\n')[1]?.split('\n\n**CRITICAL')[0];
  if (!section) return [];
  return section.split('\n\n').map(block => {
    const [header, ...lines] = block.split('\n');
    return [header.replace(/\*\*/g, ''), ...lines.map(l => l.trim().replace(/^- /, ''))].join(' | ');
  });
}

const rangeOf = (prompt: string) => prompt.match(/^From: (.+)$/m)?.[1];

async function main() {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see eval-voice-show.ts);
  // the stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
    _cache: Record<string, unknown>;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('services/calendar.ts', { TIMEZONE: IL, getCalendarClient: fakeGoogleClient });
  stub('services/calendar-provider/index.ts', {
    getProviderForUser: (u: { id: number }) => ({ fetchEventsInRange: async () => NATIVE_BY_USER[u.id] ?? NATIVE_EVENTS }),
    getCalendarAssignmentsForUser: async () => calendars,
  });
  stub('services/native-calendar/event-store.ts', { getNativeSeriesRrule: async (id: string) => RRULES[id] ?? null });
  stub('lib/timezone.ts', { resolveUserTimezone: async (u: { id: number }) => TIMEZONES[u.id] });
  stub('services/ai-provider.ts', {
    generateAICompletion: async (prompt: string) => {
      prompts.push(prompt);
      return { text: 'ok' };
    },
    streamAICompletion: async () => {
      throw new Error('not streamed in this test');
    },
  });

  const { getWeekLookahead, getNextWeekLookahead, formatTomorrowLookahead, clearRecurrenceCache, clearRecurrenceCacheForUser } =
    await import('../src/services/week-lookahead');
  const { generateWeekLookahead, generateNextWeekSummary } = await import('../src/services/claude');

  /** The prompt claude.ts builds for a lookahead. */
  const promptFor = async (lookahead: WeekLookahead, u: UserConfig, nextWeek = false) => {
    prompts.length = 0;
    await (nextWeek ? generateNextWeekSummary : generateWeekLookahead)(lookahead, u, 'en');
    assert(prompts.length === 1, `${prompts.length} prompts`);
    return prompts[0];
  };

  // Tuesday 22:30 in New York is already Wednesday on a UTC or an Israeli clock.
  const nyTuesdayNight = new Date('2026-10-13T22:30:00-04:00');
  // Tuesday 01:30 in Israel is still Monday on a UTC clock.
  const ilTuesdayNight = new Date('2026-10-13T01:30:00+03:00');

  googleCalls.length = 0;
  const nyWeek = await getWeekLookahead(newYorker, calendars, nyTuesdayNight);
  const nyWeekCalls = [...googleCalls];
  googleCalls.length = 0;
  const ilWeek = await getWeekLookahead(israeli, calendars, ilTuesdayNight);
  const ilWeekCalls = [...googleCalls];

  // (a)
  await check('(a) the Google fetch asks for the user\'s timezone, not Israel\'s', () => {
    assert(nyWeekCalls.length === 1 && nyWeekCalls[0].timeZone === NY, `New York asked for ${nyWeekCalls.map(c => c.timeZone)}`);
    assert(ilWeekCalls.length === 1 && ilWeekCalls[0].timeZone === IL, `Israel asked for ${ilWeekCalls.map(c => c.timeZone)}`);
  });

  // (b) and the overnight rule
  await check('(b) New York /week: each event on its New York day, an overnight one once, on the day it starts', async () => {
    assertList(daysOf(await promptFor(nyWeek, newYorker)), [
      'Tuesday, Oct 13 - Today | All day (began Mon, through Wed) - Vacation (Family) | all day (Mon 09:00 - Wed 17:00) - Conference (Family) | 22:00 - Homework club (Family)',
      'Thursday, Oct 15 - In 2 days | 21:00 - Late dinner (Family)',
      'Friday, Oct 16 - In 3 days | All day - School trip (Family)',
      'Saturday, Oct 17 - In 4 days | 22:00 - Sleepover (Family)',
      'Sunday, Oct 18 - In 5 days | 20:00 - Movie night (Family) | 22:00 - Late sleepover (Family)',
    ]);
  });

  await check('(b) Israel /week: an event after midnight is tomorrow\'s, with its Hebrew date', async () => {
    assertList(daysOf(await promptFor(ilWeek, israeli)), [
      'Wednesday, Oct 14 (3 Cheshvan) - Tomorrow | 00:30 - Late swim (Family)',
      'Friday, Oct 16 (5 Cheshvan) - In 3 days | 19:00 - Shabbat dinner (Family)',
      'Saturday, Oct 17 (6 Cheshvan) - In 4 days | 22:00 - Party (Family)',
    ]);
  });

  // (c)
  await check('(c) an all-day event stays on its date in New York (not UTC midnight, the evening before)', () => {
    const trip = nyWeek.events.find(e => e.summary === 'School trip');
    assert(!!trip, 'School trip missing');
    assert(trip.isAllDay && trip.daysFromNow === 3, `daysFromNow ${trip.daysFromNow}`);
    const weekday = trip.start.toLocaleDateString('en-US', { weekday: 'long', timeZone: NY });
    assert(weekday === 'Friday', `starts on ${weekday}`);
  });

  await check('(c) the tomorrow summary\'s lookahead lines name each event\'s New York weekday, from the day after', async () => {
    // As src/services/telegram/summary.ts calls it: from noon of the summary day, Wednesday.
    const tomorrowNoon = fromZonedTime('2026-10-14 12:00:00', NY);
    const lookahead = await getWeekLookahead(newYorker, calendars, tomorrowNoon);
    assertList(lookahead.events.map(e => `${e.daysFromNow} ${e.summary}`), [
      '0 Vacation', '0 Conference', '1 Late dinner', '2 School trip', '3 Sleepover', '4 Movie night', '4 Late sleepover',
    ]);
    // Wednesday itself is the summary's; Thursday is the lookahead's first day.
    assertList(formatTomorrowLookahead(lookahead).split('\n'), [
      'Thursday: Late dinner at 21:00 (Family)',
      'Friday: School trip (All day) (Family)',
      'Saturday: Sleepover at 22:00 (Family)',
      'Sunday: Movie night at 20:00 (Family)',
      'Sunday: Late sleepover at 22:00 (Family)',
    ]);
  });

  await check('(c) native New York user: an all-day event on its date, recurrence still read', async () => {
    const lookahead = await getWeekLookahead(nativeNewYorker, calendars, nyTuesdayNight);
    const lines = lookahead.events.map(e =>
      `${e.daysFromNow} ${e.start.toLocaleDateString('en-US', { weekday: 'long', timeZone: NY })}: ${e.summary} ${e.recurrenceType}`);
    assertList(lines, ['3 Friday: Teacher day single', '4 Saturday: Anniversary yearly']);
  });

  // (d)
  await check('(d) /week: an event that started before today is Today, never "In -1 days"', () => {
    for (const lookahead of [nyWeek, ilWeek]) {
      const early = lookahead.events.filter(e => e.daysFromNow < 0).map(e => `${e.summary} ${e.daysFromNow}`);
      assert(early.length === 0, `listed ${early.join(', ')}`);
    }
    const running = nyWeek.events.filter(e => e.runningLabel).map(e => `${e.summary} ${e.day} ${e.daysFromNow}`);
    assertList(running, ['Vacation 2026-10-13 0', 'Conference 2026-10-13 0']);
  });

  await check('(d) last night\'s event ending by 06:00 is not today\'s, as in the daily summary', () => {
    assert(!ilWeek.events.some(e => e.summary === 'Night shift'), 'Night shift listed');
  });

  await check('(d) /week: a vacation and a visit already under way show as running today', async () => {
    const tuesdayMorning = new Date('2026-10-13T09:00:00-04:00');
    const lookahead = await getWeekLookahead(runningNewYorker, calendars, tuesdayMorning);
    // The week-long visit names both Saturdays by date; the four-day vacation needs no dates.
    assertList(daysOf(await promptFor(lookahead, runningNewYorker)), [
      'Tuesday, Oct 13 - Today | all day (Sat 10 15:00 - Sat 17 12:00) - Grandma visiting (Family) | All day (began Mon, through Thu) - Vacation (Family)',
      'Thursday, Oct 15 - In 2 days | 19:00 - Thu dinner (Family)',
      'Saturday, Oct 17 - In 4 days | 22:00 - Sleepover (Family)',
    ]);
  });

  await check('(d) /week on the week-long visit\'s last day: it started last Saturday, by date, not "Sat" that reads as today', async () => {
    const saturdayMorning = new Date('2026-10-17T08:00:00-04:00');
    const lookahead = await getWeekLookahead(runningNewYorker, calendars, saturdayMorning);
    assertList(daysOf(await promptFor(lookahead, runningNewYorker)), [
      'Saturday, Oct 17 - Today | until 12:00 (started Sat 10 15:00) - Grandma visiting (Family) | 22:00 - Sleepover (Family)',
    ]);
  });

  await check('(d) /week on Sunday morning: the sleepover until 10:00 is today\'s pickup', async () => {
    const sundayMorning = new Date('2026-10-18T08:00:00-04:00');
    const lookahead = await getWeekLookahead(runningNewYorker, calendars, sundayMorning);
    assertList(daysOf(await promptFor(lookahead, runningNewYorker)), [
      'Sunday, Oct 18 - Today | until 10:00 (started yesterday 22:00) - Sleepover (Family)',
    ]);
  });

  await check('(d) /nextweek: a break that began on the weekend before shows on the Monday', async () => {
    const tuesday = new Date('2026-10-20T12:00:00-04:00');
    const lookahead = await getNextWeekLookahead(runningNewYorker, calendars, tuesday);
    assertList(daysOf(await promptFor(lookahead, runningNewYorker, true)), [
      'Monday, Oct 26 - In 6 days | All day (began Sat, through Tue) - Fall break (Family)',
    ]);
  });

  await check('(d) an event that started earlier today and is still on is Today', () => {
    const club = nyWeek.events.find(e => e.summary === 'Homework club');
    assert(club?.daysFromNow === 0, `daysFromNow ${club?.daysFromNow}`);
  });

  // (e)
  await check('(e) New York /week runs to the end of Sunday in New York', () => {
    const end = startOfLocalDay('2026-10-19', NY).getTime() - 1;
    assert(nyWeek.dateRange.end.getTime() === end, `ends ${nyWeek.dateRange.end.toISOString()}`);
    assert(nyWeekCalls[0]?.timeMax === new Date(end).toISOString(), `timeMax ${nyWeekCalls[0]?.timeMax}`);
  });

  await check('(e) Israel /week ends with Saturday: Sunday 01:00 is next week', () => {
    const end = startOfLocalDay('2026-10-18', IL).getTime() - 1;
    assert(ilWeek.dateRange.end.getTime() === end, `ends ${ilWeek.dateRange.end.toISOString()}`);
    assert(!ilWeek.events.some(e => e.summary === 'Early flight'), 'Early flight listed');
  });

  await check('(e) New York /nextweek on Sunday night is the coming Monday to Sunday', async () => {
    const sundayNight = new Date('2026-10-18T21:00:00-04:00');
    const lookahead = await getNextWeekLookahead(newYorker, calendars, sundayNight);
    assert(lookahead.dateRange.start.getTime() === startOfLocalDay('2026-10-19', NY).getTime(), `starts ${lookahead.dateRange.start.toISOString()}`);
    assert(lookahead.dateRange.end.getTime() === startOfLocalDay('2026-10-26', NY).getTime() - 1, `ends ${lookahead.dateRange.end.toISOString()}`);
    const prompt = await promptFor(lookahead, newYorker, true);
    assert(rangeOf(prompt) === 'Monday, Oct 19 to Sunday, Oct 25', `range ${rangeOf(prompt)}`);
    // Sunday's overnight Late sleepover belongs to this week, not next.
    assertList(daysOf(prompt), [
      'Monday, Oct 19 - Tomorrow | 10:00 - Brunch (Family)',
      'Friday, Oct 23 - In 5 days | All day - Book fair (Family)',
      'Sunday, Oct 25 - In 7 days | 19:00 - Parent meeting (Family)',
    ]);
  });

  await check('(e) Israel /nextweek on Saturday night is Sunday to Saturday, Israel\'s midnights', async () => {
    const saturdayNight = new Date('2026-10-17T23:30:00+03:00');
    const lookahead = await getNextWeekLookahead(israeli, calendars, saturdayNight);
    assert(lookahead.dateRange.start.getTime() === startOfLocalDay('2026-10-18', IL).getTime(), `starts ${lookahead.dateRange.start.toISOString()}`);
    assert(lookahead.dateRange.end.getTime() === startOfLocalDay('2026-10-25', IL).getTime() - 1, `ends ${lookahead.dateRange.end.toISOString()}`);
    const prompt = await promptFor(lookahead, israeli, true);
    assert(rangeOf(prompt) === 'Sunday, Oct 18 to Saturday, Oct 24', `range ${rangeOf(prompt)}`);
    // Saturday's party runs past midnight but belongs to this week; Motzei Shabbat at
    // the end of next week shows once, on Saturday; Sunday 00:30 after it is the week after.
    assertList(daysOf(prompt), [
      'Sunday, Oct 18 (7 Cheshvan) - Tomorrow | 01:00 - Early flight (Family)',
      'Saturday, Oct 24 (13 Cheshvan) - In 7 days | 21:00 - Motzei Shabbat (Family)',
    ]);
  });

  await check('(e) a week across Israel\'s DST change ends at its own local midnight', async () => {
    const lookahead = await getNextWeekLookahead(israeli, calendars, new Date('2026-10-20T12:00:00+03:00'));
    assert(lookahead.dateRange.start.toISOString() === '2026-10-24T21:00:00.000Z', `starts ${lookahead.dateRange.start.toISOString()}`);
    assert(lookahead.dateRange.end.toISOString() === '2026-10-31T21:59:59.999Z', `ends ${lookahead.dateRange.end.toISOString()}`);
  });

  // (f) built-in calendar reminders
  const reminderWeek = await getWeekLookahead(nativeIsraeli, calendars, new Date('2026-10-13T09:00:00+03:00'));

  await check('(f) /week: a reminder shows once, on its own day, as "Reminder HH:MM", with whose it is', async () => {
    // Renew passport is done and Take vitamins is daily: neither is coming up.
    assertList(daysOf(await promptFor(reminderWeek, nativeIsraeli)), [
      'Thursday, Oct 15 - In 2 days | Reminder 10:00 - Call the plumber (Family) | 11:00 - Dentist (Family)',
      'Friday, Oct 16 - In 3 days | Reminder 17:00 - Buy milk (Family) (for Dana, you asked)',
      'Saturday, Oct 17 - In 4 days | Reminder - Pick up the cake (Family) (from Dana)',
    ]);
  });

  await check('(f) /week: the reminders guideline comes only with reminders', async () => {
    assert((await promptFor(reminderWeek, nativeIsraeli)).includes('- **Reminders**: Times starting with "Reminder"'), 'no guideline');
    assert(!(await promptFor(nyWeek, newYorker)).includes('Reminder'), 'a Google week mentions reminders');
  });

  await check('(f) /week in Hebrew and Russian: the reminder label is the user\'s language', async () => {
    prompts.length = 0;
    await generateWeekLookahead(reminderWeek, nativeIsraeli, 'he');
    assert(prompts[0]?.includes('  - תזכורת 10:00 - Call the plumber (Family)'), 'Hebrew timed');
    assert(prompts[0]?.includes('  - תזכורת - Pick up the cake (Family) (from Dana)'), 'Hebrew date-only');
    assert(prompts[0]?.includes('- **תזכורות**:'), 'Hebrew guideline');
    prompts.length = 0;
    await generateWeekLookahead(reminderWeek, nativeIsraeli, 'ru');
    assert(prompts[0]?.includes('  - Напоминание 17:00 - Buy milk (Family) (for Dana, you asked)'), 'Russian timed');
    assert(prompts[0]?.includes('- **Напоминания**:'), 'Russian guideline');
  });

  await check('(f) the tomorrow summary\'s lookahead lists reminders with the daily summary\'s label', async () => {
    const lookahead = await getWeekLookahead(nativeIsraeli, calendars, fromZonedTime('2026-10-14 12:00:00', IL));
    assertList(formatTomorrowLookahead(lookahead).split('\n'), [
      'Thursday: Call the plumber (Reminder 10:00)',
      'Thursday: Dentist at 11:00 (Family)',
      'Friday: Buy milk (Reminder 17:00) (for Dana, you asked)',
      'Saturday: Pick up the cake (Reminder (all day)) (from Dana)',
    ]);
  });

  // (g) the series lookup cache
  const seriesTuesday = new Date('2026-10-13T09:00:00+03:00');
  const T0 = seriesTuesday.getTime();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const BOTH = (token: string) => `asked ${token}:carpool, ${token}:bookclub`;
  /** One /week run at `at` on the cache's clock: what it lists | the lookups it made. */
  const seriesWeek = async (u: UserConfig, at: number) => {
    clock = at;
    masterCalls.length = 0;
    const lookahead = await getWeekLookahead(u, calendars, seriesTuesday);
    return `${lookahead.events.map(e => e.summary).join(', ') || 'nothing'} | asked ${masterCalls.join(', ') || 'nothing'}`;
  };
  const freshCache = () => {
    clearRecurrenceCache();
    for (const token of Object.keys(masterErrors)) delete masterErrors[token];
    masterTookMs = 0;
  };

  // The cache reads Date.now; nothing else in a lookahead given a reference date does.
  // The failed lookups' warnings are expected.
  const realNow = Date.now;
  const realWarn = console.warn;
  Date.now = () => clock;
  console.warn = () => undefined;
  try {
    await check('(g) a failed lookup is kept 10 minutes, then asked again', async () => {
      freshCache();
      masterErrors['token-series-6'] = googleError(503);
      const got = [`0:00:00: ${await seriesWeek(seriesUser, T0)}`];
      delete masterErrors['token-series-6'];
      got.push(`0:09:59: ${await seriesWeek(seriesUser, T0 + 10 * MIN - 1000)}`);
      got.push(`0:10:00: ${await seriesWeek(seriesUser, T0 + 10 * MIN)}`);
      assertList(got, [
        `0:00:00: nothing | ${BOTH('token-series-6')}`,
        '0:09:59: nothing | asked nothing',
        `0:10:00: Book club | ${BOTH('token-series-6')}`,
      ]);
    });

    await check('(g) an answer is kept 6 hours, then asked again', async () => {
      freshCache();
      const got = [`0:00:00: ${await seriesWeek(seriesUser, T0)}`];
      // Asked again now, the lookup would fail: what shows is the kept answer.
      masterErrors['token-series-6'] = googleError(503);
      got.push(`5:59:59: ${await seriesWeek(seriesUser, T0 + 6 * HOUR - 1000)}`);
      got.push(`6:00:00: ${await seriesWeek(seriesUser, T0 + 6 * HOUR)}`);
      assertList(got, [
        `0:00:00: Book club | ${BOTH('token-series-6')}`,
        '5:59:59: Book club | asked nothing',
        `6:00:00: nothing | ${BOTH('token-series-6')}`,
      ]);
    });

    await check('(g) a series that is gone (404, 410) is kept 6 hours, not asked again after 10 minutes', async () => {
      const got: string[] = [];
      for (const status of [404, 410]) {
        freshCache();
        masterErrors['token-series-6'] = googleError(status);
        got.push(`${status} 0:00:00: ${await seriesWeek(seriesUser, T0)}`);
        delete masterErrors['token-series-6'];
        got.push(`${status} 0:10:00: ${await seriesWeek(seriesUser, T0 + 10 * MIN)}`);
        got.push(`${status} 5:59:59: ${await seriesWeek(seriesUser, T0 + 6 * HOUR - 1000)}`);
        got.push(`${status} 6:00:00: ${await seriesWeek(seriesUser, T0 + 6 * HOUR)}`);
      }
      assertList(got, [404, 410].flatMap(status => [
        `${status} 0:00:00: nothing | ${BOTH('token-series-6')}`,
        `${status} 0:10:00: nothing | asked nothing`,
        `${status} 5:59:59: nothing | asked nothing`,
        `${status} 6:00:00: Book club | ${BOTH('token-series-6')}`,
      ]));
    });

    await check('(g) two users with the same calendar and series ids each get their own answer', async () => {
      freshCache();
      masterErrors['token-series-6'] = googleError(503);
      assertList([await seriesWeek(seriesUser, T0), await seriesWeek(otherSeriesUser, T0)], [
        `nothing | ${BOTH('token-series-6')}`,
        `Book club | ${BOTH('token-series-66')}`,
      ]);
    });

    await check('(g) each series is looked up once per run, even when its answer runs out mid-run', async () => {
      freshCache();
      masterErrors['token-series-6'] = googleError(503);
      // Each lookup takes 11 minutes on the cache's clock, so a failure is stale before the
      // next Carpool. The run still asks about each series once.
      masterTookMs = 11 * MIN;
      assertList([await seriesWeek(seriesUser, T0)], [`nothing | ${BOTH('token-series-6')}`]);
    });

    await check('(g) clearRecurrenceCacheForUser drops that user\'s answers only', async () => {
      freshCache();
      await seriesWeek(seriesUser, T0);
      await seriesWeek(otherSeriesUser, T0);
      clearRecurrenceCacheForUser(6);
      assertList([await seriesWeek(seriesUser, T0 + MIN), await seriesWeek(otherSeriesUser, T0 + MIN)], [
        `Book club | ${BOTH('token-series-6')}`,
        'Book club | asked nothing',
      ]);
    });
  } finally {
    Date.now = realNow;
    console.warn = realWarn;
    freshCache();
  }

  await check('(g) recurrence-cache.ts loads on its own: no Google client, Prisma or calendar provider', () => {
    // Calendar write paths clear the cache through this module, so it must stay a leaf.
    // Asked in a fresh process with this one's tsx loader: this process has week-lookahead
    // and the stubs loaded already.
    const root = path.resolve(__dirname, '..');
    const leaf = path.join(root, 'src/services/recurrence-cache.ts');
    assert(existsSync(leaf), 'src/services/recurrence-cache.ts does not exist');
    const probe = `require(${JSON.stringify(leaf)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
    const loaded = JSON.parse(execFileSync(process.execPath, [...process.execArgv, '-e', probe], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })) as string[];
    const appModules = loaded
      .filter(file => file.startsWith(root + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`))
      .map(file => path.relative(root, file));
    assertList(appModules, ['src/services/recurrence-cache.ts']);
    const packages = loaded.filter(file => /[\\/]node_modules[\\/](@googleapis|googleapis|@prisma|\.prisma|@upstash)[\\/]/.test(file));
    assert(packages.length === 0, `it loaded ${packages.join(', ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
