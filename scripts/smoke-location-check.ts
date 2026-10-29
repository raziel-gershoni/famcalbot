// Smoke test for the check of a place typed in Settings (the final review's M-3): our server asks OpenStreetMap, so the
// person's browser never does and OpenStreetMap sees our server's address; "use my location" still asks from the browser
// (the Privacy Policy promises the device's position never reaches our servers), and the Policy says OpenStreetMap sees
// the browser's IP address for it.
//
//  - L1 POST /api/location/check asks Nominatim's search once, from the server, with the place, English names and our
//    User-Agent, and answers what the hits mean (src/lib/location-place.ts): a city as typed, a building collapsed to its
//    city, nothing found; Nominatim failing (an error status, a throw) answers "failed", logged and captured without the
//    place's name.
//  - L2 the person is authenticated as Settings' save is (a refusal is the auth's own answer, and nothing is asked of
//    Nominatim); an empty place is valid with nothing asked; a place too long is refused.
//  - L3 the browser's code asks our server for the typed place and never Nominatim's search; the reverse lookup stays in
//    the browser; the Policy's OpenStreetMap line names the IP address and the browser in en, he and ru.
//
// The real route and place logic run; the auth, the rate limit, error capture and the network are faked. No network,
// no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-location-check.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

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
const show = (v: unknown) => JSON.stringify(v);

// ---- Boundaries ----

const asked: { url: string; headers: Row }[] = [];
let nominatim: (url: URL) => Response | Promise<Response> = () => json([]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = new URL(String(input));
  asked.push({ url: url.toString(), headers: Object.fromEntries(new Headers(init.headers).entries()) });
  if (url.host === 'nominatim.openstreetmap.org') return nominatim(url);
  throw new Error(`an unexpected request: ${url}`);
}) as typeof fetch;

let authOk = true;
const logs: string[] = [];
const captured: string[] = [];
const stubs: Record<string, object> = {
  [`${SRC}/lib/api-auth.ts`]: {
    verifyUserAuth: async () => (authOk ? { success: true, user: { id: 7 }, via: 'telegram' } : { success: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }),
  },
  [`${SRC}/lib/rate-limit.ts`]: { generalRateLimiter: {}, settingsRateLimiter: {} },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (e: unknown, context: string) => void captured.push(`${context}: ${e instanceof Error ? e.message : String(e)}`),
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  },
};
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {
    // An unresolvable request goes to the real loader, which says why
  }
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};

const CONSOLE = { log: console.log, warn: console.warn, error: console.error };
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const take = (...args: unknown[]) => void logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  Object.assign(console, { log: take, warn: take, error: take });
  try {
    return await fn();
  } finally {
    Object.assign(console, CONSOLE);
  }
}
const reset = () => {
  asked.length = 0;
  logs.length = 0;
  captured.length = 0;
  authOk = true;
  nominatim = () => json([]);
};

async function main() {
  const { POST } = await import('../app/api/location/check/route');
  const { NextRequest } = await import('next/server');
  const ask = async (body: Row) => {
    const response = await quietly(() => POST(new NextRequest('https://famcal.test/api/location/check?user_id=5007', { method: 'POST', body: JSON.stringify({ initData: 'x', ...body }) })));
    return { status: response.status, body: (await response.json()) as Row };
  };

  await check('L1 the server asks Nominatim\'s search once (the place, English names, our User-Agent) and answers what the hits mean: a city as typed, a building as its city, nothing found; an error status or a throw is "failed", logged and captured without the place', async () => {
    reset();
    nominatim = () => json([{ place_rank: 16, addresstype: 'city' }]);
    let a = await ask({ place: '  Haifa ' });
    assert(show(a) === show({ status: 200, body: { check: { kind: 'valid', normalized: 'Haifa' } } }), `a city: ${show(a)}`);
    assert(asked.length === 1, `${asked.length} requests`);
    const url = new URL(asked[0].url);
    assert(url.pathname === '/search' && url.searchParams.get('q') === 'Haifa' && url.searchParams.get('format') === 'json' && url.searchParams.get('limit') === '1' && url.searchParams.get('addressdetails') === '1', `the request ${asked[0].url}`);
    assert(asked[0].headers['accept-language'] === 'en' && /FamilyCalendarBot/.test(asked[0].headers['user-agent'] ?? ''), `the headers ${show(asked[0].headers)}`);
    reset();
    nominatim = () => json([{ place_rank: 30, addresstype: 'building', address: { house_number: '12', road: 'Herzl', city: 'Haifa', country: 'Israel' } }]);
    a = await ask({ place: 'Herzl 12, Haifa' });
    assert(show(a.body) === show({ check: { kind: 'valid', normalized: 'Haifa, Israel' } }), `a building: ${show(a)}`);
    reset();
    a = await ask({ place: 'Nowhereville' });
    assert(show(a.body) === show({ check: { kind: 'notFound' } }), `nothing: ${show(a)}`);
    for (const [label, answer] of [['503', () => json({}, 503)], ['a throw', () => { throw new TypeError('fetch failed for https://nominatim.openstreetmap.org/search?q=Secret%20Street'); }]] as [string, () => Response][]) {
      reset();
      nominatim = answer;
      a = await ask({ place: 'Secret Street' });
      assert(show(a) === show({ status: 200, body: { check: { kind: 'failed' } } }), `${label}: ${show(a)}`);
      assert(logs.some((l) => l.includes('[location-check]')), `${label}: not logged: ${show(logs)}`);
      assert(![...logs, ...captured].some((l) => /Secret|Street/.test(l)), `${label}: the place is in a log or in Sentry: ${show([...logs, ...captured])}`);
      if (label === 'a throw') assert(captured.some((c) => c.startsWith('location-check')), `${label}: not captured: ${show(captured)}`);
    }
  });

  await check('L2 a person the auth refuses gets its answer and nothing is asked of Nominatim; an empty place is valid with nothing asked; a place over 200 characters is refused', async () => {
    reset();
    authOk = false;
    let a = await ask({ place: 'Haifa' });
    assert(a.status === 401 && asked.length === 0, `refused: ${show(a)}, ${asked.length} requests`);
    reset();
    a = await ask({ place: '   ' });
    assert(show(a.body) === show({ check: { kind: 'valid', normalized: '' } }) && asked.length === 0, `empty: ${show(a)}`);
    a = await ask({ place: 'x'.repeat(201) });
    assert(a.status === 400 && asked.length === 0, `too long: ${show(a)}`);
    a = await ask({ place: 42 });
    assert(a.status === 400, `not a string: ${show(a)}`);
  });

  await check('L3 the browser asks our server for a typed place and never Nominatim\'s search; "use my location" stays in the browser; the Policy\'s OpenStreetMap line names the IP address and the browser in en, he and ru', () => {
    const settings = path.join(ROOT, 'app/[locale]/(app)/settings');
    const code = fs.readdirSync(settings).filter((f) => /\.tsx?$/.test(f)).map((f) => fs.readFileSync(path.join(settings, f), 'utf8')).join('\n');
    assert(!/nominatim\.openstreetmap\.org\/search/.test(code), 'the browser still asks Nominatim\'s search');
    assert(/fetch\(`\/api\/location\/check\?user_id=/.test(code), 'the browser does not ask our server');
    assert(/nominatim\.openstreetmap\.org\/reverse/.test(code), 'the reverse lookup left the browser: the Policy promises the position never reaches our servers');
    const IP: Record<string, RegExp> = { en: /IP address/, he: /כתובת ה־IP/, ru: /IP-адрес/ };
    for (const l of ['en', 'he', 'ru']) {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'));
      const line = m.legal.privacy.sections.processors.blocks[1].find((x: unknown) => typeof x === 'string' && x.includes('OpenStreetMap (Nominatim)')) as string;
      assert(line && IP[l].test(line), `${l}: the OpenStreetMap line says nothing of the IP address: ${line}`);
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
