// Smoke test for the Shabbat and Yom Tov pause (plan docs/superpowers/plans/2026-10-28-zmanim-reminders.md, Task 2):
// isPaused (src/services/zmanim/pause.ts, with the windows and the place in pause-windows.ts) and the audit of every
// place the app sends a message, so a send nobody classified fails here.
//
// What it pins:
//   - the answer: the switch off (or unset) is never paused and does no work; from sunset on the eve (the owner's
//     ruling 2026-10-28: not candle lighting, which is 20 minutes earlier and sends) to the end of Shabbat in the
//     person's own place, the minute either side of both edges; Yom Tov next to Shabbat as one
//     window; a two-day Yom Tov abroad but one day in Israel; Rosh Hashana's two days in Israel; each person by their
//     own place at the same instant; the community's own edge (Sephardi and Ashkenazi end Shabbat at different minutes);
//   - the place: saved coordinates; a place name with none, filled once (and the pause then uses them); no usable
//     location falls back to the main city of the timezone (Asia/Jerusalem gives Jerusalem), logged once a day per
//     person; a zone with no main city is not paused and says so;
//   - the cache: one computation per person per day, kept on globalThis, recomputed on another day or another place,
//     and never holding the switch itself;
//   - a failure is logged and read as not paused (it never throws into a pass), and a skipped send is logged
//     "[pause] skipped <kind> for <userId>";
//   - the audit: every file that sends a message to a person is either paused (it calls isPaused) or listed here with
//     the reason it is not (a reply to the person's own action, or a message to the admin).
//
// No network, no database: Redis, Prisma, the geocoding fetch and error capture are faked. Process zone: this file
// re-runs itself once per server zone (UTC, Asia/Jerusalem, America/New_York) as child processes, so a plain
// `npx tsx scripts/smoke-pause.ts` and `bash scripts/ci-smokes.sh` both cover all three.
//   npx tsx scripts/smoke-pause.ts

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'PAUSE_SMOKE_CHILD';

// ---- The parent: one child per process zone ----

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      zone =>
        new Promise<{ zone: string; code: number; text: string }>(resolve => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', chunk => (text += chunk));
          child.stderr.on('data', chunk => (text += chunk));
          child.on('close', code => resolve({ zone, code: code ?? 1, text }));
        })
    )
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Checks ----

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build before the module under test loads ----

const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string; _cache: Record<string, unknown> };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type PauseUser = {
  id: number;
  location?: string;
  latitude?: number | null;
  longitude?: number | null;
  elevationM?: number | null;
  zmanimCommunity?: string | null;
  pauseOnShabbat?: boolean | null;
};
type Pause = { isPaused: (user: PauseUser, at?: Date, skipped?: string) => Promise<boolean> };
type Windows = {
  __resetPauseForTests: () => void;
  MAIN_CITIES: Record<string, string>;
  mainCityPlace: (zone: string) => { latitude: number; longitude: number; elevationM: number | null; timeZone: string } | null;
};
type Hebcal = { Location: { lookup: (name: string) => { getTzid: () => string } | undefined } };

// ---- The world: Redis, Prisma, the geocoding fetch, error capture ----

type Row = Record<string, unknown>;
const redisStore = new Map<string, unknown>();
let redisReads = 0;
const dbUsers = new Map<number, Row>();
let dbCalls = 0;
const requests: string[] = [];
const captured: { kind: string; context: string; message: string }[] = [];
const logs: string[] = [];

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const HARISH_BOX = ['32.4418', '32.4818', '35.0255', '35.0655'];
let nominatim: () => Response = () => json([{ lat: '32.46182', lon: '35.04555', boundingbox: HARISH_BOX }]);

async function fakeFetchWithTimeout(url: string): Promise<Response> {
  requests.push(url);
  const parsed = new URL(url);
  if (parsed.host === 'nominatim.openstreetmap.org') return nominatim();
  if (parsed.host === 'api.open-meteo.com' && parsed.pathname === '/v1/elevation') {
    const points = (parsed.searchParams.get('latitude') ?? '').split(',').length;
    return json({ elevation: Array.from({ length: points }, () => 290) });
  }
  if (parsed.host === 'api.open-meteo.com') return json({ timezone: 'Asia/Jerusalem' });
  throw new Error(`unexpected request: ${url}`);
}

function installStubs(): void {
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new (Module as unknown as new (id: string) => Row)(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    internals._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', {
    redis: {
      get: async (key: string) => { redisReads++; return redisStore.has(key) ? redisStore.get(key) : null; },
      set: async (key: string, value: unknown) => { redisStore.set(key, value); return 'OK'; },
      del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
    },
  });
  stub('src/utils/prisma.ts', {
    prisma: {
      user: {
        findUnique: async (args: { where: { id: number }; select: Row }) => {
          dbCalls++;
          const row = dbUsers.get(args.where.id);
          return row ? Object.fromEntries(Object.keys(args.select).map(key => [key, row[key]])) : null;
        },
        updateMany: async (args: { where: { id: number; location: string }; data: Row }) => {
          dbCalls++;
          const row = dbUsers.get(args.where.id);
          if (!row || row.location !== args.where.location) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      },
    },
  });
  stub('src/lib/error-capture.ts', {
    captureError: (error: unknown, context: string) => { captured.push({ kind: 'error', context, message: error instanceof Error ? error.message : String(error) }); },
    captureWarning: (message: string, context: string) => { captured.push({ kind: 'warning', context, message }); },
    captureInfo: (message: string, context: string) => { captured.push({ kind: 'info', context, message }); },
  });
  stub('src/services/calendar.ts', { getUserCalendarTimezone: async () => null });
  stub('src/services/weather/geocoding.ts', {
    fetchWithTimeout: fakeFetchWithTimeout,
    geocodeLocation: async () => { throw new Error('the cached geocode path was used'); },
  });
}

function resetWorld(): void {
  redisStore.clear();
  redisReads = 0;
  dbUsers.clear();
  dbCalls = 0;
  requests.length = 0;
  captured.length = 0;
  logs.length = 0;
  nominatim = () => json([{ lat: '32.46182', lon: '35.04555', boundingbox: HARISH_BOX }]);
  (globalThis as unknown as { __zmanimPlaceFill?: { running: Map<string, unknown>; filled: Map<string, unknown>; failedAt: Map<string, number> } }).__zmanimPlaceFill?.filled.clear();
  (globalThis as unknown as { __zmanimPlaceFill?: { running: Map<string, unknown>; filled: Map<string, unknown>; failedAt: Map<string, number> } }).__zmanimPlaceFill?.failedAt.clear();
  windows.__resetPauseForTests();
}

// ---- People and places ----

const JERUSALEM = { latitude: 31.778, longitude: 35.235, elevationM: 754 };
const NEW_YORK = { latitude: 40.7127, longitude: -74.006, elevationM: 10 };
const HARISH = { latitude: 32.46182, longitude: 35.04555, elevationM: 290 };
const ZONE_OF = new Map<number, string>();

/** A person whose switch is on, in a place, with their zone cached the way resolveUserTimezone finds it. */
function person(id: number, zone: string, place: { latitude: number; longitude: number; elevationM: number | null } | null, over: Partial<PauseUser> = {}): PauseUser {
  redisStore.set(`tz:user:${id}`, zone);
  ZONE_OF.set(id, zone);
  return { id, location: place ? 'somewhere' : '', latitude: place?.latitude ?? null, longitude: place?.longitude ?? null, elevationM: place?.elevationM ?? null, zmanimCommunity: 'sephardi', pauseOnShabbat: true, ...over };
}

const at = (iso: string): Date => new Date(iso);
const minute = (iso: string, deltaMinutes: number): Date => new Date(Date.parse(iso) + deltaMinutes * 60_000);

/* eslint-disable @typescript-eslint/no-require-imports */
installStubs();
const pause = require('../src/services/zmanim/pause') as Pause;
const windows = require('../src/services/zmanim/pause-windows') as Windows;
const hebcal = require('@hebcal/core') as Hebcal;
const compute = require('../src/services/zmanim/compute') as { shabbatYomTovWindows: (range: { from: Date; to: Date }, place: { latitude: number; longitude: number; elevationM: number | null; timeZone: string }, community: string) => Array<[Date, Date]> };
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- The audit of every send ----

/** Every .ts/.tsx file under these roots (and instrumentation.ts), minus tests and generated code. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(path.relative(ROOT, full));
    }
  };
  for (const root of ['src', 'app']) walk(path.join(ROOT, root));
  out.push('instrumentation.ts');
  return out.sort();
}

/** A call that puts a message in front of a person (Telegram or WhatsApp), or the sender helpers the files use. */
const SEND_CALL = /\.(sendMessage|sendMessageDraft|sendVoice|sendAudio|sendPhoto|sendDocument|sendMediaGroup|sendInvoice|sendLocation|sendContact|sendPoll|sendSticker|sendAnimation|sendVideo|sendVideoNote|forwardMessage|copyMessage)\(|\b(sendVoiceMessage|sendWeeklyVoiceMessage|sendPing|sendTrialExpiredNotification|sendReminderDowngradeNotification)\(|\bwhatsappTemplate\b/;

/** The files that send on a schedule (cron, or a pass a cron runs): each calls isPaused before it sends. */
const PAUSED: Record<string, string> = {
  'src/services/native-reminders/pass.ts': 'the native reminder ping: claimed without a send, so it is not sent after the window',
  'src/services/reminders.ts': 'the event alert, and the downgrade notice the alert pass sends',
  'src/services/telegram/summary.ts': 'the daily and tomorrow summaries, text and voice (the batch: sendSummaryToAll)',
  'src/cron/handlers.ts': 'the setup nudges (the location track and the Google tracks)',
  'src/services/subscription-reminders.ts': 'the 3-day and last-day renewal reminders and the expiry notice',
  'src/services/subscription-service.ts': 'the trial-expired notice, sent when the first check after the trial finds it over',
  'src/services/google-sync/worker.ts': 'the copy-to-Google reconnect message',
};

/** The files that send but are not scheduled sends to a person, each with why. */
const NOT_PAUSED: Record<string, string> = {
  // Replies to the person's own action
  'src/services/messaging/telegram-adapter.ts': 'the transport: sends what its caller decided to send',
  'src/services/messaging/whatsapp-adapter.ts': 'the transport',
  'src/services/messaging/types.ts': 'a type',
  'src/services/telegram/commands.ts': 'replies to the person\'s own commands (summary, weather, lookahead, next week and their weekly voice, feedback, connect)',
  'src/services/telegram/command-pipeline.ts': 'replies to a command: the typing indicator and the error answers',
  'src/services/telegram/google-read-errors.ts': 'the answer to a command whose Google read failed',
  'src/services/telegram/pair-handler.ts': 'the pairing the person started',
  'src/services/telegram/text-limit.ts': 'the answer to a command over its limit',
  'src/services/telegram/voice.ts': 'the voice note sender: its scheduled caller (the summary) is paused, its other callers are commands',
  'src/services/telegram/notifications.ts': 'the senders of the trial and downgrade notices: their callers are paused (subscription-service, reminders)',
  'src/services/voice/auto-create.ts': 'the answer to a voice message the person sent',
  'src/services/voice/bulk-confirmations.ts': 'the answer to a voice message the person sent',
  'src/services/voice/callbacks.ts': 'the answer to a button the person pressed',
  'src/services/voice/confirmations.ts': 'the answer to a voice message the person sent',
  'src/services/voice/correction-handler.ts': 'the answer to a correction the person sent',
  'src/services/voice/handler.ts': 'the answer to a voice message the person sent',
  'src/services/voice/tts-outcome.ts': 'the voice answer to a voice message the person sent',
  'src/services/forward-event/handler.ts': 'the answer to a message the person forwarded',
  'src/services/image-event/handler.ts': 'the answer to an image the person sent',
  'src/services/kid-name-detection.ts': 'the follow-up question after a summary: it is sent only by the summary, which is paused',
  'src/services/google-connect.ts': 'the answer to the person connecting Google',
  'src/services/payment-handler.ts': 'the answer to a payment the person made',
  'src/services/webhook-handlers.ts': 'the answer to what the person sent the bot',
  'src/services/whatsapp-onboarding.ts': 'the answer to what the person sent the bot on WhatsApp',
  'src/services/native-reminders/actions.ts': 'the quiet note to the partner after a person marks a reminder done (their own action, sent without a sound)',
  'src/services/native-reminders/typed-route.ts': 'the answer to a reminder the person typed',
  'src/services/native-reminders/ping.ts': 'the ping text and the edits of a ping that is already on screen; the one send, sendPing, is called by the paused pass',
  // To the admin
  'app/api/admin/send-reminder/route.ts': 'the admin pressing "send a reminder" for one person',
  'src/utils/error-notifier.ts': 'messages to the admin (errors and warnings)',
  'src/services/key-rotation.ts': 'the key sweep\'s SAFE message to the admin',
  'instrumentation.ts': 'the deploy notice to the admin',
  'app/api/execute-command/route.ts': 'the answer to a command the person (or the operator) sent from the Mini App',
};

// ---- The checks, in one process zone ----

async function runChecks(): Promise<void> {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[pause]')) logs.push(line);
    else realLog(...args);
  };
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[pause]') || line.startsWith('[zmanim]')) logs.push(line);
    else realWarn(...args);
  };
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[pause]')) logs.push(line);
    else realError(...args);
  };

  // Friday 2026-10-16, Jerusalem, Sephardi: candle lighting 17:50 (14:50 UTC), sunset 18:10 (15:10 UTC), Shabbat ends 18:39
  // (15:39 UTC the next day). The pause begins at the sunset.
  const FRI_CANDLES = '2026-10-16T14:50:00.000Z';
  const FRI_SUNSET = '2026-10-16T15:10:00.000Z';
  const SAT_END = '2026-10-17T15:39:00.000Z';

  // ============ The answer ============

  await check('the switch off, unset or null is never paused and does no work (no Redis, no database, no lookup, no log), even in the middle of Shabbat', async () => {
    resetWorld();
    const midShabbat = at('2026-10-17T09:00:00.000Z');
    for (const pauseOnShabbat of [false, undefined, null]) {
      const user = person(1, 'Asia/Jerusalem', JERUSALEM, { pauseOnShabbat });
      assert(await pause.isPaused(user, midShabbat, 'event alert') === false, `pauseOnShabbat ${String(pauseOnShabbat)} paused`);
    }
    assert(redisReads === 0 && dbCalls === 0 && requests.length === 0 && logs.length === 0 && captured.length === 0, `work done: ${redisReads} reads, ${dbCalls} db, ${requests.length} requests, ${logs.join('|')}`);
  });

  await check('Friday to Saturday night in Jerusalem (Sephardi): paused from sunset (the minute itself, 20 minutes after candle lighting, which sends) to the end of Shabbat (not the minute itself), through Saturday noon, and not the minute before either edge', async () => {
    resetWorld();
    const user = person(2, 'Asia/Jerusalem', JERUSALEM);
    const cases: Array<[string, Date, boolean]> = [
      ['Friday noon', at('2026-10-16T09:00:00.000Z'), false],
      ['a minute before candle lighting', minute(FRI_CANDLES, -1), false],
      ['candle lighting itself', at(FRI_CANDLES), false],
      ['between candle lighting and sunset', minute(FRI_CANDLES, 10), false],
      ['a minute before sunset', minute(FRI_SUNSET, -1), false],
      ['a millisecond before sunset', new Date(Date.parse(FRI_SUNSET) - 1), false],
      ['sunset itself', at(FRI_SUNSET), true],
      ['a minute after sunset', minute(FRI_SUNSET, 1), true],
      ['Friday night', at('2026-10-16T20:00:00.000Z'), true],
      ['Saturday noon', at('2026-10-17T09:00:00.000Z'), true],
      ['a millisecond before the end', new Date(Date.parse(SAT_END) - 1), true],
      ['the end of Shabbat itself', at(SAT_END), false],
      ['a minute after the end', minute(SAT_END, 1), false],
      ['Sunday', at('2026-10-18T09:00:00.000Z'), false],
      ['Wednesday', at('2026-10-14T20:00:00.000Z'), false],
    ];
    for (const [name, when, want] of cases) assert(await pause.isPaused(user, when) === want, `${name}: ${when.toISOString()} should be ${want ? 'paused' : 'sending'}`);
  });

  await check('the same instant, two places: Friday 21:00 UTC is after sunset in Jerusalem and the afternoon in New York; each person is read by their own place, and New York begins at its own sunset (22:14 UTC), not its candle lighting (21:54 UTC)', async () => {
    resetWorld();
    const jerusalem = person(3, 'Asia/Jerusalem', JERUSALEM);
    const newYork = person(4, 'America/New_York', NEW_YORK);
    const when = at('2026-10-16T21:00:00.000Z');
    assert(await pause.isPaused(jerusalem, when) === true, 'Jerusalem is in Shabbat');
    assert(await pause.isPaused(newYork, when) === false, 'New York is before its candle lighting (21:54 UTC)');
    assert(await pause.isPaused(newYork, at('2026-10-16T21:54:00.000Z')) === false, 'New York at its own candle lighting sends');
    assert(await pause.isPaused(newYork, at('2026-10-16T22:13:00.000Z')) === false, 'New York a minute before its sunset');
    assert(await pause.isPaused(newYork, at('2026-10-16T22:14:00.000Z')) === true, 'New York at its own sunset');
  });

  await check('the community\'s own edge: Sephardi ends Shabbat at 15:39 UTC and Ashkenazi at 15:42 in Jerusalem, so the minutes between are paused for one and not the other', async () => {
    resetWorld();
    const sephardi = person(5, 'Asia/Jerusalem', JERUSALEM, { zmanimCommunity: 'sephardi' });
    const ashkenazi = person(6, 'Asia/Jerusalem', JERUSALEM, { zmanimCommunity: 'ashkenazi' });
    const unknown = person(7, 'Asia/Jerusalem', JERUSALEM, { zmanimCommunity: 'martian' });
    const between = at('2026-10-17T15:40:00.000Z');
    assert(await pause.isPaused(sephardi, between) === false, 'Sephardi sends');
    assert(await pause.isPaused(ashkenazi, between) === true, 'Ashkenazi is still paused');
    assert(await pause.isPaused(unknown, between) === false, 'an unknown community reads as the default (Sephardi)');
    assert(await pause.isPaused(ashkenazi, at('2026-10-17T15:42:00.000Z')) === false, 'Ashkenazi ends at 15:42');
  });

  await check('Yom Tov: Rosh Hashana 5787 is one window across Saturday and Sunday in Israel; Pesach 2027\'s second day (a Friday) is a Yom Tov abroad, which joins its Shabbat in one window, and a working day in Israel', async () => {
    resetWorld();
    const jerusalem = person(8, 'Asia/Jerusalem', JERUSALEM);
    const newYork = person(9, 'America/New_York', NEW_YORK);
    // Israel, Rosh Hashana: Friday 11 September 18:54 (the sunset; the candle lighting is 18:34) to Sunday 13 September 19:23, with no gap between the two days.
    assert(await pause.isPaused(jerusalem, at('2026-09-11T15:34:00.000Z')) === false, 'candle lighting sends');
    assert(await pause.isPaused(jerusalem, at('2026-09-11T15:53:00.000Z')) === false, 'a minute before Rosh Hashana');
    assert(await pause.isPaused(jerusalem, at('2026-09-11T15:54:00.000Z')) === true, 'Rosh Hashana begins at the sunset');
    assert(await pause.isPaused(jerusalem, at('2026-09-12T16:30:00.000Z')) === true, 'between Saturday night and the second day');
    assert(await pause.isPaused(jerusalem, at('2026-09-13T16:22:00.000Z')) === true, 'a minute before the second day ends');
    assert(await pause.isPaused(jerusalem, at('2026-09-13T16:23:00.000Z')) === false, 'the second day ends');
    // Pesach 2027: Thursday 22 April is the first day everywhere; Friday 23 April the second day abroad only.
    const fridayNoon = at('2027-04-23T12:00:00.000Z');
    assert(await pause.isPaused(newYork, fridayNoon) === true, 'New York: Friday is the second day, inside one window from Wednesday evening to Saturday night');
    assert(await pause.isPaused(jerusalem, fridayNoon) === false, 'Jerusalem: Friday is Chol HaMoed');
    assert(await pause.isPaused(jerusalem, at('2027-04-22T12:00:00.000Z')) === true, 'Jerusalem: Thursday is the first day');
    assert(await pause.isPaused(jerusalem, at('2027-04-23T15:57:00.000Z')) === false && await pause.isPaused(jerusalem, at('2027-04-23T16:16:00.000Z')) === false && await pause.isPaused(jerusalem, at('2027-04-23T16:17:00.000Z')) === true, 'Jerusalem: Shabbat Chol HaMoed begins at its sunset (16:17 UTC), not its candle lighting (15:57)');
  });

  // ============ The pause starts at the eve's sunset (owner 2026-10-28), not at candle lighting ============

  await check('Harish, Friday 2026-10-30 (Sephardi, 290 m): candle lighting 16:33 (14:33 UTC) and the minute before sunset send, sunset 16:53 (14:53 UTC) is paused, and Saturday ends as it did (15:24 UTC: the minute before is paused, the minute itself sends)', async () => {
    resetWorld();
    const user = person(60, 'Asia/Jerusalem', HARISH);
    const cases: Array<[string, string, boolean]> = [
      ['candle lighting itself, 16:33', '2026-10-30T14:33:00.000Z', false],
      ['twenty minutes after it', '2026-10-30T14:52:00.000Z', false],
      ['sunset, 16:53', '2026-10-30T14:53:00.000Z', true],
      ['Friday night', '2026-10-30T19:00:00.000Z', true],
      ['the minute before Shabbat ends', '2026-10-31T15:23:00.000Z', true],
      ['Shabbat ends, 17:24', '2026-10-31T15:24:00.000Z', false],
    ];
    for (const [name, when, want] of cases) assert(await pause.isPaused(user, at(when)) === want, `${name}: ${when} should be ${want ? 'paused' : 'sending'}`);
  });

  await check('a Yom Tov eve in Israel is the same: Erev Yom Kippur (Sunday 2026-09-20, sunset 15:42 UTC, candles 15:22), Erev Sukkot (Friday 2026-09-25, sunset 15:36, candles 15:16, one window into the Saturday that ends 16:05) and Erev Pesach (Wednesday 2027-04-21, sunset 16:16, candles 15:56): candle lighting and the minute before sunset send, sunset is paused, and the end is the day\'s end as before', async () => {
    resetWorld();
    const user = person(61, 'Asia/Jerusalem', JERUSALEM);
    const cases: Array<[string, string, boolean]> = [
      ['Erev Yom Kippur: candle lighting', '2026-09-20T15:22:00.000Z', false],
      ['Erev Yom Kippur: a minute before sunset', '2026-09-20T15:41:00.000Z', false],
      ['Erev Yom Kippur: sunset', '2026-09-20T15:42:00.000Z', true],
      ['Yom Kippur: the minute before its end', '2026-09-21T16:11:00.000Z', true],
      ['Yom Kippur: its end', '2026-09-21T16:12:00.000Z', false],
      ['Erev Sukkot (a Friday): candle lighting', '2026-09-25T15:16:00.000Z', false],
      ['Erev Sukkot: a minute before sunset', '2026-09-25T15:35:00.000Z', false],
      ['Erev Sukkot: sunset', '2026-09-25T15:36:00.000Z', true],
      ['Sukkot, a Saturday: the minute before its end', '2026-09-26T16:04:00.000Z', true],
      ['Sukkot, a Saturday: its end', '2026-09-26T16:05:00.000Z', false],
      ['Erev Pesach: candle lighting', '2027-04-21T15:56:00.000Z', false],
      ['Erev Pesach: a minute before sunset', '2027-04-21T16:15:00.000Z', false],
      ['Erev Pesach: sunset', '2027-04-21T16:16:00.000Z', true],
    ];
    for (const [name, when, want] of cases) assert(await pause.isPaused(user, at(when)) === want, `${name}: ${when} should be ${want ? 'paused' : 'sending'}`);
  });

  await check('a Yom Tov on a Friday inside a longer window (Shavuot 2027 in Israel is Friday 2027-06-11): the window starts at Thursday 06-10\'s sunset (16:48 UTC; candles 16:28 send), Friday is paused all day, and it ends at Saturday\'s end (17:20 UTC)', async () => {
    resetWorld();
    const user = person(62, 'Asia/Jerusalem', JERUSALEM);
    const cases: Array<[string, string, boolean]> = [
      ['Thursday noon', '2027-06-10T09:00:00.000Z', false],
      ['Thursday candle lighting (the eve\'s, Erev Shavuot)', '2027-06-10T16:28:00.000Z', false],
      ['Thursday, a minute before sunset', '2027-06-10T16:47:00.000Z', false],
      ['Thursday sunset', '2027-06-10T16:48:00.000Z', true],
      ['Friday morning', '2027-06-11T04:00:00.000Z', true],
      ['Friday noon', '2027-06-11T09:00:00.000Z', true],
      ['Friday candle lighting (the Shabbat\'s, inside the window)', '2027-06-11T16:29:00.000Z', true],
      ['Friday sunset', '2027-06-11T16:49:00.000Z', true],
      ['Saturday noon', '2027-06-12T09:00:00.000Z', true],
      ['Saturday, a minute before the end', '2027-06-12T17:19:00.000Z', true],
      ['Saturday\'s end', '2027-06-12T17:20:00.000Z', false],
    ];
    for (const [name, when, want] of cases) assert(await pause.isPaused(user, at(when)) === want, `${name}: ${when} should be ${want ? 'paused' : 'sending'}`);
    const [only, ...rest] = compute.shabbatYomTovWindows({ from: at('2027-06-09T00:00:00.000Z'), to: at('2027-06-14T00:00:00.000Z') }, { ...JERUSALEM, timeZone: 'Asia/Jerusalem' }, 'sephardi');
    assert(rest.length === 0 && only[0].toISOString() === '2027-06-10T16:48:00.000Z' && only[1].toISOString() === '2027-06-12T17:20:00.000Z', `one window: ${show([only, ...rest])}`);
  });

  await check('New York (Ashkenazi): a Friday starts at its own sunset (2026-10-16 22:14 UTC; candles 21:54 send), the minute before is sending, Shabbat ends at 22:54 UTC the next day', async () => {
    resetWorld();
    const user = person(63, 'America/New_York', NEW_YORK, { zmanimCommunity: 'ashkenazi' });
    const cases: Array<[string, string, boolean]> = [
      ['candle lighting', '2026-10-16T21:54:00.000Z', false],
      ['a minute before sunset', '2026-10-16T22:13:00.000Z', false],
      ['sunset', '2026-10-16T22:14:00.000Z', true],
      ['the minute before Shabbat ends', '2026-10-17T22:53:00.000Z', true],
      ['Shabbat ends', '2026-10-17T22:54:00.000Z', false],
    ];
    for (const [name, when, want] of cases) assert(await pause.isPaused(user, at(when)) === want, `${name}: ${when} should be ${want ? 'paused' : 'sending'}`);
  });

  await check('Chabad begins at its own sea-level sunset, not the Sephardi one: Jerusalem (754 m) on Friday 2026-10-16 the Chabad sunset is 15:05 UTC and the Sephardi elevation sunset 15:10, so 15:07 is paused for Chabad and sends for Sephardi; the Chabad candle lighting (14:45) sends', async () => {
    resetWorld();
    const chabad = person(64, 'Asia/Jerusalem', JERUSALEM, { zmanimCommunity: 'chabad' });
    const sephardi = person(65, 'Asia/Jerusalem', JERUSALEM, { zmanimCommunity: 'sephardi' });
    const cases: Array<[string, string, boolean, boolean]> = [
      ['Chabad candle lighting', '2026-10-16T14:45:00.000Z', false, false],
      ['a minute before the Chabad sunset', '2026-10-16T15:04:00.000Z', false, false],
      ['the Chabad sunset', '2026-10-16T15:05:00.000Z', true, false],
      ['between the two sunsets', '2026-10-16T15:07:00.000Z', true, false],
      ['the Sephardi sunset', '2026-10-16T15:10:00.000Z', true, true],
    ];
    for (const [name, when, wantChabad, wantSephardi] of cases) {
      assert(await pause.isPaused(chabad, at(when)) === wantChabad, `Chabad, ${name}: ${when} should be ${wantChabad ? 'paused' : 'sending'}`);
      assert(await pause.isPaused(sephardi, at(when)) === wantSephardi, `Sephardi, ${name}: ${when} should be ${wantSephardi ? 'paused' : 'sending'}`);
    }
  });

  // ============ The place ============

  await check('a person with a place name and no coordinates gets them filled once (one lookup, logged by the place) and is then paused by them: Harish at 290 m ends Shabbat later than the sea-level fallback would', async () => {
    resetWorld();
    dbUsers.set(10, { id: 10, location: 'Harish, Israel', latitude: null, longitude: null, elevationM: null });
    const user = person(10, 'Asia/Jerusalem', null, { location: 'Harish, Israel' });
    const requestsFor = () => requests.filter(r => r.includes('nominatim')).length;
    assert(await pause.isPaused(user, at('2026-10-17T09:00:00.000Z')) === true, 'paused on Saturday noon');
    assert(requestsFor() === 1 && dbUsers.get(10)!.latitude === 32.46182 && dbUsers.get(10)!.elevationM === 290, `filled once: ${requestsFor()} lookups, row ${show(dbUsers.get(10))}`);
    windows.__resetPauseForTests();
    assert(await pause.isPaused(user, at('2026-10-17T09:00:00.000Z')) === true && requestsFor() === 1, 'the next computation does not look the place up again');
  });

  await check('a place in Israel saved without a height: the windows are counted at sea level for at most an hour, the height is looked up in the background, and once it is found the next count uses it (a Saturday-evening minute that the sea-level end let out is paused again, though the first count was the same UTC day)', async () => {
    resetWorld();
    const harish = { latitude: 32.46182, longitude: 35.04555 };
    const SATURDAY_NOON = '2026-10-31T10:00:00.000Z';
    const endOf = (elevationM: number | null) => compute.shabbatYomTovWindows({ from: at('2026-10-30T00:00:00.000Z'), to: at('2026-10-31T23:59:00.000Z') }, { ...harish, elevationM, timeZone: 'Asia/Jerusalem' }, 'sephardi')[0][1];
    const endSea = endOf(null), endHigh = endOf(290);
    assert(endHigh.getTime() - endSea.getTime() >= 90_000, `the height should move the end: ${endSea.toISOString()} ${endHigh.toISOString()}`);
    dbUsers.set(41, { id: 41, location: 'Harish, Israel', ...harish, elevationM: null });
    const user = person(41, 'Asia/Jerusalem', { ...harish, elevationM: null }, { location: 'Harish, Israel' });
    assert(await pause.isPaused(user, at(SATURDAY_NOON)) === true, 'paused at noon');
    // The first count (above) was at sea level, and started the lookup of the height.
    const minuteAfterSeaEnd = new Date(endSea.getTime() + 60_000);
    const state = (globalThis as unknown as { __zmanimPlaceFill: { running: Map<string, Promise<unknown>> } }).__zmanimPlaceFill;
    await state.running.get('41|Harish, Israel');
    assert(dbUsers.get(41)!.elevationM === 290 && requests.filter(r => r.includes('/v1/elevation')).length === 1, `the height was looked up once and saved: ${show(dbUsers.get(41))}`);
    // The same stale row, an hour and a minute after the first count (the same UTC day): counted again, with the height.
    assert(Date.parse(SATURDAY_NOON) + 60 * 60_000 < minuteAfterSeaEnd.getTime() && minuteAfterSeaEnd.getTime() < endHigh.getTime(), 'the minutes are in order, more than an hour after the first count');
    assert(await pause.isPaused(user, minuteAfterSeaEnd) === true, 'with the height found, the minute the sea-level end let out is paused again');
  });

  await check('no usable location: a person with no place at all, or a place the lookup does not find, is paused by the main city of their timezone (Asia/Jerusalem gives Jerusalem), and the fallback is logged once a day per person', async () => {
    resetWorld();
    const none = person(11, 'Asia/Jerusalem', null);
    const city = windows.mainCityPlace('Asia/Jerusalem')!;
    const reference = person(12, 'Asia/Jerusalem', { latitude: city.latitude, longitude: city.longitude, elevationM: city.elevationM });
    const fallbackLogs = () => logs.filter(l => l.includes('user 11 ') && /main city/.test(l)).length;
    for (const when of ['2026-10-16T15:09:00.000Z', '2026-10-16T15:10:00.000Z', '2026-10-17T15:39:00.000Z', '2026-10-17T15:40:00.000Z']) {
      assert(await pause.isPaused(none, at(when)) === await pause.isPaused(reference, at(when)), `the fallback is Jerusalem's windows at ${when}`);
    }
    assert(fallbackLogs() === 2, `logged once for each of the two days (Friday, Saturday): ${show(logs)}`);
    await pause.isPaused(none, at('2026-10-17T20:00:00.000Z'));
    assert(fallbackLogs() === 2, `not again on the same day: ${show(logs)}`);
    await pause.isPaused(none, at('2026-10-18T09:00:00.000Z'));
    assert(fallbackLogs() === 3, `logged again the next day: ${show(logs)}`);
    // A place name that the lookup does not find, tried again only after an hour: the fallback meanwhile.
    resetWorld();
    nominatim = () => json([]);
    dbUsers.set(13, { id: 13, location: 'Atlantis', latitude: null, longitude: null, elevationM: null });
    const lost = person(13, 'Asia/Jerusalem', null, { location: 'Atlantis' });
    assert(await pause.isPaused(lost, at('2026-10-17T09:00:00.000Z')) === true, 'paused by Jerusalem on Saturday noon, no crash');
    assert(logs.some(l => l.includes('user 13 ') && /main city/.test(l)), `the fallback is logged: ${show(logs)}`);
  });

  await check('the main cities: every city in the table is a hebcal classic city whose own zone is the key (Asia/Jerusalem is Jerusalem), a zone with none is not paused and is logged, and the Israel aliases map to Jerusalem', async () => {
    resetWorld();
    for (const [zone, city] of Object.entries(windows.MAIN_CITIES)) {
      const found = hebcal.Location.lookup(city);
      assert(found !== undefined, `${city} is not a hebcal city`);
      if (!['Asia/Tel_Aviv', 'Israel', 'Europe/Kyiv'].includes(zone)) assert(found.getTzid() === zone, `${city} is in ${found.getTzid()}, not ${zone}`);
    }
    assert(windows.MAIN_CITIES['Asia/Jerusalem'] === 'Jerusalem' && windows.MAIN_CITIES['Israel'] === 'Jerusalem' && windows.MAIN_CITIES['Asia/Tel_Aviv'] === 'Jerusalem', 'Israel is Jerusalem');
    const jerusalem = windows.mainCityPlace('Asia/Jerusalem');
    assert(jerusalem !== null && Math.abs(jerusalem.latitude - 31.77) < 0.05 && jerusalem.timeZone === 'Asia/Jerusalem', `Jerusalem: ${show(jerusalem)}`);
    assert(windows.mainCityPlace('Asia/Kolkata') === null, 'no main city for Kolkata');
    const stranger = person(14, 'Asia/Kolkata', null);
    assert(await pause.isPaused(stranger, at('2026-10-17T09:00:00.000Z')) === false, 'not paused: no place to count Shabbat from');
    assert(logs.some(l => l.includes('user 14 ') && l.includes('Asia/Kolkata')), `said so: ${show(logs)}`);
  });

  // ============ The cache ============

  await check('cached per person per day, on globalThis: a second answer for the same person and day does no place or zone work; another day, another place, or another community is computed again; the switch is not cached', async () => {
    resetWorld();
    const user = person(15, 'Asia/Jerusalem', JERUSALEM);
    await pause.isPaused(user, at('2026-10-17T09:00:00.000Z'));
    const reads = redisReads;
    assert(reads > 0, 'the first answer resolved the zone');
    for (const when of ['2026-10-17T10:00:00.000Z', '2026-10-17T23:59:00.000Z', '2026-10-17T00:00:00.000Z']) await pause.isPaused(user, at(when));
    assert(redisReads === reads, `the same UTC day: ${redisReads - reads} more reads`);
    const cache = (globalThis as unknown as { __pauseCache?: Map<number, unknown> }).__pauseCache;
    assert(cache instanceof Map && cache.has(15), 'the cache is on globalThis');
    await pause.isPaused(user, at('2026-10-18T09:00:00.000Z'));
    assert(redisReads > reads, 'another day is computed again');
    const afterDay = redisReads;
    await pause.isPaused({ ...user, latitude: NEW_YORK.latitude, longitude: NEW_YORK.longitude }, at('2026-10-18T09:00:00.000Z'));
    assert(redisReads > afterDay, 'another place is computed again');
    const afterPlace = redisReads;
    await pause.isPaused({ ...user, latitude: NEW_YORK.latitude, longitude: NEW_YORK.longitude, zmanimCommunity: 'chabad' }, at('2026-10-18T09:00:00.000Z'));
    assert(redisReads > afterPlace, 'another community is computed again');
    // The switch is read from the person each time: turning it off takes effect at once.
    assert(await pause.isPaused({ ...user, pauseOnShabbat: false }, at('2026-10-17T09:00:00.000Z')) === false, 'switched off');
    assert(await pause.isPaused({ ...user, pauseOnShabbat: true }, at('2026-10-17T09:00:00.000Z')) === true, 'switched on again');
  });

  await check('a place name the lookup did not find is paused by the main city for at most an hour (the lookup is tried again after that, and the place it finds is used), while a person with no place name keeps the fallback for the day', async () => {
    resetWorld();
    nominatim = () => json([]);
    dbUsers.set(20, { id: 20, location: 'Haifa', latitude: null, longitude: null, elevationM: null });
    const named = person(20, 'Asia/Jerusalem', null, { location: 'Haifa' });
    const lookups = () => requests.filter(r => r.includes('nominatim')).length;
    const t0 = '2026-10-17T07:00:00.000Z';
    await pause.isPaused(named, at(t0));
    assert(lookups() === 1 && dbUsers.get(20)!.latitude === null, `not found: ${lookups()} lookups`);
    const fallbackLogs = () => logs.filter(l => l.includes('user 20 ') && /main city/.test(l)).length;
    nominatim = () => json([{ lat: '32.46182', lon: '35.04555', boundingbox: HARISH_BOX }]);
    await pause.isPaused(named, minute(t0, 30));
    assert(lookups() === 1, `within the hour nothing is asked again: ${lookups()} lookups`);
    // An hour on the answer is worked out again (still by the fallback: the lookup waits its own hour), and the log stays one a day
    const readsBefore = redisReads;
    await pause.isPaused(named, minute(t0, 61));
    assert(redisReads > readsBefore && lookups() === 1 && fallbackLogs() === 1, `after the hour: ${redisReads - readsBefore} more reads, ${lookups()} lookups, ${fallbackLogs()} fallback logs`);
    const fills = (globalThis as unknown as { __zmanimPlaceFill: { failedAt: Map<string, number> } }).__zmanimPlaceFill;
    fills.failedAt.set('20|Haifa', performance.now() - 61 * 60 * 1000);
    await pause.isPaused(named, minute(t0, 122));
    assert(lookups() === 2 && dbUsers.get(20)!.latitude === 32.46182, `once the lookup may be tried again the place is looked up and used: ${lookups()} lookups, row ${show(dbUsers.get(20))}`);

    resetWorld();
    const nameless = person(21, 'Asia/Jerusalem', null);
    await pause.isPaused(nameless, at(t0));
    const reads = redisReads;
    await pause.isPaused(nameless, minute(t0, 180));
    assert(redisReads === reads, `no place name: the day's answer is kept (${redisReads - reads} more reads)`);
  });

  // ============ Failures and the log ============

  await check('a failure never throws into a pass: an invalid timezone is logged and captured, and reads as not paused (the send goes ahead)', async () => {
    resetWorld();
    const user = person(16, 'Not/AZone', JERUSALEM);
    assert(await pause.isPaused(user, at('2026-10-17T09:00:00.000Z'), 'summary') === false, 'not paused');
    assert(logs.some(l => l.startsWith('[pause]') && l.includes('user 16 ')), `logged: ${show(logs)}`);
    assert(captured.some(c => c.context === 'pause-check'), `captured: ${show(captured)}`);
    assert(!logs.some(l => l.includes('skipped')), 'a failed check skips nothing');
  });

  await check('a skipped send is logged "[pause] skipped <kind> for <userId>", once per call, and only when it was paused', async () => {
    resetWorld();
    const user = person(17, 'Asia/Jerusalem', JERUSALEM);
    assert(await pause.isPaused(user, at('2026-10-17T09:00:00.000Z'), 'event alert') === true, 'paused');
    assertSame(logs.filter(l => l.includes('skipped')), ['[pause] skipped event alert for 17'], 'the skip line');
    logs.length = 0;
    assert(await pause.isPaused(user, at('2026-10-14T09:00:00.000Z'), 'event alert') === false, 'a Wednesday');
    assert(await pause.isPaused(user, at('2026-10-17T09:00:00.000Z')) === true, 'no kind given');
    assert(!logs.some(l => l.includes('skipped')), `nothing skipped to log: ${show(logs)}`);
  });

  // ============ The audit ============

  await check('every file that sends a message to a person is classified: a scheduled send calls isPaused (and is listed as paused), anything else is listed with its reason; a new sender fails here until it is classified', () => {
    const senders = sourceFiles().filter(file => SEND_CALL.test(readFileSync(path.join(ROOT, file), 'utf8')));
    const known = new Set([...Object.keys(PAUSED), ...Object.keys(NOT_PAUSED)]);
    const unclassified = senders.filter(file => !known.has(file));
    assert(unclassified.length === 0, `sends nobody classified (pause it, or list it with the reason it is not): ${unclassified.join(', ')}`);
    const stale = [...known].filter(file => !senders.includes(file) && !Object.keys(PAUSED).includes(file));
    assert(stale.length === 0, `listed as not paused but no longer sending: ${stale.join(', ')}`);
    const calls = (file: string) => {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      return /zmanim\/pause'/.test(text) && /\bisPaused\(/.test(text);
    };
    const silent = Object.keys(PAUSED).filter(file => !calls(file));
    assert(silent.length === 0, `listed as paused but do not call isPaused: ${silent.join(', ')}`);
    const surprising = Object.keys(NOT_PAUSED).filter(file => calls(file));
    assert(surprising.length === 0, `listed as not paused but call isPaused: ${surprising.join(', ')}`);
  });

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  report();
}

function report(): void {
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') {
  runChildren();
} else {
  runChecks().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
