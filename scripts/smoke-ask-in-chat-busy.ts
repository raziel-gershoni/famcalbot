// Smoke test for the busy times of a guest answer (src/services/ask-in-chat/busy.ts; spec
// docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §5.2-5.3, rulings 4 and 12):
//   - busyIntervals: an all-day and a multi-day event make the whole day busy; a timed event is clipped to the day;
//     Thursday 22:00-02:00 counts on Friday (the reader's events, not the summary's shaping); reminders, Google
//     birthdays, a calendar labelled birthdays and a Google holiday calendar never count; overlapping and touching
//     intervals merge; an event with no length is an instant;
//   - judgeWindow: a day, a part of the day, the hour from a time ("20:00" catches 19:00-21:00 and 20:30-22:00) and a
//     range, each free, busy throughout or busy in part; night ends at the next day's start;
//   - summer and winter time in Asia/Jerusalem (2026-03-27 has 23 hours, 2026-10-25 has 25) and a New York caller;
//   - readBusyDays: one read through the summaries' reader on the summary's calendars, from the first day's start to
//     the last instant of the last day, on demand; each person (spec 2026-11-08-ask-in-chat-people §3) gets the events
//     of their own calendars only, named in the answer's language; the Google gap is passed on;
//   - the same results whatever zone the server runs in: the file re-runs itself under UTC, Asia/Jerusalem and
//     America/New_York.
// Pure: the reader and the calendar list are fakes. No network, no database.
//
//   npx tsx scripts/smoke-ask-in-chat-busy.ts

import { spawn } from 'node:child_process';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { DigestEvents, DigestRead } from '../src/services/calendar-read/digest';
import { busyIntervals, judgeWindow, readBusyDays, windowOf, type Interval } from '../src/services/ask-in-chat/busy';

const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ASK_BUSY_SMOKE_CHILD';

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      zone =>
        new Promise<{ zone: string; code: number; text: string }>(resolve => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', chunk => (text += chunk));
          child.stderr.on('data', chunk => (text += chunk));
          child.on('close', code => resolve({ zone, code: code ?? 1, text }));
        })
    )
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

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
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const ms = (iso: string) => Date.parse(iso);
const ev = (start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  summary: 'SECRET-TITLE', start, end, calendarName: 'Mine', calendarId: 'native:mine', ...extra,
});
const iv = (start: string, end: string, startsBefore = false, endsAfter = false): Interval => ({ start: ms(start), end: ms(end), startsBefore, endsAfter });
const ASSIGNMENTS: CalendarAssignment[] = [
  { calendarId: 'native:mine', labels: ['primary', 'yours'], name: 'Mine', color: '#000' },
  { calendarId: 'native:partner', labels: ['spouse'], name: 'Partner', color: '#111' },
  { calendarId: 'bday@group.calendar.google.com', labels: ['birthdays'], name: 'Birthdays', color: '#222' },
];

async function main() {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  const FRI = '2026-11-13';

  await check('an all-day event covering the day is the whole day; a multi-day one starts before and ends after it', () => {
    const one = busyIntervals([ev(FRI, '2026-11-14')], FRI, IL, ASSIGNMENTS);
    assert(show(one) === show([iv('2026-11-12T22:00:00Z', '2026-11-13T22:00:00Z')]), show(one));
    const multi = busyIntervals([ev('2026-11-12', '2026-11-15')], FRI, IL, ASSIGNMENTS);
    assert(show(multi) === show([iv('2026-11-12T22:00:00Z', '2026-11-13T22:00:00Z', true, true)]), show(multi));
    assert(busyIntervals([ev('2026-11-14', '2026-11-15')], FRI, IL, ASSIGNMENTS).length === 0, 'the next day\'s all-day event');
    assert(busyIntervals([ev(FRI, '')], FRI, IL, ASSIGNMENTS).length === 1, 'an all-day event with no end is one day');
  });

  await check('a timed event is clipped to the day; Thursday 22:00-02:00 makes Friday busy until 02:00 and Thursday from 22:00', () => {
    const night = ev('2026-11-12T22:00:00+02:00', '2026-11-13T02:00:00+02:00');
    assert(show(busyIntervals([night], FRI, IL, ASSIGNMENTS)) === show([iv('2026-11-12T22:00:00Z', '2026-11-13T00:00:00Z', true, false)]), 'Friday');
    assert(show(busyIntervals([night], '2026-11-12', IL, ASSIGNMENTS)) === show([iv('2026-11-12T20:00:00Z', '2026-11-12T22:00:00Z', false, true)]), 'Thursday');
    assert(busyIntervals([ev('2026-11-13T22:00:00Z', '2026-11-13T23:00:00Z')], FRI, IL, ASSIGNMENTS).length === 0, 'an event that starts at the day\'s end');
  });

  await check('reminders, Google birthdays, a calendar labelled birthdays and a Google holiday calendar never count; a partner\'s calendar does', () => {
    const events = [
      ev('2026-11-13T09:00:00+02:00', '2026-11-13T09:00:00+02:00', { eventType: 'reminder' }),
      ev(FRI, '2026-11-14', { eventType: 'birthday' }),
      ev(FRI, '2026-11-14', { calendarId: 'bday@group.calendar.google.com' }),
      ev(FRI, '2026-11-14', { calendarId: 'en.jewish#holiday@group.v.calendar.google.com' }),
      ev('2026-11-13T19:00:00+02:00', '2026-11-13T21:00:00+02:00', { calendarId: 'native:partner' }),
    ];
    assert(show(busyIntervals(events, FRI, IL, ASSIGNMENTS)) === show([iv('2026-11-13T17:00:00Z', '2026-11-13T19:00:00Z')]), show(busyIntervals(events, FRI, IL, ASSIGNMENTS)));
  });

  await check('overlapping and touching intervals merge, in time order; a gap keeps them apart', () => {
    const events = [
      ev('2026-11-13T19:00:00+02:00', '2026-11-13T21:00:00+02:00'),
      ev('2026-11-13T10:30:00+02:00', '2026-11-13T11:30:00+02:00'),
      ev('2026-11-13T10:00:00+02:00', '2026-11-13T11:00:00+02:00'),
      ev('2026-11-13T11:30:00+02:00', '2026-11-13T12:00:00+02:00'),
    ];
    assert(show(busyIntervals(events, FRI, IL, ASSIGNMENTS)) === show([iv('2026-11-13T08:00:00Z', '2026-11-13T10:00:00Z'), iv('2026-11-13T17:00:00Z', '2026-11-13T19:00:00Z')]), show(busyIntervals(events, FRI, IL, ASSIGNMENTS)));
  });

  await check('an event with no length is an instant on its day; one at the day\'s end belongs to the next day', () => {
    assert(show(busyIntervals([ev('2026-11-13T20:15:00+02:00', '2026-11-13T20:15:00+02:00')], FRI, IL, ASSIGNMENTS)) === show([iv('2026-11-13T18:15:00Z', '2026-11-13T18:15:00Z')]), 'instant');
    assert(busyIntervals([ev('2026-11-13T22:00:00Z', '2026-11-13T22:00:00Z')], FRI, IL, ASSIGNMENTS).length === 0, 'midnight instant');
  });

  await check('judgeWindow: "20:00" asks 20:00-21:00 and catches 19:00-21:00 (throughout) and 20:30-22:00 (in part), each shown whole', () => {
    const a = judgeWindow({ kind: 'at', time: '20:00' }, FRI, [iv('2026-11-13T17:00:00Z', '2026-11-13T19:00:00Z')], IL);
    assert(a.verdict === 'busyAll' && a.shown.length === 1, show(a));
    const b = judgeWindow({ kind: 'at', time: '20:00' }, FRI, [iv('2026-11-13T18:30:00Z', '2026-11-13T20:00:00Z')], IL);
    assert(b.verdict === 'busySome' && b.shown[0].end === ms('2026-11-13T20:00:00Z'), show(b));
    const c = judgeWindow({ kind: 'at', time: '20:00' }, FRI, [iv('2026-11-13T08:00:00Z', '2026-11-13T10:00:00Z')], IL);
    assert(c.verdict === 'free' && c.shown.length === 0, show(c));
    const edge = judgeWindow({ kind: 'at', time: '20:00' }, FRI, [iv('2026-11-13T19:00:00Z', '2026-11-13T20:00:00Z')], IL);
    assert(edge.verdict === 'free', 'an event that starts as the hour ends');
  });

  await check('judgeWindow: a day, a part of the day and a range', () => {
    const busy = [iv('2026-11-13T08:00:00Z', '2026-11-13T09:30:00Z'), iv('2026-11-13T17:00:00Z', '2026-11-13T19:00:00Z')];
    assert(judgeWindow({ kind: 'day' }, FRI, busy, IL).verdict === 'busySome' && judgeWindow({ kind: 'day' }, FRI, busy, IL).shown.length === 2, 'day');
    assert(judgeWindow({ kind: 'day' }, FRI, [], IL).verdict === 'free', 'free day');
    assert(judgeWindow({ kind: 'day' }, FRI, [iv('2026-11-12T22:00:00Z', '2026-11-13T22:00:00Z')], IL).verdict === 'busyAll', 'all day');
    const evening = judgeWindow({ kind: 'part', part: 'evening' }, FRI, busy, IL);
    assert(evening.verdict === 'busySome' && evening.shown.length === 1 && evening.shown[0].start === ms('2026-11-13T17:00:00Z'), show(evening));
    assert(judgeWindow({ kind: 'part', part: 'morning' }, FRI, busy, IL).verdict === 'busySome', 'morning');
    assert(judgeWindow({ kind: 'part', part: 'afternoon' }, FRI, busy, IL).verdict === 'free', 'afternoon');
    assert(judgeWindow({ kind: 'between', from: '19:00', to: '21:00' }, FRI, busy, IL).verdict === 'busyAll', 'range covered');
    assert(judgeWindow({ kind: 'between', from: '18:00', to: '20:00' }, FRI, busy, IL).verdict === 'busySome', 'range in part');
  });

  await check('windowOf: night and a range to 24:00 end at the next day\'s start; the hour from 23:30 stops at the day\'s end', () => {
    assert(show(windowOf({ kind: 'part', part: 'night' }, FRI, IL)) === show({ start: ms('2026-11-13T20:00:00Z'), end: ms('2026-11-13T22:00:00Z') }), 'night');
    assert(windowOf({ kind: 'between', from: '22:00', to: '24:00' }, FRI, IL).end === ms('2026-11-13T22:00:00Z'), 'to 24:00');
    assert(windowOf({ kind: 'at', time: '23:30' }, FRI, IL).end === ms('2026-11-13T22:00:00Z'), '23:30');
  });

  await check('summer time: Jerusalem\'s 2026-03-27 has 23 hours, and a time in the skipped hour moves forward by the jump', () => {
    const day = busyIntervals([ev('2026-03-27', '2026-03-28')], '2026-03-27', IL, ASSIGNMENTS)[0];
    assert(day.end - day.start === 23 * 3_600_000, `${(day.end - day.start) / 3_600_000} h`);
    const w = windowOf({ kind: 'at', time: '02:30' }, '2026-03-27', IL);
    assert(w.start === ms('2026-03-27T00:30:00Z') && w.end === ms('2026-03-27T01:30:00Z'), show(w));
  });

  await check('winter time: Jerusalem\'s 2026-10-25 has 25 hours, and 01:30 is its first occurrence', () => {
    const day = busyIntervals([ev('2026-10-25', '2026-10-26')], '2026-10-25', IL, ASSIGNMENTS)[0];
    assert(day.end - day.start === 25 * 3_600_000, `${(day.end - day.start) / 3_600_000} h`);
    assert(windowOf({ kind: 'at', time: '01:30' }, '2026-10-25', IL).start === ms('2026-10-24T22:30:00Z'), 'first 01:30');
  });

  await check('a New York caller: the day is New York\'s, and an evening event there is in its evening', () => {
    const nyDay = busyIntervals([ev(FRI, '2026-11-14')], FRI, NY, ASSIGNMENTS)[0];
    assert(nyDay.start === ms('2026-11-13T05:00:00Z') && nyDay.end === ms('2026-11-14T05:00:00Z'), show(nyDay));
    const evening = busyIntervals([ev('2026-11-13T19:00:00-05:00', '2026-11-13T21:00:00-05:00')], FRI, NY, ASSIGNMENTS);
    assert(judgeWindow({ kind: 'part', part: 'evening' }, FRI, evening, NY).verdict === 'busySome', 'evening');
    assert(busyIntervals([ev('2026-11-13T19:00:00-05:00', '2026-11-13T21:00:00-05:00')], FRI, IL, ASSIGNMENTS).length === 0, 'the same event is Saturday in Jerusalem');
  });

  await check('readBusyDays: one read on the summary\'s calendars from the first day\'s start to the last instant of the last day, on demand; each person gets their own calendars\' events; the Google gap is kept', async () => {
    const calls: Array<{ start: string; end: string; tz: string; ids: readonly string[]; read: DigestRead; userId: number }> = [];
    const DEFAULT_ON_DEMAND_READ: DigestRead = { mode: 'onDemand', deadlineMs: 10_000 };
    const user = { id: 7, telegramId: 4001, name: 'Raziel Gershoni', englishName: 'Raziel', pairingId: 'pair-1' } as unknown as UserConfig;
    const result = await readBusyDays(user, [FRI, '2026-11-14'], IL, 'en', {
      calendarsOf: async u => { assert(u === user, 'the caller\'s own account'); return { assignments: ASSIGNMENTS, partnerOwned: new Set(['native:partner']) }; },
      partnerOf: async u => { assert(u === user, 'the caller\'s partner'); return { name: 'Dana Levi', englishName: 'Dana' }; },
      reader: {
        DEFAULT_ON_DEMAND_READ,
        readLookaheadEvents: async (u, start, end, tz, ids, read) => {
          calls.push({ start: start.toISOString(), end: end.toISOString(), tz, ids, read, userId: u.id });
          const events: DigestEvents = [
            ev('2026-11-13T19:00:00+02:00', '2026-11-13T21:00:00+02:00'),
            ev('2026-11-13T10:00:00+02:00', '2026-11-13T11:00:00+02:00', { calendarId: 'native:partner' }),
          ];
          events.googleGap = 'token';
          return events;
        },
      },
    });
    assert(calls.length === 1, `${calls.length} reads`);
    assert(calls[0].start === '2026-11-12T22:00:00.000Z' && calls[0].end === '2026-11-14T21:59:59.999Z', show(calls[0]));
    assert(show(calls[0].ids) === show(ASSIGNMENTS.map(a => a.calendarId)) && calls[0].read === DEFAULT_ON_DEMAND_READ && calls[0].userId === 7, show(calls[0]));
    assert(show(result.people.map(p => [p.key, p.name, p.calendarIds])) === show([['me', 'Raziel', ['native:mine']], ['partner', 'Dana', ['native:partner']]]), show(result.people));
    assert(result.googleGap === 'token' && result.days.length === 2, show(result));
    const [fri, sat] = result.days;
    assert(show(fri.people.map(p => [p.person.key, p.intervals])) === show([
      ['me', [iv('2026-11-13T17:00:00Z', '2026-11-13T19:00:00Z')]],
      ['partner', [iv('2026-11-13T08:00:00Z', '2026-11-13T09:00:00Z')]],
    ]), show(fri));
    assert(sat.day === '2026-11-14' && sat.people.every(p => p.intervals.length === 0), show(sat));
  });

  await check('readBusyDays: a reader failure is thrown as it is (the handler words it)', async () => {
    const boom = new Error('GOOGLE_FETCH_FAILED');
    let thrown: unknown;
    try {
      await readBusyDays({ id: 7 } as unknown as UserConfig, [FRI], IL, 'en', {
        calendarsOf: async () => ({ assignments: ASSIGNMENTS, partnerOwned: new Set() }),
        partnerOf: async () => null,
        reader: { DEFAULT_ON_DEMAND_READ: { mode: 'onDemand', deadlineMs: 10_000 }, readLookaheadEvents: async () => { throw boom; } },
      });
    } catch (error) {
      thrown = error;
    }
    assert(thrown === boom, String(thrown));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') {
  void runChildren();
} else {
  main().catch(err => {
    console.error('smoke crashed:', err);
    process.exit(1);
  });
}
