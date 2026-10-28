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
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, exdates: [], ownAlerts: false, alertMinutes: [], isDeleted: false, kind: 'EVENT', forUserId: null, forBoth: false, eachMarksDone: false, armedAt: null }),
  nativeEventInstance: () => ({ title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null }),
  nativeReminderState: () => ({ doneAt: null, doneByUserId: null }),
  nativeReminderPing: () => ({ snoozedUntil: null, lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null, doneAt: null }),
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

/** Prisma returns only the selected columns, so a column the code forgets to select is missing; a state row's `pings` is its relation. */
const pick = (row: Row | undefined, select?: Record<string, unknown>): Row | null =>
  !row ? null : select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, k === 'pings' ? pingsOf(row, select[k]) : row[k]])) : { ...row };
const pingsOf = (state: Row, select: unknown): Array<Row | null> =>
  tables.nativeReminderPing.filter((p) => p.stateId === state.id).map((p) => pick(p, (select as { select?: Record<string, boolean> }).select));

/** Prisma skips undefined fields and appends on { push }. */
function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const push = value !== null && typeof value === 'object' && Object.hasOwn(value, 'push');
    row[key] = push ? [...(row[key] as unknown[]), (value as { push: unknown }).push] : value;
  }
  row.updatedAt = new Date();
}

/** The unique keys the database enforces: an override's occurrence, a state row's. */
const UNIQUE: Record<string, string[]> = { nativeEventInstance: ['seriesEventId', 'originalStartsAt'], nativeReminderState: ['seriesEventId', 'originalStartsAt'], nativeReminderPing: ['stateId', 'userId'] };

function table(name: string) {
  const find = (where?: Where) => tables[name].filter((r) => !where || matches(r, where));
  /** As the database would: a write that puts two rows on one unique key fails. */
  const unique = (row: Row) => {
    const keys = UNIQUE[name];
    if (keys && tables[name].some((r) => r !== row && keys.every((k) => same(r[k], row[k])))) {
      throw new Error(`stand-in ${name}: unique key ${keys.join('+')} taken by ${JSON.stringify(keys.map((k) => row[k]))}`);
    }
  };
  const insert = (data: Row) => {
    const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date() };
    apply(row, data);
    unique(row);
    tables[name].push(row);
    return { ...row };
  };
  type Args = { where?: Where; select?: Record<string, unknown>; orderBy?: Array<Record<string, 'asc' | 'desc'>>; data?: Row; create?: Row; update?: Row };
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
      unique(row);
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
      rows.forEach(unique);
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Args) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !where || !matches(r, where));
      // The database cascades a state row's pings.
      if (name === 'nativeReminderState') tables.nativeReminderPing = tables.nativeReminderPing.filter((p) => tables.nativeReminderState.some((s) => s.id === p.stateId));
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
// googleSyncLink: no calendar here is copied to Google (google-sync spec §2), so the store's marks find no link.
for (const name of ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'nativeReminderState', 'nativeReminderPing', 'googleSyncLink']) {
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
function seedState(seriesEventId: string, originalStartsAt: Date, pingMessageId: number | null, fields: Row = {}, userId = 1) {
  const { snoozedUntil = null, ...stateFields } = fields;
  const id = `state-${++nextId}`;
  tables.nativeReminderState.push({
    ...DEFAULTS.nativeReminderState(), id, seriesEventId, originalStartsAt,
    createdAt: originalStartsAt, updatedAt: originalStartsAt, ...stateFields,
  });
  // The ping is its recipient's own row.
  tables.nativeReminderPing.push({
    ...DEFAULTS.nativeReminderPing(), id: `ping-${++nextId}`, stateId: id, userId, snoozedUntil,
    lastPingedAt: originalStartsAt, pingAttempts: 1,
    pingChatId: pingMessageId === null ? null : 5001n, pingMessageId,
    createdAt: originalStartsAt, updatedAt: originalStartsAt,
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
  tables.nativeReminderPing = [];
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
  Object.assign(prismaModule, { filename: prismaFile, loaded: true, exports: { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() } });
  Module._cache[prismaFile] = prismaModule;

  const store = await import('../src/services/native-calendar/event-store');
  const { normalizeReminderTimes, createNativeEvent, updateNativeEvent, deleteNativeEvent, getMainNativeCalendar, encodeEventId } = store;
  const { nativeProvider } = await import('../src/services/calendar-provider/native-provider');

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

  // ---- Remind us both: who a reminder is for ----

  await check('both: a reminder for both partners stores the partner and forBoth; an event, or a self reminder, never does', async () => {
    reset();
    const base = { calendarCuid: 'raziel', creatorUserId: 1, title: 'Book the flights', startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 10:00'), timeZone: IL };
    const both = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', forUserId: 2, forBoth: true })).id);
    assert(both.forUserId === 2 && both.forBoth === true, `forUserId ${both.forUserId}, forBoth ${both.forBoth}`);
    const partner = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', forUserId: 2 })).id);
    assert(partner.forUserId === 2 && partner.forBoth === false, `partner: ${partner.forBoth}`);
    const self = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', forBoth: true })).id);
    assert(self.forUserId === null && self.forBoth === false, 'forBoth with no partner is for the creator alone');
    const event = eventRow((await createNativeEvent({ ...base, forUserId: 2, forBoth: true })).id);
    assert(event.kind === 'EVENT' && event.forBoth !== true, 'an event is for no one');
  });

  /** A repeating reminder of Raziel's for himself, with an open and a done occurrence, both pinged. */
  function reassignable() {
    reset();
    seedEvent('rem', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });
    seedState('rem', at('2026-10-13 08:00'), 11, { doneAt: at('2026-10-13 08:05') });
    seedState('rem', at('2026-10-14 08:00'), 12);
  }

  await check('both: handing a reminder to both: the open occurrences start afresh and their pings come back "now for", the done one stays', async () => {
    reassignable();
    closeGate();
    const r = await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: 2, forBoth: true });
    const row = eventRow('rem');
    assert(row.forUserId === 2 && row.forBoth === true, `forUserId ${row.forUserId}, forBoth ${row.forBoth}`);
    assert(pings(r.reassignedPings) === '5001/12' && r.clearedPings.length === 0, `reassigned ${pings(r.reassignedPings)}`);
    assert(JSON.stringify(stateKeys('rem')) === JSON.stringify([iso(at('2026-10-13 08:00'))]), `states ${stateKeys('rem')}`);
    assert(gateCleared(), 'the due gate is closed');
  });

  await check('both: from both to the partner alone, then to the creator alone: an open occurrence returns BOTH pings', async () => {
    reset();
    seedEvent('rem', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, forUserId: 2, forBoth: true, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });
    seedState('rem', at('2026-10-14 08:00'), 12, {}, 1);
    const stateId = tables.nativeReminderState[0].id;
    // Her ping on the same occurrence.
    tables.nativeReminderPing.push({ ...DEFAULTS.nativeReminderPing(), id: 'ping-hers', stateId, userId: 2, lastPingedAt: at('2026-10-14 08:00'), pingAttempts: 1, pingChatId: 5002n, pingMessageId: 13 });
    const toPartner = await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: 2, forBoth: false });
    assert(eventRow('rem').forUserId === 2 && eventRow('rem').forBoth === false, 'for the partner alone');
    assert(pings(toPartner.reassignedPings) === '5001/12, 5002/13', `both live pings come back: ${pings(toPartner.reassignedPings)}`);
    assert(stateKeys('rem').length === 0 && tables.nativeReminderPing.length === 0, 'the state and both ping rows went with it');
    const toMe = await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: null });
    assert(eventRow('rem').forUserId === null && eventRow('rem').forBoth === false, 'the creator alone, forBoth off');
    assert(toMe.reassignedPings.length === 0, 'nothing left to edit');
  });

  await check('both: the same recipients again is no change: the open occurrences keep their state and no ping is touched', async () => {
    reset();
    seedEvent('rem', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, forUserId: 2, forBoth: true, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });
    seedState('rem', at('2026-10-14 08:00'), 12, {}, 1);
    const r = await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: 2, forBoth: true });
    assert(r.reassignedPings.length === 0 && stateKeys('rem').length === 1 && tables.nativeReminderPing.length === 1, `reassigned ${pings(r.reassignedPings)}, states ${stateKeys('rem').length}`);
  });

  await check('both: only the creator can, and only for the active partner on Telegram; forBoth needs that partner', async () => {
    reassignable();
    await refused('the partner hands it on', () => updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 2, forUserId: 2, forBoth: true }));
    for (const [what, input] of [
      ['a stranger as the partner', { forUserId: 3, forBoth: true }],
      ['both with no partner', { forUserId: null, forBoth: true }],
    ] as const) {
      const outcome = await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, ...input }).then(() => 'allowed', (err: Error) => err.name);
      assert(outcome === 'NativeRecipientError', `${what}: ${outcome}`);
    }
    assert(eventRow('rem').forUserId === null && eventRow('rem').forBoth === false, 'nothing written');
  });

  await check('both: either partner may delete a reminder for both (the recipients rule); a stranger and an unlinked ex-partner may not', async () => {
    reset();
    const row = seedEvent('rem', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, forUserId: 2, forBoth: true, title: 'Feed the cat', startsAt: at('2026-10-10 08:00') });
    assert((await store.mayDeleteReminder(row as never, 1)) && (await store.mayDeleteReminder(row as never, 2)), 'the two partners');
    assert(!(await store.mayDeleteReminder(row as never, 3)), 'a stranger');
    tables.user.find((u) => u.id === 2)!.pairingId = null;
    tables.user.find((u) => u.id === 1)!.pairingId = null;
    assert((await store.mayDeleteReminder(row as never, 1)) && !(await store.mayDeleteReminder(row as never, 2)), 'unlinked: the creator only');
  });

  await check('both: this one and the ones after, for both: the new series is for both, the earlier ones keep their recipient', async () => {
    reassignable();
    const r = await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-14 08:00'), actingUserId: 1, forUserId: 2, forBoth: true });
    const tail = tables.nativeEvent.find((e) => e.id !== 'rem' && e.kind === 'REMINDER')!;
    assert(tail.forUserId === 2 && tail.forBoth === true && eventRow('rem').forUserId === null && eventRow('rem').forBoth === false, `tail ${tail.forBoth}, head ${eventRow('rem').forBoth}`);
    assert(pings(r.reassignedPings) === '5001/12', `reassigned ${pings(r.reassignedPings)}`);
  });

  // ---- Each of us marks it done ----

  /** A reminder of Raziel's for both of them with the switch on; its open occurrence has Dana's own Done, a done one is done for everyone. */
  function eachReminder(rrule: string | null = 'FREQ=DAILY') {
    reset();
    seedEvent('rem', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, forUserId: 2, forBoth: true, eachMarksDone: true, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule });
    if (!rrule) return;
    seedState('rem', at('2026-10-13 08:00'), 11, { doneAt: at('2026-10-13 08:10') }, 1);
    tables.nativeReminderPing.push({ ...DEFAULTS.nativeReminderPing(), id: 'ping-d13', stateId: tables.nativeReminderState[0].id, userId: 2, lastPingedAt: at('2026-10-13 08:00'), pingAttempts: 1, pingChatId: 5002n, pingMessageId: 21, doneAt: at('2026-10-13 08:05') });
    seedState('rem', at('2026-10-14 08:00'), 12, {}, 1);
    tables.nativeReminderPing.push({ ...DEFAULTS.nativeReminderPing(), id: 'ping-d14', stateId: tables.nativeReminderState[1].id, userId: 2, lastPingedAt: at('2026-10-14 08:00'), pingAttempts: 1, pingChatId: 5002n, pingMessageId: 22, doneAt: at('2026-10-14 08:05') });
  }
  const pingDone = (stateIndex: number, userId: number) => tables.nativeReminderPing.find((p) => p.stateId === tables.nativeReminderState[stateIndex].id && p.userId === userId)?.doneAt ?? null;

  await check('each: a reminder is created with the switch only when it is for both partners; an event, a partner-only or a self reminder never has it', async () => {
    reset();
    const base = { calendarCuid: 'raziel', creatorUserId: 1, title: 'Book the flights', startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 10:00'), timeZone: IL };
    const on = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', forUserId: 2, forBoth: true, eachMarksDone: true })).id);
    assert(on.forBoth === true && on.eachMarksDone === true, `both: ${on.eachMarksDone}`);
    const plain = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', forUserId: 2, forBoth: true })).id);
    assert(plain.eachMarksDone === false, `default off: ${plain.eachMarksDone}`);
    const partner = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', forUserId: 2, eachMarksDone: true })).id);
    const self = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', eachMarksDone: true })).id);
    const noPartner = eventRow((await createNativeEvent({ ...base, kind: 'REMINDER', forBoth: true, eachMarksDone: true })).id);
    const event = eventRow((await createNativeEvent({ ...base, forUserId: 2, forBoth: true, eachMarksDone: true })).id);
    assert([partner, self, noPartner, event].every((r) => r.eachMarksDone === false), `stored ${[partner, self, noPartner, event].map((r) => r.eachMarksDone)}`);
  });

  await check('each: turning the switch on clears the open occurrences\' partial Done, going off every per-person Done (the done ones\' too, still done), in place (state rows, snoozes and live pings stay), and wakes the gate', async () => {
    for (const next of [false, true]) {
      eachReminder();
      eventRow('rem').eachMarksDone = !next;
      closeGate();
      const r = await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, eachMarksDone: next });
      assert(eventRow('rem').eachMarksDone === next && eventRow('rem').forBoth === true, `flag ${eventRow('rem').eachMarksDone}`);
      assert(pingDone(1, 2) === null, 'the open occurrence lost her partial Done');
      assert(tables.nativeReminderState[0].doneAt !== null, 'the done occurrence stays done');
      // Going off clears every per-person Done, the done occurrence's too (state.doneAt keeps it done), so none can come back or block a ping.
      assert(next ? pingDone(0, 2) !== null : pingDone(0, 2) === null && pingDone(0, 1) === null, `the done occurrence's own Dones: hers ${pingDone(0, 2)}`);
      // The state rows in scope are locked (touched) before their pings are cleared, so a Done in flight lands first or finds the switch gone.
      assert(fresh(tables.nativeReminderState[1].updatedAt) && fresh(tables.nativeReminderState[0].updatedAt) === !next, 'the state rows are touched first');
      assert(tables.nativeReminderState.length === 2 && tables.nativeReminderPing.length === 4, 'no state or ping row was removed');
      assert(r.clearedPings.length + r.changedPings.length + r.reassignedPings.length === 0, `no live ping is touched: ${pings(r.reassignedPings)}`);
      assert(gateCleared(), 'the due gate is closed');
    }
  });

  await check('each: a switch that is already what the reminder has is no change: nothing is cleared', async () => {
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, eachMarksDone: true });
    assert(pingDone(1, 2) !== null, 'a no-op write cleared the partial Done');
  });

  await check('each: only the creator changes it, and only for a reminder for both partners; "this one" is refused on a repeating series', async () => {
    eachReminder();
    await refused('the partner', () => updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 2, eachMarksDone: false }));
    eventRow('rem').eachMarksDone = false;
    for (const [what, patch] of [['for the partner alone', { forBoth: false }], ['for the creator alone', { forUserId: null, forBoth: false }]] as const) {
      Object.assign(eventRow('rem'), patch);
      const outcome = await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, eachMarksDone: true }).then(() => 'allowed', (err: Error) => err.name);
      assert(outcome === 'NativeScopeError', `${what}: ${outcome}`);
      assert(eventRow('rem').eachMarksDone === false, 'nothing written');
    }
    Object.assign(eventRow('rem'), { forUserId: 2, forBoth: true });
    const single = await updateNativeEvent({ seriesCuid: 'rem', scope: 'single', instanceStartsAt: at('2026-10-14 08:00'), actingUserId: 1, eachMarksDone: true }).then(() => 'allowed', (err: Error) => err.name);
    assert(single === 'NativeScopeError', `single: ${single}`);
    // A one-off has no series to speak of: its own scope is fine.
    eachReminder(null);
    eventRow('rem').eachMarksDone = false;
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'single', actingUserId: 1, eachMarksDone: true });
    assert(eventRow('rem').eachMarksDone === true, 'a one-off takes it');
  });

  await check('each: this one and the ones after: the new series carries the switch (also when only the title changes), the earlier ones keep theirs and their Done', async () => {
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-14 08:00'), actingUserId: 1, title: 'Feed the cats' });
    const tail = tables.nativeEvent.find((e) => e.id !== 'rem' && e.kind === 'REMINDER')!;
    assert(tail.eachMarksDone === true && tail.forBoth === true && eventRow('rem').eachMarksDone === true, `tail ${tail.eachMarksDone}, head ${eventRow('rem').eachMarksDone}`);
    assert(pingDone(1, 2) !== null, 'the switch did not change, so the open occurrence keeps hers');
    // Now turn it off from the 14th: the tail loses it and the open occurrence its partial Done; the 13th keeps both.
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-14 08:00'), actingUserId: 1, eachMarksDone: false });
    const off = tables.nativeEvent.find((e) => e.id !== 'rem' && e.kind === 'REMINDER')!;
    assert(off.eachMarksDone === false && eventRow('rem').eachMarksDone === true, `tail ${off.eachMarksDone}, head ${eventRow('rem').eachMarksDone}`);
    assert(pingDone(1, 2) === null && pingDone(0, 2) !== null && tables.nativeReminderState[0].seriesEventId === 'rem' && tables.nativeReminderState[1].seriesEventId === off.id, 'the open one is reset and follows the tail; the earlier one is untouched');
  });

  await check('each: turned off from an occurrence on, the new series\' done occurrences lose their per-person Dones too (still done), the earlier ones keep theirs', async () => {
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-13 08:00'), actingUserId: 1, eachMarksDone: false });
    const tail = tables.nativeEvent.find((e) => e.id !== 'rem' && e.kind === 'REMINDER')!;
    assert(tail.eachMarksDone === false && tables.nativeReminderState.every((x) => x.seriesEventId === tail.id), 'both occurrences follow the tail');
    assert(pingDone(0, 2) === null && pingDone(0, 1) === null && pingDone(1, 2) === null, 'no per-person Done is left on either');
    assert(tables.nativeReminderState[0].doneAt !== null, 'the done one is still done');
  });

  await check('each: a switch turned on and off again never brings partial progress back', async () => {
    eachReminder();
    eventRow('rem').eachMarksDone = false; // off, with a stale partial that must not exist (it is cleared on the way)
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, eachMarksDone: true });
    assert(pingDone(1, 2) === null, 'cleared on the way on');
    tables.nativeReminderPing.find((p) => p.id === 'ping-d14')!.doneAt = at('2026-10-14 09:00'); // she marks hers while it is on
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, eachMarksDone: false });
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, eachMarksDone: true });
    assert(pingDone(1, 2) === null, 'off then on again: her partial Done did not come back');
  });

  await check('each: moving the reminder away from both clears the switch (to the partner alone, to the creator alone); handing it to both can set it in the same save', async () => {
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: 2, forBoth: false });
    assert(eventRow('rem').eachMarksDone === false && eventRow('rem').forBoth === false, 'for the partner alone');
    assert(tables.nativeReminderState.length === 1 && tables.nativeReminderState[0].doneAt !== null && pingDone(0, 2) === null && pingDone(0, 1) === null, 'the done occurrence stays done and no per-person Done is left on it');
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: null });
    assert(eventRow('rem').eachMarksDone === false && eventRow('rem').forUserId === null, 'for the creator alone');
    reassignable();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: 2, forBoth: true, eachMarksDone: true });
    assert(eventRow('rem').forBoth === true && eventRow('rem').eachMarksDone === true, 'both with the switch');
    // Handing it to both without asking for the switch leaves it off.
    reassignable();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'all', actingUserId: 1, forUserId: 2, forBoth: true });
    assert(eventRow('rem').eachMarksDone === false, 'off unless asked');
    // The tail of a "following" recipient change is for both without the switch too, and with it when asked.
    reassignable();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-14 08:00'), actingUserId: 1, forUserId: 2, forBoth: true, eachMarksDone: true });
    assert(tables.nativeEvent.find((e) => e.id !== 'rem' && e.kind === 'REMINDER')!.eachMarksDone === true, 'the tail has the switch');
  });

  await check('each: stopping a repeat keeps the switch on the one-off, and a switch change in the same save resets its partial Done', async () => {
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-14 08:00'), actingUserId: 1, rrule: null, startsAt: at('2026-10-14 08:00'), endsAt: at('2026-10-14 08:00') });
    const oneOff = tables.nativeEvent.find((e) => e.id !== 'rem' && e.kind === 'REMINDER')!;
    assert(oneOff.eachMarksDone === true && oneOff.rrule === null && pingDone(1, 2) !== null, `kept: ${oneOff.eachMarksDone}`);
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-14 08:00'), actingUserId: 1, rrule: null, startsAt: at('2026-10-14 08:00'), endsAt: at('2026-10-14 08:00'), eachMarksDone: false });
    const off = tables.nativeEvent.find((e) => e.id !== 'rem' && e.kind === 'REMINDER')!;
    assert(off.eachMarksDone === false && pingDone(1, 2) === null, `reset: ${off.eachMarksDone}`);
    // The opened occurrence is a done one: its per-person Dones go as well, and it stays done.
    eachReminder();
    await updateNativeEvent({ seriesCuid: 'rem', scope: 'following', instanceStartsAt: at('2026-10-13 08:00'), actingUserId: 1, rrule: null, startsAt: at('2026-10-13 08:00'), endsAt: at('2026-10-13 08:00'), eachMarksDone: false });
    assert(pingDone(0, 2) === null && pingDone(0, 1) === null && tables.nativeReminderState[0].doneAt !== null, 'a done occurrence opened to stop repeating');
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

  // ---- A series moved: what was done to its occurrences one by one moves with it ----

  /** The starts of a series' occurrences in [from, to), with its own exdates and overrides. */
  const startsOf = (seriesId: unknown, from: string, to: string) =>
    expandSeries(eventRow(String(seriesId)) as never, { from: at(from), to: at(to) }, tables.nativeEventInstance.filter((r) => r.seriesEventId === seriesId) as never).map((i) => iso(i.startsAt));
  const instance = (id: string, seriesEventId: string, slot: string, fields: Row) => ({ ...DEFAULTS.nativeEventInstance(), id, seriesEventId, originalStartsAt: at(slot), ...fields });
  const row = (id: string) => tables.nativeEventInstance.find((r) => r.id === id)!;

  await check('every occurrence of an event moved from Saturday 24 October (summer time) to Sunday the 25th (winter time): the skipped Saturdays are the skipped Sundays, still at 08:00; a renamed one keeps its name and takes the series\' time; nothing deleted comes back', async () => {
    reset();
    seedEvent('market', { calendarId: 'raziel', creatorUserId: 1, title: 'Market', startsAt: at('2026-10-24 08:00'), rrule: 'FREQ=WEEKLY', exdates: [at('2026-10-31 08:00'), at('2026-11-14 08:00')] });
    tables.nativeEventInstance.push(
      instance('skip', 'market', '2026-11-07 08:00', { status: 'CANCELLED' }),
      instance('late', 'market', '2026-11-21 08:00', { status: 'OVERRIDE', title: 'Late market', startsAt: at('2026-11-21 11:00'), endsAt: at('2026-11-21 12:00') }),
    );
    const before = startsOf('market', '2026-10-24 00:00', '2026-11-29 00:00');
    assert(before.join() === ['2026-10-24 08:00', '2026-11-21 11:00', '2026-11-28 08:00'].map((d) => iso(at(d))).join(), `before: ${before.join()}`);
    await updateNativeEvent({ seriesCuid: 'market', scope: 'all', actingUserId: 1, startsAt: at('2026-10-25 08:00'), endsAt: at('2026-10-25 09:00') });
    const series = eventRow('market');
    assert((series.exdates as Date[]).map(iso).join() === [at('2026-11-01 08:00'), at('2026-11-15 08:00')].map(iso).join(), `exdates ${(series.exdates as Date[]).map(iso).join()}`);
    assert(iso(row('skip').originalStartsAt) === iso(at('2026-11-08 08:00')) && row('skip').status === 'CANCELLED', `skip ${iso(row('skip').originalStartsAt)}`);
    assert(iso(row('late').originalStartsAt) === iso(at('2026-11-22 08:00')) && row('late').startsAt === null && row('late').title === 'Late market', `late ${JSON.stringify(row('late'))}`);
    const after = startsOf('market', '2026-10-24 00:00', '2026-11-30 00:00');
    assert(after.join() === ['2026-10-25 08:00', '2026-11-22 08:00', '2026-11-29 08:00'].map((d) => iso(at(d))).join(), `after: ${after.join()}`);
    // A daily series a day later: each cancellation moves onto the next one's key, which the database allows only latest first.
    reset();
    seedEvent('daily-ev', { calendarId: 'raziel', creatorUserId: 1, title: 'Walk', startsAt: at('2026-10-10 07:00'), rrule: 'FREQ=DAILY' });
    tables.nativeEventInstance.push(instance('a', 'daily-ev', '2026-10-12 07:00', { status: 'CANCELLED' }), instance('b', 'daily-ev', '2026-10-13 07:00', { status: 'CANCELLED' }));
    await updateNativeEvent({ seriesCuid: 'daily-ev', scope: 'all', actingUserId: 1, startsAt: at('2026-10-11 07:00'), endsAt: at('2026-10-11 08:00') });
    assert([row('a'), row('b')].map((r) => iso(r.originalStartsAt)).join() === [at('2026-10-13 07:00'), at('2026-10-14 07:00')].map(iso).join(), `daily: ${[row('a'), row('b')].map((r) => iso(r.originalStartsAt)).join()}`);
    // And a day earlier, earliest first.
    await updateNativeEvent({ seriesCuid: 'daily-ev', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 07:00'), endsAt: at('2026-10-10 08:00') });
    assert([row('a'), row('b')].map((r) => iso(r.originalStartsAt)).join() === [at('2026-10-12 07:00'), at('2026-10-13 07:00')].map(iso).join(), `back: ${[row('a'), row('b')].map((r) => iso(r.originalStartsAt)).join()}`);
  });

  await check('every occurrence of a reminder moved: what was skipped stays skipped at the new time, what was moved on its own goes, every state row goes', async () => {
    reset();
    seedEvent('daily', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY', exdates: [at('2026-10-12 08:00')] });
    tables.nativeEventInstance.push(
      instance('skip', 'daily', '2026-10-15 08:00', { status: 'CANCELLED' }),
      instance('moved', 'daily', '2026-10-16 08:00', { status: 'OVERRIDE', startsAt: at('2026-10-16 12:00'), endsAt: at('2026-10-16 12:00') }),
    );
    seedState('daily', at('2026-10-13 08:00'), 81);
    const result = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 09:15') });
    assert(pings(result.clearedPings) === '5001/81' && stateKeys('daily').length === 0, `cleared ${pings(result.clearedPings)}`);
    assert((eventRow('daily').exdates as Date[]).map(iso).join() === iso(at('2026-10-12 09:15')), `exdates ${(eventRow('daily').exdates as Date[]).map(iso).join()}`);
    assert(tables.nativeEventInstance.map((r) => `${r.id} ${iso(r.originalStartsAt)}`).join() === `skip ${iso(at('2026-10-15 09:15'))}`, `instances ${tables.nativeEventInstance.map((r) => r.id).join()}`);
    const days = startsOf('daily', '2026-10-11 00:00', '2026-10-17 00:00');
    assert(days.join() === ['2026-10-11', '2026-10-13', '2026-10-14', '2026-10-16'].map((d) => iso(at(`${d} 09:15`))).join(), `expanded ${days.join()}`);
  });

  await check('the bot\'s "every one at 18:00", said of a later occurrence (occurrenceTimes): the series keeps its first day and its earlier occurrences, moved to 18:00 with what was skipped; an end alone keeps the start; through the provider too', async () => {
    const seed = () => {
      reset();
      seedEvent('swim', { calendarId: 'raziel', creatorUserId: 1, title: 'Swimming', startsAt: at('2026-09-01 17:00'), rrule: 'FREQ=WEEKLY', exdates: [at('2026-09-29 17:00'), at('2026-11-10 17:00')] });
    };
    const occ = at('2026-10-20 17:00');
    seed();
    await updateNativeEvent({ seriesCuid: 'swim', instanceStartsAt: occ, scope: 'all', actingUserId: 1, occurrenceTimes: true, startsAt: at('2026-10-20 18:00'), endsAt: at('2026-10-20 19:00') });
    const swim = eventRow('swim');
    assert(iso(swim.startsAt) === iso(at('2026-09-01 18:00')) && iso(swim.endsAt) === iso(at('2026-09-01 19:00')), `series ${iso(swim.startsAt)} - ${iso(swim.endsAt)}`);
    assert((swim.exdates as Date[]).map(iso).join() === [at('2026-09-29 18:00'), at('2026-11-10 18:00')].map(iso).join(), `exdates ${(swim.exdates as Date[]).map(iso).join()}`);
    const days = startsOf('swim', '2026-09-22 00:00', '2026-11-18 00:00').map((d) => d.slice(0, 10));
    assert(days.join() === ['2026-09-22', '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-17'].map((d) => iso(at(`${d} 18:00`)).slice(0, 10)).join(), `occurrences ${days.join()}`);
    // An end alone: a longer one for every week, the start where it is.
    await updateNativeEvent({ seriesCuid: 'swim', instanceStartsAt: at('2026-10-20 18:00'), scope: 'all', actingUserId: 1, occurrenceTimes: true, endsAt: at('2026-10-20 19:30') });
    assert(iso(eventRow('swim').startsAt) === iso(at('2026-09-01 18:00')) && iso(eventRow('swim').endsAt) === iso(at('2026-09-01 19:30')), `end alone ${iso(eventRow('swim').endsAt)}`);
    // Without the flag the times are the series' own, as the home sends them.
    seed();
    await updateNativeEvent({ seriesCuid: 'swim', instanceStartsAt: occ, scope: 'all', actingUserId: 1, startsAt: at('2026-09-01 18:00'), endsAt: at('2026-09-01 19:00') });
    assert(iso(eventRow('swim').startsAt) === iso(at('2026-09-01 18:00')), 'the series\' own times');
    // The provider says so for the bot.
    seed();
    const result = await nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('swim', occ), { startTime: at('2026-10-20 18:00'), endTime: at('2026-10-20 19:00'), scope: 'all' });
    assert(result.success && iso(eventRow('swim').startsAt) === iso(at('2026-09-01 18:00')), `through the provider: ${JSON.stringify(result)} ${iso(eventRow('swim').startsAt)}`);
    // A reminder the same way: its first day stays, its skipped day moves to the new time.
    reset();
    seedEvent('daily', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY', exdates: [at('2026-10-12 08:00')] });
    await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: at('2026-10-14 08:00'), scope: 'all', actingUserId: 1, occurrenceTimes: true, startsAt: at('2026-10-14 09:00'), endsAt: at('2026-10-14 09:00') });
    assert(iso(eventRow('daily').startsAt) === iso(at('2026-10-10 09:00')) && (eventRow('daily').exdates as Date[]).map(iso).join() === iso(at('2026-10-12 09:00')), `reminder ${iso(eventRow('daily').startsAt)} ${(eventRow('daily').exdates as Date[]).map(iso).join()}`);
  });

  await check('the bot\'s "every year" on a yearly reminder (editor upgrades spec §1): a date half a year or more away is the first, a later skip stays, the state rows go; a Hebrew one is anchored on it; a near one keeps the first year', async () => {
    reset();
    seedEvent('bday', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Call Dana', startsAt: at('2020-03-02 09:00'), rrule: 'FREQ=YEARLY', exdates: [at('2028-03-02 09:00')] });
    seedState('bday', at('2026-03-02 09:00'), 82);
    const far = await nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('bday', at('2026-03-02 09:00')), { startTime: at('1985-03-02 09:00'), endTime: at('1985-03-02 09:00'), scope: 'all' });
    assert(far.success && iso(eventRow('bday').startsAt) === iso(at('1985-03-02 09:00')), `far: ${far.success} ${iso(eventRow('bday').startsAt)}`);
    assert((eventRow('bday').exdates as Date[]).map(iso).join() === iso(at('2028-03-02 09:00')) && stateKeys('bday').length === 0, `exdates ${(eventRow('bday').exdates as Date[]).map(iso).join()}, states ${stateKeys('bday').length}`);
    const days = startsOf('bday', '1985-01-01 00:00', '1987-01-01 00:00').concat(startsOf('bday', '2027-01-01 00:00', '2030-01-01 00:00'));
    assert(days.join() === ['1985-03-02', '1986-03-02', '2027-03-02', '2029-03-02'].map((d) => iso(at(`${d} 09:00`))).join(), `days ${days.join()}`);
    const near = await nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('bday', at('2026-03-02 09:00')), { startTime: at('2026-03-04 09:00'), endTime: at('2026-03-04 09:00'), scope: 'all' });
    assert(near.success && iso(eventRow('bday').startsAt) === iso(at('1985-03-04 09:00')), `near: ${iso(eventRow('bday').startsAt)}`);
    reset();
    seedEvent('tu', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Plant a tree', startsAt: at('2024-01-25 09:00'), rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2024-01-25' });
    const heb = await nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('tu', at('2026-02-02 09:00')), { startTime: at('1950-02-02 09:00'), endTime: at('1950-02-02 09:00'), scope: 'all' });
    assert(heb.success && iso(eventRow('tu').startsAt) === iso(at('1950-02-02 09:00')) && eventRow('tu').hebrewAnchor === '1950-02-02', `hebrew: ${iso(eventRow('tu').startsAt)} ${eventRow('tu').hebrewAnchor}`);
    assert(startsOf('tu', '2026-01-01 00:00', '2028-01-01 00:00').join() === ['2026-02-02', '2027-01-23'].map((d) => iso(at(`${d} 09:00`))).join(), 'every year still on 15 Shvat');
  });

  await check('every one resent with the series\' own start (the bot saying the time it already has): an occurrence moved on its own stays moved, also with the end resent unchanged and through the bot\'s occurrenceTimes; a new end or a new start still resets it', async () => {
    const seed = () => {
      reset();
      seedEvent('swim', { calendarId: 'raziel', creatorUserId: 1, title: 'Swimming', startsAt: at('2026-09-01 17:00'), endsAt: at('2026-09-01 18:00'), rrule: 'FREQ=WEEKLY' });
      tables.nativeEventInstance.push(instance('moved', 'swim', '2026-10-20 17:00', { status: 'OVERRIDE', title: 'Late swim', startsAt: at('2026-10-21 09:00'), endsAt: at('2026-10-21 10:00') }));
    };
    const kept = () => iso(row('moved').startsAt) === iso(at('2026-10-21 09:00')) && iso(row('moved').endsAt) === iso(at('2026-10-21 10:00')) && iso(row('moved').originalStartsAt) === iso(at('2026-10-20 17:00'));
    seed();
    await updateNativeEvent({ seriesCuid: 'swim', scope: 'all', actingUserId: 1, startsAt: at('2026-09-01 17:00') });
    assert(kept(), `start alone: ${JSON.stringify(row('moved'))}`);
    await updateNativeEvent({ seriesCuid: 'swim', scope: 'all', actingUserId: 1, startsAt: at('2026-09-01 17:00'), endsAt: at('2026-09-01 18:00'), allDay: false });
    assert(kept(), `start and end: ${JSON.stringify(row('moved'))}`);
    await updateNativeEvent({ seriesCuid: 'swim', scope: 'all', actingUserId: 1, title: 'Pool', endsAt: at('2026-09-01 18:00') });
    assert(kept() && eventRow('swim').title === 'Pool', 'a title with the same end');
    await updateNativeEvent({ seriesCuid: 'swim', instanceStartsAt: at('2026-10-27 17:00'), scope: 'all', actingUserId: 1, occurrenceTimes: true, startsAt: at('2026-10-27 17:00'), endsAt: at('2026-10-27 18:00') });
    assert(kept(), `occurrenceTimes: ${JSON.stringify(row('moved'))}`);
    await updateNativeEvent({ seriesCuid: 'swim', scope: 'all', actingUserId: 1, startsAt: at('2026-09-01 17:00'), endsAt: at('2026-09-01 19:00') });
    assert(row('moved').startsAt === null && row('moved').title === 'Late swim', 'a new end resets the times and keeps the title');
    seed();
    await updateNativeEvent({ seriesCuid: 'swim', scope: 'all', actingUserId: 1, startsAt: at('2026-09-01 18:00'), endsAt: at('2026-09-01 19:00') });
    assert(row('moved').startsAt === null && iso(row('moved').originalStartsAt) === iso(at('2026-10-20 18:00')), 'a new start still moves it');
  });

  await check('a rule with fixed days (BYDAY=MO,WE, as the bot writes): a day move for every one, or this and the ones after, is refused before anything is written, for the bot (FIXED_DAYS) and directly, events and reminders; a new time of day goes for both scopes', async () => {
    const seed = (kind: 'EVENT' | 'REMINDER' = 'EVENT') => {
      reset();
      seedEvent('cls', { kind, calendarId: 'raziel', creatorUserId: 1, title: 'Class', startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', exdates: [at('2026-10-19 10:00')] });
      tables.nativeEventInstance.push(
        instance('ren', 'cls', '2026-10-21 10:00', { status: 'OVERRIDE', title: 'Special' }),
        instance('can', 'cls', '2026-10-26 10:00', { status: 'CANCELLED' }),
      );
      return JSON.stringify([tables.nativeEvent, tables.nativeEventInstance]);
    };
    const wed = at('2026-10-14 10:00');
    const outcome = (write: () => Promise<unknown>) => write().then(() => 'allowed', (err: Error) => err.name);
    for (const kind of ['EVENT', 'REMINDER'] as const) {
      let before = seed(kind);
      // The bot: "move all of them to Thursday", said of Wednesday the 14th.
      const bot = await nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('cls', wed), { startTime: at('2026-10-15 10:00'), endTime: at(kind === 'EVENT' ? '2026-10-15 11:00' : '2026-10-15 10:00'), scope: 'all' });
      assert(!bot.success && bot.error === 'FIXED_DAYS', `${kind} bot: ${JSON.stringify(bot)}`);
      assert(JSON.stringify([tables.nativeEvent, tables.nativeEventInstance]) === before, `${kind}: the bot's refused move wrote`);
      for (const scope of ['all', 'following'] as const) {
        before = seed(kind);
        const startsAt = scope === 'all' ? at('2026-10-06 10:00') : at('2026-10-15 10:00');
        const result = await outcome(() => updateNativeEvent({ seriesCuid: 'cls', instanceStartsAt: wed, scope, actingUserId: 1, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) }));
        assert(result === 'NativeFixedDaysError', `${kind} ${scope}: ${result}`);
        assert(JSON.stringify([tables.nativeEvent, tables.nativeEventInstance]) === before, `${kind} ${scope}: a refused move wrote`);
      }
      // A new time of day: every Monday and Wednesday at 11:00, the skipped Monday still skipped.
      seed(kind);
      const later = await nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('cls', wed), { startTime: at('2026-10-14 11:00'), endTime: at(kind === 'EVENT' ? '2026-10-14 12:00' : '2026-10-14 11:00'), scope: 'all' });
      assert(later.success && iso(eventRow('cls').startsAt) === iso(at('2026-10-05 11:00')), `${kind} a new time: ${JSON.stringify(later)} ${iso(eventRow('cls').startsAt)}`);
      const days = startsOf('cls', '2026-10-12 00:00', '2026-10-29 00:00');
      assert(days.join() === ['2026-10-12', '2026-10-14', '2026-10-21', '2026-10-28'].map((d) => iso(at(`${d} 11:00`))).join(), `${kind} occurrences ${days.join()}`);
      seed(kind);
      const split = await outcome(() => updateNativeEvent({ seriesCuid: 'cls', instanceStartsAt: wed, scope: 'following', actingUserId: 1, startsAt: at('2026-10-14 12:00'), endsAt: at('2026-10-14 13:00') }));
      assert(split === 'allowed', `${kind} following at a new time: ${split}`);
    }
  });

  await check('asking whether an edit would be refused as a fixed-days move (the bot asks before its card) agrees with the write and writes nothing: Thursday for every Wednesday is refused, a new time or one occurrence is not, a rule that follows its start is not, and a gone series is not', async () => {
    reset();
    seedEvent('cls', { calendarId: 'raziel', creatorUserId: 1, title: 'Class', startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
    seedEvent('open', { calendarId: 'raziel', creatorUserId: 1, title: 'Swim', startsAt: at('2026-10-06 10:00'), rrule: 'FREQ=WEEKLY' });
    const before = JSON.stringify([tables.nativeEvent, tables.nativeEventInstance]);
    const wed = at('2026-10-14 10:00');
    const asks = (seriesCuid: string, scope: 'single' | 'all' | 'following', startsAt: Date, instanceStartsAt = wed) =>
      store.refusesFixedDays({ seriesCuid, instanceStartsAt, scope, actingUserId: 1, occurrenceTimes: true, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) });
    for (const scope of ['all', 'following'] as const) {
      assert(await asks('cls', scope, at('2026-10-15 10:00')), `${scope}: Thursday for every Wednesday`);
      assert(!(await asks('cls', scope, at('2026-10-14 11:00'))), `${scope}: a new time of day`);
    }
    assert(!(await asks('cls', 'single', at('2026-10-15 10:00'))), 'one occurrence');
    assert(!(await asks('open', 'all', at('2026-10-14 10:00'), at('2026-10-13 10:00'))), 'a rule that follows its start');
    assert(!(await asks('missing', 'all', at('2026-10-15 10:00'))), 'a series that is gone');
    assert(JSON.stringify([tables.nativeEvent, tables.nativeEventInstance]) === before, 'asking wrote');
    const asked = await nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('cls', wed), { startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), scope: 'all' });
    assert(!asked.success && asked.error === 'FIXED_DAYS', 'the write agrees');
    const { wouldRefuseFixedDays } = await import('../src/services/calendar-provider/native-provider');
    const thursday = { startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), scope: 'all' as const };
    assert(await wouldRefuseFixedDays(tables.user[0] as never, 'native:raziel', encodeEventId('cls', wed), thursday), 'the provider asks for the bot');
    assert(!(await wouldRefuseFixedDays(tables.user[0] as never, 'primary', 'x', thursday)), 'another calendar is not asked');
  });

  await check('this and the ones after, from an occurrence moved on its own to another day: a new time starts the new series on the rule\'s day (the slot\'s), not the day it was moved to; on a rule that follows its start, a new day starts it on the date entered, for the bot too', async () => {
    reset();
    seedEvent('cls', { calendarId: 'raziel', creatorUserId: 1, title: 'Class', startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', exdates: [at('2026-10-19 10:00')] });
    tables.nativeEventInstance.push(instance('mv', 'cls', '2026-10-14 10:00', { status: 'OVERRIDE', startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 11:00') }));
    const result = await updateNativeEvent({ seriesCuid: 'cls', instanceStartsAt: at('2026-10-14 10:00'), scope: 'following', actingUserId: 1, startsAt: at('2026-10-15 11:00'), endsAt: at('2026-10-15 12:00') });
    const child = eventRow(result.canonicalEventId);
    assert(iso(child.startsAt) === iso(at('2026-10-14 11:00')) && iso(child.endsAt) === iso(at('2026-10-14 12:00')), `the new series ${iso(child.startsAt)} - ${iso(child.endsAt)}`);
    const days = startsOf(child.id, '2026-10-12 00:00', '2026-10-29 00:00');
    assert(days.join() === ['2026-10-14', '2026-10-21', '2026-10-26', '2026-10-28'].map((d) => iso(at(`${d} 11:00`))).join(), `occurrences ${days.join()}`);
    // On a rule that follows its start, a new day starts the new series on the date entered
    // (Friday), through the bot's path too; a new time alone keeps the slot's day.
    for (const [what, write] of [
      ['the store', () => updateNativeEvent({ seriesCuid: 'swim', instanceStartsAt: at('2026-10-27 10:00'), scope: 'following', actingUserId: 1, startsAt: at('2026-10-30 10:00'), endsAt: at('2026-10-30 11:00') })],
      ['the bot', () => nativeProvider.updateEvent(tables.user[0] as never, 'native:raziel', encodeEventId('swim', at('2026-10-27 10:00')), { startTime: at('2026-10-30 10:00'), endTime: at('2026-10-30 11:00'), scope: 'following' })],
    ] as const) {
      reset();
      seedEvent('swim', { calendarId: 'raziel', creatorUserId: 1, title: 'Swimming', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY' });
      tables.nativeEventInstance.push(instance('thu', 'swim', '2026-10-27 10:00', { status: 'OVERRIDE', startsAt: at('2026-10-29 10:00'), endsAt: at('2026-10-29 11:00') }));
      await write();
      const fri = tables.nativeEvent.find((e) => e.id !== 'swim')!;
      assert(iso(fri.startsAt) === iso(at('2026-10-30 10:00')), `${what}: the new series starts ${iso(fri.startsAt)}`);
      assert(startsOf(fri.id, '2026-10-27 00:00', '2026-11-14 00:00').join() === ['2026-10-30', '2026-11-06', '2026-11-13'].map((d) => iso(at(`${d} 10:00`))).join(), `${what}: Fridays`);
    }
    reset();
    seedEvent('swim', { calendarId: 'raziel', creatorUserId: 1, title: 'Swimming', startsAt: at('2026-10-20 10:00'), rrule: 'FREQ=WEEKLY' });
    tables.nativeEventInstance.push(instance('thu', 'swim', '2026-10-27 10:00', { status: 'OVERRIDE', startsAt: at('2026-10-29 10:00'), endsAt: at('2026-10-29 11:00') }));
    const timeOnly = await updateNativeEvent({ seriesCuid: 'swim', instanceStartsAt: at('2026-10-27 10:00'), scope: 'following', actingUserId: 1, startsAt: at('2026-10-29 12:00'), endsAt: at('2026-10-29 13:00') });
    assert(iso(eventRow(timeOnly.canonicalEventId).startsAt) === iso(at('2026-10-27 12:00')), `a new time alone: ${iso(eventRow(timeOnly.canonicalEventId).startsAt)}`);
    // Moved back to its own day from there is a day move: refused.
    reset();
    seedEvent('cls', { calendarId: 'raziel', creatorUserId: 1, title: 'Class', startsAt: at('2026-10-05 10:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
    tables.nativeEventInstance.push(instance('mv', 'cls', '2026-10-14 10:00', { status: 'OVERRIDE', startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 11:00') }));
    const back = await updateNativeEvent({ seriesCuid: 'cls', instanceStartsAt: at('2026-10-14 10:00'), scope: 'following', actingUserId: 1, startsAt: at('2026-10-14 10:00'), endsAt: at('2026-10-14 11:00') }).then(() => 'allowed', (err: Error) => err.name);
    assert(back === 'NativeFixedDaysError', `back to its day: ${back}`);
  });

  await check('a moved series keeps a skipped or renamed occurrence only where its rule still has one: monthly on the 30th moved to the 31st has no 1 May, for every one and for this and the ones after', async () => {
    const seed = () => {
      reset();
      seedEvent('rent', { calendarId: 'raziel', creatorUserId: 1, title: 'Rent', startsAt: at('2026-01-30 09:00'), rrule: 'FREQ=MONTHLY', exdates: [at('2026-03-30 09:00'), at('2026-06-30 09:00')] });
      tables.nativeEventInstance.push(
        instance('apr', 'rent', '2026-04-30 09:00', { status: 'OVERRIDE', title: 'Rent (late)' }),
        instance('jul', 'rent', '2026-07-30 09:00', { status: 'OVERRIDE', title: 'Rent (July)' }),
      );
    };
    seed();
    await updateNativeEvent({ seriesCuid: 'rent', scope: 'all', actingUserId: 1, startsAt: at('2026-01-31 09:00'), endsAt: at('2026-01-31 10:00') });
    assert((eventRow('rent').exdates as Date[]).map(iso).join() === iso(at('2026-03-31 09:00')), `exdates ${(eventRow('rent').exdates as Date[]).map(iso).join()}`);
    assert(tables.nativeEventInstance.map((r) => `${r.id} ${iso(r.originalStartsAt)}`).join() === `jul ${iso(at('2026-07-31 09:00'))}`, `rows ${tables.nativeEventInstance.map((r) => `${r.id} ${iso(r.originalStartsAt)}`).join()}`);
    const months = startsOf('rent', '2026-03-01 00:00', '2026-08-15 00:00');
    assert(months.join() === ['2026-05-31', '2026-07-31'].map((d) => iso(at(`${d} 09:00`))).join(), `occurrences ${months.join()}`);
    seed();
    const split = await updateNativeEvent({ seriesCuid: 'rent', instanceStartsAt: at('2026-03-30 09:00'), scope: 'following', actingUserId: 1, startsAt: at('2026-03-31 09:00'), endsAt: at('2026-03-31 10:00') });
    const child = eventRow(split.canonicalEventId);
    assert((child.exdates as Date[]).map(iso).join() === iso(at('2026-03-31 09:00')), `child exdates ${(child.exdates as Date[]).map(iso).join()}`);
    assert(tables.nativeEventInstance.map((r) => r.id).join() === 'jul' && row('jul').seriesEventId === child.id, `child rows ${tables.nativeEventInstance.map((r) => r.id).join()}`);
  });

  await check('a moved series moves its UNTIL: a split parent moved an hour earlier gains no occurrence on the cut\'s day; one "until 24 November" moved to Wednesdays keeps its last week; a COUNT is left alone', async () => {
    reset();
    seedEvent('walk', { calendarId: 'raziel', creatorUserId: 1, title: 'Walk', startsAt: at('2026-10-10 10:00'), rrule: 'FREQ=DAILY' });
    const split = await updateNativeEvent({ seriesCuid: 'walk', instanceStartsAt: at('2026-10-14 10:00'), scope: 'following', actingUserId: 1, title: 'Walk 2' });
    await updateNativeEvent({ seriesCuid: 'walk', instanceStartsAt: at('2026-10-12 10:00'), scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 09:00'), endsAt: at('2026-10-10 10:00') });
    const parent = startsOf('walk', '2026-10-12 00:00', '2026-10-16 00:00');
    assert(parent.join() === ['2026-10-12', '2026-10-13'].map((d) => iso(at(`${d} 09:00`))).join(), `the parent: ${parent.join()}`);
    assert(startsOf(eventRow(split.canonicalEventId).id, '2026-10-12 00:00', '2026-10-16 00:00')[0] === iso(at('2026-10-14 10:00')), 'the split');
    reset();
    seedEvent('swim', { calendarId: 'raziel', creatorUserId: 1, title: 'Swimming', startsAt: at('2026-10-20 17:00'), rrule: 'FREQ=WEEKLY;UNTIL=20261124' });
    await updateNativeEvent({ seriesCuid: 'swim', scope: 'all', actingUserId: 1, startsAt: at('2026-10-21 17:00'), endsAt: at('2026-10-21 18:00') });
    assert(eventRow('swim').rrule === 'FREQ=WEEKLY;UNTIL=20261125', `rule ${eventRow('swim').rrule}`);
    assert(startsOf('swim', '2026-11-15 00:00', '2026-12-10 00:00').join() === ['2026-11-18', '2026-11-25'].map((d) => iso(at(`${d} 17:00`))).join(), 'the last Wednesday stays');
    const { shiftUntil } = await import('../src/services/native-calendar/recurrence');
    const from = at('2026-10-20 17:00');
    const to = at('2026-10-21 16:30');
    assert(shiftUntil('FREQ=DAILY;UNTIL=20261124T165959', from, to, IL) === 'FREQ=DAILY;UNTIL=20261125T162959', 'a floating UNTIL moves on the wall clock');
    assert(shiftUntil('FREQ=DAILY;UNTIL=20261124T145959Z', from, to, IL) === 'FREQ=DAILY;UNTIL=20261125T142959Z', 'a Z one moves as wall time too');
    assert(shiftUntil('FREQ=DAILY;COUNT=5', from, to, IL) === 'FREQ=DAILY;COUNT=5', 'a COUNT stays');
  });

  await check('following, by the partner: state rows from the cut go, earlier ones stay; a cancellation after the cut follows to the new time; the new series keeps kind, person and creator', async () => {
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
    const split = eventRow(result.canonicalEventId);
    const skip = tables.nativeEventInstance.find((r) => r.id === 'ov');
    assert(skip !== undefined && skip.seriesEventId === split.id && iso(skip.originalStartsAt) === iso(at('2026-10-16 07:30')) && skip.status === 'CANCELLED', `the cancellation ${JSON.stringify(skip)}`);
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

  await check('a "from now on" reminder edit that keeps the time keeps what was skipped or moved after the cut; one that moves the time keeps what was skipped, keyed at the new time, and drops what was moved', async () => {
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
    // A change of time starts afresh, but what was skipped stays skipped at the new time.
    seed('REMINDER');
    const moved = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 1, startsAt: at('2026-10-14 09:00') });
    const later = eventRow(moved.canonicalEventId);
    assert((later.exdates as Date[]).map(iso).join() === iso(at('2026-10-17 09:00')), `exdates ${(later.exdates as Date[]).map(iso).join()}`);
    assert(tables.nativeEventInstance.map((r) => r.id).sort().join() === 'before,skip', `overrides left ${tables.nativeEventInstance.map((r) => r.id).join()}`);
    assert(ovs('skip').seriesEventId === later.id && iso(ovs('skip').originalStartsAt) === iso(at('2026-10-16 09:00')), `skip at ${iso(ovs('skip').originalStartsAt)}`);
    const afresh = expandSeries(later as never, { from: at('2026-10-14 00:00'), to: at('2026-10-20 00:00') }, tables.nativeEventInstance.filter((r) => r.seriesEventId === later.id) as never).map((i) => iso(i.startsAt));
    assert(afresh.join() === ['2026-10-14', '2026-10-15', '2026-10-18', '2026-10-19'].map((d) => iso(at(`${d} 09:00`))).join(), `expanded ${afresh.join()}`);
  });

  await check('a "from now on" event split carries what was skipped or moved after the cut to its new series: kept where it was with the time, keyed where the new series puts it when the time moves (the moved ones back on the new time), across a DST change too', async () => {
    const ov = { ...DEFAULTS.nativeEventInstance(), seriesEventId: 'daily' };
    const seed = () => {
      reset();
      seedEvent('daily', { calendarId: 'raziel', creatorUserId: 1, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY', exdates: [at('2026-10-12 08:00'), at('2026-10-17 08:00')] });
      tables.nativeEventInstance.push(
        { ...ov, id: 'skip', originalStartsAt: at('2026-10-16 08:00'), status: 'CANCELLED' },
        { ...ov, id: 'moved', originalStartsAt: at('2026-10-18 08:00'), status: 'OVERRIDE', startsAt: at('2026-10-18 12:00'), endsAt: at('2026-10-18 13:00'), title: 'Old title', location: 'Home' },
        { ...ov, id: 'before', originalStartsAt: at('2026-10-13 08:00'), status: 'CANCELLED' },
      );
    };
    const cut = at('2026-10-14 08:00');
    const ovs = (id: string) => tables.nativeEventInstance.find((r) => r.id === id)!;
    const starts = (seriesId: unknown, from: string, to: string) =>
      expandSeries(eventRow(String(seriesId)) as never, { from: at(from), to: at(to) }, tables.nativeEventInstance.filter((r) => r.seriesEventId === seriesId) as never).map((i) => iso(i.startsAt));
    // A new title from the cut: the same keys, under the new series.
    seed();
    const kept = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 1, title: 'Feed the dog' });
    const split = eventRow(kept.canonicalEventId);
    assert((split.exdates as Date[]).map(iso).join() === iso(at('2026-10-17 08:00')), `exdates ${(split.exdates as Date[]).map(iso).join()}`);
    assert(ovs('skip').seriesEventId === split.id && iso(ovs('skip').originalStartsAt) === iso(at('2026-10-16 08:00')) && ovs('skip').status === 'CANCELLED', `skip ${JSON.stringify(ovs('skip'))}`);
    assert(ovs('moved').seriesEventId === split.id && iso(ovs('moved').startsAt) === iso(at('2026-10-18 12:00')), 'the moved one did not follow');
    assert(ovs('moved').title === null && ovs('moved').location === 'Home', `title ${ovs('moved').title}, location ${ovs('moved').location}`);
    assert(ovs('before').seriesEventId === 'daily', 'an override before the cut moved');
    assert(starts(split.id, '2026-10-14 00:00', '2026-10-19 00:00').join() === ['2026-10-14 08:00', '2026-10-15 08:00', '2026-10-18 12:00'].map((d) => iso(at(d))).join(), `expanded ${starts(split.id, '2026-10-14 00:00', '2026-10-19 00:00').join()}`);
    // A new time from the cut: each keyed at the new time; the moved one takes it; its location stays.
    seed();
    const retimed = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 1, startsAt: at('2026-10-14 09:30'), endsAt: at('2026-10-14 10:30') });
    const later = eventRow(retimed.canonicalEventId);
    assert((later.exdates as Date[]).map(iso).join() === iso(at('2026-10-17 09:30')), `exdates ${(later.exdates as Date[]).map(iso).join()}`);
    assert(iso(ovs('skip').originalStartsAt) === iso(at('2026-10-16 09:30')) && ovs('skip').seriesEventId === later.id, `skip at ${iso(ovs('skip').originalStartsAt)}`);
    assert(iso(ovs('moved').originalStartsAt) === iso(at('2026-10-18 09:30')) && ovs('moved').startsAt === null && ovs('moved').endsAt === null, `moved ${JSON.stringify(ovs('moved'))}`);
    assert(ovs('moved').title === 'Old title' && ovs('moved').location === 'Home', 'what the edit did not set stays');
    assert(starts(later.id, '2026-10-14 00:00', '2026-10-19 00:00').join() === ['2026-10-14 09:30', '2026-10-15 09:30', '2026-10-18 09:30'].map((d) => iso(at(d))).join(), `expanded ${starts(later.id, '2026-10-14 00:00', '2026-10-19 00:00').join()}`);
    assert(starts('daily', '2026-10-10 00:00', '2026-10-19 00:00').length === 2, `the old series: ${starts('daily', '2026-10-10 00:00', '2026-10-19 00:00').join()}`);
    // A weekly one moved from Saturday 24 October (summer time) to Sunday the 25th (winter
    // time): the skipped Saturday 31st is the skipped Sunday 1 November, still at 08:00.
    reset();
    seedEvent('weekly', { calendarId: 'raziel', creatorUserId: 1, title: 'Market', startsAt: at('2026-10-17 08:00'), rrule: 'FREQ=WEEKLY', exdates: [at('2026-10-31 08:00')] });
    const dst = await updateNativeEvent({ seriesCuid: 'weekly', instanceStartsAt: at('2026-10-24 08:00'), scope: 'following', actingUserId: 1, startsAt: at('2026-10-25 08:00'), endsAt: at('2026-10-25 09:00') });
    const sunday = eventRow(dst.canonicalEventId);
    assert((sunday.exdates as Date[]).map(iso).join() === iso(at('2026-11-01 08:00')), `exdates ${(sunday.exdates as Date[]).map(iso).join()}`);
    assert(starts(sunday.id, '2026-10-24 00:00', '2026-11-09 00:00').join() === ['2026-10-25 08:00', '2026-11-08 08:00'].map((d) => iso(at(d))).join(), `expanded ${starts(sunday.id, '2026-10-24 00:00', '2026-11-09 00:00').join()}`);
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

  await check('a stranger and an ex-partner are refused; a partner with Google connected is not (Google as a connection)', async () => {
    reset();
    seedEvent('mine', { kind: 'REMINDER', calendarId: 'dana', creatorUserId: 2, forUserId: 1, title: 'Call the bank', startsAt: at('2026-10-15 09:00') });
    seedEvent('for-noa', { kind: 'REMINDER', calendarId: 'avi', creatorUserId: 5, forUserId: 4, title: 'Pick up the bike', startsAt: at('2026-10-15 09:00') });
    seedEvent('for-maya', { kind: 'REMINDER', calendarId: 'lior', creatorUserId: 6, forUserId: 7, title: 'Book the vet', startsAt: at('2026-10-15 09:00') });
    await refused('a stranger updating', () => updateNativeEvent({ seriesCuid: 'mine', scope: 'single', actingUserId: 3, title: 'x' }));
    await refused('a stranger deleting', () => deleteNativeEvent({ seriesCuid: 'mine', scope: 'all', actingUserId: 3 }));
    await refused('an ex-partner deleting', () => deleteNativeEvent({ seriesCuid: 'for-noa', scope: 'all', actingUserId: 4 }));
    assert(tables.nativeEvent.every((r) => r.isDeleted === false && r.title !== 'x'), 'a refused write still landed');
    await deleteNativeEvent({ seriesCuid: 'for-maya', scope: 'all', actingUserId: 7 });
    assert(tables.nativeEvent.find((r) => r.id === 'for-maya')?.isDeleted === true, 'the partner with Google connected could not delete their reminder');
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

  // ---- Reminders by zman (plan 2026-10-28-zmanim-reminders, Task 3) ----
  // NativeEvent.zmanSpec: { zman, offsetMin } or { halachicHours, offsetMin }, only on a date-only reminder; a series-level
  // field (so 'this one' on a series is refused), cleared when the reminder is given a time of day, and a move of one
  // occurrence to a time of its own is a fixed-time override.

  const SHEMA = { zman: 'SOF_SHMA_GRA', offsetMin: -10 };
  const ALOT_IN_5 = { zman: 'ALOT', offsetMin: 5 };
  const { Prisma } = await import('@prisma/client');
  const specOf = (id: string) => {
    const v = eventRow(id).zmanSpec;
    return v === undefined || v === null || v === Prisma.DbNull ? null : v;
  };
  const dayStart = (day: string) => at(`${day} 00:00`);

  /** A daily date-only reminder by zman from Oct 10, with two pinged occurrences (Oct 13 done, Oct 14 open with a live ping). */
  function zmanSeries(rrule: string | null = 'FREQ=DAILY') {
    reset();
    seedEvent('zrem', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Take the pill', startsAt: dayStart('2026-10-10'), allDay: true, rrule, zmanSpec: SHEMA });
    if (!rrule) return;
    seedState('zrem', dayStart('2026-10-13'), 31, { doneAt: at('2026-10-13 09:40') });
    seedState('zrem', dayStart('2026-10-14'), 32, {});
  }

  await check('zman create: a date-only reminder stores the rule (and re-arms like any reminder); a timed one, an event, an unknown zman are refused with NativeScopeError and write nothing; a plain reminder stores none', async () => {
    reset();
    closeGate();
    const base = { calendarCuid: 'raziel', creatorUserId: 1, title: 'Take the pill', timeZone: IL };
    const made = await createNativeEvent({ ...base, kind: 'REMINDER', allDay: true, startsAt: dayStart('2026-10-15'), endsAt: dayStart('2026-10-15'), zmanSpec: SHEMA });
    assert(JSON.stringify(specOf(made.id)) === JSON.stringify(SHEMA), `stored ${JSON.stringify(specOf(made.id))}`);
    assert(fresh(eventRow(made.id).armedAt) && gateCleared(), 'armed, and the gate is woken');
    const plain = await createNativeEvent({ ...base, kind: 'REMINDER', allDay: true, startsAt: dayStart('2026-10-15'), endsAt: dayStart('2026-10-15') });
    assert(specOf(plain.id) === null, 'a plain reminder has none');
    const rows = tables.nativeEvent.length;
    const refusals: Array<[string, Row]> = [
      ['a timed reminder', { kind: 'REMINDER', allDay: false, startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 10:00'), zmanSpec: SHEMA }],
      ['an event', { allDay: true, startsAt: dayStart('2026-10-15'), endsAt: dayStart('2026-10-16'), zmanSpec: SHEMA }],
      ['an unknown zman', { kind: 'REMINDER', allDay: true, startsAt: dayStart('2026-10-15'), endsAt: dayStart('2026-10-15'), zmanSpec: { zman: 'NOT_A_ZMAN', offsetMin: 0 } }],
      ['a rule that is not one', { kind: 'REMINDER', allDay: true, startsAt: dayStart('2026-10-15'), endsAt: dayStart('2026-10-15'), zmanSpec: { zman: 'ALOT' } }],
    ];
    for (const [what, input] of refusals) {
      const outcome = await createNativeEvent({ ...base, ...input } as Parameters<typeof createNativeEvent>[0]).then(() => 'allowed', (err: Error) => `${err.name}/${(err as { field?: string }).field}`);
      assert(outcome === 'NativeScopeError/zmanSpec', `${what}: ${outcome}`);
    }
    assert(tables.nativeEvent.length === rows, 'a refusal wrote a row');
  });

  await check('zman update (a one-off): setting or changing the rule re-arms it and starts the occurrence afresh, its live ping reads "changed" (not "moved to <day>": nothing moved); the same rule is no change at all', async () => {
    zmanSeries(null);
    eventRow('zrem').zmanSpec = undefined;
    seedState('zrem', dayStart('2026-10-10'), 41, {});
    closeGate();
    const r = await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', actingUserId: 1, zmanSpec: SHEMA });
    assert(JSON.stringify(specOf('zrem')) === JSON.stringify(SHEMA), `stored ${JSON.stringify(specOf('zrem'))}`);
    assert(fresh(eventRow('zrem').armedAt), 'armed');
    assert(tables.nativeReminderState.length === 0, 'the occurrence starts afresh');
    assert(r.clearedPings.length === 0 && pings(r.changedPings) === '5001/41', `moved ${pings(r.clearedPings)} changed ${pings(r.changedPings)}`);
    assert(gateCleared(), 'the gate is woken');
    // The same rule again changes nothing.
    seedState('zrem', dayStart('2026-10-10'), 42, {});
    const armed = eventRow('zrem').armedAt;
    closeGate();
    const same = await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', actingUserId: 1, zmanSpec: { ...SHEMA } });
    assert(eventRow('zrem').armedAt === armed && stateKeys('zrem').length === 1 && same.changedPings.length === 0, 'a no-op write re-armed or cleared');
    // A new offset is a change.
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', actingUserId: 1, zmanSpec: ALOT_IN_5 });
    assert(JSON.stringify(specOf('zrem')) === JSON.stringify(ALOT_IN_5) && stateKeys('zrem').length === 0, 'changed');
    // null takes it away (the reminder is then a plain date-only one at the reminder time).
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', actingUserId: 1, zmanSpec: null });
    assert(specOf('zrem') === null, 'taken away');
  });

  await check('zman update: a rule equal to the series\' own is no change at all, even with "only this one" on a series (nothing is refused or written); the rule written another way (a key, an offset) is a change', async () => {
    zmanSeries();
    const armed = eventRow('zrem').armedAt;
    const r = await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', instanceStartsAt: dayStart('2026-10-14'), actingUserId: 1, zmanSpec: { ...SHEMA }, title: 'Take the pill (blue box)' });
    assert(r.clearedPings.length + r.changedPings.length === 0 && eventRow('zrem').armedAt === armed && stateKeys('zrem').length === 2, 'the same rule re-armed or cleared');
    assert(tables.nativeEventInstance.some((o) => o.title === 'Take the pill (blue box)'), 'the rename went through as this occurrence\'s');
    for (const other of [ALOT_IN_5, { zman: 'SOF_SHMA_GRA', offsetMin: -15 }, { halachicHours: 3, offsetMin: -10 }]) {
      const outcome = await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', instanceStartsAt: dayStart('2026-10-14'), actingUserId: 1, zmanSpec: other }).then(() => 'allowed', (err: Error) => `${err.name}/${(err as { field?: string }).field}`);
      assert(outcome === 'NativeScopeError/scope', `${JSON.stringify(other)}: ${outcome}`);
    }
  });

  await check('zman update (a series, "all"): a new rule starts every occurrence afresh and the overrides stay (a fixed-time override is unaffected); the pings read "changed"', async () => {
    zmanSeries();
    tables.nativeEventInstance.push({ ...DEFAULTS.nativeEventInstance(), id: 'ov1', seriesEventId: 'zrem', originalStartsAt: dayStart('2026-10-15'), status: 'OVERRIDE', startsAt: at('2026-10-15 14:00'), endsAt: at('2026-10-15 14:00'), allDay: false });
    const r = await updateNativeEvent({ seriesCuid: 'zrem', scope: 'all', actingUserId: 1, zmanSpec: ALOT_IN_5 });
    assert(JSON.stringify(specOf('zrem')) === JSON.stringify(ALOT_IN_5), 'the new rule');
    assert(stateKeys('zrem').length === 0, 'every state is gone');
    assert(tables.nativeEventInstance.length === 1, 'the override stays');
    assert(r.clearedPings.length === 0 && pings(r.changedPings) === '5001/31, 5001/32', `changed ${pings(r.changedPings)}`);
    assert(fresh(eventRow('zrem').armedAt), 'armed from now, so a past occurrence does not ping');
  });

  await check('zman update: it is a series-level field: "this one" of a series is refused (NativeScopeError, nothing written); "this one" with a start and allDay false is a fixed-time override that leaves the series\' rule alone', async () => {
    zmanSeries();
    const outcome = await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', instanceStartsAt: dayStart('2026-10-14'), actingUserId: 1, zmanSpec: ALOT_IN_5 }).then(() => 'allowed', (err: Error) => `${err.name}/${(err as { field?: string }).field}`);
    assert(outcome === 'NativeScopeError/scope', outcome);
    assert(JSON.stringify(specOf('zrem')) === JSON.stringify(SHEMA) && tables.nativeEventInstance.length === 0, 'nothing written');
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'single', instanceStartsAt: dayStart('2026-10-15'), actingUserId: 1, startsAt: at('2026-10-15 14:00'), endsAt: at('2026-10-15 14:00'), allDay: false });
    const override = tables.nativeEventInstance.find((o) => same(o.originalStartsAt, dayStart('2026-10-15')))!;
    assert(override && override.allDay === false && iso(override.startsAt) === iso(at('2026-10-15 14:00')), `the override ${JSON.stringify(override)}`);
    assert(JSON.stringify(specOf('zrem')) === JSON.stringify(SHEMA), 'the series keeps its rule');
  });

  await check('zman update: "this one and the ones after" gives the new part the new rule and leaves the earlier ones theirs (and their states); from the first occurrence it is the series itself', async () => {
    zmanSeries();
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'following', instanceStartsAt: dayStart('2026-10-14'), actingUserId: 1, zmanSpec: ALOT_IN_5 });
    const tail = tables.nativeEvent.find((e) => e.id !== 'zrem' && e.kind === 'REMINDER')!;
    assert(JSON.stringify(specOf(tail.id as string)) === JSON.stringify(ALOT_IN_5) && fresh(tail.armedAt), 'the new part');
    assert(JSON.stringify(specOf('zrem')) === JSON.stringify(SHEMA), 'the earlier part keeps its own');
    assert(stateKeys('zrem').length === 1 && stateKeys(tail.id as string).length === 0, `earlier states stay, the new part starts afresh: ${stateKeys('zrem')} / ${stateKeys(tail.id as string)}`);
    zmanSeries();
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'following', instanceStartsAt: dayStart('2026-10-10'), actingUserId: 1, zmanSpec: ALOT_IN_5 });
    assert(tables.nativeEvent.length === 1 && JSON.stringify(specOf('zrem')) === JSON.stringify(ALOT_IN_5), 'from the first occurrence: in place');
  });

  await check('zman update: giving the reminder a time of day takes the rule away (a timed reminder is a fixed time), "all" or "following"; a rule asked for beside a time of day, or on a timed reminder, is refused', async () => {
    zmanSeries();
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 11:00'), endsAt: at('2026-10-10 11:00'), allDay: false, occurrenceTimes: false });
    assert(specOf('zrem') === null && eventRow('zrem').allDay === false, `rule ${JSON.stringify(specOf('zrem'))} allDay ${eventRow('zrem').allDay}`);
    zmanSeries();
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'following', instanceStartsAt: dayStart('2026-10-14'), actingUserId: 1, startsAt: at('2026-10-14 11:00'), endsAt: at('2026-10-14 11:00'), allDay: false });
    const tail = tables.nativeEvent.find((e) => e.id !== 'zrem' && e.kind === 'REMINDER')!;
    assert(specOf(tail.id as string) === null && JSON.stringify(specOf('zrem')) === JSON.stringify(SHEMA), 'the new part is timed, the earlier keeps its rule');
    zmanSeries();
    const both = await updateNativeEvent({ seriesCuid: 'zrem', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 11:00'), endsAt: at('2026-10-10 11:00'), allDay: false, zmanSpec: ALOT_IN_5 }).then(() => 'allowed', (err: Error) => `${err.name}/${(err as { field?: string }).field}`);
    assert(both === 'NativeScopeError/zmanSpec', `a rule beside a time of day: ${both}`);
    reset();
    seedEvent('timed', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, startsAt: at('2026-10-15 10:00'), allDay: false });
    const onTimed = await updateNativeEvent({ seriesCuid: 'timed', scope: 'single', actingUserId: 1, zmanSpec: SHEMA }).then(() => 'allowed', (err: Error) => `${err.name}/${(err as { field?: string }).field}`);
    assert(onTimed === 'NativeScopeError/zmanSpec' && specOf('timed') === null, `on a timed reminder: ${onTimed}`);
  });

  await check('zman update: an event has no rule: refused; "stop repeating" keeps the rule on a date-only one-off and drops it on a timed one', async () => {
    reset();
    seedEvent('ev', { kind: 'EVENT', calendarId: 'raziel', creatorUserId: 1, startsAt: at('2026-10-15 10:00') });
    const onEvent = await updateNativeEvent({ seriesCuid: 'ev', scope: 'single', actingUserId: 1, zmanSpec: SHEMA }).then(() => 'allowed', (err: Error) => `${err.name}/${(err as { field?: string }).field}`);
    assert(onEvent === 'NativeScopeError/zmanSpec', onEvent);
    zmanSeries();
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'following', instanceStartsAt: dayStart('2026-10-14'), actingUserId: 1, rrule: null });
    const oneOff = tables.nativeEvent.find((e) => e.id !== 'zrem' && e.kind === 'REMINDER')!;
    assert(JSON.stringify(specOf(oneOff.id as string)) === JSON.stringify(SHEMA) && oneOff.rrule === null, 'the one-off keeps the rule');
    zmanSeries();
    tables.nativeEventInstance.push({ ...DEFAULTS.nativeEventInstance(), id: 'ov2', seriesEventId: 'zrem', originalStartsAt: dayStart('2026-10-14'), status: 'OVERRIDE', startsAt: at('2026-10-14 14:00'), endsAt: at('2026-10-14 14:00'), allDay: false });
    await updateNativeEvent({ seriesCuid: 'zrem', scope: 'following', instanceStartsAt: dayStart('2026-10-14'), actingUserId: 1, rrule: null });
    const timedOneOff = tables.nativeEvent.find((e) => e.id !== 'zrem' && e.kind === 'REMINDER')!;
    assert(specOf(timedOneOff.id as string) === null && timedOneOff.allDay === false, `the occurrence moved to 14:00 is a fixed time: ${JSON.stringify(specOf(timedOneOff.id as string))} allDay ${timedOneOff.allDay}`);
  });

  await check('zman read: the provider hands the rule on with the reminder (ReminderInfo.zmanSpec) only when there is one', async () => {
    zmanSeries(null);
    const { reminderInfoFor } = await import('../src/services/calendar-provider/native-provider');
    const ctx = { viewerId: 1, partner: null };
    const withRule = reminderInfoFor(eventRow('zrem') as never, undefined, ctx, new Date());
    assert(JSON.stringify(withRule.zmanSpec) === JSON.stringify(SHEMA), `info ${JSON.stringify(withRule)}`);
    eventRow('zrem').zmanSpec = Prisma.DbNull;
    assert(!('zmanSpec' in reminderInfoFor(eventRow('zrem') as never, undefined, ctx, new Date())), 'a plain one carries none');
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
