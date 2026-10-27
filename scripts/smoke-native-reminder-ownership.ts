// Smoke test for the native reminders' ownership rules and due gate:
// src/services/native-reminders/ownership.ts and due-gate.ts. A reminder's forUserId
// counts only while that user is the creator's ACTIVE partner and on the built-in
// calendar, so unlinking or a switch to Google hands it back to the creator with no
// write. The due gate lets the 1-minute pass skip the database until something may be
// due, without sleeping through a write. Prisma is faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-ownership.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-ownership.ts

import path from 'path';
import {
  __resetDueGateForTests,
  DUE_GATE_CEILING_MS,
  invalidateDueGate,
  setNextDue,
  shouldRunPass,
} from '../src/services/native-reminders/due-gate';
import type { PartnerSummary, ViewerContext } from '../src/services/native-reminders/ownership';

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

/** JSON that can show a BigInt telegramId. */
const show = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

function assertSame(got: unknown, want: unknown) {
  assert(show(got) === show(want), `\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Fake Prisma: users and pairings ----

type Row = Record<string, unknown>;
const USERS: Row[] = [
  { id: 1, name: 'רזיאל', englishName: 'Raziel', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1001), language: 'he', pairingId: 'pair-1', location: 'Tel Aviv' },
  { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', calendarSource: 'NATIVE', telegramId: null, language: 'en', pairingId: 'pair-1', location: '' },
  { id: 3, name: 'Noa', englishName: '', gender: 'female', calendarSource: 'GOOGLE', telegramId: BigInt(1003), language: 'ru', pairingId: 'pair-2', location: '' },
  { id: 4, name: 'Ari', englishName: 'Ari', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1004), language: 'en', pairingId: 'pair-2', location: '' },
];
const PAIRINGS: Row[] = [
  { id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 },
  { id: 'pair-2', status: 'ACTIVE', inviterUserId: 3, inviteeUserId: 4 },
  { id: 'pair-old', status: 'UNLINKED', inviterUserId: 5, inviteeUserId: 1 },
  { id: 'pair-pending', status: 'PENDING', inviterUserId: 6, inviteeUserId: null },
];

/** Every query, to see which reads a lookup made. */
const queries: string[] = [];

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? row : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));

type FindUnique = { where: { id: unknown }; select?: Record<string, boolean> };
const fakePrisma = {
  pairing: {
    findUnique: async ({ where, select }: FindUnique) => {
      queries.push(`pairing ${where.id}`);
      return pick(PAIRINGS.find(p => p.id === where.id), select);
    },
  },
  user: {
    findUnique: async ({ where, select }: FindUnique) => {
      queries.push(`user ${where.id}`);
      return pick(USERS.find(u => u.id === where.id), select);
    },
  },
};

// ---- Viewers ----

const partnerSummary = (id: number): PartnerSummary =>
  ({ id, name: `User ${id}`, englishName: '', gender: 'female', telegramId: null, language: 'en' });
const viewer = (viewerId: number, partner: PartnerSummary | null): ViewerContext => ({ viewerId, partner });

/** A reminder by `creatorUserId`, for `forUserId` (null = the creator). */
const reminder = (creatorUserId: number, forUserId: number | null) => ({ creatorUserId, forUserId });

async function main() {
  // The stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });

  const { effectiveOwnerForViewer, effectiveOwnerId, getActivePartnerSummary, loadViewerContext, pingUserFor, recipientIds, recipientIdsForViewer, userDoneAt, viewerSnoozedUntil } =
    await import('../src/services/native-reminders/ownership');

  // ---- getActivePartnerSummary / loadViewerContext ----

  await check('partner summary: the inviter gets the invitee, with exactly the fields reminders need', async () => {
    assertSame(await getActivePartnerSummary(1, 'pair-1'), {
      id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', telegramId: null, language: 'en',
    });
  });

  await check('partner summary: the invitee gets the inviter', async () => {
    assertSame(await getActivePartnerSummary(2, 'pair-1'), {
      id: 1, name: 'רזיאל', englishName: 'Raziel', gender: 'male', telegramId: BigInt(1001), language: 'he',
    });
  });

  await check('partner summary: no pairing is null, without a query', async () => {
    queries.length = 0;
    assert((await getActivePartnerSummary(1, null)) === null, 'got a partner');
    assert(queries.length === 0, `queried ${queries.join(', ')}`);
  });

  await check('partner summary: an UNLINKED or PENDING pairing is null, and no user is read', async () => {
    queries.length = 0;
    assert((await getActivePartnerSummary(1, 'pair-old')) === null, 'unlinked pairing gave a partner');
    assert((await getActivePartnerSummary(6, 'pair-pending')) === null, 'pending pairing gave a partner');
    assertSame(queries, ['pairing pair-old', 'pairing pair-pending']);
  });

  await check('loadViewerContext: the viewer and their ACTIVE partner, a Google one included', async () => {
    const ctx = await loadViewerContext({ id: 4, pairingId: 'pair-2' });
    assert(ctx.viewerId === 4, `viewerId ${ctx.viewerId}`);
    assert(ctx.partner?.id === 3 && !('calendarSource' in ctx.partner), `partner ${show(ctx.partner)}`);
    const alone = await loadViewerContext({ id: 1, pairingId: null });
    assertSame(alone, { viewerId: 1, partner: null });
  });

  // ---- effectiveOwnerId ----

  await check('owner: no forUserId is the creator', () => {
    assert(effectiveOwnerId(reminder(1, null), partnerSummary(2)) === 1, 'not the creator');
  });

  await check('owner: forUserId = the ACTIVE partner is the partner', () => {
    assert(effectiveOwnerId(reminder(1, 2), partnerSummary(2)) === 2, 'not the partner');
  });

  await check('owner: a partner with Google connected keeps it (Google as a connection: the source column is not read)', () => {
    assert(effectiveOwnerId(reminder(1, 2), { ...partnerSummary(2), calendarSource: 'GOOGLE' } as PartnerSummary) === 2, 'not the partner');
  });

  await check('owner: after unlinking (no partner) it is the creator\'s', () => {
    assert(effectiveOwnerId(reminder(1, 2), null) === 1, 'still the ex-partner');
  });

  await check('owner: forUserId of a stranger, or of the creator, is the creator', () => {
    assert(effectiveOwnerId(reminder(1, 9), partnerSummary(2)) === 1, 'a stranger owns it');
    assert(effectiveOwnerId(reminder(1, 1), partnerSummary(2)) === 1, 'self-target not the creator');
  });

  // ---- effectiveOwnerForViewer ----

  const raziel = viewer(1, partnerSummary(2));
  const dana = viewer(2, partnerSummary(1));

  await check('viewer is the creator: their own reminder is theirs, one for the partner is the partner\'s', () => {
    assert(effectiveOwnerForViewer(reminder(1, null), raziel) === 1, 'own reminder');
    assert(effectiveOwnerForViewer(reminder(1, 2), raziel) === 2, 'reminder for Dana');
  });

  await check('viewer is the partner: one made for them is theirs, the creator\'s own stays the creator\'s', () => {
    assert(effectiveOwnerForViewer(reminder(1, 2), dana) === 2, 'reminder for Dana, seen by Dana');
    assert(effectiveOwnerForViewer(reminder(1, null), dana) === 1, 'Raziel\'s own, seen by Dana');
    assert(effectiveOwnerForViewer(reminder(1, 1), dana) === 1, 'Raziel\'s self-target, seen by Dana');
  });

  await check('viewer is a third party: the creator\'s, whatever forUserId says', () => {
    assert(effectiveOwnerForViewer(reminder(7, 2), raziel) === 7, 'third party\'s reminder for Dana');
    assert(effectiveOwnerForViewer(reminder(7, 1), raziel) === 7, 'third party\'s reminder for the viewer');
  });

  await check('viewer after unlinking: both sides read the creator', () => {
    assert(effectiveOwnerForViewer(reminder(1, 2), viewer(1, null)) === 1, 'creator still sees the ex-partner as owner');
    assert(effectiveOwnerForViewer(reminder(1, 2), viewer(2, null)) === 1, 'ex-partner still owns it');
  });

  await check('viewer whose partner has Google connected: still the partner\'s', () => {
    assert(effectiveOwnerForViewer(reminder(1, 2), viewer(1, { ...partnerSummary(2), calendarSource: 'GOOGLE' } as PartnerSummary)) === 2, 'the creator owns it');
  });

  // ---- recipientIds: remind us both ----

  const both = (creator: number, partner: number | null) => ({ creatorUserId: creator, forUserId: partner, forBoth: true });

  await check('recipients: a single reminder is its effective owner alone, as before', () => {
    assertSame(recipientIds(reminder(1, null), partnerSummary(2)), [1]);
    assertSame(recipientIds(reminder(1, 2), partnerSummary(2)), [2]);
    assertSame(recipientIds(reminder(1, 9), partnerSummary(2)), [1]);
    assertSame(recipientIdsForViewer(reminder(1, 2), raziel), [2]);
    assertSame(recipientIdsForViewer(reminder(1, 2), dana), [2]);
  });

  await check('recipients: a reminder for both is the creator and the ACTIVE partner it names, from either side', () => {
    assertSame(recipientIds(both(1, 2), partnerSummary(2)), [1, 2]);
    assertSame(recipientIdsForViewer(both(1, 2), raziel), [1, 2]);
    assertSame(recipientIdsForViewer(both(1, 2), dana), [1, 2]);
    assertSame(recipientIdsForViewer(both(2, 1), raziel), [2, 1]);
    assertSame(recipientIdsForViewer(both(2, 1), dana), [2, 1]);
  });

  await check('recipients: unpaired, or a new partner, is the creator alone: nothing is written and a later partner never inherits it', () => {
    assertSame(recipientIds(both(1, 2), null), [1]);
    assertSame(recipientIdsForViewer(both(1, 2), viewer(1, null)), [1]);
    assertSame(recipientIdsForViewer(both(1, 2), viewer(2, null)), [1]);
    assertSame(recipientIds(both(1, 2), partnerSummary(5)), [1]);
    assertSame(recipientIdsForViewer(both(1, 2), viewer(1, partnerSummary(5))), [1]);
    // forBoth with no stored partner (forUserId nulled when she deleted her account) is the creator's.
    assertSame(recipientIds(both(1, null), partnerSummary(2)), [1]);
    // A third party's reminder for both is nobody else's.
    assertSame(recipientIdsForViewer(both(7, 2), raziel), [7]);
  });

  await check('recipients: whose ping a snooze is about, and whose snooze the viewer sees', () => {
    assertSame(pingUserFor([1, 2], 2), 2);
    assertSame(pingUserFor([1, 2], 1), 1);
    assertSame(pingUserFor([2], 1), 2); // the creator of a reminder for someone else: the one it pings
    const state = { pings: [{ userId: 1, snoozedUntil: new Date(1000) }, { userId: 2, snoozedUntil: new Date(2000) }] };
    assertSame(viewerSnoozedUntil(both(1, 2), state, raziel), new Date(1000));
    assertSame(viewerSnoozedUntil(both(1, 2), state, dana), new Date(2000));
    assertSame(viewerSnoozedUntil(reminder(1, 2), { pings: [state.pings[1]] }, raziel), new Date(2000));
    assertSame(viewerSnoozedUntil(both(1, 2), { pings: [] }, raziel), null);
    assertSame(viewerSnoozedUntil(both(1, 2), undefined, raziel), null);
  });

  // ---- userDoneAt: "each of us marks it done" ----

  await check('own done: the switch off reads the shared Done only, whatever a ping row says (a stale partial never counts)', () => {
    const shared = new Date(5000);
    const off = { creatorUserId: 1, forUserId: 2, forBoth: true, eachMarksDone: false };
    assertSame(userDoneAt(off, { doneAt: shared, pings: [] }, 1), shared);
    assertSame(userDoneAt(off, { doneAt: null, pings: [{ userId: 1, doneAt: new Date(1000) }] }, 1), null);
    assertSame(userDoneAt({ creatorUserId: 1, forUserId: 2, forBoth: true }, { doneAt: null, pings: [{ userId: 1, doneAt: new Date(1000) }] }, 1), null);
    assertSame(userDoneAt(off, undefined, 1), null);
  });

  await check('own done: the switch on reads the person\'s own ping row, then the shared Done', () => {
    const on = { creatorUserId: 1, forUserId: 2, forBoth: true, eachMarksDone: true };
    const state = { doneAt: null, pings: [{ userId: 1, doneAt: new Date(1000) }, { userId: 2, doneAt: null }] };
    assertSame(userDoneAt(on, state, 1), new Date(1000));
    assertSame(userDoneAt(on, state, 2), null);
    assertSame(userDoneAt(on, { doneAt: new Date(9000), pings: [{ userId: 1, doneAt: new Date(1000) }] }, 1), new Date(1000));
    assertSame(userDoneAt(on, { doneAt: new Date(9000), pings: [] }, 2), new Date(9000)); // done for everyone before the switch went on
    assertSame(userDoneAt(on, { doneAt: null, pings: [{ userId: 2 }] }, 2), null); // a stand-in without the column
    assertSame(userDoneAt(on, undefined, 2), null);
  });

  // ---- Due gate ----

  const t0 = new Date('2026-10-14T09:00:00Z');
  const plus = (ms: number) => new Date(t0.getTime() + ms);
  const MIN = 60 * 1000;

  await check('gate: a fresh process reads the database on its first tick', () => {
    __resetDueGateForTests();
    assert(shouldRunPass(t0), 'closed at start');
  });

  await check('gate: sleeps until the earliest due, then opens', () => {
    __resetDueGateForTests();
    assert(shouldRunPass(t0), 'closed at start');
    setNextDue(plus(10 * MIN), t0);
    assert(!shouldRunPass(plus(10 * MIN - 1)), 'open before the due time');
    assert(shouldRunPass(plus(10 * MIN)), 'closed at the due time');
  });

  await check('gate: never sleeps past the 60-minute ceiling', () => {
    assert(DUE_GATE_CEILING_MS === 60 * MIN, `ceiling ${DUE_GATE_CEILING_MS}`);
    __resetDueGateForTests();
    setNextDue(plus(3 * 60 * MIN), t0);
    assert(!shouldRunPass(plus(60 * MIN - 1)), 'open before the ceiling');
    assert(shouldRunPass(plus(60 * MIN)), 'closed at the ceiling');
  });

  await check('gate: nothing upcoming wakes at the ceiling', () => {
    __resetDueGateForTests();
    setNextDue(null, t0);
    assert(!shouldRunPass(plus(60 * MIN - 1)), 'open before the ceiling');
    assert(shouldRunPass(plus(60 * MIN)), 'closed at the ceiling');
  });

  await check('gate: a reminder write opens it at once', () => {
    __resetDueGateForTests();
    setNextDue(plus(30 * MIN), t0);
    invalidateDueGate();
    assert(shouldRunPass(plus(1)), 'closed after the write');
  });

  await check('gate: a write during a pass is not closed over by that pass\'s answer', () => {
    __resetDueGateForTests();
    assert(shouldRunPass(t0), 'closed at start');
    invalidateDueGate(); // the write lands while the pass is reading
    setNextDue(plus(3 * 60 * MIN), t0);
    assert(shouldRunPass(plus(MIN)), 'the next tick skips the write');
    // That next pass has read the write, so its answer counts.
    setNextDue(plus(3 * 60 * MIN), plus(MIN));
    assert(!shouldRunPass(plus(2 * MIN)), 'open after a clean pass');
  });

  await check('gate: a write before a pass starts is read by it, so the pass\'s answer counts', () => {
    __resetDueGateForTests();
    setNextDue(plus(30 * MIN), t0);
    invalidateDueGate();
    assert(shouldRunPass(plus(MIN)), 'closed after the write');
    setNextDue(plus(30 * MIN), plus(MIN));
    assert(!shouldRunPass(plus(2 * MIN)), 'open after the pass that read the write');
    assert(shouldRunPass(plus(30 * MIN)), 'closed at the due time');
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
