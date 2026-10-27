// Smoke test for the Partner screen (plan docs/superpowers/plans/2026-10-27-app-ui-W3-partner-invite.md, Task 1;
// spec 2026-10-19-screens-and-colours §4, §5): PairClient on AppScreen and the form kit, in real React on the small fake
// DOM, with a fake Telegram.WebApp, a router stub and a fake fetch. No network, no DB.
//  - P1 the render in en, he and ru, light (the server's) and dark (Telegram), for a paired user, an unpaired one and
//    one with an invite link: the grouped root, no raw key, no emoji, no English in he and ru, the link field left to right
//    and the dates in 24-hour time;
//  - P2 the link's life: generate posts once and the link shows; generating again replaces it; revoke sends DELETE once and
//    goes back to Generate; INVITER_ALREADY_PAIRED, a 500 and a failed request each say their own thing (and the failure is
//    logged); each button is busy only while its own request runs, and every action is disabled while any request does;
//    the copy button says Copied;
//  - P3 unlinking: the row opens a sheet and window.confirm is never called; Telegram's Back closes the sheet, and does
//    nothing while the unlink works (so do Escape, the scrim and Cancel); a 500 keeps the sheet open with the error; an OK
//    answer shows the not-paired view; the sheet locks Telegram's swipe down while it is open;
//  - P4 the requests are the ones the screen has always sent: the same URLs, methods and the { initData } body;
//  - P5 Back: AppScreen is the only BackButton caller; with no sheet it returns to the calendar, from Telegram's button and
//    from the header's own in a browser;
//  - P6 React logs no warning; P7 the screen is made of the kit: no Tailwind classes, no emoji, no window.confirm.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-pair-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-pair-render.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { byRole, elements, fakeTelegram, fakeWindow, installWindow, mount, FakeElement, FakeText, type FakeNode, type Mounted, type Row } from './lib/fake-dom';

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

// ---- React must not warn; what the screen itself logs is kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[pair]') || text.startsWith('[copy]')) return void appLogs.push(text);
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: a router, a fetch, window.confirm and the clipboard ----

const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const pushes: string[] = [];
const router = { push: (href: string) => void pushes.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined };

interface FetchCall {
  url: string;
  init: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const newLink = (n: number) => ({ success: true, token: `tok-${n}`, url: `https://famcal.bot/en/invite/tok-${n}`, expiresAt: local(2026, 11, 10, 9, 5) });
let created = 0;
const world = {
  create: (): Response | Promise<Response> => json(newLink(++created)),
  revoke: (): Response | Promise<Response> => json({ success: true }),
  unlink: (): Response | Promise<Response> => json({ success: true, partnerUserId: 2 }),
};
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url === '/api/pair/invite?user_id=1' && init.method === 'POST') return world.create();
  if (url === '/api/pair/invite?user_id=1' && init.method === 'DELETE') return world.revoke();
  if (url === '/api/pair?user_id=1' && init.method === 'DELETE') return world.unlink();
  throw new Error(`an unexpected request: ${init.method} ${url}`);
}) as typeof fetch;
const requests = (method: string, prefix: string) => fetchCalls.filter((c) => c.init.method === method && c.url.startsWith(prefix));
const creates = () => requests('POST', '/api/pair/invite');
const revokes = () => requests('DELETE', '/api/pair/invite');
const unlinks = () => requests('DELETE', '/api/pair?');
const requestCount = () => fetchCalls.length;

let confirms = 0;
(globalThis as Row).confirm = () => {
  confirms++;
  return true;
};
(fakeWindow as Row).confirm = (globalThis as Row).confirm;

const reset = () => {
  pushes.length = 0;
  fetchCalls.length = 0;
  appLogs.length = 0;
  confirms = 0;
  created = 0;
  world.create = () => json(newLink(++created));
  world.revoke = () => json({ success: true });
  world.unlink = () => json({ success: true, partnerUserId: 2 });
};

// ---- Fixtures: the instants are local ones, so "15:45" is 15:45 under any clock ----

function local(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}
type State = 'paired' | 'notPaired' | 'withLink';
const NAMES: Record<Locale, string> = { en: 'Dana', he: 'דנה', ru: 'Дана' };
const propsOf = (locale: Locale, state: State): Row => ({
  userId: 1,
  locale,
  initial: {
    partner: state === 'paired' ? { name: NAMES[locale], acceptedAt: local(2026, 10, 3, 15, 45) } : null,
    invite: state === 'withLink' ? { token: 'tok-0', url: `https://famcal.bot/${locale}/invite/tok-0`, expiresAt: local(2026, 11, 3, 15, 45) } : null,
  },
});

let Pair: (props: Row) => ReactElement;
function tree(locale: Locale, props: Row): ReactElement {
  const intl = createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(Pair, props));
  return createElement(AppRouterContext.Provider, { value: router }, intl);
}
/** What the strings of a language say, by the key of its pair namespace ('unlinkTitle'). */
const word = (locale: Locale, key: string, ns = 'pair', args: Row = {}): string => {
  const value = `${ns}.${key}`.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], messages[locale]);
  if (typeof value !== 'string') throw new Error(`no message ${ns}.${key} in ${locale}`);
  return Object.entries(args).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), value);
};

// ---- Reading what is on the page ----

/** What a reader sees: style sheets, tags and React's separators out, entities decoded, spaces collapsed. */
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
const page = (m: Mounted) => flat(m.container);
const classes = (e: FakeElement) => e.className.split(' ');
const buttonsOf = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'button');
const dialogs = (m: Mounted) => byRole(m.container, 'dialog');
const alertsIn = (node: FakeNode) => byRole(node, 'alert').map(flat);
/** The generate button, the revoke row and the unlink row. */
const generateOf = (m: Mounted, locale: Locale = 'en') => buttonsOf(m).find((b) => [word(locale, 'generateInvite'), word(locale, 'creating')].includes(flat(b)));
const revokeOf = (m: Mounted, locale: Locale = 'en') => buttonsOf(m).find((b) => classes(b).includes('ch-danger-row') && flat(b) === word(locale, 'revoke'));
const unlinkRowOf = (m: Mounted, locale: Locale = 'en') => buttonsOf(m).find((b) => classes(b).includes('ch-danger-row') && flat(b) === word(locale, 'unlink'));
const linkInput = (m: Mounted) => elements(m.container).find((e) => e.localName === 'input');
const inSheet = (m: Mounted, predicate: (e: FakeElement) => boolean) => {
  const dialog = dialogs(m)[0];
  return dialog ? elements(dialog).find(predicate) : undefined;
};
const confirmOf = (m: Mounted) => inSheet(m, (e) => e.localName === 'button' && classes(e).includes('ch-btn-danger'));
const cancelOf = (m: Mounted) => inSheet(m, (e) => e.localName === 'button' && classes(e).includes('ch-sheet-close'));
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** Mount in a browser (no Telegram) or in Telegram `version`; the caller closes it. */
function open(locale: Locale, props: Row, telegram?: { version: string; scheme?: 'light' | 'dark' }) {
  installWindow();
  const calls: string[] = [];
  const tg = telegram ? fakeTelegram(calls, telegram.version) : null;
  if (tg && telegram?.scheme) tg.colorScheme = telegram.scheme;
  fakeWindow.Telegram = tg ? { WebApp: tg } : undefined;
  const m = mount(tree(locale, props));
  return { m, tg, calls };
}
const close = (opened: ReturnType<typeof open>) => {
  opened.m.unmount();
  fakeWindow.Telegram = undefined;
};

async function main() {
  Pair = (await import('../app/[locale]/pair/PairClient')).default as unknown as (props: Row) => ReactElement;

  await check('P1 render in en, he and ru, light (server) and dark (Telegram), paired / not paired / with a link: a grouped AppScreen root with its direction and language and the page title, no raw key, no emoji, no English in he and ru, the link field left to right, the dates in 24-hour time (15:45, never PM), and the right rows for the state', async () => {
    for (const locale of LOCALES) {
      const dir = locale === 'he' ? 'rtl' : 'ltr';
      const name = NAMES[locale];
      const root = `<div class="ch-app ch-screen ch-grouped" data-theme="light" dir="${dir}" lang="${locale}">`;
      for (const state of ['paired', 'notPaired', 'withLink'] as State[]) {
        const html = renderToString(tree(locale, propsOf(locale, state)));
        const text = textOf(html);
        const where = `${locale} ${state}`;
        assert(html.startsWith(root), `${where}: the root: ${html.slice(0, 140)}`);
        assert(html.includes(`<h1 class="ch-screen-title">${word(locale, 'title')}</h1>`), `${where}: the title`);
        assert(!/\b(?:pair|ui)\.[a-zA-Z]/.test(text), `${where}: a raw key in ${text}`);
        assert(!/\p{Extended_Pictographic}/u.test(html), `${where}: an emoji`);
        if (locale !== 'en') assert(!/[A-Za-z]/.test(text.replace(/Telegram|WhatsApp|Google|FamCal/g, '')), `${where}: Latin letters in ${text}`);
        assert(!/\b[AP]\.?M\b/i.test(text), `${where}: a 12-hour time in ${text}`);
        if (state === 'paired') {
          assert(text.includes(word(locale, 'pairedWith', 'pair', { name })) && text.includes(word(locale, 'unlink')), `${where}: the partner and the unlink row: ${text}`);
          const since = { en: '3 Oct 2026', he: '3 באוק׳ 2026', ru: '3 окт. 2026' }[locale];
          assert(text.includes(word(locale, 'pairedSince', 'pair', { when: since })), `${where}: the since line (${since}) in ${text}`);
          assert(!text.includes(word(locale, 'generateInvite')) && !html.includes('<input'), `${where}: the invite parts show for a paired user`);
          assert(!html.includes('role="dialog"'), `${where}: the sheet shows before it is asked for`);
        } else {
          assert(text.includes(word(locale, 'notPairedSubtitle')) && text.includes(word(locale, 'generateInvite')), `${where}: the intro and the generate button`);
          assert(!text.includes(word(locale, 'unlink')), `${where}: unlink shows for an unpaired user`);
        }
        if (state === 'withLink') {
          const input = /<input[^>]*class="ch-copy-field-input"[^>]*>/.exec(html)?.[0] ?? '';
          assert(input.includes('dir="ltr"') && /readonly=""/i.test(input) && input.includes(`value="https://famcal.bot/${locale}/invite/tok-0"`) && input.includes(`aria-label="${word(locale, 'linkLabel')}"`), `${where}: the link field: ${input}`);
          assert(html.includes(`aria-label="${word(locale, 'copyLink')}"`) && text.includes(word(locale, 'linkLabel')) && text.includes(word(locale, 'activeLink')) && text.includes(word(locale, 'revoke')), `${where}: the link's parts: ${text}`);
          // 24-hour: the fixture's 15:45, on the 3rd of November
          const when = /(?:Expires|תוקף עד|Действует до) (.+?)(?= (?:Revoke|ביטול|Отозвать))/.exec(text)?.[1] ?? '';
          assert(/(?:^|\D)15:45$/.test(when) && when.includes('3'), `${where}: the expiry reads ${show(when)}`);
          if (locale === 'en') assert(/^\w{3} 3 Nov, 15:45$/.test(when), `en: the expiry reads ${show(when)}`);
          assert(!text.includes(word(locale, 'creating')), `${where}: busy text`);
        } else {
          assert(!html.includes('<input'), `${where}: a link field with no link`);
        }
      }
      // Dark, as Telegram says it: the same root with its scheme; a light Telegram theme paints the header with the ground the cards sit on
      for (const scheme of ['dark', 'light'] as const) {
        const opened = open(locale, propsOf(locale, 'withLink'), { version: '7.7', scheme });
        try {
          const rootEl = elements(opened.m.container).find((e) => e.className === 'ch-app ch-screen ch-grouped');
          assert(rootEl && rootEl.getAttribute('data-theme') === scheme && rootEl.getAttribute('dir') === dir && rootEl.getAttribute('lang') === locale, `${locale} ${scheme}: the root`);
          const colour = scheme === 'dark' ? 'bg_color' : 'secondary_bg_color';
          assert(opened.calls.includes(`setHeaderColor(${colour})`) && opened.calls.includes(`setBackgroundColor(${colour})`) && !opened.calls.some((c) => /^set(?:Header|Background)Color\(#/.test(c)), `${locale} ${scheme}: ${show(opened.calls.filter((c) => /Color/.test(c)))}`);
          const input = linkInput(opened.m);
          assert(input?.getAttribute('dir') === 'ltr', `${locale} ${scheme}: the link field is left to right`);
        } finally {
          close(opened);
        }
      }
    }
  });

  await check('P2 the link\'s life, in en: generate posts once and the link shows; generate again replaces it; revoke sends DELETE once and goes back to Generate; INVITER_ALREADY_PAIRED says it is already paired; a 500 and a request that fails outright say "Something went wrong" (the second is logged) and the next success clears them; each button is busy only while its own request runs and every action is disabled meanwhile; the copy button says Copied', async () => {
    reset();
    const o = open('en', propsOf('en', 'notPaired'));
    const w = (key: string, args?: Row) => word('en', key, 'pair', args);
    try {
      assert(!linkInput(o.m) && generateOf(o.m) && !revokeOf(o.m), 'before: Generate alone');
      o.m.click(generateOf(o.m) as FakeElement);
      await settle();
      assert(creates().length === 1 && linkInput(o.m)?.value === 'https://famcal.bot/en/invite/tok-1', `generated: ${creates().length} request(s), ${linkInput(o.m)?.value}`);
      assert(page(o.m).includes(w('linkLabel')) && !!revokeOf(o.m), 'the link, its label and the revoke row show');
      // Generating again: the new link replaces the old one (the server revoked it)
      o.m.click(generateOf(o.m) as FakeElement);
      await settle();
      assert(creates().length === 2 && elements(o.m.container).filter((e) => e.localName === 'input').length === 1 && linkInput(o.m)?.value === 'https://famcal.bot/en/invite/tok-2', `replaced: ${creates().length} request(s), ${linkInput(o.m)?.value}`);
      // The copy button
      const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      const written: string[] = [];
      Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text: string) => void written.push(text) } }, configurable: true });
      try {
        const copy = buttonsOf(o.m).find((b) => b.getAttribute('aria-label') === w('copyLink'));
        assert(copy, 'the copy button');
        await act(async () => {
          o.m.click(copy);
          for (let i = 0; i < 4; i++) await Promise.resolve();
        });
        assert(show(written) === show(['https://famcal.bot/en/invite/tok-2']) && elements(o.m.container).some((e) => e.getAttribute('role') === 'status' && flat(e) === w('copied')), `copied: ${show(written)}`);
      } finally {
        if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
      }
      // Revoke: one DELETE, back to Generate
      o.m.click(revokeOf(o.m) as FakeElement);
      await settle();
      assert(revokes().length === 1 && !linkInput(o.m) && !revokeOf(o.m) && !!generateOf(o.m), `revoked: ${revokes().length} request(s)`);
      // INVITER_ALREADY_PAIRED, a 500, a request that fails outright
      world.create = () => json({ success: false, error: 'INVITER_ALREADY_PAIRED' }, 400);
      o.m.click(generateOf(o.m) as FakeElement);
      await settle();
      assert(show(alertsIn(o.m.container)) === show([w('errorAlreadyPaired')]), `already paired: ${show(alertsIn(o.m.container))}`);
      world.create = () => json({ error: 'Failed to create invite' }, 500);
      o.m.click(generateOf(o.m) as FakeElement);
      await settle();
      assert(show(alertsIn(o.m.container)) === show([w('errorGeneric')]), `a 500: ${show(alertsIn(o.m.container))}`);
      appLogs.length = 0;
      world.create = () => {
        throw new TypeError('Failed to fetch');
      };
      o.m.click(generateOf(o.m) as FakeElement);
      await settle();
      assert(show(alertsIn(o.m.container)) === show([w('errorGeneric')]) && appLogs.some((l) => l.startsWith('[pair]') && l.includes('Failed to fetch')), `a failed request: ${show(alertsIn(o.m.container))}, ${show(appLogs)}`);
      assert(!!generateOf(o.m) && !generateOf(o.m)?.hasAttribute('disabled'), 'the button is usable again after a failure');
      world.create = () => json(newLink(++created));
      o.m.click(generateOf(o.m) as FakeElement);
      await settle();
      assert(alertsIn(o.m.container).length === 0 && !!linkInput(o.m), `a success clears the error: ${show(alertsIn(o.m.container))}`);
      // Busy: generate works, and only it is busy; the revoke row is disabled but not busy; a second tap sends nothing
      let release: (r: Response) => void = () => undefined;
      world.create = () => new Promise<Response>((resolve) => void (release = resolve));
      const before = creates().length;
      o.m.click(generateOf(o.m) as FakeElement);
      o.m.click(generateOf(o.m) as FakeElement);
      await settle();
      assert(creates().length === before + 1, `two taps, ${creates().length - before} request(s)`);
      const generate = generateOf(o.m);
      assert(generate?.hasAttribute('disabled') && generate.getAttribute('aria-busy') === 'true' && flat(generate) === w('creating'), `generate while it works: ${generate && flat(generate)}`);
      assert(revokeOf(o.m)?.hasAttribute('disabled') && !revokeOf(o.m)?.hasAttribute('aria-busy'), 'revoke is disabled, not busy, while generate works');
      o.m.click(revokeOf(o.m) as FakeElement);
      await settle();
      assert(revokes().length === 1, `a tap on a disabled revoke sent a request: ${revokes().length}`);
      await act(async () => {
        release(json(newLink(++created)));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert(!generateOf(o.m)?.hasAttribute('disabled') && !revokeOf(o.m)?.hasAttribute('disabled'), 'both are usable again');
      // Revoke while it works: it is the busy one, and Generate is disabled
      world.revoke = () => new Promise<Response>((resolve) => void (release = resolve));
      o.m.click(revokeOf(o.m) as FakeElement);
      await settle();
      assert(revokeOf(o.m)?.getAttribute('aria-busy') === 'true' && revokeOf(o.m)?.hasAttribute('disabled') && generateOf(o.m)?.hasAttribute('disabled') && !generateOf(o.m)?.hasAttribute('aria-busy'), 'revoke is the busy one, generate disabled');
      await act(async () => {
        release(json({ success: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert(!linkInput(o.m) && !generateOf(o.m)?.hasAttribute('disabled'), 'revoked after the wait');
    } finally {
      close(o);
    }
    // A revoke that fails keeps the link and says so
    reset();
    const failed = open('en', propsOf('en', 'withLink'));
    try {
      world.revoke = () => json({ error: 'x' }, 500);
      failed.m.click(revokeOf(failed.m) as FakeElement);
      await settle();
      assert(!!linkInput(failed.m) && show(alertsIn(failed.m.container)) === show([word('en', 'errorGeneric')]), `a failed revoke: ${show(alertsIn(failed.m.container))}`);
    } finally {
      close(failed);
    }
  });

  await check('P3 unlinking, in en, he and ru: the row opens a sheet named for the partner, and window.confirm is never called; Telegram\'s Back closes the sheet and nothing else; while the unlink works Back, Escape, the scrim and Cancel do nothing and a second tap sends nothing; a 500 or a failed request keeps the sheet open with the error in it (not behind it); an OK answer closes the sheet and shows the not-paired view; the open sheet locks the swipe down', async () => {
    for (const locale of LOCALES) {
      reset();
      const name = NAMES[locale];
      const w = (key: string, args?: Row) => word(locale, key, 'pair', args);
      const o = open(locale, propsOf(locale, 'paired'), { version: '7.7' });
      const back = () => act(() => void (o.tg as Row).backHandlers[0]());
      const swipes = () => o.calls.filter((c) => /VerticalSwipes/.test(c)).at(-1);
      try {
        assert(dialogs(o.m).length === 0 && swipes() === 'enableVerticalSwipes()', `${locale}: no sheet at the start, swipes ${swipes()}`);
        o.m.click(unlinkRowOf(o.m, locale) as FakeElement);
        const sheet = dialogs(o.m)[0];
        assert(sheet && sheet.getAttribute('aria-label') === w('unlinkTitle', { name }), `${locale}: the sheet's name: ${sheet?.getAttribute('aria-label')}`);
        assert(flat(sheet).includes(w('unlinkBody')) && flat(sheet).includes(w('unlinkTitle', { name })) && flat(confirmOf(o.m) as FakeElement) === w('unlink') && flat(cancelOf(o.m) as FakeElement) === word(locale, 'cancel', 'ui'), `${locale}: the sheet's text: ${flat(sheet)}`);
        const heading = inSheet(o.m, (e) => e.localName === 'h2');
        assert(heading && classes(heading).includes('ch-sheet-heading') && flat(heading) === w('unlinkTitle', { name }), `${locale}: the heading`);
        assert(confirms === 0 && unlinks().length === 0, `${locale}: window.confirm was called (${confirms}) or a request went out`);
        assert(swipes() === 'disableVerticalSwipes()', `${locale}: the open sheet locks the swipe, last call ${swipes()}`);
        // Back closes only the sheet
        back();
        assert(dialogs(o.m).length === 0 && pushes.length === 0 && swipes() === 'enableVerticalSwipes()', `${locale}: Back with the sheet open: ${dialogs(o.m).length} dialog(s), pushes ${show(pushes)}, swipes ${swipes()}`);
        // Cancel closes it too; the sheet comes back clean
        o.m.click(unlinkRowOf(o.m, locale) as FakeElement);
        o.m.click(cancelOf(o.m) as FakeElement);
        assert(dialogs(o.m).length === 0, `${locale}: Cancel closes the sheet`);
        // The unlink works: nothing closes it, a second tap sends nothing
        let release: (r: Response) => void = () => undefined;
        world.unlink = () => new Promise<Response>((resolve) => void (release = resolve));
        o.m.click(unlinkRowOf(o.m, locale) as FakeElement);
        o.m.click(confirmOf(o.m) as FakeElement);
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(unlinks().length === 1, `${locale}: ${unlinks().length} request(s) for two taps`);
        const working = confirmOf(o.m);
        assert(working && working.hasAttribute('disabled') && working.getAttribute('aria-busy') === 'true' && flat(working) === w('unlinking') && cancelOf(o.m)?.hasAttribute('disabled'), `${locale}: the working sheet: ${working && flat(working)}`);
        back();
        o.m.key(dialogs(o.m)[0], 'Escape');
        const scrim = elements(o.m.container).find((e) => e.className === 'ch-sheet-backdrop');
        o.m.click(scrim as FakeElement);
        o.m.click(cancelOf(o.m) as FakeElement);
        assert(dialogs(o.m).length === 1 && pushes.length === 0, `${locale}: the sheet closed while it works (${dialogs(o.m).length} dialog(s), pushes ${show(pushes)})`);
        // A 500: the sheet stays open and holds the error
        await act(async () => {
          release(json({ error: 'Failed to unlink' }, 500));
          await new Promise((r) => setTimeout(r, 0));
        });
        assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('errorGeneric')]) && alertsIn(o.m.container).length === 1, `${locale}: a 500: ${show(alertsIn(o.m.container))}`);
        assert(!confirmOf(o.m)?.hasAttribute('disabled') && !cancelOf(o.m)?.hasAttribute('disabled') && flat(confirmOf(o.m) as FakeElement) === w('unlink'), `${locale}: the sheet is usable again`);
        // A request that fails outright: logged, same error
        appLogs.length = 0;
        world.unlink = () => {
          throw new TypeError('Failed to fetch');
        };
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('errorGeneric')]) && appLogs.some((l) => l.startsWith('[pair]') && l.includes('Failed to fetch')), `${locale}: a failed request: ${show(appLogs)}`);
        // Closing and opening again forgets the error
        o.m.click(cancelOf(o.m) as FakeElement);
        o.m.click(unlinkRowOf(o.m, locale) as FakeElement);
        assert(alertsIn(o.m.container).length === 0, `${locale}: the old error is still there`);
        // OK: the sheet closes and the not-paired view shows
        world.unlink = () => json({ success: true, partnerUserId: 2 });
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(dialogs(o.m).length === 0 && swipes() === 'enableVerticalSwipes()', `${locale}: the sheet is still open after OK`);
        const now = page(o.m);
        assert(now.includes(w('notPairedSubtitle')) && !!generateOf(o.m, locale) && !now.includes(name) && !unlinkRowOf(o.m, locale), `${locale}: the not-paired view: ${now}`);
        assert(confirms === 0, `${locale}: window.confirm was called`);
        assert(unlinks().length === 3, `${locale}: ${unlinks().length} unlink requests`);
      } finally {
        close(o);
      }
    }
  });

  await check('P4 the requests are the ones the screen has always sent: POST and DELETE /api/pair/invite?user_id=1 and DELETE /api/pair?user_id=1, a JSON body that is exactly { initData } (the Telegram launch data, read with readInitData; empty in a browser), and the JSON content type', async () => {
    reset();
    const opened = open('en', propsOf('en', 'notPaired'), { version: '7.7' });
    try {
      const initData = (opened.tg as Row).initData as string;
      assert(initData.length > 10, 'the fake launch data');
      opened.m.click(generateOf(opened.m) as FakeElement);
      await settle();
      opened.m.click(revokeOf(opened.m) as FakeElement);
      await settle();
      assert(requestCount() === 2, `${requestCount()} requests`);
      for (const [call, method, url] of [[fetchCalls[0], 'POST', '/api/pair/invite?user_id=1'], [fetchCalls[1], 'DELETE', '/api/pair/invite?user_id=1']] as const) {
        assert(call.url === url && call.init.method === method && new Headers(call.init.headers).get('content-type') === 'application/json', `${method} ${url}: ${call.url} ${call.init.method}`);
        assert(show(JSON.parse(String(call.init.body))) === show({ initData }), `${method} ${url}: the body ${String(call.init.body)}`);
      }
    } finally {
      close(opened);
    }
    reset();
    const paired = open('en', propsOf('en', 'paired'), { version: '7.7' });
    try {
      paired.m.click(unlinkRowOf(paired.m) as FakeElement);
      paired.m.click(confirmOf(paired.m) as FakeElement);
      await settle();
      const call = fetchCalls[0];
      assert(requestCount() === 1 && call.url === '/api/pair?user_id=1' && call.init.method === 'DELETE' && new Headers(call.init.headers).get('content-type') === 'application/json', `the unlink: ${call?.url} ${call?.init.method}`);
      assert(show(JSON.parse(String(call.init.body))) === show({ initData: (paired.tg as Row).initData }), `the unlink body: ${String(call.init.body)}`);
    } finally {
      close(paired);
    }
    // In a browser the body carries an empty initData (the session cookie is the credential)
    reset();
    const browser = open('en', propsOf('en', 'notPaired'));
    try {
      browser.m.click(generateOf(browser.m) as FakeElement);
      await settle();
      assert(show(JSON.parse(String(fetchCalls[0].init.body))) === show({ initData: '' }), `a browser's body: ${String(fetchCalls[0].init.body)}`);
    } finally {
      close(browser);
    }
  });

  await check("P5 Back: AppScreen is the only BackButton caller on the Partner screen; Telegram's Back (and the header's own back in a browser) returns to the calendar in the page's language with no sheet open, and closes the sheet first when there is one", async () => {
    const code = fs.readFileSync(path.join(ROOT, 'app/[locale]/pair/PairClient.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/useTelegramBackButton\(/.test(code), 'PairClient calls useTelegramBackButton');
    for (const locale of LOCALES) {
      reset();
      const o = open(locale, { ...propsOf(locale, 'paired') }, { version: '7.7' });
      try {
        assert((o.tg as Row).backHandlers.length === 1, `${locale}: ${(o.tg as Row).backHandlers.length} BackButton handler(s)`);
        assert(o.calls.includes('BackButton.show()'), `${locale}: the BackButton shows`);
        assert(!buttonsOf(o.m).some((b) => b.getAttribute('aria-label') === word(locale, 'back', 'ui')), `${locale}: an in-page back inside Telegram 7.7`);
        act(() => void (o.tg as Row).backHandlers[0]());
        assert(show(pushes) === show([`/${locale}/dashboard?user_id=1`]), `${locale}: Back with no sheet: ${show(pushes)}`);
      } finally {
        close(o);
      }
    }
    reset();
    const browser = open('he', propsOf('he', 'paired'));
    try {
      const back = buttonsOf(browser.m).filter((b) => b.getAttribute('aria-label') === word('he', 'back', 'ui'));
      assert(back.length === 1, `the header's own back: ${back.length}`);
      browser.m.click(unlinkRowOf(browser.m, 'he') as FakeElement);
      browser.m.click(back[0]);
      assert(dialogs(browser.m).length === 0 && pushes.length === 0, 'the header back closes the sheet first');
      browser.m.click(back[0]);
      assert(show(pushes) === show(['/he/dashboard?user_id=1']), `its tap with no sheet: ${show(pushes)}`);
    } finally {
      close(browser);
    }
  });

  await check('P7 the screen is made of the kit: no Tailwind class, no emoji and no window.confirm in its source, the invite link reads through readInitData, and it brings the form kit\'s style sheet', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/[locale]/pair/PairClient.tsx'), 'utf8');
    const code = source.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/className="[^"]*\b(?:bg-|text-(?:gray|rose|blue|xs|sm|lg|xl|2xl|3xl)|rounded|px-\d|py-\d|min-h-screen|flex-1|shadow|mt-\d|mb-\d|p-\d|gap-\d|max-w)/.test(code), 'a Tailwind class is left');
    assert(!/\p{Extended_Pictographic}/u.test(source), 'an emoji in the source');
    assert(!/(?<![\w.])(?:window\.)?confirm\(/.test(code), 'PairClient calls confirm()');
    assert(/function getInitData\(\)[^{]*\{\s*return readInitData\(\);\s*\}/.test(code), 'getInitData is readInitData');
    assert(/<style>\{FORM_CSS\}<\/style>/.test(code) && /<AppScreen ground="grouped"/.test(code), 'the grouped AppScreen and the form kit\'s style sheet');
  });

  await check('P6 React logged no warning', () => {
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
