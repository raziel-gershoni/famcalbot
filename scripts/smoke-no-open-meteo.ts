// Guard: Open-Meteo's free API forbids commercial use (spec docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md
// §1), so no file in src/, app/, components/ or i18n/ (nor proxy.ts) names one of its API hosts (each ends in
// api.open-meteo.com: api., air-quality-api., geocoding-api., customer-api., ...). Allowed: its public open data on S3
// (openmeteo.s3.amazonaws.com, the dust) and the credit its licence asks for (the words "Open-Meteo.com" linking
// https://open-meteo.com/, in the footer's data sources and in bot.weatherCredit). Also: the server-only lookups never
// reach a 'use client' file, the proxy or the edge runtime, next.config.js keeps what they need, the Policy names MET
// Norway and no longer Open-Meteo, and the credits exist in every language and are drawn where weather is shown.
// Nothing is faked: it reads files. No network.

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
// Everything that ships code: the app's source, its pages, its components, the i18n setup and the proxy
const CODE_FILES = [...files('src'), ...files('app'), ...files('components'), ...files('i18n'), 'proxy.ts'].filter(f => /\.(t|j)sx?$/.test(f));

check('no code file (src/, app/, components/, i18n/, proxy.ts) names an Open-Meteo API host (the scanner finds them in probes and lets the open data and the credit be)', () => {
  for (const host of ['https://api.open-meteo.com/v1/forecast', 'https://air-quality-api.open-meteo.com/v1/air-quality', 'https://customer-api.open-meteo.com/v1/forecast', 'https://geocoding-api.open-meteo.com/v1/search']) {
    assert(OPEN_METEO_API.test(host), `the scanner misses ${host}`);
  }
  for (const allowed of ['https://openmeteo.s3.amazonaws.com/data/cams_global/static/meta.json', 'https://open-meteo.com/', 'Weather: MET Norway · Dust: Copernicus (Open-Meteo.com)']) {
    assert(!OPEN_METEO_API.test(allowed), `the scanner flags ${allowed}`);
  }
  assert(CODE_FILES.length > 500 && CODE_FILES.includes('proxy.ts') && CODE_FILES.some(f => f.startsWith('components/')) && CODE_FILES.some(f => f.startsWith('i18n/')), `the scanner reads ${CODE_FILES.length} files`);
  const hits = CODE_FILES.filter(f => OPEN_METEO_API.test(read(f)));
  assert(hits.length === 0, `Open-Meteo API hosts in ${show(hits)}`);
});

check('no \'use client\' file, no edge-runtime file, the proxy and the browser instrumentation import the weather, the zmanim, the zone lookup, geo-tz or the CAMS reader', () => {
  const FORBIDDEN = /(services\/(weather|zmanim)(\/|$)|lib\/timezone|lib\/zone-for-coords|geo-tz|@openmeteo\/)/;
  const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  const clients = CODE_FILES.filter(f => /^\s*['"]use client['"]/m.test(read(f)) || /runtime\s*=\s*['"]edge['"]/.test(read(f)) || f === 'proxy.ts');
  clients.push('instrumentation-client.ts');
  assert(clients.length > 20, `found ${clients.length} client files: the scanner is broken`);
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
    // The credit names the sources and Open-Meteo.com, whose files carry the dust (the text reply links it)
    assert(typeof m.bot.weatherCredit === 'string' && ['MET Norway', 'Copernicus', '(Open-Meteo.com)'].every(w => m.bot.weatherCredit.includes(w)), `${lang}: bot.weatherCredit ${show(m.bot.weatherCredit)}`);
    // The footer line links Open-Meteo.com (<om>), CC BY and the dataset's DOI, and has no placeholder left
    const footerLine = m.site.footer.dataSources;
    assert(typeof footerLine === 'string' && footerLine.includes('<om>Open-Meteo.com</om>') && footerLine.includes('<cams>') && footerLine.includes('<ccby>') && !footerLine.includes('{'), `${lang}: site.footer.dataSources ${show(footerLine)}`);
  }
  // The day the Policy text changed or later (the Terms' date does not count)
  const privacyDay = /privacy: '(\d{4}-\d{2}-\d{2})'/.exec(read('src/site/legal.ts'))?.[1];
  assert(privacyDay && privacyDay >= '2026-10-31', `LEGAL_UPDATED.privacy ${show(privacyDay)} was not moved to the day of the change (2026-10-31 or later)`);
});

check('the credits are shown where weather is drawn: the infographic (the /weather photo and the share image), the /weather text reply, the site footer', () => {
  // The image takes the credit from the messages and puts it in its element tree (smoke-bug-batch-words walks the tree)
  const image = read('src/services/weather/infographic.tsx');
  assert(image.includes('t.weatherCredit') && /\{\s*isRTL\s*\?\s*toVisualOrder\(credit\)\s*:\s*credit\s*\}/.test(image), 'the infographic does not draw bot.weatherCredit');
  const reply = read('src/services/telegram/commands.ts');
  assert(reply.includes('t.weatherCredit') && reply.includes('SOURCE_LINKS.om'), 'the /weather text reply has no bot.weatherCredit with Open-Meteo.com linked');
  const footer = read('components/site/SiteFooter.tsx');
  assert(footer.includes("'site.footer.dataSources'") && footer.includes('camsNotice('), 'the footer lacks the data sources line or the Copernicus notice');
  const sources = read('src/site/data-sources.ts');
  assert(sources.includes('Contains modified Copernicus Atmosphere Monitoring Service information') && sources.includes("om: 'https://open-meteo.com/'") && sources.includes("cams: 'https://doi.org/10.24381/04a0b097'"), 'src/site/data-sources.ts lost a licence credit or link');
  assert(read('src/site/zmanim/sources.ts').includes('Produced using Copernicus WorldDEM™-90') && read('src/site/zmanim/sources.ts').includes('do not incur any liability'), 'the zmanim pages lost the height notice or its liability sentence');
  const notice = read('NOTICE');
  assert(['WorldDEM™-90', 'GeoNames', 'scripts/fixtures/met-tel-aviv.json', 'scripts/fixtures/cams-tel-aviv.json'].every(w => notice.includes(w)), 'NOTICE lost a data source');
});

check('no console line of the app interpolates a place or its coordinates (Sentry attaches console lines to later error reports): the user id, the zone, a flag or the status say what happened', () => {
  // A coordinate word anywhere in an interpolation, or an interpolation that ends in a place word (${location}, ${user.location}: not ${place.timeZone})
  const PLACE_IN_LINE = /console\.(?:log|info|warn|error|debug)\([^\n]*(?:\$\{[^}\n]*\b(?:latitude|longitude|lat|lon|lng)\b[^}\n]*\}|\$\{\s*(?:[\w$]+\.)*(?:location|place|city|town|centre)\s*\})/i;
  for (const probe of ['console.log(`Geocoded "${location}" to ${latitude}`)', 'console.warn(`[x] at ${place.latitude.toFixed(3)}`)', 'console.error(`failed for ${user.location}`, e)']) assert(PLACE_IN_LINE.test(probe), `the scanner misses ${probe}`);
  for (const fine of ['console.log(`[geocode] fresh place found, zone ${timezone}`)', 'console.log(`user ${user.id} has a place name`)', 'console.warn(`[zmanim] no ${keys} in ${place.timeZone}`)']) assert(!PLACE_IN_LINE.test(fine), `the scanner flags ${fine}`);
  const hits = CODE_FILES.flatMap(f => read(f).split('\n').map((line, i) => (PLACE_IN_LINE.test(line) ? `${f}:${i + 1}` : '')).filter(Boolean));
  assert(hits.length === 0, `console lines with a place or coordinates: ${show(hits)}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
