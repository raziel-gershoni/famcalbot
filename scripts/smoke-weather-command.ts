// /weather after c79945d: the photo is drawn from the weather data alone and sent without
// waiting for the AI forecast, which runs only for the voice note, or as the reply when the
// photo fails. Drives the real handleWeatherCommand through the real executeCommand, with
// the user lookup, quota, weather APIs, infographic renderer, AI, voice note, Redis and both
// messaging services faked. The clock is frozen for dates; event times are real (monotonic).
// The pipeline's typing interval (TYPING_INTERVAL_MS, 4 s) runs 40x faster here, so a 1.5 s
// forecast spans many "recording" ticks. No network.
// When the photo fails and the forecast comes back empty, the reply is now skipped, so the
// user gets nothing at all; before, the empty send failed into the pipeline's error reply.
//
// Run under both clocks:
//   TZ=UTC npx tsx scripts/smoke-weather-command.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-weather-command.ts

import Module from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MessageFormat, MessagingPlatform } from '../src/services/messaging/types';
import type { IMessagingService, MessageOptions, PhotoOptions } from '../src/services/messaging/types';
import type { AICompletionResult } from '../src/services/ai-provider';
import type { WeatherFormatResult } from '../src/services/weather/formatter';
import type { InfographicConfig } from '../src/services/weather/infographic';
import type { AirQualityData, UserConfig, WeatherData } from '../src/types';

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

// ---- Environment: fakes only, set before anything under test loads ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- Clocks: Date is frozen; the event timeline uses the monotonic clock ----

/** 22:30 on Tue 13 Oct 2026 in New York, already Wed 14 Oct in UTC and Israel. */
const FROZEN = Date.parse('2026-10-14T02:30:00Z');
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FROZEN);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return FROZEN;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

const now = () => performance.now();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(cond: () => boolean, timeoutMs: number, what: string) {
  const deadline = now() + timeoutMs;
  while (!cond()) {
    if (now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ---- Intervals: tracked (to catch a leak) and run TIME_SCALE times faster ----

const TIME_SCALE = 40;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
type TrackedInterval = {
  requestedMs: number; label: string; run: string; createdAt: number; clearedAt?: number;
  /** Still running when the next run began, and stopped there by the suite (see runWeather). */
  stoppedBySuite?: boolean; handle: ReturnType<typeof realSetInterval>;
};
const intervals: TrackedInterval[] = [];
/** startTypingInterval sends one indicator right before it sets its interval; this names it. */
let lastTypingLabel = '';
let currentRun = '';
globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const handle = realSetInterval(fn, Math.max(1, Math.round((ms ?? 0) / TIME_SCALE)), ...rest);
  intervals.push({ requestedMs: ms ?? 0, label: lastTypingLabel, run: currentRun, createdAt: now(), handle });
  return handle;
}) as unknown as typeof setInterval;
globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
  const tracked = intervals.find(i => i.handle === handle);
  if (tracked && tracked.clearedAt === undefined) tracked.clearedAt = now();
  realClearInterval(handle);
}) as typeof clearInterval;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

// ---- Fixtures ----

const WEATHER: WeatherData = {
  location: 'Brooklyn, United States',
  current: { temperature: 14, feelsLike: 12, humidity: 70, weatherCode: 3, windSpeed: 12, windDirection: 200, uvIndex: 0 },
  today: { tempMax: 18, tempMin: 11, precipitationProbability: 10, weatherCode: 3, sunrise: '2026-10-13T07:05', sunset: '2026-10-13T18:20', uvIndexMax: 3 },
  tomorrow: { tempMax: 17, tempMin: 10, precipitationProbability: 60, weatherCode: 61, sunrise: '2026-10-14T07:06', sunset: '2026-10-14T18:19', uvIndexMax: 2 },
  hourly: {
    time: Array.from({ length: 48 }, (_, h) => `2026-10-${13 + Math.floor(h / 24)}T${String(h % 24).padStart(2, '0')}:00`),
    temperature: Array.from({ length: 48 }, () => 14),
    precipitation_probability: Array.from({ length: 48 }, (_, h) => (h >= 30 && h < 36 ? 60 : 5)),
    precipitation: Array.from({ length: 48 }, () => 0),
    weatherCode: Array.from({ length: 48 }, () => 3),
    windSpeed: Array.from({ length: 48 }, () => 12),
    humidity: Array.from({ length: 48 }, () => 70),
    windDirection: Array.from({ length: 48 }, () => 200),
  },
  daily: [13, 14, 15].map(d => ({
    date: `2026-10-${d}`, tempMax: 18, tempMin: 11, precipitationProbability: d === 14 ? 60 : 10, weatherCode: 3,
    sunrise: `2026-10-${d}T07:05`, sunset: `2026-10-${d}T18:20`, uvIndexMax: 3, windSpeedMax: 15, windDirection: 200, humidity: 70,
  })),
};
const AIR: AirQualityData = { hourly: { time: ['2026-10-13T22:00'], pm10: [12], pm2_5: [6], dust: [0] } };
const USER_TZ = 'America/New_York';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const AI_TEXT = '<b>Today & Tomorrow</b>\nGood evening Dana, a cloudy night ahead.';

let user: UserConfig;
function makeUser(voice: boolean, admin = true): UserConfig {
  return {
    id: 7, telegramId: 5551, name: 'Dana', language: 'en', location: 'Brooklyn', culture: 'jewish', isAdmin: admin,
    voiceSummaryEnabled: voice, googleRefreshToken: 'refresh-token', calendarSource: 'GOOGLE', suspendedAt: null,
    calendarAssignments: [{ calendarId: 'primary', labels: ['primary'], name: 'Dana', color: '#000' }],
  } as unknown as UserConfig;
}

// ---- Fakes ----

type Call = {
  at: number; platform: MessagingPlatform; method: 'sendPhoto' | 'sendMessage' | 'sendTypingIndicator';
  chatId: number | string; text?: string; photo?: Buffer; typingType?: string; options?: PhotoOptions | MessageOptions;
};
let calls: Call[] = [];
function makeService(platform: MessagingPlatform): IMessagingService {
  return {
    sendPhoto: async (chatId: number | string, photo: Buffer, options?: PhotoOptions) => {
      calls.push({ at: now(), platform, method: 'sendPhoto', chatId, photo, options });
      return 101;
    },
    sendMessage: async (chatId: number | string, text: string, options?: MessageOptions) => {
      // As Telegram answers an empty text: 400, nothing delivered.
      if (!text.trim()) throw new Error('400 Bad Request: message text is empty');
      calls.push({ at: now(), platform, method: 'sendMessage', chatId, text, options });
      return 102;
    },
    sendTypingIndicator: async (chatId: number | string, _messageId?: string, typingType?: 'text' | 'audio' | 'photo') => {
      lastTypingLabel = `${platform}:${typingType}`;
      calls.push({ at: now(), platform, method: 'sendTypingIndicator', chatId, typingType });
    },
  } as unknown as IMessagingService;
}
const telegram = makeService(MessagingPlatform.TELEGRAM);
const whatsapp = makeService(MessagingPlatform.WHATSAPP);

/** What the infographic renderer does: draw, draw nothing, or throw; after `delayMs`. */
let infographicMode: { kind: 'buffer' | 'null' | 'throw'; delayMs: number } = { kind: 'buffer', delayMs: 0 };
let infographicConfigs: InfographicConfig[] = [];
async function fakeInfographic(config: InfographicConfig): Promise<Buffer | null> {
  infographicConfigs.push(config);
  if (infographicMode.delayMs) await sleep(infographicMode.delayMs);
  if (infographicMode.kind === 'throw') throw new Error('satori exploded');
  return infographicMode.kind === 'buffer' ? PNG : null;
}

/** The AI under the real formatWeatherAI: answers AI_TEXT after `aiDelayMs`. */
let aiDelayMs = 0;
let aiText = AI_TEXT;
let aiCalls: { at: number; doneAt?: number }[] = [];
async function fakeAI(_prompt: string): Promise<AICompletionResult> {
  const call: { at: number; doneAt?: number } = { at: now() };
  aiCalls.push(call);
  if (aiDelayMs) await sleep(aiDelayMs);
  call.doneAt = now();
  return { text: `  ${aiText}  `, usage: { inputTokens: 900, outputTokens: 400 }, stopReason: 'STOP', model: 'Gemini Test', durationMs: aiDelayMs };
}

/**
 * formatWeatherAI wrapped: records its arguments and when its promise settles, then runs
 * the real one ('real') or rejects after `delayMs` ('reject').
 */
type FormatWeatherAI = typeof import('../src/services/weather/formatter').formatWeatherAI;
let forecastMode: { kind: 'real' } | { kind: 'reject'; delayMs: number } = { kind: 'real' };
type ForecastCall = { at: number; args: unknown[]; settledAt?: number; result?: WeatherFormatResult; error?: unknown };
let forecastCalls: ForecastCall[] = [];
const wrapFormatter = (real: Record<string, unknown>) => ({
  ...real,
  formatWeatherAI: (...args: Parameters<FormatWeatherAI>) => {
    const call: ForecastCall = { at: now(), args };
    forecastCalls.push(call);
    const mode = forecastMode;
    // Stamped inside the chain the caller gets, so before its handlers run. No rejection
    // handler is added here: whether a rejection goes unhandled is what check 5 watches.
    return mode.kind === 'reject'
      ? sleep(mode.delayMs).then((): WeatherFormatResult => {
        call.settledAt = now();
        call.error = new Error('forecast boom');
        throw call.error;
      })
      : (real.formatWeatherAI as FormatWeatherAI)(...args).then(result => {
        call.settledAt = now();
        call.result = result;
        return result;
      });
  },
});

type VoiceCall = { at: number; chatId: number | string; summary: string; user: UserConfig; service: unknown; showProgress: unknown; platform: unknown; waMessageId: unknown; kind: unknown };
let voiceCalls: VoiceCall[] = [];
let usageCalls: unknown[][] = [];
let redisSets: unknown[][] = [];
type Log = { level: string; text: string };
let logs: Log[] = [];

const SRC = path.resolve(__dirname, '../src');

/** Modules replaced by fakes, by file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/services/user-service.ts`]: {
    getUserByIdentifier: async () => user,
    getUserByTelegramId: async () => user,
    getOrCreateUser: async () => user,
  },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform, MessageFormat,
    getMessagingService: (platform: MessagingPlatform) => (platform === MessagingPlatform.WHATSAPP ? whatsapp : telegram),
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (chatId: number | string, summary: string, u: UserConfig, service: unknown, showProgress: unknown, platform: unknown, waMessageId: unknown, kind: unknown) => {
      voiceCalls.push({ at: now(), chatId, summary, user: u, service, showProgress, platform, waMessageId, kind });
    },
    sendWeeklyVoiceMessage: async () => { throw new Error('weekly voice sent from /weather'); },
  },
  [`${SRC}/services/telegram/summary.ts`]: {
    sendDailySummaryToUser: async () => {}, sendTomorrowSummaryToUser: async () => {}, routeTextMessage: async () => {},
  },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async () => ({ allowed: true }),
    incrementUsage: async (...args: unknown[]) => { usageCalls.push(args); },
  },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/utils/prisma.ts`]: { prisma: {} },
  [`${SRC}/utils/redis.ts`]: {
    redis: { set: async (...args: unknown[]) => { redisSets.push(args); return 'OK'; }, get: async () => null, del: async () => 0 },
  },
  [`${SRC}/utils/error-notifier.ts`]: { notifyAdminError: async () => {} },
  [`${SRC}/services/magic-link.ts`]: { generateMagicLink: async () => 'https://famcal.test/magic' },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: fakeAI },
  [`${SRC}/services/weather/infographic.tsx`]: { generateWeatherInfographic: fakeInfographic },
  [`${SRC}/services/weather/air-quality.ts`]: { fetchAirQuality: async () => AIR },
  [`${SRC}/services/weather/open-meteo.ts`]: real => ({ ...real, fetchWeather: async () => WEATHER }),
  [`${SRC}/services/weather/geocoding.ts`]: real => ({ ...real, getTimezone: async () => USER_TZ }),
  [`${SRC}/services/weather/formatter.ts`]: wrapFormatter,
};

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see eval-voice-show.ts); the
// real formatter imports it.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
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

// commands.ts loads the weather modules, Redis and the magic link with import(), which goes
// through the ES module loader instead; it gets the same fake, served as an ES module.
(globalThis as { weatherSmokeFake?: (file: string) => object }).weatherSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { weatherSmokeFake: (file: string) => object }).weatherSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.weatherSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Running one /weather ----

const TG_CHAT = 5551;
const WA_CHAT = '972500000007';

type Run = { startedAt: number; returnedAt: number };

async function runWeather(opts: {
  platform?: MessagingPlatform;
  voice: boolean;
  admin?: boolean;
  infographic?: { kind: 'buffer' | 'null' | 'throw'; delayMs?: number };
  aiDelayMs?: number;
  aiText?: string;
  forecast?: { kind: 'real' } | { kind: 'reject'; delayMs: number };
}): Promise<Run> {
  const { handleWeatherCommand } = await import('../src/services/telegram/commands');
  // An interval an earlier run left running is stopped here so it cannot tick into this
  // run's recordings. It stays uncleared, and the last check reports it as a leak.
  for (const i of intervals) {
    if (i.clearedAt === undefined && !i.stoppedBySuite) {
      i.stoppedBySuite = true;
      realClearInterval(i.handle);
    }
  }
  calls = [];
  voiceCalls = [];
  usageCalls = [];
  redisSets = [];
  infographicConfigs = [];
  forecastCalls = [];
  aiCalls = [];
  logs = [];
  user = makeUser(opts.voice, opts.admin);
  infographicMode = { kind: opts.infographic?.kind ?? 'buffer', delayMs: opts.infographic?.delayMs ?? 0 };
  aiDelayMs = opts.aiDelayMs ?? 0;
  aiText = opts.aiText ?? AI_TEXT;
  forecastMode = opts.forecast ?? { kind: 'real' };
  const platform = opts.platform ?? MessagingPlatform.TELEGRAM;
  const chatId = platform === MessagingPlatform.WHATSAPP ? WA_CHAT : TG_CHAT;
  currentRun = `${platform} voice=${opts.voice} infographic=${infographicMode.kind} forecast=${forecastMode.kind}`;

  const startedAt = now();
  await handleWeatherCommand(chatId, chatId, platform);
  return { startedAt, returnedAt: now() };
}

const sentBy = (method: Call['method'], platform?: MessagingPlatform) =>
  calls.filter(c => c.method === method && (!platform || c.platform === platform));
const indicators = (typingType: string, platform?: MessagingPlatform) =>
  sentBy('sendTypingIndicator', platform).filter(c => c.typingType === typingType);
const intervalsLabelled = (label: string, since: number) => intervals.filter(i => i.label === label && i.createdAt >= since);
const errorsMatching = (needle: string) => logs.filter(l => l.level === 'error' && l.text.includes(needle));
const forecastArgsOk = (c: ForecastCall) => c.args[6] === false && c.args[1] === 'en' && c.args[3] === USER_TZ && c.args[7] === AIR;

async function main() {
  // Capture the services' logs; some checks read them.
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capture = (level: string) => (...args: unknown[]) => {
    logs.push({ level, text: args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ') });
  };
  console.log = capture('log');
  console.warn = capture('warn');
  console.error = capture('error');
  console.info = capture('info');

  // Load the formatter through the hooks, as commands.ts will, for the expected infographic input.
  const { buildInfographicConfig } = await import('../src/services/weather/formatter');

  await check('1. voice off, photo drawn: the photo goes out, no forecast is written, no text', async () => {
    const run = await runWeather({ voice: false });
    await sleep(300);
    const photos = sentBy('sendPhoto');
    assert(photos.length === 1 && photos[0].photo === PNG && photos[0].chatId === TG_CHAT, `photos ${photos.length}`);
    const markup = JSON.stringify((photos[0].options as PhotoOptions | undefined)?.replyMarkup ?? null);
    assert(markup.includes('share-story?user_id=7&source=cached') && markup.includes('web_app'), `reply markup ${markup}`);
    assert(forecastCalls.length === 0 && aiCalls.length === 0, `forecast calls ${forecastCalls.length}, AI calls ${aiCalls.length}`);
    assert(sentBy('sendMessage').length === 0, `text messages: ${sentBy('sendMessage').map(c => c.text).join(' | ')}`);
    assert(voiceCalls.length === 0, `voice calls ${voiceCalls.length}`);
    assert(indicators('audio').length === 0, `audio indicators ${indicators('audio').length}`);
    assert(redisSets.length === 1 && redisSets[0][1] === PNG.toString('base64'), `story image cache writes ${redisSets.length}`);
    assert(run.returnedAt - run.startedAt < 500, `command took ${Math.round(run.returnedAt - run.startedAt)} ms`);
  });

  await check('2. voice on, photo drawn, forecast 1.5 s: photo first, "recording" while it is written, then the voice', async () => {
    const run = await runWeather({ voice: true, aiDelayMs: 1500 });
    await waitUntil(() => voiceCalls.length > 0, 4000, 'the voice note');
    const forecast = forecastCalls[0];
    // Long enough for several more ticks of the sped-up interval.
    await sleep((4000 / TIME_SCALE) * 6);

    const photo = sentBy('sendPhoto')[0];
    assert(!!photo && forecast?.settledAt !== undefined, `photo ${!!photo}, forecast settled ${forecast?.settledAt}`);
    assert(photo.at < forecast.settledAt! - 1000, `photo at +${Math.round(photo.at - run.startedAt)} ms, forecast settled at +${Math.round(forecast.settledAt! - run.startedAt)} ms`);
    assert(run.returnedAt < forecast.settledAt!, 'the command waited for the forecast');
    assert(forecastCalls.length === 1 && aiCalls.length === 1 && forecastArgsOk(forecast), `forecast calls ${forecastCalls.length}, AI calls ${aiCalls.length}, args ok ${forecastArgsOk(forecast)}`);
    assert(sentBy('sendMessage').length === 0, 'a text message went out with the photo');

    assert(voiceCalls.length === 1, `voice calls ${voiceCalls.length}`);
    const voice = voiceCalls[0];
    assert(voice.summary === forecast.result?.detailed && voice.summary === AI_TEXT, `voice text ${JSON.stringify(voice.summary)}`);
    assert(forecast.result?.brief !== voice.summary, 'the voice got the brief (admin footer) instead of the detailed text');
    assert(voice.kind === 'weather' && voice.platform === MessagingPlatform.TELEGRAM && voice.chatId === TG_CHAT && voice.user === user, `voice args ${JSON.stringify({ kind: voice.kind, platform: voice.platform, chatId: voice.chatId })}`);
    assert(voice.at >= forecast.settledAt!, 'voice sent before the forecast settled');

    const audio = indicators('audio', MessagingPlatform.TELEGRAM);
    const whilePending = audio.filter(c => c.at > photo.at && c.at < forecast.settledAt!);
    assert(whilePending.length >= 5, `"recording" indicators while the forecast was pending: ${whilePending.length}`);
    const after = audio.filter(c => c.at > forecast.settledAt!);
    assert(after.length === 0, `${after.length} "recording" indicator(s) after the forecast settled`);
    const recording = intervalsLabelled('telegram:audio', run.startedAt);
    assert(recording.length === 1, `"recording" intervals started: ${recording.length}`);
    assert(recording[0].clearedAt !== undefined && recording[0].clearedAt >= forecast.settledAt! && recording[0].clearedAt - forecast.settledAt! < 50,
      `"recording" interval cleared at ${recording[0].clearedAt === undefined ? 'never' : `+${Math.round(recording[0].clearedAt - forecast.settledAt!)} ms after the forecast`}`);
  });

  await check('3. voice off, no photo: the forecast is written once and its brief is the reply', async () => {
    await runWeather({ voice: false, infographic: { kind: 'null' }, aiDelayMs: 100 });
    await sleep(200);
    assert(forecastCalls.length === 1 && aiCalls.length === 1, `forecast calls ${forecastCalls.length}, AI calls ${aiCalls.length}`);
    assert(forecastArgsOk(forecastCalls[0]), `forecast args ${JSON.stringify(forecastCalls[0].args.slice(1, 7))}`);
    assert(sentBy('sendPhoto').length === 0, 'a photo went out');
    const messages = sentBy('sendMessage');
    assert(messages.length === 1, `text messages ${messages.length}`);
    assert(messages[0].text === forecastCalls[0].result?.brief && messages[0].text!.startsWith(AI_TEXT), `reply ${JSON.stringify(messages[0].text)}`);
    assert((messages[0].options as MessageOptions | undefined)?.format === MessageFormat.HTML, 'reply is not HTML');
    assert(voiceCalls.length === 0 && indicators('audio').length === 0, `voice ${voiceCalls.length}, audio indicators ${indicators('audio').length}`);
  });

  await check('4. voice on, infographic throws: one forecast serves both the reply and the voice', async () => {
    const run = await runWeather({ voice: true, infographic: { kind: 'throw' }, aiDelayMs: 200 });
    await waitUntil(() => voiceCalls.length > 0, 3000, 'the voice note');
    await sleep(200);
    assert(forecastCalls.length === 1 && aiCalls.length === 1, `forecast calls ${forecastCalls.length}, AI calls ${aiCalls.length}`);
    assert(forecastArgsOk(forecastCalls[0]), `forecast args ${JSON.stringify(forecastCalls[0].args.slice(1, 7))}`);
    const forecast = forecastCalls[0].result!;
    const messages = sentBy('sendMessage');
    assert(sentBy('sendPhoto').length === 0, 'a photo went out');
    assert(messages.length === 1 && messages[0].text === forecast.brief, `reply ${JSON.stringify(messages.map(m => m.text))}`);
    assert(voiceCalls.length === 1 && voiceCalls[0].summary === forecast.detailed && forecast.detailed === AI_TEXT, `voice ${JSON.stringify(voiceCalls.map(v => v.summary))}`);
    assert(voiceCalls[0].kind === 'weather', `voice kind ${voiceCalls[0].kind}`);
    assert(errorsMatching('[Weather] Infographic generation failed').length === 1, 'infographic failure not logged');
    const recording = intervalsLabelled('telegram:audio', run.startedAt);
    assert(recording.every(i => i.clearedAt !== undefined), '"recording" interval left running');
  });

  await check('5. voice on, photo drawn, forecast rejects (late and early): logged, indicator stops, no voice, nothing unhandled', async () => {
    for (const variant of [
      { name: 'late', forecast: { kind: 'reject' as const, delayMs: 400 }, infographicDelayMs: 0 },
      { name: 'early', forecast: { kind: 'reject' as const, delayMs: 0 }, infographicDelayMs: 100 },
    ]) {
      unhandled.length = 0;
      const run = await runWeather({ voice: true, forecast: variant.forecast, infographic: { kind: 'buffer', delayMs: variant.infographicDelayMs } });
      await waitUntil(() => errorsMatching('[Weather] Voice generation failed').length > 0, 2000, `${variant.name}: the voice failure log`);
      await sleep((4000 / TIME_SCALE) * 4);
      const settledAt = forecastCalls[0]?.settledAt;
      assert(settledAt !== undefined, `${variant.name}: forecast never settled`);
      assert(unhandled.length === 0, `${variant.name}: unhandledRejection fired: ${unhandled.map(String).join(', ')}`);
      assert(sentBy('sendPhoto').length === 1, `${variant.name}: photos ${sentBy('sendPhoto').length}`);
      const failure = errorsMatching('[Weather] Voice generation failed');
      assert(failure.length === 1 && failure[0].text.includes('forecast boom') && failure[0].text.includes(String(TG_CHAT)), `${variant.name}: log ${JSON.stringify(failure)}`);
      assert(voiceCalls.length === 0, `${variant.name}: voice calls ${voiceCalls.length}`);
      const recording = intervalsLabelled('telegram:audio', run.startedAt);
      assert(recording.length === 1 && recording[0].clearedAt !== undefined, `${variant.name}: "recording" interval ${recording.length ? 'never cleared' : 'never started'}`);
      const late = indicators('audio').filter(c => c.at > Math.max(settledAt!, recording[0].clearedAt!));
      assert(late.length === 0, `${variant.name}: ${late.length} "recording" indicator(s) after the failure`);
      assert(sentBy('sendMessage').length === 0, `${variant.name}: unexpected text ${sentBy('sendMessage').map(c => c.text).join(' | ')}`);
    }
  });

  await check('6. WhatsApp, voice on: no "recording" indicator, photo without buttons, voice still sent', async () => {
    const run = await runWeather({ platform: MessagingPlatform.WHATSAPP, voice: true, aiDelayMs: 300 });
    await waitUntil(() => voiceCalls.length > 0, 3000, 'the voice note');
    await sleep(200);
    assert(indicators('audio').length === 0, `"recording" indicators ${indicators('audio').length}`);
    assert(intervalsLabelled('whatsapp:audio', run.startedAt).length === 0, 'a "recording" interval was started on WhatsApp');
    assert(calls.every(c => c.platform === MessagingPlatform.WHATSAPP), 'something went to Telegram');
    const photos = sentBy('sendPhoto');
    assert(photos.length === 1 && photos[0].chatId === WA_CHAT, `photos ${photos.length}`);
    assert((photos[0].options as PhotoOptions | undefined)?.replyMarkup === undefined, 'WhatsApp photo carries reply markup');
    assert(voiceCalls.length === 1 && voiceCalls[0].platform === MessagingPlatform.WHATSAPP && voiceCalls[0].chatId === WA_CHAT, `voice ${JSON.stringify(voiceCalls.map(v => [v.platform, v.chatId]))}`);
    assert(voiceCalls[0].summary === AI_TEXT && voiceCalls[0].kind === 'weather', `voice text ${JSON.stringify(voiceCalls[0].summary)}`);
    assert(sentBy('sendMessage').length === 0, 'a text message went out with the photo');
  });

  await check('7. the infographic gets buildInfographicConfig(weather, language, timezone, culture, airQuality)', async () => {
    await runWeather({ voice: false });
    assert(infographicConfigs.length === 1, `infographic calls ${infographicConfigs.length}`);
    const expected = buildInfographicConfig(WEATHER, 'en', USER_TZ, 'jewish', AIR);
    assert(isDeepStrictEqual(infographicConfigs[0], expected), `got ${JSON.stringify(infographicConfigs[0]).slice(0, 300)}`);
    // The user's own day (New York), not the server's or UTC's.
    assert(expected.timezone === USER_TZ && expected.dateStr === 'Tuesday, October 13, 2026' && expected.hebrewDateStr === '2 Cheshvan 5787',
      `dateStr ${expected.dateStr}, hebrewDateStr ${expected.hebrewDateStr}`);
  });

  await check('8. usage is counted once per command', async () => {
    for (const opts of [
      { voice: false },
      { voice: true, aiDelayMs: 50 },
      { voice: false, infographic: { kind: 'null' as const } },
      { voice: true, infographic: { kind: 'throw' as const } },
      { voice: true, platform: MessagingPlatform.WHATSAPP },
    ]) {
      await runWeather(opts);
      await sleep(100);
      assert(usageCalls.length === 1 && usageCalls[0][0] === 7 && usageCalls[0][1] === 'textSummaries', `usage calls for ${JSON.stringify(opts)}: ${JSON.stringify(usageCalls)}`);
    }
  });

  await check('9. no photo and an empty forecast: the user still gets a reply', async () => {
    await runWeather({ voice: false, admin: false, infographic: { kind: 'null' }, aiText: '' });
    await sleep(100);
    assert(forecastCalls.length === 1 && forecastCalls[0].result?.brief === '', `forecast ${JSON.stringify(forecastCalls[0]?.result)}`);
    const replies = calls.filter(c => c.method !== 'sendTypingIndicator');
    assert(replies.length > 0, `nothing was delivered: no photo, no text, no error message (brief ${JSON.stringify(forecastCalls[0].result?.brief)}, usage counted ${usageCalls.length}x)`);
  });

  await check('nothing left running: every interval cleared, no network', async () => {
    await sleep(100);
    const running = intervals.filter(i => i.clearedAt === undefined);
    assert(running.length === 0, `${running.length} interval(s) never cleared: ${running.map(i => `${i.label} from [${i.run}]`).join(', ')}`);
    assert(intervals.every(i => i.requestedMs === 4000), `interval periods ${[...new Set(intervals.map(i => i.requestedMs))].join(',')}`);
    assert(networkAttempts.length === 0, `network attempts: ${networkAttempts.length}`);
  });

  Object.assign(console, original);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
