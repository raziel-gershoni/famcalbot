// Smoke test for the calendar home's Telegram calls (src/lib/telegram-ui.ts, spec §7.1
// Look and §7.6), and the SDK members they need in src/types/telegram-webapp.d.ts.
//
// - useTelegramBackButton(active, onBack): hide() on mount, since the client keeps the
//   button across reloads; while active, one handler and show(); whenever it stops
//   being needed (inactive, unmount), offClick(that handler) and hide().
// - useTelegramTheme(): setHeaderColor('bg_color') and setBackgroundColor('bg_color') on
//   mount and on every themeChanged; the scheme follows Telegram's colorScheme inside
//   Telegram and prefers-color-scheme in a browser.
// - onTelegramEvent and openExternalLink, for the home's foreground refetch and
//   "Open in Google Calendar".
// - useTelegramVerticalSwipes(locked) (Plan E Ruling 9, Bot API 7.7): disable while
//   locked, enable when not, on an unlocked mount and on unmount; one call per change;
//   never a read of isVerticalSwipesEnabled. releaseTelegramControls(), before a reload:
//   the BackButton let go, then swipes enabled.
// Every SDK call is gated with isVersionAtLeast and wrapped in try/catch: a 6.0 client,
// a browser (the SDK defines Telegram.WebApp there too, at 6.0) or a throwing method
// never breaks the page.
//
// The hooks run in real React (react-dom/client with act), mounted into a fake container
// that renders nothing. Faked at the boundaries: the browser window (just enough DOM for
// React to mount a component that renders null) and the Telegram SDK (records every
// call, keeps event handlers as the SDK does). No network.
//
// Check #1 is compile-time: tsc fails on it until the d.ts additions land.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-telegram-ui.ts

import path from 'path';
import { createRequire } from 'module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

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
const ui = () => load('src/lib/telegram-ui.ts');

const INIT_DATA = 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc';

// ---- Compile-time: the SDK members the home uses are typed (spec §7.6) ----

function typedMembers(tg: TelegramWebApp): unknown[] {
  const event: TelegramWebAppEventType = 'activated';
  const inset: TelegramWebAppSafeAreaInset = tg.safeAreaInset;
  return [
    tg.isVersionAtLeast('8.0'),
    tg.disableVerticalSwipes,
    tg.enableVerticalSwipes,
    tg.onEvent,
    tg.offEvent,
    event,
    inset.top + inset.bottom + inset.left + inset.right,
    tg.contentSafeAreaInset.top,
    tg.themeParams.section_bg_color,
    tg.themeParams.section_header_text_color,
    tg.themeParams.section_separator_color,
    tg.themeParams.subtitle_text_color,
    tg.BackButton.offClick,
    tg.openLink,
  ];
}

// ---- The fake window: one object for the whole run (react-dom reads it when loaded) ----

const g = globalThis as Row;
const noop = () => undefined;
const fakeDocument: Row = {
  nodeType: 9,
  activeElement: null,
  documentElement: {},
  addEventListener: noop,
  removeEventListener: noop,
  createElement: () => ({ setAttribute: noop, style: {} }),
};
const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
};
fakeDocument.defaultView = fakeWindow;
g.window = fakeWindow;
g.document = fakeDocument;
g.IS_REACT_ACT_ENVIRONMENT = true;

const React = nodeRequire('react');
const { createRoot } = nodeRequire('react-dom/client');
const { renderToString } = nodeRequire('react-dom/server');

/** A React root in a container that never gets a DOM node (the probes render null). */
function mount(element: unknown) {
  const container: Row = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
    firstChild: null,
    childNodes: [],
    textContent: '',
    addEventListener: noop,
    removeEventListener: noop,
    removeChild: noop,
  };
  const root = createRoot(container);
  React.act(() => root.render(element));
  return {
    render: (next: unknown) => React.act(() => root.render(next)),
    unmount: () => React.act(() => root.unmount()),
  };
}

const act = (fn: () => void) => React.act(fn);

/** Bot API versions compared as the SDK does: part by part, missing parts 0. */
function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * A fake Telegram.WebApp that records every call (handlers as fn1, fn2… so offClick can
 * be matched to its onClick) and keeps event handlers in a set per event, as the SDK
 * does. Methods named in `throwOn` throw after recording. Its isVerticalSwipesEnabled is
 * a getter that counts the read and throws: the home must never read it (spec §7.6).
 * `swipes()` is what the calls left them at (null before any call).
 */
function fakeTelegram(o: { version: string; initData?: string; colorScheme?: 'light' | 'dark'; throwOn?: string[] }) {
  const calls: string[] = [];
  let swipes: boolean | null = null;
  let flagReads = 0;
  const handlers = new Map<string, Set<() => void>>();
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
    if (typeof a !== 'function') return String(a);
    if (!ids.has(a)) ids.set(a, `fn${ids.size + 1}`);
    return ids.get(a) as string;
  };
  const on = (type: string, h: () => void) => {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)?.add(h);
  };
  const off = (type: string, h: () => void) => handlers.get(type)?.delete(h);
  const rec = (name: string, effect?: (...args: Row[]) => void) => (...args: Row[]) => {
    calls.push(`${name}(${args.map(label).join(',')})`);
    if (o.throwOn?.includes(name)) throw new Error(`${name} threw`);
    effect?.(...args);
  };
  const webApp: Row = {
    initData: o.initData ?? INIT_DATA,
    initDataUnsafe: {},
    version: o.version,
    colorScheme: o.colorScheme ?? 'light',
    isVersionAtLeast: (v: string) => versionAtLeast(o.version, v),
    setHeaderColor: rec('setHeaderColor'),
    setBackgroundColor: rec('setBackgroundColor'),
    onEvent: rec('onEvent', (type, h) => on(String(type), h as unknown as () => void)),
    offEvent: rec('offEvent', (type, h) => off(String(type), h as unknown as () => void)),
    openLink: rec('openLink'),
    enableVerticalSwipes: rec('enableVerticalSwipes', () => { swipes = true; }),
    disableVerticalSwipes: rec('disableVerticalSwipes', () => { swipes = false; }),
    BackButton: {
      isVisible: false,
      onClick: rec('BackButton.onClick', h => on('backButtonClicked', h as unknown as () => void)),
      offClick: rec('BackButton.offClick', h => off('backButtonClicked', h as unknown as () => void)),
      show: rec('BackButton.show', () => { webApp.BackButton.isVisible = true; }),
      hide: rec('BackButton.hide', () => { webApp.BackButton.isVisible = false; }),
    },
  };
  Object.defineProperty(webApp, 'isVerticalSwipesEnabled', {
    get() {
      flagReads++;
      throw new Error('isVerticalSwipesEnabled was read');
    },
  });
  return {
    webApp,
    calls,
    fire: (type: string) => [...(handlers.get(type) ?? [])].forEach(h => h()),
    count: (type: string) => handlers.get(type)?.size ?? 0,
    swipes: () => swipes,
    flagReads: () => flagReads,
  };
}

/** A fake prefers-color-scheme query whose `matches` can change, with its listeners. */
function fakeMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const query: Row = {
    matches: dark,
    addEventListener: (_t: string, l: () => void) => listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
  };
  return {
    matchMedia: (q: string) => {
      assert(q === '(prefers-color-scheme: dark)', `matchMedia(${q})`);
      return query;
    },
    set: (next: boolean) => {
      query.matches = next;
      listeners.forEach(l => l());
    },
    count: () => listeners.size,
  };
}

/** Runs fn with this Telegram SDK (null: none), launch hash and matchMedia; console.warn collected. */
async function withEnv(
  o: { webApp?: Row | null; hash?: string; matchMedia?: (q: string) => Row },
  fn: (warnings: string[]) => void | Promise<void>
) {
  const warnings: string[] = [];
  const prevWarn = console.warn;
  if (o.webApp) fakeWindow.Telegram = { WebApp: o.webApp };
  else delete fakeWindow.Telegram;
  fakeWindow.location = { hash: o.hash ?? '' };
  if (o.matchMedia) fakeWindow.matchMedia = o.matchMedia;
  else delete fakeWindow.matchMedia;
  delete fakeWindow.open;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    await fn(warnings);
  } finally {
    console.warn = prevWarn;
    delete fakeWindow.Telegram;
    delete fakeWindow.matchMedia;
    delete fakeWindow.open;
    fakeWindow.location = { hash: '' };
  }
}

async function main() {
  const { useTelegramBackButton, useTelegramTheme, useTelegramVerticalSwipes, releaseTelegramControls } = await ui().catch(() => ({} as Row));

  function BackProbe(props: { active: boolean; onBack: () => void }) {
    useTelegramBackButton(props.active, props.onBack);
    return null;
  }
  const back = (active: boolean, onBack: () => void) => React.createElement(BackProbe, { active, onBack });

  function SwipeProbe(props: { locked: boolean }) {
    useTelegramVerticalSwipes(props.locked);
    return null;
  }
  const swipes = (locked: boolean) => React.createElement(SwipeProbe, { locked });
  const strict = (locked: boolean) => React.createElement(React.StrictMode, null, swipes(locked));
  /** The E4 exports exist (before Task E4 they don't, and a probe calling one would throw while rendering). */
  const swipesExported = () => {
    assert(typeof useTelegramVerticalSwipes === 'function', 'useTelegramVerticalSwipes is not exported');
    assert(typeof releaseTelegramControls === 'function', 'releaseTelegramControls is not exported');
  };
  const swipeCalls = (calls: string[]) => calls.filter(c => c.includes('VerticalSwipes'));

  function ThemeProbe(props: { seen: string[] }) {
    props.seen.push(useTelegramTheme());
    return null;
  }

  await check('#1 [types] isVersionAtLeast, vertical swipes, onEvent/offEvent, the safe-area insets and the section colours are typed', () => {
    const typed = typedMembers({
      isVersionAtLeast: () => true,
      safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      themeParams: {},
      BackButton: {},
    } as unknown as TelegramWebApp);
    assert(typed.length === 14, `${typed.length} members`);
  });

  await check('#2 BackButton (8.0 client): mounted inactive it only hides; active, one handler and show(); a tap calls onBack', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const taps: string[] = [];
      const view = mount(back(false, () => taps.push('a')));
      assert(show(tg.calls) === show(['BackButton.hide()']), `mounted inactive: ${show(tg.calls)}`);
      view.render(back(true, () => taps.push('a')));
      assert(show(tg.calls.slice(1)) === show(['BackButton.onClick(fn1)', 'BackButton.show()']), `active: ${show(tg.calls)}`);
      assert(tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 1, `visible ${tg.webApp.BackButton.isVisible}, ${tg.count('backButtonClicked')} handlers`);
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['a']), `taps ${show(taps)}`);
      view.unmount();
    });
  });

  await check('#3 BackButton: a new onBack on re-render is used without re-registering; inactive → offClick(that handler), hide(), and a tap reaches nobody', async () => {
    await ui();
    const tg = fakeTelegram({ version: '7.10' });
    await withEnv({ webApp: tg.webApp }, () => {
      const taps: string[] = [];
      const view = mount(back(true, () => taps.push('first')));
      const before = tg.calls.length;
      view.render(back(true, () => taps.push('second')));
      assert(tg.calls.length === before, `re-render called ${show(tg.calls.slice(before))}`);
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['second']), `taps ${show(taps)}`);
      view.render(back(false, () => taps.push('third')));
      assert(show(tg.calls.slice(before)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()']), `inactive: ${show(tg.calls)}`);
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0, 'still shown or still registered');
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['second']), `taps after: ${show(taps)}`);
      view.unmount();
    });
  });

  await check('#4 BackButton: mounted active → hide() first, then onClick + show(); unmount → offClick + hide()', async () => {
    await ui();
    const tg = fakeTelegram({ version: '6.1' });
    await withEnv({ webApp: tg.webApp }, () => {
      const view = mount(back(true, noop));
      assert(show(tg.calls) === show(['BackButton.hide()', 'BackButton.onClick(fn1)', 'BackButton.show()']), `mount: ${show(tg.calls)}`);
      view.unmount();
      assert(show(tg.calls.slice(3)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()']), `unmount: ${show(tg.calls)}`);
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0, 'left shown or registered');
    });
  });

  await check('#5 BackButton under StrictMode (effects run twice): shown with exactly one handler; unmount leaves none', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const taps: string[] = [];
      const view = mount(React.createElement(React.StrictMode, null, back(true, () => taps.push('x'))));
      assert(tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 1, `visible ${tg.webApp.BackButton.isVisible}, ${tg.count('backButtonClicked')} handlers: ${show(tg.calls)}`);
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['x']), `taps ${show(taps)}`);
      view.unmount();
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0, 'left shown or registered');
    });
  });

  await check('#6 BackButton on a 6.0 client and in a browser (SDK at 6.0, no initData): no SDK call at all; with no SDK nothing throws', async () => {
    await ui();
    for (const tg of [fakeTelegram({ version: '6.0' }), fakeTelegram({ version: '6.0', initData: '' })]) {
      await withEnv({ webApp: tg.webApp }, () => {
        const view = mount(back(false, noop));
        view.render(back(true, noop));
        view.render(back(false, noop));
        view.unmount();
        assert(tg.calls.length === 0, `${tg.webApp.initData ? '6.0 client' : 'browser'}: ${show(tg.calls)}`);
      });
    }
    await withEnv({ webApp: null }, () => {
      const view = mount(back(true, noop));
      view.render(back(false, noop));
      view.unmount();
    });
  });

  await check('#7 BackButton: a hide() that throws on mount still lets it show later; an offClick that throws still hides; both logged', async () => {
    await ui();
    const hides = fakeTelegram({ version: '8.0', throwOn: ['BackButton.hide'] });
    await withEnv({ webApp: hides.webApp }, warnings => {
      const view = mount(back(false, noop));
      view.render(back(true, noop));
      assert(hides.webApp.BackButton.isVisible, `not shown: ${show(hides.calls)}`);
      assert(warnings.some(w => w.includes('BackButton.hide threw')), `warnings ${show(warnings)}`);
      view.unmount();
    });
    const offs = fakeTelegram({ version: '8.0', throwOn: ['BackButton.offClick'] });
    await withEnv({ webApp: offs.webApp }, warnings => {
      const view = mount(back(true, noop));
      view.render(back(false, noop));
      assert(!offs.webApp.BackButton.isVisible, `still shown: ${show(offs.calls)}`);
      assert(warnings.some(w => w.includes('BackButton.offClick threw')), `warnings ${show(warnings)}`);
      view.unmount();
    });
  });

  await check('#8 theme (8.0 client): setHeaderColor(bg_color) and setBackgroundColor(bg_color) on mount; Telegram\'s colorScheme; themeChanged re-applies and re-renders; unmount unsubscribes', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0', colorScheme: 'dark' });
    await withEnv({ webApp: tg.webApp }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      const colours = () => tg.calls.filter(c => c.startsWith('set'));
      assert(show(colours()) === show(['setHeaderColor(bg_color)', 'setBackgroundColor(bg_color)']), `mount: ${show(tg.calls)}`);
      assert(seen[seen.length - 1] === 'dark', `scheme ${show(seen)}`);
      assert(tg.count('themeChanged') === 2, `${tg.count('themeChanged')} themeChanged handlers (colours + scheme)`);
      tg.webApp.colorScheme = 'light';
      act(() => tg.fire('themeChanged'));
      assert(seen[seen.length - 1] === 'light', `after themeChanged: ${show(seen)}`);
      assert(colours().length === 4, `colours after themeChanged: ${show(colours())}`);
      view.unmount();
      assert(tg.count('themeChanged') === 0, `${tg.count('themeChanged')} handlers left`);
    });
  });

  await check('#8b theme: two mounted users register their own handlers; the first unmount leaves the other re-applying the colours', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const a = mount(React.createElement(ThemeProbe, { seen: [] }));
      const b = mount(React.createElement(ThemeProbe, { seen: [] }));
      assert(tg.count('themeChanged') === 4, `${tg.count('themeChanged')} themeChanged handlers for two users (colours + scheme each)`);
      a.unmount();
      assert(tg.count('themeChanged') === 2, `${tg.count('themeChanged')} handlers after one unmount`);
      const before = tg.calls.filter(c => c.startsWith('set')).length;
      act(() => tg.fire('themeChanged'));
      const after = tg.calls.filter(c => c.startsWith('set')).slice(before);
      assert(show(after) === show(['setHeaderColor(bg_color)', 'setBackgroundColor(bg_color)']), `after the first unmount: ${show(after)}`);
      b.unmount();
      assert(tg.count('themeChanged') === 0, `${tg.count('themeChanged')} handlers left`);
    });
  });

  await check('#9 theme on a 6.0 client: no colour call (the scheme still follows colorScheme); a setHeaderColor that throws still lets setBackgroundColor run', async () => {
    await ui();
    const old = fakeTelegram({ version: '6.0', colorScheme: 'dark' });
    await withEnv({ webApp: old.webApp }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      assert(!old.calls.some(c => c.startsWith('set')), `6.0: ${show(old.calls)}`);
      assert(seen[seen.length - 1] === 'dark', `6.0 scheme ${show(seen)}`);
      view.unmount();
    });
    const throws = fakeTelegram({ version: '6.1', throwOn: ['setHeaderColor'] });
    await withEnv({ webApp: throws.webApp }, warnings => {
      const view = mount(React.createElement(ThemeProbe, { seen: [] }));
      assert(throws.calls.includes('setBackgroundColor(bg_color)'), `after a throw: ${show(throws.calls)}`);
      assert(warnings.some(w => w.includes('setHeaderColor threw')), `warnings ${show(warnings)}`);
      view.unmount();
    });
  });

  await check('#10 theme in a browser (SDK at 6.0, no initData): prefers-color-scheme and its changes, never Telegram\'s colorScheme; unmount removes the listener', async () => {
    await ui();
    const tg = fakeTelegram({ version: '6.0', initData: '', colorScheme: 'dark' });
    const media = fakeMatchMedia(false);
    await withEnv({ webApp: tg.webApp, matchMedia: media.matchMedia }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      assert(seen[seen.length - 1] === 'light', `browser light: ${show(seen)}`);
      assert(media.count() === 1, `${media.count()} media listeners`);
      act(() => media.set(true));
      assert(seen[seen.length - 1] === 'dark', `browser dark: ${show(seen)}`);
      view.unmount();
      assert(media.count() === 0, `${media.count()} media listeners left`);
      assert(!tg.calls.some(c => c.startsWith('set')), `colour calls in a browser: ${show(tg.calls)}`);
    });
    await withEnv({ webApp: null }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      assert(seen[seen.length - 1] === 'light', `no SDK, no matchMedia: ${show(seen)}`);
      view.unmount();
    });
  });

  await check('#11 server render: the theme is light and neither hook calls the SDK while rendering', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0', colorScheme: 'dark' });
    await withEnv({ webApp: tg.webApp }, () => {
      const seen: string[] = [];
      renderToString(React.createElement(React.Fragment, null, React.createElement(ThemeProbe, { seen }), back(true, noop)));
      assert(show(seen) === show(['light']), `server scheme ${show(seen)}`);
      assert(tg.calls.length === 0, `calls during a server render: ${show(tg.calls)}`);
    });
  });

  await check('#12 onTelegramEvent: activated needs Bot API 8.0 (7.10: no subscription, a no-op unsubscribe); on 8.0 the same handler on and off', async () => {
    const { onTelegramEvent } = await ui();
    const old = fakeTelegram({ version: '7.10' });
    await withEnv({ webApp: old.webApp }, () => {
      const off = onTelegramEvent('activated', noop);
      off();
      assert(old.calls.length === 0, `7.10: ${show(old.calls)}`);
    });
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      let hits = 0;
      const off = onTelegramEvent('activated', () => { hits++; });
      tg.fire('activated');
      off();
      tg.fire('activated');
      assert(show(tg.calls) === show(['onEvent(activated,fn1)', 'offEvent(activated,fn1)']), `8.0: ${show(tg.calls)}`);
      assert(hits === 1, `${hits} hits`);
    });
  });

  await check('#13 openExternalLink: Telegram → openLink; a browser → a new tab; javascript: and relative links refused; a throwing openLink falls back to a tab', async () => {
    const { openExternalLink } = await ui();
    const link = 'https://www.google.com/calendar/event?eid=abc123';
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const opened: string[] = [];
      fakeWindow.open = (...a: unknown[]) => { opened.push(a.join(' ')); return null; };
      assert(openExternalLink(link) === true, 'not opened');
      assert(show(tg.calls) === show([`openLink(${link})`]) && opened.length === 0, `telegram: ${show(tg.calls)} ${show(opened)}`);
      assert(openExternalLink('javascript:alert(1)') === false && openExternalLink('/en/settings') === false, 'a bad link was accepted');
      assert(tg.calls.length === 1 && opened.length === 0, `bad links opened: ${show(tg.calls)} ${show(opened)}`);
    });
    const browser = fakeTelegram({ version: '6.0', initData: '' });
    await withEnv({ webApp: browser.webApp }, () => {
      const opened: string[] = [];
      fakeWindow.open = (...a: unknown[]) => { opened.push(a.join(' ')); return null; };
      assert(openExternalLink(link) === true, 'not opened');
      assert(show(opened) === show([`${link} _blank noopener,noreferrer`]) && browser.calls.length === 0, `browser: ${show(opened)} ${show(browser.calls)}`);
    });
    const throws = fakeTelegram({ version: '8.0', throwOn: ['openLink'] });
    await withEnv({ webApp: throws.webApp }, () => {
      const opened: string[] = [];
      fakeWindow.open = (...a: unknown[]) => { opened.push(a.join(' ')); return null; };
      assert(openExternalLink(link) === true && opened.length === 1, `after a throw: ${show(opened)}`);
    });
  });

  await check('#14 isInTelegram: the SDK alone is not Telegram; initData from the SDK or the launch hash is', async () => {
    const { isInTelegram } = await ui();
    const got: Row = {};
    await withEnv({ webApp: fakeTelegram({ version: '6.0', initData: '' }).webApp }, () => { got.browserSdk = isInTelegram(); });
    await withEnv({ webApp: null }, () => { got.noSdk = isInTelegram(); });
    await withEnv({ webApp: fakeTelegram({ version: '8.0' }).webApp }, () => { got.sdk = isInTelegram(); });
    await withEnv({ webApp: null, hash: `#tgWebAppData=${encodeURIComponent(INIT_DATA)}` }, () => { got.hash = isInTelegram(); });
    assert(show(got) === show({ browserSdk: false, noSdk: false, sdk: true, hash: true }), show(got));
  });

  await check('#15 vertical swipes on a 7.6 client and in a browser (SDK at 6.0, no initData): no swipe call, locked or not, mounted or not; none during a server render; with no SDK nothing throws', async () => {
    await ui();
    swipesExported();
    for (const tg of [fakeTelegram({ version: '7.6' }), fakeTelegram({ version: '6.0', initData: '' })]) {
      await withEnv({ webApp: tg.webApp }, () => {
        const view = mount(swipes(false));
        view.render(swipes(true));
        view.render(swipes(false));
        view.render(swipes(true));
        view.unmount();
        releaseTelegramControls();
        assert(swipeCalls(tg.calls).length === 0, `${tg.webApp.initData ? '7.6 client' : 'browser'}: ${show(tg.calls)}`);
      });
    }
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      renderToString(React.createElement(React.Fragment, null, swipes(true), swipes(false)));
      assert(tg.calls.length === 0, `calls during a server render: ${show(tg.calls)}`);
    });
    await withEnv({ webApp: null }, () => {
      const view = mount(swipes(true));
      view.render(swipes(false));
      view.unmount();
      releaseTelegramControls();
    });
  });

  await check('#16 vertical swipes on 7.7, 7.10 and 8.0: an unlocked mount enables (a reload can leave them off); lock → disable, unlock → enable, one call per change and none on a re-render; a locked mount only disables; unmount enables; under StrictMode the state still ends as asked', async () => {
    await ui();
    swipesExported();
    for (const version of ['7.7', '7.10', '8.0']) {
      const tg = fakeTelegram({ version });
      await withEnv({ webApp: tg.webApp }, () => {
        const view = mount(swipes(false));
        assert(show(tg.calls) === show(['enableVerticalSwipes()']), `${version} unlocked mount: ${show(tg.calls)}`);
        view.render(swipes(true));
        view.render(swipes(true));
        assert(show(tg.calls.slice(1)) === show(['disableVerticalSwipes()']) && tg.swipes() === false, `${version} lock: ${show(tg.calls)}`);
        view.render(swipes(false));
        view.render(swipes(false));
        assert(show(tg.calls.slice(2)) === show(['enableVerticalSwipes()']) && tg.swipes() === true, `${version} unlock: ${show(tg.calls)}`);
        view.render(swipes(true));
        view.unmount();
        assert(show(tg.calls.slice(3)) === show(['disableVerticalSwipes()', 'enableVerticalSwipes()']) && tg.swipes() === true, `${version} lock, then unmount: ${show(tg.calls)}`);
      });
    }
    const locked = fakeTelegram({ version: '7.7' });
    await withEnv({ webApp: locked.webApp }, () => {
      const view = mount(swipes(true));
      assert(show(locked.calls) === show(['disableVerticalSwipes()']), `locked mount: ${show(locked.calls)}`);
      view.unmount();
      assert(show(locked.calls) === show(['disableVerticalSwipes()', 'enableVerticalSwipes()']), `locked unmount: ${show(locked.calls)}`);
    });
    const twice = fakeTelegram({ version: '7.7' });
    await withEnv({ webApp: twice.webApp }, () => {
      const view = mount(strict(true));
      assert(twice.swipes() === false, `StrictMode locked mount: ${show(twice.calls)}`);
      view.render(strict(false));
      assert(twice.swipes() === true, `StrictMode unlock: ${show(twice.calls)}`);
      view.render(strict(true));
      assert(twice.swipes() === false, `StrictMode lock: ${show(twice.calls)}`);
      view.unmount();
      assert(twice.swipes() === true, `StrictMode unmount: ${show(twice.calls)}`);
    });
  });

  await check('#17 isVerticalSwipesEnabled is never read (it is wrong after a reload): a getter that throws is never touched through mount, lock, unlock, unmount and releaseTelegramControls', async () => {
    await ui();
    swipesExported();
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, warnings => {
      const view = mount(swipes(true));
      view.render(swipes(false));
      view.render(swipes(true));
      view.unmount();
      releaseTelegramControls();
      assert(tg.flagReads() === 0, `isVerticalSwipesEnabled read ${tg.flagReads()} times`);
      assert(warnings.length === 0, `warnings ${show(warnings)}`);
      assert(
        show(swipeCalls(tg.calls)) === show(['disableVerticalSwipes()', 'enableVerticalSwipes()', 'disableVerticalSwipes()', 'enableVerticalSwipes()', 'enableVerticalSwipes()']),
        `calls ${show(tg.calls)}`,
      );
    });
  });

  await check('#18 a swipe call that throws is logged, never raised: a throwing disableVerticalSwipes on a locked mount still lets an unlock enable; a throwing enableVerticalSwipes on mount and on unmount is logged each time', async () => {
    await ui();
    swipesExported();
    const disables = fakeTelegram({ version: '7.7', throwOn: ['disableVerticalSwipes'] });
    await withEnv({ webApp: disables.webApp }, warnings => {
      const view = mount(swipes(true));
      assert(warnings.some(w => w.startsWith('[telegram-ui] disableVerticalSwipes failed:') && w.includes('disableVerticalSwipes threw')), `warnings ${show(warnings)}`);
      view.render(swipes(false));
      assert(disables.swipes() === true, `after the unlock: ${show(disables.calls)}`);
      view.unmount();
    });
    const enables = fakeTelegram({ version: '7.7', throwOn: ['enableVerticalSwipes'] });
    await withEnv({ webApp: enables.webApp }, warnings => {
      const view = mount(swipes(false));
      view.render(swipes(true));
      view.unmount();
      assert(show(enables.calls) === show(['enableVerticalSwipes()', 'disableVerticalSwipes()', 'enableVerticalSwipes()']), `calls ${show(enables.calls)}`);
      assert(warnings.filter(w => w.includes('enableVerticalSwipes threw')).length === 2, `warnings ${show(warnings)}`);
    });
  });

  await check('#19 releaseTelegramControls, before a reload (outside React): offClick(the live handler) and hide(), then enableVerticalSwipes(); a 7.6 client gets the BackButton calls only; a throwing hide() still enables; with no SDK nothing throws', async () => {
    await ui();
    assert(typeof releaseTelegramControls === 'function', 'releaseTelegramControls is not exported');
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const view = mount(back(true, noop));
      const before = tg.calls.length;
      releaseTelegramControls();
      assert(show(tg.calls.slice(before)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()', 'enableVerticalSwipes()']), `release: ${show(tg.calls)}`);
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0 && tg.swipes() === true, 'the button still shown or registered, or swipes not enabled');
      view.unmount();
    });
    const old = fakeTelegram({ version: '7.6' });
    await withEnv({ webApp: old.webApp }, () => {
      releaseTelegramControls();
      assert(show(old.calls) === show(['BackButton.hide()']), `7.6: ${show(old.calls)}`);
    });
    const hides = fakeTelegram({ version: '7.7', throwOn: ['BackButton.hide'] });
    await withEnv({ webApp: hides.webApp }, warnings => {
      releaseTelegramControls();
      assert(show(hides.calls) === show(['BackButton.hide()', 'enableVerticalSwipes()']) && hides.swipes() === true, `after a throwing hide(): ${show(hides.calls)}`);
      assert(warnings.some(w => w.includes('BackButton.hide threw')), `warnings ${show(warnings)}`);
    });
    await withEnv({ webApp: null }, () => releaseTelegramControls());
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
