// Smoke test for the notification service worker and the web app's manifest (web push spec 2026-11-05 §3.3; plan 6c-2 Task 4):
// public/sw.js, app/manifest.ts, the icons, the head links and the headers /sw.js is served with.
//
// What it pins:
//   - the worker runs as a classic script in a fake worker scope (a vm with a fake self, clients and registration) and listens to
//     install, activate, push and notificationclick only: no fetch handler, no cache;
//   - install takes over at once (skipWaiting) and activate claims the open windows (clients.claim);
//   - a push shows one notification from the declarative payload (title, body, lang, dir, tag, FamCal's icon, the URL kept in its
//     data); a tag renotifies unless the push is silent (a browser throws on both, and the fake does too); a payload that cannot
//     be read, or holds the wrong types, still shows "FamCal"; a navigate URL on another origin, or not a URL, opens the home;
//   - a tap closes the notification and, with a FamCal window open, focuses it and navigates it (the focused one first, then a
//     visible one, never another site's window), else opens a new window; a window that cannot be focused or navigated, a
//     list that cannot be read and an open that is refused each end in one quiet console line and never in a throw;
//   - nothing the worker logs holds a notification's words or URL;
//   - the manifest: FamCal, start_url /dashboard, standalone, the app's own light colour, a 192, a 512 and a maskable icon that
//     are really those PNG sizes, and the Home Screen icon is 180 square; the proxy leaves /sw.js, the manifest and the icons
//     alone; /sw.js is served with no-cache and no-store, and only /sw.js is;
//   - the head links: the manifest and the Home Screen icon are file conventions of app/, so all three root layouts link them,
//     and no layout sets metadata.manifest or metadata.icons over them; the (app) layout's viewport gives the dark device its
//     own bar colour from the app's tokens.
//
// Nothing is faked but the worker's scope: the real public/sw.js, app/manifest.ts, proxy.ts's matcher and next.config.js run. No
// network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh (the plan's $RUN runner):
//   $RUN smoke-push-worker

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import vm from 'vm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const ORIGIN = 'https://famcal.bot';
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

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

// ---- The worker's fake scope ----

interface FakeWindow {
  url: string;
  focused?: boolean;
  visibilityState?: 'visible' | 'hidden';
  focusFails?: boolean;
  navigateFails?: boolean;
  /** What happened to it, in order: 'focus', 'navigate <url>' */
  calls: string[];
}

interface Scope {
  handlers: Record<string, ((event: Row) => void)[]>;
  shown: { title: string; options: Row }[];
  warnings: string[];
  opened: string[];
  matchAllOptions: Row[];
  windows: FakeWindow[];
  counts: { skipWaiting: number; claim: number };
  fails: { showNotification: boolean; matchAll: boolean; openWindow: boolean };
  /** Runs one event through every handler of its type, as the browser does; resolves when what it waited on does. */
  fire: (type: string, extra?: Row) => Promise<Row>;
}

/** A browser's own rules for showNotification, which a worker can break: renotify needs a tag, and a silent notification cannot renotify. */
function browserShowNotification(options: Row): void {
  if (options.renotify && !options.tag) throw new TypeError('Failed to execute showNotification: renotify requires a tag');
  if (options.silent && options.renotify) throw new TypeError('Failed to execute showNotification: silent and renotify cannot both be true');
}

function boot(): Scope {
  const scope: Scope = {
    handlers: {}, shown: [], warnings: [], opened: [], matchAllOptions: [], windows: [],
    counts: { skipWaiting: 0, claim: 0 }, fails: { showNotification: false, matchAll: false, openWindow: false },
    fire: async (type, extra = {}) => {
      const waits: Promise<unknown>[] = [];
      const event: Row = { waitUntil: (p: Promise<unknown>) => { waits.push(Promise.resolve(p)); }, ...extra };
      for (const handler of scope.handlers[type] ?? []) handler(event);
      await Promise.all(waits);
      return event;
    },
  };
  const client = (w: FakeWindow): Row => ({
    url: w.url, focused: w.focused ?? false, visibilityState: w.visibilityState ?? 'hidden',
    focus: async () => { w.calls.push('focus'); if (w.focusFails) throw new Error('focus refused'); return client(w); },
    navigate: async (url: string) => { w.calls.push(`navigate ${url}`); if (w.navigateFails) throw new TypeError('the client is not controlled'); return client(w); },
  });
  const sandbox: Row = {
    URL, Promise, JSON, Boolean, Error, TypeError,
    console: { warn: (...args: unknown[]) => scope.warnings.push(args.map(String).join(' ')), log: () => undefined, error: () => undefined },
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: Row) => void) => { (scope.handlers[type] ??= []).push(handler); },
    skipWaiting: async () => { scope.counts.skipWaiting++; },
    registration: {
      showNotification: async (title: string, options: Row) => {
        if (scope.fails.showNotification) throw new Error('showNotification refused');
        browserShowNotification(options);
        scope.shown.push({ title, options: JSON.parse(JSON.stringify(options)) });
      },
    },
    clients: {
      claim: async () => { scope.counts.claim++; },
      matchAll: async (options: Row) => {
        scope.matchAllOptions.push(JSON.parse(JSON.stringify(options)));
        if (scope.fails.matchAll) throw new Error('matchAll refused');
        return scope.windows.map(client);
      },
      openWindow: async (url: string) => {
        if (scope.fails.openWindow) throw new Error('openWindow refused');
        scope.opened.push(url);
        return { url };
      },
    },
  };
  sandbox.self = sandbox; // in a worker, self is the global scope itself
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'public/sw.js' });
  return scope;
}

/** A push event carrying this payload as JSON, as the browser hands it to the worker. */
const pushOf = (payload: unknown): Row => ({ data: { json: () => JSON.parse(JSON.stringify(payload)) } });
const declarative = (n: Row): Row => ({ web_push: 8030, notification: n });
const HOME = `${ORIGIN}/dashboard`;
const win = (url: string, o: Partial<FakeWindow> = {}): FakeWindow => ({ url, calls: [], ...o });
const tap = (data: unknown): Row => ({ notification: { data, close() { this.closed = true; }, closed: false } });

// ---- The PNG's size, from its header ----

function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  assert(buf.subarray(1, 4).toString('latin1') === 'PNG', `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  await check('the worker is a classic script that listens to install, activate, push and notificationclick only: no fetch handler, no cache, no module syntax', () => {
    const scope = boot();
    assert(show(Object.keys(scope.handlers).sort()) === show(['activate', 'install', 'notificationclick', 'push']), `handlers: ${show(Object.keys(scope.handlers))}`);
    const code = SOURCE.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    assert(!/\bfetch\b|\bcaches\b|\bimportScripts\b/.test(code), 'the worker fetches, caches or imports');
    assert(!/^\s*(import|export)\s/m.test(code), 'module syntax in a classic worker');
  });

  await check('install takes over at once (skipWaiting) and activate claims the open windows (clients.claim), each waited on', async () => {
    const scope = boot();
    await scope.fire('install');
    await scope.fire('activate');
    assert(scope.counts.skipWaiting === 1 && scope.counts.claim === 1, `${show(scope.counts)}`);
  });

  await check('a push shows one notification from the declarative payload: title, body, lang, dir, tag, FamCal\'s icon, the URL kept in data; a tag renotifies', async () => {
    const scope = boot();
    await scope.fire('push', pushOf(declarative({ title: 'Dentist', body: 'Starting at 10:00', navigate: `${ORIGIN}/en/dashboard?user_id=50`, lang: 'en', dir: 'ltr', tag: 'nr-abc', silent: false })));
    assert(scope.shown.length === 1, `${scope.shown.length} shown`);
    assert(show(scope.shown[0]) === show({
      title: 'Dentist',
      options: { body: 'Starting at 10:00', icon: '/icon-192.png', lang: 'en', dir: 'ltr', data: { url: `${ORIGIN}/en/dashboard?user_id=50` }, silent: false, tag: 'nr-abc', renotify: true },
    }), `shown: ${show(scope.shown[0])}`);
    await scope.fire('push', pushOf(declarative({ title: 'תזכורת', body: 'לכולם', navigate: `${ORIGIN}/he/dashboard?user_id=51`, lang: 'he', dir: 'rtl', tag: 'nr-def' })));
    assert(scope.shown[1].title === 'תזכורת' && scope.shown[1].options.dir === 'rtl' && scope.shown[1].options.lang === 'he' && scope.shown[1].options.silent === false, `he: ${show(scope.shown[1])}`);
  });

  await check('a silent push does not renotify (the browser throws on both); a push with no tag sets neither tag nor renotify', async () => {
    const scope = boot();
    await scope.fire('push', pushOf(declarative({ title: 'Done by Dana', body: 'Dentist', navigate: HOME, tag: 'nr-x', silent: true })));
    assert(scope.shown[0].options.silent === true && scope.shown[0].options.renotify === false && scope.shown[0].options.tag === 'nr-x', `silent: ${show(scope.shown[0])}`);
    await scope.fire('push', pushOf(declarative({ title: 'Today', body: 'Dentist 09:00', navigate: HOME })));
    assert(!('tag' in scope.shown[1].options) && !('renotify' in scope.shown[1].options), `untagged: ${show(scope.shown[1])}`);
  });

  await check('a push whose payload cannot be read (no data, not JSON, the wrong shape) still shows "FamCal" with the home as its target, and a notification the browser refuses is not swallowed', async () => {
    const scope = boot();
    await scope.fire('push', {});
    await scope.fire('push', { data: { json: () => { throw new SyntaxError('Unexpected token') } } });
    for (const odd of [{}, null, [1], 'text', { notification: 'x' }, { notification: null }]) await scope.fire('push', pushOf(odd));
    assert(scope.shown.length === 8, `${scope.shown.length} shown`);
    for (const s of scope.shown) {
      assert(s.title === 'FamCal' && s.options.body === '' && s.options.data.url === HOME && s.options.dir === 'auto' && !('tag' in s.options), `${show(s)}`);
    }
    assert(scope.warnings.length === 1 && scope.warnings[0] === '[sw] a push with a payload that is not JSON', `warnings: ${show(scope.warnings)}`);
    scope.fails.showNotification = true;
    let thrown = false;
    try { await scope.fire('push', pushOf(declarative({ title: 'x', navigate: HOME }))); } catch { thrown = true; }
    assert(thrown, 'a refused showNotification was swallowed (the browser must see the failure)');
  });

  await check('fields of the wrong type are ignored (a title that is a number, a body that is an object, a dir that is neither); a navigate URL on another origin or that is no URL opens the home, a relative one stays on FamCal', async () => {
    const scope = boot();
    await scope.fire('push', pushOf(declarative({ title: 7, body: { a: 1 }, dir: 'weird', lang: 5, tag: 9, navigate: 3 })));
    assert(show(scope.shown[0]) === show({ title: 'FamCal', options: { body: '', icon: '/icon-192.png', lang: '', dir: 'auto', data: { url: HOME }, silent: false } }), `${show(scope.shown[0])}`);
    const targets: [unknown, string][] = [
      ['https://evil.example/phish', HOME], ['javascript:alert(1)', HOME], ['//evil.example/x', HOME], ['https://famcal.bot.evil.example/', HOME],
      ['', HOME], ['/he/dashboard?user_id=5', `${ORIGIN}/he/dashboard?user_id=5`], [`${ORIGIN}/ru/dashboard?user_id=6`, `${ORIGIN}/ru/dashboard?user_id=6`],
    ];
    for (const [navigate, want] of targets) {
      scope.shown.length = 0;
      await scope.fire('push', pushOf(declarative({ title: 't', navigate })));
      assert(scope.shown[0].options.data.url === want, `${show(navigate)} → ${scope.shown[0].options.data.url}, want ${want}`);
    }
  });

  await check('a tap closes the notification and, with FamCal open, focuses that window and then navigates it to the notification\'s URL; matchAll asks for windows, uncontrolled ones too; no new window opens', async () => {
    const scope = boot();
    const open = win(`${ORIGIN}/en/settings?user_id=50`);
    scope.windows = [open];
    const event = tap({ url: `${ORIGIN}/en/dashboard?user_id=50` });
    await scope.fire('notificationclick', event);
    assert(event.notification.closed === true, 'the notification was not closed');
    assert(show(open.calls) === show(['focus', `navigate ${ORIGIN}/en/dashboard?user_id=50`]), `calls: ${show(open.calls)}`);
    assert(scope.opened.length === 0, 'a window was opened as well');
    assert(show(scope.matchAllOptions) === show([{ type: 'window', includeUncontrolled: true }]), `matchAll: ${show(scope.matchAllOptions)}`);
  });

  await check('a tap chooses the focused FamCal window, else a visible one, else the first; another site\'s window is never used', async () => {
    const url = `${ORIGIN}/en/dashboard?user_id=50`;
    const pick = async (windows: FakeWindow[]): Promise<Scope> => {
      const scope = boot();
      scope.windows = windows;
      await scope.fire('notificationclick', tap({ url }));
      return scope;
    };
    const [a, b, c] = [win(`${ORIGIN}/a`), win(`${ORIGIN}/b`, { visibilityState: 'visible' }), win(`${ORIGIN}/c`, { focused: true, visibilityState: 'visible' })];
    await pick([a, b, c]);
    assert(c.calls.length === 2 && a.calls.length === 0 && b.calls.length === 0, `focused: ${show([a.calls, b.calls, c.calls])}`);
    const [d, e] = [win(`${ORIGIN}/d`), win(`${ORIGIN}/e`, { visibilityState: 'visible' })];
    await pick([d, e]);
    assert(e.calls.length === 2 && d.calls.length === 0, `visible: ${show([d.calls, e.calls])}`);
    const [f, g] = [win(`${ORIGIN}/f`), win(`${ORIGIN}/g`)];
    await pick([f, g]);
    assert(f.calls.length === 2 && g.calls.length === 0, `first: ${show([f.calls, g.calls])}`);
    const foreign = win('https://famcal.bot.evil.example/dashboard', { focused: true, visibilityState: 'visible' });
    const other = win('https://evil.example/', { focused: true });
    const scope = await pick([foreign, other]);
    assert(foreign.calls.length === 0 && other.calls.length === 0 && show(scope.opened) === show([url]), `another site's window: ${show([foreign.calls, other.calls, scope.opened])}`);
  });

  await check('a tap with no FamCal window open opens one at the notification\'s URL; one with no URL in its data opens the home', async () => {
    const scope = boot();
    await scope.fire('notificationclick', tap({ url: `${ORIGIN}/he/dashboard?user_id=51` }));
    await scope.fire('notificationclick', tap(undefined));
    await scope.fire('notificationclick', tap({ url: 'https://evil.example/x' }));
    assert(show(scope.opened) === show([`${ORIGIN}/he/dashboard?user_id=51`, HOME, HOME]), `opened: ${show(scope.opened)}`);
  });

  await check('a window that cannot be navigated or focused, a window list that cannot be read, and an open that is refused each end quietly: the next way is tried, one console line, never a throw', async () => {
    const url = `${ORIGIN}/en/dashboard?user_id=50`;
    const uncontrolled = boot();
    const stuck = win(`${ORIGIN}/x`, { navigateFails: true });
    uncontrolled.windows = [stuck];
    await uncontrolled.fire('notificationclick', tap({ url }));
    assert(show(stuck.calls) === show(['focus', `navigate ${url}`]) && show(uncontrolled.opened) === show([url]), `navigate fails: ${show([stuck.calls, uncontrolled.opened])}`);
    assert(uncontrolled.warnings.length === 1 && uncontrolled.warnings[0] === '[sw] could not focus or navigate the open window; opening a new one', `${show(uncontrolled.warnings)}`);
    const noFocus = boot();
    noFocus.windows = [win(`${ORIGIN}/x`, { focusFails: true })];
    await noFocus.fire('notificationclick', tap({ url }));
    assert(show(noFocus.opened) === show([url]), `focus fails: ${show(noFocus.opened)}`);
    const noList = boot();
    noList.fails.matchAll = true;
    await noList.fire('notificationclick', tap({ url }));
    assert(show(noList.opened) === show([url]) && noList.warnings.length === 1 && noList.warnings[0] === '[sw] could not list the open windows', `matchAll fails: ${show([noList.opened, noList.warnings])}`);
    const noOpen = boot();
    noOpen.fails.openWindow = true;
    await noOpen.fire('notificationclick', tap({ url }));
    assert(show(noOpen.warnings) === show(['[sw] could not open a window']), `openWindow fails: ${show(noOpen.warnings)}`);
  });

  await check('nothing the worker logs holds a notification\'s title, body or URL', async () => {
    const scope = boot();
    const words = ['Secret dentist title', 'Secret place body', 'https://famcal.bot/en/dashboard?user_id=777'];
    await scope.fire('push', { data: { json: () => { throw new SyntaxError(`Unexpected token ${words[0]}`); } } });
    await scope.fire('push', pushOf(declarative({ title: words[0], body: words[1], navigate: words[2], tag: 't' })));
    scope.fails.openWindow = true;
    scope.windows = [win(`${ORIGIN}/x`, { navigateFails: true })];
    await scope.fire('notificationclick', tap({ url: words[2] }));
    assert(scope.warnings.length >= 2, `${scope.warnings.length} lines`);
    for (const line of scope.warnings) for (const word of words) assert(!line.includes(word), `a line holds ${word}: ${line}`);
  });

  // ---- The manifest, the icons and the head ----

  await check('the manifest: FamCal, start_url /dashboard, standalone, the app\'s own light colour, and the 192, 512 and maskable icons are real PNGs of those sizes under public/; the Home Screen icon is 180 square', async () => {
    const { default: manifest } = nodeRequire(path.join(ROOT, 'app/manifest.ts'));
    const { APP_TOKENS } = nodeRequire(path.join(ROOT, 'components/app-ui/tokens.ts'));
    const m: Row = manifest();
    assert(m.name === 'FamCal' && m.short_name === 'FamCal' && m.start_url === '/dashboard' && m.scope === '/' && m.display === 'standalone', `${show(m)}`);
    assert(m.background_color === APP_TOKENS.light.bg && m.theme_color === APP_TOKENS.light.bg, `colours ${m.background_color} ${m.theme_color}`);
    const icons: Row[] = m.icons;
    const byPurpose = (purpose: string) => icons.filter(i => i.purpose === purpose);
    assert(byPurpose('maskable').length === 1 && byPurpose('maskable')[0].sizes === '512x512', 'one maskable 512 icon');
    assert(show(byPurpose('any').map(i => i.sizes).sort()) === show(['192x192', '512x512']), `any icons: ${show(byPurpose('any'))}`);
    for (const icon of icons) {
      assert(icon.type === 'image/png' && String(icon.src).startsWith('/') && !String(icon.src).includes('..'), `${show(icon)}`);
      const size = pngSize(path.join(ROOT, 'public', icon.src));
      assert(`${size.width}x${size.height}` === icon.sizes, `${icon.src} is ${size.width}x${size.height}, the manifest says ${icon.sizes}`);
    }
    const apple = pngSize(path.join(ROOT, 'app/apple-icon.png'));
    assert(apple.width === 180 && apple.height === 180, `apple-icon.png is ${apple.width}x${apple.height}`);
    // The worker shows the 192 icon
    assert(icons.some(i => i.src === '/icon-192.png') && SOURCE.includes("'/icon-192.png'"), 'the worker\'s icon is not the manifest\'s 192');
  });

  await check('the proxy leaves /sw.js, the manifest and the icons alone (a path with a dot), and still routes the pages; /sw.js is served no-cache and no-store, and only /sw.js has that rule', async () => {
    const { config } = await import(path.join(ROOT, 'proxy.ts'));
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const skipped of ['/sw.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-icon.png']) assert(!matcher.test(skipped), `the proxy takes ${skipped}`);
    for (const routed of ['/dashboard', '/he/settings', '/']) assert(matcher.test(routed), `the proxy lost ${routed}`);
    const next = nodeRequire(path.join(ROOT, 'next.config.js'));
    const rules: Row[] = await next.headers();
    assert(rules.length === 1 && rules[0].source === '/sw.js', `header rules: ${show(rules)}`);
    const cacheControl = String(rules[0].headers.find((h: Row) => h.key === 'Cache-Control')?.value);
    assert(/\bno-cache\b/.test(cacheControl) && /\bno-store\b/.test(cacheControl), `Cache-Control: ${cacheControl}`);
  });

  await check('the head: the manifest and the Home Screen icon sit at the top of app/ (so all three root layouts link them), no layout sets metadata.manifest or icons over them, and the (app) layout gives a dark device its own bar colour from the app\'s tokens', () => {
    for (const file of ['app/manifest.ts', 'app/apple-icon.png', 'app/icon.png']) assert(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
    for (const layout of ['app/[locale]/(app)/layout.tsx', 'app/[locale]/(site)/layout.tsx', 'app/(connect)/layout.tsx']) {
      const text = fs.readFileSync(path.join(ROOT, layout), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      assert(!/\bmanifest\s*:|\bicons\s*:|apple-touch-icon|rel="manifest"/.test(text), `${layout} sets its own manifest or icons`);
    }
    const app = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/layout.tsx'), 'utf8');
    assert(/themeColor: \[\s*\{ media: '\(prefers-color-scheme: light\)', color: APP_TOKENS\.light\.bg \},\s*\{ media: '\(prefers-color-scheme: dark\)', color: APP_TOKENS\.dark\.bg \},\s*\]/.test(app), 'the (app) layout has no light and dark themeColor from APP_TOKENS');
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
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
