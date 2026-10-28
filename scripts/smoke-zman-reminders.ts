// Smoke test for reminders by zman (zmanim reminders plan, Task 3): the rule a reminder carries
// (src/lib/calendar-view/zman-spec.ts, src/services/zmanim/spec.ts), the person's clock that turns it into the
// instant it is due (reminder-clock.ts, reminder-times.ts), the leaf due.ts that every reader asks, the
// bodies the editor sends and the server accepts (editor-model.ts, validate.ts), the words of a rule in en/he/ru
// (app/[locale]/dashboard/zman-words.ts), and the migration. The store, the pass, the home and the digests
// each have their checks in their own smokes (smoke-native-reminder-store, smoke-native-reminders,
// smoke-calendar-dto, smoke-native-reminder-digest, smoke-calendar-editor-api, smoke-calendar-home-render,
// smoke-settings-render).
//
// What it pins:
//   - the spec: its shape, "the same rule", the known keys, what each community's set offers a reminder;
//   - one function turns a rule into an instant: the clock's, on the occurrence's civil date, at the PERSON'S place
//     (Harish 10 minutes before the latest Shema, GRA, is 08:27); a timed occurrence is a fixed time; no clock
//     or no zman that day falls back as stated; the answer is remembered and a missing zman logs once;
//   - the place: the saved one, else the zone's main city (logged once a day), else none;
//   - the editor info: the community's zmanim, today's time of each, the hours table, the place source;
//   - the editor's model: the form from an edit info, the create and update bodies, the scope plan (a mode or rule
//     change is a series change, a fixed-time move of one occurrence is not), the preview, the dirty check;
//   - the server's parsing of those bodies;
//   - the words of a rule in English, Hebrew and Russian;
//   - the migration: one additive, idempotent column.
//
// Pure for the computation; the person's place comes from coordinates the fixtures carry, so nothing reaches the
// network or a database (a fetch throws). Process zone: this file re-runs itself once per server zone (UTC,
// Asia/Jerusalem, America/New_York) as child processes, so `bash scripts/ci-smokes.sh` and a plain
// `npx tsx scripts/smoke-zman-reminders.ts` both cover all three; nothing here may depend on the one the process has.
//   npx tsx scripts/smoke-zman-reminders.ts

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMAN_REMINDERS_SMOKE_CHILD';
const nodeRequire = createRequire(__filename);

// ---- The parent: one child per process zone ----

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      (zone) =>
        new Promise<{ zone: string; code: number; text: string }>((resolve) => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.stderr.on('data', (chunk) => (text += chunk));
          child.on('close', (code) => resolve({ zone, code: code ?? 1, text }));
        }),
    ),
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Checks ----

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const show = (value: unknown): string => JSON.stringify(value);

function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build before the module under test loads ----

const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string; _cache: Record<string, unknown> };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Row = Record<string, unknown>;
function stub(rel: string, exports: Row): void {
  const filename = path.join(ROOT, rel);
  const mod = new (Module as unknown as new (id: string) => Row)(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  internals._cache[filename] = mod;
}

/** Console output the call made, and what it returned. */
async function logged<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const kept = { log: console.log, warn: console.warn, info: console.info, error: console.error };
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = take; console.warn = take; console.info = take; console.error = take;
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, kept);
  }
}

const captured: Array<{ context: string }> = [];
stub('src/utils/redis.ts', { redis: { get: async () => null, set: async () => 'OK', del: async () => 0 } });
stub('src/utils/prisma.ts', { prisma: {} });
stub('src/lib/error-capture.ts', {
  captureError: (_e: unknown, context: string) => { captured.push({ context }); },
  captureWarning: (_m: string, context: string) => { captured.push({ context }); },
  captureInfo: () => undefined,
});
// The zone is the caller's (the clock is built with it); the lookups must never run, so each answers "nothing".
stub('src/lib/timezone.ts', {
  resolveUserTimezone: async () => 'Asia/Jerusalem',
  resolveLocation: async () => null,
  LOOKUP_TIMEOUT_MS: 3000,
  TIMEZONE_CACHE_TTL: 86_400,
});
stub('src/services/weather/geocoding.ts', {
  fetchWithTimeout: async () => { throw new Error('the smoke reached the network'); },
});
globalThis.fetch = (async () => { throw new Error('the smoke reached the network'); }) as typeof fetch;

/* eslint-disable @typescript-eslint/no-require-imports */
const zspec = require('../src/lib/calendar-view/zman-spec') as typeof import('../src/lib/calendar-view/zman-spec');
const spec = require('../src/services/zmanim/spec') as typeof import('../src/services/zmanim/spec');
const sets = require('../src/services/zmanim/sets') as typeof import('../src/services/zmanim/sets');
const due = require('../src/services/native-reminders/due') as typeof import('../src/services/native-reminders/due');
const clockMod = require('../src/services/zmanim/reminder-clock') as typeof import('../src/services/zmanim/reminder-clock');
const times = require('../src/services/zmanim/reminder-times') as typeof import('../src/services/zmanim/reminder-times');
const compute = require('../src/services/zmanim/compute') as typeof import('../src/services/zmanim/compute');
const model = require('../src/lib/calendar-view/editor-model') as typeof import('../src/lib/calendar-view/editor-model');
const validate = require('../src/services/calendar-write/validate') as typeof import('../src/services/calendar-write/validate');
const words = require('../app/[locale]/dashboard/zman-words') as typeof import('../app/[locale]/dashboard/zman-words');
const wall = require('../src/utils/wall-time') as { instantToWallTime: (instant: Date, zone: string) => string };
const { createTranslator } = nodeRequire('next-intl') as { createTranslator: (o: Row) => (key: string, values?: Row) => string };
/* eslint-enable @typescript-eslint/no-require-imports */

type Spec = import('../src/lib/calendar-view/zman-spec').ZmanSpecValue;
type Form = import('../src/lib/calendar-view/editor-model').EditorForm;
type Info = import('../src/lib/calendar-view/editor-types').ItemEditInfoResponse;

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const hm = (at: Date | null | undefined, zone = IL): string => {
  assert(at instanceof Date && !Number.isNaN(at.getTime()), `not an instant: ${String(at)}`);
  return wall.instantToWallTime(at, zone).slice(11, 16);
};

// A person: the fields the clock reads (the pause's), with coordinates so no lookup runs.
const user = (over: Row = {}) => ({
  id: 1, location: 'Harish', latitude: 32.46182, longitude: 35.04555, elevationM: 270, zmanimCommunity: 'sephardi', pauseOnShabbat: false, ...over,
});
type User = ReturnType<typeof user>;
const asUser = (u: User) => u as unknown as Parameters<typeof times.buildZmanClock>[0];

// A clock that answers from a table, to see exactly what the leaf asks of it.
function fakeClock(answers: Record<string, string | null> = {}, source: 'saved' | 'zone' = 'saved') {
  const asked: string[] = [];
  const clock: import('../src/lib/calendar-view/zman-spec').ZmanClock = {
    source,
    instant: (day, rule) => {
      asked.push(`${day} ${show(rule)}`);
      const at = answers[day];
      return at ? new Date(at) : null;
    },
    opinion: () => null,
  };
  return { clock, asked };
}

const SHEMA_GRA_10_BEFORE: Spec = { zman: 'SOF_SHMA_GRA', offsetMin: -10 };

async function main() {
  // ============ The rule ============

  await check('spec: readZmanSpec takes exactly {zman, offsetMin} or {halachicHours, offsetMin}, whole minutes within 12 hours, hours 0 to 12, and returns a fresh object', () => {
    assertSame(zspec.readZmanSpec({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }), SHEMA_GRA_10_BEFORE, 'a zman');
    assertSame(zspec.readZmanSpec({ halachicHours: 3, offsetMin: 5 }), { halachicHours: 3, offsetMin: 5 }, 'hours');
    assertSame(zspec.readZmanSpec({ halachicHours: 0, offsetMin: 0 }), { halachicHours: 0, offsetMin: 0 }, 'zero hours');
    const input = { zman: 'CHATZOT', offsetMin: 0 };
    assert(zspec.readZmanSpec(input) !== input, 'a fresh object');
    for (const bad of [null, undefined, 'x', 7, [], {}, { zman: 'A' }, { offsetMin: 5 }, { zman: '', offsetMin: 0 }, { zman: 'A', offsetMin: 1.5 }, { zman: 'A', offsetMin: 721 }, { zman: 'A', offsetMin: '5' },
      { zman: 'A', halachicHours: 3, offsetMin: 0 }, { zman: 'A', offsetMin: 0, extra: 1 }, { halachicHours: 13, offsetMin: 0 }, { halachicHours: -1, offsetMin: 0 }, { halachicHours: NaN, offsetMin: 0 }, { zman: 5, offsetMin: 0 }]) {
      assert(zspec.readZmanSpec(bad) === null, `accepted ${show(bad)}`);
    }
  });

  await check('spec: sameZmanSpec compares the rule, and two absences are the same', () => {
    const a: Spec = { zman: 'CHATZOT', offsetMin: 5 };
    assert(zspec.sameZmanSpec(a, { zman: 'CHATZOT', offsetMin: 5 }), 'equal');
    assert(!zspec.sameZmanSpec(a, { zman: 'CHATZOT', offsetMin: 10 }) && !zspec.sameZmanSpec(a, { zman: 'SHKIA', offsetMin: 5 }), 'differs');
    assert(!zspec.sameZmanSpec(a, { halachicHours: 5, offsetMin: 5 }) && !zspec.sameZmanSpec({ halachicHours: 5, offsetMin: 5 }, a), 'a zman is not hours');
    assert(zspec.sameZmanSpec({ halachicHours: 3, offsetMin: 0 }, { halachicHours: 3, offsetMin: 0 }) && !zspec.sameZmanSpec({ halachicHours: 3, offsetMin: 0 }, { halachicHours: 4, offsetMin: 0 }), 'hours');
    assert(zspec.sameZmanSpec(null, undefined) && !zspec.sameZmanSpec(a, null) && !zspec.sameZmanSpec(null, a), 'absence');
  });

  await check('spec (server): a key the module does not know is no spec; a reminder is offered the set minus the end of Shabbat; Chabad has no Magen Avraham; every set offers halachic hours', () => {
    assert(spec.asZmanSpec({ zman: 'NOT_A_ZMAN', offsetMin: 0 }) === null, 'an unknown key');
    assertSame(spec.asZmanSpec({ zman: 'TZEIT', offsetMin: 5 }), { zman: 'TZEIT', offsetMin: 5 }, 'a known key');
    for (const community of sets.COMMUNITIES) {
      const offered = spec.reminderZmanim(community);
      assert(!offered.includes('SHABBAT_ENDS') && offered.length === sets.zmanimOfSet(community).length - 1, `${community} offers ${offered.length}`);
      assert(spec.offeredIn({ halachicHours: 3, offsetMin: 0 }, community), `${community} offers hours`);
      assert(!spec.offeredIn({ zman: 'SHABBAT_ENDS', offsetMin: 0 }, community), `${community} offers the end of Shabbat`);
    }
    assert(spec.offeredIn({ zman: 'SOF_SHMA_MGA', offsetMin: 0 }, 'sephardi') && !spec.offeredIn({ zman: 'SOF_SHMA_MGA', offsetMin: 0 }, 'chabad'), 'Magen Avraham: Sephardi yes, Chabad no');
    assert(spec.offeredIn({ zman: 'PLAG_HALACHA_BERURA', offsetMin: 0 }, 'sephardi') && !spec.offeredIn({ zman: 'PLAG_HALACHA_BERURA', offsetMin: 0 }, 'ashkenazi') && spec.offeredIn({ zman: 'PLAG_GRA', offsetMin: 0 }, 'ashkenazi'), 'the plags by set');
    assert(spec.communityOfUser({ zmanimCommunity: 'chabad' }) === 'chabad' && spec.communityOfUser({ zmanimCommunity: 'nope' }) === 'sephardi' && spec.communityOfUser({}) === 'sephardi', 'the community of a user');
  });

  // ============ The one function: a rule becomes an instant ============

  const IL_MIDNIGHT = new Date('2026-10-14T21:00:00Z'); // 2026-10-15 00:00 in Israel (summer time)
  const occurrence = { startsAt: IL_MIDNIGHT, allDay: true, timeZone: IL };

  await check('due: a date-only occurrence of a reminder by zman is due at the clock\'s instant for ITS civil date (the event\'s own date, not the reader\'s)', () => {
    const { clock, asked } = fakeClock({ '2026-10-15': '2026-10-15T05:27:00Z' });
    const rule = due.zmanRuleOf({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }, clock);
    assert(rule !== undefined, 'a rule');
    // The reader is in New York, where the event\'s date is still the 14th: the date asked is the event\'s.
    const at = due.dueAtForOccurrence(occurrence, NY, '09:00', rule);
    assert(at.toISOString() === '2026-10-15T05:27:00.000Z', `due ${at.toISOString()}`);
    assertSame(asked, ['2026-10-15 {"zman":"SOF_SHMA_GRA","offsetMin":-10}'], 'asked the clock once, for the event\'s date');
    const home = due.reminderDueAt({ start: '2026-10-15' }, IL, '09:00', rule);
    assert(home.toISOString() === '2026-10-15T05:27:00.000Z', `the home reads ${home.toISOString()}`);
  });

  await check('due: a timed occurrence (a reminder moved on its own to a time) is a fixed time: the rule is not asked', () => {
    const { clock, asked } = fakeClock({ '2026-10-15': '2026-10-15T05:27:00Z' });
    const rule = due.zmanRuleOf(SHEMA_GRA_10_BEFORE, clock);
    const timed = { startsAt: new Date('2026-10-15T14:00:00Z'), allDay: false, timeZone: IL };
    assert(due.dueAtForOccurrence(timed, IL, '09:00', rule).toISOString() === '2026-10-15T14:00:00.000Z', 'timed occurrence');
    assert(due.zmanDueForOccurrence(timed, rule!) === undefined, 'the rule does not apply to it');
    assert(due.reminderDueAt({ start: '2026-10-15T14:00:00.000Z' }, IL, '09:00', rule).toISOString() === '2026-10-15T14:00:00.000Z', 'the home reads a timed one as it is');
    assert(asked.length === 0, `the clock was asked ${asked.length} time(s)`);
  });

  await check('due: with no clock, or a clock with no time that day, a date-only one falls back to the reminder time (reads) and zmanDueForOccurrence says there is none (the pass skips it)', () => {
    for (const clock of [null, fakeClock({}).clock]) {
      const rule = due.zmanRuleOf(SHEMA_GRA_10_BEFORE, clock)!;
      assert(due.dueAtForOccurrence(occurrence, IL, '08:15', rule).toISOString() === '2026-10-15T05:15:00.000Z', 'the reminder time of the day');
      assert(due.reminderDueAt({ start: '2026-10-15' }, IL, '08:15', rule).toISOString() === '2026-10-15T05:15:00.000Z', 'the home too');
      assert(due.zmanDueForOccurrence(occurrence, rule) === null, 'none');
    }
  });

  await check('due: a plain reminder is untouched (no rule: 09:00); zmanRuleOf reads a stored value and returns nothing for a plain one', () => {
    assert(due.zmanRuleOf(null, fakeClock().clock) === undefined && due.zmanRuleOf(undefined, null) === undefined && due.zmanRuleOf({ nonsense: true }, null) === undefined, 'no rule');
    assert(due.dueAtForOccurrence(occurrence, IL).toISOString() === '2026-10-15T06:00:00.000Z', '09:00 in Israel');
    assert(due.reminderDueAt({ start: '2026-10-15' }, IL).toISOString() === '2026-10-15T06:00:00.000Z', '09:00 on the home');
  });

  // ============ The person's clock ============

  const HARISH_DAY = '2026-10-28';

  await check('clock: Harish, 10 minutes before the latest time for Shema (GRA), 2026-10-28, is 08:27 (the plan\'s example), counted at the person\'s own place with the elevation, and equals the calculator', async () => {
    const clock = await times.buildZmanClock(asUser(user()), IL);
    assert(clock !== null && clock.source === 'saved', 'a clock at the saved place');
    const at = clock.instant(HARISH_DAY, SHEMA_GRA_10_BEFORE);
    assert(hm(at) === '08:27', `at ${hm(at)}`);
    const direct = compute.zmanInstant(HARISH_DAY, SHEMA_GRA_10_BEFORE as import('../src/services/zmanim/compute').ZmanSpec, { latitude: 32.46182, longitude: 35.04555, elevationM: 270, timeZone: IL }, 'sephardi');
    assert(at !== null && direct !== null && at.getTime() === direct.getTime(), 'the clock gives zmanInstant\'s answer');
    // Two halachic hours after sunrise, and an offset after.
    const hours = clock.instant(HARISH_DAY, { halachicHours: 3, offsetMin: 0 });
    assert(hours !== null && hm(hours) === '08:37', `3 halachic hours ${hm(hours)}`);
  });

  await check('clock: two people in different cities get two times for the same rule and date; a person\'s community changes the set', async () => {
    const eilat = await times.buildZmanClock(asUser(user({ id: 2, latitude: 29.5577, longitude: 34.9519, elevationM: 10 })), IL);
    const harish = await times.buildZmanClock(asUser(user()), IL);
    const a = harish!.instant(HARISH_DAY, SHEMA_GRA_10_BEFORE);
    const b = eilat!.instant(HARISH_DAY, SHEMA_GRA_10_BEFORE);
    assert(a !== null && b !== null && a.getTime() !== b.getTime(), `Harish ${hm(a)} and Eilat ${hm(b)} should differ`);
    const ashkenazi = await times.buildZmanClock(asUser(user({ zmanimCommunity: 'ashkenazi' })), IL);
    const mga = ashkenazi!.instant(HARISH_DAY, { zman: 'SOF_SHMA_MGA', offsetMin: 0 });
    const sephardiMga = harish!.instant(HARISH_DAY, { zman: 'SOF_SHMA_MGA', offsetMin: 0 });
    assert(mga !== null && sephardiMga !== null && mga.getTime() !== sephardiMga.getTime(), 'the sets give other times');
    // Chabad's own set has no Magen Avraham, but a reminder by it that a Chabad reader is handed (a partner's "for both", or their own from
    // before they switched) still has a time: the nearest set that has the zman counts it (the next check pins which).
    const chabad = await times.buildZmanClock(asUser(user({ zmanimCommunity: 'chabad' })), IL);
    assert(chabad!.instant(HARISH_DAY, { zman: 'SOF_SHMA_MGA', offsetMin: 0 }) !== null, 'a Chabad reader still gets a Magen Avraham time');
  });

  await check('clock: a zman the reader\'s own set lacks is counted by the nearest set that has it, at the READER\'S place, with that set\'s opinion (a partner in another community, or a community switched after the reminder was made, still gets a time)', async () => {
    const harish = { latitude: 32.46182, longitude: 35.04555, elevationM: 270, timeZone: IL };
    // [reader, zman, the set that counts it, its opinion]
    type Community = import('../src/services/zmanim/sets').ZmanimCommunity;
    const cases: Array<[Community, string, Community, string | null]> = [
      ['ashkenazi', 'PLAG_YALKUT_YOSEF', 'sephardi', 'yalkutYosef'],
      ['chabad', 'PLAG_YALKUT_YOSEF', 'sephardi', 'yalkutYosef'],
      ['ashkenazi', 'PLAG_HALACHA_BERURA', 'sephardi', 'halachaBerura'],
      ['ashkenazi', 'TZEIT_LECHUMRA', 'sephardi', null],
      ['chabad', 'TZEIT_LECHUMRA', 'sephardi', null],
      ['chabad', 'SOF_SHMA_MGA', 'ashkenazi', 'mga'],
      ['sephardi', 'PLAG_GRA', 'ashkenazi', 'gra'],
    ];
    for (const [reader, zman, counting, opinion] of cases) {
      const clock = await times.buildZmanClock(asUser(user({ zmanimCommunity: reader })), IL);
      const at = clock!.instant(HARISH_DAY, { zman, offsetMin: -10 });
      const want = compute.zmanInstant(HARISH_DAY, { zman, offsetMin: -10 } as import('../src/services/zmanim/compute').ZmanSpec, harish, counting);
      assert(at !== null && want !== null && at.getTime() === want.getTime(), `${reader} reader, ${zman}: ${at?.toISOString()} but the ${counting} set gives ${want?.toISOString()}`);
      assert(clock!.opinion(zman) === opinion, `${reader} reader, ${zman}: opinion ${show(clock!.opinion(zman))}, want ${show(opinion)}`);
    }
    // The reader's own set still wins where it has the zman: an Ashkenazi reader's Magen Avraham is the Ashkenazi one, not the Sephardi one.
    const own = await times.buildZmanClock(asUser(user({ zmanimCommunity: 'ashkenazi' })), IL);
    const ashkenaziMga = compute.zmanInstant(HARISH_DAY, { zman: 'SOF_SHMA_MGA', offsetMin: 0 }, harish, 'ashkenazi');
    assert(own!.instant(HARISH_DAY, { zman: 'SOF_SHMA_MGA', offsetMin: 0 })?.getTime() === ashkenaziMga?.getTime(), 'the reader\'s own set counts what it has');
    assert(sets.communityCounting('SOF_SHMA_GRA', 'chabad') === 'chabad' && sets.communityCounting('PLAG_GRA', 'chabad') === 'chabad', 'Chabad\'s own GRA keys are Chabad\'s');
    // A zman no set has: nothing counts it.
    assert(sets.communityCounting('SHABBAT_ENDS', 'ashkenazi') === 'ashkenazi' && sets.communityCounting('NOT_A_ZMAN' as never, 'sephardi') === null, 'no set, no counting community');
  });

  await check('clock: the opinion a person\'s set names a zman with (Sephardi GRA keys are the GRA\'s, Chabad\'s the Baal HaTanya\'s; no opinion for a zman without one)', async () => {
    const sephardi = await times.buildZmanClock(asUser(user()), IL);
    const chabad = await times.buildZmanClock(asUser(user({ zmanimCommunity: 'chabad' })), IL);
    assert(sephardi!.opinion('SOF_SHMA_GRA') === 'gra' && sephardi!.opinion('SOF_SHMA_MGA') === 'mga' && sephardi!.opinion('PLAG_YALKUT_YOSEF') === 'yalkutYosef', 'Sephardi');
    assert(chabad!.opinion('SOF_SHMA_GRA') === 'baalHatanya' && chabad!.opinion('PLAG_GRA') === 'baalHatanya', 'Chabad');
    assert(sephardi!.opinion('CHATZOT') === null && sephardi!.opinion('NOT_A_ZMAN') === null, 'none');
  });

  await check('clock: with no saved place the zone\'s main city stands in (Jerusalem for Israel), logged once a day; a zone with no main city has no clock, logged; a place name that cannot be found is not fetched by the smoke', async () => {
    times.__resetZmanClockForTests();
    const bare = user({ id: 3, location: '', latitude: null, longitude: null, elevationM: null });
    const first = await logged(() => times.buildZmanClock(asUser(bare), IL));
    assert(first.value !== null && first.value.source === 'zone', 'a clock for the main city');
    assert(first.lines.filter((l) => l.includes('main city of Asia/Jerusalem')).length === 1, `logged: ${show(first.lines)}`);
    const jerusalem = first.value!.instant(HARISH_DAY, { zman: 'SHKIA', offsetMin: 0 });
    assert(jerusalem !== null && hm(jerusalem).startsWith('16:'), `Jerusalem sunset ${hm(jerusalem)}`);
    const again = await logged(() => times.buildZmanClock(asUser(bare), IL));
    assert(again.lines.length === 0, `a second clock logs nothing the same day: ${show(again.lines)}`);
    const nowhere = await logged(() => times.buildZmanClock(asUser({ ...bare, id: 4 }), 'Pacific/Auckland'));
    assert(nowhere.value === null && nowhere.lines.some((l) => l.includes('has no main city') && l.includes('4')), `no clock: ${show(nowhere.lines)}`);
  });

  await check('clock: a zman that does not exist that day is null, logged ONCE however often it is asked (the pass ticks every minute), and a rule this build does not know is null and logged', async () => {
    times.__resetZmanClockForTests();
    const svalbard = await times.buildZmanClock(asUser(user({ id: 5, latitude: 78.22, longitude: 15.65, elevationM: 0, zmanimCommunity: 'ashkenazi' })), 'Arctic/Longyearbyen');
    const result = await logged(() => [1, 2, 3].map(() => svalbard!.instant('2026-06-21', { zman: 'SOF_SHMA_GRA', offsetMin: 0 })));
    assertSame(result.value, [null, null, null], 'no sunrise in the midnight sun');
    assert(result.lines.filter((l) => l.startsWith('[zmanim]')).length === 1, `logged ${result.lines.length} times: ${show(result.lines)}`);
    const unknown = await logged(() => svalbard!.instant('2026-06-21', { zman: 'NOT_A_ZMAN', offsetMin: 0 }));
    assert(unknown.value === null && unknown.lines.some((l) => l.includes('not one this build knows')), `unknown: ${show(unknown.lines)}`);
  });

  await check('clock: the light facade never throws: a failure to build is logged and captured, and reads as no clock', async () => {
    const before = captured.length;
    const broken = { id: 6, get latitude(): number { throw new Error('boom'); } } as unknown as Parameters<typeof clockMod.zmanClockFor>[0];
    const result = await logged(() => clockMod.zmanClockFor(broken, IL));
    assert(result.value === null, 'no clock');
    assert(captured.length === before + 1 && captured[captured.length - 1].context === 'zmanim-clock', 'captured');
    assert(result.lines.some((l) => l.includes('[zmanim] could not build the zman clock of user 6')), `logged: ${show(result.lines)}`);
    assert((await clockMod.zmanClockIfNeeded(false, asUser(user()), IL)) === null, 'not needed: no clock, no work');
    assert((await clockMod.zmanClockIfNeeded(true, asUser(user()), IL)) !== null, 'needed: a clock');
  });

  await check('editor info: the community\'s zmanim in the order of the day (no end of Shabbat), today\'s time of each, the 12 hours, and where the times are counted from', async () => {
    times.__resetZmanClockForTests();
    const info = await times.zmanEditorInfo(asUser(user()), IL, HARISH_DAY);
    assert(info.community === 'sephardi' && info.place === 'saved' && info.day === HARISH_DAY, `${info.community} ${info.place} ${info.day}`);
    assertSame(info.zmanim.map((z) => z.key), spec.reminderZmanim('sephardi'), 'the keys');
    const shema = info.zmanim.find((z) => z.key === 'SOF_SHMA_GRA')!;
    assert(shema.opinion === 'gra' && hm(new Date(shema.at!)) === '08:37', `Shema GRA ${shema.opinion} ${shema.at}`);
    assert(info.zmanim.find((z) => z.key === 'CHATZOT')!.opinion === null, 'midday has no opinion');
    assert(info.hours.length === 12 && hm(new Date(info.hours[2]!)) === '08:37', `3 hours ${info.hours[2]}`);
    const zone = await times.zmanEditorInfo(asUser(user({ id: 7, location: '', latitude: null, longitude: null })), IL, HARISH_DAY);
    assert(zone.place === 'zone' && zone.zmanim.every((z) => z.at !== null), 'main city: times, place zone');
    const none = await times.zmanEditorInfo(asUser(user({ id: 8, location: '', latitude: null, longitude: null })), 'Pacific/Auckland', HARISH_DAY);
    assert(none.place === 'none' && none.zmanim.length > 0 && none.zmanim.every((z) => z.at === null) && none.hours.every((h) => h === null), 'no place: the list, no times');
    const chabad = await times.zmanEditorInfo(asUser(user({ id: 9, zmanimCommunity: 'chabad' })), IL, HARISH_DAY);
    assert(!chabad.zmanim.some((z) => z.key === 'SOF_SHMA_MGA') && chabad.zmanim.find((z) => z.key === 'SOF_SHMA_GRA')!.opinion === 'baalHatanya', 'Chabad\'s list and opinion');
  });

  // ============ The editor's model ============

  const ZMANIM_INFO: import('../src/lib/calendar-view/zman-spec').ZmanimInfo = {
    community: 'sephardi', place: 'saved', day: HARISH_DAY,
    zmanim: [
      { key: 'ALOT', opinion: null, at: '2026-10-28T02:44:00.000Z' },
      { key: 'SOF_SHMA_GRA', opinion: 'gra', at: '2026-10-28T06:37:00.000Z' },
      { key: 'SHKIA', opinion: null, at: null },
    ],
    hours: Array.from({ length: 12 }, (_, i) => `2026-10-28T${String(4 + i).padStart(2, '0')}:00:00.000Z`),
  };
  const baseNew = () =>
    model.newItemForm({ today: HARISH_DAY, pickedDay: null, nowMs: Date.parse('2026-10-28T10:00:00Z'), tz: IL, kinds: { event: true, reminder: true }, calendars: [] });
  const newReminder = (over: Partial<Form> = {}): Form => ({ ...baseNew(), kind: 'reminder', title: 'Take the pill', startDay: '2026-10-29', ...over });
  const reminderInfo = (over: Partial<Info> = {}, series: Partial<Info['series']> = {}, occ: Partial<Info['occurrence']> = {}): Info => ({
    kind: 'reminder', canEdit: true, canDelete: true,
    occurrence: { start: '2026-10-29', end: '2026-10-29', allDay: true, title: 'Take the pill', location: '', description: '', ...occ },
    series: { recurring: true, start: '2026-10-29', repeat: { freq: 'daily', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: IL, rule: { choice: 'daily' }, spec: { freq: 'daily', interval: 1 }, first: true, ...series },
    tz: IL, calendar: { id: 'native:c', name: 'Mine', color: null }, forName: null, scopes: ['single', 'following', 'all'], forWho: 'me', eachMarksDone: false, source: 'famcal', ...over,
  });

  await check('model: a new reminder starts as a plain time; turning By zman on picks the latest time for Shema (GRA) (else the set\'s first), off keeps the pick', () => {
    const form = newReminder();
    assert(form.timeMode === 'time' && form.zmanPick === '' && form.zmanMinutes === 0 && form.zmanBefore === true && form.zmanHours === 3, `defaults ${show([form.timeMode, form.zmanPick, form.zmanMinutes, form.zmanBefore, form.zmanHours])}`);
    const on = model.setTimeMode(form, 'zman', ZMANIM_INFO);
    assert(on.timeMode === 'zman' && on.zmanPick === 'SOF_SHMA_GRA', `on: ${on.timeMode} ${on.zmanPick}`);
    const first = model.setTimeMode(form, 'zman', { ...ZMANIM_INFO, zmanim: ZMANIM_INFO.zmanim.slice(2) });
    assert(first.zmanPick === 'SHKIA', 'the first when the set lacks the Shema');
    const none = model.setTimeMode(form, 'zman', undefined);
    assert(none.zmanPick === 'hours', 'no info: halachic hours');
    const off = model.setTimeMode({ ...on, zmanPick: 'ALOT' }, 'time', ZMANIM_INFO);
    assert(off.timeMode === 'time' && off.zmanPick === 'ALOT', 'off keeps the pick');
    assert(model.setTimeMode(on, 'zman', ZMANIM_INFO) === on, 'same mode: the same form');
  });

  await check('model: the create body of a reminder by zman is date-only with timeMode and the rule (before is negative); a plain reminder sends neither', () => {
    const zman = newReminder({ timeMode: 'zman', zmanPick: 'SOF_SHMA_GRA', zmanMinutes: 10, zmanBefore: true, allDay: false, startTime: '17:30' });
    const body = model.createBody(zman);
    assert(body.allDay === true && body.start === '2026-10-29' && body.timeMode === 'zman', `body ${show(body)}`);
    assertSame(body.zmanSpec, { zman: 'SOF_SHMA_GRA', offsetMin: -10 }, 'the rule');
    const after = model.createBody({ ...zman, zmanBefore: false });
    assertSame(after.zmanSpec, { zman: 'SOF_SHMA_GRA', offsetMin: 10 }, 'after');
    for (const before of [true, false]) {
      const zero = model.createBody({ ...zman, zmanMinutes: 0, zmanBefore: before });
      assert(Object.is((zero.zmanSpec as { offsetMin: number }).offsetMin, 0), `zero minutes is a plain 0 either way (before ${before})`);
    }
    const hours = model.createBody({ ...zman, zmanPick: 'hours', zmanHours: 4, zmanMinutes: 5 });
    assertSame(hours.zmanSpec, { halachicHours: 4, offsetMin: -5 }, 'hours');
    const plain = model.createBody(newReminder({ allDay: false, startTime: '17:30' }));
    assert(plain.allDay === false && plain.start === '2026-10-29T17:30' && !('timeMode' in plain) && !('zmanSpec' in plain), `plain ${show(plain)}`);
    const leftOver = model.createBody(newReminder({ zmanPick: 'CHATZOT', timeMode: 'time' }));
    assert(!('zmanSpec' in leftOver), 'a pick left behind in time mode is not sent');
    const ev = model.createBody({ ...baseNew(), kind: 'event', title: 'x', timeMode: 'zman', zmanPick: 'CHATZOT' });
    assert(!('zmanSpec' in ev) && !('timeMode' in ev), 'an event never carries one');
  });

  await check('model: an edit info becomes the form (mode, pick, hours, minutes and direction); an occurrence moved to a time of its own opens in time mode with the series\' rule kept', () => {
    const f = model.editItemForm(reminderInfo({ timeMode: 'zman', zmanSpec: { zman: 'SOF_SHMA_GRA', offsetMin: -10 } }));
    assert(f.timeMode === 'zman' && f.zmanPick === 'SOF_SHMA_GRA' && f.zmanMinutes === 10 && f.zmanBefore === true && f.allDay === true, `form ${show([f.timeMode, f.zmanPick, f.zmanMinutes, f.zmanBefore])}`);
    const after = model.editItemForm(reminderInfo({ timeMode: 'zman', zmanSpec: { zman: 'CHATZOT', offsetMin: 25 } }));
    assert(after.zmanBefore === false && after.zmanMinutes === 25, 'after');
    const hours = model.editItemForm(reminderInfo({ timeMode: 'zman', zmanSpec: { halachicHours: 5, offsetMin: 0 } }));
    assert(hours.zmanPick === 'hours' && hours.zmanHours === 5 && hours.zmanBefore === true, 'hours');
    const moved = model.editItemForm(reminderInfo({ timeMode: 'time', zmanSpec: { zman: 'CHATZOT', offsetMin: 0 } }, {}, { allDay: false, start: '2026-10-29T14:00', end: '2026-10-29T14:00' }));
    assert(moved.timeMode === 'time' && moved.zmanPick === 'CHATZOT', 'time mode, rule kept');
    const plain = model.editItemForm(reminderInfo());
    assert(plain.timeMode === 'time' && plain.zmanPick === '', 'a plain reminder');
  });

  const zmanInfo = reminderInfo({ timeMode: 'zman', zmanSpec: { zman: 'SOF_SHMA_GRA', offsetMin: -10 } });
  const zmanForm = () => model.editItemForm(zmanInfo);

  await check('model: the update body names only what changed: a new offset sends the mode and the whole rule; an unchanged rule sends nothing; By zman off sends mode time alone', () => {
    const initial = zmanForm();
    assert(model.updateBody(initial, initial, 'k', 'all', zmanInfo) === null, 'nothing changed');
    const longer = model.updateBody({ ...initial, zmanMinutes: 15 }, initial, 'k', 'all', zmanInfo);
    assertSame(longer?.changes, { timeMode: 'zman', zmanSpec: { zman: 'SOF_SHMA_GRA', offsetMin: -15 } }, 'a new offset');
    const flipped = model.updateBody({ ...initial, zmanBefore: false }, initial, 'k', 'all', zmanInfo);
    assertSame(flipped?.changes, { timeMode: 'zman', zmanSpec: { zman: 'SOF_SHMA_GRA', offsetMin: 10 } }, 'after instead');
    const other = model.updateBody({ ...initial, zmanPick: 'hours', zmanHours: 2 }, initial, 'k', 'all', zmanInfo);
    assertSame(other?.changes, { timeMode: 'zman', zmanSpec: { halachicHours: 2, offsetMin: -10 } }, 'hours');
    const off = model.updateBody({ ...initial, timeMode: 'time' }, initial, 'k', 'all', zmanInfo);
    assertSame(off?.changes, { timeMode: 'time' }, 'off: the all-day form stays all-day, so no time moves');
    const title = model.updateBody({ ...initial, title: 'Other' }, initial, 'k', 'single', zmanInfo);
    assertSame(title?.changes, { title: 'Other' }, 'a title alone sends no zman field');
    const moveDay = model.updateBody({ ...initial, startDay: '2026-10-30' }, initial, 'k', 'single', zmanInfo);
    assertSame(moveDay?.changes, { start: '2026-10-30' }, 'a date move keeps it by zman and sends no mode');
  });

  await check('model: turning By zman on for a timed reminder sends allDay true and a date-only start with the rule; turning it off with a time sends the time', () => {
    const timedInfo = reminderInfo({}, { recurring: false, repeat: null, rule: { choice: 'none' }, spec: undefined }, { allDay: false, start: '2026-10-29T17:30', end: '2026-10-29T17:30' });
    const initial = model.editItemForm(timedInfo);
    const on = model.updateBody(model.setTimeMode(initial, 'zman', ZMANIM_INFO), initial, 'k', 'single', timedInfo);
    assertSame(on?.changes, { allDay: true, start: '2026-10-29', timeMode: 'zman', zmanSpec: { zman: 'SOF_SHMA_GRA', offsetMin: 0 } }, 'to zman');
    const zInitial = zmanForm();
    const timed = model.updateBody({ ...zInitial, timeMode: 'time', allDay: false, startTime: '11:00' }, zInitial, 'k', 'single', zmanInfo);
    assertSame(timed?.changes, { allDay: false, start: '2026-10-29T11:00', timeMode: 'time' }, 'to a time');
  });

  await check('model scope plan: a change of the rule or the mode on a series asks "this one and the ones after" or "all" (no note about calendars); By zman off with a time of day also allows "only this one" (a fixed-time move); a date move still asks all three', () => {
    const initial = zmanForm();
    const rule = model.scopePlan({ ...initial, zmanMinutes: 20 }, initial, zmanInfo);
    assertSame(rule, { kind: 'sheet', choices: ['following', 'all'] }, 'a new rule: no series note');
    const offAllDay = model.scopePlan({ ...initial, timeMode: 'time' }, initial, zmanInfo);
    assertSame(offAllDay, { kind: 'sheet', choices: ['following', 'all'] }, 'off, still date-only');
    const offTimed = model.scopePlan({ ...initial, timeMode: 'time', allDay: false, startTime: '11:00' }, initial, zmanInfo);
    assertSame(offTimed, { kind: 'sheet', choices: ['single', 'following', 'all'] }, 'off with a time: a fixed time for one occurrence is allowed');
    const date = model.scopePlan({ ...initial, startDay: '2026-10-30' }, initial, zmanInfo);
    assertSame(date, { kind: 'sheet', choices: ['single', 'following', 'all'] }, 'a date move');
    const withRecipient = model.scopePlan({ ...initial, zmanMinutes: 20, forWho: 'both' }, initial, zmanInfo);
    assertSame(withRecipient, { kind: 'sheet', choices: ['following', 'all'], note: 'series' }, 'with a recipient change the series note stays');
    const oneOff = reminderInfo({ timeMode: 'zman', zmanSpec: { zman: 'CHATZOT', offsetMin: 0 } }, { recurring: false, repeat: null, rule: { choice: 'none' }, spec: undefined });
    const oneOffForm = model.editItemForm(oneOff);
    assertSame(model.scopePlan({ ...oneOffForm, zmanMinutes: 5 }, oneOffForm, oneOff), { kind: 'none' }, 'a one-off asks nothing');
  });

  await check('model: today\'s preview is the server\'s instant plus the offset (before is earlier), null where the zman has no time today or there is no info; the dirty check ignores a pick left behind in time mode', () => {
    const form = newReminder({ timeMode: 'zman', zmanPick: 'SOF_SHMA_GRA', zmanMinutes: 10, zmanBefore: true });
    assert(model.zmanPreviewMs(form, ZMANIM_INFO) === Date.parse('2026-10-28T06:27:00.000Z'), 'ten minutes before 08:37 (UTC 06:37)');
    assert(model.zmanPreviewMs({ ...form, zmanBefore: false }, ZMANIM_INFO) === Date.parse('2026-10-28T06:47:00.000Z'), 'after');
    assert(model.zmanPreviewMs({ ...form, zmanPick: 'hours', zmanHours: 3, zmanMinutes: 0 }, ZMANIM_INFO) === Date.parse('2026-10-28T06:00:00.000Z'), '3 halachic hours');
    assert(model.zmanPreviewMs({ ...form, zmanPick: 'SHKIA' }, ZMANIM_INFO) === null, 'no time today');
    assert(model.zmanPreviewMs({ ...form, zmanPick: 'CHATZOT' }, ZMANIM_INFO) === null, 'not in the list');
    assert(model.zmanPreviewMs(form, undefined) === null, 'no info');
    const start = newReminder();
    assert(!model.isDirty({ ...start, zmanPick: 'CHATZOT', zmanMinutes: 30 }, start), 'a pick in time mode is no edit');
    assert(model.isDirty({ ...start, timeMode: 'zman', zmanPick: 'CHATZOT' }, start), 'turning it on is');
    const z = zmanForm();
    assert(!model.isDirty(z, z) && model.isDirty({ ...z, zmanMinutes: 5 }, z), 'in zman mode the rule is compared');
    assert(model.effectiveAllDay({ ...start, timeMode: 'zman', allDay: false }) && !model.effectiveAllDay({ ...start, allDay: false }), 'a reminder by zman is date-only');
    assert(!model.effectiveAllDay({ ...start, kind: 'event', timeMode: 'zman', allDay: false }), 'an event never is');
  });

  // ============ What the server accepts ============

  const createBody = (over: Row = {}) => ({ kind: 'reminder', title: 'Take the pill', allDay: true, start: '2026-10-29', timeMode: 'zman', zmanSpec: { zman: 'SOF_SHMA_GRA', offsetMin: -10 }, ...over });

  await check('validate (create): a reminder by zman needs a date-only start and a known rule; timeMode time takes no rule; an event cannot be by zman; an unknown mode, key or a rule without the mode is refused naming the field', () => {
    const ok = validate.parseCreate(createBody());
    assert(ok.ok && ok.value.zmanSpec !== undefined && 'zman' in ok.value.zmanSpec && ok.value.zmanSpec.offsetMin === -10, `ok ${show(ok)}`);
    const hours = validate.parseCreate(createBody({ zmanSpec: { halachicHours: 3, offsetMin: 0 } }));
    assert(hours.ok && hours.value.zmanSpec !== undefined && 'halachicHours' in hours.value.zmanSpec, 'hours');
    const plain = validate.parseCreate({ kind: 'reminder', title: 'x', allDay: false, start: '2026-10-29T10:00' });
    assert(plain.ok && plain.value.zmanSpec === undefined, 'a plain reminder');
    const explicitTime = validate.parseCreate({ kind: 'reminder', title: 'x', allDay: false, start: '2026-10-29T10:00', timeMode: 'time' });
    assert(explicitTime.ok, 'timeMode time is a plain reminder');
    const fails = (body: Row) => { const r = validate.parseCreate(body); return r.ok ? 'ok' : r.field; };
    assert(fails(createBody({ allDay: false, start: '2026-10-29T10:00' })) === 'allDay', 'timed');
    assert(fails(createBody({ kind: 'event' })) === 'timeMode', 'an event');
    assert(fails(createBody({ timeMode: 'later' })) === 'timeMode', 'a mode');
    assert(fails(createBody({ zmanSpec: { zman: 'NOT_A_ZMAN', offsetMin: 0 } })) === 'zmanSpec', 'an unknown zman');
    assert(fails(createBody({ zmanSpec: undefined })) === 'zmanSpec', 'no rule');
    assert(fails(createBody({ zmanSpec: { zman: 'CHATZOT', offsetMin: 5000 } })) === 'zmanSpec', 'an offset past 12 hours');
    assert(fails(createBody({ timeMode: undefined })) === 'zmanSpec', 'a rule without the mode');
    assert(fails(createBody({ timeMode: 'time' })) === 'zmanSpec', 'a rule beside mode time');
  });

  await check('validate (update): timeMode zman brings the rule, time takes it away, a rule alone is refused, and the field is named', () => {
    const key = 'famcal|abc';
    const parse = (changes: Row) => validate.parseUpdate({ key, scope: 'all', changes });
    const zman = parse({ timeMode: 'zman', zmanSpec: { zman: 'CHATZOT', offsetMin: 5 } });
    assert(zman.ok && zman.value.changes.timeMode === 'zman' && zman.value.changes.zmanSpec?.offsetMin === 5, `zman ${show(zman)}`);
    const time = parse({ timeMode: 'time' });
    assert(time.ok && time.value.changes.timeMode === 'time' && time.value.changes.zmanSpec === undefined, 'time alone');
    const fails = (changes: Row) => { const r = parse(changes); return r.ok ? 'ok' : r.field; };
    assert(fails({ zmanSpec: { zman: 'CHATZOT', offsetMin: 5 } }) === 'timeMode', 'a rule alone');
    assert(fails({ timeMode: 'zman' }) === 'zmanSpec', 'zman without a rule');
    assert(fails({ timeMode: 'time', zmanSpec: { zman: 'CHATZOT', offsetMin: 5 } }) === 'zmanSpec', 'time with a rule');
    assert(fails({ timeMode: 'zman', zmanSpec: { zman: 'NOPE', offsetMin: 0 } }) === 'zmanSpec', 'an unknown zman');
    assert(fails({ timeMode: 'sometimes' }) === 'timeMode', 'a mode');
  });

  // ============ The words ============

  const translate = (locale: 'en' | 'he' | 'ru') =>
    createTranslator({
      locale,
      messages: JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8')),
      namespace: 'calendarHome',
      onError: (err: Error) => { throw err; },
    }) as unknown as Parameters<typeof words.zmanName>[0];

  await check('words: a zman named with its opinion, and a rule in words, in en, he and ru (the owner\'s luach terms in Hebrew)', () => {
    const en = translate('en'); const he = translate('he'); const ru = translate('ru');
    assert(words.zmanName(en, 'SOF_SHMA_GRA', 'gra') === 'Latest time for Shema (GRA)', words.zmanName(en, 'SOF_SHMA_GRA', 'gra'));
    assert(words.zmanName(he, 'SOF_SHMA_GRA', 'gra') === 'סוף זמן קריאת שמע (גר״א)', words.zmanName(he, 'SOF_SHMA_GRA', 'gra'));
    assert(words.zmanName(he, 'SOF_SHMA_MGA', 'mga') === 'סוף זמן קריאת שמע (מג״א)', 'Magen Avraham');
    assert(words.zmanName(he, 'PLAG_HALACHA_BERURA', 'halachaBerura') === 'פלג המנחה (הלכה ברורה)' && words.zmanName(he, 'PLAG_YALKUT_YOSEF', 'yalkutYosef') === 'פלג המנחה (ילקוט יוסף)', 'the two plags');
    assert(words.zmanName(he, 'TZEIT_LECHUMRA', null) === 'צאת הכוכבים לחומרא' && words.zmanName(he, 'CHATZOT_HALAYLA', null) === 'חצות הלילה' && words.zmanName(he, 'CANDLE_LIGHTING', null) === 'הדלקת נרות', 'plain names');
    assert(words.zmanRuleWords(en, SHEMA_GRA_10_BEFORE, 'gra') === '10 min before the latest time for Shema (GRA)', words.zmanRuleWords(en, SHEMA_GRA_10_BEFORE, 'gra'));
    assert(words.zmanRuleWords(he, SHEMA_GRA_10_BEFORE, 'gra') === '10 דק׳ לפני סוף זמן קריאת שמע (גר״א)', words.zmanRuleWords(he, SHEMA_GRA_10_BEFORE, 'gra'));
    assert(words.zmanRuleWords(ru, SHEMA_GRA_10_BEFORE, 'gra') === 'за 10 мин до конца времени Шма (ГРА)', words.zmanRuleWords(ru, SHEMA_GRA_10_BEFORE, 'gra'));
    assert(words.zmanRuleWords(en, { zman: 'SHKIA', offsetMin: 15 }, null) === '15 min after sunset' && words.zmanRuleWords(ru, { zman: 'SHKIA', offsetMin: 15 }, null) === 'через 15 мин после заката (шкия)', 'after');
    assert(words.zmanRuleWords(en, { zman: 'CHATZOT', offsetMin: 0 }, null) === 'Midday (chatzot)' && words.zmanRuleWords(he, { zman: 'CHATZOT', offsetMin: 0 }, null) === 'חצות היום', 'no offset: the name alone');
    assert(words.zmanRuleWords(en, { halachicHours: 3, offsetMin: 0 }, null) === '3 halachic hours after sunrise' && words.zmanRuleWords(en, { halachicHours: 1, offsetMin: 0 }, null) === '1 halachic hour after sunrise', 'hours');
    assert(words.zmanRuleWords(he, { halachicHours: 1, offsetMin: 0 }, null) === 'שעה זמנית אחת אחרי הנץ החמה' && words.zmanRuleWords(he, { halachicHours: 2, offsetMin: 0 }, null) === 'שעתיים זמניות אחרי הנץ החמה' && words.zmanRuleWords(he, { halachicHours: 5, offsetMin: -10 }, null) === '10 דק׳ לפני 5 שעות זמניות אחרי הנץ החמה', 'Hebrew hours');
    assert(words.zmanRuleWords(ru, { halachicHours: 3, offsetMin: -5 }, null).startsWith('за 5 мин до 3 галахических часов после восхода'), words.zmanRuleWords(ru, { halachicHours: 3, offsetMin: -5 }, null));
    // Every key a set can store has a name (and an after-form) in each language.
    for (const lang of [en, he, ru]) for (const key of sets.ZMAN_KEYS.filter((k) => k !== 'SHABBAT_ENDS')) {
      assert(words.zmanName(lang, key, null).length > 0 && words.zmanName(lang, key, null, true).length > 0, `a name for ${key}`);
    }
  });

  const copy = (locale: 'en' | 'he' | 'ru') => translate(locale) as unknown as (key: string) => string;

  await check('words (review): the Yalkut Yosef plag is "Ялкут Йосеф" in Russian, as Russian-speaking readers know the book', () => {
    assert(copy('ru')('zmanim.opinions.yalkutYosef') === 'Ялкут Йосеф', copy('ru')('zmanim.opinions.yalkutYosef'));
    assert(words.zmanName(translate('ru'), 'PLAG_YALKUT_YOSEF', 'yalkutYosef').endsWith('(Ялкут Йосеф)'), words.zmanName(translate('ru'), 'PLAG_YALKUT_YOSEF', 'yalkutYosef'));
  });

  await check('words (review): the editor\'s Hebrew switch and row say "זמן הלכתי", since a bare "לפי זמן" next to "מתי" reads as "by time"', () => {
    assert(copy('he')('editor.byZman') === 'לפי זמן הלכתי', copy('he')('editor.byZman'));
    assert(copy('he')('editor.zmanLabel') === 'זמן הלכתי', copy('he')('editor.zmanLabel'));
  });

  // ============ The migration ============

  await check('migration: NativeEvent.zmanSpec is one additive, idempotent JSONB column, matching the schema', () => {
    const schema = readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    assert(/zmanSpec\s+Json\?/.test(schema), 'schema.prisma lacks zmanSpec Json?');
    const sql = readFileSync(path.join(ROOT, 'prisma/migrations/20261028020000_reminder_zman_spec/migration.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    assert(sql === 'ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "zmanSpec" JSONB;', `the migration: ${sql}`);
  });

  await check('server only: no file the Mini App bundles imports the zmanim module (the client gets computed times in the DTO)', () => {
    const files = ['app/[locale]/dashboard/EditorSheet.tsx', 'app/[locale]/dashboard/ItemRow.tsx', 'app/[locale]/dashboard/ItemSheet.tsx', 'app/[locale]/dashboard/zman-words.ts', 'app/[locale]/dashboard/CalendarHome.tsx',
      'src/lib/calendar-view/editor-model.ts', 'src/lib/calendar-view/editor-types.ts', 'src/lib/calendar-view/editor-client.ts', 'src/lib/calendar-view/types.ts', 'src/lib/calendar-view/zman-spec.ts'];
    for (const file of files) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      assert(!/services\/zmanim|@hebcal/.test(text.split('\n').filter((l) => /^\s*(import|export)\b.*from/.test(l)).join('\n')), `${file} imports the zmanim module`);
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

if (process.env[CHILD]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  void runChildren();
}
