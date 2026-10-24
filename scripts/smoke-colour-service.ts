// Smoke test for the colour service (src/services/native-calendar/colour.ts).
//
// I1: the nudge and the auto-pick judge a Google calendar by the colour the home draws:
//   the live calendarList colour (the range read's, or the one remembered from its last
//   read), then the saved choice colour, then Google's default; all through mapGoogleColour.
// M2: a failure in the colour step (a DB blip) never fails the caller: the display falls back
//   to no nudge, the pick to the first palette colour, and each failure is logged and captured.
//
// Prisma, Redis and the event store are faked. No network.
//
//   npx tsx scripts/smoke-colour-service.ts

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

process.env.ENCRYPTION_KEY_PREVIOUS = '';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
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

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeRequire = createRequire(import.meta.url);
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
      'export default (s.__esModule ? s.default : s);',
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

// ---- Fakes ----

const redisStore = new Map<string, unknown>();
let redisFails = false;
let natives: Row[] = [];
let nativesFail = false;
const captured: { ctx: string; message: string }[] = [];
const logged: string[] = [];

stub('src/utils/redis.ts', {
  redis: {
    get: async (key: string) => {
      if (redisFails) throw new Error('redis down');
      return redisStore.has(key) ? JSON.parse(JSON.stringify(redisStore.get(key))) : null;
    },
    set: async (key: string, value: unknown) => {
      if (redisFails) throw new Error('redis down');
      redisStore.set(key, value);
      return 'OK';
    },
  },
});
stub('src/lib/error-capture.ts', {
  captureError: (e: unknown, ctx: string) => void captured.push({ ctx, message: e instanceof Error ? e.message : String(e) }),
  captureWarning: (e: unknown, ctx: string) => void captured.push({ ctx, message: e instanceof Error ? e.message : String(e) }),
  captureInfo: () => undefined,
});
stub('src/services/native-calendar/event-store.ts', {
  encodeCalendarId: (id: string) => `native:${id}`,
  listVisibleCalendars: async () => {
    if (nativesFail) throw new Error('db blip');
    return natives;
  },
});
const realError = console.error;
const realWarn = console.warn;
console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(' '));

function reset() {
  redisStore.clear();
  redisFails = false;
  natives = [];
  nativesFail = false;
  captured.length = 0;
  logged.length = 0;
}

const user = (choices: Row[]) => ({ id: 7, pairingId: null, googleRefreshToken: 'rt', calendarSource: 'NATIVE', calendarAssignments: choices });
const native = (id: string, color: string) => ({ id, color });

async function main() {
  const colour = (await import('../src/services/native-calendar/colour')) as Row;
  const cols = (await import('../src/lib/calendar-colours')) as Row;
  const PEACOCK_CLASSIC = '#9fe1e7'; // Google's API colour that its app shows as #039be5
  const PEACOCK = '#039be5';

  await check('I1 a choice saved with no colour is judged by the live colour: the Peacock native calendar is nudged off the blue the home draws', async () => {
    natives = [native('a', PEACOCK)];
    const map = await colour.displayColourMap(user([{ calendarId: 'g1', name: 'G' }]), { g1: PEACOCK_CLASSIC });
    const drawn = map.get('native:a');
    assert(drawn !== undefined && drawn !== PEACOCK, `drawn ${drawn}`);
  });

  await check('I1 a stale saved colour is not what is judged: live blue nudges the blue native, the native on the stale colour stays', async () => {
    natives = [native('a', PEACOCK), native('b', '#f4511e')];
    const map = await colour.displayColourMap(user([{ calendarId: 'g1', name: 'G', color: '#fa573c' }]), { g1: PEACOCK_CLASSIC });
    assert(map.get('native:a') !== PEACOCK, `a ${map.get('native:a')}`);
    assert(map.get('native:b') === '#f4511e', `b ${map.get('native:b')}`);
  });

  await check('I1 the colours remembered from the last read give the same answer where no read happens, and are replaced by a newer read', async () => {
    natives = [native('a', PEACOCK)];
    const u = user([{ calendarId: 'g1', name: 'G', color: '#f4511e' }]);
    await colour.rememberLiveColours(7, { g1: PEACOCK_CLASSIC });
    const map = await colour.displayColourMap(u);
    assert(map.get('native:a') !== PEACOCK, `remembered: ${map.get('native:a')}`);
    const pick = await colour.autoCalendarColour(u);
    assert(cols.displayDistance(pick, PEACOCK) >= cols.MIN_DELTA_E, `pick ${pick} too close to the blue on screen`);
    await colour.rememberLiveColours(7, { g1: '#d50000' });
    natives = [native('a', PEACOCK)];
    assert((await colour.displayColourMap(u)).get('native:a') === PEACOCK, 'a newer live colour is used');
  });

  await check('I1 the calendars page colours: live, then remembered, then saved, then the Google default; all mapped', async () => {
    const u = user([
      { calendarId: 'live', name: 'A', color: '#f4511e' },
      { calendarId: 'rem', name: 'B', color: '#f4511e' },
      { calendarId: 'saved', name: 'C', color: '#16a765' },
      { calendarId: 'none', name: 'D' },
    ]);
    await colour.rememberLiveColours(7, { rem: '#9fc6e7' });
    const got = await colour.googleColoursOnScreen(u, { live: PEACOCK_CLASSIC });
    assert(JSON.stringify(got.map((c: Row) => c.color)) === JSON.stringify([PEACOCK, '#4285f4', '#0b8043', PEACOCK]), JSON.stringify(got));
  });

  await check('M2 the display step: a DB blip gives no nudge, no throw, and is logged and captured', async () => {
    nativesFail = true;
    const map = await colour.displayColourMap(user([{ calendarId: 'g1', name: 'G' }]));
    assert(map instanceof Map && map.size === 0, `map ${[...map]}`);
    assert(captured.some((c) => c.message === 'db blip'), `captured ${JSON.stringify(captured)}`);
    assert(logged.length > 0, 'nothing logged');
  });

  await check('M2 the pick: a DB blip gives the first palette colour, and is captured', async () => {
    nativesFail = true;
    const pick = await colour.autoCalendarColour(user([]));
    assert(pick === cols.CALENDAR_PALETTE[0].hex, `pick ${pick}`);
    assert(captured.some((c) => c.message === 'db blip'), `captured ${JSON.stringify(captured)}`);
  });

  await check('I1 a Redis failure while remembering or recalling costs only the live colours: saved ones are used, and it is captured', async () => {
    redisFails = true;
    natives = [native('a', '#f4511e')];
    const map = await colour.displayColourMap(user([{ calendarId: 'g1', name: 'G', color: '#fa573c' }]));
    assert(map.get('native:a') !== '#f4511e', 'saved colour (mapped Tangerine) still nudges the native');
    await colour.rememberLiveColours(7, { g1: PEACOCK_CLASSIC });
    assert(captured.length >= 2, `captured ${JSON.stringify(captured)}`);
  });

  console.error = realError;
  console.warn = realWarn;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
