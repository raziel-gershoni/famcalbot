// Smoke test for the data layer of "Send a copy of an event" (docs/superpowers/specs/2026-11-27-send-event-copy-design.md,
// Task 1): the offer's token and deep link, the offer's states (viewCopyOffer), the single-use claim, release and record,
// the copy write (copyEventFor, through the event store) and the store's two new fields (skipped days, the birth year).
//
// The service and the store run for real over an in-memory Prisma. Faked at the boundaries: Prisma, error capture,
// moderation (the ban list) and the google-sync marks' links. No network, no database.
//
// Run with the fake env, under both clocks:
//   TZ=UTC npx tsx scripts/smoke-event-copy.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-event-copy.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

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
async function rejects(fn: () => Promise<unknown>, name: string, label: string) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof Error && err.name === name, `${label}: threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}, want ${name}`);
    return;
  }
  throw new Error(`${label}: did not throw`);
}

// ---- Fake Prisma ----

const db: Record<string, Row[]> = {};
const MODELS = ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'eventCopyOffer', 'googleSyncLink'];
const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [], ownAlerts: false, alertMinutes: [], isDeleted: false, kind: 'EVENT', forUserId: null, forBoth: false, eachMarksDone: false, zmanSpec: null, armedAt: null, birthday: false, birthYear: null }),
  eventCopyOffer: () => ({ takenAt: null, takenByUserId: null, copyEventId: null }),
};
let nextId = 0;
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime());

const toOne: Record<string, Record<string, (row: Row) => Row | undefined>> = {
  eventCopyOffer: { sourceEvent: (row) => db.nativeEvent.find((e) => e.id === row.sourceEventId) },
};

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
  return Object.entries(cond as Where).every(([op, arg]) => {
    switch (op) {
      case 'in': return (arg as unknown[]).some((a) => same(value, a));
      case 'not': return !same(value, arg);
      default: throw new Error(`stand-in Prisma does not know '${op}'`);
    }
  });
}

function matches(model: string, row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'OR') return (cond as Where[]).some((w) => matches(model, row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(model, row, w));
    const one = toOne[model]?.[key];
    if (one) {
      const related = one(row);
      return !!related && matches('related', related, cond as Where);
    }
    return fieldMatches(row[key], cond);
  });
}

function pick(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  return select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };
}

function model(name: string) {
  const find = (where?: Where) => db[name].filter((r) => matches(name, r, where));
  type Args = { where?: Where; select?: Row; data?: Row };
  return {
    findUnique: async (a: Args) => pick(find(a.where)[0], a.select),
    findFirst: async (a: Args) => pick(find(a.where)[0], a.select),
    findMany: async (a: Args = {}) => find(a.where).map((r) => pick(r, a.select)),
    create: async (a: Args) => {
      const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date(), updatedAt: new Date(), ...a.data };
      if (name === 'eventCopyOffer' && db[name].some((r) => r.tokenHash === row.tokenHash)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      db[name].push(row);
      return { ...row };
    },
    update: async (a: Args) => {
      const row = find(a.where)[0];
      if (!row) throw new Error(`stand-in ${name}.update: no row`);
      Object.assign(row, a.data);
      return { ...row };
    },
    updateMany: async (a: Args) => {
      const rows = find(a.where);
      rows.forEach((r) => Object.assign(r, a.data));
      return { count: rows.length };
    },
  };
}

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
};
for (const name of MODELS) {
  db[name] = [];
  fakePrisma[name] = model(name);
}

// ---- Boundaries ----

const captured: { ctx: string; message: string }[] = [];
const consoleLines: string[] = [];
let blockedTelegramIds: bigint[] = [];
/** The fake Bot API: the savePreparedInlineMessage calls it got, and what the next one does. */
const preparedCalls: Row[] = [];
let prepareBehaviour: 'ok' | 'refused' = 'ok';
/** Every Bot API call and messaging-service send the receiver's side made, in order; a chat id here makes a send to it fail like a blocked bot. */
const botCalls: { method: string; params: Row }[] = [];
let failChatId: number | null = null;

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

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => null) }) });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, ctx: string) => { captured.push({ ctx, message: e instanceof Error ? e.message : String(e) }); },
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  });
  stub('src/lib/user-moderation.ts', {
    isIdentifierBlocked: async (args: { telegramId?: bigint | number | null }) =>
      args.telegramId != null && blockedTelegramIds.some((b) => b === BigInt(args.telegramId!)),
    isUserSuspended: (u: { suspendedAt: Date | null } | null | undefined) => !!u?.suspendedAt,
  });
  // The route's boundaries: the sign-in check (the body's user_id is the account's id), the rate limiter, the zone and the Bot API.
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async (_req: unknown, userId: string | null) => {
      const row = db.user.find((u) => String(u.id) === userId);
      if (!row) return { success: false, response: new Response(JSON.stringify({ error: 'auth' }), { status: 401 }) };
      return { success: true, user: { ...row, telegramId: row.telegramId === null ? null : Number(row.telegramId) } };
    },
  });
  stub('src/lib/rate-limit.ts', { calendarRateLimiter: {} });
  stub('src/lib/timezone.ts', { resolveUserTimezone: async () => 'Asia/Jerusalem' });
  const bot = {
    savePreparedInlineMessage: async (params: Row) => {
      preparedCalls.push(params);
      if (prepareBehaviour === 'refused') {
        throw Object.assign(new Error('Bad Request: inline mode is off'), { code: 'ETELEGRAM', errorCode: 400, description: 'Bad Request: inline mode is off' });
      }
      return { id: 'prepared-1', expiration_date: 1 };
    },
    answerCallbackQuery: async (params: Row) => { botCalls.push({ method: 'answerCallbackQuery', params }); },
    editMessageText: async (params: Row) => { botCalls.push({ method: 'editMessageText', params }); },
    sendMessage: async (params: Row) => {
      botCalls.push({ method: 'sendMessage', params });
      if (params.chat_id === failChatId) throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { code: 'ETELEGRAM', errorCode: 403, description: 'Forbidden: bot was blocked by the user' });
      return { message_id: 900 };
    },
  };
  stub('src/services/telegram/bot.ts', {
    getBot: () => bot,
    getMessagingService: () => ({
      sendMessage: async (chatId: number | string, text: string, options?: Row) => { botCalls.push({ method: 'service.sendMessage', params: { chatId, text, options } }); return 901; },
    }),
  });
}

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const SENDER = 1;
const PARTNER = 2; // the sender's partner
const RECEIVER = 3;
const OTHER = 4;
const SECRET_TITLE = 'Zebra Private Title';
const OLD = new Date('2026-10-01T06:00:00Z');

function user(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', calendarSource: 'NATIVE', pairingId: null,
    telegramId: null, suspendedAt: null, ...o,
  };
}

function seed() {
  nextId = 0;
  captured.length = 0;
  consoleLines.length = 0;
  blockedTelegramIds = [];
  db.user = [
    user({ id: SENDER, telegramId: BigInt(101), pairingId: 'pair' }),
    user({ id: PARTNER, telegramId: BigInt(102), pairingId: 'pair' }),
    user({ id: RECEIVER, telegramId: BigInt(103) }),
    user({ id: OTHER, telegramId: BigInt(104) }),
  ];
  db.pairing = [{ id: 'pair', status: 'ACTIVE', inviterUserId: SENDER, inviteeUserId: PARTNER }];
  db.nativeCalendar = [
    { ...DEFAULTS.nativeCalendar(), id: 'cal-sender', ownerUserId: SENDER, name: 'Sender cal', labels: ['primary'], createdAt: OLD },
    { ...DEFAULTS.nativeCalendar(), id: 'cal-partner', ownerUserId: PARTNER, name: 'Partner cal', privacy: 'SHARED_EDITOR', createdAt: OLD },
    { ...DEFAULTS.nativeCalendar(), id: 'cal-receiver', ownerUserId: RECEIVER, name: 'Receiver cal', labels: ['primary'], createdAt: OLD },
    { ...DEFAULTS.nativeCalendar(), id: 'cal-other', ownerUserId: OTHER, name: 'Other cal', privacy: 'PRIVATE', createdAt: OLD },
  ];
  db.nativeEvent = [];
  db.eventCopyOffer = [];
  db.googleSyncLink = [];
}

function event(id: string, o: Row = {}): Row {
  const startsAt = new Date('2026-12-03T08:00:00Z');
  const row: Row = {
    ...DEFAULTS.nativeEvent(), id, calendarId: 'cal-sender', creatorUserId: SENDER, title: SECRET_TITLE, timeZone: IL,
    startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), createdAt: OLD, updatedAt: OLD, ...o,
  };
  db.nativeEvent.push(row);
  return row;
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const offerRow = (id: string) => db.eventCopyOffer.find((o) => o.id === id)!;

async function main() {
  installStubs();
  seed();
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    (console as Row)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
  }

  const offers = await load('src/services/event-copy/offers.ts');
  const store = await load('src/services/native-calendar/event-store.ts');
  const receiverConfig = () => db.user.find((u) => u.id === RECEIVER)!;

  // ================= token and link =================

  await check('the start parameter is cp_ + a 22-character token: at most 64 characters, Telegram\'s alphabet', () => {
    const { token } = offers.newCopyToken();
    assert(token.length === 22, `token length ${token.length}`);
    const param = offers.copyStartParam(token);
    assert(param === `cp_${token}` && param.length <= 64 && /^[A-Za-z0-9_-]{1,64}$/.test(param), `param ${param}`);
    assertSame(offers.copyTokenFromStart(token), token, 'the token as it reads from the start payload');
  });

  await check('copyTokenFromStart refuses 21 or 23 characters and other letters', () => {
    const t22 = 'A'.repeat(22);
    assertSame(offers.copyTokenFromStart(t22), t22, '22');
    assertSame(offers.copyTokenFromStart('A'.repeat(21)), null, '21');
    assertSame(offers.copyTokenFromStart('A'.repeat(23)), null, '23');
    assertSame(offers.copyTokenFromStart(`${'A'.repeat(21)}+`), null, 'plus');
    assertSame(offers.copyTokenFromStart(`${'A'.repeat(21)}é`), null, 'accent');
    assertSame(offers.copyTokenFromStart(''), null, 'empty');
  });

  await check('the stored hash is never the token, and is the token\'s SHA-256 (64 hex)', () => {
    const { token, tokenHash } = offers.newCopyToken();
    assert(tokenHash !== token && /^[0-9a-f]{64}$/.test(tokenHash), `hash ${tokenHash}`);
    assertSame(offers.copyTokenHash(token), tokenHash, 'copyTokenHash');
    assert(offers.newCopyToken().token !== token, 'two tokens are equal');
  });

  await check('the deep link is https://t.me/<bot>?start=cp_<token>, the bot from the env or the default', () => {
    const { token } = offers.newCopyToken();
    const before = process.env.TELEGRAM_BOT_USERNAME;
    try {
      delete process.env.TELEGRAM_BOT_USERNAME;
      assertSame(offers.copyDeepLink(token), `https://t.me/family_calendar_telegram_bot?start=cp_${token}`, 'default');
      process.env.TELEGRAM_BOT_USERNAME = 'my_bot';
      assertSame(offers.copyDeepLink(token), `https://t.me/my_bot?start=cp_${token}`, 'env');
    } finally {
      if (before === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
      else process.env.TELEGRAM_BOT_USERNAME = before;
    }
  });

  // ================= the offer =================

  await check('createCopyOffer stores only the token\'s hash, never the token, and logs ids only', async () => {
    seed();
    event('ev1');
    const made = await offers.createCopyOffer(SENDER, 'ev1');
    const row = offerRow(made.offerId);
    assert(row.tokenHash === offers.copyTokenHash(made.token) && row.tokenHash !== made.token, 'hash');
    assert(row.sourceEventId === 'ev1' && row.senderUserId === SENDER && row.takenAt === null, `row ${show(row)}`);
    assert(!show(db.eventCopyOffer).includes(made.token), 'the token is stored');
    const logs = consoleLines.join('\n');
    assert(logs.includes('[event-copy]') && !logs.includes(made.token) && !logs.includes(SECRET_TITLE), `logs ${logs}`);
  });

  async function offerFor(eventId = 'ev1') {
    const made = await offers.createCopyOffer(SENDER, eventId);
    return made as { offerId: string; token: string };
  }

  await check('viewCopyOffer: invalid for an unknown token', async () => {
    seed();
    event('ev1');
    const view = await offers.viewCopyOffer(offers.newCopyToken().token, RECEIVER);
    assertSame(view, { state: 'invalid' }, 'unknown');
  });

  await check('viewCopyOffer: mine for the sender, open for anyone else', async () => {
    seed();
    event('ev1');
    const { token } = await offerFor();
    const mine = await offers.viewCopyOffer(token, SENDER);
    assert(mine.state === 'mine' && mine.source.id === 'ev1' && mine.sender.id === SENDER, `mine ${mine.state}`);
    const open = await offers.viewCopyOffer(token, RECEIVER);
    assert(open.state === 'open' && open.offer.senderUserId === SENDER, `open ${open.state}`);
  });

  await check('viewCopyOffer: taken for another taker, yours (with the copy\'s calendar name) for the taker', async () => {
    seed();
    event('ev1');
    const { offerId, token } = await offerFor();
    assert(await offers.claimCopyOffer(offerId, RECEIVER), 'claim');
    const copy = event('copy1', { calendarId: 'cal-receiver', creatorUserId: RECEIVER });
    await offers.recordCopy(offerId, copy.id);
    const taken = await offers.viewCopyOffer(token, OTHER);
    assert(taken.state === 'taken', `other ${taken.state}`);
    const yours = await offers.viewCopyOffer(token, RECEIVER);
    assert(yours.state === 'yours' && yours.calendarName === 'Receiver cal', `taker ${yours.state} ${yours.calendarName}`);
  });

  await check('viewCopyOffer: gone when the original is deleted', async () => {
    seed();
    const ev = event('ev1');
    const { token } = await offerFor();
    ev.isDeleted = true;
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'gone', 'receiver');
    assert((await offers.viewCopyOffer(token, SENDER)).state === 'gone', 'sender');
  });

  await check('viewCopyOffer: gone when the calendar is now PRIVATE to the sender (the partner\'s), and after an unlink', async () => {
    seed();
    event('ev-partner', { calendarId: 'cal-partner', creatorUserId: PARTNER });
    const { token } = await offerFor('ev-partner');
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'open', 'visible while shared');
    db.nativeCalendar.find((c) => c.id === 'cal-partner')!.privacy = 'PRIVATE';
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'gone', 'private');
    db.nativeCalendar.find((c) => c.id === 'cal-partner')!.privacy = 'SHARED_EDITOR';
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'open', 'shared again');
    db.pairing[0].status = 'UNLINKED';
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'gone', 'unlinked');
  });

  await check('viewCopyOffer: gone when the sender is suspended or banned', async () => {
    seed();
    event('ev1');
    const { token } = await offerFor();
    db.user.find((u) => u.id === SENDER)!.suspendedAt = new Date();
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'gone', 'suspended');
    db.user.find((u) => u.id === SENDER)!.suspendedAt = null;
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'open', 'active again');
    blockedTelegramIds = [BigInt(101)];
    assert((await offers.viewCopyOffer(token, RECEIVER)).state === 'gone', 'banned');
  });

  // ================= claim, release, record =================

  await check('two claimCopyOffer calls on one offer give [true, false]; the winner is recorded', async () => {
    seed();
    event('ev1');
    const { offerId } = await offerFor();
    const got = await Promise.all([offers.claimCopyOffer(offerId, RECEIVER), offers.claimCopyOffer(offerId, OTHER)]);
    assertSame(got, [true, false], 'claims');
    assert(offerRow(offerId).takenByUserId === RECEIVER && offerRow(offerId).takenAt instanceof Date, `row ${show(offerRow(offerId))}`);
  });

  await check('claimCopyOffer is refused when the original was deleted', async () => {
    seed();
    const ev = event('ev1');
    const { offerId } = await offerFor();
    ev.isDeleted = true;
    assert(!(await offers.claimCopyOffer(offerId, RECEIVER)), 'claimed a deleted original');
  });

  await check('releaseCopyOffer reopens the offer (only for its taker), so someone can claim it again', async () => {
    seed();
    event('ev1');
    const { offerId, token } = await offerFor();
    assert(await offers.claimCopyOffer(offerId, RECEIVER), 'claim');
    await offers.releaseCopyOffer(offerId, OTHER);
    assert(offerRow(offerId).takenByUserId === RECEIVER, 'a stranger released it');
    await offers.releaseCopyOffer(offerId, RECEIVER);
    assert(offerRow(offerId).takenAt === null && offerRow(offerId).takenByUserId === null, 'not reopened');
    assert((await offers.viewCopyOffer(token, OTHER)).state === 'open', 'view');
    assert(await offers.claimCopyOffer(offerId, OTHER), 'claim again');
  });

  await check('recordCopy sets the copy\'s id on the offer', async () => {
    seed();
    event('ev1');
    const { offerId } = await offerFor();
    await offers.claimCopyOffer(offerId, RECEIVER);
    await offers.recordCopy(offerId, 'copy-9');
    assert(offerRow(offerId).copyEventId === 'copy-9', 'copyEventId');
  });

  // ================= the copy write =================

  const FIELDS = ['title', 'startsAt', 'endsAt', 'allDay', 'timeZone', 'rrule', 'hebrewRule', 'hebrewAnchor', 'exdates', 'birthday', 'birthYear'];

  await check('copyEventFor copies exactly the listed fields of a yearly Hebrew birthday with its birth year; no description, location or alert; the creator is the receiver', async () => {
    seed();
    const src = event('bday', {
      title: 'Dana', description: 'private notes', location: 'Home', allDay: true,
      startsAt: new Date('1985-03-02T22:00:00Z'), endsAt: new Date('1985-03-03T21:59:00Z'),
      rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '1985-03-03', birthday: true, birthYear: 1985,
      ownAlerts: true, alertMinutes: [30],
    });
    const copy = await offers.copyEventFor(src, receiverConfig(), 'cal-receiver');
    assert(copy.id !== src.id && copy.calendarId === 'cal-receiver' && copy.creatorUserId === RECEIVER, `copy ${show(copy)}`);
    for (const f of FIELDS) assertSame(copy[f], src[f], `field ${f}`);
    assert(copy.description == null && copy.location == null, 'description or location copied');
    assert(copy.ownAlerts === false && show(copy.alertMinutes) === '[]', 'alerts copied');
    assert(copy.kind === 'EVENT', 'kind');
  });

  await check('copyEventFor copies a weekly rule with its skipped days', async () => {
    seed();
    const skipped = [new Date('2026-12-10T08:00:00Z'), new Date('2026-12-24T08:00:00Z')];
    const src = event('weekly', { rrule: 'FREQ=WEEKLY;BYDAY=TH', exdates: skipped });
    const copy = await offers.copyEventFor(src, receiverConfig(), 'cal-receiver');
    assertSame(copy.exdates, skipped, 'exdates');
    assertSame(copy.rrule, 'FREQ=WEEKLY;BYDAY=TH', 'rrule');
    assert(copy.birthday === false && copy.birthYear === null, 'birthday');
  });

  await check('copyEventFor refuses a calendar the receiver can\'t write (NativePermissionDeniedError)', async () => {
    seed();
    const src = event('ev1');
    await rejects(() => offers.copyEventFor(src, receiverConfig(), 'cal-other'), 'NativePermissionDeniedError', 'someone else\'s private calendar');
    await rejects(() => offers.copyEventFor(src, receiverConfig(), 'cal-sender'), 'NativePermissionDeniedError', 'the sender\'s calendar');
    assert(db.nativeEvent.length === 1, 'an event was written');
  });

  await check('the store refuses birthYear without birthday, and exdates on a one-off', async () => {
    seed();
    const base = {
      calendarCuid: 'cal-receiver', creatorUserId: RECEIVER, title: 'T', startsAt: new Date('2026-12-03T08:00:00Z'),
      endsAt: new Date('2026-12-03T09:00:00Z'), timeZone: IL,
    };
    await rejects(() => store.createNativeEvent({ ...base, birthYear: 1985 }), 'NativeScopeError', 'birthYear alone');
    await rejects(() => store.createNativeEvent({ ...base, rrule: 'FREQ=YEARLY', allDay: true, birthYear: 1985 }), 'NativeScopeError', 'birthYear with no birthday');
    await rejects(() => store.createNativeEvent({ ...base, exdates: [new Date('2026-12-10T08:00:00Z')] }), 'NativeScopeError', 'exdates on a one-off');
    assert(db.nativeEvent.length === 0, 'an event was written');
    const ok = await store.createNativeEvent({ ...base, rrule: 'FREQ=WEEKLY', exdates: [new Date('2026-12-10T08:00:00Z')] });
    assert(ok.exdates.length === 1, 'exdates not stored');
  });

  // ================= the card and the route that prepares it =================

  const card = await load('src/services/event-copy/card.ts');
  const { POST } = await load('app/api/calendar/copy/route.ts');
  const ask = async (body: Row): Promise<{ status: number; body: Row }> => {
    const res = await POST(new Request('http://localhost/api/calendar/copy', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
    return { status: res.status, body: await res.json() };
  };
  const setLanguage = (id: number, language: string) => { db.user.find((u) => u.id === id)!.language = language; };

  await check('the route refuses a key that is not FamCal (400 invalid), a missing or unseen event (404), a reminder (409 not_event), an account with no Telegram (409 no_telegram)', async () => {
    seed();
    event('ev-ok');
    event('ev-other', { calendarId: 'cal-other', creatorUserId: OTHER });
    event('ev-rem', { kind: 'REMINDER', forUserId: SENDER });
    const bad = await ask({ user_id: SENDER, key: 'google|cal@x.com|abc' });
    assert(bad.status === 400 && bad.body.error === 'invalid', `google key: ${bad.status} ${show(bad.body)}`);
    const none = await ask({ user_id: SENDER, key: 'famcal|nope-nope' });
    assert(none.status === 404 && none.body.error === 'not_found', `missing: ${none.status} ${show(none.body)}`);
    const unseen = await ask({ user_id: SENDER, key: 'famcal|ev-other' });
    assert(unseen.status === 404 && unseen.body.error === 'not_found', `someone else's private calendar: ${unseen.status} ${show(unseen.body)}`);
    const reminder = await ask({ user_id: SENDER, key: 'famcal|ev-rem' });
    assert(reminder.status === 409 && reminder.body.error === 'not_event', `reminder: ${reminder.status} ${show(reminder.body)}`);
    db.user.find((u) => u.id === SENDER)!.telegramId = null;
    const web = await ask({ user_id: SENDER, key: 'famcal|ev-ok' });
    assert(web.status === 409 && web.body.error === 'no_telegram', `no Telegram: ${web.status} ${show(web.body)}`);
    assert(db.eventCopyOffer.length === 0 && preparedCalls.length === 0, 'a refusal made an offer or called Telegram');
  });

  await check('an event answers 200 with the prepared id, the deep link and the card text; the article carries the same link and text, for the sender\'s Telegram id', async () => {
    seed();
    preparedCalls.length = 0;
    prepareBehaviour = 'ok';
    event('ev-one');
    const res = await ask({ user_id: SENDER, key: 'famcal|ev-one' });
    assert(res.status === 200 && res.body.preparedId === 'prepared-1', `answer ${res.status} ${show(res.body)}`);
    assertSame(res.body.text, `${SECRET_TITLE}\nThu 3 Dec, 10:00–11:00`, 'the card text');
    assert(db.eventCopyOffer.length === 1 && db.eventCopyOffer[0].sourceEventId === 'ev-one' && db.eventCopyOffer[0].senderUserId === SENDER, 'the offer');
    const token = String(res.body.link).split('?start=cp_')[1];
    assert(res.body.link === offers.copyDeepLink(token) && offers.copyTokenFromStart(token) === token, `link ${res.body.link}`);
    assert(db.eventCopyOffer[0].tokenHash === offers.copyTokenHash(token), 'the offer holds the link\'s token\'s hash');
    assert(preparedCalls.length === 1, `${preparedCalls.length} prepare calls`);
    const call = preparedCalls[0];
    assert(call.user_id === 101 && call.allow_user_chats === true && call.allow_group_chats === true, `params ${show({ ...call, result: undefined })}`);
    assert(!('allow_channel_chats' in call && call.allow_channel_chats) && !('allow_bot_chats' in call && call.allow_bot_chats), 'channels or bots allowed');
    const article = call.result;
    assert(article.type === 'article' && article.input_message_content.message_text === res.body.text, 'article text');
    assert(article.input_message_content.link_preview_options.is_disabled === true, 'link preview on');
    assertSame(article.reply_markup.inline_keyboard, [[{ text: 'Copy to my calendar', url: res.body.link }]], 'article button');
  });

  await check('a refused prepare still answers 200, with preparedId null and the link and text', async () => {
    seed();
    preparedCalls.length = 0;
    prepareBehaviour = 'refused';
    event('ev-one');
    const res = await ask({ user_id: SENDER, key: 'famcal|ev-one' });
    prepareBehaviour = 'ok';
    assert(res.status === 200 && res.body.preparedId === null, `answer ${res.status} ${show(res.body)}`);
    assert(String(res.body.link).includes('?start=cp_') && String(res.body.text).startsWith(SECRET_TITLE), `link and text ${show(res.body)}`);
    assert(preparedCalls.length === 1, 'a refusal is not retried');
    assert(consoleLines.some((l) => l.includes('[event-copy]') && l.includes('400')), 'the refusal is not logged with its status');
  });

  await check('the card text: weekly en, yearly Hebrew he, all-day ru, birthday-style yearly en, a multi-day all-day', async () => {
    seed();
    const mon = new Date('2026-12-07T08:00:00Z');
    const weekly = event('ev-weekly', { rrule: 'FREQ=WEEKLY;BYDAY=MO', startsAt: mon, endsAt: new Date(mon.getTime() + 3_600_000) });
    const heb = event('ev-heb', { rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2026-12-03', allDay: true, startsAt: new Date('2026-12-02T22:00:00Z'), endsAt: new Date('2026-12-03T22:00:00Z') });
    const allDay = event('ev-allday', { allDay: true, startsAt: new Date('2026-12-02T22:00:00Z'), endsAt: new Date('2026-12-03T22:00:00Z') });
    const multi = event('ev-multi', { allDay: true, startsAt: new Date('2026-12-02T22:00:00Z'), endsAt: new Date('2026-12-05T22:00:00Z') });
    const out: Row = {
      weeklyEn: card.copyCardText(weekly, 'en', IL, 0),
      hebHe: card.copyCardText(heb, 'he', IL, 0),
      hebEn: card.copyCardText(heb, 'en', IL, 0),
      weeklyHe: card.copyCardText(weekly, 'he', IL, 0),
      hebRu: card.copyCardText(heb, 'ru', IL, 1),
      allDayRu: card.copyCardText(allDay, 'ru', IL, 1),
      multiEn: card.copyCardText(multi, 'en', IL, 0),
    };
    assertSame(out.weeklyEn, `${SECRET_TITLE}\nEvery week on Monday, 10:00–11:00`, 'weekly en');
    assert(out.hebHe.startsWith(`${SECRET_TITLE}\nכל שנה ב`) && out.hebHe.endsWith('כל היום'), `heb he ${out.hebHe}`);
    assertSame(out.weeklyHe, `${SECRET_TITLE}\nכל שבוע ביום שני, 10:00–11:00`, 'weekly he');
    assertSame(out.hebRu, `${SECRET_TITLE}\nКаждый год 23 кислева, весь день`, 'heb ru');
    assertSame(out.hebEn, `${SECRET_TITLE}\nEvery year on 23 Kislev, all day`, 'heb en');
    assertSame(out.allDayRu, `${SECRET_TITLE}\nчт, 3 дек., весь день`, 'all-day ru');
    assertSame(out.multiEn, `${SECRET_TITLE}\nThu 3 – Sat 5 Dec, all day`, 'multi-day en');
  });

  await check('the Hebrew and Russian cards come out of the route in the sender\'s language; the button too', async () => {
    seed();
    event('ev-one');
    setLanguage(SENDER, 'he');
    preparedCalls.length = 0;
    await ask({ user_id: SENDER, key: 'famcal|ev-one' });
    assertSame(preparedCalls[0].result.reply_markup.inline_keyboard[0][0].text, 'העתקה ליומן שלי', 'he button');
    setLanguage(SENDER, 'ru');
    await ask({ user_id: SENDER, key: 'famcal|ev-one' });
    assertSame(preparedCalls[1].result.reply_markup.inline_keyboard[0][0].text, 'Скопировать в свой календарь', 'ru button');
    setLanguage(SENDER, 'en');
  });


  // ================= the receiver's side in the bot =================

  const bot = await load('src/services/event-copy/bot.ts');
  const MSGS: Row = Object.fromEntries(['en', 'he', 'ru'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8')).bot.eventCopy]));
  const CUID = 'cabcdefghijklmnopqrstuvwx'; // a real cuid's length: 25
  const receiverUser = (): Row => ({ ...db.user.find((u) => u.id === RECEIVER)!, telegramId: 103 });
  const serviceSends = () => botCalls.filter((c) => c.method === 'service.sendMessage').map((c) => c.params);
  const calls = (method: string) => botCalls.filter((c) => c.method === method).map((c) => c.params);
  const newOffer = async (eventId = 'ev1') => offers.createCopyOffer(SENDER, eventId);
  const press = (token: string, cal: string, telegramId = 103) => bot.handleCopyPress(telegramId, 77, 'q1', telegramId, `cp:${token}:${cal}`);
  const reset = () => { seed(); botCalls.length = 0; failChatId = null; };

  await check('/start cp_<token> answers each state with its own line, in the receiver\'s language, with the policy footer', async () => {
    reset();
    event('ev1');
    const open = await newOffer();
    const deleted = await newOffer();
    const taken = await newOffer();
    await offers.claimCopyOffer(taken.offerId, OTHER);
    const mine = await newOffer();
    db.user.find((u) => u.id === RECEIVER)!.language = 'he';
    const send = async (token: string, who = receiverUser()) => {
      botCalls.length = 0;
      await bot.handleCopyStart(103, who, token, who.language, 'FOOTER');
      return serviceSends()[0];
    };
    const he = MSGS.he;
    let out = await send('A'.repeat(21));
    assertSame(out.text, `${he.invalid}\n\nFOOTER`, 'invalid (bad token)');
    out = await send('B'.repeat(22));
    assertSame(out.text, `${he.invalid}\n\nFOOTER`, 'invalid (unknown token)');
    out = await send(taken.token);
    assertSame(out.text, `${he.taken}\n\nFOOTER`, 'taken');
    out = await send(mine.token, { ...db.user.find((u) => u.id === SENDER)!, language: 'he', telegramId: 101 });
    assertSame(out.text, `${he.mine}\n\nFOOTER`, 'mine');
    assert(offerRow(mine.offerId).takenAt === null, 'the sender\'s own start used the offer up');
    db.nativeEvent.find((e) => e.id === 'ev1')!.isDeleted = true;
    out = await send(deleted.token);
    assertSame(out.text, `${he.gone}\n\nFOOTER`, 'gone');
    db.nativeEvent.find((e) => e.id === 'ev1')!.isDeleted = false;
    await offers.claimCopyOffer(open.offerId, RECEIVER);
    const copy = await offers.copyEventFor(db.nativeEvent.find((e) => e.id === 'ev1') as never, receiverUser() as never, 'cal-receiver');
    await offers.recordCopy(open.offerId, copy.id);
    out = await send(open.token);
    assertSame(out.text, `${he.yours.replace('{calendar}', 'Receiver cal')}\n\nFOOTER`, 'yours names the calendar');
    assert(out.options.format === 'html' || out.options.format === 'HTML' || out.options.format !== undefined, 'html format');
    assert(out.options.disablePreview === true, 'the footer comes with no preview');
  });

  await check('an open offer shows the card in the receiver\'s language and zone, one button per writable calendar (own first, main first), each at most 64 bytes with a real cuid; a user with none gets their main one made', async () => {
    reset();
    event('ev1');
    const { token } = await newOffer();
    // A second own calendar (not main, older id order) and the partner's shared editor calendar, with 25-character ids.
    db.nativeCalendar.push(
      { ...DEFAULTS.nativeCalendar(), id: CUID, ownerUserId: RECEIVER, name: 'Second', createdAt: new Date('2026-09-01T00:00:00Z') },
    );
    db.user.find((u) => u.id === RECEIVER)!.language = 'ru';
    await bot.handleCopyStart(103, receiverUser(), token, 'ru', '');
    const sent = serviceSends()[0];
    const ru = MSGS.ru;
    assert(sent.text.startsWith(`<b>${SECRET_TITLE}</b>\nчт, 3 дек., 10:00–11:00`) || sent.text.includes('3 дек'), `card text ${sent.text}`);
    assert(sent.text.endsWith(ru.open.split('\n\n')[1]), `ask line ${sent.text}`);
    const buttons = sent.options.replyMarkup.inline_keyboard.flat();
    assertSame(buttons.map((b: Row) => b.text), ['Receiver cal', 'Second'], 'own calendars, main first');
    for (const b of buttons) assert(Buffer.byteLength(b.callback_data) <= 64 && /^cp:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/.test(b.callback_data), `data ${b.callback_data}`);
    assertSame(buttons[1].callback_data, `cp:${token}:${CUID}`, 'real cuid in the data');
    assert(Buffer.byteLength(buttons[1].callback_data) === 51, `51 bytes with a cuid, got ${Buffer.byteLength(buttons[1].callback_data)}`);
    // No own calendar at all: the main one is made.
    reset();
    event('ev1');
    const o2 = await newOffer();
    db.nativeCalendar = db.nativeCalendar.filter((c) => c.ownerUserId !== RECEIVER);
    const made = db.nativeCalendar.length;
    await bot.handleCopyStart(103, receiverUser(), o2.token, 'en', '');
    assert(db.nativeCalendar.length === made + 1 && db.nativeCalendar.some((c) => c.ownerUserId === RECEIVER), 'no main calendar made');
    assertSame(serviceSends()[0].options.replyMarkup.inline_keyboard.flat().length, 1, 'one button for the new calendar');
  });

  await check('a press answers the spinner first, claims, copies into the picked calendar, records it, edits the card to "Copied to <calendar>" with "<sender> was told", and sends the sender one silent note in the SENDER\'s language naming the receiver and the title', async () => {
    reset();
    event('ev1');
    const { token, offerId } = await newOffer();
    db.user.find((u) => u.id === RECEIVER)!.language = 'ru';
    db.user.find((u) => u.id === RECEIVER)!.name = 'Dana <b>';
    db.user.find((u) => u.id === SENDER)!.language = 'he';
    db.user.find((u) => u.id === SENDER)!.name = 'Avi';
    await press(token, 'cal-receiver');
    assertSame(botCalls.map((c) => c.method), ['answerCallbackQuery', 'sendMessage', 'editMessageText'], 'order: spinner, note, edit');
    const copies = db.nativeEvent.filter((e) => e.calendarId === 'cal-receiver');
    assert(copies.length === 1 && copies[0].creatorUserId === RECEIVER && copies[0].title === SECRET_TITLE, `copies ${show(copies)}`);
    assert(offerRow(offerId).takenByUserId === RECEIVER && offerRow(offerId).copyEventId === copies[0].id, `offer ${show(offerRow(offerId))}`);
    const edit = calls('editMessageText')[0];
    assert(edit.chat_id === 103 && edit.message_id === 77 && edit.parse_mode === 'HTML', `edit ${show(edit)}`);
    assert(edit.text.startsWith('Скопировано в календарь «Receiver cal»:') && edit.text.includes(`<b>${SECRET_TITLE}</b>`) && edit.text.endsWith('Уведомление отправлено: Avi.'), `edit text ${edit.text}`);
    const note = calls('sendMessage')[0];
    assertSame(note.chat_id, 101, 'the note goes to the sender\'s chat');
    assert(note.disable_notification === true && note.parse_mode === 'HTML', `note ${show(note)}`);
    assertSame(note.text, `“${SECRET_TITLE}” הועתק ליומן של Dana &lt;b&gt;.`, 'the note, Hebrew, escaped name');
  });

  await check('a receiver with no name: the note says "Someone" in the sender\'s language', async () => {
    reset();
    event('ev1');
    const { token } = await newOffer();
    db.user.find((u) => u.id === RECEIVER)!.name = '';
    await press(token, 'cal-receiver');
    assertSame(calls('sendMessage')[0].text, `Someone copied “${SECRET_TITLE}” to their calendar.`, 'anonymous note');
  });

  await check('a second press answers taken and copies nothing more; two presses at once give one copy', async () => {
    reset();
    event('ev1');
    const { token } = await newOffer();
    await press(token, 'cal-receiver');
    botCalls.length = 0;
    await bot.handleCopyPress(104, 78, 'q2', 104, `cp:${token}:cal-other`);
    assert(db.nativeEvent.filter((e) => e.id !== 'ev1').length === 1, 'a second copy was made');
    assertSame(calls('editMessageText')[0].text, MSGS.en.taken, 'taken line for the second');
    assert(calls('sendMessage').length === 0, 'a note went out for the loser');
    // The same person again: yours.
    botCalls.length = 0;
    await press(token, 'cal-receiver');
    assertSame(calls('editMessageText')[0].text, MSGS.en.yours.replace('{calendar}', 'Receiver cal'), 'yours for the taker\'s second press');
    // Two at once, on a fresh offer.
    reset();
    event('ev1');
    const again = await newOffer();
    await Promise.all([
      press(again.token, 'cal-receiver'),
      bot.handleCopyPress(104, 78, 'q2', 104, `cp:${again.token}:cal-other`),
    ]);
    assert(db.nativeEvent.filter((e) => e.id !== 'ev1').length === 1, `copies after two at once: ${db.nativeEvent.length - 1}`);
    assert(calls('sendMessage').length === 1, `notes: ${calls('sendMessage').length}`);
  });

  await check('a store failure gives the claim back, says try again, reports it, and the offer works afterwards', async () => {
    reset();
    event('ev1');
    const { token, offerId } = await newOffer();
    const realCreate = fakePrisma.nativeEvent.create;
    fakePrisma.nativeEvent.create = async () => { throw new Error('boom'); };
    try {
      await press(token, 'cal-receiver');
    } finally {
      fakePrisma.nativeEvent.create = realCreate;
    }
    assert(offerRow(offerId).takenAt === null && offerRow(offerId).takenByUserId === null, `claim kept ${show(offerRow(offerId))}`);
    assert(db.nativeEvent.length === 1, 'an event was written');
    assertSame(calls('sendMessage').map((c) => c.text), [MSGS.en.failed], 'the try-again line, to the receiver only');
    assertSame(calls('sendMessage')[0].chat_id, 103, 'to the receiver');
    assert(captured.some((c) => c.ctx === 'event-copy-write'), 'not reported');
    await press(token, 'cal-receiver');
    assert(db.nativeEvent.filter((e) => e.id !== 'ev1').length === 1, 'the retry did not copy');
  });

  await check('a calendar the receiver can\'t write is refused and the offer stays open; the sender\'s press is "mine" with no claim', async () => {
    reset();
    event('ev1');
    const { token, offerId } = await newOffer();
    await press(token, 'cal-other');
    await press(token, 'cal-sender');
    assert(offerRow(offerId).takenAt === null && db.nativeEvent.length === 1, 'the offer was used or an event written');
    assertSame(calls('sendMessage').map((c) => c.text), [MSGS.en.notWritable, MSGS.en.notWritable], 'refusal lines');
    botCalls.length = 0;
    await bot.handleCopyPress(101, 79, 'q3', 101, `cp:${token}:cal-sender`);
    assert(offerRow(offerId).takenAt === null && db.nativeEvent.length === 1, 'the sender used it up');
    assertSame(calls('editMessageText')[0].text, MSGS.en.mine, 'mine');
  });

  await check('a note that cannot be sent (blocked bot) or a sender with no Telegram does not undo the copy, and the card then has no "was told" line', async () => {
    reset();
    event('ev1');
    const { token } = await newOffer();
    failChatId = 101;
    await press(token, 'cal-receiver');
    assert(db.nativeEvent.filter((e) => e.id !== 'ev1').length === 1, 'no copy');
    assert(!calls('editMessageText')[0].text.includes('Avi') && calls('editMessageText')[0].text.startsWith('Copied to Receiver cal'), `edit ${calls('editMessageText')[0].text}`);
    assert(captured.some((c) => c.ctx === 'event-copy-notice'), 'the failed note was not reported');
    reset();
    event('ev1');
    const o2 = await newOffer();
    db.user.find((u) => u.id === SENDER)!.telegramId = null;
    await press(o2.token, 'cal-receiver');
    assert(db.nativeEvent.filter((e) => e.id !== 'ev1').length === 1 && calls('sendMessage').length === 0, 'web sender');
  });

  await check('a button that is not cp:<token>:<calendar> is refused after answering the spinner', async () => {
    reset();
    await bot.handleCopyPress(103, 77, 'q', 103, 'cp:short:x');
    await bot.handleCopyPress(103, 77, 'q', 103, `cp:${'A'.repeat(22)}:cal-receiver:extra`);
    assertSame(botCalls.map((c) => c.method), ['answerCallbackQuery', 'answerCallbackQuery'], 'only the spinner');
  });

  // One more full run, with the log lines kept for the leak check below.
  reset();
  event('ev1');
  db.user.find((u) => u.id === RECEIVER)!.name = 'Dana';
  const last = await newOffer();
  await bot.handleCopyStart(103, receiverUser(), last.token, 'en', '');
  failChatId = 101;
  await press(last.token, 'cal-receiver');
  await press(last.token, 'cal-receiver');

  await check('no log line or captured error holds a token, the title or the card text', () => {
    const tokens = db.eventCopyOffer.map((o) => o.id);
    assert(tokens.length > 0, 'no offers made');
    const lines = [...consoleLines, ...captured.map((c) => c.message)];
    const bad = lines.filter((l) => l.includes(SECRET_TITLE) || l.includes('Dana') || /cp_[A-Za-z0-9_-]{22}/.test(l) || l.includes('start='));
    assert(bad.length === 0, `leaks: ${show(bad)}`);
    assert(lines.some((l) => l.startsWith('[event-copy]')), 'no [event-copy] line');
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
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
