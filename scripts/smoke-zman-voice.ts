// Smoke test for reminders by zman made by voice and text (zman reminders by voice plan, Task 5):
//   - resolution (src/services/native-reminders/resolve.ts): the model's zman mapped under the WRITER's community, the
//     recipient's clock (the partner's own place and zone for a reminder for them alone), the day per rule or per
//     choice (the next time that has not passed, or the day said), the notice counted at the rule's time (not at the
//     09:00 reminder time), the pause note read through isPaused, the three refusals, the choices on the pending event
//     and the tap that makes one of them the rule;
//   - the questions a refused zman reminder gets, in en/he/ru.
//
// The zman clock and the pause are the real ones (hebcal, places from the fixtures' coordinates). Prisma, Redis, the
// timezone lookups, Telegram, the AI and the store's writes are faked. No network: a fetch throws.
// Process zone: this file re-runs itself once per server zone (UTC, Asia/Jerusalem, America/New_York) as child
// processes; nothing here may depend on the one the process has.
//   npx tsx scripts/smoke-zman-voice.ts

import { spawn } from 'node:child_process';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantToWallTime, wallTimeToInstant } from '../src/utils/wall-time';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { PartnerSummary } from '../src/services/native-reminders/ownership';
import type { UserConfig } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMAN_VOICE_SMOKE_CHILD';

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      (zone) =>
        new Promise<{ zone: string; code: number; text: string }>((resolve) => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.stderr.on('data', (chunk) => (text += chunk));
          child.on('close', (code) => resolve({ zone, code: code ?? 1, text }));
        }),
    ),
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

async function check(name: string, fn: () => void | Promise<void>) {
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

const show = (v: unknown) => JSON.stringify(v);

// ---- Places, people, zones ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo'; // no main city: with no saved place, nothing to count from
const OSLO = 'Europe/Oslo';
const HARISH = { location: 'Harish', latitude: 32.46182, longitude: 35.04555, elevationM: 270 };
const NEW_YORK = { location: 'New York', latitude: 40.7128, longitude: -74.006, elevationM: 10 };
const TROMSO = { location: 'Tromso', latitude: 69.6492, longitude: 18.9553, elevationM: 10 }; // polar night in December
const NOWHERE = { location: '', latitude: null, longitude: null, elevationM: null };

const dana = {
  id: 1, name: 'Dana', englishName: 'Dana', language: 'en', telegramId: 1001, calendarSource: 'NATIVE', pairingId: 'pair-1',
  isAdmin: false, googleRefreshToken: '', reminderTime: null, ...HARISH, zmanimCommunity: 'sephardi', pauseOnShabbat: true,
} as unknown as UserConfig;
const raziel: PartnerSummary = {
  id: 2, name: 'Raziel', englishName: 'Raziel', gender: 'male', telegramId: BigInt(1002), language: 'he', reminderTime: null,
  ...NEW_YORK, zmanimCommunity: 'ashkenazi', pauseOnShabbat: true,
};
let partner: PartnerSummary | null = raziel;
/** Each person's zone, as resolveUserTimezone answers (the fake). */
let zones: Record<number, string> = {};

const user = (over: Record<string, unknown>) => ({ ...dana, ...over }) as unknown as UserConfig;

// ---- Fakes ----

const created: Array<Record<string, unknown>> = [];
const logs: string[] = [];
/** What the user lookups asked for (the select of each findUnique). */
const selects: Array<Record<string, unknown> | undefined> = [];
function reset() {
  partner = raziel;
  zones = { 1: IL, 2: NY };
  created.length = 0;
  logs.length = 0;
  selects.length = 0;
}

const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const SRC = path.resolve(ROOT, 'src');
const fakeBot = { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => true, answerCallbackQuery: async () => true };
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': { calendar: () => ({}), auth: { OAuth2: class {} } },
  [`${SRC}/utils/redis.ts`]: { redis: { get: async () => null, set: async () => 'OK', del: async () => 0, exists: async () => 0 } },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: {
      user: {
        // The recipient a refresh reads by id: the partner (with their place), or nobody
        findUnique: async ({ where, select }: { where: { id: number }; select?: Record<string, unknown> }) => {
          selects.push(select);
          return partner && partner.id === where.id ? { ...partner } : null;
        },
      },
      pairing: { findUnique: async () => ({ status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 }) },
    },
    withRetry: (fn: () => unknown) => fn(),
  },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/lib/timezone.ts`]: {
    resolveUserTimezone: async (u: { id: number }) => zones[u.id] ?? IL,
    resolveLocation: async () => null,
    LOOKUP_TIMEOUT_MS: 3000,
    TIMEZONE_CACHE_TTL: 86_400,
  },
  [`${SRC}/services/weather/geocoding.ts`]: { fetchWithTimeout: async () => { throw new Error('the smoke reached the network'); } },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: async () => ({ text: '{}' }), getGemini: () => ({}), extractionConfig: () => ({}) },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => ({}) },
  [`${SRC}/services/telegram/bot.ts`]: { getBot: () => fakeBot, getMessagingService: () => ({}) },
  [`${SRC}/services/calendar-provider/index.ts`]: { getCalendarAssignmentsForUser: async () => [] },
  [`${SRC}/services/native-calendar/event-store.ts`]: (real) => fakeOver(real, {
    getMainNativeCalendar: async (userId: number) => ({ id: `main${userId}` }),
    createNativeEvent: async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: `ev${created.length}`, calendarId: input.calendarCuid };
    },
  }),
  [`${SRC}/services/native-reminders/ownership.ts`]: (real) => fakeOver(real, {
    getActivePartnerSummary: async (_userId: number, pairingId: string | null) => (pairingId ? partner : null),
  }),
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};
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
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const key = request in stubs ? request : resolved;
  if (!(key in stubs) || loadingReal.has(key)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(key, () => realLoad.call(this, request, parent, isMain));
};
// import() goes through the ES module loader: the same fakes, served as ES modules.
(globalThis as { zmanVoiceFake?: (file: string) => object }).zmanVoiceFake = (file) => fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { zmanVoiceFake: (file: string) => object }).zmanVoiceFake(file);
    const names = Object.keys(fake).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.zmanVoiceFake(${JSON.stringify(file)});\n${names}\n` };
  },
});
globalThis.fetch = (async () => { throw new Error('the smoke reached the network'); }) as typeof fetch;

// ---- Fixtures ----

/** An instant from a wall time ('yyyy-MM-dd HH:mm') in a zone, through the one resolver. */
const at = (local: string, tz = IL): Date => wallTimeToInstant(local.replace(' ', 'T'), tz);
const hm = (d: Date | null | undefined, tz = IL) => (d ? instantToWallTime(d, tz).slice(11, 16) : 'none');
const dayOf = (d: Date, tz = IL) => instantToWallTime(d, tz).slice(0, 10);

/** A zman reminder as the parser hands it over: date-only, local midnight of the said day (or of today). */
function zmanReminder(zman: Record<string, unknown>, opts: { day?: string; said?: boolean; now: Date; tz?: string } & Partial<ParsedEvent>): ParsedEvent {
  const { day, said, now, tz = IL, ...over } = opts;
  const start = at(`${day ?? dayOf(now, tz)} 00:00`, tz);
  return {
    title: 'Say Shema', startTime: start, endTime: new Date(start.getTime()), allDay: true, confidence: 'high',
    kind: 'reminder', forPerson: 'self', calendarId: 'native:whatever', calendarName: 'Dana',
    zman: zman as ParsedEvent['zman'], ...(said ? { zmanDaySaid: true as const } : {}), ...over,
  };
}
const SHEMA = (offsetMinutes = -10, opinion: string | null = null) => ({ name: 'SOF_SHMA', opinion, offsetMinutes });
const SHKIA = (offsetMinutes = 0) => ({ name: 'SHKIA', opinion: null, offsetMinutes });

async function main() {
  const resolve = await import('../src/services/native-reminders/resolve');
  const { resolveReminderIntents, refreshReminderNotice, withZmanChoice, zmanTimingFor, zmanTimeOn } = resolve;
  const { isPaused } = await import('../src/services/zmanim/pause');
  const { zmanClockFor } = await import('../src/services/zmanim/reminder-clock');
  const { anchorQuestion } = await import('../src/services/voice/confirmations');

  /** One reminder through resolveReminderIntents, as every handler resolves it. Console lines are kept in `logs`. */
  async function resolveOne(event: ParsedEvent, now: Date, who: UserConfig = dana, tz = IL) {
    const kept = { log: console.log, warn: console.warn, error: console.error };
    const take = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.log = take; console.warn = take; console.error = take;
    try {
      const intent: VoiceIntentResult = { intent: 'create', confidence: 'high', event };
      const { intents, failures } = await resolveReminderIntents(who, [intent], tz, { now });
      return { event: intents[0].event, intent: intents[0], failure: failures[0] };
    } finally {
      Object.assign(console, kept);
    }
  }
  /** A person's time for a rule on a day, through the real clock. */
  async function clockTime(person: import('../src/services/zmanim/reminder-clock').ZmanUser, zone: string, day: string, spec: { zman: string; offsetMin: number } | { halachicHours: number; offsetMin: number }) {
    const clock = await zmanClockFor(person, zone);
    return clock ? clock.instant(day, spec) : null;
  }

  // ---- The mapping, under the writer's community ----

  await check('Sephardi "10 min before sof zman Shema" with no opinion: two choices, MGA then GRA, no rule, the model\'s words gone', async () => {
    const now = at('2026-10-28 06:00');
    const { event, failure } = await resolveOne(zmanReminder(SHEMA(), { now }), now);
    assert(event && !failure, show(failure));
    assert(event.zmanSpec === undefined && event.zman === undefined, `spec ${show(event.zmanSpec)}, zman ${show(event.zman)}`);
    assert(show(event.zmanChoices?.map((c) => c.spec)) === show([{ zman: 'SOF_SHMA_MGA', offsetMin: -10 }, { zman: 'SOF_SHMA_GRA', offsetMin: -10 }]), show(event.zmanChoices));
    assert(event.allDay && event.kind === 'reminder' && dayOf(event.startTime) === '2026-10-28', `${event.allDay} ${dayOf(event.startTime)}`);
    // The plan's example: Harish on 2026-10-28, GRA 08:27, MGA 07:53
    const times = await Promise.all(event.zmanChoices!.map((c) => clockTime(dana, IL, c.day, c.spec)));
    assert(show(times.map((t) => hm(t))) === show(['07:53', '08:27']), show(times.map((t) => hm(t))));
    assert(logs.some((l) => l.startsWith('[zman-voice]') && l.includes('2 opinions')), show(logs));
  });

  await check('a Chabad writer gets the one Shema key (no buttons); an opinion said is used as said', async () => {
    const now = at('2026-10-28 06:00');
    const chabad = await resolveOne(zmanReminder(SHEMA(), { now }), now, user({ zmanimCommunity: 'chabad' }));
    assert(show(chabad.event?.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && chabad.event?.zmanChoices === undefined, show(chabad.event));
    const gra = await resolveOne(zmanReminder(SHEMA(-10, 'gra'), { now }), now);
    assert(show(gra.event?.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && gra.event?.zmanChoices === undefined, show(gra.event));
    const hours = await resolveOne(zmanReminder({ halachicHours: 3, offsetMinutes: 0 }, { now }), now);
    assert(show(hours.event?.zmanSpec) === show({ halachicHours: 3, offsetMin: 0 }), show(hours.event));
  });

  await check('refused, nothing created, the person asked: an opinion the set lacks (naming what it has), a name it does not know, an offset past 12 hours', async () => {
    const now = at('2026-10-28 06:00');
    const mga = await resolveOne(zmanReminder(SHEMA(-10, 'mga'), { now }), now, user({ zmanimCommunity: 'chabad' }));
    assert(!mga.event && mga.intent.error === 'zman_not_offered', show(mga.intent));
    assert(mga.failure?.error === 'zman_not_offered' && mga.failure.description === 'Say Shema' && mga.failure.zmanRefusal === 'not_offered', show(mga.failure));
    assert(show(mga.failure.offered) === show([{ zman: 'SOF_SHMA_GRA', offsetMin: 0 }]), show(mga.failure.offered));
    assert(logs.some((l) => l.startsWith('[zman-voice]') && l.includes('not_offered')), show(logs));
    const plag = await resolveOne(zmanReminder({ name: 'PLAG', opinion: 'gra', offsetMinutes: 0 }, { now }), now);
    assert(plag.failure?.zmanRefusal === 'not_offered' && show(plag.failure.offered) === show([{ zman: 'PLAG_HALACHA_BERURA', offsetMin: 0 }, { zman: 'PLAG_YALKUT_YOSEF', offsetMin: 0 }]), show(plag.failure));
    const unknown = await resolveOne(zmanReminder({ name: 'RABBEINU_TAM', opinion: null, offsetMinutes: 0 }, { now }), now);
    assert(unknown.failure?.error === 'zman_not_offered' && unknown.failure.zmanRefusal === 'unknown' && show(unknown.failure.offered) === '[]', show(unknown.failure));
    const far = await resolveOne(zmanReminder(SHKIA(-800), { now }), now);
    assert(far.failure?.error === 'zman_not_offered' && far.failure.zmanRefusal === 'bad_offset', show(far.failure));
  });

  // ---- The day ----

  await check('no day said: today while the time is ahead, else tomorrow, per choice (MGA passed goes to tomorrow, GRA still today)', async () => {
    const before = at('2026-10-28 10:00');
    const today = await resolveOne(zmanReminder(SHKIA(), { now: before }), before);
    assert(dayOf(today.event!.startTime) === '2026-10-28' && today.event!.reminderNotice === undefined, show(today.event));
    const after = at('2026-10-28 19:00');
    const tomorrow = await resolveOne(zmanReminder(SHKIA(), { now: after }), after);
    assert(dayOf(tomorrow.event!.startTime) === '2026-10-29' && tomorrow.event!.reminderNotice === undefined, show(tomorrow.event));
    const eight = at('2026-10-28 08:00');
    const { event } = await resolveOne(zmanReminder(SHEMA(), { now: eight }), eight);
    assert(show(event?.zmanChoices?.map((c) => [c.spec, c.day])) === show([[{ zman: 'SOF_SHMA_MGA', offsetMin: -10 }, '2026-10-29'], [{ zman: 'SOF_SHMA_GRA', offsetMin: -10 }, '2026-10-28']]), show(event?.zmanChoices));
    assert(dayOf(event!.startTime) === '2026-10-28', 'the card\'s day is the earliest choice\'s');
  });

  await check('the notice is counted at the zman, not at the 09:00 reminder time: today\'s sunset at 10:00 has none, a passed one is "time passed", never "no time set"', async () => {
    const ten = at('2026-10-28 10:00');
    const ahead = await resolveOne(zmanReminder(SHKIA(-30), { now: ten, said: true }), ten);
    assert(ahead.event && ahead.event.reminderNotice === undefined && dayOf(ahead.event.startTime) === '2026-10-28', show(ahead.event));
    const evening = at('2026-10-28 19:00');
    const passed = await resolveOne(zmanReminder(SHKIA(-30), { now: evening, said: true }), evening);
    assert(passed.event?.reminderNotice === 'time_passed' && dayOf(passed.event.startTime) === '2026-10-28', show(passed.event));
    const refreshed = await refreshReminderNotice(ahead.event!, IL, ten, dana);
    assert(refreshed.reminderNotice === undefined, `refresh at 10:00: ${refreshed.reminderNotice}`);
    const later = await refreshReminderNotice(ahead.event!, IL, evening, dana);
    assert(later.reminderNotice === 'time_passed', `refresh at 19:00: ${later.reminderNotice}`);
  });

  await check('a repeat with no day said starts at its next time and has no notice; one with a passed said day has none either', async () => {
    const evening = at('2026-10-28 19:00');
    const daily = await resolveOne(zmanReminder(SHKIA(-10), { now: evening, recurrence: { frequency: 'daily' } }), evening);
    assert(dayOf(daily.event!.startTime) === '2026-10-29' && daily.event!.reminderNotice === undefined && daily.event!.recurrence?.frequency === 'daily', show(daily.event));
    const said = await resolveOne(zmanReminder(SHKIA(-10), { now: evening, said: true, recurrence: { frequency: 'daily' } }), evening);
    assert(dayOf(said.event!.startTime) === '2026-10-28' && said.event!.reminderNotice === undefined, show(said.event));
  });

  // ---- Whose place ----

  await check('"remind Raziel": timed at his own place and zone (New York), for the day pick and for the notice on refresh', async () => {
    const evening = at('2026-10-28 20:00'); // Harish's sunset has passed; New York's (about 23:55 Israel time) has not
    const theirs = await resolveOne(zmanReminder(SHKIA(), { now: evening, forPerson: 'partner' }), evening);
    assert(theirs.event?.forUserId === 2 && theirs.event.forBoth === false && dayOf(theirs.event.startTime) === '2026-10-28', show(theirs.event));
    const mine = await resolveOne(zmanReminder(SHKIA(), { now: evening }), evening);
    assert(dayOf(mine.event!.startTime) === '2026-10-29', show(mine.event));
    const nySunset = await clockTime(raziel, NY, '2026-10-28', { zman: 'SHKIA', offsetMin: 0 });
    assert(nySunset && nySunset.getTime() > evening.getTime(), `New York sunset ${nySunset?.toISOString()}`);
    // Refresh reads him by id: ahead at 20:00 (Harish's has passed), passed once his has
    const saidDay = { ...theirs.event!, zmanDaySaid: true as const };
    assert((await refreshReminderNotice(saidDay, IL, evening, dana)).reminderNotice === undefined, 'his sunset is ahead');
    const afterHis = new Date(nySunset.getTime() + 30 * 60_000);
    assert((await refreshReminderNotice(saidDay, IL, afterHis, dana)).reminderNotice === 'time_passed', 'his sunset has passed');
    const timing = await zmanTimingFor(dana, saidDay, IL);
    assert(timing.person.id === 2 && timing.zone === NY && hm(zmanTimeOn('2026-10-28', { zman: 'SHKIA', offsetMin: 0 }, timing, IL), NY) === hm(nySunset, NY), `${timing.person.id} ${timing.zone}`);
  });

  await check('"remind us both": the creator\'s times (and choices), each partner needing a place; a partner not on Telegram keeps it the creator\'s with the notice', async () => {
    const evening = at('2026-10-28 20:00');
    const both = await resolveOne(zmanReminder(SHKIA(), { now: evening, forPerson: 'both' }), evening);
    assert(both.event?.forBoth === true && both.event.forUserId === 2 && dayOf(both.event.startTime) === '2026-10-29', show(both.event));
    const six = at('2026-10-28 06:00');
    const choices = await resolveOne(zmanReminder(SHEMA(), { now: six, forPerson: 'both' }), six);
    assert(choices.event?.zmanChoices?.length === 2 && choices.event.forBoth === true, show(choices.event));
    partner = { ...raziel, telegramId: null };
    const off = await resolveOne(zmanReminder(SHKIA(), { now: evening, forPerson: 'partner' }), evening);
    assert(off.event?.forUserId === null && off.event.reminderNotice === 'partner_not_on_telegram' && dayOf(off.event.startTime) === '2026-10-29', show(off.event));
  });

  await check('no place: refused (zman_no_place), the partner named when it is theirs; the zone\'s main city stands in for a person with none saved', async () => {
    const now = at('2026-10-28 06:00');
    zones[5] = TOKYO;
    const lost = await resolveOne(zmanReminder(SHKIA(), { now, tz: TOKYO }), now, user({ id: 5, ...NOWHERE }), TOKYO);
    assert(!lost.event && lost.failure?.error === 'zman_no_place' && lost.failure.name === undefined, show(lost.failure));
    assert(logs.some((l) => l.startsWith('[zman-voice]') && l.includes('no place')), show(logs));
    const zoneOnly = await resolveOne(zmanReminder(SHKIA(), { now }), now, user({ id: 6, ...NOWHERE }));
    assert(show(zoneOnly.event?.zmanSpec) === show({ zman: 'SHKIA', offsetMin: 0 }), show(zoneOnly));
    partner = { ...raziel, ...NOWHERE };
    zones[2] = TOKYO;
    const theirs = await resolveOne(zmanReminder(SHKIA(), { now, forPerson: 'partner' }), now);
    assert(theirs.failure?.error === 'zman_no_place' && theirs.failure.name === 'Raziel', show(theirs.failure));
    const both = await resolveOne(zmanReminder(SHKIA(), { now, forPerson: 'both' }), now);
    assert(both.failure?.error === 'zman_no_place' && both.failure.name === 'Raziel', show(both.failure));
  });

  await check('no such time (polar night): a one-off is refused (zman_no_time), said day or not; a repeat is created', async () => {
    zones[7] = OSLO;
    const north = user({ id: 7, ...TROMSO });
    const now = at('2026-12-15 08:00', OSLO);
    const said = await resolveOne(zmanReminder({ name: 'NETZ', opinion: null, offsetMinutes: 0 }, { now, tz: OSLO, said: true }), now, north, OSLO);
    assert(!said.event && said.failure?.error === 'zman_no_time', show(said.failure));
    const unsaid = await resolveOne(zmanReminder({ name: 'NETZ', opinion: null, offsetMinutes: 0 }, { now, tz: OSLO }), now, north, OSLO);
    assert(unsaid.failure?.error === 'zman_no_time', show(unsaid.failure));
    const daily = await resolveOne(zmanReminder({ name: 'NETZ', opinion: null, offsetMinutes: 0 }, { now, tz: OSLO, recurrence: { frequency: 'daily' } }), now, north, OSLO);
    assert(show(daily.event?.zmanSpec) === show({ zman: 'NETZ', offsetMin: 0 }) && dayOf(daily.event!.startTime, OSLO) === '2026-12-15', show(daily));
  });

  await check('the partner summary (and a refresh\'s lookup) selects every field the zman clock and the pause read', async () => {
    const file = path.join(SRC, 'services/native-reminders/ownership.ts');
    loadingReal.add(file);
    let real: typeof import('../src/services/native-reminders/ownership');
    try {
      real = require(file); // eslint-disable-line @typescript-eslint/no-require-imports
    } finally {
      loadingReal.delete(file);
    }
    const fields = ['location', 'latitude', 'longitude', 'elevationM', 'zmanimCommunity', 'pauseOnShabbat', 'reminderTime'];
    await real.getActivePartnerSummary(1, 'pair-1');
    assert(fields.every((f) => selects[0]?.[f] === true), `partner summary: ${show(selects[0])}`);
    const start = at('2026-10-30 00:00');
    await refreshReminderNotice({ title: 'x', startTime: start, endTime: start, allDay: true, confidence: 'high', kind: 'reminder', forUserId: 2, forBoth: false, zmanSpec: { zman: 'SHKIA', offsetMin: 0 } }, IL, at('2026-10-28 10:00'), dana);
    assert(fields.every((f) => selects[1]?.[f] === true), `refresh: ${show(selects[1])}`);
  });

  // ---- The pause note (through isPaused, never a second window rule) ----

  await check('pause note: a one-off at Friday\'s sunset is held, 30 minutes before it is not, candle lighting is whatever isPaused says', async () => {
    const now = at('2026-10-28 10:00');
    const friday = { now, day: '2026-10-30', said: true };
    const sunset = await resolveOne(zmanReminder(SHKIA(), friday), now);
    assert(sunset.event?.reminderPaused === true, `sunset: ${show(sunset.event)}`);
    const before = await resolveOne(zmanReminder(SHKIA(-30), friday), now);
    assert(before.event?.reminderPaused === undefined, `30 before: ${show(before.event)}`);
    const candles = await resolveOne(zmanReminder({ name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: 0 }, friday), now);
    const candleAt = await clockTime(dana, IL, '2026-10-30', { zman: 'CANDLE_LIGHTING', offsetMin: 0 });
    assert((candles.event?.reminderPaused === true) === (await isPaused(dana, candleAt!)), `candle lighting: ${show(candles.event)}`);
    const saturday = await resolveOne(zmanReminder({ name: 'PLAG', opinion: 'halachaBerura', offsetMinutes: 0 }, { now, day: '2026-10-31', said: true }), now);
    assert(saturday.event?.reminderPaused === true, `Saturday plag: ${show(saturday.event)}`);
  });

  await check('pause note: none with the pause off, none on a repeat; each choice has its own; a refresh works it out again', async () => {
    const now = at('2026-10-28 10:00');
    const off = await resolveOne(zmanReminder(SHKIA(), { now, day: '2026-10-30', said: true }), now, user({ pauseOnShabbat: false }));
    assert(off.event && off.event.reminderPaused === undefined, show(off.event));
    const weekly = await resolveOne(zmanReminder(SHKIA(), { now, day: '2026-10-30', said: true, recurrence: { frequency: 'weekly', daysOfWeek: ['FR'] } }), now);
    assert(weekly.event && weekly.event.reminderPaused === undefined, show(weekly.event));
    const shabbat = await resolveOne(zmanReminder(SHEMA(), { now, day: '2026-10-31', said: true }), now);
    assert(shabbat.event?.zmanChoices?.length === 2 && shabbat.event.zmanChoices.every((c) => c.paused === true && c.day === '2026-10-31'), show(shabbat.event));
    const thursday = await resolveOne(zmanReminder(SHEMA(), { now, day: '2026-10-29', said: true }), now);
    assert(thursday.event?.zmanChoices?.every((c) => c.paused === undefined), show(thursday.event));
    // Moved to Shabbat (a quick fix of the day): the refresh notes each choice
    const moved = { ...thursday.event!, zmanChoices: thursday.event!.zmanChoices!.map((c) => ({ ...c, day: '2026-10-31' })) };
    const refreshed = await refreshReminderNotice(moved, IL, now, dana);
    assert(refreshed.zmanChoices?.every((c) => c.paused === true), show(refreshed.zmanChoices));
    const single = await refreshReminderNotice({ ...sunsetEvent(), reminderPaused: undefined }, IL, now, dana);
    assert(single.reminderPaused === true, show(single));
    const unpaused = await refreshReminderNotice(sunsetEvent(), IL, now, user({ pauseOnShabbat: false }));
    assert(unpaused.reminderPaused === undefined, show(unpaused));
  });
  function sunsetEvent(): ParsedEvent {
    const start = at('2026-10-30 00:00');
    return { title: 'Light', startTime: start, endTime: start, allDay: true, confidence: 'high', kind: 'reminder', forUserId: null, forBoth: false, zmanSpec: { zman: 'SHKIA', offsetMin: 0 }, zmanDaySaid: true, reminderPaused: true };
  }

  // ---- The choices on the pending card, and the tap ----

  await check('the choices survive the pending card\'s JSON; a tap makes that one the rule on its own day, and an index it lacks is null', async () => {
    const eight = at('2026-10-28 08:00');
    const { event } = await resolveOne(zmanReminder(SHEMA(), { now: eight }), eight);
    const stored = JSON.parse(JSON.stringify(event)) as ParsedEvent;
    stored.startTime = new Date(stored.startTime);
    stored.endTime = new Date(stored.endTime);
    const mga = withZmanChoice(stored, 0, IL)!;
    assert(show(mga.zmanSpec) === show({ zman: 'SOF_SHMA_MGA', offsetMin: -10 }) && mga.zmanChoices === undefined && dayOf(mga.startTime) === '2026-10-29' && mga.allDay, show(mga));
    assert(mga.endTime.getTime() === mga.startTime.getTime(), 'one moment');
    const gra = withZmanChoice(stored, 1, IL)!;
    assert(show(gra.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && dayOf(gra.startTime) === '2026-10-28', show(gra));
    assert(withZmanChoice(stored, 2, IL) === null && withZmanChoice({ ...stored, zmanChoices: undefined }, 0, IL) === null, 'no such choice');
  });

  // ---- What a refused one is asked ----

  await check('the questions: each zman refusal in en/he/ru names the reminder, the partner\'s missing place names them, escaped for Telegram', async () => {
    const description = 'Shema <now>';
    for (const language of ['en', 'he', 'ru']) {
      const seen = new Set<string>();
      for (const error of ['zman_not_offered', 'zman_no_place', 'zman_no_time'] as const) {
        const html = await anchorQuestion({ error, description }, language);
        assert(html.includes('Shema &lt;now&gt;') && !html.includes('nativeReminders.'), `${language} ${error}: ${html}`);
        const plain = await anchorQuestion({ error, description }, language, false);
        assert(plain.includes(description), `${language} ${error} plain: ${plain}`);
        seen.add(html);
      }
      const theirs = await anchorQuestion({ error: 'zman_no_place', description, name: 'Raz<i>el' }, language);
      assert(theirs.includes('Raz&lt;i&gt;el') && !seen.has(theirs), `${language}: ${theirs}`);
      assert(seen.size === 3, `${language}: the three questions differ`);
    }
    const anchor = await anchorQuestion({ error: 'anchor_not_found', description: 'the dentist' }, 'en');
    assert(anchor === 'I couldn\'t find “the dentist” in your calendar. Send it again with a time, like “remind me at 16:00 to …”.', anchor);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'OK ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.env[CHILD]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runChildren();
}
