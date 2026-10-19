// Smoke test for the scheduled summaries' Google retry (calendar home spec §3.1 step 6,
// deliberate change C5): sendSummaryToAll in src/services/telegram/summary.ts, run through
// sendDailySummaryToAll and sendTomorrowSummaryToAll.
//
// For a user the rollout switch covers, a summary whose Google read fails
// (GOOGLE_FETCH_FAILED from the digest adapter) is set aside and the batch moves on. After
// the loop the run waits until 30 s have passed since the first such failure, then retries
// each set-aside user once, in order, on the first attempt's day with a 15 s deadline. Only
// a second outage sends the summary without Google: the prompt gets the outage guideline,
// the text and the voice note get the outage line, and the dedup mark is set. Any other
// error on the retry goes the way it always went: a dead token gets the token text with
// the refresh button and no dedup mark (A-24), missing scopes are Sentry only (A-25).
// Users the switch doesn't cover read through their provider and are never retried (A-33);
// they go first, so none of them waits on a covered user's Google read.
//
// Also: Sentry hears once per batch how many users were set aside (a deploy during the
// wait would drop them); the retry's dedup marks carry the batch's date, so a 23:00
// tomorrow summary retried past midnight doesn't skip the next evening's; a switch turned
// back during the wait sends today's summary; the daily run's reminder-cache sync runs
// beside the batch, not after its retries; the batch logs its total time.
//
// The real summary.ts, digest adapter, rollout switch, claude.ts prompt builder, bot
// messages, summary scheduling and the cron's daily handler run. Faked: the reader's
// readRange, the clock and the retry's sleep, Redis (in memory), the database, the users,
// the AI, Telegram, the voice note, the quota, the reminder cache, error capture and the
// admin notifier. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-summary-retry.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-summary-retry.ts

import Module from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { RangeRead, ReadItem, ReadRangeOptions } from '../src/services/calendar-read/types';
import type { AICompletionResult } from '../src/services/ai-provider';
import enMessages from '../messages/en.json';
import heMessages from '../messages/he.json';

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

function assertList(got: readonly string[], want: readonly string[], what: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${what}\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const IL = 'Asia/Jerusalem';
/** Wall-clock time in Israel, as epoch ms. */
const il = (local: string) => fromZonedTime(local, IL).getTime();

let clock = 0;
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = ClockDate as unknown as DateConstructor;

/** How long each calendar read and each provider fetch takes on the smoke's clock. */
let readMs = 2_000;

// ---- What happened, in order: reads, sends, waits, dedup marks, admin notices ----

let log: string[] = [];
let sleeps: number[] = [];
type Sent = { name: string; text: string; button?: string };
let sent: Sent[] = [];
let voices: { name: string; text: string }[] = [];
let prompts: { name: string; prompt: string }[] = [];
let captured: { context: string; severity: string; message: string }[] = [];
let tokensCleared: number[] = [];
/** The batch's own "[Batch Summary] … done:" log lines. */
let batchLines: string[] = [];
/** What the next retry wait does besides moving the clock: turn the switch, wait for the housekeeping. */
let onSleep: () => void | Promise<void> = () => {};

// ---- Users: every switch-covered one is an admin, as under ADMINS ----

const cal = (calendarId: string, name: string): CalendarAssignment => ({ calendarId, labels: ['yours'], name, color: '#039BE5' });

function person(id: number, name: string, over: Record<string, unknown>): UserConfig {
  return {
    id, telegramId: 1000 + id, name, englishName: name, gender: 'female', language: 'en', culture: 'default',
    location: '', weatherEnabled: false, textSummaryEnabled: true, voiceSummaryEnabled: true, messagingPlatform: 'telegram',
    isAdmin: true, suspendedAt: null, unreachableSince: null, globalRules: [], includeLookaheadInTomorrow: false,
    preferredMorningHour: 7, preferredEveningHour: 19, dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
    ...over,
  } as unknown as UserConfig;
}
const google = (id: number, name: string, over: Record<string, unknown> = {}) =>
  person(id, name, { calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token', calendarAssignments: [cal(`${name.toLowerCase()}@gmail.com`, name)], ...over });

const NOA = google(11, 'Noa');
const YAEL = google(12, 'Yael', { language: 'he' });
const DANA = person(13, 'Dana', { calendarSource: 'NATIVE', googleRefreshToken: '' });
const OMER = google(14, 'Omer');
/** Not an admin: the switch (ADMINS) doesn't cover him, so he reads through the provider. */
const ITAI = google(15, 'Itai', { isAdmin: false });
/** Her tomorrow summary comes at 23:00. */
const LIOR = google(16, 'Lior', { preferredEveningHour: 23 });
const EVERYONE = [NOA, YAEL, DANA, OMER, ITAI, LIOR];
const nameOf = (chatId: unknown) => EVERYONE.find(u => u.telegramId === Number(chatId))?.name ?? `chat ${String(chatId)}`;

let batch: UserConfig[] = [];

// ---- The reader: each user's planned outcomes, one per readRange call ----

type Outcome = 'ok' | 'empty' | 'fail' | 'token' | 'scopes' | 'boom';
let plans = new Map<number, Outcome[]>();

function item(user: UserConfig, event: CalendarEvent): ReadItem {
  const source = user.calendarSource === 'NATIVE' ? 'famcal' : 'google';
  return {
    source, key: `${source}|${event.summary}`, event: { ...event, provider: source === 'famcal' ? 'native' : 'google' },
    calendar: { id: event.calendarId, source, name: event.calendarName, color: null, mine: true, inLegend: true },
    title: event.summary, kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null,
  };
}

/** One event at 10:00-11:00 on `day`, on the user's own calendar. */
function dentist(user: UserConfig, day: string): CalendarEvent {
  const calendarId = user.calendarSource === 'NATIVE' ? 'native:cal-dana' : user.calendarAssignments![0].calendarId;
  return {
    summary: `Dentist (${user.name})`, start: new RealDate(il(`${day} 10:00:00`)).toISOString(), end: new RealDate(il(`${day} 11:00:00`)).toISOString(),
    calendarId, calendarName: user.name,
  };
}

/** While set, every read waits for it (a stalled Google): how many wait at once is the batch's concurrency. */
let hold: Promise<void> | null = null;
let readsHeld = 0;
let peakHeld = 0;

async function readRange(user: UserConfig, fromKey: string, toKey: string, opts: ReadRangeOptions): Promise<RangeRead> {
  log.push(`read ${user.name} ${fromKey}..${toKey} ${opts.deadlineMs}`);
  if (hold) {
    peakHeld = Math.max(peakHeld, ++readsHeld);
    await hold;
    readsHeld--;
  }
  clock += readMs;
  const outcome = plans.get(user.id)?.shift();
  if (!outcome) throw new Error(`unplanned read for ${user.name}`);
  if (outcome === 'boom') throw new Error(`the read for ${user.name} broke`);
  const window = { from: new RealDate(il(`${fromKey} 00:00:00`)), to: new RealDate(il(`${toKey} 00:00:00`)) };
  const items = outcome === 'ok' ? [item(user, dentist(user, fromKey))] : [];
  if (user.calendarSource === 'NATIVE') {
    return { window, items, famcal: { status: 'ok', ctx: { viewerId: user.id, partner: null }, calendars: [], partner: null } };
  }
  const read: RangeRead['google'] =
    outcome === 'fail' ? { status: 'error', reason: 'transient', cause: new Error('rateLimitExceeded') }
    : outcome === 'token' ? { status: 'reconnect', reason: 'token' }
    : outcome === 'scopes' ? { status: 'reconnect', reason: 'scopes' }
    : { status: 'ok', calendars: [], goneIds: [], partial: null, stale: false };
  return { window, items, google: read };
}

/** The switch as the fake Redis holds it: ADMINS unless a check turns it. */
const rolloutNow = () => store.get('chome:rollout') ?? 'ADMINS';

/** The provider that users the switch doesn't cover read through. */
let providerFailure: Error | null = null;
const legacyFetch = (kind: string) => async (user: UserConfig, _ids: string[], tz?: string) => {
  log.push(`provider ${user.name} ${kind}`);
  clock += readMs;
  if (user.isAdmin && rolloutNow() !== 'OFF') throw new Error(`a switch-covered user (${user.name}) read through the provider`);
  if (providerFailure) throw providerFailure;
  return [dentist(user, new RealDate(clock).toLocaleDateString('en-CA', { timeZone: tz ?? IL }))];
};

// ---- Redis, in memory: the dedup marks and the rollout switch ----

const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => store.get(key) ?? (key === 'chome:rollout' ? 'ADMINS' : null),
  set: async (key: string, value: unknown) => {
    if (key.startsWith('summary:dedup:')) {
      const [, , type, userId, date] = key.split(':');
      log.push(`mark ${nameOf(1000 + Number(userId))} ${type} ${date}`);
    }
    store.set(key, String(value));
    return 'OK';
  },
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

// ---- Telegram and the voice note ----

let nextMessageId = 1;
const telegram = {
  sendMessage: async (chatId: number | string, text: string, options?: { replyMarkup?: { inline_keyboard?: { web_app?: { url: string } }[][] } }) => {
    const button = options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url;
    const kind = button?.includes('/refresh-token') ? 'token' : 'summary';
    log.push(`send ${nameOf(chatId)} ${kind}`);
    sent.push({ name: nameOf(chatId), text, ...(button ? { button } : {}) });
    return nextMessageId++;
  },
  updateMessage: async () => {},
  deleteMessage: async () => {},
};

/** The AI: records each prompt under the user it names, and answers with that name. */
async function generateAICompletion(prompt: string): Promise<AICompletionResult> {
  const named = EVERYONE.filter(u => prompt.includes(u.name));
  const name = named.length === 1 ? named[0].name : `?${named.map(u => u.name).join('/')}`;
  prompts.push({ name, prompt });
  return { text: `Summary for ${name}`, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', model: 'fake-model', durationMs: 0 };
}

// ---- Stubs: static imports go through Module._load, import() through the ES module hooks ----

type SummaryModule = typeof import('../src/services/telegram/summary');
let loadedSummary: SummaryModule | undefined;
const summaryModule = (): SummaryModule => {
  if (!loadedSummary) throw new Error('summary.ts is not loaded yet');
  return loadedSummary;
};

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  [`${SRC}/services/calendar-read/index.ts`]: {
    readRange,
    sourcesFor: (u: UserConfig) => (u.calendarSource === 'NATIVE' ? ['famcal'] : ['google']),
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: () => ({ fetchTodayEvents: legacyFetch('today'), fetchTomorrowEvents: legacyFetch('tomorrow') }),
    getCalendarAssignmentsForUser: async (u: UserConfig) =>
      u.calendarSource === 'NATIVE' ? [cal('native:cal-dana', 'Dana')] : (u.calendarAssignments ?? []),
  },
  [`${SRC}/services/user-service.ts`]: {
    getAllUsers: async () => batch,
    getUserByIdentifier: async () => null,
    getWhatsAppChatId: (u: UserConfig) => u.whatsappPhone || u.whatsappBsuid || null,
    clearGoogleRefreshToken: async (telegramId: bigint) => {
      tokensCleared.push(Number(telegramId));
    },
  },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: {
    addDigestReminders: async (_user: UserConfig, events: CalendarEvent[]) => ({ events, moreCount: 0 }),
  },
  [`${SRC}/services/ai-provider.ts`]: {
    generateAICompletion,
    streamAICompletion: async () => {
      throw new Error('a scheduled summary never streams');
    },
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform: { TELEGRAM: 'telegram', WHATSAPP: 'whatsapp' },
    MessageFormat: { HTML: 'html', MARKDOWN: 'markdown', PLAIN: 'plain' },
    getMessagingService: () => {
      throw new Error('no WhatsApp user in this smoke');
    },
  },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (chatId: number | string, text: string) => {
      voices.push({ name: nameOf(chatId), text });
    },
    sendWeeklyVoiceMessage: async () => {},
  },
  [`${SRC}/services/telegram/commands.ts`]: { sendSetupNudgeIfNeeded: async () => false },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async () => ({ allowed: true }),
    incrementUsage: async () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: {
      adminSettings: { findUnique: async () => ({ calendarHomeRollout: 'ADMINS' }) },
      // The daily handler's housekeeping: the reminder users, and the OAuth clean-up at 04:00 UTC.
      user: {
        findMany: async () => {
          log.push('housekeeping: reminder users');
          return [NOA, DANA].map(u => ({
            id: u.id, telegramId: BigInt(u.telegramId!), googleRefreshToken: u.googleRefreshToken, calendarAssignments: [],
            calendarSource: u.calendarSource, pairingId: null, defaultReminderMinutes: 15, pickupRemindersEnabled: true,
            language: u.language, name: u.name, location: '',
          }));
        },
      },
      oAuthState: {
        deleteMany: async () => {
          log.push('housekeeping: OAuth clean-up');
          return { count: 0 };
        },
      },
    },
  },
  [`${SRC}/services/reminder-cache.ts`]: {
    syncReminderCache: async (users: unknown[]) => {
      log.push(`housekeeping: ${users.length} reminder users synced`);
    },
    setGlobalRemindersEnabled: async () => {
      log.push('housekeeping: reminders switch set');
    },
  },
  [`${SRC}/utils/encryption.ts`]: { safeDecrypt: (value: string) => value },
  // The daily handler imports the senders through the package index; it gets summary.ts's own.
  [`${SRC}/services/telegram/index.ts`]: {
    sendDailySummaryToAll: (options?: { filterByHour?: boolean }) => summaryModule().sendDailySummaryToAll(options),
  },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push({ context, severity, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: (message: string, context: string) => {
      captured.push({ context, severity: 'warning', message });
      if (context.startsWith('summary-')) log.push(`warn ${context} ${message}`);
    },
    captureInfo: () => {},
  },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async (title: string) => {
      log.push(`admin ${title}`);
    },
    notifyAdminError: async (title: string) => {
      log.push(`admin error ${title}`);
    },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts).
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
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
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- One scheduled run ----

/** Friday 16 October 2026, 07:00 in Israel: every user's morning hour. */
const MORNING = il('2026-10-16 07:00:00');

function reset(users: UserConfig[], userPlans: [UserConfig, Outcome[]][], startAt = MORNING) {
  batch = users;
  plans = new Map(userPlans.map(([u, p]) => [u.id, [...p]]));
  clock = startAt;
  readMs = 2_000;
  providerFailure = null;
  log = [];
  sleeps = [];
  sent = [];
  voices = [];
  prompts = [];
  captured = [];
  tokensCleared = [];
  batchLines = [];
  onSleep = () => {};
  store.clear();
  // The switch's 30 s memo lives on globalThis; each run starts without it.
  delete (globalThis as Record<string, unknown>).__calendarHomeRolloutMemo;
}

const OUTAGE_EN = enMessages.bot.errors.googleOutageNote;
const OUTAGE_HE = heMessages.bot.errors.googleOutageNote;
const TOKEN_TEXT = `${enMessages.bot.tokenExpired.title}\n\n${enMessages.bot.tokenExpired.message}`;

const textOf = (name: string) => sent.filter(s => s.name === name).map(s => s.text);
const voiceOf = (name: string) => voices.filter(v => v.name === name).map(v => v.text);
const promptsOf = (name: string) => prompts.filter(p => p.name === name).map(p => p.prompt);
const readsOf = (name: string) => log.filter(l => l.startsWith(`read ${name} `));
/** What summary.ts itself reported to Sentry; the reader's own warnings are not checked here. */
const reported = () => captured.filter(c => c.context.startsWith('summary-')).map(c => `${c.context} ${c.severity} ${c.message}`);

/** Waits, in real time, until `done()` or 2 s have passed. */
async function until(done: () => boolean): Promise<void> {
  const started = performance.now();
  while (!done() && performance.now() - started < 2_000) await new Promise(resolve => setTimeout(resolve, 5));
}

async function main() {
  const summary = await import('../src/services/telegram/summary');
  loadedSummary = summary;
  const { filterUsersForSummary } = await import('../src/lib/summary-scheduling');
  const { handleDailySummary } = await import('../src/cron/handlers');
  // The checks below read one user after another on a single fake clock (each read adds its
  // time to it), so their timelines hold at one user at a time; the last check runs the
  // real limit.
  summary.__setSummaryConcurrencyForTests(1);
  summary.__setScheduledRetrySleepForTests(async (ms: number) => {
    await onSleep();
    log.push(`sleep ${ms}`);
    sleeps.push(ms);
    clock += ms;
  });
  // The batch's own closing line; everything else the code logs is left alone.
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[Batch Summary]') && line.includes(' done: ')) batchLines.push(line);
    else realLog(...args);
  };

  // ---- The batch: three Google users fail, a FamCal user and a legacy user don't ----

  reset([NOA, YAEL, DANA, OMER, ITAI], [[NOA, ['fail', 'ok']], [YAEL, ['fail', 'fail']], [DANA, ['ok']], [OMER, ['fail', 'token']]]);
  const batchResult = await summary.sendDailySummaryToAll({ filterByHour: true });
  const batchLog = batchLines;

  await check('the batch: the user the switch doesn\'t cover goes first, the FamCal user before the retries; one count to Sentry and one wait, then each set-aside user is retried once, in order', () => {
    assertList(log, [
      'provider Itai today',
      'send Itai summary',
      'mark Itai daily 2026-10-16',
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Yael 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'mark Dana daily 2026-10-16',
      'read Omer 2026-10-16..2026-10-17 30000',
      'warn summary-google-retry 3 scheduled summaries set aside for a Google retry',
      'sleep 24000',
      'read Noa 2026-10-16..2026-10-17 15000',
      'send Noa summary',
      'mark Noa daily 2026-10-16',
      'read Yael 2026-10-16..2026-10-17 15000',
      'send Yael summary',
      'mark Yael daily 2026-10-16',
      'read Omer 2026-10-16..2026-10-17 15000',
      'send Omer token',
      'admin Token Expired',
    ], 'the run');
  });

  await check('the wait ends 30 s after the first failure (Noa at 07:00:04), not 30 s after the loop', () => {
    assertList(sleeps.map(String), ['24000'], 'sleeps');
  });

  await check('retry ok: the normal summary, with the retry\'s events, and no outage line', () => {
    assertList(textOf('Noa').map(t => t.split('\n')[0]), ['Summary for Noa'], 'Noa\'s messages');
    assert(!textOf('Noa')[0].includes(OUTAGE_EN), 'the outage line is in a normal summary');
    assert(promptsOf('Noa').length === 1 && promptsOf('Noa')[0].includes('Dentist (Noa)'), 'the retry\'s event is not in the prompt');
    assert(voiceOf('Noa').length === 1 && !voiceOf('Noa')[0].includes(OUTAGE_EN), `voice ${JSON.stringify(voiceOf('Noa'))}`);
  });

  await check('retry fails again: the summary goes out without Google, with the outage line in the text and the voice note (Hebrew)', () => {
    assert(readsOf('Yael').length === 2, `Yael was read ${readsOf('Yael').length} times; the outage run must not read Google`);
    assert(textOf('Yael').length === 1 && textOf('Yael')[0].startsWith('Summary for Yael'), `Yael's messages ${JSON.stringify(textOf('Yael'))}`);
    assert(textOf('Yael')[0].includes(OUTAGE_HE), `no Hebrew outage line in ${JSON.stringify(textOf('Yael')[0])}`);
    assert(voiceOf('Yael').length === 1 && voiceOf('Yael')[0].includes(OUTAGE_HE), `voice ${JSON.stringify(voiceOf('Yael'))}`);
    assert(promptsOf('Yael').length === 1 && !promptsOf('Yael')[0].includes('Dentist'), 'the outage prompt lists Google events');
  });

  await check('retry finds a dead token: the token text with the refresh button and an admin notice, no outage run, no dedup mark (A-24)', () => {
    assertList(sent.filter(s => s.name === 'Omer').map(s => s.text), [TOKEN_TEXT], 'Omer\'s messages');
    assert(sent.find(s => s.name === 'Omer')?.button === 'https://famcal.test/refresh-token?user_id=1014', `button ${sent.find(s => s.name === 'Omer')?.button}`);
    assert(promptsOf('Omer').length === 0, 'Omer got a summary');
    assert(!log.some(l => l.startsWith('mark Omer')), 'Omer has a dedup mark');
  });

  await check('a set-aside first attempt reports no error; the batch counts them once; the outage run leaves one warning; the dead token is reported as before', () => {
    assertList(reported(), [
      'summary-google-retry warning 3 scheduled summaries set aside for a Google retry',
      'summary-google-outage warning GOOGLE_FETCH_FAILED',
      'summary-batch-user error GOOGLE_TOKEN_EXPIRED',
    ], 'captured');
  });

  await check('the batch logs one closing line: what it delivered, how many it set aside, and its total time', () => {
    assertList(batchLog, ['[Batch Summary] daily done: processed=4 set aside=3 total=40000ms'], 'the closing line');
  });

  await check('the result counts the four summaries delivered', () => {
    assert(batchResult.processed === 4, `processed ${batchResult.processed}`);
  });

  await check('the legacy user (switch off) reads through his provider, never the reader, and is never retried (A-33)', () => {
    assertList(log.filter(l => l.includes('Itai')), ['provider Itai today', 'send Itai summary', 'mark Itai daily 2026-10-16'], 'Itai');
  });

  // ---- The outage guideline: the same user and clock, retry ok with nothing vs a second outage ----

  reset([NOA], [[NOA, ['fail', 'empty']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  const emptyDay = promptsOf('Noa');
  const emptyText = textOf('Noa');
  reset([NOA], [[NOA, ['fail', 'fail']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  const outage = promptsOf('Noa');
  const outageText = textOf('Noa');
  const outageMarks = log.filter(l => l.startsWith('mark '));

  await check('the outage prompt is the empty-day prompt plus exactly one guideline line', () => {
    assert(emptyDay.length === 1 && outage.length === 1, `prompts ${emptyDay.length}, ${outage.length}`);
    const a = emptyDay[0].split('\n');
    const b = outage[0].split('\n');
    assert(b.length === a.length + 1, `lines ${a.length} -> ${b.length}`);
    const at = b.findIndex((line, i) => line !== a[i]);
    assert(at >= 0 && JSON.stringify([...b.slice(0, at), ...b.slice(at + 1)]) === JSON.stringify(a), 'more than one line differs');
    assert(b[at].startsWith('- '), `the added line is not a guideline: ${b[at]}`);
  });

  await check('the outage summary is the empty-day summary plus the outage line, and it is marked sent', () => {
    assert(emptyText.length === 1 && !emptyText[0].includes(OUTAGE_EN), `empty-day text ${JSON.stringify(emptyText)}`);
    assert(outageText.length === 1 && outageText[0].startsWith(emptyText[0]) && outageText[0].includes(OUTAGE_EN), `outage text ${JSON.stringify(outageText)}`);
    assertList(outageMarks, ['mark Noa daily 2026-10-16'], 'marks');
  });

  // ---- No failure, no wait ----

  reset([NOA, DANA], [[NOA, ['ok']], [DANA, ['ok']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('a batch with no Google failure never waits and reads each user once, with the scheduled 30 s deadline', () => {
    assertList(log.filter(l => l.startsWith('read ') || l.startsWith('sleep')), [
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
    ], 'reads');
  });

  // ---- A slow batch: 30 s have already passed when the loop ends ----

  reset([NOA, DANA], [[NOA, ['fail', 'ok']], [DANA, ['ok']]]);
  readMs = 40_000;
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('when 30 s have passed by the end of the loop, the retry runs at once', () => {
    assertList(log.filter(l => l.startsWith('read ') || l.startsWith('sleep') || l.startsWith('send ')), [
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'read Noa 2026-10-16..2026-10-17 15000',
      'send Noa summary',
    ], 'run');
  });

  // ---- The retry keeps the first attempt's day across local midnight (A-7) ----

  reset([NOA], [[NOA, ['fail', 'ok']]], il('2026-10-16 23:59:50'));
  await summary.sendTomorrowSummaryToAll();

  await check('a tomorrow summary retried after local midnight reads and shapes the first attempt\'s day', () => {
    assertList(log, [
      'read Noa 2026-10-17..2026-10-18 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'read Noa 2026-10-17..2026-10-18 15000',
      'send Noa summary',
    ], 'run');
    assert(promptsOf('Noa').length === 1 && promptsOf('Noa')[0].includes('Saturday, October 17, 2026'), 'the prompt is not for Saturday 17 October');
    assert(promptsOf('Noa')[0].includes('Dentist (Noa)'), 'the day\'s event is not in the prompt');
  });

  // ---- Missing scopes on the retry: Sentry only, as on any scheduled run (A-25) ----

  reset([NOA], [[NOA, ['fail', 'scopes']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('retry finds missing scopes: no message, no token cleared, no dedup mark, no outage run, Sentry only (A-25)', () => {
    assertList(log, [
      'read Noa 2026-10-16..2026-10-17 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'read Noa 2026-10-16..2026-10-17 15000',
    ], 'run');
    assert(sent.length === 0 && prompts.length === 0 && tokensCleared.length === 0, `sent ${sent.length}, prompts ${prompts.length}, cleared ${tokensCleared.length}`);
    assertList(reported(), [
      'summary-google-retry warning 1 scheduled summaries set aside for a Google retry',
      'summary-batch-user error GOOGLE_INSUFFICIENT_SCOPES',
    ], 'captured');
  });

  // ---- A 23:00 tomorrow summary whose retry lands after midnight: marked for the batch's date ----

  reset([LIOR], [[LIOR, ['fail', 'ok']]], il('2026-10-16 23:59:20'));
  readMs = 15_000;
  await summary.sendTomorrowSummaryToAll({ filterByHour: true });
  const lateRun = [...log];
  clock = il('2026-10-17 23:00:00');
  const nextEvening = await filterUsersForSummary([LIOR], 'tomorrow');

  await check('a 23:00 tomorrow summary retried after midnight is marked for the batch\'s date, so the next evening\'s still goes out', () => {
    // The batch at 23:59:20, the first failure at 23:59:35, the retry at 00:00:05.
    assertList(lateRun, [
      'read Lior 2026-10-17..2026-10-18 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'read Lior 2026-10-17..2026-10-18 15000',
      'send Lior summary',
      'mark Lior tomorrow 2026-10-16',
    ], 'run');
    assert(store.has('summary:dedup:tomorrow:16:2026-10-16'), `marks ${JSON.stringify([...store.keys()])}`);
    assert(nextEvening.eligible.length === 1 && nextEvening.skippedDedup === 0, `at 23:00 on 17 October: ${JSON.stringify({ eligible: nextEvening.eligible.length, dedup: nextEvening.skippedDedup })}`);
  });

  // ---- The switch turned back during the wait: today's path ----

  reset([NOA], [[NOA, ['fail']]]);
  onSleep = () => {
    store.set('chome:rollout', 'OFF');
  };
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('a switch turned back to OFF during the wait: the retry is today\'s summary through the provider, with no outage line, marked for the batch\'s date', () => {
    assertList(log, [
      'read Noa 2026-10-16..2026-10-17 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'provider Noa today',
      'send Noa summary',
      'mark Noa daily 2026-10-16',
    ], 'run');
    assert(textOf('Noa').length === 1 && !textOf('Noa')[0].includes(OUTAGE_EN), `Noa's messages ${JSON.stringify(textOf('Noa'))}`);
    assertList(reported(), ['summary-google-retry warning 1 scheduled summaries set aside for a Google retry'], 'captured');
  });

  // ---- The daily run's housekeeping runs beside the batch, not after its retries ----

  reset([NOA, DANA], [[NOA, ['fail', 'ok']], [DANA, ['ok']]]);
  onSleep = () => until(() => log.includes('housekeeping: OAuth clean-up'));
  const handled = await handleDailySummary();

  await check('the daily cron run syncs the reminder cache and cleans up OAuth states beside the batch: done before the retry wait ends', () => {
    const housekeeping = log.filter(l => l.startsWith('housekeeping: '));
    assertList(housekeeping, [
      'housekeeping: reminder users',
      'housekeeping: 2 reminder users synced',
      'housekeeping: reminders switch set',
      'housekeeping: OAuth clean-up',
    ], 'housekeeping');
    const sleptAt = log.indexOf('sleep 28000');
    assert(sleptAt > 0 && log.lastIndexOf('housekeeping: OAuth clean-up') < sleptAt, `the run ${JSON.stringify(log)}`);
    assertList(log.filter(l => !l.startsWith('housekeeping: ')), [
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'mark Dana daily 2026-10-16',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 28000',
      'read Noa 2026-10-16..2026-10-17 15000',
      'send Noa summary',
      'mark Noa daily 2026-10-16',
    ], 'the summaries');
    assert(handled.success === true && handled.processed === 2, JSON.stringify(handled));
  });

  // ---- Users the switch doesn't cover: today's handling, never the retry (A-33) ----

  reset([ITAI, DANA], [[DANA, ['ok']]]);
  providerFailure = new Error('GOOGLE_TOKEN_EXPIRED');
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('a legacy user\'s dead token gets today\'s token text and admin notice, with no wait and no retry', () => {
    assertList(log, [
      'provider Itai today',
      'send Itai token',
      'admin Token Expired',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'mark Dana daily 2026-10-16',
    ], 'run');
  });

  // ---- Concurrency: a Google stall costs the batch one wait per four users, not one per user ----

  await check('six Google users behind a stalled Google: four reads in flight at once, in order; every user delivered once, the set-aside ones retried once after one wait, four at a time; a user whose read throws leaves the others alone; the counts equal the one-at-a-time run', async () => {
    const gs = [21, 22, 23, 24, 25, 26].map(id => google(id, `G${id - 20}`));
    const boom = google(27, 'G7');
    EVERYONE.push(...gs, boom);
    const run = async (concurrency: number, held: boolean) => {
      summary.__setSummaryConcurrencyForTests(concurrency);
      reset([...gs, boom], [...gs.map((g): [UserConfig, Outcome[]] => [g, ['fail', 'ok']]), [boom, ['boom']]]);
      peakHeld = 0;
      readsHeld = 0;
      let release: () => void = () => {};
      if (held) hold = new Promise<void>(resolve => { release = resolve; });
      const phases: number[] = [];
      onSleep = async () => {
        // The retry's turn: stall it too, to see it is four at a time as well.
        if (!held) return;
        peakHeld = 0;
        hold = new Promise<void>(resolve => { release = resolve; });
        setTimeout(() => { phases.push(peakHeld); release(); hold = null; }, 60);
      };
      const running = summary.sendDailySummaryToAll({ filterByHour: true });
      if (held) {
        await until(() => readsHeld >= 4);
        await new Promise(resolve => setTimeout(resolve, 30));
        phases.unshift(peakHeld);
        const firstWave = log.filter(l => l.startsWith('read ')).map(l => l.split(' ')[1]).join();
        assert(firstWave === 'G1,G2,G3,G4', `the first reads ${firstWave}`);
        hold = null;
        release();
      }
      const result = await running;
      hold = null;
      return { result, phases, log: [...log], batchLines: [...batchLines], sleeps: [...sleeps], reports: reported() };
    };
    const wide = await run(4, true);
    assert(wide.phases.join() === '4,4', `most reads in flight at once, first wave then retries: ${wide.phases}`);
    const count = (lines: string[], prefix: string) => lines.filter(l => l.startsWith(prefix)).length;
    for (const g of gs) {
      assert(sent.filter(x => x.name === g.name).length === 1, `${g.name} got ${sent.filter(x => x.name === g.name).length} summaries`);
      assert(wide.log.filter(l => l === `mark ${g.name} daily 2026-10-16`).length === 1, `${g.name} marks`);
      assert(wide.log.filter(l => l.startsWith(`read ${g.name} `)).length === 2, `${g.name} reads`);
    }
    assert(sent.every(x => x.name !== 'G7'), 'the user whose read broke got a summary');
    assert(wide.sleeps.length === 1 && wide.log.filter(l => l.startsWith('warn summary-google-retry')).join() === 'warn summary-google-retry 6 scheduled summaries set aside for a Google retry', `sleeps ${wide.sleeps}, log ${wide.log.filter(l => l.includes('retry'))}`);
    assert(wide.reports.some(r => r.includes('the read for G7 broke')) || captured.some(c => c.context === 'summary-batch-user'), `no report for G7: ${JSON.stringify(captured)}`);
    assert(wide.result.processed === 6, `processed ${wide.result.processed}`);
    assert(wide.batchLines.join().includes('processed=6 set aside=6'), `closing line ${wide.batchLines}`);
    const wideMarks = count(wide.log, 'mark ');
    const narrow = await run(1, false);
    assert(narrow.result.processed === wide.result.processed && count(narrow.log, 'mark ') === wideMarks && narrow.sleeps.length === wide.sleeps.length,
      `one at a time: processed ${narrow.result.processed}, marks ${count(narrow.log, 'mark ')}, sleeps ${narrow.sleeps.length}`);
    summary.__setSummaryConcurrencyForTests(1);
  });

  await check('nothing above reached the network or sent an admin error notice', () => {
    assert(networkAttempts.length === 0, `network: ${networkAttempts.join(', ')}`);
    assert(!log.some(l => l.startsWith('admin error')), 'an admin error notice was sent');
  });

  summary.__setScheduledRetrySleepForTests(null);
  console.log = realLog;

  let passed = 0;
  for (const r of results) {
    if (r.ok) passed++;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  }
  console.log(`\n${passed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
