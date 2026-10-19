// Smoke test for the reminder rules in src/services/native-calendar/event-store.ts, the
// one place every native write goes through. A reminder is an event with no length
// (spec §1): it must stay zero-length however an edit sends its end, a change of its
// time must re-arm it (its done/snoozed/pinged state goes, and its live pings come
// back so their buttons can be stripped), a "from now on" split must keep it the
// creator's reminder for the same person, and its creator and the person it is for get
// the rights the calendar alone would not give them. Events must behave as before.
// Prisma is an in-memory stand-in; the due gate and the ownership helpers are real.
// No network, no database.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-store.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-store.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { expandSeries } from '../src/services/native-calendar/recurrence';
import { __resetDueGateForTests, setNextDue, shouldRunPass } from '../src/services/native-reminders/due-gate';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void>) {
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

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
/** A wall-clock time in `tz`, e.g. '2026-10-14 08:00'. */
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

// ---- Prisma, in memory ----
// Just what the store, onboarding and the ownership helpers ask of it: the where
// operators they use, compound unique keys, select, orderBy, Prisma's column defaults,
// and a $transaction that rolls back when its callback throws.

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const tables: Record<string, Row[]> = {};
const COMPOUND_KEYS: Record<string, string[]> = { seriesEventId_originalStartsAt: ['seriesEventId', 'originalStartsAt'] };
const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], personName: null, personEnglishName: null, personGender: null, rules: [], privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, exdates: [], reminderMinutes: null, isDeleted: false, kind: 'EVENT', forUserId: null, armedAt: null }),
  nativeEventInstance: () => ({ title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null }),
  nativeReminderState: () => ({ doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null }),
};
let nextId = 0;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key in COMPOUND_KEYS) return matches(row, cond as Where);
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some((a) => same(value, a));
        case 'not': return !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        case 'lte': return value != null && (value as Date) <= (arg as Date);
        case 'gt': return value != null && (value as Date) > (arg as Date);
        case 'gte': return value != null && (value as Date) >= (arg as Date);
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

/** Prisma skips undefined fields and appends on { push }. */
function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const push = value !== null && typeof value === 'object' && Object.hasOwn(value, 'push');
    row[key] = push ? [...(row[key] as unknown[]), (value as { push: unknown }).push] : value;
  }
  row.updatedAt = new Date();
}

function table(name: string) {
  const find = (where?: Where) => tables[name].filter((r) => !where || matches(r, where));
  const insert = (data: Row) => {
    const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date() };
    apply(row, data);
    tables[name].push(row);
    return { ...row };
  };
  type Args = { where?: Where; select?: Record<string, boolean>; orderBy?: Array<Record<string, 'asc' | 'desc'>>; data?: Row; create?: Row; update?: Row };
  return {
    findUnique: async ({ where, select }: Args) => pick(find(where)[0], select),
    findFirst: async ({ where, select }: Args) => pick(find(where)[0], select),
    findMany: async ({ where, select, orderBy = [] }: Args = {}) => {
      const rows = [...find(where)];
      for (const order of [...orderBy].reverse()) {
        const [[key, dir]] = Object.entries(order);
        rows.sort((a, b) => ((a[key] as Date) > (b[key] as Date) ? 1 : (a[key] as Date) < (b[key] as Date) ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return rows.map((r) => pick(r, select));
    },
    create: async ({ data }: Args) => insert(data!),
    update: async ({ where, data }: Args) => {
      const row = find(where)[0];
      if (!row) throw new Error(`stand-in ${name}.update: no row matches ${JSON.stringify(where)}`);
      apply(row, data!);
      return { ...row };
    },
    upsert: async ({ where, create, update }: Args) => {
      const row = find(where)[0];
      if (!row) return insert(create!);
      apply(row, update!);
      return { ...row };
    },
    updateMany: async ({ where, data }: Args) => {
      const rows = find(where);
      rows.forEach((r) => apply(r, data!));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Args) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !where || !matches(r, where));
      return { count: before - tables[name].length };
    },
  };
}

const fakePrisma: Record<string, unknown> = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(tables);
    try {
      return await fn(fakePrisma);
    } catch (err) {
      Object.assign(tables, snapshot);
      throw err;
    }
  },
};
for (const name of ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'nativeReminderState']) {
  tables[name] = [];
  fakePrisma[name] = table(name);
}

// ---- The family ----
// Raziel (1) and Dana (2) are paired. Noa (4) and Avi (5) were, until they unlinked
// (unlinking clears both pairingIds). Lior (6) is paired with Maya (7), who moved to
// Google and keeps the ACTIVE pairing. The stranger (3) knows nobody.

const OLD_ARMED = new Date('2026-10-01T06:00:00Z');
let testStarted = 0;
/** Set by this write: not before the check began. */
const fresh = (d: unknown) => d instanceof Date && d.getTime() >= testStarted;

function user(id: number, name: string, pairingId: string | null, calendarSource = 'NATIVE'): Row {
  return { id, name, englishName: name, gender: 'female', language: 'en', calendarSource, telegramId: BigInt(1000 + id), pairingId };
}

function calendar(id: string, ownerUserId: number, privacy: string, labels: string[], createdAt = '2026-01-01T00:00:00Z'): Row {
  return { ...DEFAULTS.nativeCalendar(), id, ownerUserId, name: id, privacy, labels, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) };
}

/** A NativeEvent row as an earlier write left it: an hour-long event, or a reminder armed on Oct 1. */
function seedEvent(id: string, fields: Row): Row {
  const row: Row = { ...DEFAULTS.nativeEvent(), id, timeZone: IL, createdAt: OLD_ARMED, updatedAt: OLD_ARMED, ...fields };
  if (row.kind === 'REMINDER') row.armedAt ??= OLD_ARMED;
  row.endsAt ??= row.kind === 'REMINDER' ? row.startsAt : new Date((row.startsAt as Date).getTime() + 60 * 60_000);
  tables.nativeEvent.push(row);
  return row;
}

/** A state row: an occurrence that was pinged, snoozed or done, with its ping message when one was sent. */
function seedState(seriesEventId: string, originalStartsAt: Date, pingMessageId: number | null, fields: Row = {}) {
  tables.nativeReminderState.push({
    ...DEFAULTS.nativeReminderState(), id: `state-${++nextId}`, seriesEventId, originalStartsAt,
    lastPingedAt: originalStartsAt, pingAttempts: 1,
    pingChatId: pingMessageId === null ? null : 5001n, pingMessageId,
    createdAt: originalStartsAt, updatedAt: originalStartsAt, ...fields,
  });
}

function reset() {
  tables.user = [
    user(1, 'Raziel', 'p1'), user(2, 'Dana', 'p1'), user(3, 'Stranger', null),
    user(4, 'Noa', null), user(5, 'Avi', null), user(6, 'Lior', 'p3'), user(7, 'Maya', 'p3', 'GOOGLE'),
  ];
  tables.pairing = [
    { id: 'p1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 },
    { id: 'p2', status: 'UNLINKED', inviterUserId: 4, inviteeUserId: 5 },
    { id: 'p3', status: 'ACTIVE', inviterUserId: 6, inviteeUserId: 7 },
  ];
  tables.nativeCalendar = [
    calendar('raziel', 1, 'SHARED_EDITOR', ['primary', 'yours']),
    calendar('dana', 2, 'PRIVATE', ['primary', 'yours']),
    calendar('dana-view', 2, 'SHARED_VIEWER', ['kids']),
    calendar('avi', 5, 'PRIVATE', ['primary', 'yours']),
    calendar('lior', 6, 'PRIVATE', ['primary', 'yours']),
  ];
  tables.nativeEvent = [];
  tables.nativeEventInstance = [];
  tables.nativeReminderState = [];
  testStarted = Date.now();
}

const eventRow = (id: string) => tables.nativeEvent.find((r) => r.id === id)!;
const stateKeys = (seriesId: string) =>
  tables.nativeReminderState.filter((r) => r.seriesEventId === seriesId).map((r) => iso(r.originalStartsAt)).sort();
const pings = (cleared: Array<{ chatId: bigint; messageId: number }>) => cleared.map((p) => `${p.chatId}/${p.messageId}`).sort().join(', ');

/** Close the due gate as a pass would leave it, so a write that clears it shows. */
function closeGate() {
  __resetDueGateForTests();
  setNextDue(new Date(Date.now() + 30 * 60_000), new Date());
  assert(!shouldRunPass(new Date()), 'the due gate did not close');
}
const gateCleared = () => shouldRunPass(new Date());

async function refused(what: string, write: () => Promise<unknown>) {
  const outcome = await write().then(() => 'allowed', (err: Error) => err.name);
  assert(outcome === 'NativePermissionDeniedError', `${what}: ${outcome}`);
}

async function main() {
  // The store reads src/utils/prisma; the stand-in goes into require's cache before the
  // store loads, as smoke-week-lookahead.ts does for its stubs.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const prismaFile = path.resolve(__dirname, '../src/utils/prisma.ts');
  const prismaModule = new Module(prismaFile);
  Object.assign(prismaModule, { filename: prismaFile, loaded: true, exports: { prisma: fakePrisma } });
  Module._cache[prismaFile] = prismaModule;

  const store = await import('../src/services/native-calendar/event-store');
  const { normalizeReminderTimes, createNativeEvent, updateNativeEvent, deleteNativeEvent, getMainNativeCalendar, encodeEventId } = store;

  // ---- normalizeReminderTimes ----

  await check('normalize: a timed reminder starts and ends at the same instant', async () => {
    const t = at('2026-10-20 17:30');
    const r = normalizeReminderTimes(t, false, IL);
    assert(iso(r.startsAt) === iso(t) && iso(r.endsAt) === iso(t), `got ${iso(r.startsAt)} - ${iso(r.endsAt)}`);
  });

  await check('normalize: a date-only reminder sits at 00:00 of its own local day, not the UTC one', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['Jerusalem afternoon', IL, '2026-10-20 15:00', '2026-10-19T21:00:00.000Z'],
      ['Jerusalem 00:30 (still the 19th in UTC)', IL, '2026-10-20 00:30', '2026-10-19T21:00:00.000Z'],
      ['New York 22:30 (already the 21st in UTC)', NY, '2026-10-20 22:30', '2026-10-20T04:00:00.000Z'],
      ['already at local midnight', NY, '2026-10-20 00:00', '2026-10-20T04:00:00.000Z'],
    ];
    for (const [label, tz, local, want] of cases) {
      const r = normalizeReminderTimes(at(local, tz), true, tz);
      assert(iso(r.startsAt) === want && iso(r.endsAt) === want, `${label}: got ${iso(r.startsAt)} - ${iso(r.endsAt)}, want ${want}`);
    }
  });

  await check('normalize: DST days (Jerusalem 25h and 23h, New York 25h) start at their own 00:00', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['Jerusalem 2026-10-25 (clocks back)', IL, '2026-10-25 23:30', '2026-10-24T21:00:00.000Z'],
      ['Jerusalem 2027-03-26 (clocks forward)', IL, '2027-03-26 20:00', '2027-03-25T22:00:00.000Z'],
      ['New York 2026-11-01 (clocks back)', NY, '2026-11-01 22:00', '2026-11-01T04:00:00.000Z'],
    ];
    for (const [label, tz, local, want] of cases) {
      const r = normalizeReminderTimes(at(local, tz), true, tz);
      assert(iso(r.startsAt) === want && iso(r.endsAt) === want, `${label}: got ${iso(r.startsAt)}, want ${want}`);
    }
  });

  // ---- createNativeEvent ----

  await check('create: a reminder is zero-length, armed, for its person, and clears the due gate', async () => {
    reset();
    closeGate();
    const created = await createNativeEvent({
      calendarCuid: 'raziel', creatorUserId: 1, title: 'Call the plumber',
      startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 11:00'), timeZone: IL,
      kind: 'REMINDER', forUserId: 2,
    });
    const row = eventRow(created.id);
    assert(row.kind === 'REMINDER', `kind ${row.kind}`);
    assert(iso(row.startsAt) === iso(at('2026-10-15 10:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(row.forUserId === 2, `forUserId ${row.forUserId}`);
    assert(fresh(row.armedAt), `armedAt ${iso(row.armedAt)}`);
    assert(gateCleared(), 'the due gate is still closed');
  });

  await check('create: a date-only reminder saved as the bot saves all-day (00:00 to 23:59) is zero-length at 00:00', async () => {
    reset();
    const created = await createNativeEvent({
      calendarCuid: 'raziel', creatorUserId: 1, title: 'Buy milk', allDay: true,
      startsAt: at('2026-10-16 00:00'), endsAt: at('2026-10-16 23:59'), timeZone: IL, kind: 'REMINDER',
    });
    const row = eventRow(created.id);
    assert(iso(row.startsAt) === iso(at('2026-10-16 00:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(row.allDay === true && row.forUserId === null, `allDay ${row.allDay}, forUserId ${row.forUserId}`);
  });

  await check('create: an event is stored as before, is for no one, and leaves the due gate alone', async () => {
    reset();
    closeGate();
    const created = await createNativeEvent({
      calendarCuid: 'raziel', creatorUserId: 1, title: 'Dentist',
      startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 11:00'), timeZone: IL, forUserId: 2,
    });
    const row = eventRow(created.id);
    assert(row.kind === 'EVENT' && row.forUserId === null && row.armedAt === null, `kind ${row.kind}, forUserId ${row.forUserId}, armedAt ${row.armedAt}`);
    assert(iso(row.endsAt) === iso(at('2026-10-15 11:00')), `end ${iso(row.endsAt)}`);
    assert(!gateCleared(), 'an event cleared the due gate');
  });

  // ---- updateNativeEvent: zero length and re-arm ----

  const daily = () => seedEvent('daily', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Water the plants', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });

  await check('single occurrence moved: zero-length, only its state row goes, its ping comes back, the series keeps its armedAt', async () => {
    reset();
    daily();
    const occ = at('2026-10-14 08:00');
    seedState('daily', at('2026-10-13 08:00'), 11, { doneAt: at('2026-10-13 08:05') });
    seedState('daily', occ, 12);
    closeGate();
    const result = await updateNativeEvent({
      seriesCuid: 'daily', instanceStartsAt: occ, scope: 'single', actingUserId: 1,
      startsAt: at('2026-10-14 12:00'), endsAt: at('2026-10-14 13:00'),
    });
    const override = tables.nativeEventInstance.find((r) => same(r.originalStartsAt, occ))!;
    assert(iso(override.startsAt) === iso(at('2026-10-14 12:00')) && iso(override.endsAt) === iso(override.startsAt), `override ${iso(override.startsAt)} - ${iso(override.endsAt)}`);
    assert(pings(result.clearedPings) === '5001/12', `cleared ${pings(result.clearedPings)}`);
    assert(stateKeys('daily').join() === iso(at('2026-10-13 08:00')), `states left ${stateKeys('daily').join()}`);
    assert(iso(eventRow('daily').armedAt) === iso(OLD_ARMED), `series armedAt ${iso(eventRow('daily').armedAt)}`);
    assert(result.canonicalEventId === encodeEventId('daily', occ), `id ${result.canonicalEventId}`);
    assert(gateCleared(), 'the due gate is still closed');
  });

  await check('one-off moved: zero-length, its state row goes with its ping, re-armed now', async () => {
    reset();
    seedEvent('once', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Call mom', startsAt: at('2026-10-14 10:00') });
    seedState('once', at('2026-10-14 10:00'), 21, { snoozedUntil: at('2026-10-14 10:15') });
    const result = await updateNativeEvent({
      seriesCuid: 'once', scope: 'single', actingUserId: 1, startsAt: at('2026-10-14 17:00'), endsAt: at('2026-10-14 18:00'),
    });
    const row = eventRow('once');
    assert(iso(row.startsAt) === iso(at('2026-10-14 17:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(pings(result.clearedPings) === '5001/21' && stateKeys('once').length === 0, `cleared ${pings(result.clearedPings)}, left ${stateKeys('once').join()}`);
    assert(fresh(row.armedAt), `armedAt ${iso(row.armedAt)}`);
  });

  await check('a date-only reminder moved to another day as the edit path sends it (00:00 to 23:59) stays zero-length', async () => {
    reset();
    seedEvent('milk', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Buy milk', allDay: true, startsAt: at('2026-10-14 00:00') });
    await updateNativeEvent({ seriesCuid: 'milk', scope: 'single', actingUserId: 1, startsAt: at('2026-10-16 00:00'), endsAt: at('2026-10-16 23:59') });
    const row = eventRow('milk');
    assert(iso(row.startsAt) === iso(at('2026-10-16 00:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
  });

  await check('every occurrence moved: every state row goes, only rows with a ping message come back, overrides drop', async () => {
    reset();
    daily();
    seedState('daily', at('2026-10-12 08:00'), 31);
    seedState('daily', at('2026-10-13 08:00'), null); // passed over without a send
    seedState('daily', at('2026-10-14 08:00'), 33);
    tables.nativeEventInstance.push({ ...DEFAULTS.nativeEventInstance(), id: 'ov', seriesEventId: 'daily', originalStartsAt: at('2026-10-13 08:00'), status: 'OVERRIDE', title: 'Just today' });
    const result = await updateNativeEvent({
      seriesCuid: 'daily', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 09:00'), endsAt: at('2026-10-10 10:00'),
    });
    const row = eventRow('daily');
    assert(iso(row.startsAt) === iso(at('2026-10-10 09:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(pings(result.clearedPings) === '5001/31, 5001/33', `cleared ${pings(result.clearedPings)}`);
    assert(stateKeys('daily').length === 0 && tables.nativeEventInstance.length === 0, `left ${stateKeys('daily').length} states, ${tables.nativeEventInstance.length} overrides`);
    assert(fresh(row.armedAt), `armedAt ${iso(row.armedAt)}`);
  });

  await check('every occurrence, the start where it was: one moved on its own comes back to the series\' time (an event\'s new end, a reminder\'s time); what else its override carries, and a cancellation, stay', async () => {
    const ov = (id: string, day: string, fields: Row) => ({ ...DEFAULTS.nativeEventInstance(), id, seriesEventId: 'daily', originalStartsAt: at(`${day} 08:00`), ...fields });
    const seed = (kind: 'REMINDER' | 'EVENT') => {
      reset();
      seedEvent('daily', { kind, calendarId: 'raziel', creatorUserId: 1, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });
      tables.nativeEventInstance.push(
        ov('moved', '2026-10-13', { status: 'OVERRIDE', title: 'Later today', startsAt: at('2026-10-13 12:00'), endsAt: at('2026-10-13 12:00') }),
        ov('named', '2026-10-14', { status: 'OVERRIDE', location: 'Garden' }),
        ov('skip', '2026-10-15', { status: 'CANCELLED', startsAt: at('2026-10-15 09:00'), endsAt: at('2026-10-15 09:00') }),
      );
    };
    const ovs = (id: string) => tables.nativeEventInstance.find((r) => r.id === id)!;
    // An event: a new end for every one, the start where it was.
    seed('EVENT');
    const ev = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, endsAt: at('2026-10-10 10:00'), allDay: false });
    assert(ev.clearedPings.length === 0 && iso(eventRow('daily').endsAt) === iso(at('2026-10-10 10:00')), `series end ${iso(eventRow('daily').endsAt)}`);
    assert(ovs('moved').startsAt === null && ovs('moved').endsAt === null && ovs('moved').title === 'Later today', `moved ${JSON.stringify(ovs('moved'))}`);
    assert(ovs('named').location === 'Garden' && ovs('skip').status === 'CANCELLED', 'the location or the cancellation went');
    const days = expandSeries(eventRow('daily') as never, { from: at('2026-10-13 00:00'), to: at('2026-10-16 00:00') }, tables.nativeEventInstance as never)
      .map((i) => `${iso(i.startsAt)}-${iso(i.endsAt)}`);
    assert(days.join() === ['2026-10-13', '2026-10-14'].map((d) => `${iso(at(`${d} 08:00`))}-${iso(at(`${d} 10:00`))}`).join(), `expanded ${days.join()}`);
    // A text change for every one leaves the moved one where it is.
    seed('EVENT');
    await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, title: 'Feed the dog' });
    assert(iso(ovs('moved').startsAt) === iso(at('2026-10-13 12:00')), 'a rename moved it');
    // A reminder: every one at 08:00, where the series already is. The moved one pings again there.
    seed('REMINDER');
    seedState('daily', at('2026-10-13 08:00'), 71);
    seedState('daily', at('2026-10-14 08:00'), 72);
    closeGate();
    const rem = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 08:00'), endsAt: at('2026-10-10 09:00') });
    assert(pings(rem.clearedPings) === '5001/71', `cleared ${pings(rem.clearedPings)}`);
    assert(stateKeys('daily').join() === iso(at('2026-10-14 08:00')), `states left ${stateKeys('daily').join()}`);
    assert(ovs('moved').startsAt === null && ovs('moved').title === 'Later today' && ovs('skip').status === 'CANCELLED', `moved ${JSON.stringify(ovs('moved'))}`);
    assert(fresh(eventRow('daily').armedAt) && gateCleared(), `armedAt ${iso(eventRow('daily').armedAt)}`);
    // Nothing moved on its own: nothing is cleared, nor re-armed.
    seed('REMINDER');
    tables.nativeEventInstance = tables.nativeEventInstance.filter((r) => r.id !== 'moved');
    seedState('daily', at('2026-10-14 08:00'), 73);
    const none = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 08:00') });
    assert(none.clearedPings.length === 0 && stateKeys('daily').length === 1 && iso(eventRow('daily').armedAt) === iso(OLD_ARMED), 'the same time re-armed it');
  });

  await check('following, by the partner: rows from the cut go, earlier ones stay; the new series keeps kind, person and creator', async () => {
    reset();
    seedEvent('daily', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, forUserId: 2, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });
    const cut = at('2026-10-14 08:00');
    seedState('daily', at('2026-10-12 08:00'), 41);
    seedState('daily', cut, 42);
    seedState('daily', at('2026-10-15 08:00'), 43);
    tables.nativeEventInstance.push({ ...DEFAULTS.nativeEventInstance(), id: 'ov', seriesEventId: 'daily', originalStartsAt: at('2026-10-16 08:00'), status: 'CANCELLED' });
    // Dana edits Raziel's reminder for her, on his SHARED_EDITOR calendar.
    const result = await updateNativeEvent({
      seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 2,
      startsAt: at('2026-10-14 07:30'), endsAt: at('2026-10-14 08:30'),
    });
    assert(pings(result.clearedPings) === '5001/42, 5001/43', `cleared ${pings(result.clearedPings)}`);
    assert(stateKeys('daily').join() === iso(at('2026-10-12 08:00')), `parent states left ${stateKeys('daily').join()}`);
    assert(String(eventRow('daily').rrule).includes('UNTIL=20261014T075959'), `parent rrule ${eventRow('daily').rrule}`);
    assert(tables.nativeEventInstance.length === 0, 'the override after the cut is still there');
    const split = eventRow(result.canonicalEventId);
    assert(split && split.id !== 'daily', `canonical id ${result.canonicalEventId}`);
    assert(split.kind === 'REMINDER' && split.forUserId === 2 && split.creatorUserId === 1, `kind ${split.kind}, forUserId ${split.forUserId}, creator ${split.creatorUserId}`);
    assert(iso(split.startsAt) === iso(at('2026-10-14 07:30')) && iso(split.endsAt) === iso(split.startsAt), `times ${iso(split.startsAt)} - ${iso(split.endsAt)}`);
    assert(split.rrule === 'FREQ=DAILY' && fresh(split.armedAt), `rrule ${split.rrule}, armedAt ${iso(split.armedAt)}`);
  });

  await check('a title-only change deletes nothing and keeps armedAt; a "from now on" rename takes the state along', async () => {
    reset();
    daily();
    seedState('daily', at('2026-10-13 08:00'), 51, { doneAt: at('2026-10-13 08:01') });
    seedState('daily', at('2026-10-15 08:00'), 52, { doneAt: at('2026-10-15 08:01') });
    const all = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, title: 'Water the garden' });
    const single = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: at('2026-10-13 08:00'), scope: 'single', actingUserId: 1, title: 'Just today' });
    assert(all.clearedPings.length === 0 && single.clearedPings.length === 0, 'a rename cleared pings');
    assert(stateKeys('daily').length === 2, `states left ${stateKeys('daily').length}`);
    assert(iso(eventRow('daily').armedAt) === iso(OLD_ARMED), `armedAt ${iso(eventRow('daily').armedAt)}`);
    const override = tables.nativeEventInstance[0];
    assert(override.title === 'Just today' && override.startsAt === null && override.endsAt === null, `override ${JSON.stringify(override)}`);
    // The same time sent again, with the edit path's extra hour, moves nothing.
    const again = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 08:00'), endsAt: at('2026-10-10 09:00') });
    assert(again.clearedPings.length === 0 && stateKeys('daily').length === 2, 'the same time re-armed it');
    assert(iso(eventRow('daily').endsAt) === iso(at('2026-10-10 08:00')), `end ${iso(eventRow('daily').endsAt)}`);
    const following = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: at('2026-10-14 08:00'), scope: 'following', actingUserId: 1, title: 'Water the trees' });
    assert(following.clearedPings.length === 0, `cleared ${pings(following.clearedPings)}`);
    const splitId = following.canonicalEventId;
    assert(stateKeys('daily').join() === iso(at('2026-10-13 08:00')), `parent states ${stateKeys('daily').join()}`);
    assert(stateKeys(splitId).join() === iso(at('2026-10-15 08:00')), `new series states ${stateKeys(splitId).join()}`);
    assert(iso(eventRow(splitId).armedAt) === iso(OLD_ARMED), `new series armedAt ${iso(eventRow(splitId).armedAt)}`);
  });

  await check('a "from now on" edit that keeps the time keeps what was skipped or moved after the cut; one that moves the time drops them', async () => {
    const seed = (kind: 'REMINDER' | 'EVENT') => {
      reset();
      seedEvent('daily', { kind, calendarId: 'raziel', creatorUserId: 1, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY', exdates: [at('2026-10-12 08:00'), at('2026-10-17 08:00')] });
      const ov = { ...DEFAULTS.nativeEventInstance(), seriesEventId: 'daily' };
      tables.nativeEventInstance.push(
        { ...ov, id: 'skip', originalStartsAt: at('2026-10-16 08:00'), status: 'CANCELLED' },
        { ...ov, id: 'moved', originalStartsAt: at('2026-10-18 08:00'), status: 'OVERRIDE', startsAt: at('2026-10-18 12:00'), endsAt: at('2026-10-18 12:00'), title: 'Old title', location: 'Home' },
        { ...ov, id: 'before', originalStartsAt: at('2026-10-13 08:00'), status: 'CANCELLED' },
      );
    };
    const cut = at('2026-10-14 08:00');
    const ovs = (id: string) => tables.nativeEventInstance.find((r) => r.id === id)!;
    seed('REMINDER');
    const kept = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 1, title: 'Feed the dog' });
    const split = eventRow(kept.canonicalEventId);
    assert((split.exdates as Date[]).map(iso).join() === iso(at('2026-10-17 08:00')), `exdates ${(split.exdates as Date[]).map(iso).join()}`);
    assert(ovs('skip').seriesEventId === split.id && ovs('skip').status === 'CANCELLED', `skip on ${ovs('skip').seriesEventId}`);
    assert(ovs('moved').seriesEventId === split.id && iso(ovs('moved').startsAt) === iso(at('2026-10-18 12:00')), 'the moved override did not follow');
    assert(ovs('moved').title === null && ovs('moved').location === 'Home', `title ${ovs('moved').title}, location ${ovs('moved').location}`);
    assert(ovs('before').seriesEventId === 'daily', 'an override before the cut moved');
    const days = expandSeries(
      split as never,
      { from: at('2026-10-14 00:00'), to: at('2026-10-19 00:00') },
      tables.nativeEventInstance.filter((r) => r.seriesEventId === split.id) as never,
    ).map((i) => iso(i.instanceStartsAt));
    assert(days.length > 0 && !days.includes(iso(at('2026-10-16 08:00'))) && !days.includes(iso(at('2026-10-17 08:00'))), `expanded: ${days.join()}`);
    // A change of time starts afresh.
    seed('REMINDER');
    const moved = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 1, startsAt: at('2026-10-14 09:00') });
    assert((eventRow(moved.canonicalEventId).exdates as Date[]).length === 0, 'a time change kept exdates');
    assert(tables.nativeEventInstance.map((r) => r.id).join() === 'before', `overrides left ${tables.nativeEventInstance.map((r) => r.id).join()}`);
    // An event split is as it was: its overrides after the cut are dropped.
    seed('EVENT');
    const ev = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 1, title: 'Feed the dog' });
    assert((eventRow(ev.canonicalEventId).exdates as Date[]).length === 0, 'an event split got exdates');
    assert(tables.nativeEventInstance.map((r) => r.id).join() === 'before', `event overrides left ${tables.nativeEventInstance.map((r) => r.id).join()}`);
  });

  await check('following on an event is unchanged: the editor becomes the creator, the length is kept, nothing is for anyone', async () => {
    reset();
    seedEvent('standup', { calendarId: 'raziel', creatorUserId: 1, title: 'Standup', startsAt: at('2026-10-10 09:00'), rrule: 'FREQ=DAILY' });
    closeGate();
    const result = await updateNativeEvent({
      seriesCuid: 'standup', instanceStartsAt: at('2026-10-14 09:00'), scope: 'following', actingUserId: 2,
      startsAt: at('2026-10-14 10:00'),
    });
    const split = eventRow(result.canonicalEventId);
    assert(split.creatorUserId === 2 && split.kind === 'EVENT' && split.forUserId === null && split.armedAt === null, `creator ${split.creatorUserId}, kind ${split.kind}, forUserId ${split.forUserId}, armedAt ${split.armedAt}`);
    assert(iso(split.endsAt) === iso(at('2026-10-14 11:00')), `end ${iso(split.endsAt)}`);
    assert(result.clearedPings.length === 0 && !gateCleared(), 'an event edit touched reminder state');
  });

  // ---- Permissions ----

  await check('the creator may change and delete a reminder on a calendar they can only view; not an event', async () => {
    reset();
    // Dana's kids calendar was SHARED_EDITOR when Raziel put these on it; it is view-only now.
    seedEvent('pickup', { kind: 'REMINDER', calendarId: 'dana-view', creatorUserId: 1, title: 'Bring the permission slip', startsAt: at('2026-10-15 07:30') });
    seedEvent('school', { calendarId: 'dana-view', creatorUserId: 1, title: 'School play', startsAt: at('2026-10-15 17:00') });
    await updateNativeEvent({ seriesCuid: 'pickup', scope: 'single', actingUserId: 1, title: 'Sign the permission slip' });
    assert(eventRow('pickup').title === 'Sign the permission slip', 'the creator could not rename it');
    closeGate();
    await deleteNativeEvent({ seriesCuid: 'pickup', scope: 'all', actingUserId: 1 });
    assert(eventRow('pickup').isDeleted === true && gateCleared(), `deleted ${eventRow('pickup').isDeleted}, gate cleared ${gateCleared()}`);
    await refused('the creator updating an event', () => updateNativeEvent({ seriesCuid: 'school', scope: 'single', actingUserId: 1, title: 'x' }));
    await refused('the creator deleting an event', () => deleteNativeEvent({ seriesCuid: 'school', scope: 'all', actingUserId: 1 }));
  });

  await check('the person a reminder is for may delete it ("stop reminding me") but not change it', async () => {
    reset();
    seedEvent('for-raziel', { kind: 'REMINDER', calendarId: 'dana', creatorUserId: 2, forUserId: 1, title: 'Renew the passport', startsAt: at('2026-10-15 09:00') });
    await refused('the person it is for updating it', () => updateNativeEvent({ seriesCuid: 'for-raziel', scope: 'single', actingUserId: 1, startsAt: at('2026-10-15 12:00') }));
    await deleteNativeEvent({ seriesCuid: 'for-raziel', scope: 'all', actingUserId: 1 });
    assert(eventRow('for-raziel').isDeleted === true, 'not deleted');
  });

  await check('a stranger, an ex-partner and a partner now on Google are refused', async () => {
    reset();
    seedEvent('mine', { kind: 'REMINDER', calendarId: 'dana', creatorUserId: 2, forUserId: 1, title: 'Call the bank', startsAt: at('2026-10-15 09:00') });
    seedEvent('for-noa', { kind: 'REMINDER', calendarId: 'avi', creatorUserId: 5, forUserId: 4, title: 'Pick up the bike', startsAt: at('2026-10-15 09:00') });
    seedEvent('for-maya', { kind: 'REMINDER', calendarId: 'lior', creatorUserId: 6, forUserId: 7, title: 'Book the vet', startsAt: at('2026-10-15 09:00') });
    await refused('a stranger updating', () => updateNativeEvent({ seriesCuid: 'mine', scope: 'single', actingUserId: 3, title: 'x' }));
    await refused('a stranger deleting', () => deleteNativeEvent({ seriesCuid: 'mine', scope: 'all', actingUserId: 3 }));
    await refused('an ex-partner deleting', () => deleteNativeEvent({ seriesCuid: 'for-noa', scope: 'all', actingUserId: 4 }));
    await refused('a partner on Google deleting', () => deleteNativeEvent({ seriesCuid: 'for-maya', scope: 'all', actingUserId: 7 }));
    assert(tables.nativeEvent.every((r) => r.isDeleted === false && r.title !== 'x'), 'a refused write still landed');
  });

  await check('deleting one occurrence of a reminder clears the gate; deleting an event does not', async () => {
    reset();
    daily();
    seedEvent('dentist', { calendarId: 'raziel', creatorUserId: 1, title: 'Dentist', startsAt: at('2026-10-15 10:00') });
    closeGate();
    await deleteNativeEvent({ seriesCuid: 'dentist', scope: 'single', actingUserId: 1 });
    assert(!gateCleared(), 'an event delete cleared the gate');
    await deleteNativeEvent({ seriesCuid: 'daily', instanceStartsAt: at('2026-10-14 08:00'), scope: 'single', actingUserId: 1 });
    assert(iso((eventRow('daily').exdates as Date[])[0]) === iso(at('2026-10-14 08:00')) && gateCleared(), 'the occurrence was not skipped or the gate not cleared');
  });

  // ---- getMainNativeCalendar ----

  await check("main calendar: the user's own primary, not the partner's older one", async () => {
    reset();
    tables.nativeCalendar = [
      calendar('dana', 2, 'SHARED_EDITOR', ['primary', 'yours'], '2025-06-01T00:00:00Z'),
      calendar('raziel-kids', 1, 'PRIVATE', ['kids'], '2026-02-01T00:00:00Z'),
      calendar('raziel', 1, 'SHARED_EDITOR', ['primary', 'yours'], '2026-03-01T00:00:00Z'),
    ];
    const main = await getMainNativeCalendar(1);
    assert(main.id === 'raziel', `got ${main.id}`);
  });

  await check('main calendar: no primary → the oldest own calendar, skipping a deleted one', async () => {
    reset();
    tables.nativeCalendar = [
      { ...calendar('old', 1, 'PRIVATE', ['primary', 'yours'], '2025-01-01T00:00:00Z'), isDeleted: true },
      calendar('raziel-work', 1, 'PRIVATE', [], '2026-04-01T00:00:00Z'),
      calendar('raziel-kids', 1, 'PRIVATE', ['kids'], '2026-02-01T00:00:00Z'),
    ];
    const main = await getMainNativeCalendar(1);
    assert(main.id === 'raziel-kids', `got ${main.id}`);
  });

  await check('main calendar: none at all → the primary calendar onboarding creates', async () => {
    reset();
    tables.nativeCalendar = [];
    const main = await getMainNativeCalendar(1);
    assert(main.ownerUserId === 1 && (main.labels as string[]).join() === 'primary,yours', `got ${JSON.stringify(main)}`);
    assert(tables.nativeCalendar.length === 1, `${tables.nativeCalendar.length} calendars`);
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
