// Records the S3 exchanges of one air-quality read (Tel Aviv, Asia/Jerusalem) for scripts/smoke-air-quality.ts, which
// replays them through a mocked fetch (the dust spike's ruling R7). It reads Open-Meteo's public open data (no key, no
// user data). Run once on a developer machine, never in CI; the fixture it writes is committed. Re-record after a
// change to the reader's reads:
//   npx tsx scripts/record-cams-fixture.ts
// It stops with nothing written on any failure.

import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'scripts/fixtures/cams-tel-aviv.json');
const PLACE = { latitude: 32.0853, longitude: 34.7818 };
const ZONE = 'Asia/Jerusalem';
const KEPT_HEADERS = ['content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'accept-ranges'];
type Exchange = { method: string; url: string; range: string | null; status: number; headers: Record<string, string>; body: string };

const nodeRequire = createRequire(__filename);
const exchanges: Exchange[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? 'GET';
  const range = new Headers(init?.headers).get('range');
  const response = await realFetch(input, init);
  const body = method === 'HEAD' ? '' : Buffer.from(await response.clone().arrayBuffer()).toString('base64');
  const headers = Object.fromEntries([...response.headers.entries()].filter(([name]) => KEPT_HEADERS.includes(name)));
  exchanges.push({ method, url, range, status: response.status, headers, body });
  return response;
}) as typeof fetch;

const internals = Module as unknown as { _cache: Record<string, unknown> };
const stub = (rel: string, exports: Record<string, unknown>) => {
  const filename = path.join(ROOT, rel);
  const mod = new (Module as unknown as new (id: string) => Record<string, unknown>)(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  internals._cache[filename] = mod;
};
stub('src/services/weather/geocoding.ts', { geocodeLocation: async () => ({ ...PLACE, timezone: ZONE }) });
stub('src/lib/error-capture.ts', {
  captureError: (e: unknown) => { throw e instanceof Error ? e : new Error(String(e)); },
  captureWarning: (m: string) => { throw new Error(m); },
  captureInfo: () => {},
});

async function main(): Promise<void> {
  const air = nodeRequire(path.join(ROOT, 'src/services/weather/air-quality.ts')) as typeof import('../src/services/weather/air-quality');
  const recordedAt = Date.now();
  air.__useAirForTests({ now: () => recordedAt });
  const expected = await air.fetchAirQuality('Tel Aviv', ZONE);
  if (!expected) throw new Error('the read gave nothing');
  const bytes = exchanges.reduce((sum, e) => sum + e.body.length, 0);
  fs.writeFileSync(OUT, `${JSON.stringify({ recordedAt, place: PLACE, zone: ZONE, exchanges, expected })}\n`);
  console.log(`[cams-fixture] ${exchanges.length} exchanges, ${Math.round(bytes / 1024)} KB of base64, ${expected.hourly.time.length} hours, to ${path.relative(ROOT, OUT)}`);
  process.exit(0);
}

main().catch(error => {
  console.error('[cams-fixture] stopped, nothing written:', error);
  process.exit(1);
});
