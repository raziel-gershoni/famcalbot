// Smoke test for the share-story image links (secret rotation, spec section b). The links
// were signed with ENCRYPTION_KEY || CRON_SECRET, so one secret did another's job and
// rotating ENCRYPTION_KEY also changed the image links. Now they are signed with their own
// key, derived from SESSION_SECRET by HKDF (src/lib/app-keys.ts), with no fallback:
// without SESSION_SECRET no link is signed or accepted, and sign refuses before it builds
// an image. A link's time may run at most 60 s ahead of the server's clock.
//
// Real: app-keys, image-link and both weather-image routes. Faked at the boundaries:
// Redis (in memory), the user auth (a proved user 9 with a location), the rate limiter,
// error capture (recorded) and the weather services (every build recorded). No network,
// no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-image-link.ts

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const env = process.env as Record<string, string | undefined>;

// Every value this smoke depends on is set here, never taken from the fake env.
const SESSION = 'test-session-secret-image';
const ENC_KEY = '0'.repeat(64);
const CRON = 'test-cron-image';
Object.assign(env, {
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || 'test',
  SESSION_SECRET: SESSION,
  ENCRYPTION_KEY: ENC_KEY,
  ENCRYPTION_KEY_PREVIOUS: '',
  CRON_SECRET: CRON,
  NEXT_PUBLIC_APP_URL: 'https://famcal.test',
});

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

const show = (value: unknown) => JSON.stringify(value);
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
/** A second copy of a module, as another Next bundle holds it (require's cache dropped). */
function freshCopy(rel: string): Row {
  const file = path.join(ROOT, rel);
  delete nodeRequire.cache[file];
  return nodeRequire(file);
}

/** Runs fn with `vars` set in process.env, then puts the old values back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, env[k]]));
  Object.assign(env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
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

const redisStore = new Map<string, string>();
/** Every captureError: its context, its extra and the error's message. */
const captured: { ctx: string; extra?: Row; message: string }[] = [];
/** Every weather image build step that ran. */
const builds: string[] = [];

const USER = { id: 9, telegramId: 111111111, location: 'Tel Aviv', language: 'en', culture: 'default', name: 'Tal' };

function installStubs() {
  stub('src/utils/redis.ts', {
    redis: {
      get: async (k: string) => redisStore.get(k) ?? null,
      set: async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; },
    },
  });
  stub('src/lib/rate-limit.ts', {
    generalRateLimiter: { name: 'general' },
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  });
  const { NextResponse } = nodeRequire('next/server');
  // The proved user is 9 (auth itself is covered by smoke-oauth-weather.ts and smoke-initdata-header.ts)
  stub('src/lib/api-auth.ts', {
    verifyUserAuth: async (_req: unknown, userId: string | null) => (userId === '9'
      ? { success: true, via: 'telegram', user: USER }
      : { success: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }),
  });
  const capture = (e: unknown, ctx: string, extra?: Row) => {
    captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('src/services/weather/open-meteo.ts', { fetchWeather: async () => { builds.push('fetchWeather'); return {}; } });
  stub('src/services/weather/air-quality.ts', { fetchAirQuality: async () => { builds.push('fetchAirQuality'); return null; } });
  stub('src/services/weather/geocoding.ts', { getTimezone: async () => { builds.push('getTimezone'); return 'Asia/Jerusalem'; } });
  stub('src/services/weather/formatter.ts', { buildInfographicConfig: () => { builds.push('buildInfographicConfig'); return {}; } });
  stub('src/services/weather/infographic.tsx', {
    generateWeatherInfographic: async () => { builds.push('generateWeatherInfographic'); return Buffer.from('built image'); },
  });
}

// ---- Fixtures ----

const hmacHex = (key: crypto.BinaryLike, payload: string) => crypto.createHmac('sha256', key).update(payload).digest('hex');
const hkdf = (secret: string, purpose: string) => Buffer.from(crypto.hkdfSync('sha256', secret, '', `famcal/${purpose}/v1`, 32));
const linkPayload = (userId: string, source: string, msgId: string | null, ts: number | string) => `${userId}:${source}:${msgId ?? ''}:${ts}`;
/** The weather-image query for a link signed with `key` (source 'cached', the cached image). */
const linkQuery = (key: crypto.BinaryLike, ts: number | string = Date.now()) =>
  `user_id=9&ts=${ts}&sig=${hmacHex(key, linkPayload('9', 'cached', null, ts))}&source=cached`;

function resetState() {
  redisStore.clear();
  captured.length = 0;
  builds.length = 0;
  redisStore.set('story:img:9', Buffer.from('cached image').toString('base64'));
}

/** The once-per-process set app-keys keeps on globalThis, emptied so a check sees its own first report. */
function forgetMissingReports() {
  delete (globalThis as Row).__famcalAppKeyMissing;
}

const appKeyCaptures = (purpose: string) => captured.filter(c => c.ctx === 'app-key-missing' && c.extra?.purpose === purpose);

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');

  const fetchImage = async (query: string): Promise<Response> => {
    const { GET } = await load('app/api/weather-image/route.ts');
    return GET(new NextRequest(`http://localhost/api/weather-image?${query}`));
  };
  const sign = async (query: string): Promise<Response> => {
    const { GET } = await load('app/api/weather-image/sign/route.ts');
    return GET(new NextRequest(`http://localhost/api/weather-image/sign?${query}`));
  };
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const { log, warn, error } = console;
    Object.assign(console, { log: () => undefined, warn: () => undefined, error: () => undefined });
    try {
      return await fn();
    } finally {
      Object.assign(console, { log, warn, error });
    }
  };

  // ---- app-keys ----

  await check('#1 appKey is HKDF-SHA256 of SESSION_SECRET with info famcal/<purpose>/v1: 32 bytes, one key per purpose, never the secret itself', async () => {
    const { appKey } = await load('src/lib/app-keys.ts');
    const image = appKey('image-link');
    const session = appKey('session-cookie');
    assert(Buffer.isBuffer(image) && image.length === 32, `image-link key: ${show(image)}`);
    assert(image.equals(hkdf(SESSION, 'image-link')), 'the image-link key is not HKDF(SESSION_SECRET, famcal/image-link/v1)');
    assert(Buffer.isBuffer(session) && session.equals(hkdf(SESSION, 'session-cookie')), 'the session-cookie key is not HKDF(SESSION_SECRET, famcal/session-cookie/v1)');
    assert(!image.equals(session), 'the two purposes share a key');
    assert(!image.equals(Buffer.from(SESSION)), 'the key is the raw secret');
    // Env is read on each call
    const other = await withEnv({ SESSION_SECRET: 'another-session-secret' }, () => appKey('image-link'));
    assert(Buffer.isBuffer(other) && other.equals(hkdf('another-session-secret', 'image-link')), 'a changed SESSION_SECRET was not seen');
  });

  await check('#2 with SESSION_SECRET unset or empty, appKey is null and reports app-key-missing once per process per purpose, across two module copies', async () => {
    resetState();
    forgetMissingReports();
    const first = await load('src/lib/app-keys.ts');
    const second = freshCopy('src/lib/app-keys.ts');
    assert(first.appKey !== second.appKey, 'the second copy is the same module instance; the check proves nothing');
    const keys = await withEnv({ SESSION_SECRET: '' }, () => [
      first.appKey('image-link'), first.appKey('image-link'), second.appKey('image-link'), second.appKey('session-cookie'),
    ]);
    const unset = await withEnv({ SESSION_SECRET: '' }, () => {
      delete env.SESSION_SECRET;
      return first.appKey('session-cookie');
    });
    assert([...keys, unset].every(k => k === null), `keys: ${show(keys)} ${show(unset)}`);
    assert(appKeyCaptures('image-link').length === 1, `image-link reports: ${show(captured)}`);
    assert(appKeyCaptures('session-cookie').length === 1, `session-cookie reports: ${show(captured)}`);
    assert(captured.every(c => !c.message.includes(SESSION) && !show(c.extra).includes(SESSION)), 'a report carries the secret');
  });

  // ---- image-link ----

  await check('#3 signImageLink is HMAC-SHA256 under the image-link key over userId:source:msgId:ts; verifyImageLink takes it within the window only', async () => {
    const { signImageLink, verifyImageLink } = await load('src/lib/image-link.ts');
    const now = 1_760_000_000_000;
    const p = { userId: '9', source: 'summary', msgId: '5', ts: now };
    const sig = signImageLink(p);
    assert(sig === hmacHex(hkdf(SESSION, 'image-link'), '9:summary:5:1760000000000'), `sig ${sig}`);
    assert(signImageLink({ ...p, msgId: null }) === hmacHex(hkdf(SESSION, 'image-link'), '9:summary::1760000000000'), 'a null msg is not signed as an empty field');
    const verdicts = {
      now: verifyImageLink(p, sig, now),
      fiftyNineMinutesOld: verifyImageLink(p, sig, now + 59 * 60_000),
      thirtySecondsAhead: verifyImageLink(p, sig, now - 30_000),
      twoHoursAhead: verifyImageLink(p, sig, now - 2 * 3600_000),
      ninetySecondsAhead: verifyImageLink(p, sig, now - 90_000),
      twoHoursOld: verifyImageLink(p, sig, now + 2 * 3600_000),
      otherMsg: verifyImageLink({ ...p, msgId: '7' }, sig, now),
      otherSource: verifyImageLink({ ...p, source: 'cached' }, sig, now),
      otherUser: verifyImageLink({ ...p, userId: '42' }, sig, now),
      shortSig: verifyImageLink(p, sig.slice(0, 10), now),
      nanTs: verifyImageLink({ ...p, ts: NaN }, sig, now),
    };
    const want = {
      now: true, fiftyNineMinutesOld: true, thirtySecondsAhead: true, twoHoursAhead: false, ninetySecondsAhead: false,
      twoHoursOld: false, otherMsg: false, otherSource: false, otherUser: false, shortSig: false, nanTs: false,
    };
    assert(show(verdicts) === show(want), `verdicts ${show(verdicts)}`);
    const noKey = await withEnv({ SESSION_SECRET: '' }, () => ({ sign: signImageLink(p), verify: verifyImageLink(p, sig, now) }));
    assert(noKey.sign === null && noKey.verify === false, `with no key: ${show(noKey)}`);
  });

  // ---- weather-image: no other secret signs a link ----

  await check('#4 weather-image refuses a link signed with ENCRYPTION_KEY (401) and serves one signed with the image-link key (200)', async () => {
    resetState();
    const legacy = await quiet(() => fetchImage(linkQuery(ENC_KEY)));
    const current = await quiet(() => fetchImage(linkQuery(hkdf(SESSION, 'image-link'))));
    assert(legacy.status === 401, `ENCRYPTION_KEY-signed link: ${legacy.status}`);
    assert(current.status === 200, `image-link-key-signed link: ${current.status}`);
  });

  await check('#5 weather-image: a link whose ts is 2 h ahead is 401, and a ts that is not plain digits is 401 (the same link at now is 200)', async () => {
    resetState();
    const key = hkdf(SESSION, 'image-link');
    const now = Date.now();
    const ok = await quiet(() => fetchImage(linkQuery(key, now)));
    const ahead = await quiet(() => fetchImage(linkQuery(key, now + 2 * 3600_000)));
    const padded = await quiet(() => fetchImage(linkQuery(key, `${now}.0`)));
    assert(ok.status === 200, `ts now: ${ok.status}`);
    assert(ahead.status === 401, `ts now + 2 h: ${ahead.status}`);
    assert(padded.status === 401, `ts "${now}.0": ${padded.status}`);
  });

  // ---- sign: the key first ----

  await check('#6 sign returns a URL signed with the image-link key, and weather-image serves it', async () => {
    resetState();
    const res = await quiet(() => sign('user_id=9&source=cached'));
    assert(res.status === 200, `sign: ${res.status}`);
    const { url } = await res.json();
    const u = new URL(url);
    const ts = u.searchParams.get('ts') ?? '';
    const sig = u.searchParams.get('sig') ?? '';
    assert(u.origin === 'https://famcal.test' && u.searchParams.get('user_id') === '9' && u.searchParams.get('source') === 'cached', `url ${url}`);
    assert(sig === hmacHex(hkdf(SESSION, 'image-link'), linkPayload('9', 'cached', null, ts)), 'the URL is not signed with the image-link key');
    const served = await quiet(() => fetchImage(u.searchParams.toString()));
    assert(served.status === 200, `weather-image on the signed URL: ${served.status}`);
    assert(builds.length === 0, `a cached image was rebuilt: ${show(builds)}`);
  });

  await check('#7 ENCRYPTION_KEY="" SESSION_SECRET="" CRON_SECRET=C: a C-signed link is 401, and sign is 500 with an app-key-missing report and no image built', async () => {
    resetState();
    forgetMissingReports();
    const { link, signed, signCaptures } = await withEnv({ ENCRYPTION_KEY: '', SESSION_SECRET: '', CRON_SECRET: CRON }, async () => {
      const link = await quiet(() => fetchImage(linkQuery(CRON)));
      // The link fetch above may have reported the missing key already; sign must report on its own
      forgetMissingReports();
      captured.length = 0;
      const signed = await quiet(() => sign('user_id=9&source=fresh'));
      return { link, signed, signCaptures: appKeyCaptures('image-link').length };
    });
    assert(link.status === 401, `CRON_SECRET-signed link: ${link.status}`);
    assert(signed.status === 500, `sign: ${signed.status}`);
    assert(builds.length === 0, `an image was built for a link that can't be signed: ${show(builds)}`);
    assert(signCaptures === 1, `sign's app-key-missing reports: ${signCaptures} (${show(captured)})`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
