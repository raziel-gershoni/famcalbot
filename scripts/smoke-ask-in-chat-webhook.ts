// Smoke test for routing a Guest Mode update (handleTelegramWebhook, src/services/webhook-handlers.ts; spec
// docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §3):
//   - a guest_message goes to handleGuestMessage once, with the message and the account the gate looked up by the
//     sender's telegramId (null for a stranger), before every other dispatch: no message, payment or callback handler,
//     no account made, no database, and the breadcrumb says guest_message;
//   - a blocked or suspended caller is dropped by the moderation gate first;
//   - a guest message never clears the unreachable flag (it proves nothing about the person's own chat);
//   - a normal update still reaches its handler and never the guest handler.
// Faked: the guest handler, the bot, the user lookup, Prisma, Redis, the moderation lists, analytics and error capture.
// The webhook handler is the real one. No network, no database.
//
//   npx tsx scripts/smoke-ask-in-chat-webhook.ts

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

process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

const realLog = console.log;
let logs: string[] = [];
const capture = (...args: unknown[]) => { logs.push(args.map(a => (typeof a === 'string' ? a : show(a))).join(' ')); };
console.log = capture;
console.warn = capture;
console.error = capture;
console.info = capture;

let handlerCalls: string[] = [];
const record = (name: string) => async () => { handlerCalls.push(name); };
let guestCalls: Array<{ message: unknown; user: UserConfig | null }> = [];
let breadcrumbs: Array<Record<string, unknown>> = [];
let reachabilityCleared: number[] = [];

const KNOWN = 4001;
const BLOCKED = 4004;
const SUSPENDED = 4005;
const UNREACHABLE = 4006;
const STRANGER = 4009;

function makeUser(id: number, telegramId: number, extra: Record<string, unknown> = {}): UserConfig {
  return { id, telegramId, language: 'en', suspendedAt: null, unreachableSince: null, ...extra } as unknown as UserConfig;
}
const USERS: Record<number, UserConfig> = {
  [KNOWN]: makeUser(1, KNOWN),
  [SUSPENDED]: makeUser(5, SUSPENDED, { suspendedAt: new Date('2026-01-01T00:00:00Z') }),
  [UNREACHABLE]: makeUser(6, UNREACHABLE, { unreachableSince: new Date('2026-01-01T00:00:00Z') }),
};
let lookups: number[] = [];

const prismaCalls: string[] = [];
const fakePrisma: unknown = new Proxy(() => undefined, {
  get: (_t, prop) => new Proxy(() => undefined, {
    get: (_t2, prop2) => (...args: unknown[]) => { prismaCalls.push(`${String(prop)}.${String(prop2)}(${args.length})`); return Promise.resolve(null); },
  }),
});

function reset() {
  logs = [];
  handlerCalls = [];
  guestCalls = [];
  breadcrumbs = [];
  reachabilityCleared = [];
  lookups = [];
  prismaCalls.length = 0;
}

const guestUpdate = (fromId: number) => ({
  update_id: 900,
  guest_message: {
    message_id: 77,
    guest_query_id: 'gq-1',
    date: 1_800_000_000,
    chat: { id: -100, type: 'supergroup' },
    from: { id: fromId, is_bot: false, first_name: 'Someone' },
    text: '@famcal_bot Friday?',
    entities: [{ type: 'mention', offset: 0, length: 11 }],
  },
});

function makeRes() {
  const statuses: number[] = [];
  return { statuses, res: { status: (code: number) => { statuses.push(code); return { json: () => {} }; } } };
}

async function main() {
  const Mod = Module as unknown as { new (id: string): { filename: string; loaded: boolean; exports: unknown }; _cache: Record<string, unknown> };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Mod(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Mod._cache[filename] = mod;
  };
  const telegram = {
    getBot: () => ({ sendMessage: record('bot.sendMessage') }),
    getMessagingService: () => ({ sendMessage: record('messaging.sendMessage') }),
    handleStartCommand: record('handleStartCommand'),
    handleSummaryCommand: record('handleSummaryCommand'),
    handleWeatherCommand: record('handleWeatherCommand'),
    handleFeedbackCommand: record('handleFeedbackCommand'),
    handleSupportCommand: record('handleSupportCommand'),
    handleConnectCommand: record('handleConnectCommand'),
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('utils/redis.ts', { redis: {} });
  stub('services/telegram/bot.ts', telegram);
  stub('services/telegram/index.ts', telegram);
  stub('services/ask-in-chat/handler.ts', {
    handleGuestMessage: async (message: unknown, user: UserConfig | null) => { guestCalls.push({ message, user }); },
  });
  stub('services/user-service.ts', {
    getUserByTelegramId: async (telegramId: number | bigint) => { lookups.push(Number(telegramId)); return USERS[Number(telegramId)] ?? null; },
    getUserByWhatsAppPhone: record('getUserByWhatsAppPhone'),
    getOrCreateUserByWhatsApp: record('getOrCreateUserByWhatsApp'),
    createAccount: record('createAccount'),
  });
  stub('lib/user-reachability.ts', { clearUserUnreachable: async (id: number) => { reachabilityCleared.push(id); } });
  stub('lib/error-capture.ts', { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} });
  stub('services/analytics-service.ts', {
    trackActivityAsync: () => {},
    setUserContext: () => {},
    addBreadcrumb: (_message: string, data: Record<string, unknown>) => { breadcrumbs.push(data); },
  });
  stub('services/voice/index.ts', {
    handleVoiceMessage: record('handleVoiceMessage'),
    handleEventCallback: record('handleEventCallback'),
    handleEditCallback: record('handleEditCallback'),
    handleDeleteCallback: record('handleDeleteCallback'),
  });
  stub('services/voice/speech-presence.ts', { NO_SPEECH: 'no_speech' });
  stub('services/payment-handler.ts', { handlePreCheckoutQuery: record('handlePreCheckoutQuery'), handleSuccessfulPayment: record('handleSuccessfulPayment') });
  stub('lib/user-moderation.ts', {
    isIdentifierBlocked: async (args: { telegramId?: number }) => args.telegramId === BLOCKED,
    isUserSuspended: (user: { suspendedAt?: Date | null }) => Boolean(user.suspendedAt),
  });

  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');
  const send = async (update: Record<string, unknown>) => {
    reset();
    const { statuses, res } = makeRes();
    await handleTelegramWebhook({ body: update }, res);
    return statuses;
  };

  await check('a guest message from an account goes to handleGuestMessage once, with the message and the gate\'s account', async () => {
    const update = guestUpdate(KNOWN);
    const statuses = await send(update);
    assert(show(statuses) === '[200]', `statuses ${show(statuses)}`);
    assert(guestCalls.length === 1 && guestCalls[0].message === update.guest_message && guestCalls[0].user === USERS[KNOWN], show(guestCalls));
    assert(show(lookups) === show([KNOWN]), `lookups ${show(lookups)}`);
    assert(breadcrumbs.length === 1 && breadcrumbs[0].type === 'guest_message', show(breadcrumbs));
  });

  await check('a stranger\'s guest message goes to handleGuestMessage with no account, and none is made', async () => {
    await send(guestUpdate(STRANGER));
    assert(guestCalls.length === 1 && guestCalls[0].user === null, show(guestCalls));
    assert(!handlerCalls.includes('createAccount'), show(handlerCalls));
  });

  await check('the guest branch comes before every other dispatch: no message, payment or callback handler, no database, no network', async () => {
    const update = { ...guestUpdate(STRANGER), pre_checkout_query: { id: 'q', from: { id: STRANGER } }, callback_query: { id: 'c', from: { id: STRANGER }, data: 'event_create:x', message: { chat: { id: 1 }, message_id: 2 } } };
    await send(update);
    assert(guestCalls.length === 1 && handlerCalls.length === 0, `handlers ${show(handlerCalls)}`);
    assert(prismaCalls.length === 0 && networkAttempts.length === 0, `database ${show(prismaCalls)} network ${show(networkAttempts)}`);
  });

  await check('a blocked caller and a suspended one are dropped by the gate before the guest handler', async () => {
    assert(show(await send(guestUpdate(BLOCKED))) === '[200]' && guestCalls.length === 0, `blocked ${show(guestCalls)}`);
    assert(logs.some(l => l.includes('[Moderation] Dropped Telegram update from blocked id')), show(logs));
    assert(show(await send(guestUpdate(SUSPENDED))) === '[200]' && guestCalls.length === 0, `suspended ${show(guestCalls)}`);
  });

  await check('a guest message never clears the unreachable flag', async () => {
    await send(guestUpdate(UNREACHABLE));
    assert(guestCalls.length === 1 && reachabilityCleared.length === 0, `cleared ${show(reachabilityCleared)}`);
  });

  await check('control: a pre-checkout query reaches its handler and never the guest handler', async () => {
    await send({ update_id: 1, pre_checkout_query: { id: 'q', from: { id: STRANGER } } });
    assert(show(handlerCalls) === show(['handlePreCheckoutQuery']) && guestCalls.length === 0, show({ handlerCalls, guestCalls }));
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
