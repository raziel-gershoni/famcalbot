// Smoke test for the ✅ Done / 💤 Snooze buttons on a native reminder ping:
// src/services/native-reminders/callbacks.ts, and the nr: branch and the unknown-prefix
// answer in src/services/webhook-handlers.ts. The buttons never expire, so a tap can
// come after the reminder was moved, deleted, done by the other person, or after the
// pair unlinked. Each such tap must get a short answer and never a throw: a throw fails
// the webhook with a 500, and Telegram redelivers the tap in a loop. Prisma, the bot,
// the user lookup and the timezone lookup are faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-buttons.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-buttons.ts

import path from 'path';
import type TelegramBot from 'node-telegram-bot-api';
import { __resetDueGateForTests, setNextDue, shouldRunPass } from '../src/services/native-reminders/due-gate';

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

/** JSON that can show BigInt ids and Dates. */
const show = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- The world: users, a pairing, a calendar, reminders and their state rows ----

type Row = Record<string, unknown>;
const RAZIEL = 1; // creator, Hebrew, Israel
const DANA = 2; // Raziel's partner, English, New York
const NOA = 3; // a stranger, Russian, Moscow
const TIMEZONES: Record<number, string> = { [RAZIEL]: 'Asia/Jerusalem', [DANA]: 'America/New_York', [NOA]: 'Europe/Moscow' };
const tg = (userId: number) => 1000 + userId;

// State row ids are cuids, 25 characters.
const MILK = 'cmilk00000000000000000001'; // Raziel's one-off "Buy milk" for Dana, pinged to Dana
const CALL = 'ccall00000000000000000002'; // Raziel's own one-off, pinged to Raziel
const PILLS = 'cpill00000000000000000003'; // Dana's own daily 08:00, today's occurrence
const MOVED = 'cmove00000000000000000004'; // Dana's daily, an occurrence moved to 18:30
const MILK_MSG = 501;
const CALL_MSG = 502;
const PILLS_MSG = 503;
const MOVED_MSG = 504;

const PILLS_TODAY = new Date('2026-10-14T12:00:00Z'); // Wed 08:00 in New York
const PILLS_FRIDAY = new Date('2026-10-16T12:00:00Z');

interface World { users: Row[]; pairings: Row[]; calendars: Row[]; events: Row[]; instances: Row[]; states: Row[] }
let world: World;

function freshWorld(): World {
  const event = (row: Row): Row => ({
    calendarId: 'cal-raziel', description: null, location: null, allDay: false, rrule: null, exdates: [],
    reminderMinutes: null, kind: 'REMINDER', forUserId: null, armedAt: new Date('2026-10-13T08:00:00Z'), isDeleted: false,
    createdAt: new Date('2026-10-13T08:00:00Z'), updatedAt: new Date('2026-10-13T08:00:00Z'),
    ...row,
    endsAt: row.startsAt,
  });
  const state = (row: Row): Row => ({
    doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: new Date('2026-10-14T13:00:00Z'), pingAttempts: 1,
    createdAt: new Date('2026-10-14T13:00:00Z'), updatedAt: new Date('2026-10-14T13:00:00Z'), ...row,
  });
  return {
    users: [
      { id: RAZIEL, name: 'רזיאל', englishName: 'Raziel', gender: 'male', language: 'he', telegramId: BigInt(tg(RAZIEL)), calendarSource: 'NATIVE', pairingId: 'pair-1', location: 'Tel Aviv', suspendedAt: null, unreachableSince: null },
      { id: DANA, name: 'Dana', englishName: 'Dana', gender: 'female', language: 'en', telegramId: BigInt(tg(DANA)), calendarSource: 'NATIVE', pairingId: 'pair-1', location: 'New York', suspendedAt: null, unreachableSince: null },
      { id: NOA, name: 'Ноа', englishName: 'Noa', gender: 'female', language: 'ru', telegramId: BigInt(tg(NOA)), calendarSource: 'NATIVE', pairingId: null, location: 'Moscow', suspendedAt: null, unreachableSince: null },
    ],
    pairings: [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: RAZIEL, inviteeUserId: DANA }],
    calendars: [
      { id: 'cal-raziel', ownerUserId: RAZIEL, privacy: 'PRIVATE', isDeleted: false },
      { id: 'cal-dana', ownerUserId: DANA, privacy: 'SHARED_VIEWER', isDeleted: false },
    ],
    events: [
      event({ id: 'ev-milk', creatorUserId: RAZIEL, forUserId: DANA, title: 'Buy milk', startsAt: new Date('2026-10-14T13:00:00Z'), timeZone: 'Asia/Jerusalem' }),
      event({ id: 'ev-call', creatorUserId: RAZIEL, title: 'Call the plumber', startsAt: new Date('2026-10-14T07:00:00Z'), timeZone: 'Asia/Jerusalem' }),
      event({ id: 'ev-pills', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Pills', startsAt: new Date('2026-10-01T12:00:00Z'), timeZone: 'America/New_York', rrule: 'FREQ=DAILY' }),
    ],
    instances: [
      { id: 'ov-1', seriesEventId: 'ev-pills', originalStartsAt: PILLS_FRIDAY, status: 'OVERRIDE', title: 'Pills (late)', description: null, location: null, startsAt: new Date('2026-10-16T22:30:00Z'), endsAt: new Date('2026-10-16T22:30:00Z'), allDay: null, createdAt: new Date(), updatedAt: new Date() },
    ],
    states: [
      state({ id: MILK, seriesEventId: 'ev-milk', originalStartsAt: new Date('2026-10-14T13:00:00Z'), pingChatId: BigInt(tg(DANA)), pingMessageId: MILK_MSG }),
      state({ id: CALL, seriesEventId: 'ev-call', originalStartsAt: new Date('2026-10-14T07:00:00Z'), pingChatId: BigInt(tg(RAZIEL)), pingMessageId: CALL_MSG }),
      state({ id: PILLS, seriesEventId: 'ev-pills', originalStartsAt: PILLS_TODAY, pingChatId: BigInt(tg(DANA)), pingMessageId: PILLS_MSG }),
      state({ id: MOVED, seriesEventId: 'ev-pills', originalStartsAt: PILLS_FRIDAY, pingChatId: BigInt(tg(DANA)), pingMessageId: MOVED_MSG }),
    ],
  };
}

const user = (id: number) => world.users.find(u => u.id === id)!;
const stateRow = (id: string) => world.states.find(s => s.id === id)!;
const eventRow = (id: string) => world.events.find(e => e.id === id)!;

// ---- Fake Prisma ----

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? row : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));
/** A `where` of plain values, where null means "is null". */
const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));

let dbDown = false;
type FindUnique = { where: { id: unknown }; select?: Record<string, boolean> };
type Include = { seriesEvent: { include: { calendar: { select: Record<string, boolean> }; creator: { select: Record<string, boolean> }; instances: boolean } } };
const fakePrisma = {
  nativeReminderState: {
    findUnique: async ({ where, include }: { where: { id: string }; include: Include }) => {
      if (dbDown) throw new Error('Can\'t reach database server');
      const state = world.states.find(s => s.id === where.id);
      if (!state) return null;
      const series = eventRow(state.seriesEventId as string);
      const inc = include.seriesEvent.include;
      return {
        ...state,
        seriesEvent: {
          ...series,
          calendar: pick(world.calendars.find(c => c.id === series.calendarId), inc.calendar.select),
          creator: pick(user(series.creatorUserId as number), inc.creator.select),
          instances: world.instances.filter(i => i.seriesEventId === series.id),
        },
      };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = world.states.filter(s => matches(s, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
  pairing: {
    findUnique: async ({ where, select }: FindUnique) => pick(world.pairings.find(p => p.id === where.id), select),
  },
  user: {
    findUnique: async ({ where, select }: FindUnique) => pick(world.users.find(u => u.id === where.id), select),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = world.users.filter(u => matches(u, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
};

// ---- Fake bot: records every answer, edit and send ----

type BotCall =
  | { kind: 'answer'; queryId: string; text?: string }
  | { kind: 'edit'; chatId: number; messageId: number; text: string; buttons: boolean; html: boolean }
  | { kind: 'markup'; chatId: number; messageId: number; buttons: boolean }
  | { kind: 'send'; chatId: number; text: string; silent: boolean; html: boolean };
let botCalls: BotCall[] = [];
const botFailures: { edit?: Error; markup?: Error; answer?: Error; send?: Error } = {};

/** A Telegram API error as node-telegram-bot-api throws it. */
const telegramError = (status: number, description: string) =>
  Object.assign(new Error(`ETELEGRAM: ${status} ${description}`), { code: 'ETELEGRAM', response: { body: { error_code: status, description } } });

/** Whether reply_markup (an object, or the JSON string the adapter sends) still has buttons. */
function hasButtons(markup: unknown): boolean {
  const parsed = typeof markup === 'string' ? JSON.parse(markup) : markup;
  return !!(parsed as TelegramBot.InlineKeyboardMarkup | undefined)?.inline_keyboard?.some(row => row.length > 0);
}

type EditOptions = { chat_id?: number | string; message_id?: number; parse_mode?: string; reply_markup?: unknown };
const fakeBot = {
  answerCallbackQuery: async (queryId: string, options?: { text?: string }) => {
    botCalls.push({ kind: 'answer', queryId, text: options?.text });
    if (botFailures.answer) throw botFailures.answer;
    return true;
  },
  editMessageText: async (text: string, options: EditOptions) => {
    botCalls.push({ kind: 'edit', chatId: Number(options.chat_id), messageId: Number(options.message_id), text, buttons: hasButtons(options.reply_markup), html: options.parse_mode === 'HTML' });
    if (botFailures.edit) throw botFailures.edit;
    return true;
  },
  editMessageReplyMarkup: async (markup: TelegramBot.InlineKeyboardMarkup, options: EditOptions) => {
    botCalls.push({ kind: 'markup', chatId: Number(options.chat_id), messageId: Number(options.message_id), buttons: hasButtons(markup) });
    if (botFailures.markup) throw botFailures.markup;
    return true;
  },
  sendMessage: async (chatId: number | string, text: string, options?: { parse_mode?: string; disable_notification?: boolean }) => {
    botCalls.push({ kind: 'send', chatId: Number(chatId), text, silent: options?.disable_notification === true, html: options?.parse_mode === 'HTML' });
    if (botFailures.send) throw botFailures.send;
    return { message_id: 900 };
  },
};

// ---- The other fakes ----

const captured: string[] = [];
const activity: { userId: number; action: string; meta?: Row }[] = [];

/** The UserConfig getUserByTelegramId returns: the row with a numeric telegramId. */
async function fakeGetUserByTelegramId(telegramId: number | bigint) {
  const row = world.users.find(u => u.telegramId === BigInt(telegramId));
  return row ? { ...row, telegramId: Number(row.telegramId) } : null;
}

// ---- Scenario helpers ----

let queryCount = 0;
/** A tap by `userId` on a button of message `messageId` in their own chat. */
function tap(userId: number, data: string, messageId: number): TelegramBot.CallbackQuery {
  queryCount++;
  return {
    id: `q${queryCount}`,
    from: { id: tg(userId), is_bot: false, first_name: 'Tapper' },
    chat_instance: 'ci',
    data,
    message: { message_id: messageId, date: 0, chat: { id: tg(userId), type: 'private' } },
  } as TelegramBot.CallbackQuery;
}

function reset() {
  world = freshWorld();
  botCalls = [];
  captured.length = 0;
  activity.length = 0;
  dbDown = false;
  for (const key of Object.keys(botFailures) as (keyof typeof botFailures)[]) delete botFailures[key];
}

const answersTo = (q: TelegramBot.CallbackQuery) =>
  botCalls.filter((c): c is Extract<BotCall, { kind: 'answer' }> => c.kind === 'answer' && c.queryId === q.id);
/** Every tap is answered exactly once; returns the toast. */
function toastOf(q: TelegramBot.CallbackQuery): string | undefined {
  const answers = answersTo(q);
  assert(answers.length === 1, `answered ${answers.length} times`);
  return answers[0].text;
}
const edits = () => botCalls.filter((c): c is Extract<BotCall, { kind: 'edit' }> => c.kind === 'edit');
const markups = () => botCalls.filter((c): c is Extract<BotCall, { kind: 'markup' }> => c.kind === 'markup');
const sends = () => botCalls.filter((c): c is Extract<BotCall, { kind: 'send' }> => c.kind === 'send');

/** The ping was edited to `text` with its buttons gone, and nothing else was edited. */
function assertEditedTo(chatId: number, messageId: number, text: string) {
  const all = edits();
  assert(all.length >= 1, 'the ping was not edited');
  assert(all.every(e => e.chatId === chatId && e.messageId === messageId), `edited ${show(all)}`);
  const last = all[all.length - 1];
  assert(last.text === text, `\n     text ${show(last.text)}\n     want ${show(text)}`);
  assert(last.html && !last.buttons, `html ${last.html}, buttons ${last.buttons}`);
}

/** The buttons came off message `messageId` and its text was left alone. */
function assertButtonsRemoved(chatId: number, messageId: number) {
  assert(edits().length === 0, `text edited: ${show(edits())}`);
  const removed = markups();
  assert(removed.length === 1 && removed[0].chatId === chatId && removed[0].messageId === messageId && !removed[0].buttons,
    `markup edits ${show(removed)}`);
}

function assertUntouched(id: string) {
  const row = stateRow(id);
  assert(row.doneAt === null && row.snoozedUntil === null, `state written: ${show(row)}`);
}

// 10:00 in New York, 17:00 in Israel, on Wednesday 14 Oct 2026.
const NOW = new Date('2026-10-14T14:00:00Z');
const MIN = 60 * 1000;

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
  // The ping module may edit through the bot or through the Telegram adapter; both reach fakeBot.
  let adapter: unknown = null;
  const telegram = { getBot: () => fakeBot, getMessagingService: () => adapter };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('utils/redis.ts', { redis: {} }); // nothing on this path may reach Redis
  stub('services/telegram/bot.ts', telegram);
  stub('services/telegram/index.ts', telegram);
  stub('services/user-service.ts', { getUserByTelegramId: fakeGetUserByTelegramId });
  stub('lib/timezone.ts', { resolveUserTimezone: async (u: { id: number }) => TIMEZONES[u.id] });
  stub('lib/error-capture.ts', {
    captureError: (err: unknown, context: string) => { captured.push(`${context}: ${err instanceof Error ? err.message : String(err)}`); },
    captureWarning: () => {},
    captureInfo: () => {},
  });
  stub('services/analytics-service.ts', {
    trackActivityAsync: (userId: number, action: string, meta?: Row) => { activity.push({ userId, action, meta }); },
    setUserContext: () => {},
    addBreadcrumb: () => {},
  });
  // What the webhook handler loads besides the callback branch.
  stub('services/voice/index.ts', {});
  stub('services/voice/speech-presence.ts', { NO_SPEECH: 'no_speech' });
  stub('services/payment-handler.ts', {});
  stub('lib/user-moderation.ts', { isIdentifierBlocked: async () => false, isUserSuspended: () => false });

  const { TelegramAdapter } = await import('../src/services/messaging/telegram-adapter');
  adapter = new TelegramAdapter(fakeBot as unknown as TelegramBot);
  const { handleNativeReminderCallback, parseNativeReminderCallback, NATIVE_REMINDER_CALLBACK_PREFIX } =
    await import('../src/services/native-reminders/callbacks');
  const { buildPingKeyboard } = await import('../src/services/native-reminders/ping');
  const { getBotMessage } = await import('../src/lib/bot-messages');
  /** Hebrew and Russian copy as messages/*.json has it; the English is the plan's reference copy. */
  const copy = (language: string, key: string, params?: Record<string, string>) =>
    getBotMessage(language, `nativeReminders.${key}`, params);
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');

  // ---- Callback data ----

  await check('parse: each button\'s data names its op and state row', () => {
    for (const op of ['d', 's15', 's60', 'st'] as const) {
      assert(show(parseNativeReminderCallback(`nr:${op}:${MILK}`)) === show({ op, stateId: MILK }), `nr:${op}`);
    }
    assert(NATIVE_REMINDER_CALLBACK_PREFIX === 'nr:', `prefix ${NATIVE_REMINDER_CALLBACK_PREFIX}`);
  });

  await check('parse: anything else is not a reminder button', () => {
    for (const data of ['nr:x:abc', 'nr:d:', `nr:d:${MILK}:extra`, `nr:s30:${MILK}`, 'nr:d:a b', `event_create:${MILK}`, `nr:d:${'a'.repeat(58)}`, '']) {
      assert(parseNativeReminderCallback(data) === null, `parsed ${show(data)}`);
    }
  });

  await check('parse: the ping keyboard\'s data fits 64 bytes and parses back, for a cuid and a uuid', async () => {
    for (const stateId of [MILK, '0f8fad5b-d9cb-469f-a165-70867728950e']) {
      const keyboard = await buildPingKeyboard(stateId, 'he');
      const data = keyboard.inline_keyboard.flat().map(b => b.callback_data ?? '');
      assert(show(data) === show([`nr:d:${stateId}`, `nr:s15:${stateId}`, `nr:s60:${stateId}`, `nr:st:${stateId}`]), `data ${show(data)}`);
      for (const d of data) {
        assert(Buffer.byteLength(d, 'utf8') <= 64, `${d} is ${Buffer.byteLength(d, 'utf8')} bytes`);
        assert(parseNativeReminderCallback(d)?.stateId === stateId, `${d} does not parse back`);
      }
    }
  });

  // ---- Done: who may tap ----

  await check('Done by the owner: marked done by them, ping edited, creator told quietly in Hebrew', async () => {
    reset();
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    const row = stateRow(MILK);
    assert(show(row.doneAt) === show(NOW) && row.doneByUserId === DANA, `state ${show(row)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '✅ Buy milk');
    const notices = sends();
    assert(notices.length === 1, `sends ${show(notices)}`);
    assert(notices[0].chatId === tg(RAZIEL) && notices[0].silent && notices[0].html, `notice ${show(notices[0])}`);
    const notice = await copy('he', 'doneBy', { name: 'Dana', title: 'Buy milk' });
    assert(notices[0].text === notice, `notice text ${show(notices[0].text)}, want ${show(notice)}`);
    assert(show(activity) === show([{ userId: DANA, action: 'native_reminder_done', meta: { series_event_id: 'ev-milk' } }]), `activity ${show(activity)}`);
  });

  await check('Done twice: the second tap says "already done" and nobody is told again', async () => {
    reset();
    await handleNativeReminderCallback(tap(DANA, `nr:d:${MILK}`, MILK_MSG), NOW);
    const second = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(second, new Date(NOW.getTime() + MIN));
    assert(toastOf(second) === 'Already done 👍', `toast ${toastOf(second)}`);
    assert(show(stateRow(MILK).doneAt) === show(NOW), `doneAt moved: ${show(stateRow(MILK).doneAt)}`);
    assert(sends().length === 1, `${sends().length} notices`);
    assert(activity.length === 1, `${activity.length} activities`);
  });

  await check('Done by the creator on their own reminder: no notice', async () => {
    reset();
    const q = tap(RAZIEL, `nr:d:${CALL}`, CALL_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(CALL).doneByUserId === RAZIEL, `state ${show(stateRow(CALL))}`);
    assertEditedTo(tg(RAZIEL), CALL_MSG, '✅ Call the plumber');
    assert(sends().length === 0, `sends ${show(sends())}`);
  });

  await check('Done by the creator on the partner\'s reminder: allowed, no notice to themselves', async () => {
    reset();
    const q = tap(RAZIEL, `nr:d:${MILK}`, 777);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === RAZIEL, `state ${show(stateRow(MILK))}`);
    assert(sends().length === 0, `sends ${show(sends())}`);
  });

  await check('a stranger\'s tap: "not yours" in their language, nothing written or edited', async () => {
    reset();
    const q = tap(NOA, `nr:d:${MILK}`, 601);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === (await copy('ru', 'notYours')), `toast ${toastOf(q)}`);
    assertUntouched(MILK);
    assert(edits().length === 0 && markups().length === 0 && sends().length === 0, `bot calls ${show(botCalls)}`);
  });

  await check('a tap from someone with no account: "not yours", in English', async () => {
    reset();
    const q = { ...tap(NOA, `nr:d:${MILK}`, 601), from: { id: 4242, is_bot: false, first_name: 'Ghost' } };
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'This reminder isn\'t yours.', `toast ${toastOf(q)}`);
    assertUntouched(MILK);
  });

  await check('after unlinking: the ex-partner\'s old ping says "changed" and loses its buttons', async () => {
    reset();
    world.pairings[0].status = 'UNLINKED';
    user(RAZIEL).pairingId = null;
    user(DANA).pairingId = null;
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'This reminder changed or no longer exists.', `toast ${toastOf(q)}`);
    assertUntouched(MILK);
    assertButtonsRemoved(tg(DANA), MILK_MSG);
    assert(sends().length === 0, `sends ${show(sends())}`);
  });

  await check('after unlinking: the creator can still mark it done', async () => {
    reset();
    world.pairings[0].status = 'UNLINKED';
    user(RAZIEL).pairingId = null;
    user(DANA).pairingId = null;
    const q = tap(RAZIEL, `nr:d:${MILK}`, 777);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === RAZIEL, `state ${show(stateRow(MILK))}`);
  });

  await check('the partner moved to Google: their old ping says "changed"', async () => {
    reset();
    user(DANA).calendarSource = 'GOOGLE';
    const q = tap(DANA, `nr:s15:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'This reminder changed or no longer exists.', `toast ${toastOf(q)}`);
    assertUntouched(MILK);
    assertButtonsRemoved(tg(DANA), MILK_MSG);
  });

  // ---- Stale buttons ----

  const staleCases: [string, () => void, string, number][] = [
    ['the time changed (the re-arm deleted the state row)', () => { world.states = world.states.filter(s => s.id !== MILK); }, MILK, MILK_MSG],
    ['the reminder was deleted', () => { eventRow('ev-milk').isDeleted = true; }, MILK, MILK_MSG],
    ['its calendar was deleted', () => { world.calendars[0].isDeleted = true; }, MILK, MILK_MSG],
    ['it is no longer a reminder', () => { eventRow('ev-milk').kind = 'EVENT'; }, MILK, MILK_MSG],
    ['today\'s occurrence was skipped (exdate)', () => { eventRow('ev-pills').exdates = [PILLS_TODAY]; }, PILLS, PILLS_MSG],
    ['the occurrence was cancelled (override)', () => {
      world.instances.push({ id: 'ov-2', seriesEventId: 'ev-pills', originalStartsAt: PILLS_TODAY, status: 'CANCELLED', title: null, startsAt: null, endsAt: null, allDay: null });
    }, PILLS, PILLS_MSG],
    ['"delete from today on" cut the series before it', () => { eventRow('ev-pills').rrule = 'FREQ=DAILY;UNTIL=20261013T235959'; }, PILLS, PILLS_MSG],
  ];
  for (const [what, change, stateId, messageId] of staleCases) {
    await check(`stale: ${what} → "changed", buttons removed, nothing written`, async () => {
      reset();
      change();
      const q = tap(DANA, `nr:d:${stateId}`, messageId);
      await handleNativeReminderCallback(q, NOW);
      assert(toastOf(q) === 'This reminder changed or no longer exists.', `toast ${toastOf(q)}`);
      assertButtonsRemoved(tg(DANA), messageId);
      if (world.states.some(s => s.id === stateId)) assertUntouched(stateId);
      assert(sends().length === 0 && activity.length === 0, `side effects ${show({ sends: sends(), activity })}`);
    });
  }

  await check('an occurrence moved to another time is still found by its key, with its own title', async () => {
    reset();
    const q = tap(DANA, `nr:d:${MOVED}`, MOVED_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MOVED).doneByUserId === DANA, `state ${show(stateRow(MOVED))}`);
    assertEditedTo(tg(DANA), MOVED_MSG, '✅ Pills (late)');
  });

  await check('a daily reminder\'s live occurrence is marked done on its own row only', async () => {
    reset();
    const q = tap(DANA, `nr:d:${PILLS}`, PILLS_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(PILLS).doneByUserId === DANA && stateRow(MOVED).doneAt === null, `states ${show(world.states)}`);
    assertEditedTo(tg(DANA), PILLS_MSG, '✅ Pills');
  });

  // ---- Snooze ----

  await check('snooze 15 min: snoozedUntil = now + 15, ping says until 10:15 New York time, gate opens', async () => {
    reset();
    __resetDueGateForTests();
    setNextDue(new Date(NOW.getTime() + 50 * MIN), NOW);
    assert(!shouldRunPass(new Date(NOW.getTime() + MIN)), 'gate open before the snooze');
    const q = tap(DANA, `nr:s15:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(show(stateRow(MILK).snoozedUntil) === show(new Date(NOW.getTime() + 15 * MIN)), `snoozedUntil ${show(stateRow(MILK).snoozedUntil)}`);
    assert(stateRow(MILK).doneAt === null, 'marked done');
    assertEditedTo(tg(DANA), MILK_MSG, '💤 Buy milk · until 10:15');
    assert(shouldRunPass(new Date(NOW.getTime() + MIN)), 'gate still closed after the snooze');
    assert(show(activity) === show([{ userId: DANA, action: 'native_reminder_snoozed', meta: { snooze: 's15' } }]), `activity ${show(activity)}`);
  });

  await check('snooze 1 hour: now + 60', async () => {
    reset();
    const q = tap(DANA, `nr:s60:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(show(stateRow(MILK).snoozedUntil) === show(new Date(NOW.getTime() + 60 * MIN)), `snoozedUntil ${show(stateRow(MILK).snoozedUntil)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '💤 Buy milk · until 11:00');
  });

  await check('snooze tomorrow at 10:00 local: tomorrow 09:00 on the tapper\'s clock, with the weekday', async () => {
    reset();
    const q = tap(DANA, `nr:st:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    // Thursday 15 Oct, 09:00 in New York (EDT) is 13:00 UTC.
    assert(show(stateRow(MILK).snoozedUntil) === show(new Date('2026-10-15T13:00:00Z')), `snoozedUntil ${show(stateRow(MILK).snoozedUntil)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '💤 Buy milk · until Thu 09:00');
  });

  await check('snooze tomorrow at 02:00 local: this morning at 09:00 (R6), in Hebrew', async () => {
    reset();
    // 02:00 on Wednesday in Israel (IDT) is 23:00 UTC on Tuesday.
    const q = tap(RAZIEL, `nr:st:${CALL}`, CALL_MSG);
    await handleNativeReminderCallback(q, new Date('2026-10-13T23:00:00Z'));
    assert(show(stateRow(CALL).snoozedUntil) === show(new Date('2026-10-14T06:00:00Z')), `snoozedUntil ${show(stateRow(CALL).snoozedUntil)}`);
    // "יום ד׳" is Wednesday, short, in Hebrew.
    assertEditedTo(tg(RAZIEL), CALL_MSG, await copy('he', 'snoozedUntil', { title: 'Call the plumber', time: 'יום ד׳ 09:00' }));
  });

  await check('snooze resets the retry budget (pingAttempts 3 -> 0) and leaves lastPingedAt alone', async () => {
    reset();
    stateRow(MILK).pingAttempts = 3;
    const pinged = show(stateRow(MILK).lastPingedAt);
    const q = tap(DANA, `nr:s15:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).pingAttempts === 0, `pingAttempts ${show(stateRow(MILK).pingAttempts)}`);
    assert(show(stateRow(MILK).lastPingedAt) === pinged, `lastPingedAt ${show(stateRow(MILK).lastPingedAt)}`);
  });

  await check('snooze after it was done: "already done", no snooze, ping shows it done', async () => {
    reset();
    stateRow(MILK).doneAt = new Date('2026-10-14T13:30:00Z');
    stateRow(MILK).doneByUserId = RAZIEL;
    const q = tap(DANA, `nr:s60:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'Already done 👍', `toast ${toastOf(q)}`);
    assert(stateRow(MILK).snoozedUntil === null, `snoozed: ${show(stateRow(MILK).snoozedUntil)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '✅ Buy milk');
    assert(activity.length === 0, `activity ${show(activity)}`);
  });

  // ---- HTML ----

  await check('titles and names are escaped in the edited ping and the creator\'s notice', async () => {
    reset();
    eventRow('ev-milk').title = 'Pay <Dana> & co';
    user(DANA).name = 'D<a>na';
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assertEditedTo(tg(DANA), MILK_MSG, '✅ Pay &lt;Dana&gt; &amp; co');
    const notice = await copy('he', 'doneBy', { name: 'D&lt;a&gt;na', title: 'Pay &lt;Dana&gt; &amp; co' });
    assert(sends()[0]?.text === notice, `notice ${show(sends()[0]?.text)}, want ${show(notice)}`);
  });

  // ---- Nothing escapes ----

  await check('"message is not modified" on the edit: still done, answered once, no error reported', async () => {
    reset();
    botFailures.edit = telegramError(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === DANA, 'not marked done');
    assert(captured.length === 0, `captured ${show(captured)}`);
  });

  await check('any other failed edit: still done, the creator is still told, answered once', async () => {
    reset();
    botFailures.edit = telegramError(400, 'Bad Request: can\'t parse entities');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === DANA && sends().length === 1, `state ${show(stateRow(MILK))}, sends ${sends().length}`);
  });

  await check('"query is too old" when answering: the handler still returns quietly', async () => {
    reset();
    botFailures.answer = telegramError(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(answersTo(q).length === 1, `answered ${answersTo(q).length} times`);
    assert(stateRow(MILK).doneByUserId === DANA, 'not marked done');
  });

  await check('the database is down: answered once with no toast, the error reported, nothing thrown', async () => {
    reset();
    dbDown = true;
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(captured.length === 1 && captured[0].startsWith('native-reminder-callback:'), `captured ${show(captured)}`);
  });

  await check('the creator blocked the bot: the notice marks them unreachable, the tap still succeeds', async () => {
    reset();
    botFailures.send = telegramError(403, 'Forbidden: bot was blocked by the user');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(user(RAZIEL).unreachableSince instanceof Date, `unreachableSince ${show(user(RAZIEL).unreachableSince)}`);
  });

  // ---- The webhook ----

  type Response = { code: number; body: unknown };
  const webhook = async (callbackQuery: TelegramBot.CallbackQuery) => {
    const responses: Response[] = [];
    const res = { status: (code: number) => ({ json: (body: unknown) => { responses.push({ code, body }); } }) };
    await handleTelegramWebhook({ body: { update_id: 1, callback_query: callbackQuery } }, res);
    return responses;
  };

  await check('webhook: an nr: tap reaches the handler and gets a 200', async () => {
    reset();
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    const responses = await webhook(q);
    assert(show(responses) === show([{ code: 200, body: { ok: true } }]), `responses ${show(responses)}`);
    assert(stateRow(MILK).doneByUserId === DANA, `state ${show(stateRow(MILK))}`);
    assert(answersTo(q).length === 1, `answered ${answersTo(q).length} times`);
  });

  await check('webhook: a button with an unknown prefix is answered, so its spinner stops', async () => {
    reset();
    const q = tap(DANA, 'retired_button:42', 700);
    const responses = await webhook(q);
    assert(show(responses) === show([{ code: 200, body: { ok: true } }]), `responses ${show(responses)}`);
    assert(answersTo(q).length === 1 && answersTo(q)[0].text === undefined, `answers ${show(answersTo(q))}`);
  });

  await check('no network was touched', () => {
    assert(networkAttempts.length === 0, `requests: ${networkAttempts.join(', ')}`);
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
