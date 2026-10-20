// Smoke test for the summary seam (calendar home spec §3.1, Plan C Task C3):
// src/services/telegram/summary.ts.
//
// The daily and tomorrow summaries read their day through the shared reader's
// readDigestDay: the summary day, the user's timezone, the resolved calendar ids, and the
// run's mode and deadline (on demand: 10 s; scheduled: 30 s). prepareSummaryForUser takes the summary day, the read and the outage flag from its
// caller (the scheduled retry, Task C4). The day drives the read, the shaping, the
// reminders, the prompt's date, the header and the week block. The outage run reads
// nothing for a Google user, skips the week block, flags the prompt and puts the outage
// line under the text. On demand, a Google outage (GOOGLE_FETCH_FAILED) gets Ruling
// R13's text, in place of an open draft, and no admin page.
//
// The real summary.ts, command pipeline and bot texts run. Faked: the user lookup, the
// calendar lookup, readDigestDay (the rest of digest.ts is real), the timezone, open
// reminders, the week lookahead, the AI, the voice note, quota, analytics, Redis, the
// setup nudge, both messaging services and the admin notifier. The clock is frozen. No
// network, no DB.
//
// Checks named [guard] passed before the shared reader too: the error branches it left
// as they were.
//
// Run under each clock; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-summary-seam.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-summary-seam.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-summary-seam.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MessageFormat, MessagingPlatform } from '../src/services/messaging/types';
import type { MessageOptions, StreamMessageHandle } from '../src/services/messaging/types';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { SummaryUserContext } from '../src/services/claude';
import type { DigestRead } from '../src/services/calendar-read/digest';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void>) {
  reset();
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

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function assertEqual(got: unknown, want: unknown, what: string) {
  assert(isDeepStrictEqual(got, want), `${what}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Environment: fakes only ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';

const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => {
  unhandled.push(reason);
});

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

/** 06:30 on Saturday 17 October 2026 in Israel, 23:30 on Friday the 16th in New York. */
const MORNING = Date.parse('2026-10-17T03:30:00Z');
/** Ten seconds past midnight in Israel, Sunday the 18th: a retry that crossed midnight. */
const PAST_MIDNIGHT = Date.parse('2026-10-17T21:00:10Z');
let clock = MORNING;
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

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const MINE: CalendarAssignment = { calendarId: 'noa@gmail.com', labels: ['yours'], name: 'Noa', color: '#039BE5' };
const KIDS: CalendarAssignment = { calendarId: 'family.kids@group.calendar.google.com', labels: ['kids'], name: 'Kids', color: '#33b679' };
const HOME: CalendarAssignment = { calendarId: 'native:home1', labels: ['yours'], name: 'Home', color: '#039BE5' };
const GOOGLE_IDS = [MINE.calendarId, KIDS.calendarId];

function fixtureUser(o: Partial<UserConfig> & { id: number }): UserConfig {
  return {
    name: 'Noa', englishName: 'Noa', gender: 'female', language: 'en', culture: 'default',
    calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token', calendarAssignments: [MINE, KIDS],
    messagingPlatform: 'telegram', whatsappPhone: null, isAdmin: true, weatherEnabled: false, location: 'Tel Aviv',
    textSummaryEnabled: true, voiceSummaryEnabled: true, includeLookaheadInTomorrow: true, globalRules: [],
    suspendedAt: null, unreachableSince: null,
    ...o,
  } as unknown as UserConfig;
}

const GOOGLE_USER = fixtureUser({ id: 3, telegramId: 1003, language: 'he' });
const FAMCAL_USER = fixtureUser({ id: 4, telegramId: 1004, language: 'ru', calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: undefined });
const NEW_YORKER = fixtureUser({ id: 5, telegramId: 1005, location: 'Brooklyn' });
const WHATSAPP_USER = fixtureUser({ id: 6, telegramId: null, language: 'ru', messagingPlatform: 'whatsapp', whatsappPhone: '972500000006' });
const USERS = [GOOGLE_USER, FAMCAL_USER, NEW_YORKER, WHATSAPP_USER];
const TZ_OF: Record<number, string> = { 5: NY };

const ev = (id: string, start: string, end: string, cal: CalendarAssignment = MINE): CalendarEvent => ({
  summary: `Event ${id}`, start, end, calendarId: cal.calendarId, calendarName: cal.name, eventId: id,
});
/** What the read returns: Friday the 16th to Monday the 19th, in Israel. */
const READ: CalendarEvent[] = [
  ev('fri', '2026-10-16T09:00:00+03:00', '2026-10-16T10:00:00+03:00'),
  ev('sat', '2026-10-17T09:00:00+03:00', '2026-10-17T10:00:00+03:00'),
  ev('sat-kids', '2026-10-17T15:00:00+03:00', '2026-10-17T16:00:00+03:00', KIDS),
  ev('sun', '2026-10-18T09:00:00+03:00', '2026-10-18T10:00:00+03:00'),
  ev('mon', '2026-10-19T09:00:00+03:00', '2026-10-19T10:00:00+03:00'),
];
const NOON_18TH = '2026-10-18T09:00:00.000Z';

// ---- What the fakes saw ----

type DigestCall = { user: UserConfig; day: string; tz: string; ids: string[]; read: DigestRead; sources?: readonly string[] };
const digestCalls: DigestCall[] = [];
const lookedUp: UserConfig[] = [];
const reminderDays: string[] = [];
const lookaheadRefs: string[] = [];
/** The sources each week block was asked to read (undefined: every applicable one). */
const lookaheadSources: (readonly string[] | undefined)[] = [];
type AiCall = { events: string[][]; dayNoon: string; context: SummaryUserContext; weekLookahead: unknown };
const aiCalls: AiCall[] = [];
const headers: { date: string; tz: unknown }[] = [];
type Sent = { via: string; method: string; chatId?: number | string; text: string; format?: MessageFormat };
const sent: Sent[] = [];
const voice: string[] = [];
const admin: string[] = [];
const cleared: unknown[] = [];
const logs: string[] = [];
/** Sentry, as "<context> <level> <message>". */
const captured: string[] = [];

/** What the next day read does: return events, or throw. */
let readOutcome: () => Promise<CalendarEvent[]>;
/** What the next week block does: its events, or a throw. */
let lookaheadOutcome: () => Promise<CalendarEvent[]>;
let aiText: string;
let scheduledUsers: UserConfig[] = [];

const failWith = (message: string) => async (): Promise<CalendarEvent[]> => {
  throw Object.assign(new Error(message), { day: '2026-10-17' });
};

function reset() {
  clock = MORNING;
  for (const list of [digestCalls, lookedUp, reminderDays, lookaheadRefs, lookaheadSources, aiCalls, headers, sent, voice, admin, cleared, captured]) {
    list.length = 0;
  }
  readOutcome = async () => READ.map(e => ({ ...e }));
  lookaheadOutcome = async () => [READ[4]];
  aiText = 'AI summary';
  scheduledUsers = [];
}

// ---- Fakes ----

function service(via: 'telegram' | 'whatsapp') {
  return {
    sendMessage: async (chatId: number | string, text: string, options?: MessageOptions) => {
      sent.push({ via, method: 'sendMessage', chatId, text, format: options?.format });
      return 500 + sent.length;
    },
    updateMessage: async (chatId: number | string, _messageId: number | string, text: string, options?: MessageOptions) => {
      sent.push({ via, method: 'updateMessage', chatId, text, format: options?.format });
    },
    sendTypingIndicator: async () => {},
  };
}
const telegram = service('telegram');
const whatsapp = service('whatsapp');

/** An open streaming draft, as the Mini App's on-demand path hands one in. */
function draft(): StreamMessageHandle {
  return {
    pushStage: () => {},
    pushDelta: () => {},
    finalize: async (text: string, options?: MessageOptions) => {
      sent.push({ via: 'draft', method: 'finalize', text, format: options?.format });
      return 777;
    },
    cancel: async (text: string, options?: MessageOptions) => {
      sent.push({ via: 'draft', method: 'cancel', text, format: options?.format });
    },
  };
}

const SRC = path.resolve(__dirname, '../src');

/** Modules replaced by fakes, by file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/services/user-service.ts`]: {
    getUserByIdentifier: async (id: number | string) => {
      const found = USERS.find(u => (typeof id === 'number' ? u.telegramId === id : u.whatsappPhone === id));
      if (!found) return null;
      const row = { ...found }; // a fresh row on every lookup, as the database gives
      lookedUp.push(row);
      return row;
    },
    getAllUsers: async () => scheduledUsers.map(u => ({ ...u })),
    getWhatsAppChatId: (u: UserConfig) => u.whatsappPhone ?? null,
    // A tripwire: missing permissions keep the token now (a cleared one made stale Google choices)
    clearGoogleRefreshToken: async (telegramId: bigint) => {
      cleared.push(telegramId);
    },
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getCalendarAssignmentsForUser: async (u: UserConfig) => (u.calendarSource === 'NATIVE' ? [HOME] : (u.calendarAssignments ?? [])),
  },
  [`${SRC}/services/calendar-read/digest.ts`]: real => ({
    ...real,
    readDigestDay: async (u: UserConfig, day: string, tz: string, ids: readonly string[], read: DigestRead, sources?: readonly string[]) => {
      digestCalls.push({ user: u, day, tz, ids: [...ids], read, ...(sources ? { sources: [...sources] } : {}) });
      return readOutcome();
    },
  }),
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async (u: UserConfig) => TZ_OF[u.id] ?? IL },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: {
    addDigestReminders: async (_u: UserConfig, events: CalendarEvent[], day: string) => {
      reminderDays.push(day);
      return { events, moreCount: 0 };
    },
  },
  [`${SRC}/services/week-lookahead.ts`]: {
    getWeekLookahead: async (_u: UserConfig, _calendars: unknown, referenceDate: Date, _read?: unknown, opts?: { sources?: readonly string[] }) => {
      lookaheadRefs.push(referenceDate.toISOString());
      lookaheadSources.push(opts?.sources);
      return { events: await lookaheadOutcome() };
    },
    formatTomorrowLookahead: () => 'Looking ahead: Monday',
  },
  [`${SRC}/services/claude.ts`]: {
    generateSummary: async (...args: unknown[]) => {
      const lists = args.slice(0, 3) as CalendarEvent[][];
      aiCalls.push({
        events: lists.map(list => list.map(e => e.eventId ?? e.summary)),
        dayNoon: (args[10] as Date).toISOString(),
        context: args[15] as SummaryUserContext,
        weekLookahead: args[17],
      });
      return aiText;
    },
    formatDateHeader: (date: Date, _language: unknown, _culture: unknown, tz: string) => {
      headers.push({ date: date.toISOString(), tz });
      return `Header ${date.toISOString()}`;
    },
  },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform, MessageFormat,
    getMessagingService: (platform: MessagingPlatform) => (platform === MessagingPlatform.WHATSAPP ? whatsapp : telegram),
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (_chatId: number | string, text: string) => {
      voice.push(text);
    },
    sendWeeklyVoiceMessage: async () => {},
  },
  [`${SRC}/services/telegram/commands.ts`]: { sendSetupNudgeIfNeeded: async () => false },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async () => ({ allowed: true }),
    incrementUsage: async () => {},
  },
  [`${SRC}/services/kid-name-detection.ts`]: { sendKidNameFollowUp: async () => {} },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push(`${context} ${severity} ${error instanceof Error ? error.message : String(error)}`);
    },
    captureWarning: (message: string, context: string) => {
      captured.push(`${context} warning ${message}`);
    },
    captureInfo: () => {},
  },
  [`${SRC}/utils/prisma.ts`]: { prisma: {}, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/utils/redis.ts`]: { redis: { set: async () => 'OK', get: async () => null, del: async () => 0, mget: async () => [] } },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminError: async (context: string) => {
      admin.push(`error: ${context}`);
    },
    notifyAdminWarning: async (title: string) => {
      admin.push(`warning: ${title}`);
    },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};

/** A partial fake is built once from the real module, then served to require() and import() alike. */
const built = new Map<string, object>();
const loadingReal = new Set<string>();
function fakeFor(file: string, loadReal: () => unknown): object {
  const stub = stubs[file];
  if (typeof stub !== 'function') return stub;
  if (!built.has(file)) {
    loadingReal.add(file);
    try {
      built.set(file, stub(loadReal() as Record<string, unknown>));
    } finally {
      loadingReal.delete(file);
    }
  }
  return built.get(file)!;
}

// Static imports compile to require() and pass through Module._load.
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  if (!(resolved in stubs) || loadingReal.has(resolved)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(resolved, () => realLoad.call(this, request, parent, isMain));
};

// summary.ts loads the timezone, the week lookahead, Redis and the admin notifier with
// import(), which goes through the ES module loader; it gets the same fake, as an ES module.
(globalThis as { seamSmokeFake?: (file: string) => object }).seamSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { seamSmokeFake: (file: string) => object }).seamSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.seamSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

type BotTexts = {
  errors: Record<string, string>;
  tokenExpired: { title: string; message: string };
  insufficientScopes: { title: string; message: string };
};

const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };

async function main() {
  // The code under test logs timings and the pipeline's errors; keep them out of the report.
  const keep = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  Object.assign(console, { log: keep, error: keep, warn: keep, info: keep });

  const summary = await import('../src/services/telegram/summary');
  const digest = await import('../src/services/calendar-read/digest');
  const bot = Object.fromEntries(
    ['en', 'he', 'ru'].map(lang => [lang, JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${lang}.json`), 'utf8')).bot as BotTexts])
  );
  const text = (lang: string, key: 'googleUnreachable' | 'googleOutageNote') => {
    const value = bot[lang].errors[key];
    assert(typeof value === 'string' && value.trim() !== '', `bot.errors.${key} is missing in messages/${lang}.json (Task C2 adds it)`);
    return value;
  };
  // A bot text is reported by its name ("he:errors.calendarFetch"), whatever its copy.
  const names = new Map<string, string>();
  for (const lang of ['en', 'he', 'ru']) {
    const t = bot[lang];
    for (const [key, value] of Object.entries(t.errors)) names.set(value, `${lang}:errors.${key}`);
    names.set(`${t.tokenExpired.title}\n\n${t.tokenExpired.message}`, `${lang}:tokenExpired`);
    names.set(`${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`, `${lang}:insufficientScopes`);
  }
  const nameOf = (sentText: string) => names.get(sentText) ?? sentText;
  const tomorrowFlag = () => new Date(clock + 24 * 3600 * 1000);
  const readsOf = () => digestCalls.map(c => [c.day, c.tz, c.ids, c.read]);
  const aiEvents = () => aiCalls.map(a => a.events.flat());
  const messages = () => sent.filter(s => s.method !== 'updateMessage').map(s => [s.via, s.method, s.chatId ?? null, nameOf(s.text)]);

  await check("Google user: today is read through readDigestDay, on demand, with the fresh user row, and the AI's text goes out as written", async () => {
    await summary.sendDailySummaryToUser(1003);
    assertEqual(readsOf(), [['2026-10-17', IL, GOOGLE_IDS, { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
    assert(digestCalls[0].read === digest.DEFAULT_ON_DEMAND_READ, "the read is not digest.ts's DEFAULT_ON_DEMAND_READ");
    assert(digestCalls[0].user === lookedUp[0], 'the reader got another user object than the lookup returned');
    assertEqual(aiCalls.map(a => a.events), [[['sat'], [], ['sat-kids']]], 'the events the AI got (mine, spouse, other)');
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'AI summary']], 'messages');
    assertEqual(voice, ['AI summary'], 'the voice text');
  });

  await check("tomorrow: the reader reads tomorrow's local date, and the week block starts from its noon", async () => {
    await summary.sendTomorrowSummaryToUser(1003);
    assertEqual(readsOf(), [['2026-10-18', IL, GOOGLE_IDS, { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
    assertEqual(aiEvents(), [['sun']], 'the events the AI got');
    assertEqual(aiCalls[0].dayNoon, NOON_18TH, "the prompt's date");
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block reference');
  });

  await check('FamCal user: the reader too, with the built-in calendar ids', async () => {
    await summary.sendDailySummaryToUser(1004);
    assertEqual(readsOf(), [['2026-10-17', IL, [HOME.calendarId], { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
  });

  await check("FamCal user, tomorrow: the reader reads tomorrow with the built-in calendar ids, and the week block comes from tomorrow's noon", async () => {
    await summary.sendTomorrowSummaryToUser(1004);
    assertEqual(readsOf(), [['2026-10-18', IL, [HOME.calendarId], { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
    assertEqual(aiEvents(), [['sun']], 'the events the AI got');
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block reference');
    assertEqual(aiCalls[0].weekLookahead, 'Looking ahead: Monday', 'the week block text');
  });

  await check("New York at 23:30 on Friday: today and tomorrow are New York's dates", async () => {
    await summary.sendDailySummaryToUser(1005);
    await summary.sendTomorrowSummaryToUser(1005);
    assertEqual(readsOf().map(r => r.slice(0, 2)), [['2026-10-16', NY], ['2026-10-17', NY]], 'reader reads (day, tz)');
  });

  await check("the summary read hands on the caller's day and read", async () => {
    await summary.readSummaryDay(GOOGLE_USER, GOOGLE_IDS, IL, '2026-10-17', digest.SCHEDULED_READ);
    await summary.readSummaryDay(GOOGLE_USER, GOOGLE_IDS, IL, '2026-10-20', digest.SCHEDULED_RETRY_READ);
    assertEqual(readsOf().map(r => r[0]), ['2026-10-17', '2026-10-20'], 'reader days');
    assert(digestCalls[0].read === digest.SCHEDULED_READ && digestCalls[1].read === digest.SCHEDULED_RETRY_READ, `reads ${show(digestCalls.map(c => c.read))}`);
  });

  await check("opts.day keeps the first attempt's day past midnight: the read, the shaping, the reminders, the prompt's date, the header and the week block", async () => {
    clock = PAST_MIDNIGHT;
    const result = await summary.prepareSummaryForUser(GOOGLE_USER, summary.readSummaryDay, tomorrowFlag(), undefined, undefined, undefined, {
      day: '2026-10-18',
      read: digest.SCHEDULED_RETRY_READ,
    });
    assertEqual(readsOf(), [['2026-10-18', IL, GOOGLE_IDS, { mode: 'scheduled', deadlineMs: 15000 }]], 'reader reads (day, tz, ids, read)');
    assert(digestCalls[0].read === digest.SCHEDULED_RETRY_READ, "the read is not the caller's");
    assertEqual(aiEvents(), [['sun']], 'the events the AI got (shaped to the 18th)');
    assertEqual(reminderDays, ['2026-10-18'], 'the open-reminders day');
    assertEqual(aiCalls[0].dayNoon, NOON_18TH, "the prompt's date");
    assertEqual(headers, [{ date: NOON_18TH, tz: IL }], 'the date header');
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block reference');
    assertEqual(result.summary, 'AI summary', 'the summary text');
  });

  await check("without opts.day the day is today's rule and the read is on demand: past midnight, tomorrow is the 19th", async () => {
    clock = PAST_MIDNIGHT;
    await summary.prepareSummaryForUser(GOOGLE_USER, summary.readSummaryDay, tomorrowFlag());
    assertEqual(readsOf(), [['2026-10-19', IL, GOOGLE_IDS, { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
    assertEqual(aiEvents(), [['mon']], 'the events the AI got');
  });

  await check("googleUnavailable, Google user: the day is read from FamCal only, the prompt flagged, the week block FamCal only, and the outage line under the text (G2)", async () => {
    clock = PAST_MIDNIGHT;
    readOutcome = async () => [ev('sun-home', '2026-10-18T09:00:00+03:00', '2026-10-18T10:00:00+03:00', HOME)];
    const result = await summary.prepareSummaryForUser(GOOGLE_USER, summary.readSummaryDay, tomorrowFlag(), undefined, undefined, undefined, {
      day: '2026-10-18',
      read: digest.SCHEDULED_RETRY_READ,
      googleUnavailable: true,
    });
    assertEqual(digestCalls.map(c => [c.day, c.sources]), [['2026-10-18', ['famcal']]], 'reader reads (day, sources)');
    assertEqual(aiCalls.map(a => a.events), [[[], [], ['sun-home']]], 'the events the AI got');
    assert(aiCalls[0].context.googleUnavailable === true, `the prompt context has no googleUnavailable: true: ${show(aiCalls[0].context)}`);
    assertEqual([lookaheadRefs, lookaheadSources, aiCalls[0].weekLookahead], [[NOON_18TH], [['famcal']], 'Looking ahead: Monday'], 'the week block (reads, sources, text)');
    assertEqual(aiCalls[0].dayNoon, NOON_18TH, "the prompt's date");
    assertEqual(result.summary, `AI summary\n\n<i>${text('he', 'googleOutageNote')}</i>`, 'the summary text');
  });

  await check("googleUnavailable: the outage line is in the user's language", async () => {
    for (const [u, lang] of [[NEW_YORKER, 'en'], [WHATSAPP_USER, 'ru']] as const) {
      const result = await summary.prepareSummaryForUser(u, summary.readSummaryDay, undefined, undefined, undefined, undefined, {
        read: digest.SCHEDULED_RETRY_READ,
        googleUnavailable: true,
      });
      assertEqual(result.summary, `AI summary\n\n<i>${text(lang, 'googleOutageNote')}</i>`, `the ${lang} summary text`);
    }
    assertEqual(digestCalls.map(c => c.sources), [['famcal'], ['famcal']], 'reader reads (sources)');
  });

  await check('googleUnavailable with an empty AI answer: nothing is added, so delivery still answers "could not generate"', async () => {
    aiText = '';
    const result = await summary.prepareSummaryForUser(GOOGLE_USER, summary.readSummaryDay, undefined, undefined, undefined, undefined, {
      read: digest.SCHEDULED_RETRY_READ,
      googleUnavailable: true,
    });
    assertEqual(result.summary, '', 'the summary text');
  });

  await check("googleUnavailable leaves a FamCal user's read, prompt and text alone", async () => {
    const result = await summary.prepareSummaryForUser(FAMCAL_USER, summary.readSummaryDay, undefined, undefined, undefined, undefined, {
      read: digest.SCHEDULED_RETRY_READ,
      googleUnavailable: true,
    });
    assertEqual(readsOf(), [['2026-10-17', IL, [HOME.calendarId], { mode: 'scheduled', deadlineMs: 15000 }]], 'reader reads (day, tz, ids, read)');
    assert(!('googleUnavailable' in aiCalls[0].context), `the prompt context: ${show(aiCalls[0].context)}`);
    assertEqual(result.summary, 'AI summary', 'the summary text');
  });

  await check("[guard] the week block's own Google outage degrades the tomorrow summary: it goes out without the block and with no outage line, and Sentry gets a warning (A-28)", async () => {
    // The day read answered; only the week block (the reader's lookahead, C5) failed.
    lookaheadOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendTomorrowSummaryToUser(1003);
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block was asked');
    assertEqual(aiCalls.map(a => [a.events.flat(), a.weekLookahead ?? null]), [[['sun'], null]], "the AI's events and week block");
    assert(!('googleUnavailable' in aiCalls[0].context), `the prompt context: ${show(aiCalls[0].context)}`);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'AI summary']], 'what the user got');
    assertEqual(voice, ['AI summary'], 'the voice text');
    assertEqual(captured, ['summary-week-lookahead warning GOOGLE_FETCH_FAILED'], 'Sentry');
    assertEqual(admin, [], 'admin pages');
  });

  await check("[guard] without the outage flag the prompt context has today's four keys, and nothing goes under the text (A-19)", async () => {
    await summary.sendDailySummaryToUser(1005);
    await summary.sendTomorrowSummaryToUser(1003);
    const keys = ['culture', 'globalRules', 'calendarAssignments', 'openRemindersMore'];
    assertEqual(aiCalls.map(a => Object.keys(a.context)), [keys, keys], 'the prompt context keys');
    assertEqual(messages().map(m => m[3]), ['AI summary', 'AI summary'], 'the texts sent');
    assertEqual(voice, ['AI summary', 'AI summary'], 'the voice texts');
  });

  await check("on demand, Google outage with a draft open: R13's text replaces the draft, and no admin is paged", async () => {
    readOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendDailySummaryToUser(1003, MessagingPlatform.TELEGRAM, draft());
    text('he', 'googleUnreachable');
    assertEqual(messages(), [['draft', 'cancel', null, 'he:errors.googleUnreachable']], 'what the user got');
    assertEqual(admin, [], 'admin pages');
    assertEqual(aiCalls.length, 0, 'AI calls');
  });

  await check("on demand, Google outage, no draft: R13's text as a message, daily and tomorrow, in the user's language", async () => {
    readOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendTomorrowSummaryToUser(1005);
    await summary.sendDailySummaryToUser(1003);
    text('en', 'googleUnreachable');
    assertEqual(
      sent.map(s => [s.via, s.method, s.chatId, nameOf(s.text), s.format ?? null]),
      [
        ['telegram', 'sendMessage', 1005, 'en:errors.googleUnreachable', MessageFormat.HTML],
        ['telegram', 'sendMessage', 1003, 'he:errors.googleUnreachable', MessageFormat.HTML],
      ],
      'what the users got (via, method, chat, text, format)'
    );
    assertEqual(admin, [], 'admin pages');
  });

  await check("on demand on WhatsApp, Google outage: R13's text through the WhatsApp service", async () => {
    readOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendDailySummaryToUser('972500000006', MessagingPlatform.WHATSAPP);
    text('ru', 'googleUnreachable');
    assertEqual(messages(), [['whatsapp', 'sendMessage', '972500000006', 'ru:errors.googleUnreachable']], 'what the user got');
    assertEqual(admin, [], 'admin pages');
  });

  await check('[guard] on demand, dead token: the token text and an admin warning', async () => {
    readOutcome = failWith('GOOGLE_TOKEN_EXPIRED');
    await summary.sendDailySummaryToUser(1003);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'he:tokenExpired']], 'what the user got');
    assertEqual(admin, ['warning: Token Expired'], 'admin pages');
  });

  await check('[guard] on demand, missing scopes: the scopes text, the token kept, and an admin warning', async () => {
    readOutcome = failWith('GOOGLE_INSUFFICIENT_SCOPES');
    await summary.sendDailySummaryToUser(1003);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'he:insufficientScopes']], 'what the user got');
    assertEqual(cleared, [], 'tokens cleared');
    assertEqual(admin, ['warning: Insufficient Scopes'], 'admin pages');
  });

  await check("[guard] on demand, any other read error: the pipeline's fetch texts and the admin notice (A-28)", async () => {
    readOutcome = async () => {
      throw new Error('connection reset');
    };
    await summary.sendDailySummaryToUser(1004);
    await summary.sendTomorrowSummaryToUser(1004);
    assertEqual(
      messages(),
      [
        ['telegram', 'sendMessage', 1004, 'ru:errors.calendarFetch'],
        ['telegram', 'sendMessage', 1004, 'ru:errors.tomorrowFetch'],
      ],
      'what the user got'
    );
    assertEqual(admin, ['error: Summary Generation', 'error: Summary Generation'], 'admin pages');
  });

  // ---- G2: a failed Google half never hides the FamCal half (spec §4 Summaries) ----

  /** A day read whose Google half had a gap: the FamCal events, marked as digest.ts marks them. */
  const withGap = (gap: string) => async () => Object.assign([ev('sat-home', '2026-10-17T09:00:00+03:00', '2026-10-17T10:00:00+03:00', HOME)], { googleGap: gap });

  await check('G2 on demand, a dead token with FamCal events: the summary goes out with them, then the token text, and the admin is warned', async () => {
    readOutcome = withGap('token');
    await summary.sendDailySummaryToUser(1003);
    assertEqual(aiEvents(), [['sat-home']], 'the events the AI got');
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'AI summary'], ['telegram', 'sendMessage', 1003, 'he:tokenExpired']], 'what the user got');
    assertEqual(admin, ['warning: Token Expired'], 'admin pages');
  });

  await check('G2 on demand, missing scopes with FamCal events: the summary, then the scopes text, and the token kept', async () => {
    readOutcome = withGap('scopes');
    await summary.sendDailySummaryToUser(1003);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'AI summary'], ['telegram', 'sendMessage', 1003, 'he:insufficientScopes']], 'what the user got');
    assertEqual(cleared, [], 'tokens cleared');
  });

  await check('G2 on demand, Google unreachable with FamCal events: the summary goes out with them, the prompt flagged and the outage line under it', async () => {
    readOutcome = withGap('unavailable');
    await summary.sendDailySummaryToUser(1003);
    assertEqual(aiEvents(), [['sat-home']], 'the events the AI got');
    assert(aiCalls[0].context.googleUnavailable === true, `the prompt context: ${show(aiCalls[0].context)}`);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, `AI summary\n\n<i>${text('he', 'googleOutageNote')}</i>`]], 'what the user got');
    assertEqual(admin, [], 'admin pages');
  });

  await check('scheduled: the reader reads today with the scheduled 30 s deadline; the text and the voice note go out', async () => {
    scheduledUsers = [GOOGLE_USER];
    const result = await summary.sendDailySummaryToAll();
    assertEqual(result.processed, 1, 'users processed');
    assertEqual(readsOf(), [['2026-10-17', IL, GOOGLE_IDS, { mode: 'scheduled', deadlineMs: 30000 }]], 'reader reads (day, tz, ids, read)');
    assert(digestCalls[0].read === digest.SCHEDULED_READ, "the read is not digest.ts's SCHEDULED_READ");
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'AI summary']], 'messages');
    assertEqual(voice, ['AI summary'], 'the voice text');
  });

  await check('nothing left over: no unhandled rejection, no network', async () => {
    await new Promise(resolve => setImmediate(resolve));
    assertEqual(unhandled.map(String), [], 'unhandled rejections');
    assertEqual(networkAttempts, [], 'network attempts');
  });

  Object.assign(console, original);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // The pipeline's 50 s operation timer is never cleared; don't wait for it.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  Object.assign(console, original);
  console.error(err);
  process.exit(1);
});
