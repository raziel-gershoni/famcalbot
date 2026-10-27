// Smoke test for summer/winter time (DST) in the code that turns a local wall time into an
// instant and back: the one resolver (src/utils/wall-time.ts, re-exported by
// calendar-write/walltime.ts) and every path that uses it, so a reminder, event, alert or
// summary never moves off its local wall time, whatever zone the server process runs in.
//
// The rule it pins: a wall time the clocks skip (02:30 on the night Israel springs forward) moves
// forward by the jump (03:30); a wall time they repeat (01:30 on the night it falls back) is the
// FIRST occurrence; editing an item without touching its time never moves it.
//
// The real functions run; only the database, Redis and the other services are stand-ins, and the
// expected values come from an independent reader of the zone's clock (scripts/lib/dst-harness.ts),
// never from the code under test. No network, no database.
//
// Process zone: this file re-runs itself once per server zone (UTC, Asia/Jerusalem, America/New_York)
// as child processes, so `bash scripts/ci-smokes.sh` and a plain `npx tsx scripts/smoke-dst.ts` both
// cover all three; nothing here may depend on the one the process happens to have.
//   npx tsx scripts/smoke-dst.ts

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  RealDate, assert, assertSame, check, fakeOver, installClock, iso, localReading, results, scannedInstant, setClock, show, stubModules, wallOf,
} from './lib/dst-harness';

const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'DST_SMOKE_CHILD';

// ---- The parent: one child per process zone ----

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      zone =>
        new Promise<{ zone: string; code: number; text: string }>(resolve => {
          // process.execArgv carries tsx's loader flags, so the child compiles TypeScript the same way.
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

// ---- The checks, in one process zone ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const LONDON = 'Europe/London';
const MOSCOW = 'Europe/Moscow';
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function runChecks(): Promise<void> {
  process.env.TELEGRAM_BOT_TOKEN ||= 'test';
  process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
  installClock();
  const updates: Array<Record<string, unknown>> = [];
  // The store and the item loader, as updateItem sees them. Nothing else of the write path is faked.
  let loaded: unknown = null;
  // The one Google event the item reader returns, and what the provider is asked to write.
  let googleEvent: Record<string, unknown> | null = null;
  const googleUpdates: Array<Record<string, unknown>> = [];
  stubModules({
    [`${SRC}/utils/prisma.ts`]: { prisma: {} },
    // The summaries' prompt builder pulls in an ES-only hebcal build that a CommonJS run cannot load; none of these checks reach it.
    [`${SRC}/services/claude.ts`]: {},
    [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => undefined },
    [`${SRC}/services/native-calendar/event-store.ts`]: (real: Record<string, unknown>) =>
      fakeOver(real, {
        getPartnerUserId: async () => null,
        updateNativeEvent: async (input: Record<string, unknown>) => {
          updates.push(input);
          return { key: { seriesId: 'series-1', slot: null }, clearedPings: [], changedPings: [], reassignedPings: [] };
        },
      }),
    [`${SRC}/services/calendar-write/item-info.ts`]: (real: Record<string, unknown>) => fakeOver(real, { loadItem: async () => loaded }),
    [`${SRC}/services/calendar-read/google.ts`]: (real: Record<string, unknown>) =>
      fakeOver(real, { googleCalendarSet: () => [{ calendarId: 'g1', name: 'G', labels: [], color: '#000000' }] }),
    [`${SRC}/services/calendar.ts`]: (real: Record<string, unknown>) =>
      fakeOver(real, { readEventForEdit: async () => ({ accessRole: 'owner', event: googleEvent, first: true }) }),
    [`${SRC}/services/calendar-provider/google-provider.ts`]: (real: Record<string, unknown>) =>
      fakeOver(real, {
        googleProvider: new Proxy(real.googleProvider as object, {
          get: (target, key) =>
            key === 'updateEvent'
              ? async (_user: unknown, _calendar: string, _event: string, data: Record<string, unknown>) => {
                  googleUpdates.push(data);
                  return { success: true, eventId: 'g-event' };
                }
              : Reflect.get(target, key),
        }),
      }),
  });

  const { wallTimeToInstant, instantToWallTime } = await import('../src/utils/wall-time');
  const walltime = await import('../src/services/calendar-write/walltime');
  const due = await import('../src/services/native-reminders/due');
  const rec = await import('../src/services/native-calendar/recurrence');
  const write = await import('../src/services/calendar-write/write');

  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);

  // ---- The resolver ----

  // wall, zone, the instant it must be (Z). The comment says which rule each row pins.
  const TABLE: Array<[string, string, string]> = [
    // Israel springs forward 2026-03-27 02:00 -> 03:00: the skipped hour moves forward by the jump.
    ['2026-03-27T01:59', IL, '2026-03-26T23:59:00Z'],
    ['2026-03-27T02:00', IL, '2026-03-27T00:00:00Z'],
    ['2026-03-27T02:30', IL, '2026-03-27T00:30:00Z'],
    ['2026-03-27T02:59', IL, '2026-03-27T00:59:00Z'],
    ['2026-03-27T03:00', IL, '2026-03-27T00:00:00Z'],
    // Israel falls back 2026-10-25 02:00 -> 01:00: the repeated hour is the first (summer) one.
    ['2026-10-25T00:59', IL, '2026-10-24T21:59:00Z'],
    ['2026-10-25T01:00', IL, '2026-10-24T22:00:00Z'],
    ['2026-10-25T01:30', IL, '2026-10-24T22:30:00Z'],
    ['2026-10-25T01:59', IL, '2026-10-24T22:59:00Z'],
    ['2026-10-25T02:00', IL, '2026-10-25T00:00:00Z'],
    // New York: 2026-03-08 02:00 -> 03:00, 2026-11-01 02:00 -> 01:00.
    ['2026-03-08T01:59', NY, '2026-03-08T06:59:00Z'],
    ['2026-03-08T02:30', NY, '2026-03-08T07:30:00Z'],
    ['2026-03-08T03:00', NY, '2026-03-08T07:00:00Z'],
    ['2026-11-01T00:30', NY, '2026-11-01T04:30:00Z'],
    ['2026-11-01T01:30', NY, '2026-11-01T05:30:00Z'],
    ['2026-11-01T02:00', NY, '2026-11-01T07:00:00Z'],
    // London: 2026-03-29 01:00 -> 02:00, 2026-10-25 02:00 -> 01:00.
    ['2026-03-29T00:59', LONDON, '2026-03-29T00:59:00Z'],
    ['2026-03-29T01:30', LONDON, '2026-03-29T01:30:00Z'],
    ['2026-03-29T02:00', LONDON, '2026-03-29T01:00:00Z'],
    ['2026-10-25T01:30', LONDON, '2026-10-25T00:30:00Z'],
    ['2026-10-25T02:00', LONDON, '2026-10-25T02:00:00Z'],
    // Southern hemisphere, and a clock that moves by half an hour.
    ['2026-10-04T02:30', 'Australia/Sydney', '2026-10-03T16:30:00Z'],
    ['2026-04-05T02:30', 'Australia/Sydney', '2026-04-04T15:30:00Z'],
    ['2026-10-04T02:15', 'Australia/Lord_Howe', '2026-10-03T15:45:00Z'],
    // A day that starts in the gap: its first moment is 01:00.
    ['2026-09-06T00:00', 'America/Santiago', '2026-09-06T04:00:00Z'],
    // A day whose midnight happens twice.
    ['2026-11-01T00:00', 'America/Havana', '2026-11-01T04:00:00Z'],
    // No clock change: Moscow, UTC, an ordinary Israeli noon, either side of a change.
    ['2026-10-25T12:00', MOSCOW, '2026-10-25T09:00:00Z'],
    ['2026-06-01T12:00', 'UTC', '2026-06-01T12:00:00Z'],
    ['2026-03-26T12:00', IL, '2026-03-26T10:00:00Z'],
    ['2026-03-28T12:00', IL, '2026-03-28T09:00:00Z'],
    ['2026-10-24T12:00', IL, '2026-10-24T09:00:00Z'],
    ['2026-10-26T12:00', IL, '2026-10-26T10:00:00Z'],
  ];

  await check('the resolver: a skipped time moves forward by the jump, a repeated one is the first, any other is exact (IL, NY, London, Sydney, Lord Howe, Santiago, Havana, Moscow, UTC)', () => {
    for (const [wall, zone, want] of TABLE) {
      const got = wallTimeToInstant(wall, zone);
      assert(got.toISOString() === iso(want).toISOString(), `${wall} in ${zone}: got ${got.toISOString()}, want ${iso(want).toISOString()}`);
    }
  });

  await check('the resolver agrees with a scan of the zone\'s clock on every quarter hour of every change day of 2026 and the days around it (12 zones)', () => {
    const zones = [IL, NY, LONDON, MOSCOW, 'UTC', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/Santiago', 'America/Havana', 'Asia/Kathmandu', 'Pacific/Chatham', 'America/St_Johns'];
    let compared = 0;
    for (const zone of zones) {
      // The days of 2026 on which the offset at the day's start differs from the next day's.
      const days: string[] = [];
      for (let t = RealDate.UTC(2026, 0, 1); t < RealDate.UTC(2027, 0, 1); t += 86_400_000) {
        const offset = (ms: number) => localReading(ms, zone) - ms;
        if (offset(t) !== offset(t + 86_400_000) || offset(t - 3_600_000) !== offset(t + 3_600_000)) days.push(new RealDate(t).toISOString().slice(0, 10));
      }
      // Plus an ordinary day in each season.
      for (const day of [...days, '2026-02-10', '2026-07-15']) {
        for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
          const wall = `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
          const got = wallTimeToInstant(wall, zone).getTime();
          const want = scannedInstant(wall, zone);
          assert(got === want, `${wall} in ${zone}: got ${new RealDate(got).toISOString()}, scan found ${new RealDate(want).toISOString()}`);
          compared++;
        }
      }
    }
    assert(compared > 4000, `only ${compared} wall times compared`);
  });

  await check('the resolver reads every shape callers send and refuses the rest with an Invalid Date, as date-fns-tz did', () => {
    const t = (wall: string) => wallTimeToInstant(wall, IL).getTime();
    assert(t('2026-06-01 12:00:00') === t('2026-06-01T12:00'), 'a space for the T, and the seconds');
    assert(wallTimeToInstant('2026-06-01T12:00:00.250', 'UTC').getTime() === iso('2026-06-01T12:00:00.250Z').getTime(), 'milliseconds');
    assert(wallTimeToInstant('2026-06-01T24:00', 'UTC').getTime() === iso('2026-06-01T00:00:00Z').getTime(), '24:00 reads as the day\'s own 00:00, as before');
    for (const bad of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-06-01T10:60', '2026-06-01T25:00', '2026-06-01Tundefined:00', '2026-06-01T9:30', '2026-06-01', '2026-06-01T10:00Z', 'garbage', '']) {
      assert(Number.isNaN(t(bad)), `${show(bad)} gave a date`);
    }
    assert(Number.isNaN(wallTimeToInstant('2026-06-01T12:00', 'Not/AZone').getTime()), 'an unknown zone gave a date');
    assert(wallTimeToInstant('2024-02-29T12:00', 'UTC').getTime() === iso('2024-02-29T12:00:00Z').getTime(), 'a leap day');
    assert(Number.isNaN(wallTimeToInstant('2026-02-29T12:00', 'UTC').getTime()), 'a day that is not a leap day');
  });

  await check('instantToWall reads the zone\'s clock whatever the process zone, including an hour the process zone skips', () => {
    // 02:30Z on the day Israel springs forward is 02:30 in London-less UTC: a process in Israel must not read it as 03:30.
    assertSame(walltime.instantToWall(iso('2026-03-27T02:30:00Z'), 'UTC'), '2026-03-27T02:30', 'UTC reading of 02:30Z');
    assertSame(walltime.instantToWall(iso('2026-03-08T07:30:00Z'), 'UTC'), '2026-03-08T07:30', 'UTC reading of 07:30Z on the New York gap day');
    assertSame(instantToWallTime(iso('2026-03-27T00:30:00Z'), IL), '2026-03-27T03:30:00', 'the jump day in Israel');
    assertSame(walltime.instantToWall(iso('2026-10-24T22:30:00Z'), IL), '2026-10-25T01:30', 'first 01:30');
    assertSame(walltime.instantToWall(iso('2026-10-24T23:30:00Z'), IL), '2026-10-25T01:30', 'second 01:30');
  });

  await check('walltime.ts exports the one resolver, and wallToInstant and dayEnd go through it', () => {
    assert(walltime.wallTimeToInstant === wallTimeToInstant, 'walltime.ts re-exports a different function');
    assertSame(walltime.wallToInstant('2026-03-27T02:30', IL).toISOString(), '2026-03-27T00:30:00.000Z', 'wallToInstant in the gap');
    assertSame(walltime.wallToInstant('2026-10-25T01:30', IL).toISOString(), '2026-10-24T22:30:00.000Z', 'wallToInstant, repeated');
    assertSame(walltime.dayEnd('2026-03-27', IL).toISOString(), '2026-03-27T20:59:00.000Z', 'dayEnd: 23:59 local on a jump day (UTC+3)');
    assertSame(walltime.dayEnd('2026-10-25', IL).toISOString(), '2026-10-25T21:59:00.000Z', 'dayEnd: 23:59 local on a fall-back day (UTC+2)');
  });

  // ---- Reminders: when a date-only reminder pings, and Tomorrow ----

  await check('a date-only reminder pings at the reminder time, moved forward when that time is skipped (Israel 2026-03-27 02:00/02:30/02:45; New York 2026-03-08 02:30)', () => {
    const at = (start: string, tz: string, time: string) => due.reminderDueAt({ start }, tz, time).toISOString();
    assertSame(at('2026-03-27', IL, '02:00'), '2026-03-27T00:00:00.000Z', 'IL 02:00');
    assertSame(at('2026-03-27', IL, '02:30'), '2026-03-27T00:30:00.000Z', 'IL 02:30');
    assertSame(at('2026-03-27', IL, '02:45'), '2026-03-27T00:45:00.000Z', 'IL 02:45');
    assertSame(at('2026-03-27', IL, '09:00'), '2026-03-27T06:00:00.000Z', 'IL 09:00 stays 09:00 local');
    assertSame(at('2026-03-08', NY, '02:30'), '2026-03-08T07:30:00.000Z', 'NY 02:30');
    assertSame(at('2026-03-26', IL, '02:30'), '2026-03-26T00:30:00.000Z', 'the day before is untouched');
  });

  await check('a date-only reminder at a repeated time pings once, at the first occurrence (Israel 2026-10-25 01:30)', () => {
    assertSame(due.reminderDueAt({ start: '2026-10-25' }, IL, '01:30').toISOString(), '2026-10-24T22:30:00.000Z', 'first 01:30');
    const occ = { startsAt: iso('2026-10-24T21:00:00Z'), allDay: true, timeZone: IL };
    assertSame(due.dueAtForOccurrence(occ, IL, '01:30').toISOString(), '2026-10-24T22:30:00.000Z', 'the occurrence of that date');
    assertSame(due.dueAtForOccurrence(occ, IL, '09:00').toISOString(), '2026-10-25T07:00:00.000Z', '09:00 after the change is UTC+2');
  });

  await check('a date-only occurrence of an event in another zone pings at the recipient\'s time of that date (event in Israel on the jump day, recipient in New York)', () => {
    const occ = { startsAt: iso('2026-03-26T22:00:00Z'), allDay: true, timeZone: IL };
    assertSame(due.dueAtForOccurrence(occ, NY, '02:30').toISOString(), '2026-03-27T06:30:00.000Z', 'NY on 2026-03-27 is already summer time (UTC-4)');
    assertSame(due.dueAtForOccurrence(occ, IL, '02:30').toISOString(), '2026-03-27T00:30:00.000Z', 'Israel');
  });

  await check('Tomorrow with a reminder time of 02:30 tapped at 01:50 on the jump day wakes that day at 03:30, not the next day', () => {
    const tapped = iso('2026-03-26T23:50:00Z'); // 01:50 in Israel
    assertSame(due.tomorrowMorning(tapped, IL, '02:30').toISOString(), '2026-03-27T00:30:00.000Z', 'this morning, moved forward');
    // Tapped at 03:10 (after the jump), 03:30 is still ahead: this morning's. At 03:40 it has gone by: tomorrow's, 02:30 in summer time.
    assertSame(due.tomorrowMorning(iso('2026-03-27T00:10:00Z'), IL, '02:30').toISOString(), '2026-03-27T00:30:00.000Z', 'tapped at 03:10');
    assertSame(due.tomorrowMorning(iso('2026-03-27T00:40:00Z'), IL, '02:30').toISOString(), '2026-03-27T23:30:00.000Z', 'tapped at 03:40');
  });

  await check('Tomorrow around the repeated hour: the first 01:30 is ahead at the first 01:10; at the second 01:10 it has passed and the next day\'s 01:30 is chosen', () => {
    assertSame(due.tomorrowMorning(iso('2026-10-24T22:10:00Z'), IL, '01:30').toISOString(), '2026-10-24T22:30:00.000Z', 'first 01:10');
    assertSame(due.tomorrowMorning(iso('2026-10-24T23:10:00Z'), IL, '01:30').toISOString(), '2026-10-25T23:30:00.000Z', 'second 01:10');
    assertSame(due.tomorrowMorning(iso('2026-10-24T23:10:00Z'), IL, '02:30').toISOString(), '2026-10-25T00:30:00.000Z', 'a reminder time after the change is still this morning');
  });

  await check('Tomorrow on an ordinary night is untouched: 22:00 on 2026-06-10 wakes at 09:00 the next day', () => {
    assertSame(due.tomorrowMorning(iso('2026-06-10T19:00:00Z'), IL, '09:00').toISOString(), '2026-06-11T06:00:00.000Z', 'ordinary');
  });

  // ---- Series: a repeat keeps its local wall time across both changes ----

  const series = (startsAt: Date, endsAt: Date, o: Record<string, unknown> = {}) =>
    ({
      id: 's-1', calendarId: 'c-1', creatorUserId: 1, title: 'T', description: null, location: null, startsAt, endsAt, allDay: false, timeZone: IL,
      rrule: 'FREQ=DAILY', hebrewRule: null, hebrewAnchor: null, exdates: [], ownAlerts: false, alertMinutes: [], kind: 'EVENT', forUserId: null,
      forBoth: false, armedAt: null, isDeleted: false, createdAt: startsAt, updatedAt: startsAt, ...o,
    }) as unknown as Parameters<typeof rec.expandSeries>[0];
  const expand = (s: Parameters<typeof rec.expandSeries>[0], from: string, to: string) => rec.expandSeries(s, { from: iso(from), to: iso(to) });

  await check('a weekly 18:00 series from 2026-03-01 reads 18:00 local on every occurrence across both 2026 changes, and its UTC time moves by the change', () => {
    const start = wallTimeToInstant('2026-03-01T18:00', IL);
    const instances = expand(series(start, new RealDate(start.getTime() + 3_600_000), { rrule: 'FREQ=WEEKLY' }), '2026-03-01T00:00:00Z', '2026-11-30T00:00:00Z');
    assert(instances.length >= 38, `only ${instances.length} occurrences`);
    const seen = new Set<string>();
    for (const i of instances) {
      assertSame(wallOf(i.startsAt, IL).slice(11), '18:00', `${i.startsAt.toISOString()} local time`);
      seen.add(i.startsAt.toISOString().slice(11, 16));
    }
    assertSame([...seen].sort(), ['15:00', '16:00'], 'the UTC times: 16:00 in winter time, 15:00 in summer time');
    const week = (iso0: string) => instances.find(i => i.startsAt.toISOString().startsWith(iso0));
    assert(week('2026-03-22') && week('2026-03-29'), 'the weeks around the jump (the 27th is a Friday; the series is on Sundays)');
    assertSame(week('2026-03-22')!.startsAt.toISOString(), '2026-03-22T16:00:00.000Z', 'Sunday before the jump');
    assertSame(week('2026-03-29')!.startsAt.toISOString(), '2026-03-29T15:00:00.000Z', 'Sunday after the jump');
    assertSame(week('2026-10-25')!.startsAt.toISOString(), '2026-10-25T16:00:00.000Z', 'the fall-back Sunday itself, 18:00 is after the change');
  });

  await check('a daily 02:30 series: the occurrence on the jump day is 03:30 local, the days either side stay 02:30, nothing is skipped or doubled', () => {
    const start = wallTimeToInstant('2026-03-20T02:30', IL);
    const instances = expand(series(start, new RealDate(start.getTime() + 30 * 60_000)), '2026-03-24T00:00:00Z', '2026-03-30T12:00:00Z');
    assertSame(instances.map(i => wallOf(i.startsAt, IL)), [
      '2026-03-24 02:30', '2026-03-25 02:30', '2026-03-26 02:30', '2026-03-27 03:30', '2026-03-28 02:30', '2026-03-29 02:30', '2026-03-30 02:30',
    ], 'local readings');
    assertSame(instances[3].startsAt.toISOString(), '2026-03-27T00:30:00.000Z', 'the jump day in UTC');
  });

  await check('a daily 01:30 series on the night Israel falls back: one occurrence, at the first 01:30, none skipped or doubled', () => {
    const start = wallTimeToInstant('2026-10-20T01:30', IL);
    const instances = expand(series(start, new RealDate(start.getTime() + 30 * 60_000)), '2026-10-22T12:00:00Z', '2026-10-27T12:00:00Z');
    assertSame(instances.map(i => wallOf(i.startsAt, IL)), ['2026-10-23 01:30', '2026-10-24 01:30', '2026-10-25 01:30', '2026-10-26 01:30', '2026-10-27 01:30'], 'local readings');
    assertSame(instances[2].startsAt.toISOString(), '2026-10-24T22:30:00.000Z', 'the first 01:30');
  });

  await check('a yearly Hebrew series at 02:30 whose day is the jump day (9 Nisan 5786 = 2026-03-27) lands at 03:30 that day', () => {
    const start = wallTimeToInstant('2025-04-07T02:30', IL); // 9 Nisan 5785
    const s = series(start, new RealDate(start.getTime() + 3_600_000), { rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2025-04-07' });
    const [second] = expand(s, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z');
    assertSame(wallOf(second.startsAt, IL), '2026-03-27 03:30', 'the 2026 slot');
  });

  await check('moving a series by days and times keeps the local wall time: shiftOnWall and the "All" move onto the jump day', () => {
    const from = wallTimeToInstant('2026-03-26T08:00', IL);
    const to = wallTimeToInstant('2026-03-27T08:00', IL);
    const instant = wallTimeToInstant('2026-03-26T02:30', IL);
    assertSame(wallOf(rec.shiftOnWall(instant, from, to, IL), IL), '2026-03-27 03:30', 'the same wall shift lands in the jump');
    // A daily series that starts on 2026-03-30, its occurrence of the 28th moved to 02:30 on the 25th: three days earlier, so the
    // new start day is the jump day, at the moved occurrence's time of day.
    const s = series(wallTimeToInstant('2026-03-30T10:00', IL), wallTimeToInstant('2026-03-30T11:00', IL));
    const moved = rec.seriesTimesFor(s as never, { slot: wallTimeToInstant('2026-03-28T10:00', IL), start: wallTimeToInstant('2026-03-28T10:00', IL) }, {
      startsAt: wallTimeToInstant('2026-03-25T02:30', IL), endsAt: wallTimeToInstant('2026-03-25T03:30', IL), allDay: false,
    });
    assertSame(wallOf(moved.startsAt, IL).slice(0, 10), '2026-03-27', 'the day it moved to');
    assertSame(wallOf(moved.startsAt, IL).slice(11), '03:30', 'on the jump day the resolved time is 03:30');
  });

  await check('a yearly extra date and a yearly slot map keep their local time into the jump day (2025-03-27 02:30 + 1 year)', () => {
    const slot = wallTimeToInstant('2025-03-27T02:30', IL);
    assertSame(wallOf(rec.yearlyExtraDateMap(IL, 1)(slot)!, IL), '2026-03-27 03:30', 'extra date');
    const yearly = (start: Date) => series(start, new RealDate(start.getTime() + 3_600_000), { rrule: 'FREQ=YEARLY' }) as never;
    const map = rec.yearlySlotMap(yearly(wallTimeToInstant('2025-03-27T02:30', IL)), yearly(wallTimeToInstant('2025-03-27T02:30', IL)), 1);
    assertSame(wallOf(map(slot)!, IL), '2026-03-27 03:30', 'slot map');
  });

  // ---- Creating and editing ----

  await check('a one-off created at 02:30 on the jump day is stored at 03:30; one at 01:30 on the fall-back day at the first 01:30', () => {
    const base = { kind: 'event', title: 't', location: '', description: '', allDay: false, repeat: 'none', forWho: 'me' } as const;
    const gap = write.createTimes({ ...base, start: '2026-03-27T02:30', end: '2026-03-27T04:00' }, IL);
    assertSame([gap.startsAt.toISOString(), gap.endsAt.toISOString()], ['2026-03-27T00:30:00.000Z', '2026-03-27T01:00:00.000Z'], 'jump day');
    const noEnd = write.createTimes({ ...base, start: '2026-03-27T02:30' }, IL);
    assertSame(noEnd.endsAt.toISOString(), '2026-03-27T01:30:00.000Z', 'the default hour is an hour of real time after the start');
    const repeated = write.createTimes({ ...base, start: '2026-10-25T01:30', end: '2026-10-25T02:30' }, IL);
    assertSame([repeated.startsAt.toISOString(), repeated.endsAt.toISOString()], ['2026-10-24T22:30:00.000Z', '2026-10-25T00:30:00.000Z'], 'fall-back day');
    const allDay = write.createTimes({ ...base, allDay: true, start: '2026-03-27', end: '2026-03-27' }, IL);
    assertSame([allDay.startsAt.toISOString(), allDay.endsAt.toISOString()], ['2026-03-26T22:00:00.000Z', '2026-03-27T20:59:00.000Z'], 'an all-day item');
  });

  const SECOND_0130 = iso('2026-10-24T23:30:00Z'); // 01:30 the second time, in Israel
  /** What updateItem hands the store for an edit of a one-off (by default the one that starts at the second 01:30 and lasts an hour). */
  async function editedOneOff(
    changes: Record<string, unknown>,
    times: { startsAt?: Date; endsAt?: Date; allDay?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    const startsAt = times.startsAt ?? SECOND_0130;
    const endsAt = times.endsAt ?? new RealDate(startsAt.getTime() + 3_600_000);
    const allDay = times.allDay ?? false;
    const occurrence = { title: 'Late', description: null, location: null, startsAt, endsAt, allDay };
    loaded = {
      status: 'ok', canEdit: true, canDelete: true, masked: false, access: 'owner', overrides: [], override: undefined, ctx: { partner: null },
      series: series(startsAt, endsAt, { rrule: null, allDay }),
      occurrence, calendar: { id: 'c-1', ownerUserId: 1, privacy: 'PRIVATE' },
    };
    updates.length = 0;
    const result = await write.updateItem({ id: 1, name: 'U' } as never, { key: { source: 'famcal', seriesCuid: 'series-1' }, scope: 'single', changes } as never, IL);
    assertSame(result, { status: 'ok', key: 'famcal|series-1' }, 'the edit result');
    assert(updates.length === 1, `${updates.length} store writes`);
    return updates[0];
  }

  await check('editing the end of an item that starts at the SECOND 01:30 keeps its start instant (the repeated hour is not resolved again)', async () => {
    const input = await editedOneOff({ end: '2026-10-25T03:00' });
    assertSame((input.startsAt as Date).toISOString(), SECOND_0130.toISOString(), 'startsAt');
    assertSame((input.endsAt as Date).toISOString(), '2026-10-25T01:00:00.000Z', 'endsAt: 03:00 local');
  });

  await check('editing the start of the same item moves the start (onto the repeated hour: the first) and keeps its exact length, even where the end reads the same wall time', async () => {
    const moved = await editedOneOff({ start: '2026-10-25T01:45' });
    assertSame((moved.startsAt as Date).toISOString(), '2026-10-24T22:45:00.000Z', 'a new start inside the repeated hour is the first 01:45');
    assertSame((moved.endsAt as Date).toISOString(), '2026-10-24T23:45:00.000Z', 'an hour later, which reads 01:45 again: the end is not refused and not shortened');
    const later = await editedOneOff({ start: '2026-10-25T05:00' });
    assertSame((later.startsAt as Date).toISOString(), '2026-10-25T03:00:00.000Z', 'a start after the change');
    assertSame((later.endsAt as Date).toISOString(), '2026-10-25T04:00:00.000Z', 'its end an hour on');
  });

  await check('moving the start of a two-hour item that begins before the change and ends in the repeated hour keeps its two hours', async () => {
    const input = await editedOneOff({ start: '2026-10-25T00:45' }, { startsAt: iso('2026-10-24T21:30:00Z'), endsAt: iso('2026-10-24T23:30:00Z') });
    assertSame([(input.startsAt as Date).toISOString(), (input.endsAt as Date).toISOString()], ['2026-10-24T21:45:00.000Z', '2026-10-24T23:45:00.000Z'], 'start and end');
  });

  await check('turning an all-day item into a timed one at 01:30 on the fall-back day gives it an hour, not a refusal', async () => {
    const input = await editedOneOff({ allDay: false, start: '2026-10-25T01:30' }, { startsAt: iso('2026-10-24T21:00:00Z'), endsAt: iso('2026-10-25T21:59:00Z'), allDay: true });
    assertSame([(input.startsAt as Date).toISOString(), (input.endsAt as Date).toISOString()], ['2026-10-24T22:30:00.000Z', '2026-10-24T23:30:00.000Z'], 'start and end');
  });

  await check('a title-only edit of that item writes no time at all', async () => {
    const input = await editedOneOff({ title: 'Renamed' });
    assert(!('startsAt' in input) && !('endsAt' in input), `times were written: ${show(input)}`);
    assertSame(input.title, 'Renamed', 'title');
  });

  /** What updateGoogleItem hands the provider for an edit of a one-off Google event that starts at the second 01:30 and lasts an hour. */
  async function editedGoogleItem(changes: Record<string, unknown>): Promise<Record<string, unknown>> {
    googleEvent = {
      id: 'g-event', summary: 'Late', status: 'confirmed', organizer: { self: true },
      start: { dateTime: SECOND_0130.toISOString() }, end: { dateTime: new RealDate(SECOND_0130.getTime() + 3_600_000).toISOString() },
    };
    googleUpdates.length = 0;
    const { updateGoogleItem } = await import('../src/services/calendar-write/google-item');
    const user = { id: 1, name: 'U', googleRefreshToken: 'token' } as never;
    const result = await updateGoogleItem(user, { key: { source: 'google', calendarId: 'g1', eventId: 'g-event' }, scope: 'single', changes } as never, IL);
    assertSame(result, { status: 'ok', key: 'google|g1|g-event' }, 'the edit result');
    assert(googleUpdates.length === 1, `${googleUpdates.length} provider writes`);
    return googleUpdates[0];
  }

  await check('a Google item that starts at the SECOND 01:30: editing its end keeps its start; moving its start keeps its length (google-item.ts)', async () => {
    const endEdited = await editedGoogleItem({ end: '2026-10-25T03:00' });
    assertSame([(endEdited.startTime as Date).toISOString(), (endEdited.endTime as Date).toISOString()], [SECOND_0130.toISOString(), '2026-10-25T01:00:00.000Z'], 'end edited');
    const startMoved = await editedGoogleItem({ start: '2026-10-25T01:45' });
    assertSame([(startMoved.startTime as Date).toISOString(), (startMoved.endTime as Date).toISOString()], ['2026-10-24T22:45:00.000Z', '2026-10-24T23:45:00.000Z'], 'start moved onto the repeated hour');
    const titleOnly = await editedGoogleItem({ title: 'Renamed' });
    assert(!('startTime' in titleOnly) && !('endTime' in titleOnly), `times were written: ${show(titleOnly)}`);
  });

  await check('keepIfSameWall: an untouched wall time keeps the stored instant; a different one is resolved', () => {
    assertSame(walltime.wallToInstantKeeping('2026-10-25T01:30', IL, SECOND_0130).toISOString(), SECOND_0130.toISOString(), 'same wall, second occurrence');
    assertSame(walltime.wallToInstantKeeping('2026-10-25T01:30', IL, iso('2026-10-24T22:30:00Z')).toISOString(), '2026-10-24T22:30:00.000Z', 'same wall, first occurrence');
    assertSame(walltime.wallToInstantKeeping('2026-10-25T01:45', IL, SECOND_0130).toISOString(), '2026-10-24T22:45:00.000Z', 'another wall');
    assertSame(walltime.wallToInstantKeeping('2026-03-27T02:30', IL, iso('2026-03-27T00:30:00Z')).toISOString(), '2026-03-27T00:30:00.000Z', 'a moved-forward time reads 03:30 and is another wall: resolved again to the same instant');
  });

  // ---- The other callers of the resolver ----

  const { reminderTimeFromAnchor } = await import('../src/services/native-reminders/resolve');
  const { buildEventTimes } = await import('../src/services/voice/gemini-voice');
  const { startOfLocalDay, daySpanOf } = await import('../src/utils/day-events');
  const { googleRuleLine } = await import('../src/services/calendar-move/mapper');
  const { convertEditRequestToUpdates } = await import('../src/services/voice/event-resolution');

  await check('a reminder set "a day after" an event at 02:30 lands on 03:30 when that day is the jump day (resolve.ts)', () => {
    const anchor = { start: wallTimeToInstant('2026-03-26T02:30', IL).toISOString() } as never;
    const r = reminderTimeFromAnchor(anchor, 1440, IL);
    assert(r.ok, 'refused');
    assertSame(r.startTime.toISOString(), '2026-03-27T00:30:00.000Z', 'a day after');
    const fall = reminderTimeFromAnchor({ start: wallTimeToInstant('2026-10-24T01:30', IL).toISOString() } as never, 1440, IL);
    assert(fall.ok, 'refused');
    assertSame(fall.startTime.toISOString(), '2026-10-24T22:30:00.000Z', 'a day after, onto the repeated hour: the first 01:30');
  });

  await check('an event the voice flow builds for 02:30 on the jump day starts at 03:30 (gemini-voice.ts buildEventTimes)', () => {
    const { start, end } = buildEventTimes('2026-03-27', '02:30', undefined, '04:00', false, IL);
    assertSame([start.toISOString(), end.toISOString()], ['2026-03-27T00:30:00.000Z', '2026-03-27T01:00:00.000Z'], 'times');
    const day = buildEventTimes('2026-03-27', undefined, undefined, undefined, true, IL);
    assertSame([day.start.toISOString(), day.end.toISOString()], ['2026-03-26T22:00:00.000Z', '2026-03-27T20:59:00.000Z'], 'all day');
  });

  await check('a voice edit that sets 02:30 on the jump day gives 03:30, and keeps the event\'s length (event-resolution.ts)', () => {
    const original = {
      eventId: 'e1', calendarId: 'google-primary', summary: 'Lesson', start: wallTimeToInstant('2026-03-26T18:00', IL).toISOString(), end: wallTimeToInstant('2026-03-26T19:00', IL).toISOString(),
    } as never;
    const updates2 = convertEditRequestToUpdates({ newStartDate: '2026-03-27', newStartTime: '02:30' } as never, original, IL);
    assertSame(updates2.startTime?.toISOString(), '2026-03-27T00:30:00.000Z', 'start');
    assertSame(updates2.endTime?.toISOString(), '2026-03-27T01:30:00.000Z', 'end: an hour of real time after');
  });

  await check('the start of a day: a midnight the clocks skip starts the day at 01:00 (Santiago), a repeated midnight at the first one (Havana), an ordinary one at 00:00', () => {
    assertSame(startOfLocalDay('2026-09-06', 'America/Santiago').toISOString(), '2026-09-06T04:00:00.000Z', 'Santiago');
    assertSame(startOfLocalDay('2026-11-01', 'America/Havana').toISOString(), '2026-11-01T04:00:00.000Z', 'Havana');
    assertSame(startOfLocalDay('2026-03-27', IL).toISOString(), '2026-03-26T22:00:00.000Z', 'Israel on the jump day');
    assertSame(startOfLocalDay('2026-10-25', IL).toISOString(), '2026-10-24T21:00:00.000Z', 'Israel on the fall-back day');
  });

  await check('a summary day\'s overnight cutoff (06:00) and its edges are the local ones on the change days', () => {
    const event = (start: string, end: string) => ({ eventId: 'x', calendarId: 'c', summary: 's', start: wallTimeToInstant(start, IL).toISOString(), end: wallTimeToInstant(end, IL).toISOString() }) as never;
    // 22:00 to 05:00 across the jump: last night's tail ends before 06:00, so it is not the 27th's.
    assertSame(daySpanOf(event('2026-03-26T22:00', '2026-03-27T05:00'), '2026-03-27', IL), null, 'a tail ending at 05:00 on the jump day');
    assertSame(daySpanOf(event('2026-03-26T22:00', '2026-03-27T07:00'), '2026-03-27', IL), 'continues', 'a tail ending at 07:00 is the day\'s');
    assertSame(daySpanOf(event('2026-10-24T22:00', '2026-10-25T05:00'), '2026-10-25', IL), null, 'a tail ending at 05:00 on the fall-back day');
  });

  await check('a Google rule\'s UNTIL on a skipped or repeated wall time is the resolver\'s (calendar-move/mapper.ts googleRuleLine)', () => {
    assertSame(googleRuleLine('FREQ=DAILY;UNTIL=20260327T023000', false, IL), 'RRULE:FREQ=DAILY;UNTIL=20260327T003000Z', 'jump day');
    assertSame(googleRuleLine('FREQ=DAILY;UNTIL=20261025T013000', false, IL), 'RRULE:FREQ=DAILY;UNTIL=20261024T223000Z', 'fall-back day');
    assertSame(googleRuleLine('FREQ=DAILY;UNTIL=20261025', false, IL), 'RRULE:FREQ=DAILY;UNTIL=20261025T215959Z', 'a date: the end of that day');
  });

  // ---- Every caller goes through the resolver ----

  await check('no file under src/ or app/ builds an instant from a wall time with date-fns-tz\'s fromZonedTime: the one resolver is the only path', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) {
          if (name !== 'node_modules' && name !== '.next') walk(file);
        } else if (/\.(ts|tsx)$/.test(name) && !file.endsWith(path.join('src', 'utils', 'wall-time.ts'))) {
          const text = readFileSync(file, 'utf8');
          if (/\bfromZonedTime\b/.test(text)) offenders.push(path.relative(ROOT, file));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    walk(path.join(ROOT, 'app'));
    assertSame(offenders, [], 'files that still use fromZonedTime');
  });

  await check('both write paths resolve an untouched time through the same helper (write.ts updateItem, google-item.ts updateGoogleItem)', () => {
    for (const file of ['write.ts', 'google-item.ts']) {
      const text = readFileSync(path.join(SRC, 'services', 'calendar-write', file), 'utf8');
      assert(/wallToInstantKeeping\(/.test(text), `${file} does not use wallToInstantKeeping`);
    }
    const google = readFileSync(path.join(SRC, 'services', 'calendar-write', 'google-item.ts'), 'utf8');
    assert(!/[^g]wallToInstant\(/.test(google), 'google-item.ts still resolves a start or end with wallToInstant');
  });

  setClock(null);
  report();
}

function report(): void {
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') {
  runChildren();
} else {
  runChecks().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
