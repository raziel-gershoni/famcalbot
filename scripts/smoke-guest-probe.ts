// Smoke test for the Telegram Guest Mode probe (a temporary diagnostic, src/services/telegram/guest-probe.ts):
//   - describeGuestUpdate keeps every person-made string out of the log line: the fixture is full of text, names, a
//     username, a title, a phone number, entities and a replied-to message with text, and the summary holds none of
//     them; only key names, lengths, the chat type, the sender's id, the account flag and the age remain;
//   - handleTelegramWebhook routes a guest_message before every other dispatch: one `[guest probe]` line, exactly
//     one answerGuestQuery (JSON-serialized article, in the caller's language), no message handler, no account made;
//   - a blocked or suspended caller is dropped by the moderation gate before the probe;
//   - a failed answer is logged with Telegram's status and description, tried once, and never throws.
//
// Faked: the bot, the user lookup, Prisma, Redis, the moderation lists, analytics and error capture. The webhook
// handler, the probe and the bot texts (messages/*.json) are the real ones. No network, no database.
//
//   npx tsx scripts/smoke-guest-probe.ts

import Module from 'node:module';
import path from 'node:path';
import type { UserConfig } from '../src/types';

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

const show = (value: unknown): string => JSON.stringify(value);

// ---- Environment: fakes only ----

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- Fakes ----

const realLog = console.log;
let logs: string[] = [];
const capture = (...args: unknown[]) => { logs.push(args.map(a => (typeof a === 'string' ? a : show(a))).join(' ')); };
console.log = capture;
console.warn = capture;
console.error = capture;
console.info = capture;

/** Everything that would be a message handler, a payment handler or an account being made, by name. */
let handlerCalls: string[] = [];
const record = (name: string) => async () => { handlerCalls.push(name); };

/** The bot's `_request` calls, and what the next one does. */
type BotCall = { method: string; form: Record<string, unknown> };
let botCalls: BotCall[] = [];
let botOutcome: 'ok' | 'telegram-error' | 'no-answer' = 'ok';
let botDelayMs = 0;
const fakeBot = {
  _request: async (method: string, options: { form: Record<string, unknown> }) => {
    botCalls.push({ method, form: options.form });
    if (botDelayMs) await new Promise(resolve => setTimeout(resolve, botDelayMs));
    if (botOutcome === 'telegram-error') {
      throw Object.assign(new Error('ETELEGRAM: 400 Bad Request: guest mode is off'), {
        code: 'ETELEGRAM',
        response: { statusCode: 400, body: { ok: false, error_code: 400, description: 'Bad Request: guest mode is off' } },
      });
    }
    if (botOutcome === 'no-answer') throw Object.assign(new Error('EFATAL: socket hang up'), { code: 'EFATAL' });
    return { inline_message_id: 'inline-1' };
  },
  sendMessage: record('bot.sendMessage'),
};

const KNOWN = 4001; // an account, Hebrew
const KNOWN_RU = 4002; // an account, Russian
const KNOWN_NO_LANG = 4003; // an account with no language set
const BLOCKED = 4004;
const SUSPENDED = 4005;
const STRANGER = 4009; // no account

function makeUser(id: number, telegramId: number, extra: Record<string, unknown>): UserConfig {
  return {
    id, telegramId, name: 'Someone', language: 'en', calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: null,
    isAdmin: false, suspendedAt: null, unreachableSince: null, ...extra,
  } as unknown as UserConfig;
}
const USERS: Record<number, UserConfig> = {
  [KNOWN]: makeUser(1, KNOWN, { language: 'he' }),
  [KNOWN_RU]: makeUser(2, KNOWN_RU, { language: 'ru' }),
  [KNOWN_NO_LANG]: makeUser(3, KNOWN_NO_LANG, { language: undefined }),
  [SUSPENDED]: makeUser(5, SUSPENDED, { suspendedAt: new Date('2026-01-01T00:00:00Z') }),
};

let lookups: number[] = [];
const fakeGetUserByTelegramId = async (telegramId: number | bigint) => {
  lookups.push(Number(telegramId));
  return USERS[Number(telegramId)] ?? null;
};

/** Any Prisma call at all is recorded: a guest message must not reach the database. */
const prismaCalls: string[] = [];
const fakePrisma: unknown = new Proxy(() => undefined, {
  get: (_t, prop) => {
    const name = String(prop);
    return new Proxy(() => undefined, {
      get: (_t2, prop2) => (...args: unknown[]) => { prismaCalls.push(`${name}.${String(prop2)}(${args.length})`); return Promise.resolve(null); },
    });
  },
});

let captured: string[] = [];

function reset() {
  logs = [];
  handlerCalls = [];
  botCalls = [];
  botOutcome = 'ok';
  botDelayMs = 0;
  lookups = [];
  prismaCalls.length = 0;
  captured = [];
}

/** A guest_message as Telegram describes it, with a replied-to message: every string in it is a sentinel. */
const SENTINELS = [
  'SECRET-BODY-TEXT', 'Zelda', 'Quinn-Last', 'zelda_user', 'Family Dinner Chat', '+972501234567', 'SECRET-CAPTION',
  'SECRET-REPLY-TEXT', 'SECRET-QUOTE-TEXT', 'https://secret.example/path', 'Reply-First-Name', 'SECRET-EXTERNAL-TITLE',
];
const NOW = new Date('2026-11-07T10:00:05.000Z').getTime();
const DATE_SECONDS = Math.floor(new Date('2026-11-07T10:00:00.000Z').getTime() / 1000);

function guestUpdate(fromId: number, extra: Record<string, unknown> = {}, languageCode?: string): Record<string, unknown> {
  return {
    update_id: 900,
    guest_message: {
      message_id: 77,
      guest_query_id: 'gq-1',
      date: DATE_SECONDS,
      text: '@famcal_bot SECRET-BODY-TEXT',
      caption: 'SECRET-CAPTION',
      chat: { id: -100123, type: 'supergroup', title: 'Family Dinner Chat' },
      from: { id: fromId, is_bot: false, first_name: 'Zelda', last_name: 'Quinn-Last', username: 'zelda_user', ...(languageCode ? { language_code: languageCode } : {}) },
      contact: { phone_number: '+972501234567', first_name: 'Zelda' },
      entities: [{ type: 'mention', offset: 0, length: 11 }, { type: 'text_link', offset: 12, length: 4, url: 'https://secret.example/path' }],
      reply_to_message: {
        message_id: 70,
        date: DATE_SECONDS - 60,
        chat: { id: -100123, type: 'supergroup', title: 'Family Dinner Chat' },
        from: { id: 555, is_bot: false, first_name: 'Reply-First-Name' },
        text: 'SECRET-REPLY-TEXT',
        reply_to_message: { message_id: 60, text: 'SECRET-REPLY-TEXT', date: DATE_SECONDS - 120 },
      },
      external_reply: { origin: { type: 'channel', chat: { id: 1, title: 'SECRET-EXTERNAL-TITLE', type: 'channel' }, message_id: 9 }, message_id: 9, chat: { id: 1, type: 'channel' } },
      quote: { text: 'SECRET-QUOTE-TEXT', position: 0, entities: [{ type: 'bold', offset: 0, length: 3 }] },
      ...extra,
    },
  };
}

function makeRes() {
  const statuses: number[] = [];
  return { statuses, res: { status: (code: number) => { statuses.push(code); return { json: () => {} }; } } };
}

const probeLines = () => logs.filter(l => l.startsWith('[guest probe] {'));

async function main() {
  // The stubs go into require's cache before the modules that import them load.
  const Mod = Module as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Mod(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Mod._cache[filename] = mod;
  };
  const telegram = {
    getBot: () => fakeBot,
    getMessagingService: () => ({ sendMessage: record('messaging.sendMessage') }),
    handleStartCommand: record('handleStartCommand'),
    handleSummaryCommand: record('handleSummaryCommand'),
    handleWeatherCommand: record('handleWeatherCommand'),
    handleFeedbackCommand: record('handleFeedbackCommand'),
    handleSupportCommand: record('handleSupportCommand'),
    handleConnectCommand: record('handleConnectCommand'),
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('utils/redis.ts', { redis: {} }); // nothing on this path may reach Redis
  stub('services/telegram/bot.ts', telegram);
  stub('services/telegram/index.ts', telegram);
  stub('services/user-service.ts', {
    getUserByTelegramId: fakeGetUserByTelegramId,
    getUserByWhatsAppPhone: record('getUserByWhatsAppPhone'),
    getOrCreateUserByWhatsApp: record('getOrCreateUserByWhatsApp'),
    createAccount: record('createAccount'),
  });
  stub('lib/error-capture.ts', {
    captureError: (err: unknown, context: string) => { captured.push(`${context}: ${err instanceof Error ? err.message : String(err)}`); },
    captureWarning: (message: string, context: string) => { captured.push(`${context}: ${message}`); capture(`[${context}]`, message); },
    captureInfo: () => {},
  });
  stub('services/analytics-service.ts', { trackActivityAsync: () => {}, setUserContext: () => {}, addBreadcrumb: () => {} });
  stub('services/voice/index.ts', {
    handleVoiceMessage: record('handleVoiceMessage'),
    handleEventCallback: record('handleEventCallback'),
    handleEditCallback: record('handleEditCallback'),
    handleDeleteCallback: record('handleDeleteCallback'),
  });
  stub('services/voice/speech-presence.ts', { NO_SPEECH: 'no_speech' });
  stub('services/payment-handler.ts', {
    handlePreCheckoutQuery: record('handlePreCheckoutQuery'),
    handleSuccessfulPayment: record('handleSuccessfulPayment'),
  });
  stub('lib/user-moderation.ts', {
    isIdentifierBlocked: async (args: { telegramId?: number }) => args.telegramId === BLOCKED,
    isUserSuspended: (user: { suspendedAt?: Date | null }) => Boolean(user.suspendedAt),
  });

  const { describeGuestUpdate } = await import('../src/services/telegram/guest-probe');
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');
  const heMessages = (await import('../messages/he.json')).default.bot.guestProbe;
  const ruMessages = (await import('../messages/ru.json')).default.bot.guestProbe;
  const enMessages = (await import('../messages/en.json')).default.bot.guestProbe;

  const send = async (update: Record<string, unknown>) => {
    reset();
    const { statuses, res } = makeRes();
    await handleTelegramWebhook({ body: update }, res);
    return statuses;
  };
  const answerOf = (call: BotCall) => JSON.parse(String(call.form.result)) as {
    type: string; id: string; title: string; input_message_content: { message_text: string };
  };
  const textOfLastAnswer = () => answerOf(botCalls[0]).input_message_content.message_text;

  // ---- describeGuestUpdate ----

  await check('describeGuestUpdate: no string from the update leaks, in the summary or in its JSON', () => {
    const summary = describeGuestUpdate(guestUpdate(KNOWN, {}, 'he'), true, NOW);
    const json = JSON.stringify(summary);
    for (const secret of SENTINELS) assert(!json.includes(secret), `leaked ${secret}: ${json}`);
  });

  await check('describeGuestUpdate: key names, nested messages with text lengths, chat type, sender id, account flag and age', () => {
    const s = describeGuestUpdate(guestUpdate(KNOWN, {}, 'he'), true, NOW);
    assert(show(s.updateKeys) === show(['guest_message', 'update_id']), `updateKeys ${show(s.updateKeys)}`);
    const sorted = [...s.messageKeys].sort();
    assert(show(s.messageKeys) === show(sorted), `messageKeys not sorted: ${show(s.messageKeys)}`);
    assert(s.messageKeys.includes('guest_query_id') && s.messageKeys.includes('reply_to_message'), `messageKeys ${show(s.messageKeys)}`);
    const byPath = Object.fromEntries(s.nested.map(n => [n.path, n]));
    const reply = byPath['reply_to_message'];
    assert(reply && show(reply.keys) === show(['chat', 'date', 'from', 'message_id', 'reply_to_message', 'text']), `reply ${show(reply)}`);
    assert(reply.textLength === 'SECRET-REPLY-TEXT'.length, `reply length ${reply.textLength}`);
    assert(byPath['reply_to_message.reply_to_message']?.textLength === 'SECRET-REPLY-TEXT'.length, `deeper reply ${show(byPath['reply_to_message.reply_to_message'])}`);
    assert(byPath['external_reply'] && show(byPath['external_reply'].keys) === show(['chat', 'message_id', 'origin']), `external_reply ${show(byPath['external_reply'])}`);
    assert(byPath['quote']?.textLength === 'SECRET-QUOTE-TEXT'.length, `quote ${show(byPath['quote'])}`);
    assert(!('chat' in byPath) && !('from' in byPath) && !('entities' in byPath) && !('contact' in byPath), `a non-message listed: ${show(s.nested.map(n => n.path))}`);
    assert(s.chatType === 'supergroup', `chatType ${s.chatType}`);
    assert(s.fromId === KNOWN, `fromId ${s.fromId}`);
    assert(s.hasAccount === true && describeGuestUpdate(guestUpdate(STRANGER), false, NOW).hasAccount === false, 'hasAccount');
    assert(s.ageMs === 5000, `ageMs ${s.ageMs}`);
  });

  await check('describeGuestUpdate: a key that is not a schema name is not echoed, and a bad update is a summary, not a throw', () => {
    const odd = guestUpdate(KNOWN, { 'Zelda Quinn': 'SECRET-BODY-TEXT' });
    const json = JSON.stringify(describeGuestUpdate(odd, false, NOW));
    assert(!json.includes('Zelda Quinn'), `echoed: ${json}`);
    const empty = describeGuestUpdate(null, false, NOW);
    assert(show(empty.messageKeys) === '[]' && empty.chatType === null && empty.fromId === null && empty.ageMs === null, `empty ${show(empty)}`);
  });

  // ---- The webhook ----

  await check('guest_message: one [guest probe] line, no person-made string in the log, nothing else in the log leaks', async () => {
    const statuses = await send(guestUpdate(STRANGER, {}, 'he-IL'));
    assert(show(statuses) === '[200]', `statuses ${show(statuses)}`);
    assert(probeLines().length === 1, `${probeLines().length} probe lines: ${show(logs)}`);
    const all = logs.join('\n');
    for (const secret of SENTINELS) assert(!all.includes(secret), `leaked ${secret}`);
    const summary = JSON.parse(probeLines()[0].slice('[guest probe] '.length));
    assert(summary.fromId === STRANGER && summary.hasAccount === false && summary.chatType === 'supergroup', `summary ${show(summary)}`);
  });

  await check('guest_message: answered once through answerGuestQuery, the result JSON-serialized as an article', async () => {
    await send(guestUpdate(STRANGER, {}, 'he'));
    assert(botCalls.length === 1 && botCalls[0].method === 'answerGuestQuery', `bot calls ${show(botCalls)}`);
    assert(botCalls[0].form.guest_query_id === 'gq-1', `query id ${botCalls[0].form.guest_query_id}`);
    assert(typeof botCalls[0].form.result === 'string', `result is ${typeof botCalls[0].form.result}`);
    const answer = answerOf(botCalls[0]);
    assert(answer.type === 'article' && answer.id === 'probe', `answer ${show(answer)}`);
    assert(answer.title === heMessages.title && answer.input_message_content.message_text === heMessages.text, `texts ${show(answer)}`);
    assert(logs.some(l => /^\[guest probe\] answered in \d+ ms$/.test(l)), `no answered line: ${show(logs)}`);
  });

  await check('guest_message: the answer time is the time of the call', async () => {
    reset();
    botDelayMs = 40;
    const { res } = makeRes();
    await handleTelegramWebhook({ body: guestUpdate(STRANGER) }, res);
    const line = logs.find(l => l.startsWith('[guest probe] answered in '));
    const ms = Number(line?.match(/in (\d+) ms/)?.[1]);
    assert(ms >= 35 && ms < 2000, `answered line ${line}`);
  });

  await check('guest_message: no message handler, no payment handler, no user lookup beyond the gate, no account, no database', async () => {
    // A contrived update that would also match two other branches: the guest branch is first
    const update = { ...guestUpdate(STRANGER), pre_checkout_query: { id: 'q', from: { id: STRANGER } }, callback_query: { id: 'c', from: { id: STRANGER }, data: 'event_create:x', message: { chat: { id: 1 }, message_id: 2 } } };
    await send(update);
    assert(handlerCalls.length === 0, `handlers ran: ${show(handlerCalls)}`);
    assert(prismaCalls.length === 0, `database: ${show(prismaCalls)}`);
    assert(show(lookups) === show([STRANGER]), `lookups ${show(lookups)}`);
    assert(botCalls.length === 1, `bot calls ${show(botCalls)}`);
    assert(networkAttempts.length === 0, `network ${show(networkAttempts)}`);
  });

  await check('control: the same stubs do see a normal update (a pre-checkout query reaches its handler, no probe)', async () => {
    await send({ update_id: 1, pre_checkout_query: { id: 'q', from: { id: STRANGER } } });
    assert(show(handlerCalls) === show(['handlePreCheckoutQuery']), `handlers ${show(handlerCalls)}`);
    assert(probeLines().length === 0 && botCalls.length === 0, `probe ran: ${show(logs)}`);
  });

  await check('language: an account answers in its FamCal language, over Telegram\'s language_code', async () => {
    await send(guestUpdate(KNOWN, {}, 'ru'));
    assert(textOfLastAnswer() === heMessages.text, `got ${textOfLastAnswer()}`);
    await send(guestUpdate(KNOWN_RU, {}, 'he'));
    assert(textOfLastAnswer() === ruMessages.text, `got ${textOfLastAnswer()}`);
    const summary = JSON.parse(probeLines()[0].slice('[guest probe] '.length));
    assert(summary.hasAccount === true, `summary ${show(summary)}`);
  });

  await check('language: no account takes from.language_code (he, iw, ru, a region tag), anything else and none give English', async () => {
    const cases: Array<[string | undefined, string]> = [
      ['he', heMessages.text], ['he-IL', heMessages.text], ['iw', heMessages.text], ['ru', ruMessages.text], ['RU', ruMessages.text],
      ['en', enMessages.text], ['fr', enMessages.text], [undefined, enMessages.text],
    ];
    for (const [code, want] of cases) {
      await send(guestUpdate(STRANGER, {}, code));
      assert(textOfLastAnswer() === want, `language_code ${code}: got ${textOfLastAnswer()}`);
    }
    await send(guestUpdate(KNOWN_NO_LANG, {}, 'ru'));
    assert(textOfLastAnswer() === enMessages.text, `an account with no language: ${textOfLastAnswer()}`);
  });

  await check('the English text is the one the owner approved', () => {
    assert(enMessages.title === 'FamCal' && enMessages.text === 'FamCal got your message. Answers about your calendar are coming soon.', show(enMessages));
  });

  await check('moderation: a blocked caller is dropped before the probe (no line, no answer)', async () => {
    const statuses = await send(guestUpdate(BLOCKED, {}, 'he'));
    assert(show(statuses) === '[200]', `statuses ${show(statuses)}`);
    assert(probeLines().length === 0 && botCalls.length === 0, `probe ran: ${show(logs)} ${show(botCalls)}`);
    assert(logs.some(l => l.includes('[Moderation] Dropped Telegram update from blocked id')), `no drop line: ${show(logs)}`);
  });

  await check('moderation: a suspended caller is dropped before the probe', async () => {
    const statuses = await send(guestUpdate(SUSPENDED, {}, 'he'));
    assert(show(statuses) === '[200]', `statuses ${show(statuses)}`);
    assert(probeLines().length === 0 && botCalls.length === 0, `probe ran: ${show(logs)} ${show(botCalls)}`);
  });

  await check('a guest message with no guest_query_id is logged and not answered', async () => {
    const update = guestUpdate(STRANGER);
    delete (update.guest_message as Record<string, unknown>).guest_query_id;
    const statuses = await send(update);
    assert(show(statuses) === '[200]' && botCalls.length === 0, `statuses ${show(statuses)} calls ${show(botCalls)}`);
    assert(probeLines().length === 1 && logs.some(l => l.includes('no guest_query_id')), `logs ${show(logs)}`);
  });

  await check('a Telegram error: tried once, logged with the HTTP status and description, the webhook still answers 200', async () => {
    reset();
    botOutcome = 'telegram-error';
    const { statuses, res } = makeRes();
    await handleTelegramWebhook({ body: guestUpdate(STRANGER) }, res);
    assert(show(statuses) === '[200]', `statuses ${show(statuses)}`);
    assert(botCalls.length === 1, `${botCalls.length} tries`);
    assert(captured.length === 1 && captured[0].includes('HTTP 400 Bad Request: guest mode is off'), `captured ${show(captured)}`);
    assert(!logs.some(l => l.startsWith('[guest probe] answered')), `claims an answer: ${show(logs)}`);
    for (const secret of SENTINELS) assert(!logs.join('\n').includes(secret), `leaked ${secret}`);
  });

  await check('no answer from Telegram: tried once, logged without the error text, the webhook still answers 200', async () => {
    reset();
    botOutcome = 'no-answer';
    const { statuses, res } = makeRes();
    await handleTelegramWebhook({ body: guestUpdate(STRANGER) }, res);
    assert(show(statuses) === '[200]' && botCalls.length === 1, `statuses ${show(statuses)} tries ${botCalls.length}`);
    assert(captured.length === 1 && captured[0].includes('no answer (EFATAL)'), `captured ${show(captured)}`);
  });

  console.log = realLog;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.log = realLog;
  console.error('smoke crashed:', err);
  process.exit(1);
});
