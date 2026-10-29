// Smoke test for the Calendars screen in the app's design (plan docs/superpowers/plans/2026-10-29-w4-1-calendars.md;
// spec 2026-10-19-screens-and-colours §4, §5): CalendarsClient on AppScreen and the form kit, in real React on the small
// fake DOM, with a fake Telegram.WebApp, a router stub and a fake fetch. No network, no DB.
//
//  - C1 the page data: where the person is with Google (all four states, the chosen count) and the partner's name;
//  - C2 the kit's colour swatches and the swatch dot's CSS.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-calendars-screen.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { lintCss } from './lib/css-lint';
import { ColorSwatches, FORM_CSS } from '../components/app-ui/form-kit';
import { elements, installWindow, mount, type Row } from './lib/fake-dom';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message || String(((err as unknown as { errors?: Error[] }).errors?.[0] ?? err).stack).split('\n').slice(0, 5).join(' | ') : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (value: unknown) => JSON.stringify(value);

// ---- The server side of the page: page-data.ts over a world of three calls, everything else real ----

interface World {
  calendars: Row[];
  partner: { partner: { name: string } } | null;
}
const world: World = { calendars: [], partner: null };

const untouchable = (what: string): object =>
  new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' ? undefined : untouchable(`${what}.${String(key)}`)),
    apply: () => {
      throw new Error(`the page data reached ${what}, which this smoke does not fake`);
    },
  });
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/utils/prisma.ts`]: { prisma: untouchable('prisma'), withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/utils/redis.ts`]: { redis: untouchable('redis') },
  [`${SRC}/services/native-calendar/event-store.ts`]: (real) => fakeOver(real, { listVisibleCalendars: async () => world.calendars }),
  [`${SRC}/services/native-calendar/onboarding.ts`]: (real) => fakeOver(real, { ensurePrimaryNativeCalendar: async () => undefined }),
  [`${SRC}/services/native-calendar/colour.ts`]: (real) => fakeOver(real, { googleColoursOnScreen: async () => [] }),
  [`${SRC}/services/pairing-service.ts`]: (real) => fakeOver(real, { getActivePartner: async () => world.partner }),
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build
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
  if (!(resolved in stubs) || loadingReal.has(resolved)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(resolved, () => realLoad.call(this, request, parent, isMain));
};
// import() goes through the ES module loader: the same fakes, served as ES modules.
(globalThis as { calendarsScreenFake?: (file: string) => object }).calendarsScreenFake = (file) => fakeFor(file, () => realLoad.call(Module, file, null, false));
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { calendarsScreenFake: (file: string) => object }).calendarsScreenFake(file);
    const names = Object.keys(fake).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.calendarsScreenFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Fixtures ----

const ownCalendar = (id: string, name: string, o: Row = {}): Row => ({
  id, name, color: '#039be5', privacy: 'PRIVATE', ownerUserId: 1, labels: ['yours'], rules: [], personName: null, personEnglishName: null, personGender: null, createdAt: new Date('2026-01-01T00:00:00Z'), ...o,
});
const userRow = (o: Row = {}): Row => ({ id: 1, name: 'Noa', language: 'en', pairingId: null, googleRefreshToken: null, calendarSource: 'NATIVE', calendarAssignments: null, ...o });
const picks = (n: number) => Array.from({ length: n }, (_, i) => ({ calendarId: `g${i}@example.com`, labels: ['yours'] }));

async function main() {
  const { loadPageData } = await import('../src/lib/page-data');

  await check('C1 the page data says where the person is with Google (none, choose, connected, reconnect; how many calendars are chosen, a FamCal user\'s stale choices counting as none) and names the active partner, or null when not paired', async () => {
    world.calendars = [ownCalendar('own1', 'Home')];
    const dataFor = async (user: Row, partner: World['partner'] = null) => {
      world.partner = partner;
      const page = await loadPageData('calendars', user as never, 5550001, 'en');
      assert(page.kind === 'props', `the page: ${show(page)}`);
      return page.props as unknown as { google: { state: string; chosen: number }; partnerName: string | null; initialCalendars: Row[] };
    };
    const cases: [string, Row, { state: string; chosen: number }][] = [
      ['none', userRow(), { state: 'none', chosen: 0 }],
      ['none with stale choices and no token (a FamCal user)', userRow({ calendarAssignments: picks(2) }), { state: 'none', chosen: 0 }],
      ['choose', userRow({ googleRefreshToken: 'tok' }), { state: 'choose', chosen: 0 }],
      ['connected', userRow({ googleRefreshToken: 'tok', calendarAssignments: picks(3) }), { state: 'connected', chosen: 3 }],
      ['reconnect', userRow({ calendarSource: 'GOOGLE', calendarAssignments: picks(2) }), { state: 'reconnect', chosen: 2 }],
    ];
    for (const [name, user, want] of cases) {
      const data = await dataFor(user);
      assert(show(data.google) === show(want), `${name}: ${show(data.google)} (want ${show(want)})`);
      assert(data.partnerName === null, `${name}: a partner name ${show(data.partnerName)} with no partner`);
      assert(data.initialCalendars.length === 1, `${name}: the calendars`);
    }
    const paired = await dataFor(userRow({ pairingId: 'pair1' }), { partner: { name: 'Dana' } });
    assert(paired.partnerName === 'Dana', `the partner: ${show(paired.partnerName)}`);
    // The Google facts never carry the token or the chosen calendars themselves
    assert(!JSON.stringify(paired).includes('tok') && Object.keys(paired.google).sort().join() === 'chosen,state', `the Google facts: ${show(paired.google)}`);
  });

  await check('C2 the kit\'s colour swatches: a radiogroup of radio buttons labelled with the given texts, the chosen one aria-checked, each at least 44 px with a 28 px dot in its colour; tapping one reports its value; FORM_CSS draws .ch-swatch-dot (it moved from the editor\'s sheet) and passes the CSS lint', () => {
    const options = [
      { value: '#039be5', color: '#039be5', text: 'Blue' },
      { value: '#f4511e', color: '#f4511e', text: 'Orange' },
      { value: '#0b8043', color: '#0b8043', text: 'Green' },
    ];
    const tree = (locale: Locale, chosen: string, onChange: (v: string) => void = () => undefined) =>
      createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(ColorSwatches, { label: 'Color', value: chosen, options, onChange, disabled: false }));
    const html = renderToString(tree('en', '#f4511e'));
    assert(/<div[^>]*role="radiogroup"[^>]*aria-label="Color"/.test(html), `the group: ${html.slice(0, 200)}`);
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert(buttons.length === 3 && buttons.every((b) => /role="radio"/.test(b)), `the swatches: ${show(buttons)}`);
    assert(show(buttons.map((b) => /aria-label="([^"]*)"/.exec(b)?.[1])) === show(['Blue', 'Orange', 'Green']), `the labels: ${show(buttons)}`);
    assert(show(buttons.map((b) => /aria-checked="(true|false)"/.exec(b)?.[1])) === show(['false', 'true', 'false']), `the chosen one: ${show(buttons)}`);
    assert(html.includes('background:#039be5') && html.includes('background:#f4511e') && !/\p{Extended_Pictographic}/u.test(html), 'the dots are drawn in their colours');
    assert((html.match(/<svg\b/g) ?? []).length === 1 && /<svg[^>]*aria-hidden="true"/.test(html), 'one check mark, on the chosen swatch, hidden from screen readers');
    installWindow();
    const taken: string[] = [];
    const m = mount(tree('he', '#039be5', (v) => taken.push(v)));
    const radios = elements(m.container).filter((e) => e.getAttribute('role') === 'radio');
    m.click(radios[2]);
    m.unmount();
    assert(show(taken) === show(['#0b8043']), `a tap reports ${show(taken)}`);
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(FORM_CSS)?.[1] ?? '';
    assert(/inline-size:\s*44px/.test(rule('.ch-swatch')) && /block-size:\s*44px/.test(rule('.ch-swatch')), `.ch-swatch: ${rule('.ch-swatch')}`);
    assert(/inline-size:\s*28px/.test(rule('.ch-swatch-color')) && /block-size:\s*28px/.test(rule('.ch-swatch-color')), `.ch-swatch-color: ${rule('.ch-swatch-color')}`);
    assert(/flex-wrap:\s*wrap/.test(rule('.ch-swatches')), `.ch-swatches: ${rule('.ch-swatches')}`);
    assert(rule('.ch-swatch-dot') !== '', 'FORM_CSS does not draw .ch-swatch-dot');
    const problems = lintCss(FORM_CSS);
    assert(problems.length === 0, `FORM_CSS: ${show(problems)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
