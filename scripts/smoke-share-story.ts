// Smoke test for the share-story page (plan docs/superpowers/plans/2026-10-27-app-ui-W1b-subscription-feedback-story.md, Task 4;
// spec 2026-10-19-screens-and-colours §5): the Mini App page that calls shareToStory and closes, in real React on the small fake DOM,
// with a fake Telegram.WebApp (ready, showAlert, close, shareToStory), a fake fetch and the page's 5 second close held by hand. No
// network, no DB. The page's own URL shape (?user_id&source[&msg]) is what the bot's buttons send, and stays.
//  - H1 the way it goes, mounted fresh and hydrated from the server's markup: one request to /api/weather-image/sign with the page's
//    user, source and message and the initData header, shareToStory with that image and the FamCal widget link, and the window
//    closing 5 seconds after, not before; no expand();
//  - H2 an older Telegram (below Bot API 7.8), as the live SDK is shaped (shareToStory is always there and throws below 7.8): one
//    pop-up in the page's language before any request, and the window closes only after it is dismissed;
//  - H3 outside Telegram, hydrated from the server's markup as a browser does it (the effect runs once on the server's answer): a card
//    that says to open it in Telegram (in the page's language), no request, no ready(), no close(); with no user_id: the missing-
//    parameter card, no request, in or out of Telegram, and a request never carries user_id=null;
//  - H4 what goes wrong: a refusal (the server's words nowhere; logged) or a throw (logged) say so in the page's language and the
//    window closes after OK; an answer with no image is a refusal;
//  - H5 the loader is the app's (a ch-loader in an app screen), no emoji, and nothing of the old page (purple, English, startMiniApp)
//    is left; every key of shareStory is read.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-share-story.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-share-story.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { elements, fakeTelegram, fakeWindow, installWindow, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';
import { parseMarkup } from './lib/fake-markup';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

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

// ---- React must not warn; what the page itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[share-story]') || text.startsWith('[telegram-ui]')) return void appLogs.push(text);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: a fetch, and the page's 5 second timer held by hand ----

const { SearchParamsContext } = nodeRequire('next/dist/shared/lib/hooks-client-context.shared-runtime');
interface FetchCall {
  url: string;
  init: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const world = {
  sign: (): Response | Promise<Response> => json({ url: 'https://famcal.bot/api/weather-image?user_id=7&sig=abc' }),
};
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url.startsWith('/api/weather-image/sign')) return world.sign();
  throw new Error(`an unexpected request: ${url}`);
}) as typeof fetch;

/** The page's own timers (every setTimeout with a delay of a second or more): held, not run, until the test says. */
const held: { fn: () => void; delay: number }[] = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
  if (typeof delay === 'number' && delay >= 1000) {
    held.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }
  return realSetTimeout(fn, delay, ...rest);
}) as typeof setTimeout;

const reset = () => {
  fetchCalls.length = 0;
  appLogs.length = 0;
  held.length = 0;
  world.sign = () => json({ url: 'https://famcal.bot/api/weather-image?user_id=7&sig=abc' });
};

let ShareStory: () => ReactElement;
function tree(locale: Locale, query: string): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(ShareStory));
  return createElement(SearchParamsContext.Provider, { value: new URLSearchParams(query) }, intl);
}
const word = (locale: Locale, key: string, ns = 'shareStory'): string => {
  const value = `${ns}.${key}`.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${ns}.${key} in ${locale}`);
  return value;
};

// ---- Reading what is on the page ----

const textOf = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
const flat = (node: FakeNode) => visible(node).replace(/\s+/g, ' ').trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => realSetTimeout(r, 0));
  });

interface Opened {
  m: Pick<Mounted, 'container' | 'unmount'>;
  tg: Row | null;
  calls: string[];
  alerts: { message: string; done?: () => void }[];
  shared: { url: string; params: unknown }[];
  /** What React reported as recoverable while hydrating (a mismatch with the server's markup). */
  recoverable: string[];
}
interface OpenOptions {
  /** No Telegram.WebApp at all (a plain browser). */
  noSdk?: boolean;
  /** The SDK is there, without a signed launch (a browser that loaded telegram-web-app.js, which reports Bot API 6.0 there). */
  noInitData?: boolean;
  /** A client below Bot API 7.8 (it reports 7.7): shareToStory is still defined, as in the live SDK, and throws. */
  old?: boolean;
  /** The Bot API version the SDK reports, over the one the other options imply (7.8 in Telegram, 7.7 old, 6.0 in a browser). */
  version?: string;
  /** Hydrate the server's markup, as a browser does, instead of mounting fresh. */
  hydrate?: boolean;
  /** A client whose pop-up throws. */
  brokenAlert?: boolean;
  /** The SDK's own copy of the launch data is in sessionStorage (the SDK script itself did not run). */
  storedInitData?: boolean;
}
/** Mount the page at `query`; the caller closes it. */
function open(locale: Locale, query: string, options: OpenOptions = {}): Opened {
  installWindow();
  const calls: string[] = [];
  const alerts: Opened['alerts'] = [];
  const shared: Opened['shared'] = [];
  const tg = fakeTelegram(calls, options.version ?? (options.old ? '7.7' : options.noInitData ? '6.0' : '7.8'));
  tg.initData = options.noInitData ? '' : 'fake-init-data';
  tg.showAlert = options.brokenAlert
    ? () => {
        throw new Error('WebAppMethodUnsupported');
      }
    : (message: string, done?: () => void) => void alerts.push({ message, done });
  // The live SDK (telegram-web-app.js) always defines shareToStory, and throws inside it below Bot API 7.8
  tg.shareToStory = (url: string, params: unknown) => {
    if (!tg.isVersionAtLeast('7.8')) throw new Error('WebAppMethodUnsupported');
    shared.push({ url, params });
  };
  fakeWindow.Telegram = options.noSdk ? undefined : { WebApp: tg };
  if (options.storedInitData) fakeWindow.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ tgWebAppData: 'fake-init-data' }));
  const recoverable: string[] = [];
  if (!options.hydrate) return { m: mount(tree(locale, query)), tg, calls, alerts, shared, recoverable };
  // What the server sent, rendered with no window; then the browser's nodes for it; then React adopting them
  const container = new FakeElement('div', 'http://www.w3.org/1999/xhtml');
  parseMarkup(container, serverMarkup(tree(locale, query)));
  const { hydrateRoot } = nodeRequire('react-dom/client');
  let root: { unmount: () => void } | undefined;
  act(() => {
    root = hydrateRoot(container, tree(locale, query), { onRecoverableError: (error: unknown) => void recoverable.push(String(error)) });
  });
  return { m: { container, unmount: () => act(() => root?.unmount()) }, tg, calls, alerts, shared, recoverable };
}
/** The markup the server renders: no window or document in that world. */
function serverMarkup(el: ReactElement): string {
  const g = globalThis as Row;
  const [win, doc] = [g.window, g.document];
  delete g.window;
  delete g.document;
  try {
    return renderToString(el);
  } finally {
    g.window = win;
    g.document = doc;
  }
}
const close = (opened: Opened) => {
  opened.m.unmount();
  fakeWindow.Telegram = undefined;
  fakeWindow.sessionStorage.removeItem('__telegram__initParams');
};
const closes = (o: Opened) => o.calls.filter((c) => c === 'close()').length;
const signCalls = () => fetchCalls.filter((c) => c.url.startsWith('/api/weather-image/sign'));

async function main() {
  ShareStory = (await import('../app/[locale]/share-story/page')).default as unknown as () => ReactElement;

  await check('H1 the way it goes, in en, he and ru, mounted fresh and hydrated from the server\'s markup (Telegram 7.8): ready() is called (never expand()), one request to /api/weather-image/sign with the page\'s user, source and message and the initData header, shareToStory with the image it gave and the FamCal widget link, and the window closes 5 seconds later, not before; no pop-up, nothing logged', async () => {
    const cases: [string, string][] = [
      ['user_id=7&source=cached', '/api/weather-image/sign?user_id=7&source=cached'],
      ['user_id=7&source=summary&msg=12', '/api/weather-image/sign?user_id=7&source=summary&msg=12'],
      ['user_id=7', '/api/weather-image/sign?user_id=7&source=fresh'],
    ];
    for (const locale of LOCALES) {
      for (const [query, url, hydrate] of cases.flatMap(([q, u]) => [[q, u, false] as const, [q, u, true] as const])) {
        reset();
        const o = open(locale, query, { hydrate });
        try {
          await settle();
          assert(o.recoverable.length === 0, `${locale}: hydration reported ${show(o.recoverable)}`);
          assert(o.calls.includes('ready()') && !o.calls.some((c) => c.startsWith('expand(')), `${locale}: the calls ${show(o.calls)}`);
          assert(signCalls().length === 1 && fetchCalls.length === 1, `${locale} ${query}: ${fetchCalls.length} requests`);
          assert(signCalls()[0].url === url, `${locale}: the URL ${signCalls()[0].url}, want ${url}`);
          assert(show(signCalls()[0].init.headers) === show({ 'X-Telegram-Init-Data': 'fake-init-data' }), `${locale}: the headers ${show(signCalls()[0].init.headers)}`);
          assert(show(o.shared) === show([{ url: 'https://famcal.bot/api/weather-image?user_id=7&sig=abc', params: { widget_link: { url: 'https://famcal.bot', name: 'FamCal' } } }]), `${locale}: the story ${show(o.shared)}`);
          assert(held.length === 1 && held[0].delay === 5000 && closes(o) === 0, `${locale}: the timer ${show(held.map((h) => h.delay))}, ${closes(o)} closes before it`);
          held[0].fn();
          assert(closes(o) === 1, `${locale}: the window closes after the 5 seconds`);
          assert(o.alerts.length === 0 && appLogs.length === 0, `${locale}: ${show(o.alerts)} ${show(appLogs)}`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('H2 an older Telegram, shaped like the live SDK (Bot API 7.7: shareToStory is there and throws below 7.8): one pop-up, "update Telegram" in the page\'s language, before any request, and the window closes only once the pop-up is dismissed', async () => {
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, 'user_id=7&source=cached', { old: true });
      try {
        await settle();
        assert(o.tg?.version === '7.7' && typeof o.tg.shareToStory === 'function' && !o.tg.isVersionAtLeast('7.8'), `${locale}: the fake is not the live SDK's shape`);
        assert(show(o.alerts.map((a) => a.message)) === show([word(locale, 'updateTelegram')]), `${locale}: the pop-up ${show(o.alerts)}`);
        assert(fetchCalls.length === 0 && o.shared.length === 0, `${locale}: a request or a story went out`);
        assert(appLogs.length === 0, `${locale}: the old client got a failure instead of the update note: ${show(appLogs)}`);
        assert(closes(o) === 0 && held.length === 0, `${locale}: the window closed before OK (${closes(o)})`);
        o.alerts[0].done?.();
        assert(closes(o) === 1, `${locale}: the window closes after OK`);
      } finally {
        close(o);
      }
    }
  });

  await check('H3 outside Telegram, hydrated from the server\'s markup as a browser does it (the effect runs once on the server\'s answer, before the page re-renders for the client\'s): with no SDK, the SDK and no signed launch (at the 6.0 a browser reports, and at 7.8), or launch data and no SDK, the card that says to open it in Telegram (an alert, in the page\'s language), no request, no story, no ready() and no close(); with no user_id the missing-parameter card, in Telegram or out, no request; a request never carries user_id=null', async () => {
    for (const locale of LOCALES) {
      for (const options of [{ noSdk: true }, { noInitData: true }, { noInitData: true, version: '7.8' }, { noSdk: true, storedInitData: true }]) {
        reset();
        const o = open(locale, 'user_id=7&source=cached', { ...options, hydrate: true });
        try {
          await settle();
          assert(o.recoverable.length === 0, `${locale} ${show(options)}: hydration reported ${show(o.recoverable)}`);
          const card = elements(o.m.container).find((e) => e.getAttribute('role') === 'alert' && e.className.includes('ch-home-card'));
          assert(card && flat(card) === `${word(locale, 'telegramOnlyTitle')}${word(locale, 'telegramOnlyBody')}`, `${locale} ${show(options)}: the card ${card && flat(card)}`);
          assert(elements(o.m.container).some((e) => e.localName === 'h1' && flat(e) === word(locale, 'telegramOnlyTitle')), `${locale}: the title is the h1`);
          assert(fetchCalls.length === 0 && o.shared.length === 0 && closes(o) === 0, `${locale} ${show(options)}: ${fetchCalls.length} requests went out, ${closes(o)} closes: ${show(o.calls)}`);
          assert(!o.calls.includes('ready()') && o.alerts.length === 0 && appLogs.length === 0, `${locale} ${show(options)}: the page acted outside Telegram: ${show(o.calls)} ${show(o.alerts)} ${show(appLogs)}`);
          assert(!elements(o.m.container).some((e) => e.className === 'ch-loader'), `${locale}: the loader is still there`);
        } finally {
          close(o);
        }
      }
    }
    // H3b no user_id
    for (const locale of LOCALES) {
      for (const options of [{}, { noSdk: true }]) {
        reset();
        const o = open(locale, 'source=cached', options);
        try {
          await settle();
          const ui = messages[locale].ui as Row;
          const card = elements(o.m.container).find((e) => e.getAttribute('role') === 'alert');
          assert(card && flat(card) === `${ui.missingParameter.title}${ui.missingParameter.body}`, `${locale}: the missing-parameter card ${card && flat(card)}`);
          assert(fetchCalls.length === 0 && o.alerts.length === 0 && closes(o) === 0, `${locale} ${show(options)}: something went out with no user: ${show(fetchCalls.map((c) => c.url))}`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('H4 what goes wrong, in the page\'s language: a refusal (a 404 with the server\'s English) or an answer with no image is "couldn\'t prepare the image" and the server\'s words are nowhere; a throw is "couldn\'t share"; the status or the error is logged; the window closes once the pop-up is dismissed, never before', async () => {
    const cases: [string, () => Response | Promise<Response>, string, string][] = [
      ['a 404', () => json({ error: 'No location set' }, 404), 'loadFailed', '[share-story] image link refused: 404'],
      ['a 401', () => json({ error: 'Unauthorized' }, 401), 'loadFailed', '[share-story] image link refused: 401'],
      ['a 500', () => new Response('<html>', { status: 500 }), 'loadFailed', '[share-story] image link refused: 500'],
      ['no image', () => json({}), 'loadFailed', '[share-story] image link refused: 200'],
      ['a throw', () => Promise.reject(new Error('network down')), 'shareFailed', '[share-story] share failed:'],
      ['not JSON', () => new Response('<html>', { status: 200 }), 'shareFailed', '[share-story] share failed:'],
    ];
    for (const locale of LOCALES) {
      for (const [name, answer, key, log] of cases) {
        reset();
        world.sign = answer;
        const o = open(locale, 'user_id=7&source=cached');
        try {
          await settle();
          assert(show(o.alerts.map((a) => a.message)) === show([word(locale, key)]), `${locale} ${name}: the pop-up ${show(o.alerts)}`);
          assert(!o.alerts.some((a) => /No location|Unauthorized|Failed|Update Telegram/i.test(a.message)) && !/No location|Unauthorized/.test(flat(o.m.container)), `${locale} ${name}: the server's words or English`);
          assert(appLogs.length === 1 && appLogs[0].startsWith(log), `${locale} ${name}: the log ${show(appLogs)}`);
          if (name === 'a throw') assert(appLogs[0].includes('network down'), 'the error is logged');
          assert(o.shared.length === 0 && held.length === 0 && closes(o) === 0, `${locale} ${name}: the window closed before OK`);
          o.alerts[0].done?.();
          assert(closes(o) === 1, `${locale} ${name}: the window closes after OK`);
        } finally {
          close(o);
        }
      }
    }
    // A client whose pop-up fails: logged, and the window closes (it cannot wait for an OK that cannot come)
    reset();
    world.sign = () => json({ error: 'x' }, 404);
    const broken = open('en', 'user_id=7&source=cached', { brokenAlert: true });
    try {
      await settle();
      assert(closes(broken) === 1 && appLogs.some((l) => l.startsWith('[telegram-ui] showAlert failed:')), `a broken pop-up: ${closes(broken)} closes, ${show(appLogs)}`);
    } finally {
      close(broken);
    }
  });

  await check('H5 the loader is the app\'s: the first render (and the wait for the answer) is a ch-loader in an app screen, no emoji, nothing purple; the page keeps ready() literal, calls no expand() or startMiniApp, and has none of the old English; every key of shareStory is read, in all three languages', async () => {
    for (const locale of LOCALES) {
      const html = renderToString(tree(locale, 'user_id=7&source=cached'));
      assert(html.startsWith(`<div class="ch-app ch-screen" data-theme="light" dir="${locale === 'he' ? 'rtl' : 'ltr'}" lang="${locale}">`) && html.includes('class="ch-loader" role="status"'), `${locale}: ${html.slice(0, 160)}`);
      assert(!/\p{Extended_Pictographic}/u.test(textOf(html)) && !/#667eea|linear-gradient|Loading\.\.\./.test(html), `${locale}: an emoji or purple`);
      // And while the request is out
      reset();
      world.sign = () => new Promise<Response>(() => undefined);
      const o = open(locale, 'user_id=7&source=cached');
      try {
        await settle();
        assert(elements(o.m.container).some((e) => e.className === 'ch-loader') && elements(o.m.container).some((e) => e.className === 'ch-app ch-screen'), `${locale}: the loader while it works`);
      } finally {
        close(o);
      }
    }
    const source = fs.readFileSync(path.join(ROOT, 'app/[locale]/share-story/page.tsx'), 'utf8');
    const code = source.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(code.includes('tg.ready()') && !/expand\s*\(/.test(code) && !/startMiniApp/.test(code), 'ready() stays, expand() and startMiniApp stay out');
    assert(!/Update Telegram to share|Failed to load image|Failed to share|Loading\.\.\.|#667eea|linear-gradient/.test(code), 'the old English or purple is still there');
    assert(/user_id=\$\{userId\}&source=\$\{source\}/.test(code), "the sign request's shape changed");
    for (const locale of LOCALES) {
      const keys = Object.keys(messages[locale].shareStory as Row);
      assert(show(keys) === show(['telegramOnlyTitle', 'telegramOnlyBody', 'updateTelegram', 'loadFailed', 'shareFailed']), `${locale}: ${show(keys)}`);
      const unread = keys.filter((k) => !code.includes(`'${k}'`));
      assert(unread.length === 0, `${locale}: keys nothing reads: ${show(unread)}`);
    }
  });

  await check('H6 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
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
