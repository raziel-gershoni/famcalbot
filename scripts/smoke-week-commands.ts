// Smoke test for /week and /nextweek's answers to Google's failures (calendar home spec
// §3.1 step 5, Ruling R14): src/services/telegram/commands.ts. With the calendar home's
// switch on, the week reads through the shared reader, which throws GOOGLE_TOKEN_EXPIRED,
// GOOGLE_INSUFFICIENT_SCOPES or GOOGLE_FETCH_FAILED. Before, both commands sent those to
// the pipeline's "error fetching upcoming events" text and paged the admin per user.
// Now a dead token and missing permissions get the on-demand daily summary's answers
// (missing permissions also clear the token), and an outage gets "couldn't reach Google
// Calendar", as HTML like the daily's, into the open draft when there is one, with no
// admin notice. Anything else
// still gets the pipeline's text and the admin notice (A-28).
//
// Drives the real handleLookaheadCommand and handleNextWeekCommand through the real
// executeCommand and the real bot texts. The lookahead itself (what the reader throws is
// scripts/smoke-week-lookahead.ts's), the user lookup, the AI, delivery, voice, quota,
// analytics, the admin notifier and both messaging services are faked. No network.
//
// Run under both clocks:
//   TZ=UTC npx tsx scripts/smoke-week-commands.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-week-commands.ts

import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageFormat, MessagingPlatform } from '../src/services/messaging/types';
import type { IMessagingService, MessageOptions, StreamMessageHandle } from '../src/services/messaging/types';
import type { UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
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

function assertList(got: string[], want: string[]) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

// ---- The bot's own texts, read from the message files the bot reads ----

type BotTexts = {
  errors: Record<string, string>;
  tokenExpired: { title: string; message: string };
  insufficientScopes: { title: string; message: string };
};
const ROOT = path.resolve(__dirname, '..');
const botTexts = (lang: string): BotTexts =>
  (JSON.parse(readFileSync(path.join(ROOT, 'messages', `${lang}.json`), 'utf8')) as { bot: BotTexts }).bot;
const EN = botTexts('en');
const HE = botTexts('he');
const TOKEN_TEXT = `${EN.tokenExpired.title}\n\n${EN.tokenExpired.message}`;
const SCOPES_TEXT = `${EN.insufficientScopes.title}\n\n${EN.insufficientScopes.message}`;

// ---- Fixtures ----

const TG_CHAT = 7021;
const WA_CHAT = '972500000021';

function makeUser(extra: Partial<UserConfig> = {}): UserConfig {
  return {
    id: 21, telegramId: TG_CHAT, name: 'Dana', englishName: 'Dana', gender: 'female', language: 'en', culture: 'jewish',
    location: 'Tel Aviv', isAdmin: true, suspendedAt: null, voiceSummaryEnabled: false,
    calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-21',
    calendarAssignments: [{ calendarId: 'dana@example.com', labels: ['primary'], name: 'Dana', color: '#000' }],
    ...extra,
  } as unknown as UserConfig;
}
let user: UserConfig = makeUser();

// ---- Fakes ----

/** Everything the user is sent, in order, by service. */
let sent: string[] = [];
function makeService(platform: string): IMessagingService {
  return {
    sendMessage: async (chatId: number | string, text: string, options?: MessageOptions) => {
      sent.push(`${platform}.sendMessage ${chatId}${options?.format === MessageFormat.HTML ? ' html' : ''}: ${text}`);
      return 1;
    },
    sendTypingIndicator: async () => undefined,
  } as unknown as IMessagingService;
}
const telegram = makeService('telegram');
const whatsapp = makeService('whatsapp');

/** A streaming draft as execute-command opens one for /week on Telegram. */
function makeDraft(): StreamMessageHandle {
  return {
    pushStage: () => undefined,
    pushDelta: () => undefined,
    finalize: async (text: string) => {
      sent.push(`draft.finalize: ${text}`);
      return 1;
    },
    cancel: async (text: string, options?: MessageOptions) => {
      sent.push(`draft.cancel${options?.format === MessageFormat.HTML ? ' html' : ''}: ${text}`);
    },
  };
}

/** What the next lookahead throws; unset, it answers with one event. */
let lookaheadError: Error | undefined;
/** The gap the next lookahead's read reports ("Google as a connection": FamCal kept without Google). */
let lookaheadGap: string | undefined;
const lookaheadCalls: string[] = [];
const lookahead = (kind: string) => async () => {
  lookaheadCalls.push(kind);
  if (lookaheadError) throw lookaheadError;
  return {
    events: [{ summary: 'Book fair' }], dateRange: { start: new Date(), end: new Date() }, timezone: 'Asia/Jerusalem',
    ...(lookaheadGap ? { googleGap: lookaheadGap } : {}),
  };
};
const codeError = (code: string) => new Error(code);
const outage = () => Object.assign(new Error('GOOGLE_FETCH_FAILED'), { day: '2026-10-13' });

let adminWarnings: string[] = [];
let adminErrors: string[] = [];
let tokensCleared: string[] = [];
let deliveries: string[] = [];
/** Every activity row the commands write: "<action> <json metadata>". */
let tracked: string[] = [];
/** The features the plan has run out of. */
let exhausted = new Set<string>();
/** The plan checks the commands made. */
let featureChecks: string[] = [];

const SRC = path.join(ROOT, 'src');
const stubs: Record<string, Record<string, unknown>> = {
  [`${SRC}/services/user-service.ts`]: {
    getUserByIdentifier: async () => user,
    getUserByTelegramId: async () => user,
    getOrCreateUser: async () => user,
    // A tripwire: missing permissions keep the token now (a cleared one made stale Google choices)
    clearGoogleRefreshToken: async (telegramId: number | bigint) => { tokensCleared.push(String(telegramId)); },
  },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform, MessageFormat,
    getMessagingService: (platform: MessagingPlatform) => (platform === MessagingPlatform.WHATSAPP ? whatsapp : telegram),
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/telegram/voice.ts`]: { sendVoiceMessage: async () => undefined, sendWeeklyVoiceMessage: async () => undefined },
  [`${SRC}/services/telegram/summary.ts`]: {
    sendDailySummaryToUser: async () => undefined,
    sendTomorrowSummaryToUser: async () => undefined,
    routeTextMessage: async (_chatId: unknown, text: string) => { deliveries.push(text); },
  },
  // google-read-errors.ts is deliberately NOT stubbed: the real shared answers run.
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (_userId: number, action: string, meta?: object) => { tracked.push(`${action} ${JSON.stringify(meta ?? {})}`); },
    addBreadcrumb: () => undefined,
  },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async (_userId: number, feature: string) => { featureChecks.push(feature); return { allowed: !exhausted.has(feature) }; },
    incrementUsage: async () => undefined,
  },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => undefined, captureWarning: () => undefined, captureInfo: () => undefined },
  [`${SRC}/utils/prisma.ts`]: { prisma: {} },
  [`${SRC}/utils/redis.ts`]: { redis: { get: async () => null, set: async () => 'OK', del: async () => 0 } },
  [`${SRC}/services/magic-link.ts`]: { generateMagicLink: async () => 'https://famcal.test/magic' },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async (title: string, message: string) => { adminWarnings.push(`${title}: ${message}`); },
    notifyAdminError: async (commandName: string) => { adminErrors.push(commandName); },
  },
  [`${SRC}/services/week-lookahead.ts`]: {
    getWeekLookahead: lookahead('week'),
    getNextWeekLookahead: lookahead('nextweek'),
  },
  [`${SRC}/services/calendar-provider/index.ts`]: { getCalendarAssignmentsForUser: async (u: UserConfig) => u.calendarAssignments ?? [] },
  [`${SRC}/services/claude.ts`]: {
    generateWeekLookahead: async () => 'This week: the book fair on Friday.',
    generateNextWeekSummary: async () => 'Next week: the book fair on Friday.',
  },
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts).
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
// commands.ts loads the lookahead, the AI, the calendars, the magic link and the notifier
// with import(), which goes through the ES module loader instead; it gets the same stub.
(globalThis as { weekSmokeStubs?: typeof stubs }).weekSmokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake[${JSON.stringify(name)}];`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.weekSmokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Running one command ----

type Command = 'week' | 'nextweek';

async function run(command: Command, opts: { error?: Error; gap?: string; platform?: MessagingPlatform; draft?: boolean; user?: UserConfig; exhausted?: string[] } = {}) {
  const { handleLookaheadCommand, handleNextWeekCommand } = await import('../src/services/telegram/commands');
  sent = [];
  adminWarnings = [];
  adminErrors = [];
  tokensCleared = [];
  deliveries = [];
  tracked = [];
  featureChecks = [];
  lookaheadCalls.length = 0;
  lookaheadError = opts.error;
  exhausted = new Set(opts.exhausted ?? []);
  lookaheadGap = opts.gap;
  user = opts.user ?? makeUser();
  const platform = opts.platform ?? MessagingPlatform.TELEGRAM;
  const chatId = platform === MessagingPlatform.WHATSAPP ? WA_CHAT : TG_CHAT;
  const handler = command === 'week' ? handleLookaheadCommand : handleNextWeekCommand;
  await handler(chatId, chatId, platform, opts.draft ? makeDraft() : undefined);
  assertList(lookaheadCalls, exhausted.has('text_summary') ? [] : [command]);
}

/** What one run left behind, one line per kind. */
const outcome = () => [
  ...sent,
  `admin warnings: ${adminWarnings.join(' | ') || 'none'}`,
  `admin errors: ${adminErrors.join(' | ') || 'none'}`,
  `tokens cleared: ${tokensCleared.join(', ') || 'none'}`,
];

async function main() {
  // The pipeline logs each error it handles; those lines are expected.
  const realError = console.error;
  console.error = () => undefined;

  await check('a week that loads is delivered as before, /week and /nextweek', async () => {
    await run('week', { draft: true });
    const week = [...deliveries, ...outcome()];
    await run('nextweek');
    assertList([...week, ...deliveries, ...outcome()], [
      'This week: the book fair on Friday.', 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
      'Next week: the book fair on Friday.', 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('B2 a week or next week that loads writes one command_completed row with the command name and platform; a failed one writes user_error_shown instead', async () => {
    await run('week');
    const week = [...tracked];
    await run('nextweek', { platform: MessagingPlatform.WHATSAPP, user: makeUser({ telegramId: null }) });
    const nextweek = [...tracked];
    await run('week', { error: new Error('boom') });
    const failed = [...tracked];
    assertList([...week, '--', ...nextweek, '--', ...failed], [
      'command_completed {"command":"lookahead","platform":"telegram"}', '--',
      'command_completed {"command":"nextweek","platform":"whatsapp"}', '--',
      'user_error_shown {"error_type":"lookaheadFetch","command":"Lookahead Command"}',
    ]);
  });

  await check('B4 /lookahead and /nextweek check the text-summary quota like /weather: out of it, the limit message of /weather (Telegram and WhatsApp), nothing fetched, no completed row', async () => {
    // The text /weather sends (bot.subscription has no textLimitReached key, so it is the code's own English line).
    const limit = { textLimitReached: "You've reached your monthly text summary limit. Upgrade to continue!" };
    for (const command of ['week', 'nextweek'] as const) {
      for (const platform of [MessagingPlatform.TELEGRAM, MessagingPlatform.WHATSAPP]) {
        await run(command, { exhausted: ['text_summary'], platform, user: platform === MessagingPlatform.WHATSAPP ? makeUser({ telegramId: null }) : undefined });
        const chat = platform === MessagingPlatform.WHATSAPP ? WA_CHAT : TG_CHAT;
        assertList(sent, [`${platform === MessagingPlatform.WHATSAPP ? 'whatsapp' : 'telegram'}.sendMessage ${chat} html: ${limit.textLimitReached}`]);
        assertList(featureChecks, ['text_summary']);
        assertList(tracked, []);
        assertList(deliveries, []);
      }
    }
    // Within the quota they run as before.
    await run('week');
    assertList(featureChecks, ['text_summary']);
    assertList(deliveries, ['This week: the book fair on Friday.']);
  });

  await check('/week, a dead token: the daily summary\'s token text and admin warning, no admin error', async () => {
    await run('week', { error: codeError('GOOGLE_TOKEN_EXPIRED') });
    assertList(outcome(), [
      `telegram.sendMessage ${TG_CHAT} html: ${TOKEN_TEXT}`,
      'admin warnings: Token Expired: User 21 needs to refresh their Google Calendar token',
      'admin errors: none',
      'tokens cleared: none',
    ]);
  });

  await check('/week, a dead token or missing permissions, with an open draft: the draft turns into the answer, so no stage message stays behind', async () => {
    await run('week', { error: codeError('GOOGLE_TOKEN_EXPIRED'), draft: true });
    const expired = outcome();
    await run('week', { error: codeError('GOOGLE_INSUFFICIENT_SCOPES'), draft: true });
    const scopes = outcome();
    assertList([...expired, ...scopes], [
      `draft.cancel html: ${TOKEN_TEXT}`,
      'admin warnings: Token Expired: User 21 needs to refresh their Google Calendar token', 'admin errors: none', 'tokens cleared: none',
      `draft.cancel html: ${SCOPES_TEXT}`,
      'admin warnings: Insufficient Scopes: User 21 has a token with insufficient scopes. Token kept, awaiting re-authorization.',
      'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('/week, missing permissions: the permissions text, the token kept, an admin warning', async () => {
    await run('week', { error: codeError('GOOGLE_INSUFFICIENT_SCOPES') });
    const telegramUser = outcome();
    await run('week', { error: codeError('GOOGLE_INSUFFICIENT_SCOPES'), platform: MessagingPlatform.WHATSAPP, user: makeUser({ telegramId: null }) });
    const warning = 'admin warnings: Insufficient Scopes: User 21 has a token with insufficient scopes. Token kept, awaiting re-authorization.';
    assertList([...telegramUser, ...outcome()], [
      `telegram.sendMessage ${TG_CHAT} html: ${SCOPES_TEXT}`, warning, 'admin errors: none', 'tokens cleared: none',
      `whatsapp.sendMessage ${WA_CHAT} html: ${SCOPES_TEXT}`, warning, 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('/week, Google unreachable: "couldn\'t reach Google Calendar" in the user\'s language, as HTML, into the draft or as a message, no admin notice', async () => {
    assert(typeof EN.errors.googleUnreachable === 'string' && EN.errors.googleUnreachable.length > 0, 'bot.errors.googleUnreachable is missing in en.json');
    assert(typeof HE.errors.googleUnreachable === 'string' && HE.errors.googleUnreachable !== EN.errors.googleUnreachable, 'bot.errors.googleUnreachable is not translated in he.json');
    // It goes out as HTML here and from the daily summary alike, so no language may hold a raw & or <.
    const unsafe = ['en', 'he', 'ru'].filter(lang => /[&<>]/.test(botTexts(lang).errors.googleUnreachable));
    assert(unsafe.length === 0, `bot.errors.googleUnreachable is not HTML-safe in ${unsafe.join(', ')}`);
    await run('week', { error: outage(), draft: true });
    const draft = outcome();
    await run('week', { error: outage(), platform: MessagingPlatform.WHATSAPP, user: makeUser({ language: 'he' }) });
    assertList([...draft, ...outcome()], [
      `draft.cancel html: ${EN.errors.googleUnreachable}`, 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
      `whatsapp.sendMessage ${WA_CHAT} html: ${HE.errors.googleUnreachable}`, 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('/nextweek: the same three answers', async () => {
    const got: string[] = [];
    for (const error of [codeError('GOOGLE_TOKEN_EXPIRED'), codeError('GOOGLE_INSUFFICIENT_SCOPES'), outage()]) {
      await run('nextweek', { error });
      got.push(...outcome());
    }
    assertList(got, [
      `telegram.sendMessage ${TG_CHAT} html: ${TOKEN_TEXT}`,
      'admin warnings: Token Expired: User 21 needs to refresh their Google Calendar token', 'admin errors: none', 'tokens cleared: none',
      `telegram.sendMessage ${TG_CHAT} html: ${SCOPES_TEXT}`,
      'admin warnings: Insufficient Scopes: User 21 has a token with insufficient scopes. Token kept, awaiting re-authorization.',
      'admin errors: none', 'tokens cleared: none',
      `telegram.sendMessage ${TG_CHAT} html: ${EN.errors.googleUnreachable}`, 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('G2: a week that kept FamCal without Google is delivered, then the dead-token or outage answer, /week and /nextweek', async () => {
    await run('week', { gap: 'token' });
    const week = [...deliveries, ...outcome()];
    await run('nextweek', { gap: 'unavailable' });
    assertList([...week, ...deliveries, ...outcome()], [
      'This week: the book fair on Friday.',
      `telegram.sendMessage ${TG_CHAT} html: ${TOKEN_TEXT}`,
      'admin warnings: Token Expired: User 21 needs to refresh their Google Calendar token', 'admin errors: none', 'tokens cleared: none',
      'Next week: the book fair on Friday.',
      `telegram.sendMessage ${TG_CHAT} html: ${EN.errors.googleUnreachable}`, 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('any other failure still gets the pipeline\'s text and the admin notice (A-28)', async () => {
    const dbDown = () => new Error("Can't reach database server");
    await run('week', { error: dbDown() });
    const week = outcome();
    await run('nextweek', { error: dbDown(), draft: true });
    assertList([...week, ...outcome()], [
      `telegram.sendMessage ${TG_CHAT}: ${EN.errors.lookaheadFetch}`, 'admin warnings: none', 'admin errors: Lookahead Command', 'tokens cleared: none',
      `draft.cancel: ${EN.errors.nextWeekFetch}`, 'admin warnings: none', 'admin errors: Next Week Command', 'tokens cleared: none',
    ]);
  });

  console.error = realError;

  await check('no network, no unhandled rejection', () => {
    assert(networkAttempts.length === 0, `network: ${networkAttempts.join(', ')}`);
    assert(unhandled.length === 0, `unhandled: ${unhandled.map(String).join(' | ')}`);
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
