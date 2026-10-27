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
import { createRequire } from 'node:module';
import {
  RealDate, assert, assertSame, check, datesIn, fakeOver, installClock, iso, localReading, recorder, results, scannedInstant, setClock, show, stubModules, wallOf,
  type Call,
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
  // Prisma and Redis record what the code under test asks of them; Redis also keeps values (expiring on the fake clock).
  const dbCalls: Call[] = [];
  const redisData = new Map<string, { value: string; expires: number }>();
  const redisCalls: Call[] = [];
  const fakeRedis = new Proxy(recorder(redisCalls), {
    get: (target, key) => {
      if (key === 'get') return async (k: string) => (liveRedis(k) ? redisData.get(k)!.value : null);
      if (key === 'exists') return async (k: string) => (liveRedis(k) ? 1 : 0);
      if (key === 'del') return async (k: string) => (redisData.delete(k) ? 1 : 0);
      if (key === 'set') return async (k: string, value: string, opts?: { ex?: number }) => redisData.set(k, { value, expires: Date.now() + (opts?.ex ?? 1e9) * 1000 });
      return Reflect.get(target, key);
    },
  });
  function liveRedis(key: string): boolean {
    const entry = redisData.get(key);
    if (entry && entry.expires <= Date.now()) redisData.delete(key);
    return redisData.has(key);
  }
  // What the calendar provider returns for the alert pass, and the cron jobs node-cron was asked for.
  const providerEvents: Array<{ eventId: string; calendarId: string; summary: string; start: string; end: string; reminders?: unknown }> = [];
  const cronCalls: Array<{ pattern: string; options: unknown }> = [];
  const quiet = async () => undefined;
  stubModules({
    'node-cron': { schedule: (pattern: string, _task: unknown, options?: unknown) => { cronCalls.push({ pattern, options }); return { stop: () => undefined }; } },
    'next/server': {
      NextRequest: class {},
      NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
    },
    [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
    [`${SRC}/lib/timezone.ts`]: (real: Record<string, unknown>) => fakeOver(real, { resolveUserTimezone: async (user: { tz: string }) => user.tz }),
    [`${SRC}/lib/error-capture.ts`]: {
      captureError: (error: unknown, context: string) => console.error(`captured (${context}):`, error),
      captureWarning: () => undefined,
      captureInfo: () => undefined,
    },
    [`${SRC}/lib/api-auth.ts`]: { verifyUserAuth: async () => ({ success: true, user: { id: 1, name: 'U', telegramId: 1 } }) },
    [`${SRC}/lib/rate-limit.ts`]: { generalRateLimiter: {} },
    [`${SRC}/lib/bot-messages.ts`]: { getBotMessages: async () => ({}) },
    [`${SRC}/utils/error-notifier.ts`]: { notifyAdminFeedback: quiet, notifyAdminError: quiet, notifyAdminWarning: quiet, getAdminUserIds: async () => [] },
    [`${SRC}/services/user-service.ts`]: (real: Record<string, unknown>) =>
      fakeOver(real, { getUserByTelegramId: async () => ({ id: 1, name: 'U', telegramId: 1, language: 'en' }), getWhatsAppChatId: () => null }),
    [`${SRC}/services/telegram/bot.ts`]: (real: Record<string, unknown>) => fakeOver(real, { getMessagingService: () => ({ sendMessage: quiet }) }),
    // A module the code under test loads with import() keeps only the names of its real file, so those are faked over the real module, not replaced.
    [`${SRC}/cron/handlers.ts`]: (real: Record<string, unknown>) => fakeOver(real, { bootReminderCache: quiet }),
    [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: quiet, invalidateFeatureAccessCache: quiet },
    [`${SRC}/services/reminder-cache.ts`]: (real: Record<string, unknown>) => fakeOver(real, { getEarlyAdoptionMode: async () => false }),
    [`${SRC}/services/calendar-provider/index.ts`]: (real: Record<string, unknown>) =>
      fakeOver(real, {
        hasUsableCalendar: async () => true,
        getCalendarAssignmentsForUser: async () => [
          { calendarId: 'main', name: 'Main', labels: [], color: '#000000' },
          { calendarId: 'kids', name: 'Kids', labels: ['kids'], color: '#000000' },
        ],
        fetchEventsInRange: async (_user: unknown, _ids: unknown, from: Date, to: Date) => ({
          events: providerEvents.filter(e => iso(e.end) > from && iso(e.start) < to),
          failed: [],
        }),
      }),
    // The feedback count answers "at the limit", so the bot command and the route stop after reading the window.
    [`${SRC}/utils/prisma.ts`]: { prisma: recorder(dbCalls, path => (path === 'userFeedback.count' ? 99 : path.endsWith('.findMany') ? [] : null)) },
    // The summaries' prompt builder pulls in an ES-only hebcal build that a CommonJS run cannot load; none of these checks reach it.
    [`${SRC}/services/claude.ts`]: {},
    [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => undefined, trackActivity: quiet, addBreadcrumb: () => undefined },
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
  // The services log every event and send; only the checks' own lines are wanted here.
  const consoleKept = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => undefined;

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


  // ================= "Now", the summary gap hour, the setup-reminder hour =================

  const MIN = 60_000;
  const DAY = 86_400_000;
  const { getDueReminders } = await import('../src/services/reminders');
  const { matchSearchRange } = await import('../src/services/voice/event-resolution');
  const { filterUsersForSummary, markSummarySent } = await import('../src/lib/summary-scheduling');

  const alertUser = { id: 1, telegramId: 1, defaultReminderMinutes: 0, pickupRemindersEnabled: true } as never;
  const ev = (id: string, calendarId: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ eventId: id, calendarId, summary: id, start, end, ...extra });
  /** The alerts a 5-minute pass finds when the clock reads `at`, as 'eventId:type'. */
  async function alertsAt(at: string | number, events: ReturnType<typeof ev>[], tz = IL): Promise<string[]> {
    providerEvents.length = 0;
    providerEvents.push(...events);
    setClock(at);
    return (await getDueReminders(alertUser, 5, tz)).map(d => `${d.event.eventId}:${d.type}`).sort();
  }

  await check('the 5-minute alert pass at 23:30:30Z on 2026-10-24 (the second 01:30 in Israel) finds the alerts due in the second 01:xx hour: a start, a pickup and a "1 hour before"', async () => {
    const found = await alertsAt('2026-10-24T23:30:30Z', [
      ev('a', 'main', '2026-10-24T23:30:00Z', '2026-10-25T00:30:00Z'),
      ev('b', 'main', '2026-10-24T21:00:00Z', '2026-10-24T22:00:00Z'),
      ev('c', 'main', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', { reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] } }),
      ev('p', 'kids', '2026-10-24T22:32:00Z', '2026-10-24T23:32:00Z'),
      ev('later', 'main', '2026-10-24T23:45:00Z', '2026-10-25T00:45:00Z'),
    ]);
    // The kids event p also starts at 22:32Z, an hour before the window; only its pickup is due.
    assertSame(found, ['a:start', 'c:start', 'p:pickup'], 'the alerts due in [23:30, 23:35)');
  });

  await check('a sweep of 5-minute passes through each clock change finds every alert exactly once (Israel falling back and springing forward, New York both ways)', async () => {
    const sweeps: Array<[string, string, string, string]> = [
      ['IL fall back', IL, '2026-10-24T20:00:30Z', '2026-10-25T02:00:30Z'],
      ['IL spring forward', IL, '2026-03-26T21:00:30Z', '2026-03-27T03:00:30Z'],
      ['NY fall back', NY, '2026-11-01T03:00:30Z', '2026-11-01T09:00:30Z'],
      ['NY spring forward', NY, '2026-03-08T05:00:30Z', '2026-03-08T11:00:30Z'],
    ];
    for (const [label, tz, from, to] of sweeps) {
      const first = iso(from).getTime();
      const last = iso(to).getTime();
      // One event on every tenth minute (alert at its start) and a kids event ending on each (a pickup alert at its end, a start alert an hour before).
      const events: ReturnType<typeof ev>[] = [];
      const expected: string[] = [];
      const windowStart = first - 30_000;
      const windowEnd = last - 30_000 + 5 * MIN;
      const covered = (t: number) => t >= windowStart && t < windowEnd;
      for (let t = Math.ceil(first / (10 * MIN)) * 10 * MIN; t < last; t += 10 * MIN) {
        events.push(ev(`s${t}`, 'main', new RealDate(t).toISOString(), new RealDate(t + 30 * MIN).toISOString()));
        if (covered(t)) expected.push(`s${t}:start`);
        events.push(ev(`k${t}`, 'kids', new RealDate(t - 60 * MIN).toISOString(), new RealDate(t).toISOString()));
        if (covered(t - 60 * MIN)) expected.push(`k${t}:start`);
        if (covered(t)) expected.push(`k${t}:pickup`);
      }
      const seen = new Map<string, number>();
      for (let tick = first; tick <= last; tick += 5 * MIN) {
        for (const found of await alertsAt(tick, events, tz)) seen.set(found, (seen.get(found) ?? 0) + 1);
      }
      const wrong = [...seen].filter(([key, n]) => n !== 1 || !expected.includes(key)).map(([key, n]) => `${key} x${n}`);
      const missed = expected.filter(key => !seen.has(key));
      assertSame({ wrong: wrong.slice(0, 3), missed: missed.slice(0, 3) }, { wrong: [], missed: [] }, `${label}: ${expected.length} alerts expected`);
      assert(expected.length > 20, `${label}: only ${expected.length} alerts in the sweep`);
    }
  });

  await check('the voice flow\'s search range is a week back and two weeks ahead of "now" in real time, over a clock change too', () => {
    for (const now of ['2026-10-30T12:00:00Z', '2026-03-30T12:00:00Z', '2026-11-05T12:00:00Z', '2026-03-12T12:00:00Z', '2026-06-10T12:00:00Z']) {
      const r = matchSearchRange({ timeHint: undefined } as never, iso(now), IL);
      assertSame([r.startDate.getTime() - iso(now).getTime(), r.endDate.getTime() - iso(now).getTime()], [-7 * DAY, 14 * DAY], `range around ${now}`);
    }
  });

  /** The Dates in the recorded arguments of one Prisma call ('subscription.findMany'). */
  const datesOf = (path: string) => dbCalls.filter(c => c.path === path).flatMap(c => datesIn(c.args));

  await check('subscription reminders look for periods ending within 4 days (3-day warning) and 1 day (last-day warning) of real time, over a clock change', async () => {
    const { processSubscriptionReminders } = await import('../src/services/subscription-reminders');
    for (const now of ['2026-10-23T12:00:00Z', '2026-03-24T12:00:00Z']) {
      dbCalls.length = 0;
      setClock(now);
      await processSubscriptionReminders();
      const ahead = datesOf('subscription.findMany').map(d => d.getTime() - iso(now).getTime()).filter(ms => ms > 0);
      assertSame([...new Set(ahead)].sort((a, b) => a - b), [DAY, 4 * DAY], `windows ahead of ${now}`);
    }
  });

  await check('the feedback rate limit counts the last 24 hours of real time, in the bot command and in the dashboard route, over a clock change', async () => {
    const { handleFeedbackCommand } = await import('../src/services/telegram/commands');
    const route = await import('../app/api/feedback/route');
    for (const now of ['2026-10-25T10:00:00Z', '2026-03-27T10:00:00Z']) {
      setClock(now);
      dbCalls.length = 0;
      await handleFeedbackCommand(1, 1, 'a feedback text that is long enough');
      const viaBot = datesOf('userFeedback.count').map(d => iso(now).getTime() - d.getTime());
      dbCalls.length = 0;
      await route.POST({ json: async () => ({ text: 'a feedback text that is long enough', user_id: 1 }) } as never);
      const viaRoute = datesOf('userFeedback.count').map(d => iso(now).getTime() - d.getTime());
      assertSame([viaBot, viaRoute], [[DAY], [DAY]], `the window's start before ${now}`);
    }
  });

  await check('the setup reminders\' 14-day window starts 14 days of real time back, over a clock change', async () => {
    const { handleSetupReminders } = await import('../src/cron/handlers');
    for (const now of ['2026-11-03T12:00:00Z', '2026-04-05T12:00:00Z']) {
      dbCalls.length = 0;
      setClock(now);
      await handleSetupReminders();
      const back = datesOf('user.findMany').map(d => iso(now).getTime() - d.getTime());
      assert(back.length > 0 && back.every(ms => ms === 14 * DAY), `cut-offs ${show(back.map(ms => ms / DAY))} days back from ${now}`);
    }
  });

  await check('the "tomorrow" a summary batch hands down is a day of real time ahead of now', async () => {
    const { tomorrowMarker } = await import('../src/services/telegram/summary');
    for (const now of ['2026-10-24T12:00:00Z', '2026-03-26T12:00:00Z', '2026-06-10T12:00:00Z']) {
      setClock(now);
      assertSame(tomorrowMarker().getTime() - iso(now).getTime(), DAY, `from ${now}`);
    }
  });

  await check('no code under src/ or app/ moves a Date by its local fields (setSeconds, setMinutes, setHours, setDate, setMonth, setFullYear, setMilliseconds): the class that broke "now" and the windows', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) {
          if (name !== 'node_modules' && name !== '.next') walk(file);
        } else if (/\.(ts|tsx)$/.test(name) && /\.set(Seconds|Minutes|Hours|Date|Month|FullYear|Milliseconds)\(/.test(readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(ROOT, file));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    walk(path.join(ROOT, 'app'));
    assertSame(offenders, [], 'files that still use a local-field setter');
  });

  // ---- Summaries: the hour a clock change skips ----

  /** Fresh Redis; every hourly tick from `from` to `to` runs the real filter, and an eligible user is sent and marked, as the batch does. Returns the local time of each send. */
  async function summarySends(zone: string, hour: number, type: 'daily' | 'tomorrow', from: string, to: string): Promise<string[]> {
    redisData.clear();
    const user = { id: 1, tz: zone, telegramId: 1, preferredMorningHour: hour, preferredEveningHour: hour } as never;
    const sends: string[] = [];
    for (let tick = iso(from).getTime(); tick < iso(to).getTime(); tick += 3_600_000) {
      setClock(tick);
      const { eligible } = await filterUsersForSummary([user], type);
      if (eligible.length > 0) {
        await markSummarySent(1, type, zone);
        sends.push(wallOf(new RealDate(tick), zone));
      }
    }
    return sends;
  }

  await check('a summary preferred at 02:00 on the day Israel springs forward goes out once, at 03:00; the next day at 02:00 (daily and tomorrow)', async () => {
    for (const type of ['daily', 'tomorrow'] as const) {
      assertSame(await summarySends(IL, 2, type, '2026-03-26T12:00:00Z', '2026-03-27T12:00:00Z'), ['2026-03-27 03:00'], `${type} on the jump day`);
      assertSame(await summarySends(IL, 2, type, '2026-03-27T12:00:00Z', '2026-03-28T12:00:00Z'), ['2026-03-28 02:00'], `${type} the day after`);
      assertSame(await summarySends(IL, 2, type, '2026-03-25T12:00:00Z', '2026-03-26T12:00:00Z'), ['2026-03-26 02:00'], `${type} the day before`);
    }
  });

  await check('a summary preferred at 07:00 goes out once at 07:00 on both change days, in Israel and in New York', async () => {
    for (const type of ['daily', 'tomorrow'] as const) {
      assertSame(await summarySends(IL, 7, type, '2026-03-26T12:00:00Z', '2026-03-27T12:00:00Z'), ['2026-03-27 07:00'], `${type} IL jump day`);
      assertSame(await summarySends(IL, 7, type, '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z'), ['2026-10-25 07:00'], `${type} IL fall-back day`);
      assertSame(await summarySends(NY, 7, type, '2026-03-07T13:00:00Z', '2026-03-08T12:00:00Z'), ['2026-03-08 07:00'], `${type} NY jump day`);
    }
  });

  await check('a summary preferred at 02:00 in New York on 2026-03-08 goes out at 03:00; in London at 01:00 on 2026-03-29 at 02:00', async () => {
    assertSame(await summarySends(NY, 2, 'daily', '2026-03-07T12:00:00Z', '2026-03-08T12:00:00Z'), ['2026-03-08 03:00'], 'New York');
    assertSame(await summarySends(LONDON, 1, 'daily', '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z'), ['2026-03-29 02:00'], 'London');
  });

  await check('a summary preferred in the repeated hour (01:00 on the day Israel falls back) goes out once, at the first 01:00; at 02:00 once, at 02:00', async () => {
    assertSame(await summarySends(IL, 1, 'daily', '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z'), ['2026-10-25 01:00'], 'hour 1');
    assertSame(await summarySends(IL, 2, 'daily', '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z'), ['2026-10-25 02:00'], 'hour 2');
  });

  await check('every preferred hour, on each of the full days around both Israeli changes, goes out once, at its own hour (only 02:00 on the jump day moves, to 03:00)', async () => {
    for (const type of ['daily', 'tomorrow'] as const) {
      for (let hour = 0; hour < 24; hour++) {
        for (const [firstDay, endDay] of [['2026-03-25', '2026-03-31'], ['2026-10-23', '2026-10-29']]) {
          // Ticks from the first day's local midnight to the last day's, so every day in between is a full local day.
          const sends = await summarySends(IL, hour, type, wallTimeToInstant(`${firstDay}T00:00`, IL).toISOString(), wallTimeToInstant(`${endDay}T00:00`, IL).toISOString());
          const days: string[] = [];
          for (let day = firstDay; day < endDay; day = walltime.addDaysToDate(day, 1)) days.push(day);
          assertSame(sends.map(s => s.slice(0, 10)), days, `${type} hour ${hour} from ${firstDay}: one send per day`);
          for (const s of sends) {
            const want = hour === 2 && s.startsWith('2026-03-27') ? 3 : hour;
            assert(Number(s.slice(11, 13)) === want, `${type} hour ${hour}: sent at ${s}`);
          }
        }
      }
    }
  });

  // ---- The scheduler and the startup line ----

  await check('the setup reminders are scheduled at 10:00 Israel time with the zone option; health, purge and the hourly jobs stay on the host clock (UTC)', async () => {
    cronCalls.length = 0;
    const { startScheduler } = await import('../src/cron/scheduler');
    startScheduler();
    const setup = cronCalls.filter(c => c.pattern === '0 10 * * *');
    assertSame(setup.map(c => c.options), [{ timezone: IL }], 'the setup-reminders job and its options');
    for (const pattern of ['0 3 * * *', '30 3 * * *', '0 * * * *', '*/5 * * * *']) {
      const jobs = cronCalls.filter(c => c.pattern === pattern);
      assert(jobs.length > 0, `${pattern} is not scheduled`);
      assert(jobs.every(j => j.options === undefined), `${pattern} has a zone option: ${show(jobs.map(j => j.options))}`);
    }
    assert(!cronCalls.some(c => c.pattern === '0 7 * * *'), 'the old UTC 07:00 setup job is still scheduled');
  });

  await check('node-cron fires that job at 10:00 Israel time on either side of each change: 08:00Z in winter time, 07:00Z in summer time', () => {
    const { TimeMatcher } = createRequire(__filename)(path.join(ROOT, 'node_modules/node-cron/dist/cjs/time/time-matcher.js')) as { TimeMatcher: new (pattern: string, zone?: string) => { match(d: Date): boolean } };
    const matcher = new TimeMatcher('0 10 * * *', IL);
    const fires: string[] = [];
    for (const [from, to] of [['2026-03-25', '2026-03-30'], ['2026-10-23', '2026-10-28']]) {
      for (let t = iso(`${from}T00:00:00Z`).getTime(); t < iso(`${to}T00:00:00Z`).getTime(); t += MIN) {
        if (matcher.match(new RealDate(t))) fires.push(new RealDate(t).toISOString().slice(0, 16));
      }
    }
    assertSame(fires, [
      '2026-03-25T08:00', '2026-03-26T08:00', '2026-03-27T07:00', '2026-03-28T07:00', '2026-03-29T07:00',
      '2026-10-23T07:00', '2026-10-24T07:00', '2026-10-25T08:00', '2026-10-26T08:00', '2026-10-27T08:00',
    ], 'fire times (UTC)');
  });

  await check('the startup line names the process zone and whether it observes summer/winter time, and instrumentation.ts logs it', async () => {
    const { processZoneLine } = await import('../src/lib/startup-checks');
    const line = processZoneLine(iso('2026-06-01T00:00:00Z'));
    const zone = process.env.TZ ?? '';
    assert(line.includes(zone), `${line} does not name ${zone}`);
    assert(line.includes('not observed') === (zone === 'UTC'), `${line} is wrong about summer/winter time in ${zone}`);
    assert(/processZoneLine\(\)/.test(readFileSync(path.join(ROOT, 'instrumentation.ts'), 'utf8')), 'instrumentation.ts does not log processZoneLine()');
  });

  setClock(null);
  Object.assign(console, consoleKept);
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
