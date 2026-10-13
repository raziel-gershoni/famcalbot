// Smoke test for the dates in the voice pipeline: which days a voice edit or delete
// searches, how the candidate events read to the matcher and which it is shown first, what
// an edit saves and how its confirmation reads, and where a new all-day event starts and
// ends. Google's API and the AI matcher are faked; Google's records what the real provider
// and calendar.ts send it. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-voice-dates.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-voice-dates.ts

import Module from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { toUnifiedEvent } from '../src/services/calendar-provider/native-provider';
import type { UnifiedEvent } from '../src/services/calendar-provider/types';
import type { EditRequest, EventReference } from '../src/services/event-parser';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';

/** Every event body the bot sends Google (insert or patch). */
type GoogleTime = { date?: string | null; dateTime?: string | null };
const sentToGoogle: Array<{ start?: GoogleTime; end?: GoogleTime }> = [];
/** The event Google holds, which events.get returns before an update. */
let googleHolds: { start: GoogleTime; end: GoogleTime } = { start: {}, end: {} };
const record = async ({ requestBody }: { requestBody: { start?: GoogleTime; end?: GoogleTime } }) => {
  sentToGoogle.push(requestBody);
  return { data: { id: 'g1' } };
};
const fakeGoogle = {
  calendar: () => ({ events: { insert: record, patch: record, get: async () => ({ data: googleHolds }) } }),
  auth: { OAuth2: class { setCredentials() {} } },
};

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
/** Each test user's timezone, as resolveUserTimezone would give it. */
const USER_TIMEZONES: Record<number, string> = { 1: IL, 2: NY };
const userIn = (tz: string) =>
  ({ id: Number(Object.keys(USER_TIMEZONES).find(id => USER_TIMEZONES[Number(id)] === tz)), googleRefreshToken: 'token' }) as unknown as UserConfig;

/**
 * The AI matcher, faked: it picks the first listed event whose title has the user's
 * description in it, as the prompt asks, and records every prompt it is sent.
 */
const matcherPrompts: string[] = [];
async function fakeMatcher(prompt: string) {
  matcherPrompts.push(prompt);
  const description = (/User's description: "(.*)"/.exec(prompt)?.[1] ?? '').toLowerCase();
  const listed = prompt.split('Available events:\n')[1].split('\n\n')[0].split('\n');
  const index = listed.findIndex(line => line.toLowerCase().includes(description));
  return { text: JSON.stringify(index < 0 ? { match: 'none' } : { match: 'single', eventIndex: index + 1 }) };
}

// The voice modules reach src/services/claude.ts, which imports @hebcal/core. That package
// ships ESM only and tsx cannot require it; nothing under test uses it. Google's client,
// the timezone lookup and the AI completion are faked.
const timezoneModule = path.resolve(__dirname, '../src/lib/timezone.ts');
const aiProviderModule = path.resolve(__dirname, '../src/services/ai-provider.ts');
const fakeTimezone = { resolveUserTimezone: async (user: { id: number }) => USER_TIMEZONES[user.id] };
let fakeAiProvider: object | undefined;
type Loader = (request: string, parent: unknown, ...rest: unknown[]) => unknown;
const loader = Module as unknown as { _load: Loader; _resolveFilename: (request: string, parent: unknown) => string };
const load = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, ...rest: unknown[]) {
  if (request.startsWith('@hebcal/')) return {};
  if (request === '@googleapis/calendar') return fakeGoogle;
  if (request.endsWith('/lib/timezone') && loader._resolveFilename(request, parent) === timezoneModule) return fakeTimezone;
  if (request.endsWith('/ai-provider') && loader._resolveFilename(request, parent) === aiProviderModule) {
    // A proxy, not a copy: the module is still loading when its own imports require it back
    const real = load.call(this, request, parent, ...rest) as object;
    fakeAiProvider ??= new Proxy(real, { get: (target, key) => (key === 'generateAICompletion' ? fakeMatcher : Reflect.get(target, key)) });
    return fakeAiProvider;
  }
  return load.call(this, request, parent, ...rest);
};
// The providers load the timezone lookup with import(), which goes through the ES module
// loader instead; it gets the same fake, served as an ES module.
(globalThis as { fakeTimezone?: typeof fakeTimezone }).fakeTimezone = fakeTimezone;
Module.registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== timezoneModule) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: 'export const resolveUserTimezone = globalThis.fakeTimezone.resolveUserTimezone;\n' };
  },
});

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
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

/** An instant as the user's clock shows it. */
const at = (date: Date | undefined, tz: string) => (date ? formatInTimeZone(date, tz, 'yyyy-MM-dd HH:mm') : 'unset');

/** A native all-day event as the bot stores it: 00:00 to 23:59 local on its last day. */
function nativeAllDay(firstDay: string, lastDay: string, tz: string) {
  const startsAt = fromZonedTime(`${firstDay}T00:00:00`, tz);
  const endsAt = fromZonedTime(`${lastDay}T23:59:00`, tz);
  return { startsAt, endsAt, unified: unify(startsAt, endsAt, tz) };
}

function unify(startsAt: Date, endsAt: Date, tz: string, allDay = true): CalendarEvent {
  return toUnifiedEvent({ id: 'c1', name: 'Family' }, {
    title: 'Trip', startsAt, endsAt, allDay, timeZone: tz,
    seriesEventId: 'e1', instanceStartsAt: startsAt, isRecurringInstance: false,
  });
}

/** A Google event: dates for all-day (end exclusive), ISO instants for timed. */
const ev = (summary: string, start: string, end: string): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Family', calendarId: 'c1' });

/** What Google was last sent, as start..end: dates for an all-day event. */
function lastSentToGoogle(): string {
  const body = sentToGoogle[sentToGoogle.length - 1];
  return `${body?.start?.date ?? body?.start?.dateTime ?? 'unset'}..${body?.end?.date ?? body?.end?.dateTime ?? 'unset'}`;
}

async function main() {
  const {
    buildMatchPrompt, convertEditRequestToUpdates, describeEventForMatching, findMatchingEvent, hintedDay, matchSearchRange,
  } = await import('../src/services/voice/event-resolution');
  const { buildEventTimes, parseGeminiEventResponse } = await import('../src/services/voice/gemini-voice');
  const { formatEditChanges, formatCalendarEventDateTime } = await import('../src/services/voice/confirmations');
  const { googleProvider } = await import('../src/services/calendar-provider/google-provider');

  /** A Google event after a voice edit through the real provider, as Google is sent it. */
  async function editGoogle(original: CalendarEvent, tz: string, request: EditRequest): Promise<string> {
    const holds = (value: string) => (value.includes('T') ? { dateTime: value } : { date: value });
    googleHolds = { start: holds(original.start), end: holds(original.end) };
    sentToGoogle.length = 0;
    const updates = convertEditRequestToUpdates(request, original, tz);
    const result = await googleProvider.updateEvent(userIn(tz), 'c1', 'g1', updates);
    assert(result.success, `update failed: ${result.errorMessage}`);
    return lastSentToGoogle();
  }

  /** A new all-day event through the real provider, as Google is sent it. */
  async function createGoogle(startTime: Date, endTime: Date, tz: string): Promise<string> {
    sentToGoogle.length = 0;
    const result = await googleProvider.createEvent(userIn(tz), 'c1', { title: 'Trip', startTime, endTime, allDay: true });
    assert(result.success, `create failed: ${result.errorMessage}`);
    return lastSentToGoogle();
  }

  /** The changes an edit confirmation lists for a native all-day event, one line each. */
  const confirmNative = (original: CalendarEvent, request: EditRequest, tz: string) =>
    formatEditChanges(original, convertEditRequestToUpdates(request, original, tz), 'en', tz, 'All day').split('\n').join(' | ');

  /** A native all-day event after a voice edit, as Google-style dates: start..exclusive end. */
  function editNative(firstDay: string, lastDay: string, tz: string, request: EditRequest, userTz = tz): string {
    const original = nativeAllDay(firstDay, lastDay, tz);
    const updates = convertEditRequestToUpdates(request, original.unified, userTz);
    const edited = unify(updates.startTime ?? original.startsAt, updates.endTime ?? original.endsAt, tz);
    return `${edited.start}..${edited.end}`;
  }

  // (a) Matching an event for a voice edit or delete.

  check('"tomorrow" at 01:30 in Israel searches the next local day, not the UTC one', () => {
    const now = new Date('2026-10-13T22:30:00Z'); // Wednesday 2026-10-14 01:30 in Israel
    const { startDate, endDate } = matchSearchRange({ timeHint: 'tomorrow' }, now, IL);
    assert(at(startDate, IL) === '2026-10-15 00:00' && at(endDate, IL) === '2026-10-16 00:00', `${at(startDate, IL)}..${at(endDate, IL)}`);
  });

  check('"היום" late in the evening in New York searches that local day', () => {
    const now = new Date('2026-10-14T02:30:00Z'); // Tuesday 2026-10-13 22:30 in New York
    const { startDate, endDate } = matchSearchRange({ timeHint: 'היום' }, now, NY);
    assert(at(startDate, NY) === '2026-10-13 00:00' && at(endDate, NY) === '2026-10-14 00:00', `${at(startDate, NY)}..${at(endDate, NY)}`);
  });

  check('"next week" searches two weeks from the start of the local day', () => {
    const now = new Date('2026-10-13T22:30:00Z');
    const { startDate, endDate } = matchSearchRange({ timeHint: 'next week' }, now, IL);
    assert(at(startDate, IL) === '2026-10-14 00:00' && at(endDate, IL) === '2026-10-28 00:00', `${at(startDate, IL)}..${at(endDate, IL)}`);
  });

  check('a timed candidate reads on the user\'s clock, with its weekday', () => {
    const line = describeEventForMatching(ev('Dentist', '2026-10-14T15:00:00+03:00', '2026-10-14T16:00:00+03:00'), 0, IL);
    assert(line === '1. "Dentist" on Wednesday 2026-10-14 at 15:00 (calendar: c1)', `got ${line}`);
  });

  check('an all-day candidate keeps its own date, west of UTC too', () => {
    const line = describeEventForMatching(ev('Trip', '2026-10-13', '2026-10-14'), 1, NY);
    assert(line === '2. "Trip" on Tuesday 2026-10-13 (all day) (calendar: c1)', `got ${line}`);
  });

  check('a candidate that runs into a later day says until when', () => {
    const sleepover = describeEventForMatching(ev('Sleepover', '2026-10-13T18:00:00+03:00', '2026-10-14T10:00:00+03:00'), 0, IL);
    assert(sleepover === '1. "Sleepover" on Tuesday 2026-10-13 at 18:00 until Wednesday 2026-10-14 10:00 (calendar: c1)', `got ${sleepover}`);
    const trip = describeEventForMatching(ev('Trip', '2026-10-13', '2026-10-16'), 1, NY);
    assert(trip === '2. "Trip" on Tuesday 2026-10-13 (all day) until Thursday 2026-10-15 (calendar: c1)', `got ${trip}`);
  });

  const sleepoverRef: EventReference = { type: 'by_description', description: 'sleepover' };

  check('the matcher is told the user\'s date and the day the reference means', () => {
    const tuesday = buildMatchPrompt({ ...sleepoverRef, timeHint: 'tomorrow' }, 'en', '', new Date('2026-10-13T09:00:00Z'), IL);
    assert(tuesday.includes('Today is Tuesday 2026-10-13; "tomorrow" means Wednesday 2026-10-14.'), `Tuesday: ${tuesday.split('\n')[3]}`);
    // 01:30 on Wednesday in Israel is still Tuesday on the server's UTC clock
    const night = buildMatchPrompt({ ...sleepoverRef, timeHint: 'מחר' }, 'he', '', new Date('2026-10-13T22:30:00Z'), IL);
    assert(night.includes('Today is Wednesday 2026-10-14; "מחר" means Thursday 2026-10-15.'), `night: ${night.split('\n')[3]}`);
    const named = buildMatchPrompt({ ...sleepoverRef, timeHint: 'Thursday' }, 'en', '', new Date('2026-10-13T09:00:00Z'), IL);
    assert(named.includes('Today is Tuesday 2026-10-13; "Thursday" means Thursday 2026-10-15.\n\n'), `named: ${named.split('\n').slice(3, 5).join(' | ')}`);
    const dated = buildMatchPrompt({ ...sleepoverRef, originalDate: '2026-10-15' }, 'en', '', new Date('2026-10-13T09:00:00Z'), IL);
    assert(dated.includes('Today is Tuesday 2026-10-13; the user means Thursday 2026-10-15.'), `dated: ${dated.split('\n')[3]}`);
    const vague = buildMatchPrompt({ ...sleepoverRef, timeHint: 'next Thursday' }, 'en', '', new Date('2026-10-13T09:00:00Z'), IL);
    assert(vague.includes('Today is Tuesday 2026-10-13.\nDate hint: "next Thursday"'), `vague: ${vague.split('\n').slice(3, 5).join(' | ')}`);
  });

  check('the matcher prefers events starting on the day; one carried over counts only when none of those matches', () => {
    const prompt = buildMatchPrompt({ ...sleepoverRef, timeHint: 'Thursday' }, 'en', '', new Date('2026-10-13T09:00:00Z'), IL);
    const rule = prompt.split('\n').find(line => line.startsWith('3. '));
    assert(rule === '3. If a date is meant (e.g., "tomorrow"), prefer events that start on that date; count one carried over from an earlier day only when none starting on it matches', `rule 3: ${rule}`);
  });

  check('"the day after tomorrow" is two days on, not tomorrow, in all three languages', () => {
    const now = new Date('2026-10-13T09:00:00Z');
    for (const hint of ['the day after tomorrow', 'מחרתיים', 'послезавтра']) {
      const { startDate, endDate } = matchSearchRange({ timeHint: hint }, now, IL);
      assert(hintedDay({ timeHint: hint }, now, IL) === '2026-10-15', `${hint}: ${hintedDay({ timeHint: hint }, now, IL)}`);
      assert(at(startDate, IL) === '2026-10-15 00:00' && at(endDate, IL) === '2026-10-16 00:00', `${hint}: ${at(startDate, IL)}..${at(endDate, IL)}`);
    }
  });

  check('a weekday is the coming one, today when it is that day, in all three languages', () => {
    const tuesday = new Date('2026-10-13T09:00:00Z');
    const days: Array<[string, string]> = [
      ['Thursday', '2026-10-15'], ["thursday's", '2026-10-15'], ['ביום חמישי', '2026-10-15'], ['в четверг', '2026-10-15'],
      ['Tuesday', '2026-10-13'], ['ביום שלישי', '2026-10-13'], ['во вторник', '2026-10-13'],
      ['Monday', '2026-10-19'], ['ביום שני', '2026-10-19'], ['в понедельник', '2026-10-19'],
      ['בשבת', '2026-10-17'], ['в субботу', '2026-10-17'], ['в среду', '2026-10-14'], ['до пятницы', '2026-10-16'],
    ];
    for (const [hint, day] of days) {
      assert(hintedDay({ timeHint: hint }, tuesday, IL) === day, `${hint}: ${hintedDay({ timeHint: hint }, tuesday, IL)}`);
    }
    // 01:30 on Wednesday in Israel: "Wednesday" is today there, not next week's
    assert(hintedDay({ timeHint: 'Wednesday' }, new Date('2026-10-13T22:30:00Z'), IL) === '2026-10-14', 'Wednesday at 01:30');
    const { startDate, endDate } = matchSearchRange({ timeHint: 'Thursday' }, tuesday, IL);
    assert(at(startDate, IL) === '2026-10-15 00:00' && at(endDate, IL) === '2026-10-16 00:00', `Thursday: ${at(startDate, IL)}..${at(endDate, IL)}`);
  });

  check('a weekday some other word or a date makes another one is left to the matcher', () => {
    const tuesday = new Date('2026-10-13T09:00:00Z');
    for (const hint of [
      'last Thursday', 'next Thursday', 'the Thursday before', 'Thursday the 22nd', 'Thursday or Friday',
      'יום חמישי שעבר', 'יום חמישי הבא', 'ערב שבת', 'в прошлый четверг', 'в следующий четверг',
      'שבוע הבא', 'this week', 'שני ילדים',
    ]) {
      assert(hintedDay({ timeHint: hint }, tuesday, IL) === undefined, `${hint}: ${hintedDay({ timeHint: hint }, tuesday, IL)}`);
    }
  });

  check('the date the model read for the event comes first; one that is not a date is ignored', () => {
    const tuesday = new Date('2026-10-13T09:00:00Z');
    assert(hintedDay({ originalDate: '2026-10-22' }, tuesday, IL) === '2026-10-22', 'date alone');
    assert(hintedDay({ timeHint: 'Thursday', originalDate: '2026-10-22' }, tuesday, IL) === '2026-10-22', 'date with a weekday');
    // Before the default search's week back
    const { startDate, endDate } = matchSearchRange({ originalDate: '2026-09-01' }, tuesday, IL);
    assert(at(startDate, IL) === '2026-09-01 00:00' && at(endDate, IL) === '2026-09-02 00:00', `range: ${at(startDate, IL)}..${at(endDate, IL)}`);
    for (const originalDate of [null, '', 'YYYY-MM-DD', '2026-02-30', '2026-13-01', '15/10/2026']) {
      const reference = { timeHint: 'tomorrow', originalDate } as unknown as EventReference;
      assert(hintedDay(reference, tuesday, IL) === '2026-10-14', `${originalDate}: ${hintedDay(reference, tuesday, IL)}`);
    }
  });

  /**
   * The event findMatchingEvent picks for an Israeli user at `now` (the fake fetch returns
   * those of `events` overlapping its range), and the event lists the matcher was shown.
   */
  async function match(events: CalendarEvent[], description: string, day: string | Partial<EventReference> | undefined, now: Date) {
    googleProvider.fetchEventsInRange = async (_user, _calendarIds, from, to) =>
      events.filter(e => new Date(e.start) < to && new Date(e.end) > from) as UnifiedEvent[];
    matcherPrompts.length = 0;
    const named = typeof day === 'string' ? { timeHint: day } : day;
    const result = await findMatchingEvent(userIn(IL), ['c1'], { type: 'by_description', description, ...named }, 'en', now);
    const shown = matcherPrompts.map(p => p.split('Available events:\n')[1].split('\n\n')[0]);
    return { picked: 'event' in result ? `${result.event.summary} ${result.event.start}` : result.error, shown };
  }

  const tuesdayNoon = new Date('2026-10-13T09:00:00Z');
  const tonightsSleepover = ev('Sleepover', '2026-10-13T18:00:00+03:00', '2026-10-14T10:00:00+03:00');
  const tomorrowsSleepover = ev('Sleepover', '2026-10-14T18:00:00+03:00', '2026-10-15T10:00:00+03:00');
  const tomorrowsDentist = ev('Dentist', '2026-10-14T15:00:00+03:00', '2026-10-14T16:00:00+03:00');

  await checkAsync('"cancel tomorrow\'s sleepover" picks the one starting tomorrow, not tonight\'s running into it', async () => {
    const { picked, shown } = await match([tonightsSleepover, tomorrowsSleepover, tomorrowsDentist], 'sleepover', 'tomorrow', tuesdayNoon);
    assert(picked === `Sleepover ${tomorrowsSleepover.start}`, `picked ${picked}`);
    assert(shown.length === 1 && !shown[0].includes('2026-10-13 at 18:00'), `shown ${JSON.stringify(shown)}`);
  });

  await checkAsync('with no sleepover starting tomorrow, tonight\'s that runs into it is found after tomorrow\'s own', async () => {
    const { picked, shown } = await match([tonightsSleepover, tomorrowsDentist], 'sleepover', 'tomorrow', tuesdayNoon);
    assert(picked === `Sleepover ${tonightsSleepover.start}`, `picked ${picked}`);
    assert(shown.length === 2 && shown[0] === '1. "Dentist" on Wednesday 2026-10-14 at 15:00 (calendar: c1)', `shown ${JSON.stringify(shown)}`);
  });

  await checkAsync('nothing on the day or carried into it is still no match; without a day hint all are shown at once', async () => {
    const none = await match([tonightsSleepover, tomorrowsDentist], 'piano', 'tomorrow', tuesdayNoon);
    assert(none.picked === 'no_match' && none.shown.length === 2, `no match: ${none.picked}, ${none.shown.length} rounds`);
    const all = await match([tonightsSleepover, tomorrowsSleepover, tomorrowsDentist], 'dentist', undefined, tuesdayNoon);
    assert(all.picked === `Dentist ${tomorrowsDentist.start}` && all.shown.length === 1 && all.shown[0].split('\n').length === 3, `no hint: ${all.picked}, ${JSON.stringify(all.shown)}`);
  });

  await checkAsync('a guessed day that finds nothing falls back to the three-week search; "tomorrow" does not', async () => {
    // The model named Thursday, but the dentist is on Wednesday (or gave the edit's new date).
    const wrongDay = await match([tomorrowsDentist], 'dentist', 'Thursday', tuesdayNoon);
    assert(wrongDay.picked === `Dentist ${tomorrowsDentist.start}`, `weekday: ${wrongDay.picked}`);
    const wrongDate = await match([tomorrowsDentist], 'dentist', { originalDate: '2026-10-16' }, tuesdayNoon);
    assert(wrongDate.picked === `Dentist ${tomorrowsDentist.start}`, `originalDate: ${wrongDate.picked}`);
    // "today" narrowed the search before this branch too, and stays narrow.
    const today = await match([tomorrowsDentist], 'dentist', 'today', tuesdayNoon);
    assert(today.picked === 'no_events_found', `today: ${today.picked}`);
  });

  // Thursday's sleepover and Wednesday's, which runs into Thursday morning.
  const wednesdaysSleepover = ev('Sleepover', '2026-10-14T18:00:00+03:00', '2026-10-15T10:00:00+03:00');
  const thursdaysSleepover = ev('Sleepover', '2026-10-15T18:00:00+03:00', '2026-10-16T10:00:00+03:00');
  const thursdaysDentist = ev('Dentist', '2026-10-15T15:00:00+03:00', '2026-10-15T16:00:00+03:00');
  const twoSleepovers = [wednesdaysSleepover, thursdaysDentist, thursdaysSleepover];

  for (const day of ['Thursday', 'ביום חמישי', 'в четверг', { originalDate: '2026-10-15' }, { timeHint: 'Thursday', originalDate: '2026-10-15' }]) {
    await checkAsync(`"cancel Thursday's sleepover" (${JSON.stringify(day)}) picks the one starting Thursday, not Wednesday's running into it`, async () => {
      const { picked, shown } = await match(twoSleepovers, 'sleepover', day, tuesdayNoon);
      assert(picked === `Sleepover ${thursdaysSleepover.start}`, `picked ${picked}`);
      assert(shown.length === 1 && !shown[0].includes('Wednesday 2026-10-14 at 18:00'), `shown ${JSON.stringify(shown)}`);
    });
  }

  await checkAsync('with no sleepover starting on the date the model read, Wednesday\'s that runs into it is found after its own', async () => {
    const { picked, shown } = await match([wednesdaysSleepover, thursdaysDentist], 'sleepover', { originalDate: '2026-10-15' }, tuesdayNoon);
    assert(picked === `Sleepover ${wednesdaysSleepover.start}`, `picked ${picked}`);
    assert(shown.length === 2 && shown[0] === '1. "Dentist" on Thursday 2026-10-15 at 15:00 (calendar: c1)', `shown ${JSON.stringify(shown)}`);
  });

  // (b) Editing an all-day event's dates.

  check('one-day Tuesday, "extend it through Friday": Tuesday to Friday', () => {
    const days = editNative('2026-10-13', '2026-10-13', IL, { newEndDate: '2026-10-16' });
    assert(days === '2026-10-13..2026-10-17', `got ${days}`);
  });

  check('Tuesday to Thursday, "until Friday": Tuesday to Friday', () => {
    const days = editNative('2026-10-13', '2026-10-15', IL, { newEndDate: '2026-10-16' });
    assert(days === '2026-10-13..2026-10-17', `got ${days}`);
  });

  check('one-day Tuesday, "Sunday to Tuesday": both new dates kept', () => {
    const days = editNative('2026-10-13', '2026-10-13', IL, { newStartDate: '2026-10-18', newEndDate: '2026-10-20' });
    assert(days === '2026-10-18..2026-10-21', `got ${days}`);
  });

  check('Tuesday to Thursday moved to Sunday keeps its three days, saved as 00:00 to 23:59 local', () => {
    const original = nativeAllDay('2026-10-13', '2026-10-15', IL);
    const updates = convertEditRequestToUpdates({ newStartDate: '2026-10-18' }, original.unified, IL);
    assert(at(updates.startTime, IL) === '2026-10-18 00:00' && at(updates.endTime, IL) === '2026-10-20 23:59', `${at(updates.startTime, IL)}..${at(updates.endTime, IL)}`);
    assert(editNative('2026-10-13', '2026-10-15', IL, { newStartDate: '2026-10-18' }) === '2026-10-18..2026-10-21', 'days');
  });

  check('New York one-day Tuesday moved to Thursday starts at Thursday 00:00 there', () => {
    const original = nativeAllDay('2026-10-13', '2026-10-13', NY);
    const updates = convertEditRequestToUpdates({ newStartDate: '2026-10-15' }, original.unified, NY);
    assert(at(updates.startTime, NY) === '2026-10-15 00:00' && at(updates.endTime, NY) === '2026-10-15 23:59', `${at(updates.startTime, NY)}..${at(updates.endTime, NY)}`);
  });

  check('a move across the end of daylight saving keeps the days', () => {
    const days = editNative('2026-10-21', '2026-10-23', IL, { newStartDate: '2026-10-26' });
    assert(days === '2026-10-26..2026-10-29', `got ${days}`);
  });

  check('a native event keeps its own timezone: edited from Israel, a New York Tuesday moves to Thursday', () => {
    const days = editNative('2026-10-13', '2026-10-13', NY, { newStartDate: '2026-10-15' }, IL);
    assert(days === '2026-10-15..2026-10-16', `got ${days}`);
  });

  // Google takes dates. An edit hands the provider the same instants as for a native
  // calendar, and calendar.ts turns them into dates on the user's clock, the end exclusive;
  // these go through the real provider and calendar.ts to what Google is sent.

  await checkAsync('Google Tuesday to Thursday, "until Friday": end date Saturday (exclusive), start kept', async () => {
    const dates = await editGoogle(ev('Trip', '2026-10-13', '2026-10-16'), IL, { newEndDate: '2026-10-16' });
    assert(dates === '2026-10-13..2026-10-17', `got ${dates}`);
  });

  await checkAsync('Google Tuesday to Thursday moved to Sunday keeps its three days', async () => {
    const dates = await editGoogle(ev('Trip', '2026-10-13', '2026-10-16'), IL, { newStartDate: '2026-10-18' });
    assert(dates === '2026-10-18..2026-10-21', `got ${dates}`);
  });

  await checkAsync('Google one-day Tuesday in New York moved to Thursday lands on Thursday', async () => {
    const dates = await editGoogle(ev('Trip', '2026-10-13', '2026-10-14'), NY, { newStartDate: '2026-10-15' });
    assert(dates === '2026-10-15..2026-10-16', `got ${dates}`);
  });

  // (b) A timed event made all-day: both ends are set, on its own days unless given others.

  /** A native timed event after a voice edit, as Google-style dates. */
  function editNativeTimed(start: string, end: string, tz: string, request: EditRequest): string {
    const startsAt = fromZonedTime(start, tz);
    const endsAt = fromZonedTime(end, tz);
    const updates = convertEditRequestToUpdates(request, unify(startsAt, endsAt, tz, false), tz);
    const edited = unify(updates.startTime ?? startsAt, updates.endTime ?? endsAt, tz, updates.allDay ?? false);
    return `${edited.start}..${edited.end}`;
  }

  check('native Tuesday 15:00-16:00, "make it all day through Friday": Tuesday to Friday', () => {
    const days = editNativeTimed('2026-10-13T15:00:00', '2026-10-13T16:00:00', IL, { newAllDay: true, newEndDate: '2026-10-16' });
    assert(days === '2026-10-13..2026-10-17', `got ${days}`);
  });

  check('native Tuesday 20:00 to midnight made all-day on Thursday: Thursday only', () => {
    const days = editNativeTimed('2026-10-13T20:00:00', '2026-10-14T00:00:00', IL, { newAllDay: true, newStartDate: '2026-10-15' });
    assert(days === '2026-10-15..2026-10-16', `got ${days}`);
  });

  await checkAsync('Google Wednesday 15:00 made all-day: Wednesday', async () => {
    const dates = await editGoogle(ev('Call', '2026-10-14T15:00:00+03:00', '2026-10-14T16:00:00+03:00'), IL, { newAllDay: true });
    assert(dates === '2026-10-14..2026-10-15', `got ${dates}`);
  });

  await checkAsync('Google Wednesday 01:00 made all-day through Friday: Wednesday to Friday', async () => {
    const dates = await editGoogle(ev('Call', '2026-10-14T01:00:00+03:00', '2026-10-14T02:00:00+03:00'), IL, { newAllDay: true, newEndDate: '2026-10-16' });
    assert(dates === '2026-10-14..2026-10-17', `got ${dates}`);
  });

  await checkAsync('Google Tuesday 20:00 to midnight made all-day on Thursday: Thursday only', async () => {
    const dates = await editGoogle(ev('Call', '2026-10-13T20:00:00+03:00', '2026-10-14T00:00:00+03:00'), IL, { newAllDay: true, newStartDate: '2026-10-15' });
    assert(dates === '2026-10-15..2026-10-16', `got ${dates}`);
  });

  // An end by OVERNIGHT_CUTOFF_HOUR the next morning belongs to the evening it starts.

  check('native Tuesday 22:00 to 02:00 made all-day: Tuesday only; moved to Thursday, Thursday only', () => {
    const days = editNativeTimed('2026-10-13T22:00:00', '2026-10-14T02:00:00', IL, { newAllDay: true });
    assert(days === '2026-10-13..2026-10-14', `made all-day: got ${days}`);
    const moved = editNativeTimed('2026-10-13T22:00:00', '2026-10-14T02:00:00', IL, { newAllDay: true, newStartDate: '2026-10-15' });
    assert(moved === '2026-10-15..2026-10-16', `moved: got ${moved}`);
  });

  check('native sleepover Tuesday 18:00 to Wednesday 10:00 made all-day: both days', () => {
    const days = editNativeTimed('2026-10-13T18:00:00', '2026-10-14T10:00:00', IL, { newAllDay: true });
    assert(days === '2026-10-13..2026-10-15', `got ${days}`);
  });

  await checkAsync('Google Tuesday 22:00 to 02:00 made all-day: Tuesday only, in New York too', async () => {
    const israel = await editGoogle(ev('Party', '2026-10-13T22:00:00+03:00', '2026-10-14T02:00:00+03:00'), IL, { newAllDay: true });
    assert(israel === '2026-10-13..2026-10-14', `Israel: got ${israel}`);
    const newYork = await editGoogle(ev('Party', '2026-10-13T22:00:00-04:00', '2026-10-14T02:00:00-04:00'), NY, { newAllDay: true });
    assert(newYork === '2026-10-13..2026-10-14', `New York: got ${newYork}`);
  });

  // (b) An all-day event made timed: the time given, else the start of its day, for an hour
  // unless given an end; not its all-day length, and not UTC midnight.

  await checkAsync('Google all-day Tuesday "at 10:00 instead": 10:00 to 11:00 on Tuesday, in New York too', async () => {
    for (const tz of [IL, NY]) {
      const [start, end] = (await editGoogle(ev('Trip', '2026-10-13', '2026-10-14'), tz, { newAllDay: false, newStartTime: '10:00' })).split('..');
      assert(at(new Date(start), tz) === '2026-10-13 10:00' && at(new Date(end), tz) === '2026-10-13 11:00', `${tz}: ${at(new Date(start), tz)}..${at(new Date(end), tz)}`);
    }
  });

  await checkAsync('Google all-day Tuesday "not all day" with no time: 00:00 to 01:00 on the user\'s clock', async () => {
    for (const tz of [IL, NY]) {
      const [start, end] = (await editGoogle(ev('Trip', '2026-10-13', '2026-10-14'), tz, { newAllDay: false })).split('..');
      assert(at(new Date(start), tz) === '2026-10-13 00:00' && at(new Date(end), tz) === '2026-10-13 01:00', `${tz}: ${at(new Date(start), tz)}..${at(new Date(end), tz)}`);
    }
  });

  check('native Tuesday-to-Thursday trip made timed lasts an hour unless given an end', () => {
    const trip = nativeAllDay('2026-10-13', '2026-10-15', IL).unified;
    const span = (request: EditRequest) => {
      const updates = convertEditRequestToUpdates(request, trip, IL);
      return `${at(updates.startTime, IL)}..${at(updates.endTime, IL)}${updates.allDay === false ? '' : ' (allDay not cleared)'}`;
    };
    const atNine = span({ newAllDay: false, newStartTime: '09:00' });
    assert(atNine === '2026-10-13 09:00..2026-10-13 10:00', `at nine: ${atNine}`);
    const moved = span({ newAllDay: false, newStartDate: '2026-10-18' });
    assert(moved === '2026-10-18 00:00..2026-10-18 01:00', `moved: ${moved}`);
    const late = span({ newAllDay: false, newStartTime: '22:00', newEndTime: '01:00' });
    assert(late === '2026-10-13 22:00..2026-10-14 01:00', `late: ${late}`);
  });

  // (b) The model's null for a field it leaves alone.

  check('"newAllDay": null leaves allDay unset, through the pending edit\'s JSON too', () => {
    const nulls = { newTitle: null, newStartDate: null, newStartTime: null, newEndDate: null, newEndTime: null, newLocation: null, newAllDay: null };
    const dentist = ev('Dentist', '2026-10-14T10:00:00+03:00', '2026-10-14T11:00:00+03:00');
    const renamed = convertEditRequestToUpdates({ ...nulls, newTitle: 'Orthodontist' } as unknown as EditRequest, dentist, IL);
    assert(JSON.stringify(renamed) === '{"title":"Orthodontist"}', `renamed: ${JSON.stringify(renamed)}`);
    const trip = convertEditRequestToUpdates({ ...nulls, newStartDate: '2026-10-18' } as unknown as EditRequest, ev('Trip', '2026-10-13', '2026-10-14'), IL);
    assert(!('allDay' in trip) && at(trip.startTime, IL) === '2026-10-18 00:00' && at(trip.endTime, IL) === '2026-10-18 23:59', `trip: ${JSON.stringify(trip)}`);
  });

  // (b) A timed end without a new end date keeps its day relative to the start.

  check('"move the lesson from tomorrow 15:00 to today 20:00, until 21:00" ends today', () => {
    const lesson = ev('Lesson', '2026-10-14T15:00:00+03:00', '2026-10-14T16:00:00+03:00');
    const updates = convertEditRequestToUpdates({ newStartDate: '2026-10-13', newStartTime: '20:00', newEndTime: '21:00' }, lesson, IL);
    assert(at(updates.startTime, IL) === '2026-10-13 20:00' && at(updates.endTime, IL) === '2026-10-13 21:00', `${at(updates.startTime, IL)}..${at(updates.endTime, IL)}`);
  });

  check('an overnight end stays overnight, and "until 02:00" after an evening start is the next morning', () => {
    const party = ev('Party', '2026-10-13T20:00:00+03:00', '2026-10-14T01:00:00+03:00');
    const thursday = convertEditRequestToUpdates({ newStartDate: '2026-10-15', newStartTime: '21:00', newEndTime: '02:00' }, party, IL);
    assert(at(thursday.startTime, IL) === '2026-10-15 21:00' && at(thursday.endTime, IL) === '2026-10-16 02:00', `Thursday: ${at(thursday.startTime, IL)}..${at(thursday.endTime, IL)}`);
    const shorter = convertEditRequestToUpdates({ newEndTime: '23:30' }, party, IL);
    assert(shorter.startTime === undefined && at(shorter.endTime, IL) === '2026-10-13 23:30', `shorter: ${at(shorter.endTime, IL)}`);
    const dinner = ev('Dinner', '2026-10-13T20:00:00+03:00', '2026-10-13T23:00:00+03:00');
    const longer = convertEditRequestToUpdates({ newEndTime: '02:00' }, dinner, IL);
    assert(at(longer.endTime, IL) === '2026-10-14 02:00', `longer: ${at(longer.endTime, IL)}`);
  });

  // (b) What the edit confirmation lists, under "Changes:".

  check('confirmation: a native trip moved to Sunday shows the day, and no time change', () => {
    for (const tz of [IL, NY]) {
      const lines = confirmNative(nativeAllDay('2026-10-13', '2026-10-13', tz).unified, { newStartDate: '2026-10-18' }, tz);
      assert(lines === '📆 Tue, Oct 13 → Sun, Oct 18', `${tz}: got ${lines}`);
    }
  });

  check('confirmation: a Google trip in New York moved to Thursday shows Thursday', () => {
    const trip = ev('Trip', '2026-10-13', '2026-10-14');
    const lines = formatEditChanges(trip, convertEditRequestToUpdates({ newStartDate: '2026-10-15' }, trip, NY), 'en', NY, 'All day');
    assert(lines === '📆 Tue, Oct 13 → Thu, Oct 15', `got ${lines}`);
  });

  check('confirmation: "extend it through Friday" shows the new last day', () => {
    const lines = confirmNative(nativeAllDay('2026-10-13', '2026-10-13', IL).unified, { newEndDate: '2026-10-16' }, IL);
    assert(lines === '📆 Tue, Oct 13 → Tue, Oct 13 – Fri, Oct 16', `got ${lines}`);
  });

  check('confirmation: a timed event made all-day through Friday', () => {
    const call = unify(fromZonedTime('2026-10-13T15:00:00', IL), fromZonedTime('2026-10-13T16:00:00', IL), IL, false);
    const lines = confirmNative(call, { newAllDay: true, newEndDate: '2026-10-16' }, IL);
    assert(lines === '📆 Tue, Oct 13 → Tue, Oct 13 – Fri, Oct 16 | 🕐 15:00 → All day', `got ${lines}`);
  });

  check('confirmation: timed moves read as before; a later end alone is shown too', () => {
    const dentist = unify(fromZonedTime('2026-10-13T15:00:00', IL), fromZonedTime('2026-10-13T16:00:00', IL), IL, false);
    const moved = confirmNative(dentist, { newStartDate: '2026-10-15', newStartTime: '17:00' }, IL);
    assert(moved === '📆 Tue, Oct 13 → Thu, Oct 15 | 🕐 15:00 → 17:00', `moved: got ${moved}`);
    const longer = confirmNative(dentist, { newEndTime: '17:30' }, IL);
    assert(longer === '🕐 15:00 - 16:00 → 15:00 - 17:30', `longer: got ${longer}`);
  });

  check('confirmation: an overnight party moved to Thursday shows the date alone, a later end the time', () => {
    const party = unify(fromZonedTime('2026-10-13T22:00:00', IL), fromZonedTime('2026-10-14T02:00:00', IL), IL, false);
    const moved = confirmNative(party, { newStartDate: '2026-10-15' }, IL);
    assert(moved === '📆 Tue, Oct 13 → Thu, Oct 15', `moved: got ${moved}`);
    const later = confirmNative(party, { newEndTime: '03:00' }, IL);
    assert(later === '🕐 22:00 - Wed, Oct 14 02:00 → 22:00 - Wed, Oct 14 03:00', `later: got ${later}`);
    const dinner = unify(fromZonedTime('2026-10-13T20:00:00', IL), fromZonedTime('2026-10-13T23:00:00', IL), IL, false);
    const pastMidnight = confirmNative(dinner, { newEndTime: '02:00' }, IL);
    assert(pastMidnight === '🕐 20:00 - 23:00 → 20:00 - Wed, Oct 14 02:00', `past midnight: got ${pastMidnight}`);
  });

  check('confirmation: an overnight party made all-day, and an all-day event made timed, show the time change', () => {
    const party = unify(fromZonedTime('2026-10-13T22:00:00', IL), fromZonedTime('2026-10-14T02:00:00', IL), IL, false);
    const allDay = confirmNative(party, { newAllDay: true }, IL);
    assert(allDay === '🕐 22:00 → All day', `all-day: got ${allDay}`);
    const timed = confirmNative(nativeAllDay('2026-10-13', '2026-10-13', IL).unified, { newAllDay: false, newStartTime: '10:00' }, IL);
    assert(timed === '🕐 All day → 10:00', `timed: got ${timed}`);
  });

  check('confirmation: the current all-day event shows its own date in New York', () => {
    const line = formatCalendarEventDateTime(ev('Trip', '2026-10-13', '2026-10-14'), 'en', 'All day', NY);
    assert(line === '📆 Tuesday, October 13 (All day)', `got ${line}`);
  });

  check('an all-day event that stays all-day has no time of day to move', () => {
    const updates = convertEditRequestToUpdates({ newStartTime: '10:00' }, ev('Trip', '2026-10-13', '2026-10-14'), IL);
    assert(updates.startTime === undefined && updates.endTime === undefined, `${at(updates.startTime, IL)}..${at(updates.endTime, IL)}`);
  });

  check('an all-day event made timed keeps its own date, west of UTC too', () => {
    const updates = convertEditRequestToUpdates({ newAllDay: false, newStartTime: '10:00', newEndTime: '12:00' }, ev('Trip', '2026-10-13', '2026-10-14'), NY);
    assert(at(updates.startTime, NY) === '2026-10-13 10:00' && at(updates.endTime, NY) === '2026-10-13 12:00', `${at(updates.startTime, NY)}..${at(updates.endTime, NY)}`);
    assert(updates.allDay === false, 'allDay');
  });

  check('timed edits are unchanged: new time, new date, new end', () => {
    const dentist = ev('Dentist', '2026-10-13T15:00:00+03:00', '2026-10-13T16:00:00+03:00');
    const moved = convertEditRequestToUpdates({ newStartTime: '16:00', newEndTime: '17:00' }, dentist, IL);
    assert(at(moved.startTime, IL) === '2026-10-13 16:00' && at(moved.endTime, IL) === '2026-10-13 17:00', `time ${at(moved.startTime, IL)}..${at(moved.endTime, IL)}`);
    const otherDay = convertEditRequestToUpdates({ newStartDate: '2026-10-15' }, dentist, IL);
    assert(at(otherDay.startTime, IL) === '2026-10-15 15:00' && at(otherDay.endTime, IL) === '2026-10-15 16:00', `date ${at(otherDay.startTime, IL)}..${at(otherDay.endTime, IL)}`);
    const longer = convertEditRequestToUpdates({ newEndTime: '17:30' }, dentist, IL);
    assert(longer.startTime === undefined && at(longer.endTime, IL) === '2026-10-13 17:30', `end ${at(longer.startTime, IL)}..${at(longer.endTime, IL)}`);
  });

  // (c) Creating an all-day event where daylight saving starts at midnight.

  const calendars: CalendarAssignment[] = [{ calendarId: 'primary', name: 'Primary', labels: [], color: '#000' }];
  const create = (event: Record<string, unknown>, tz: string) =>
    parseGeminiEventResponse({ intent: 'create', confidence: 'high', event: { title: 'Trip', calendarId: 'primary', ...event } }, calendars, tz);

  for (const [tz, day] of [['America/Santiago', '2026-09-06'], ['Asia/Beirut', '2026-03-29'], ['Africa/Cairo', '2026-04-24']]) {
    check(`all-day on ${day} in ${tz} (no 00:00 that day) starts on that day`, () => {
      for (const startTime of [undefined, '00:00']) {
        const { event } = create({ startDate: day, endDate: day, startTime, allDay: true }, tz);
        assert(!!event, 'no event');
        assert(at(event.startTime, tz) === `${day} 01:00` && at(event.endTime, tz) === `${day} 23:59`, `startTime ${startTime}: ${at(event.startTime, tz)}..${at(event.endTime, tz)}`);
        const unified = unify(event.startTime, event.endTime, tz);
        assert(unified.start === day, `native date ${unified.start}`);
      }
    });
  }

  check('the correction path builds the same all-day start', () => {
    const { start, end } = buildEventTimes('2026-09-06', '00:00', undefined, undefined, true, 'America/Santiago');
    assert(at(start, 'America/Santiago') === '2026-09-06 01:00' && at(end, 'America/Santiago') === '2026-09-06 23:59', `${at(start, 'America/Santiago')}..${at(end, 'America/Santiago')}`);
  });

  // The same event on a Google calendar: its dates are taken on the user's clock, not the
  // server's, which put it a day early everywhere east of UTC.
  await checkAsync('Google all-day Tuesday in Israel is created on Tuesday, a three-day trip on its three days', async () => {
    const tuesday = create({ startDate: '2026-10-13', allDay: true }, IL).event!;
    assert(await createGoogle(tuesday.startTime, tuesday.endTime, IL) === '2026-10-13..2026-10-14', `Tuesday: ${lastSentToGoogle()}`);
    const trip = create({ startDate: '2026-10-13', endDate: '2026-10-15', allDay: true }, IL).event!;
    assert(await createGoogle(trip.startTime, trip.endTime, IL) === '2026-10-13..2026-10-16', `trip: ${lastSentToGoogle()}`);
    const corrected = buildEventTimes('2026-10-13', undefined, undefined, undefined, true, IL);
    assert(await createGoogle(corrected.start, corrected.end, IL) === '2026-10-13..2026-10-14', `correction: ${lastSentToGoogle()}`);
  });

  await checkAsync('Google all-day in New York is created on its date too', async () => {
    const thursday = create({ startDate: '2026-10-15', allDay: true }, NY).event!;
    assert(await createGoogle(thursday.startTime, thursday.endTime, NY) === '2026-10-15..2026-10-16', `got ${lastSentToGoogle()}`);
  });

  check('an ordinary all-day event and a timed event are unchanged', () => {
    const allDay = create({ startDate: '2026-10-13', endDate: '2026-10-15', allDay: true }, IL).event;
    assert(!!allDay && at(allDay.startTime, IL) === '2026-10-13 00:00' && at(allDay.endTime, IL) === '2026-10-15 23:59', `all-day ${at(allDay?.startTime, IL)}..${at(allDay?.endTime, IL)}`);
    const timed = create({ startDate: '2026-10-13', startTime: '15:00', endDate: '2026-10-13', endTime: '16:00', allDay: false }, IL).event;
    assert(!!timed && at(timed.startTime, IL) === '2026-10-13 15:00' && at(timed.endTime, IL) === '2026-10-13 16:00', `timed ${at(timed?.startTime, IL)}..${at(timed?.endTime, IL)}`);
  });

  await checkAsync('a photo "Camp Oct 20-22, pickup 11:00" keeps its last day, on both calendars and in a correction', async () => {
    const camp = create({ startDate: '2026-10-20', startTime: '08:00', endDate: '2026-10-22', endTime: '11:00', allDay: true }, IL).event!;
    assert(at(camp.startTime, IL) === '2026-10-20 00:00' && at(camp.endTime, IL) === '2026-10-22 23:59', `${at(camp.startTime, IL)}..${at(camp.endTime, IL)}`);
    const native = unify(camp.startTime, camp.endTime, IL);
    assert(`${native.start}..${native.end}` === '2026-10-20..2026-10-23', `native ${native.start}..${native.end}`);
    assert(await createGoogle(camp.startTime, camp.endTime, IL) === '2026-10-20..2026-10-23', `Google ${lastSentToGoogle()}`);
    const corrected = buildEventTimes('2026-10-20', '08:00', '2026-10-22', '11:00', true, IL);
    assert(at(corrected.end, IL) === '2026-10-22 23:59', `correction ${at(corrected.end, IL)}`);
  });

  check('an unreadable all-day date is reported, not thrown', () => {
    const result = create({ startDate: 'next Friday', allDay: true }, IL);
    assert(!result.event && result.error === 'Invalid date/time parsed', `got ${result.error}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
