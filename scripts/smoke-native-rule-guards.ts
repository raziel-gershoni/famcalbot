// Smoke test for 3b's read guards and the reminder pass's recipient race (3b spec §3.1,
// §6, §7 "The read guards" and "The pass race"):
//   - one FamCal series with a rule that can't be read is skipped and logged (its id, never
//     its title) by the range read, the digest's open lines, the open list, the item lookup
//     and the ping's title, and everything else reads whole;
//   - repeatInfo's and wouldRefuseFixedDays' catches log;
//   - a recipient change landing between the pass's read and its claim sends nothing to the
//     old person, and the next tick pings the new one; any other edit there is undone too;
//   - the stale-ping copy a home edit uses: "changed" and "now for <name>", in the reader's
//     language.
//
// The store, the readers, the pass, the claim and the ping copy run for real over an
// in-memory Prisma (with the claim's ON CONFLICT upsert). Faked at the boundaries: Prisma,
// Redis, error capture, Telegram, the timezone lookup, moderation, analytics and the
// reminders switch. No network, no database.
//
// Run with the fake env, under both clocks:
//   TZ=UTC npx tsx scripts/smoke-native-rule-guards.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-rule-guards.ts

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { fromZonedTime } from 'date-fns-tz';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Where = Record<string, unknown>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

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

const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Fake Prisma: where (with the relation filters the readers use), select, include,
// the compound keys, transactions and the claim's raw upsert ----

const db: Record<string, Row[]> = {};
const MODELS = ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'nativeReminderState'];
const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, exdates: [], reminderMinutes: null, ownAlerts: false, alertMinutes: [], isDeleted: false, kind: 'EVENT', forUserId: null, armedAt: null }),
  nativeEventInstance: () => ({ title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null }),
  nativeReminderState: () => ({ doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null }),
};
let nextId = 0;
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : v);
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime());

const toOne: Record<string, Record<string, (row: Row) => Row | undefined>> = {
  nativeEvent: {
    calendar: (row) => db.nativeCalendar.find((c) => c.id === row.calendarId),
    creator: (row) => db.user.find((u) => u.id === row.creatorUserId),
  },
};
const toMany: Record<string, Record<string, (row: Row) => Row[]>> = {
  nativeEvent: {
    instances: (row) => db.nativeEventInstance.filter((i) => i.seriesEventId === row.id),
    states: (row) => db.nativeReminderState.filter((s) => s.seriesEventId === row.id),
  },
};

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
  return Object.entries(cond as Where).every(([op, arg]) => {
    switch (op) {
      case 'in': return (arg as unknown[]).some((a) => same(value, a));
      case 'not': return !same(value, arg);
      case 'lt': return value != null && (ms(value) as number) < (ms(arg) as number);
      case 'lte': return value != null && (ms(value) as number) <= (ms(arg) as number);
      case 'gt': return value != null && (ms(value) as number) > (ms(arg) as number);
      case 'gte': return value != null && (ms(value) as number) >= (ms(arg) as number);
      default: throw new Error(`stand-in Prisma does not know '${op}'`);
    }
  });
}

function matches(model: string, row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'OR') return (cond as Where[]).some((w) => matches(model, row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(model, row, w));
    if (key === 'seriesEventId_originalStartsAt') return matches(model, row, cond as Where);
    const one = toOne[model]?.[key];
    if (one) {
      const related = one(row);
      return !!related && matches('related', related, cond as Where);
    }
    const many = toMany[model]?.[key];
    if (many) {
      const { some } = cond as { some: Where };
      return many(row).some((r) => matches('related', r, some));
    }
    return fieldMatches(row[key], cond);
  });
}

function shape(model: string, row: Row | undefined, args: { select?: Row; include?: Row }): Row | null {
  if (!row) return null;
  const out: Row = args.select
    ? Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k] && !toOne[model]?.[k] && !toMany[model]?.[k]).map((k) => [k, row[k]]))
    : { ...row };
  const rel = { ...(args.include ?? {}), ...Object.fromEntries(Object.entries(args.select ?? {}).filter(([k]) => toOne[model]?.[k] || toMany[model]?.[k])) };
  for (const [k, spec] of Object.entries(rel)) {
    if (!spec) continue;
    const sub = spec === true ? {} : (spec as Row);
    if (toOne[model]?.[k]) out[k] = shape('related', toOne[model][k](row), sub);
    else if (toMany[model]?.[k]) out[k] = toMany[model][k](row).map((r) => shape('related', r, sub));
  }
  return out;
}

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const push = value !== null && typeof value === 'object' && Object.hasOwn(value, 'push');
    row[key] = push ? [...(row[key] as unknown[]), (value as { push: unknown }).push] : value;
  }
  row.updatedAt = new Date();
}

function checkUnique(model: string) {
  if (model !== 'nativeEventInstance' && model !== 'nativeReminderState') return;
  const seen = new Set<string>();
  for (const r of db[model]) {
    const k = `${r.seriesEventId}|${ms(r.originalStartsAt)}`;
    if (seen.has(k)) throw Object.assign(new Error(`stand-in ${model}: unique key violated`), { code: 'P2002' });
    seen.add(k);
  }
}

/** Run before a model's next findMany (once): an edit landing mid-read. */
const beforeFindMany: Record<string, (() => Promise<void>) | undefined> = {};
/** Thrown by the next nativeEvent.findUnique: a database blip. */
let failNextFindUnique: Error | null = null;

function model(name: string) {
  const find = (where?: Where) => db[name].filter((r) => matches(name, r, where));
  type Args = { where?: Where; select?: Row; include?: Row; data?: Row; create?: Row; update?: Row; orderBy?: unknown };
  const insert = (data: Row) => {
    const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date() };
    apply(row, data);
    db[name].push(row);
    checkUnique(name);
    return { ...row };
  };
  return {
    findUnique: async (a: Args) => {
      if (name === 'nativeEvent' && failNextFindUnique) {
        const e = failNextFindUnique;
        failNextFindUnique = null;
        throw e;
      }
      return shape(name, find(a.where)[0], a);
    },
    findFirst: async (a: Args) => shape(name, find(a.where)[0], a),
    findMany: async (a: Args = {}) => {
      const hook = beforeFindMany[name];
      if (hook) {
        beforeFindMany[name] = undefined;
        await hook();
      }
      return find(a.where).map((r) => shape(name, r, a));
    },
    create: async (a: Args) => insert(a.data!),
    createMany: async (a: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of a.data) {
        if (find({ seriesEventId: d.seriesEventId, originalStartsAt: d.originalStartsAt }).length) continue;
        insert(d);
        count++;
      }
      return { count };
    },
    update: async (a: Args) => {
      const row = find(a.where)[0];
      if (!row) throw new Error(`stand-in ${name}.update: no row`);
      apply(row, a.data!);
      checkUnique(name);
      return { ...row };
    },
    upsert: async (a: Args) => {
      const row = find(a.where)[0];
      if (!row) return insert(a.create!);
      apply(row, a.update!);
      checkUnique(name);
      return { ...row };
    },
    updateMany: async (a: Args) => {
      const rows = find(a.where);
      rows.forEach((r) => apply(r, a.data!));
      checkUnique(name);
      return { count: rows.length };
    },
    deleteMany: async (a: Args = {}) => {
      const before = db[name].length;
      db[name] = db[name].filter((r) => !matches(name, r, a.where));
      return { count: before - db[name].length };
    },
  };
}

/** Run inside the next claim, before it writes: an edit landing between the pass's read and its claim. */
let duringClaim: (() => Promise<void>) | null = null;
const fakePrisma: Row = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(db);
    try {
      return await fn(fakePrisma);
    } catch (err) {
      Object.assign(db, snapshot);
      throw err;
    }
  },
  // The claim: INSERT … ON CONFLICT DO UPDATE … WHERE not done and not yet pinged for this due … RETURNING.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    assert(/INSERT INTO "NativeReminderState"[\s\S]*ON CONFLICT/.test(strings.join('$')), 'not the claim');
    if (duringClaim) {
      const hook = duringClaim;
      duringClaim = null;
      await hook();
    }
    const [id, seriesEventId, occurrence, at] = values as string[];
    const due = new Date(values[values.length - 1] as string).getTime();
    const originalStartsAt = new Date(occurrence);
    const lastPingedAt = new Date(at);
    const row = db.nativeReminderState.find((s) => s.seriesEventId === seriesEventId && ms(s.originalStartsAt) === originalStartsAt.getTime());
    if (!row) {
      db.nativeReminderState.push({ ...DEFAULTS.nativeReminderState(), id, seriesEventId, originalStartsAt, lastPingedAt, pingAttempts: 1, createdAt: new Date(), updatedAt: new Date() });
      return [{ id, lastPingedAt, pingAttempts: 1 }];
    }
    if (row.doneAt || (row.lastPingedAt && ms(row.lastPingedAt) as number >= due)) return [];
    Object.assign(row, { lastPingedAt, pingAttempts: row.pingAttempts + 1 });
    return [{ id: row.id, lastPingedAt, pingAttempts: row.pingAttempts }];
  },
};
for (const name of MODELS) {
  db[name] = [];
  fakePrisma[name] = model(name);
}

// ---- Boundaries ----

const captured: { ctx: string; extra: Row | undefined; message: string }[] = [];
type Sent = { chatId: string; text: string };
const sent: Sent[] = [];
const edits: { chatId: string; messageId: number; text: string }[] = [];
const consoleLines: string[] = [];

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map((n) => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default s;',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});
function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

const fakeBot = {
  sendMessage: async (chatId: unknown, text: string) => {
    sent.push({ chatId: String(chatId), text });
    return { message_id: 900 + sent.length };
  },
  editMessageText: async (text: string, options: Row) => {
    edits.push({ chatId: String(options.chat_id), messageId: options.message_id, text });
    return true;
  },
};

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => null) }) });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string, extra?: Row) => { captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) }); },
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  });
  const telegram = { getBot: () => fakeBot, initBot: () => fakeBot };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  stub('src/lib/timezone.ts', { resolveUserTimezone: async () => IL });
  stub('src/lib/user-moderation.ts', { isIdentifierBlocked: async () => false });
  stub('src/lib/user-reachability.ts', { markUserUnreachable: async () => undefined });
  stub('src/services/analytics-service.ts', { trackActivityAsync: () => undefined, trackActivity: async () => undefined });
  stub('src/services/native-reminders/support.ts', {
    isNativeRemindersEnabled: async () => true,
    getReminderSupport: async () => ({ supported: true }),
  });
  stub('src/services/user-service.ts', {
    getUserByTelegramId: async (telegramId: bigint) => db.user.find((u) => u.telegramId === BigInt(telegramId)) ?? null,
  });
}

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const TAL = 9;
const NOA = 42;
const SECRET = 'Zebra Private Title';
const BAD_RULE = 'FREQ=WEEKLY;BYDAY=Tuesday';
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);
const OLD = new Date('2026-10-01T06:00:00Z');

function user(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', calendarSource: 'NATIVE', pairingId: null,
    telegramId: null, suspendedAt: null, unreachableSince: null, googleRefreshToken: '', messagingPlatform: 'telegram', ...o,
  };
}

function seed() {
  nextId = 0;
  for (const list of [captured, sent, edits, consoleLines] as unknown[][]) list.length = 0;
  duringClaim = null;
  failNextFindUnique = null;
  for (const k of Object.keys(beforeFindMany)) beforeFindMany[k] = undefined;
  db.user = [
    user({ id: TAL, name: 'Tal', telegramId: BigInt(111), pairingId: 'pair' }),
    user({ id: NOA, name: 'Noa', telegramId: BigInt(222), pairingId: 'pair', language: 'he' }),
  ];
  db.pairing = [{ id: 'pair', status: 'ACTIVE', inviterUserId: TAL, inviteeUserId: NOA }];
  db.nativeCalendar = [
    { ...DEFAULTS.nativeCalendar(), id: 'cal-tal', ownerUserId: TAL, name: 'Tal', labels: ['primary'], createdAt: OLD },
  ];
  db.nativeEvent = [];
  db.nativeEventInstance = [];
  db.nativeReminderState = [];
}

function series(id: string, o: Row): Row {
  const row: Row = { ...DEFAULTS.nativeEvent(), id, calendarId: 'cal-tal', creatorUserId: TAL, timeZone: IL, createdAt: OLD, updatedAt: OLD, ...o };
  if (row.kind === 'REMINDER') row.armedAt ??= OLD;
  row.endsAt ??= row.kind === 'REMINDER' ? row.startsAt : new Date(row.startsAt.getTime() + 3_600_000);
  db.nativeEvent.push(row);
  return row;
}

/** The reader-facing state: a good event, a good weekly reminder (open since yesterday, none on the 21st), and one of each with a rule that can't be read. */
function seedMixed() {
  series('good-event', { title: 'Piano', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY' });
  series('bad-event', { title: SECRET, startsAt: at('2026-10-20 12:00'), rrule: BAD_RULE });
  series('good-reminder', { kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-13 08:00'), rrule: 'FREQ=WEEKLY' });
  series('bad-reminder', { kind: 'REMINDER', title: SECRET, startsAt: at('2026-10-19 09:00'), rrule: BAD_RULE });
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const tal = () => db.user.find((u) => u.id === TAL)!;
const loggedFor = (id: string) => captured.filter((c) => c.extra?.series_id === id);
const noSecret = () => !show(captured).includes(SECRET) && !consoleLines.some((l) => l.includes(SECRET));

async function main() {
  installStubs();
  seed();
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    (console as Row)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
  }

  const store = await load('src/services/native-calendar/event-store.ts');
  const openReminders = await load('src/services/native-reminders/open-reminders.ts');
  const itemInfo = await load('src/services/calendar-write/item-info.ts');
  const actions = await load('src/services/native-reminders/actions.ts');
  const provider = await load('src/services/calendar-provider/native-provider.ts');
  const { runNativeReminderPass } = await load('src/services/native-reminders/pass.ts');
  const { stripMovedPings } = await load('src/services/native-reminders/moved-pings.ts');

  // ================= read guards =================

  await check('range read: the series with a rule that can\'t be read is skipped and logged by id; the rest is whole', async () => {
    seed();
    seedMixed();
    const rows = await store.fetchEventsInCalendars(['cal-tal'], { from: at('2026-10-20 00:00'), to: at('2026-10-22 00:00') });
    assertSame([...new Set(rows.map((r: Row) => r.series.id))].sort(), ['good-event', 'good-reminder'], 'what reads');
    assertSame([loggedFor('bad-event').length, loggedFor('bad-reminder').length], [1, 1], 'each logged once, by id');
    assert(noSecret(), 'a title reached a log');
    const forNoa = await store.fetchRemindersForUserInRange(NOA, TAL, { from: at('2026-10-20 00:00'), to: at('2026-10-22 00:00') });
    assertSame(forNoa, [], 'the reminders for the partner read too (none here)');
  });

  await check('digest open lines and the open list: a bad series is skipped and logged; the good open reminder stays', async () => {
    seed();
    seedMixed();
    const ctx = { viewerId: TAL, partner: null };
    const cutoff = at('2026-10-21 00:00');
    const items = await openReminders.fetchOpenReminderItems(tal(), ctx, cutoff, '2026-10-21', IL, Infinity);
    assertSame(items.items.map((i: Row) => i.series.id), ['good-reminder'], 'the open list');
    assert(loggedFor('bad-reminder').length >= 1 && noSecret(), `logged: ${show(captured)}`);
    captured.length = 0;
    const digest = await openReminders.addDigestReminders(tal(), [], '2026-10-21', IL, at('2026-10-21 07:00'));
    assertSame(digest.events.map((e: Row) => e.summary), ['Pills'], 'the digest keeps its open line');
    assert(!captured.some((c) => c.ctx === 'native-reminders-open'), 'the digest lost its open lines');
  });

  await check('the item lookup answers not_found for a bad series, with a log; a good one loads', async () => {
    seed();
    seedMixed();
    const bad = await itemInfo.loadItem(tal(), { seriesCuid: 'bad-event', slot: at('2026-10-20 12:00') });
    const good = await itemInfo.loadItem(tal(), { seriesCuid: 'good-event', slot: at('2026-10-27 16:00') });
    assertSame([bad.status, good.status], ['not_found', 'ok'], 'statuses');
    assert(loggedFor('bad-event').length === 1 && noSecret(), `logged: ${show(captured)}`);
  });

  await check('a ping\'s buttons on a bad series answer "changed", with a log', async () => {
    seed();
    seedMixed();
    const live = await actions.loadLiveOccurrence({ seriesEventId: 'bad-reminder', originalStartsAt: at('2026-10-20 09:00') });
    assert(live === null, 'it read as live');
    const done = await actions.applyReminderAction(tal(), { seriesEventId: 'bad-reminder', originalStartsAt: at('2026-10-20 09:00') }, 'done');
    assertSame(done, { status: 'changed' }, 'the action');
    assert(loggedFor('bad-reminder').length >= 1 && noSecret(), `logged: ${show(captured)}`);
    const good = await actions.loadLiveOccurrence({ seriesEventId: 'good-reminder', originalStartsAt: at('2026-10-20 08:00') });
    assertSame(good?.title, 'Pills', 'a good one');
  });

  await check('repeatInfo and wouldRefuseFixedDays log what they catch', async () => {
    seed();
    assertSame(itemInfo.repeatInfo('X-HEBREW=1'), null, 'repeatInfo');
    assert(captured.some((c) => c.ctx === 'native-rule-repeat-info'), `repeatInfo did not log: ${show(captured)}`);
    series('weekly', { title: 'x', startsAt: at('2026-10-20 16:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    failNextFindUnique = new Error('connection reset');
    const refused = await provider.wouldRefuseFixedDays(tal(), 'native:cal-tal', `weekly#${at('2026-10-27 16:00').toISOString()}`, { scope: 'all', startTime: at('2026-10-29 16:00') });
    assert(refused === false, 'it blocked');
    assert(captured.some((c) => c.ctx === 'native-fixed-days-check' && c.extra?.user_id === TAL), `wouldRefuseFixedDays did not log: ${show(captured)}`);
  });

  // ================= the pass race =================

  /** A daily 08:00 reminder of Tal's, and the pass at 08:00:30 on the 21st. */
  const NOW = new Date(at('2026-10-21 08:00').getTime() + 30_000);
  const KEY = at('2026-10-21 08:00');

  await check('the pass race: a recipient change between the pass\'s read and its claim sends nothing to the old person; the next tick pings the new one', async () => {
    seed();
    series('daily', { kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-20 08:00'), rrule: 'FREQ=DAILY' });
    duringClaim = async () => {
      await store.updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: KEY, scope: 'all', actingUserId: TAL, forUserId: NOA });
    };
    const first = await runNativeReminderPass(NOW);
    assertSame(sent.map((s) => s.chatId), [], 'nothing went to Tal');
    assertSame(db.nativeReminderState.filter((s) => ms(s.originalStartsAt) === KEY.getTime()).length, 0, 'the claim was undone');
    assert(first.skipped >= 1 && first.nextDue !== null && first.nextDue.getTime() <= NOW.getTime() + 60_000, `the pass looks again soon: ${show(first)}`);
    const next = await runNativeReminderPass(new Date(NOW.getTime() + 60_000));
    assertSame([sent.map((s) => s.chatId), next.sent], [['222'], 1], 'the next tick pings Noa');
  });

  await check('the pass race: any edit there (a new title) undoes a claim on an existing row by putting its last ping back; nothing is sent until the next tick', async () => {
    seed();
    series('daily', { kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-20 08:00'), rrule: 'FREQ=DAILY' });
    const pinged = at('2026-10-21 07:30');
    db.nativeReminderState.push({ ...DEFAULTS.nativeReminderState(), id: 'state-1', seriesEventId: 'daily', originalStartsAt: KEY, lastPingedAt: pinged, snoozedUntil: at('2026-10-21 08:00'), pingAttempts: 1, createdAt: OLD, updatedAt: OLD });
    duringClaim = async () => {
      await store.updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: KEY, scope: 'all', actingUserId: TAL, title: 'Vitamins' });
    };
    await runNativeReminderPass(NOW);
    const row = db.nativeReminderState.find((s) => s.id === 'state-1')!;
    assertSame([sent.length, ms(row.lastPingedAt)], [0, pinged.getTime()], 'no send, the last ping put back');
    await runNativeReminderPass(new Date(NOW.getTime() + 60_000));
    assert(sent.length === 1 && sent[0].chatId === '111' && sent[0].text.includes('Vitamins'), `the next tick: ${show(sent)}`);
  });

  await check('the pass with no edit in between pings as before', async () => {
    seed();
    series('daily', { kind: 'REMINDER', title: 'Pills', startsAt: at('2026-10-20 08:00'), rrule: 'FREQ=DAILY' });
    const r = await runNativeReminderPass(NOW);
    assertSame([r.sent, sent.map((s) => s.chatId)], [1, ['111']], 'sent to Tal');
  });

  // ================= the stale-ping copy =================

  await check('stale pings: "changed" and "now for <name>" in the reader\'s language, buttons gone; "moved" as before', async () => {
    seed();
    const original = { summary: SECRET, start: at('2026-10-21 08:00').toISOString(), end: at('2026-10-21 08:00').toISOString() };
    await stripMovedPings(
      [{ chatId: BigInt(111), messageId: 1 }],
      original,
      { title: 'Pills <b>', startTime: at('2026-10-22 09:00'), endTime: at('2026-10-22 09:00'), allDay: false },
      tal(),
      { changed: [{ chatId: BigInt(222), messageId: 2 }], reassigned: { pings: [{ chatId: BigInt(111), messageId: 3 }], name: 'Noa' } }
    );
    const byId = Object.fromEntries(edits.map((e) => [e.messageId, e.text]));
    assertSame(byId[2], 'התזכורת הזו השתנתה או שכבר לא קיימת.', 'changed, in Noa\'s Hebrew');
    assertSame(byId[3], '⏰ Pills &lt;b&gt; · now for Noa', 'now for, in Tal\'s English, escaped');
    assert(/^⏰ Pills &lt;b&gt; · moved to /.test(byId[1] ?? ''), `moved: ${byId[1]}`);
  });

  Object.assign(console, quiet);
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
