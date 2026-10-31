// Guard: Open-Meteo's free API forbids commercial use (spec docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md
// §1), so no file in src/ or app/ names one of its API hosts (each ends in api.open-meteo.com: api., air-quality-api.,
// geocoding-api., customer-api., ...). Allowed: its public open data on S3 (openmeteo.s3.amazonaws.com, the dust) and the
// credit its licence requires ("Weather data by Open-Meteo.com", linking https://open-meteo.com/). Also: the server-only
// lookups never reach a 'use client' file, next.config.js keeps what they need, the Policy names MET Norway and no longer
// Open-Meteo, and the credits exist in every language. Nothing is faked: it reads files. No network.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const results: { name: string; ok: boolean; reason?: string }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);
const files = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(rel);
    return [rel];
  });
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OPEN_METEO_API = /[\w.-]*api\.open-meteo\.com/i;

check('no file in src/ or app/ names an Open-Meteo API host (the scanner finds them in probes and lets the open data and the credit be)', () => {
  for (const host of ['https://api.open-meteo.com/v1/forecast', 'https://air-quality-api.open-meteo.com/v1/air-quality', 'https://customer-api.open-meteo.com/v1/forecast', 'https://geocoding-api.open-meteo.com/v1/search']) {
    assert(OPEN_METEO_API.test(host), `the scanner misses ${host}`);
  }
  for (const allowed of ['https://openmeteo.s3.amazonaws.com/data/cams_global/static/meta.json', 'https://open-meteo.com/', 'Weather data by Open-Meteo.com']) {
    assert(!OPEN_METEO_API.test(allowed), `the scanner flags ${allowed}`);
  }
  const hits = [...files('src'), ...files('app')].filter(f => OPEN_METEO_API.test(read(f)));
  assert(hits.length === 0, `Open-Meteo API hosts in ${show(hits)}`);
});

check('no \'use client\' file imports the weather, the zmanim, the zone lookup, geo-tz or the CAMS reader', () => {
  const FORBIDDEN = /(services\/(weather|zmanim)(\/|$)|lib\/timezone|lib\/zone-for-coords|geo-tz|@openmeteo\/)/;
  const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  const clients = [...files('app'), ...files('components'), ...files('src')].filter(f => /\.(t|j)sx?$/.test(f) && /^\s*['"]use client['"]/m.test(read(f)));
  assert(clients.length > 0, 'found no client file: the scanner is broken');
  const bad = clients.filter(f =>
    read(f).split('\n').some(line => !/^\s*import\s+type\b/.test(line) && [...line.matchAll(SPECIFIER)].some(m => FORBIDDEN.test(m[1]))),
  );
  assert(bad.length === 0, `client files importing server-only code: ${show(bad)}`);
  for (const probe of ["import { x } from '../../services/weather/forecast';", "import('@/src/services/zmanim')", "const z = require('geo-tz');", "import { y } from '@openmeteo/file-reader';", "import { z } from '@/src/lib/zone-for-coords';"]) {
    assert([...probe.matchAll(SPECIFIER)].some(m => FORBIDDEN.test(m[1])), `the scanner misses ${probe}`);
  }
});

check('next.config.js keeps geo-tz and the CAMS reader external (serverExternalPackages) and traces the height map', () => {
  const config = read('next.config.js');
  const external = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(config);
  assert(external, 'next.config.js has no serverExternalPackages list');
  const names = [...external[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const pkg of ['geo-tz', '@openmeteo/file-reader', '@openmeteo/file-format-wasm']) assert(names.includes(pkg), `${pkg} is not external: ${show(names)}`);
  assert(config.includes('./data/israel-heights-3s.i16.br'), 'the height map is not traced');
  const size = fs.statSync(path.join(ROOT, 'data/israel-heights-3s.i16.br')).size;
  assert(size > 3e6 && size < 8e6, `the height map is ${size} bytes`);
});

check('the dependencies: geo-tz, lru-cache and the pinned @openmeteo/file-reader in dependencies; geotiff only in devDependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  assert(pkg.dependencies['geo-tz'] && pkg.dependencies['lru-cache'] && pkg.dependencies['@openmeteo/file-reader'] === '0.0.21', show(pkg.dependencies));
  assert(!pkg.dependencies.geotiff && pkg.devDependencies.geotiff, 'geotiff moved');
});

check('the Privacy Policy in en, he and ru: MET Norway gets the place\'s position rounded to about 1 km, Open-Meteo is gone from the legal texts, and the page is dated', () => {
  const ROUNDED: Record<string, string> = { en: 'rounded to about 1 km', he: 'מעוגל לדיוק של קילומטר בערך', ru: 'с точностью около 1 км' };
  for (const lang of ['en', 'he', 'ru']) {
    const m = JSON.parse(read(`messages/${lang}.json`));
    const legal = JSON.stringify(m.legal);
    assert(!legal.includes('Open-Meteo'), `${lang}: the legal texts still name Open-Meteo`);
    const line = (m.legal.privacy.sections.processors.blocks[1] as unknown[]).find(x => typeof x === 'string' && x.startsWith('**MET Norway:**')) as string | undefined;
    assert(line && line.includes(ROUNDED[lang]), `${lang}: the MET Norway line ${show(line)}`);
    assert((m.legal.privacy.sections.processors.blocks[3] as unknown[]).some(x => typeof x === 'string' && x.includes('MET Norway')), `${lang}: "only what's listed above" does not name MET Norway`);
    assert(typeof m.bot.weatherCredit === 'string' && m.bot.weatherCredit.includes('MET Norway') && m.bot.weatherCredit.includes('Copernicus'), `${lang}: bot.weatherCredit ${show(m.bot.weatherCredit)}`);
    assert(typeof m.site.footer.dataSources === 'string' && m.site.footer.dataSources.includes('{omCredit}'), `${lang}: site.footer.dataSources`);
  }
  const legalTs = read('src/site/legal.ts');
  assert(/privacy: '2026-1[01]-\d\d'/.test(legalTs) && !legalTs.includes("privacy: '2026-10-30'"), 'LEGAL_UPDATED.privacy was not moved');
});

check('the credits are shown where weather is drawn: the infographic (the /weather photo and the share image), the /weather text reply, the site footer', () => {
  assert(read('src/services/weather/infographic.tsx').includes('t.weatherCredit'), 'the infographic does not draw bot.weatherCredit');
  assert(read('src/services/telegram/commands.ts').includes('t.weatherCredit'), 'the /weather text reply has no bot.weatherCredit');
  const footer = read('components/site/SiteFooter.tsx');
  assert(footer.includes("'site.footer.dataSources'") && footer.includes('OPEN_METEO_CREDIT') && footer.includes('camsNotice('), 'the footer lacks the data sources line, Open-Meteo\'s credit or the Copernicus notice');
  const notice = read('src/site/data-sources.ts');
  assert(notice.includes("'Weather data by Open-Meteo.com'") && notice.includes('Contains modified Copernicus Atmosphere Monitoring Service information'), 'src/site/data-sources.ts lost a licence credit');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
