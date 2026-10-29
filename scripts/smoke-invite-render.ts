// Smoke test for the invite landing (plan docs/superpowers/plans/2026-10-27-app-ui-W3-partner-invite.md, Task 2; spec
// 2026-10-19-screens-and-colours §4, §5): the public page /<locale>/invite/<token> (a server page and InviteClient) on AppScreen and the
// card the app's states use, in real React on the small fake DOM, with a fake Telegram.WebApp and a fake fetch. The page's data
// (getInviteByToken) and the server's translator are stood in for; the accept route has its own smoke (smoke-pairing-accept.ts).
// No network, no DB.
//  - V1 the render in en, he and ru, light (the server's markup, hydrated as a browser does it) and dark (Telegram): the plain
//    AppScreen root, no raw key, no emoji, no English in he and ru, no hydration mismatch, whether or not Telegram is there, and the
//    expiry in 24-hour time on the device (it waits for the client: the server does not know the device's zone);
//  - V2 in Telegram: Accept posts once to /api/pair/accept?user_id=<the Telegram id> with { token, initData }; while it works it is
//    disabled; each of the 8 error codes (and an unknown one, and a failed request) shows its own message in an error notice, with
//    Accept still there; "already paired together" shows as information and Accept goes; success shows the card, and Close closes
//    the Mini App;
//  - V3 in a browser (the SDK with no launch data, or no SDK at all): no Accept, no request; Open in Telegram, then Open in
//    WhatsApp, with the exact links, each hidden when its link is empty;
//  - V4 the server page: an invalid token is the crash card with its way home, as wide as the valid card; a valid one hands InviteClient what it always did
//    (the inviter's name with its fallbacks, the deep links, the expiry);
//  - V5 the page is made of the kit: no Tailwind class, no emoji, no gradient, none of the old comments, its own CSS passes the lint;
//    V6 React logs no warning.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-invite-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-invite-render.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';
import { parseMarkup } from './lib/fake-markup';
import { lintCss } from './lib/css-lint';

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

// ---- React must not warn ----

const reactWarnings: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
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
    const names = Object.keys(stubs[file]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map((n) => `export const ${n} = s[${JSON.stringify(n)}];`),
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

/** What the page's error capture was asked to report. */
const captured: { context: string; error: unknown; severity?: string }[] = [];
/** What getInviteByToken answers: an invite and its inviter, or null for a token that is none. */
let inviteFor: (token: string) => Row | null = () => null;

// ---- The world: a fetch ----

interface FetchCall {
  url: string;
  init: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const world = {
  accept: (): Response | Promise<Response> => json({ success: true }),
};
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url.startsWith('/api/pair/accept?user_id=') && init.method === 'POST') return world.accept();
  throw new Error(`an unexpected request: ${init.method} ${url}`);
}) as typeof fetch;
const requestCount = () => fetchCalls.length;
const capturedCount = () => captured.length;
const reset = () => {
  fetchCalls.length = 0;
  captured.length = 0;
  world.accept = () => json({ success: true });
};

// ---- Fixtures: the expiry is a local instant, so "15:45" is 15:45 under any clock ----

const local = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month - 1, day, hour, minute).toISOString();
const NAMES: Record<Locale, string> = { en: 'Dana', he: 'דנה', ru: 'Дана' };
const TOKEN = 'tok-abc123';
const TG_LINK = `https://t.me/test_bot?start=invite_${TOKEN}`;
const WA_LINK = `https://wa.me/972500000000?text=accept%20${TOKEN}`;
const TG_ID = 5550001;
const propsOf = (locale: Locale, over: Row = {}): Row => ({ token: TOKEN, inviterName: NAMES[locale], locale, tgDeepLink: TG_LINK, waDeepLink: WA_LINK, expiresAt: local(2026, 11, 3, 15, 45), ...over });

let Invite: (props: Row) => ReactElement;
function tree(locale: Locale, props: Row): ReactElement {
  return createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Invite, props));
}
/** What the strings of a language say, by the key of its invite namespace ('errors.expired'). */
const word = (locale: Locale, key: string, ns = 'invite', args: Row = {}): string => {
  const value = `${ns}.${key}`.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${ns}.${key} in ${locale}`);
  return Object.entries(args).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), value);
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
const page = (m: Pick<Mounted, 'container'>) => flat(m.container);
const classes = (e: FakeElement) => e.className.split(' ');
const buttonsOf = (m: Pick<Mounted, 'container'>) => elements(m.container).filter((e) => e.localName === 'button');
const anchorsOf = (m: Pick<Mounted, 'container'>) => elements(m.container).filter((e) => e.localName === 'a');
const acceptOf = (m: Pick<Mounted, 'container'>) => buttonsOf(m).find((b) => classes(b).includes('ch-btn-primary'));
const noticesOf = (m: Pick<Mounted, 'container'>) => elements(m.container).filter((e) => classes(e).includes('ch-notice'));
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

interface OpenOptions {
  /** Telegram with a signed launch of this user (Bot API 7.7). */
  telegram?: { scheme?: 'light' | 'dark' };
  /** The SDK is there, without a signed launch (a browser that loaded telegram-web-app.js, which reports Bot API 6.0). */
  sdkOnly?: boolean;
  /** Hydrate the server's markup, as a browser does, instead of mounting fresh. */
  hydrate?: boolean;
  /** The timezone the server's markup is rendered in (the process's own otherwise): a server far from the phone. */
  serverTz?: string;
}
interface Opened {
  m: Pick<Mounted, 'container' | 'unmount' | 'click'>;
  tg: Row | null;
  calls: string[];
  /** What React reported as recoverable while hydrating (a mismatch with the server's markup). */
  recoverable: string[];
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
/** Mount the page; the caller closes it. */
function open(locale: Locale, props: Row, options: OpenOptions = {}): Opened {
  installWindow();
  const calls: string[] = [];
  let tg: Row | null = null;
  if (options.telegram || options.sdkOnly) {
    tg = fakeTelegram(calls, options.sdkOnly ? '6.0' : '7.7');
    if (options.telegram) {
      tg.colorScheme = options.telegram.scheme ?? 'light';
      tg.initDataUnsafe = { user: { id: TG_ID } };
    } else {
      tg.initData = '';
    }
  }
  fakeWindow.Telegram = tg ? { WebApp: tg } : undefined;
  const recoverable: string[] = [];
  if (!options.hydrate) return { m: mount(tree(locale, props)), tg, calls, recoverable };
  // What the server sent (it knows nothing of Telegram or the device), then the browser's nodes for it, then React adopting them
  const container = new FakeElement('div', 'http://www.w3.org/1999/xhtml');
  const clientTz = process.env.TZ;
  if (options.serverTz) process.env.TZ = options.serverTz;
  try {
    parseMarkup(container, serverMarkup(tree(locale, props)));
  } finally {
    process.env.TZ = clientTz;
  }
  const { hydrateRoot } = nodeRequire('react-dom/client');
  let root: { unmount: () => void } | undefined;
  act(() => {
    root = hydrateRoot(container, tree(locale, props), { onRecoverableError: (error: unknown) => void recoverable.push(String(error)) });
  });
  const click = () => {
    throw new Error('a hydrated page is read, not tapped: mount it fresh');
  };
  return { m: { container, unmount: () => act(() => root?.unmount()), click }, tg, calls, recoverable };
}
const close = (opened: Opened) => {
  opened.m.unmount();
  fakeWindow.Telegram = undefined;
};

async function main() {
  // The boundaries of the page: its data, its translator and the error capture
  stub('src/services/pairing-service.ts', { getInviteByToken: async (token: string) => inviteFor(token) });
  stub('src/lib/error-capture.ts', { captureError: (error: unknown, context: string, _extra?: unknown, severity?: string) => void captured.push({ context, error, severity }) });
  const { createTranslator } = nodeRequire('next-intl');
  stub(path.relative(ROOT, nodeRequire.resolve('next-intl/server')), {
    __esModule: true,
    getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => createTranslator({ locale, namespace, messages: messages[locale as Locale] }),
  });
  process.env.TELEGRAM_BOT_USERNAME = 'test_bot';
  process.env.WHATSAPP_PHONE_NUMBER = '972500000000';
  const clientModule = await import('../app/[locale]/(app)/invite/[token]/InviteClient');
  Invite = clientModule.default as unknown as (props: Row) => ReactElement;
  const { INVITE_CSS } = await import('../app/[locale]/(app)/invite/[token]/invite-css');
  const InvitePage = (await import('../app/[locale]/(app)/invite/[token]/page')).default as unknown as (props: Row) => Promise<ReactElement>;

  await check('V1 render in en, he and ru, light (the server\'s markup, hydrated as a browser does it, in a browser and inside Telegram) and dark (Telegram): a plain AppScreen root with its direction and language, the card\'s h1 and body, no raw key, no emoji, no English in he and ru beyond the brands, no hydration mismatch, and the expiry on the device in 24-hour time (15:45, never PM) once the page is on the client', async () => {
    for (const locale of LOCALES) {
      reset();
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const name = NAMES[locale];
      const server = serverMarkup(tree(locale, propsOf(locale)));
      const text = textOf(server);
      assert(server.startsWith(`<div class="ch-app ch-screen" data-theme="light" dir="${dir}" lang="${locale}">`), `${locale}: the root: ${server.slice(0, 140)}`);
      assert(server.includes(`<h1 class="ch-home-card-title">${word(locale, 'title', 'invite', { name })}</h1>`) && text.includes(word(locale, 'subtitle')), `${locale}: the title and the body: ${text}`);
      assert(!/\binvite\.[a-zA-Z]/.test(text), `${locale}: a raw key in ${text}`);
      assert(!/\p{Extended_Pictographic}/u.test(server), `${locale}: an emoji`);
      if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(/Telegram|WhatsApp/g, '')), `${locale}: Latin letters in ${text}`);
      // The server cannot know the device's zone, so the expiry is not in its markup: no mismatch to hydrate against
      assert(!text.includes(word(locale, 'expires', 'invite', { when: '' }).trim()) && !/\d{1,2}:\d{2}/.test(text), `${locale}: the server wrote an expiry: ${text}`);
      for (const options of [{}, { sdkOnly: true }, { telegram: {} }] as OpenOptions[]) {
        const o = open(locale, propsOf(locale), { ...options, hydrate: true });
        try {
          await settle();
          const where = `${locale} ${show(options)}`;
          assert(o.recoverable.length === 0, `${where}: hydration reported ${show(o.recoverable)}`);
          const now = page(o.m);
          const when = /(?:Link expires|הקישור בתוקף עד|Ссылка действует до) (.+)$/.exec(now)?.[1] ?? '';
          assert(/(?:^|\D)15:45$/.test(when) && when.includes('3') && !/\b[AP]\.?M\b/i.test(now), `${where}: the expiry reads ${show(when)} in ${now}`);
          if (locale === 'en') assert(/^\w{3} 3 Nov, 15:45$/.test(when), `${where}: the expiry reads ${show(when)}`);
          assert(elements(o.m.container).some((e) => e.localName === 'h1' && flat(e) === word(locale, 'title', 'invite', { name })), `${where}: the title is the h1`);
          // Inside Telegram the Accept button replaces the links once the page is on the client; elsewhere the links stay
          if (options.telegram) assert(!!acceptOf(o.m) && anchorsOf(o.m).length === 0, `${where}: Accept after mount: ${buttonsOf(o.m).length} button(s), ${anchorsOf(o.m).length} link(s)`);
          else assert(!acceptOf(o.m) && anchorsOf(o.m).length === 2, `${where}: the two links: ${anchorsOf(o.m).length}`);
        } finally {
          close(o);
        }
      }
      // A server in another timezone than the phone (the real case: the server's clock is UTC): nothing to mismatch, and the phone's own time shows
      const zones = ['UTC', 'Asia/Jerusalem', 'America/New_York'];
      const instant = new Date(Date.UTC(2026, 10, 3, 13, 45));
      const clientZone = process.env.TZ;
      try {
        for (const serverTz of zones) {
          process.env.TZ = 'Asia/Jerusalem';
          const far = open(locale, propsOf(locale, { expiresAt: instant.toISOString() }), { hydrate: true, serverTz });
          try {
            await settle();
            assert(far.recoverable.length === 0, `${locale}: a server in ${serverTz}: hydration reported ${show(far.recoverable)}`);
            assert(/15:45$/.test(page(far.m)), `${locale}: the phone's own time (15:45 in Jerusalem) after a server in ${serverTz}: ${page(far.m)}`);
          } finally {
            close(far);
          }
        }
      } finally {
        process.env.TZ = clientZone;
      }
      // Dark, as Telegram says it
      for (const scheme of ['dark', 'light'] as const) {
        const o = open(locale, propsOf(locale), { telegram: { scheme } });
        try {
          const root = elements(o.m.container).find((e) => e.className === 'ch-app ch-screen');
          assert(root && root.getAttribute('data-theme') === scheme && root.getAttribute('dir') === dir && root.getAttribute('lang') === locale, `${locale} ${scheme}: the root`);
          assert(o.calls.includes('setHeaderColor(bg_color)') && o.calls.includes('setBackgroundColor(bg_color)') && !o.calls.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), `${locale} ${scheme}: ${show(o.calls.filter((c) => /Color/.test(c)))}`);
        } finally {
          close(o);
        }
      }
    }
  });

  await check('V2 inside Telegram: Accept (after mount) posts once to /api/pair/accept?user_id=<the Telegram id> with { token, initData }, is disabled and says "Pairing..." while it works (a second tap sends nothing); each of the 8 error codes shows its own message in an error notice (an alert) with Accept still there; an unknown code and a failed request (reported with captureError) say "could not accept"; ALREADY_PAIRED_TOGETHER is information (a status notice), with no Accept; success shows the card with the inviter\'s name and Close, which closes the Mini App', async () => {
    const CODES: [string, string][] = [
      ['INVITE_NOT_FOUND', 'errors.notFound'],
      ['INVITE_EXPIRED', 'errors.expired'],
      ['INVITE_ALREADY_USED', 'errors.alreadyUsed'],
      ['INVITE_REVOKED', 'errors.revoked'],
      ['CANNOT_ACCEPT_OWN_INVITE', 'errors.ownInvite'],
      ['INVITER_ALREADY_PAIRED', 'errors.inviterAlreadyPaired'],
      ['INVITEE_ALREADY_PAIRED', 'errors.inviteeAlreadyPaired'],
      ['ALREADY_PAIRED_TOGETHER', 'errors.alreadyPairedTogether'],
    ];
    for (const locale of LOCALES) {
      reset();
      const name = NAMES[locale];
      const o = open(locale, propsOf(locale), { telegram: {} });
      try {
        assert(acceptOf(o.m) && flat(acceptOf(o.m) as FakeElement) === word(locale, 'accept') && classes(acceptOf(o.m) as FakeElement).includes('ch-home-card-action') && anchorsOf(o.m).length === 0, `${locale}: Accept alone`);
        assert(o.calls.includes('ready()') && o.calls.includes('expand()'), `${locale}: ready and expand: ${show(o.calls)}`);
        assert(!page(o.m).includes(word(locale, 'notInApp')), `${locale}: the browser text in Telegram`);
        // A hanging request: disabled, said, one request
        let release: (r: Response) => void = () => undefined;
        world.accept = () => new Promise<Response>((resolve) => void (release = resolve));
        o.m.click(acceptOf(o.m) as FakeElement);
        o.m.click(acceptOf(o.m) as FakeElement);
        await settle();
        const working = acceptOf(o.m) as FakeElement;
        assert(requestCount() === 1 && working.hasAttribute('disabled') && flat(working) === word(locale, 'accepting') && working.getAttribute('aria-busy') === 'true', `${locale}: working: ${requestCount()} request(s), ${flat(working)}`);
        const call = fetchCalls[0];
        assert(call.url === `/api/pair/accept?user_id=${TG_ID}` && call.init.method === 'POST' && new Headers(call.init.headers).get('content-type') === 'application/json', `${locale}: the request: ${call.url}`);
        assert(show(JSON.parse(String(call.init.body))) === show({ token: TOKEN, initData: (o.tg as Row).initData }), `${locale}: the body: ${String(call.init.body)}`);
        // Each code
        for (const [code, key] of CODES) {
          await act(async () => {
            release(json({ success: false, error: code }, 400));
            await new Promise((r) => setTimeout(r, 0));
          });
          await settle();
          const notices = noticesOf(o.m);
          const together = code === 'ALREADY_PAIRED_TOGETHER';
          assert(notices.length === 1 && flat(notices[0]) === word(locale, key), `${locale} ${code}: the notice: ${show(notices.map(flat))}`);
          if (together) {
            // Information: a status, not an alert and not the error colour; and nothing to accept
            assert(notices[0].getAttribute('role') === 'status' && !classes(notices[0]).includes('ch-notice-error') && byRole(o.m.container, 'alert').length === 0, `${locale}: together is an error`);
            assert(!acceptOf(o.m) && buttonsOf(o.m).length === 0 && anchorsOf(o.m).length === 0, `${locale}: Accept shows after "paired together"`);
          } else {
            assert(notices[0].getAttribute('role') === 'alert' && classes(notices[0]).includes('ch-notice-error'), `${locale} ${code}: not an error notice`);
            assert(!!acceptOf(o.m) && !acceptOf(o.m)?.hasAttribute('disabled') && flat(acceptOf(o.m) as FakeElement) === word(locale, 'accept'), `${locale} ${code}: Accept is not usable again`);
            world.accept = () => new Promise<Response>((resolve) => void (release = resolve));
            o.m.click(acceptOf(o.m) as FakeElement);
            await settle();
          }
        }
        assert(requestCount() === 8, `${locale}: ${requestCount()} requests for 8 codes`);
        assert(capturedCount() === 0, `${locale}: a refusal was reported: ${show(captured.map((c) => c.context))}`);
      } finally {
        close(o);
      }
      // An unknown code, then a request that fails outright
      reset();
      const failing = open(locale, propsOf(locale), { telegram: {} });
      try {
        world.accept = () => json({ success: false, error: 'SOMETHING_NEW' }, 400);
        failing.m.click(acceptOf(failing.m) as FakeElement);
        await settle();
        assert(show(noticesOf(failing.m).map(flat)) === show([word(locale, 'errorGeneric')]) && byRole(failing.m.container, 'alert').length === 1, `${locale}: an unknown code: ${show(noticesOf(failing.m).map(flat))}`);
        world.accept = () => {
          throw new TypeError('Failed to fetch');
        };
        failing.m.click(acceptOf(failing.m) as FakeElement);
        await settle();
        assert(show(noticesOf(failing.m).map(flat)) === show([word(locale, 'errorGeneric')]) && capturedCount() === 1 && captured[0].context === 'invite-accept' && String(captured[0].error).includes('Failed to fetch') && captured[0].severity === 'warning', `${locale}: a failed request: ${show(noticesOf(failing.m).map(flat))}, ${show(captured.map((c) => [c.context, String(c.error)]))}`);
        // And a success after all, which takes the notice away
        world.accept = () => json({ success: true });
        failing.m.click(acceptOf(failing.m) as FakeElement);
        await settle();
        assert(noticesOf(failing.m).length === 0 && !buttonsOf(failing.m).some((b) => flat(b) === word(locale, 'accept')), `${locale}: the notice or Accept after success`);
        const card = elements(failing.m.container).find((e) => classes(e).includes('ch-home-card'));
        assert(card && card.getAttribute('role') === 'status' && flat(card).startsWith(word(locale, 'success', 'invite', { name })) && !/\p{Extended_Pictographic}/u.test(flat(card)), `${locale}: the success card: ${card && flat(card)}`);
        const closeButton = buttonsOf(failing.m).find((b) => flat(b) === word(locale, 'closeApp'));
        assert(buttonsOf(failing.m).length === 1 && closeButton, `${locale}: the Close button`);
        failing.calls.length = 0;
        failing.m.click(closeButton);
        assert(show(failing.calls.filter((c) => c.startsWith('close'))) === show(['close()']), `${locale}: Close: ${show(failing.calls)}`);
      } finally {
        close(failing);
      }
    }
  });

  await check('V3 in a browser (the SDK with no launch data, or no SDK): no Accept and no request; "open it in Telegram", then Open in Telegram (the filled button) and Open in WhatsApp (the quiet one) with the exact links, in that order; each is hidden when its link is empty; with no link at all the text stands alone', async () => {
    for (const locale of LOCALES) {
      for (const options of [{}, { sdkOnly: true }] as OpenOptions[]) {
        reset();
        const o = open(locale, propsOf(locale), options);
        try {
          await settle();
          const where = `${locale} ${show(options)}`;
          assert(!acceptOf(o.m) && buttonsOf(o.m).length === 0 && requestCount() === 0, `${where}: Accept or a request in a browser`);
          const anchors = anchorsOf(o.m);
          assert(show(anchors.map((a) => [a.getAttribute('href'), flat(a), a.className])) === show([[TG_LINK, word(locale, 'openTg'), 'ch-btn ch-btn-primary ch-home-card-action'], [WA_LINK, word(locale, 'openWa'), 'ch-btn ch-home-card-action']]), `${where}: the links: ${show(anchors.map((a) => [a.getAttribute('href'), flat(a), a.className]))}`);
          assert(page(o.m).includes(word(locale, 'notInApp')) && noticesOf(o.m).length === 0, `${where}: the text`);
          assert(!o.calls.includes('ready()') && !o.calls.includes('expand()'), `${where}: ready() or expand() with no launch`);
        } finally {
          close(o);
        }
      }
    }
    for (const [tgLink, waLink, want] of [['', WA_LINK, [WA_LINK]], [TG_LINK, '', [TG_LINK]], ['', '', []]] as const) {
      reset();
      const o = open('en', propsOf('en', { tgDeepLink: tgLink, waDeepLink: waLink }));
      try {
        assert(show(anchorsOf(o.m).map((a) => a.getAttribute('href'))) === show(want), `links ${show([tgLink, waLink])}: ${show(anchorsOf(o.m).map((a) => a.getAttribute('href')))}`);
        assert(page(o.m).includes(word('en', 'notInApp')) && requestCount() === 0 && buttonsOf(o.m).length === 0, `links ${show([tgLink, waLink])}: the text, a request or a button`);
      } finally {
        close(o);
      }
    }
  });

  await check('V4 the server page: an invalid token is the app\'s crash card (an alert, the h1, a link to /<locale> in the card\'s button) in en, he and ru, inside the same capped, centred wrapper as the valid card (with the CSS that caps it), with no Tailwind, no emoji and no gradient; a valid one hands InviteClient the inviter (name, then English name, then "Someone"), the token, the page\'s language, the Telegram and WhatsApp deep links built as always, and the expiry as an ISO string', async () => {
    for (const locale of LOCALES) {
      inviteFor = () => null;
      const el = await InvitePage({ params: Promise.resolve({ locale, token: 'bad' }) });
      const html = renderToString(createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, el));
      assert(html.startsWith(`<div class="ch-app ch-screen" data-theme="light" dir="${locale === 'he' ? 'rtl' : 'ltr'}" lang="${locale}">`), `${locale}: the root: ${html.slice(0, 120)}`);
      assert(html.includes('<div class="ch-home-card ch-crash" role="alert">') && html.includes(`<h1 class="ch-home-card-title">${word(locale, 'invalid.title')}</h1>`), `${locale}: the crash card: ${html.slice(html.indexOf('<div class="ch-home-card'), html.indexOf('<div class="ch-home-card') + 200)}`);
      assert(html.includes(`<a class="ch-btn ch-btn-primary ch-home-card-action" href="/${locale}">${word(locale, 'invalid.home')}</a>`), `${locale}: the way home`);
      assert(textOf(html).includes(word(locale, 'invalid.body')), `${locale}: the body`);
      // The same width as the valid card: inside the capped, centred wrapper, with the CSS that caps it rendered beside it
      assert(html.includes('<div class="ch-invite-page"><div class="ch-home-card ch-crash" role="alert">'), `${locale}: the crash card is not inside the invite wrapper`);
      assert(html.includes(INVITE_CSS) && /\.ch-invite-page \{[^}]*max-inline-size:\s*480px/.test(html), `${locale}: the page does not render the invite CSS`);
      assert(!/\p{Extended_Pictographic}/u.test(html) && !/min-h-screen|bg-gradient|rounded-2xl|text-gray|from-rose/.test(html), `${locale}: an emoji or a Tailwind class`);
    }
    const expires = new Date(Date.UTC(2026, 10, 3, 13, 45));
    const valid = async (inviter: Row) => {
      inviteFor = (token) => (token === TOKEN ? { invite: { expiresAt: expires }, inviter } : null);
      return (await InvitePage({ params: Promise.resolve({ locale: 'he', token: TOKEN }) })) as unknown as { type: unknown; props: Row };
    };
    for (const [inviter, name] of [[{ name: 'Dana', englishName: 'Dana E' }, 'Dana'], [{ name: '', englishName: 'Dana E' }, 'Dana E'], [{ name: '', englishName: '' }, word('he', 'someone')]] as const) {
      const el = await valid(inviter);
      assert(el.type === Invite && show(el.props) === show({ token: TOKEN, inviterName: name, locale: 'he', tgDeepLink: TG_LINK, waDeepLink: WA_LINK, expiresAt: expires.toISOString() }), `the props for ${show(inviter)}: ${show(el.props)}`);
    }
    // A real token is 64 hex characters: the Telegram link carries it packed, within Telegram's 64 base64url characters
    {
      const hex = 'a1'.repeat(32);
      inviteFor = (token) => (token === hex ? { invite: { expiresAt: expires }, inviter: { name: 'Dana' } } : null);
      const el = (await InvitePage({ params: Promise.resolve({ locale: 'he', token: hex }) })) as unknown as { props: Row };
      const link = String(el.props.tgDeepLink);
      const param = new URL(link).searchParams.get('start') ?? '';
      const { inviteTokenFromStart } = await import('../src/lib/invite-link');
      assert(link.startsWith('https://t.me/test_bot?start=invite_') && /^[A-Za-z0-9_-]{1,64}$/.test(param), `the Telegram link: ${link} (${param.length})`);
      assert(inviteTokenFromStart(param.slice('invite_'.length)) === hex, `the link does not carry the token back: ${param}`);
      assert(el.props.waDeepLink === `https://wa.me/972500000000?text=accept%20${hex}`, `WhatsApp keeps the token as it is: ${el.props.waDeepLink}`);
    }
    // No bot or number in the environment: the links are empty strings, so the buttons hide
    const [bot, number] = [process.env.TELEGRAM_BOT_USERNAME, process.env.WHATSAPP_PHONE_NUMBER];
    delete process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.WHATSAPP_PHONE_NUMBER;
    try {
      const el = await valid({ name: 'Dana' });
      assert(el.props.tgDeepLink === '' && el.props.waDeepLink === '', `no links: ${show([el.props.tgDeepLink, el.props.waDeepLink])}`);
    } finally {
      process.env.TELEGRAM_BOT_USERNAME = bot;
      process.env.WHATSAPP_PHONE_NUMBER = number;
    }
  });

  await check('V5 the landing is made of the kit: no Tailwind class, emoji or gradient and no mention of Tailwind in InviteClient or the page; the old comments are gone; it logs a failed accept (captureError, no bare catch); its own CSS passes the lint; every key of the invite namespace is read', () => {
    const dir = path.join(ROOT, 'app/[locale]/(app)/invite/[token]');
    const strip = (source: string) => source.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    const sources = Object.fromEntries(['InviteClient.tsx', 'page.tsx'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    for (const [file, source] of Object.entries(sources)) {
      const code = strip(source);
      assert(!/className="[^"]*\b(?:bg-|text-(?:gray|rose|blue|xs|sm|lg|xl|2xl|3xl)|rounded|px-\d|py-\d|min-h-screen|flex-1|shadow|mt-\d|mb-\d|p-\d|gap-\d|max-w|from-|to-)/.test(code), `${file}: a Tailwind class is left`);
      assert(!/\p{Extended_Pictographic}/u.test(source), `${file}: an emoji`);
      assert(!/gradient/i.test(code) && !/tailwind/i.test(source), `${file}: a gradient or a mention of Tailwind`);
    }
    assert(!/from 'next\/link'|<Link\b/.test(sources['page.tsx']), 'the page still uses next/link');
    assert(!/catch\s*\{/.test(sources['InviteClient.tsx']) && sources['InviteClient.tsx'].includes("captureError(error, 'invite-accept'"), 'a bare catch, or the failure is not reported');
    assert(typeof INVITE_CSS === 'string' && INVITE_CSS.length > 0, 'invite-css.ts exports the CSS');
    // The CSS is a plain module both files import: a client file's export would reach the server page as a reference, not the string
    assert(/from '\.\/invite-css'/.test(sources['InviteClient.tsx']) && /from '\.\/invite-css'/.test(sources['page.tsx']) && !/export const INVITE_CSS/.test(sources['InviteClient.tsx']), 'both files import the CSS from ./invite-css');
    assert(!/^\s*['"]use client['"]/m.test(fs.readFileSync(path.join(dir, 'invite-css.ts'), 'utf8')), 'invite-css.ts is a plain module (no "use client" directive)');
    assert(show(lintCss(INVITE_CSS)) === show([]), `lintCss: ${show(lintCss(INVITE_CSS))}`);
    // A button that waits looks it, and the card stays no wider than a phone's on a desktop
    assert(/\.ch-invite-page \.ch-home-card-action:disabled \{[^}]*opacity:\s*0\.6/.test(INVITE_CSS) && /\.ch-invite-page \{[^}]*max-inline-size:\s*480px[^}]*margin-inline:\s*auto/.test(INVITE_CSS), `the CSS: ${INVITE_CSS}`);
    // Nothing the screen says carries an emoji either: the copy does the job of the 🤝, 🎉 and ⌛ that went
    for (const locale of LOCALES) assert(!/\p{Extended_Pictographic}/u.test(JSON.stringify(messages[locale].invite)), `${locale}: an emoji in the invite namespace`);
    const keys = (node: Row, prefix = ''): string[] => Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v as Row, `${prefix}${k}.`) : [`${prefix}${k}`]));
    const all = Object.values(sources).join('\n');
    for (const key of keys(messages.en.invite)) assert(all.includes(`'${key}'`), `invite.${key} is read by nothing`);
  });

  await check('V6 React logged no warning', () => {
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
