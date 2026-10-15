// Smoke test for what a Mini App page shows before its data arrives, and for the cards a
// page shows when nobody has proved who they are.
//
// Full height at once: PageGate renders only a loader until /api/page-data answers, and
// the page's own TelegramLayout, which called ready() and expand(), mounted only after
// that round trip. So the sheet sat at half height with Telegram's header colour for a
// whole request. PageGate now calls them on its first mount, before the fetch starts.
// share-story keeps ready() alone: it opens the story composer and closes.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-miniapp-gate.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';

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
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

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

function installStubs() {
  // DashboardClient imports @hebcal/core, which ships ESM only with no require entry, so
  // it cannot load under tsx. Nothing here renders it.
  stub('app/[locale]/dashboard/DashboardClient.tsx', { __esModule: true, default: () => null });
}

/** A fake Telegram.WebApp that records every call; `throwOn` methods throw as old SDKs do. */
function fakeWebApp(throwOn: string[] = []) {
  const calls: string[] = [];
  const method = (name: string) => (...args: unknown[]) => {
    calls.push(args.length ? `${name}(${args.map(a => String(a)).join(',')})` : `${name}()`);
    if (throwOn.includes(name)) throw new Error(`WebAppHeaderColorKeyInvalid (${name})`);
  };
  const webApp: Row = {
    initData: '',
    initDataUnsafe: {},
    ready: method('ready'),
    expand: method('expand'),
    close: method('close'),
    setHeaderColor: method('setHeaderColor'),
    setBackgroundColor: method('setBackgroundColor'),
  };
  return { webApp, calls };
}

/** Runs fn with a fake browser window (Telegram SDK included unless webApp is null). */
async function withWindow<T>(webApp: Row | null, fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as Row;
  const had = 'window' in g;
  const prev = g.window;
  g.window = {
    location: { hash: '' },
    sessionStorage: { getItem: () => null, setItem: () => undefined },
    ...(webApp ? { Telegram: { WebApp: webApp } } : {}),
  };
  try {
    return await fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

/** The bodies of the useEffect calls in PageGate's component, in declaration order. */
function pageGateEffects(src: string): string[] {
  const start = src.indexOf('export default function PageGate');
  assert(start >= 0, 'no PageGate component in PageGate.tsx');
  const body = src.slice(start);
  const end = body.indexOf('const look = LOOK[page]');
  const component = end > 0 ? body.slice(0, end) : body;
  return component.split('useEffect(').slice(1);
}

async function main() {
  installStubs();

  // ---- Full height at once ----

  await check('#1 PageGate calls ready() and expand() in an effect declared before its /api/page-data fetch effect', () => {
    const src = readSource('app/[locale]/PageGate.tsx');
    const effects = pageGateEffects(src);
    const fetchAt = effects.findIndex(e => e.includes("fetch('/api/page-data'"));
    assert(fetchAt >= 0, 'no effect fetches /api/page-data');
    // The effect either makes the calls itself or calls startMiniApp, which must make them
    const helper = src.match(/export function startMiniApp\([\s\S]*?\n}\n/)?.[0] ?? '';
    const lifecycleAt = effects.findIndex(e => {
      const calls = e.includes('startMiniApp(') ? helper : e.slice(0, e.indexOf('}, ['));
      return calls.includes('.ready()') && calls.includes('.expand()');
    });
    assert(lifecycleAt >= 0, 'no PageGate effect calls ready() and expand()');
    assert(lifecycleAt < fetchAt, `the ready/expand effect is #${lifecycleAt + 1}, the fetch effect #${fetchAt + 1}`);
  });

  await check('#2 startMiniApp: ready + expand always; purple pages also get the purple header and white background, each surviving a throw', async () => {
    const { startMiniApp } = await load('app/[locale]/PageGate.tsx');
    assert(typeof startMiniApp === 'function', 'PageGate exports no startMiniApp');

    const purple = fakeWebApp();
    await withWindow(purple.webApp, () => startMiniApp('telegram'));
    for (const call of ['ready()', 'expand()', 'setHeaderColor(#667eea)', 'setBackgroundColor(#ffffff)']) {
      assert(purple.calls.includes(call), `purple look: no ${call} in ${show(purple.calls)}`);
    }
    assert(purple.calls.indexOf('ready()') < purple.calls.indexOf('setHeaderColor(#667eea)'), `order: ${show(purple.calls)}`);

    // WebApp 6.1-6.8 throw on a hex header colour; a throw here would replace the gate
    const old = fakeWebApp(['setHeaderColor']);
    await withWindow(old.webApp, () => startMiniApp('telegram'));
    assert(old.calls.includes('expand()') && old.calls.includes('setBackgroundColor(#ffffff)'),
      `after setHeaderColor threw: ${show(old.calls)}`);
    const oldBg = fakeWebApp(['setBackgroundColor']);
    await withWindow(oldBg.webApp, () => startMiniApp('telegram'));

    const light = fakeWebApp();
    await withWindow(light.webApp, () => startMiniApp('light'));
    assert(show(light.calls) === show(['ready()', 'expand()']), `light look: ${show(light.calls)}`);

    await withWindow(null, () => startMiniApp('telegram'));
  });

  await check('#3 share-story keeps ready() alone: no expand() anywhere in it', () => {
    const src = readSource('app/[locale]/share-story/page.tsx');
    assert(src.includes('tg.ready()'), 'share-story no longer calls ready()');
    assert(!/expand\s*\(/.test(src), 'share-story calls expand()');
  });

  await check('#4 the global menu button path (TelegramDashboardRedirect) expands with ready() and sets the purple header', () => {
    const src = readSource('app/[locale]/dashboard/TelegramDashboardRedirect.tsx');
    const ready = src.indexOf('tg.ready()');
    const expand = src.indexOf('tg.expand()');
    assert(ready >= 0 && expand > ready, `ready() at ${ready}, expand() at ${expand}`);
    assert(src.includes("tg.setHeaderColor('#667eea')"), 'the header is not set to #667eea');
    assert(!src.includes("'secondary_bg_color'"), 'the header is still set to the theme colour first');
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
