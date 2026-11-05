// Smoke test for Settings' "Sign in on the web" group (plan 6b Task 9; spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md
// §4, §2.9, §2.13, §2.17): app/[locale]/(app)/settings/SignInMethods.tsx and its requests (signin-methods-client.ts), in
// real React on the small fake DOM with a fake Telegram.WebApp and a scripted fetch, over the real messages; and the kit's
// TextField kinds. No network, no DB.
//  - U1 loading (the server's render): the section label, a spinner and the loading line, in en, he and ru
//  - U2 the rows: Telegram on for a Telegram account (when Telegram sign-in is configured); Google's address, the calendar's account before its first use, or
//    Add Google; the email's address or Add email; nothing to add for a way that isn't configured; Sign out only on a web
//    session, Sign out on all devices always
//  - U3 the read: GET /api/signin-methods?user_id= with the initData header inside Telegram (never in the URL) and the
//    cookie outside it; a failure says so with Try again, which reads again (every other request: user_id in the URL, not
//    in the body)
//  - U4 Add email: the address (email keyboard and autofill), the code (digits, one-time-code autofill), the new row and the
//    notice; invalid, limit, has-one, busy, network, wrong, taken, restart, too many wrong codes and has-one at the code
//    each said; a new code for the same address; the sheet can't close while a request is out; user_id in the URL only
//  - (U2 also: Telegram is not shown as a way while Telegram sign-in isn't configured)
//  - U5 Remove: Google's, the calendar account's (as calendar-google) and the email's, each asked first; the rows after;
//    a failure keeps the sheet with the reason
//  - U6 Add Google: inside Telegram a sheet opens the link in the browser with Telegram's openLink on the tap; in a browser
//    this tab goes there; a failure says so
//  - U7 Sign out (web) and Sign out on all devices: the routes, then /signin in the page's language (a web session) or
//    the notice (the Mini App)
//  - U8 Back: the group hands the screen a closer while a sheet is open and null once it closes
//  - U9 no log line holds an address, a code or a link
//  - U10 the words: every key the group reads is in en, he and ru, none is left unread, and the group writes no copy of its own
//  - U11 TextField: email and code kinds read left to right with their keyboard and autofill; the default is unchanged
//  - U12 React logged no warning
//  - U13 Join (web sign-up plan Task 7): an Add email whose right code answers join opens the question (the other
//    account's name and day, what moves, what closes); Join posts the question's id as `token`; expired, refused and a
//    failure each said; success closes it with the done line
//  - U14 the last way (Task 8): the only durable way shows with no Remove and says why; a removal the server refuses
//    (last-way) says so; with no chat the success line says the notice went by email
//
// Run with the fake env (never the real one), from the repo root: bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-signin-ui

import fs from 'fs';
import path from 'path';
import { act, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { TextField } from '../components/app-ui/form-kit';
import { elements, fakeTelegram, fakeWindow, FakeElement, FakeText, installWindow, mount, type FakeNode, type Mounted, type Row } from './lib/fake-dom';
import { jsxCopy } from './lib/jsx-copy';

type Locale = 'en' | 'he' | 'ru';
const ROOT = path.resolve(__dirname, '..');
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;
const w = (l: Locale) => (messages[l].settings as Row).signIn as Record<string, string>;
const say = (l: Locale, key: string, values: Row = {}) => createTranslator({ locale: l, messages: messages[l] })(`settings.signIn.${key}`, values) as string;
const EMOJI = /\p{Extended_Pictographic}/u;
const ADDRESS = 'dana@gmail.com';
const LINK_TOKEN = 'Q2hlY2tpbmctdGhlLWFkZC1saW5rMDEy';

const results: { name: string; ok: boolean; reason?: string }[] = [];
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
const show = (v: unknown) => JSON.stringify(v);

// ---- React must not warn; the group's own lines are kept to be asserted ----

const reactWarnings: string[] = [];
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[signin-methods]')) return void appLogs.push(text);
    if (text.startsWith('[telegram-ui]') || text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- The world: a scripted fetch ----

type Call = { url: string; method: string; body: Row | null; headers: Record<string, string>; credentials?: string };
const calls: Call[] = [];
let routes: Record<string, (call: Call) => Response | Promise<Response>> = {};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const call: Call = { url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, headers: { ...(init.headers as Record<string, string> | undefined) }, credentials: init.credentials };
  calls.push(call);
  const route = routes[`${method} ${url.split('?')[0]}`];
  if (!route) throw new TypeError(`Failed to fetch: an unexpected request ${method} ${url}`);
  return route(call);
}) as typeof fetch;
const last = (pathname: string) => calls.filter((c) => c.url.split('?')[0] === pathname).at(-1);
const VIEW = (over: Row = {}): Row => ({ telegram: true, google: null, googleFromCalendar: null, email: null, providers: { telegram: true, google: true, email: true }, chat: true, lastWay: null, session: null, ...over });
const methodsOf = (view: Row) => {
  const { session: _session, ...methods } = view;
  return methods;
};

// ---- Mounting ----

let SignInMethods: (props: Row) => ReactElement;
const sheetCalls: ((() => void) | null)[] = [];
const assigned: string[] = [];
const tree = (locale: Locale) =>
  createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as never, createElement(SignInMethods, { userId: 7, onSheet: (close: (() => void) | null) => void sheetCalls.push(close) }));
function open(locale: Locale, view: Row, opts: { telegram?: boolean } = {}) {
  installWindow();
  assigned.length = 0;
  sheetCalls.length = 0;
  fakeWindow.location = { hash: '', origin: 'https://famcal.bot', assign: (u: string) => void assigned.push(u) };
  const tgCalls: string[] = [];
  const tg = opts.telegram ? fakeTelegram(tgCalls, '7.7') : null;
  if (tg) tg.openLink = (url: string) => void tgCalls.push(`openLink(${url})`);
  fakeWindow.Telegram = tg ? { WebApp: tg } : undefined;
  routes = { 'GET /api/signin-methods': () => json(view) };
  const m = mount(tree(locale));
  return { m, tgCalls };
}
const closeAll = (o: { m: Mounted }) => {
  o.m.unmount();
  fakeWindow.Telegram = undefined;
  fakeWindow.location = { hash: '' };
};
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
const flat = (node: FakeNode) => visible(node).replace(/\s+/g, ' ').trim();
const page = (m: Mounted) => flat(m.container);
const buttons = (m: Mounted) => elements(m.container).filter((e) => e.localName === 'button');
const button = (m: Mounted, text: string) => buttons(m).find((b) => flat(b) === text);
const rowStarting = (m: Mounted, text: string) => buttons(m).find((b) => b.className.split(' ').includes('ch-form-row') && flat(b).startsWith(text));
const dialog = (m: Mounted) => elements(m.container).find((e) => e.getAttribute('role') === 'dialog');
const inputOf = (m: Mounted) => elements(dialog(m) as FakeElement).find((e) => e.localName === 'input') as FakeElement;
const formOf = (m: Mounted) => elements(dialog(m) as FakeElement).find((e) => e.localName === 'form') as FakeElement;
const alertsIn = (node: FakeNode) => elements(node).filter((e) => e.getAttribute('role') === 'alert').map(flat);
const statusLine = (m: Mounted) => elements(m.container).filter((e) => e.className === 'ch-notice' && e.getAttribute('role') === 'status').map(flat);
const textOf = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ').replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function main() {
  SignInMethods = (await import('../app/[locale]/(app)/settings/SignInMethods')).default as unknown as (props: Row) => ReactElement;

  await check('U1 loading (the server\'s render): the section label, a spinner and the loading line, in en, he and ru; no raw key, no emoji', () => {
    for (const l of LOCALES) {
      const html = renderToString(tree(l));
      assert(html.includes(`<h2 class="ch-section-label">${w(l).title}</h2>`), `${l}: the label ${html.slice(0, 200)}`);
      assert(textOf(html).includes(w(l).loading) && /ch-spin/.test(html), `${l}: the loading line`);
      assert(!/settings\./.test(textOf(html)) && !EMOJI.test(html), `${l}: a raw key or an emoji`);
    }
  });

  await check('U2 the rows: Telegram on for a Telegram account; Google\'s address, the calendar account (no address) or Add Google; the email or Add email; nothing to add for a way that isn\'t configured; Sign out only on a web session', async () => {
    for (const l of LOCALES) {
      const t = w(l);
      const fresh = open(l, VIEW());
      await settle();
      try {
        const text = page(fresh.m);
        assert(text.includes(t.telegram) && text.includes(t.on) && text.includes(t.telegramHint), `${l}: Telegram`);
        assert(button(fresh.m, t.googleAdd) && button(fresh.m, t.emailAdd) && button(fresh.m, t.signOutAll) && !button(fresh.m, t.signOut), `${l}: the actions ${show(buttons(fresh.m).map(flat))}`);
      } finally {
        closeAll(fresh);
      }
      const added = open(l, VIEW({ google: { address: ADDRESS }, email: { address: 'd@example.org' }, session: 'google' }));
      await settle();
      try {
        const bdis = elements(added.m.container).filter((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'ltr').map(flat);
        assert(bdis.includes(ADDRESS) && bdis.includes('d@example.org'), `${l}: the addresses ${show(bdis)}`);
        assert(rowStarting(added.m, t.google)?.getAttribute('aria-haspopup') === 'dialog' && rowStarting(added.m, t.email)?.getAttribute('aria-haspopup') === 'dialog', `${l}: the rows open a sheet`);
        assert(!button(added.m, t.googleAdd) && !button(added.m, t.emailAdd) && button(added.m, t.signOut), `${l}: added rows ${show(buttons(added.m).map(flat))}`);
      } finally {
        closeAll(added);
      }
      const calendar = open(l, VIEW({ googleFromCalendar: 'on' }));
      await settle();
      try {
        assert(page(calendar.m).includes(t.googleFromCalendar) && !button(calendar.m, t.googleAdd) && !button(calendar.m, t.turnOn), `${l}: the calendar's account (on): Add Google and Turn on both hide`);
      } finally {
        closeAll(calendar);
      }
      const calendarOff = open(l, VIEW({ googleFromCalendar: 'off' }));
      await settle();
      try {
        const text = page(calendarOff.m);
        assert(text.includes(t.googleFromCalendar) && text.includes(t.calendarOffHint) && button(calendarOff.m, t.turnOn) && button(calendarOff.m, t.googleAdd), `${l}: the calendar's account (off): its title, the hint, Turn on and Add Google ${show(buttons(calendarOff.m).map(flat))}`);
      } finally {
        closeAll(calendarOff);
      }
      const calendarOffNoGoogle = open(l, VIEW({ googleFromCalendar: 'off', providers: { telegram: true, google: false, email: true } }));
      await settle();
      try {
        assert(!button(calendarOffNoGoogle.m, t.turnOn) && !button(calendarOffNoGoogle.m, t.googleAdd), `${l}: nothing about Google while its sign-in isn't configured`);
      } finally {
        closeAll(calendarOffNoGoogle);
      }
      const noTelegramSignIn = open(l, VIEW({ providers: { telegram: false, google: true, email: true } }));
      await settle();
      try {
        assert(!page(noTelegramSignIn.m).includes(t.telegramHint) && button(noTelegramSignIn.m, t.googleAdd), `${l}: Telegram shows as a way while its sign-in isn't configured: ${page(noTelegramSignIn.m)}`);
      } finally {
        closeAll(noTelegramSignIn);
      }
      const bare = open(l, VIEW({ telegram: false, providers: { telegram: false, google: false, email: false } }));
      await settle();
      try {
        assert(!page(bare.m).includes(t.telegramHint) && !button(bare.m, t.googleAdd) && !button(bare.m, t.emailAdd) && button(bare.m, t.signOutAll), `${l}: nothing configured ${page(bare.m)}`);
      } finally {
        closeAll(bare);
      }
    }
  });

  await check('U3 the read: GET with user_id, same-origin, the initData in the header inside Telegram and none in a browser; a failure says so with Try again, which reads again', async () => {
    calls.length = 0;
    const tg = open('en', VIEW(), { telegram: true });
    await settle();
    try {
      const get = last('/api/signin-methods');
      assert(get && get.url === '/api/signin-methods?user_id=7' && get.method === 'GET' && get.credentials === 'same-origin' && typeof get.headers['X-Telegram-Init-Data'] === 'string', `inside Telegram ${show(get)}`);
    } finally {
      closeAll(tg);
    }
    const web = open('en', VIEW());
    await settle();
    try {
      assert(!('X-Telegram-Init-Data' in (last('/api/signin-methods')?.headers ?? {})), 'a browser sent an initData header');
    } finally {
      closeAll(web);
    }
    appLogs.length = 0;
    const broken = open('he', VIEW());
    routes['GET /api/signin-methods'] = () => json({ error: 'boom' }, 500);
    broken.m.unmount();
    const o = { m: mount(tree('he')) };
    await settle();
    try {
      assert(alertsIn(o.m.container).some((line) => line.includes(w('he').loadFailed)) && button(o.m, w('he').retry), `he: the failure ${page(o.m)}`);
      assert(appLogs.some((line) => line.includes('GET answered 500')), `logged ${show(appLogs)}`);
      routes['GET /api/signin-methods'] = () => json(VIEW());
      o.m.click(button(o.m, w('he').retry) as FakeElement);
      await settle();
      assert(page(o.m).includes(w('he').telegramHint) && alertsIn(o.m.container).length === 0, 'Try again did not read again');
    } finally {
      closeAll(o);
    }
  });

  await check('U4 Add email: the address with the email keyboard, the code with digits and one-time-code autofill, then the row and the notice; every failure said; a new code for the same address; the sheet waits while a request is out', async () => {
    for (const l of LOCALES) {
      const t = w(l);
      const o = open(l, VIEW(), { telegram: l === 'he' });
      await settle();
      try {
        o.m.click(button(o.m, t.emailAdd) as FakeElement);
        assert(dialog(o.m)?.getAttribute('aria-label') === t.emailSheetTitle, `${l}: the sheet`);
        const field = inputOf(o.m);
        assert(field.getAttribute('type') === 'email' && field.getAttribute('inputMode') === 'email' && field.getAttribute('autoComplete') === 'email' && field.getAttribute('dir') === 'ltr', `${l}: the email field ${show([...field.attributes])}`);
        const send = () => button(o.m, t.emailSend) as FakeElement;
        assert(send().hasAttribute('disabled'), `${l}: Send is on with no address`);
        o.m.input(field, ` ${ADDRESS} `);
        for (const [answer, key] of [[() => json({ ok: false, error: 'invalid' }, 400), 'emailInvalid'], [() => json({ ok: false, error: 'limit' }, 429), 'emailLimit'], [() => json({ ok: false, error: 'has-one' }, 409), 'emailHasOne'], [() => json({ error: 'Too many requests. Please wait a minute.' }, 429), 'busy'], [() => Promise.reject(new TypeError('Failed to fetch')), 'failed']] as const) {
          routes['POST /api/signin-methods/email/add'] = answer as () => Response;
          o.m.submit(formOf(o.m));
          await settle();
          assert(alertsIn(dialog(o.m) as FakeElement).includes(t[key]) && inputOf(o.m).getAttribute('type') === 'email', `${l}: ${key}: ${show(alertsIn(dialog(o.m) as FakeElement))}`);
        }
        let release: (r: Response) => void = () => undefined;
        routes['POST /api/signin-methods/email/add'] = () => new Promise<Response>((resolve) => void (release = resolve));
        o.m.submit(formOf(o.m));
        await settle();
        assert(send().hasAttribute('disabled') && page(o.m).includes(t.emailSending), `${l}: no busy state`);
        const closer = sheetCalls.at(-1);
        assert(typeof closer === 'function', `${l}: no closer while busy`);
        await act(async () => closer?.());
        assert(dialog(o.m), `${l}: Back closed the sheet while its request was out`);
        await act(async () => release(json({ ok: true })));
        await settle();
        const added = last('/api/signin-methods/email/add');
        assert(added && added.url === '/api/signin-methods/email/add?user_id=7' && show(added.body) === show({ email: ADDRESS }) && added.headers['Content-Type'] === 'application/json' && added.credentials === 'same-origin', `${l}: the add request ${show(added)}`);
        if (l === 'he') assert(typeof added.headers['X-Telegram-Init-Data'] === 'string' && !('initData' in (added.body ?? {})), `${l}: the initData is not in the header`);
        const code = inputOf(o.m);
        assert(code.getAttribute('inputMode') === 'numeric' && code.getAttribute('autoComplete') === 'one-time-code' && code.getAttribute('maxLength') === '6' && code.getAttribute('dir') === 'ltr', `${l}: the code field ${show([...code.attributes])}`);
        const bdi = elements(dialog(o.m) as FakeElement).find((e) => e.localName === 'bdi');
        assert(bdi && flat(bdi) === ADDRESS && bdi.getAttribute('dir') === 'ltr', `${l}: the address in the code step`);
        o.m.input(code, '12 34-56');
        assert(code.value === '123456', `${l}: the code is ${code.value}`);
        for (const [error, key, status] of [['wrong', 'codeWrong', 400], ['taken', 'codeTaken', 409], ['has-one', 'emailHasOne', 409], ['limit', 'codeLimit', 429]] as const) {
          routes['POST /api/signin-methods/email/confirm'] = () => json({ ok: false, error }, status);
          o.m.submit(formOf(o.m));
          await settle();
          assert(alertsIn(dialog(o.m) as FakeElement).includes(t[key]) && inputOf(o.m).getAttribute('inputMode') === 'numeric', `${l}: ${error}`);
        }
        const before = calls.length;
        routes['POST /api/signin-methods/email/add'] = () => json({ ok: true });
        o.m.click(button(o.m, t.codeAgain) as FakeElement);
        await settle();
        assert(calls.length > before && last('/api/signin-methods/email/add')?.url === '/api/signin-methods/email/add?user_id=7' && show(last('/api/signin-methods/email/add')?.body) === show({ email: ADDRESS }), `${l}: a new code`);
        o.m.input(inputOf(o.m), '123456');
        routes['POST /api/signin-methods/email/confirm'] = () => json({ ok: false, error: 'restart' }, 400);
        o.m.submit(formOf(o.m));
        await settle();
        assert(inputOf(o.m).getAttribute('type') === 'email' && inputOf(o.m).value === ADDRESS && alertsIn(dialog(o.m) as FakeElement).includes(t.codeRestart), `${l}: restart`);
        o.m.submit(formOf(o.m));
        await settle();
        o.m.input(inputOf(o.m), '123456');
        routes['POST /api/signin-methods/email/confirm'] = () => json({ ok: true, methods: methodsOf(VIEW({ email: { address: ADDRESS } })) });
        o.m.submit(formOf(o.m));
        await settle();
        assert(last('/api/signin-methods/email/confirm')?.url === '/api/signin-methods/email/confirm?user_id=7' && show(last('/api/signin-methods/email/confirm')?.body) === show({ code: '123456' }), `${l}: the confirm request ${show(last('/api/signin-methods/email/confirm'))}`);
        assert(!dialog(o.m) && rowStarting(o.m, t.email) && !button(o.m, t.emailAdd), `${l}: the row after adding`);
        assert(statusLine(o.m).includes(say(l, 'added', { kind: 'email' })), `${l}: the notice ${show(statusLine(o.m))}`);
      } finally {
        closeAll(o);
      }
    }
  });

  await check('U5 Remove asks first: Google\'s (google), the calendar account\'s (calendar-google) and the email\'s (email), each with its words; the rows after and the notice; a failure keeps the sheet with the reason', async () => {
    for (const l of LOCALES) {
      const t = w(l);
      for (const [view, which, kind, body] of [
        [VIEW({ google: { address: ADDRESS } }), 'google', 'google', 'removeBody'],
        [VIEW({ googleFromCalendar: 'on' }), 'calendar-google', 'google', 'removeCalendarBody'],
        [VIEW({ email: { address: ADDRESS } }), 'email', 'email', 'removeBody'],
      ] as const) {
        const o = open(l, view);
        await settle();
        try {
          o.m.click(rowStarting(o.m, kind === 'google' ? t.google : t.email) as FakeElement);
          const d = dialog(o.m) as FakeElement;
          assert(d && d.getAttribute('aria-label') === say(l, 'removeTitle', { kind }) && flat(d).includes(t[body]), `${l} ${which}: the sheet ${d && flat(d)}`);
          if (which !== 'calendar-google') assert(flat(d).includes(ADDRESS), `${l} ${which}: no address in the sheet`);
          routes['POST /api/signin-methods/remove'] = () => json({ error: 'boom' }, 500);
          o.m.click(button(o.m, t.remove) as FakeElement);
          await settle();
          assert(dialog(o.m) && alertsIn(dialog(o.m) as FakeElement).includes(t.failed), `${l} ${which}: the failure`);
          routes['POST /api/signin-methods/remove'] = () => json({ ok: true, methods: methodsOf(VIEW()) });
          o.m.click(button(o.m, t.remove) as FakeElement);
          await settle();
          assert(last('/api/signin-methods/remove')?.url === '/api/signin-methods/remove?user_id=7' && show(last('/api/signin-methods/remove')?.body) === show({ which }), `${l} ${which}: the request ${show(last('/api/signin-methods/remove'))}`);
          assert(!dialog(o.m) && button(o.m, kind === 'google' ? t.googleAdd : t.emailAdd) && statusLine(o.m).includes(t.removed), `${l} ${which}: after`);
        } finally {
          closeAll(o);
        }
      }
    }
  });

  await check('U5b Turn on: one POST to /api/signin-methods/calendar-on for the account (no body of consequence), a busy label while it runs; on reads the new list (the row becomes the calendar account on, Add Google and Turn on hide) with turnedOn; shared, reconnect, failed and busy each say their own words and keep the off row with Turn on', async () => {
    for (const l of LOCALES) {
      const t = w(l);
      const o = open(l, VIEW({ googleFromCalendar: 'off' }));
      await settle();
      try {
        let release: (() => void) | null = null;
        routes['POST /api/signin-methods/calendar-on'] = () => new Promise<Response>((resolve) => {
          release = () => resolve(json({ ok: true, methods: methodsOf(VIEW({ googleFromCalendar: 'on' })) }));
        });
        calls.length = 0;
        o.m.click(button(o.m, t.turnOn) as FakeElement);
        await settle();
        assert(page(o.m).includes(t.turningOn) && buttons(o.m).filter((b) => flat(b) === t.googleAdd).every((b) => b.getAttribute('disabled') !== null), `${l}: the busy label ${page(o.m)}`);
        (release as (() => void) | null)?.();
        await settle();
        const post = last('/api/signin-methods/calendar-on');
        assert(post && post.url === '/api/signin-methods/calendar-on?user_id=7' && post.method === 'POST' && post.credentials === 'same-origin', `${l}: the request ${show(post)}`);
        assert(statusLine(o.m).includes(t.turnedOn) && page(o.m).includes(t.googleFromCalendar) && !button(o.m, t.turnOn) && !button(o.m, t.googleAdd), `${l}: after on ${page(o.m)}`);
      } finally {
        closeAll(o);
      }
      for (const [answer, key] of [
        [() => json({ ok: false, error: 'shared' }, 409), 'turnOnShared'],
        [() => json({ ok: false, error: 'reconnect' }, 409), 'turnOnReconnect'],
        [() => json({ ok: false, error: 'failed' }, 502), 'failed'],
        [() => json({ ok: false, error: 'not-offered' }, 409), 'failed'],
        [() => json({ error: 'Too many requests. Please wait a minute.' }, 429), 'busy'],
        [() => Promise.reject(new TypeError('Failed to fetch')), 'failed'],
      ] as const) {
        const f = open(l, VIEW({ googleFromCalendar: 'off' }));
        await settle();
        try {
          routes['POST /api/signin-methods/calendar-on'] = answer;
          f.m.click(button(f.m, t.turnOn) as FakeElement);
          await settle();
          assert(alertsIn(f.m.container).includes(t[key]) && button(f.m, t.turnOn) && button(f.m, t.googleAdd), `${l} ${key}: ${page(f.m)}`);
        } finally {
          closeAll(f);
        }
      }
    }
  });

  await check('U6 Add Google: inside Telegram a sheet opens the one-time link in the browser on the tap (openLink, absolute); in a browser this tab goes there; a failure says so', async () => {
    const tg = open('he', VIEW(), { telegram: true });
    await settle();
    try {
      // Task 6 answers the link absolute (buildUrl over localeHref, ?token=)
      routes['POST /api/auth/google/add-link'] = () => json({ url: `https://famcal.bot/he/signin/add-google?token=${LINK_TOKEN}` });
      tg.m.click(button(tg.m, w('he').googleAdd) as FakeElement);
      await settle();
      assert(last('/api/auth/google/add-link')?.url === '/api/auth/google/add-link?user_id=7' && show(last('/api/auth/google/add-link')?.body) === show({}), `the add-link request ${show(last('/api/auth/google/add-link'))}`);
      assert(dialog(tg.m)?.getAttribute('aria-label') === w('he').googleSheetTitle && flat(dialog(tg.m) as FakeElement).includes(w('he').googleSheetBody), 'no sheet inside Telegram');
      assert(!tg.tgCalls.some((c) => c.startsWith('openLink')), 'the link opened before the tap');
      tg.m.click(button(tg.m, w('he').googleOpen) as FakeElement);
      assert(tg.tgCalls.includes(`openLink(https://famcal.bot/he/signin/add-google?token=${LINK_TOKEN})`), `openLink ${show(tg.tgCalls)}`);
      assert(!dialog(tg.m) && statusLine(tg.m).includes(w('he').googleOpened), 'after the tap');
    } finally {
      closeAll(tg);
    }
    const web = open('en', VIEW());
    await settle();
    try {
      // A site-relative link resolves against the page's origin too
      routes['POST /api/auth/google/add-link'] = () => json({ url: `/signin/add-google?token=${LINK_TOKEN}` });
      web.m.click(button(web.m, w('en').googleAdd) as FakeElement);
      await settle();
      assert(show(assigned) === show([`https://famcal.bot/signin/add-google?token=${LINK_TOKEN}`]) && !dialog(web.m), `a browser ${show(assigned)}`);
    } finally {
      closeAll(web);
    }
    const bad = open('ru', VIEW());
    await settle();
    try {
      routes['POST /api/auth/google/add-link'] = () => json({ error: 'boom' }, 500);
      bad.m.click(button(bad.m, w('ru').googleAdd) as FakeElement);
      await settle();
      assert(alertsIn(bad.m.container).includes(w('ru').failed) && !dialog(bad.m) && !(button(bad.m, w('ru').googleAdd) as FakeElement).hasAttribute('disabled'), 'a failure');
    } finally {
      closeAll(bad);
    }
  });

  await check('U7 Sign out: on a web session the route, then /signin in the page\'s language; Sign out on all devices: the route with user_id, then /signin (web) or the notice (the Mini App); a failure says so', async () => {
    for (const l of LOCALES) {
      const signin = l === 'en' ? '/signin' : `/${l}/signin`;
      const web = open(l, VIEW({ session: 'email' }));
      await settle();
      try {
        routes['POST /api/auth/signout'] = () => json({ ok: true });
        web.m.click(button(web.m, w(l).signOut) as FakeElement);
        await settle();
        assert(last('/api/auth/signout') && show(assigned) === show([signin]), `${l}: sign out ${show(assigned)}`);
      } finally {
        closeAll(web);
      }
      const webAll = open(l, VIEW({ session: 'google' }));
      await settle();
      try {
        routes['POST /api/auth/signout-all'] = () => json({ ok: true });
        webAll.m.click(button(webAll.m, w(l).signOutAll) as FakeElement);
        await settle();
        assert(last('/api/auth/signout-all')?.url === '/api/auth/signout-all?user_id=7' && show(last('/api/auth/signout-all')?.body) === show({}) && show(assigned) === show([signin]), `${l}: all, on the web`);
      } finally {
        closeAll(webAll);
      }
      const mini = open(l, VIEW(), { telegram: true });
      await settle();
      try {
        routes['POST /api/auth/signout-all'] = () => json({}, 500);
        mini.m.click(button(mini.m, w(l).signOutAll) as FakeElement);
        await settle();
        assert(alertsIn(mini.m.container).includes(w(l).failed), `${l}: a failure`);
        routes['POST /api/auth/signout-all'] = () => json({ ok: true });
        mini.m.click(button(mini.m, w(l).signOutAll) as FakeElement);
        await settle();
        assert(assigned.length === 0 && statusLine(mini.m).includes(w(l).signedOutAll), `${l}: all, in the Mini App ${show(statusLine(mini.m))}`);
      } finally {
        closeAll(mini);
      }
    }
  });

  await check('U8 Back: while a sheet is open the screen holds a closer that closes it; once closed, null', async () => {
    const o = open('en', VIEW({ google: { address: ADDRESS } }));
    await settle();
    try {
      assert(sheetCalls.at(-1) === null, `closed at first: ${show(sheetCalls.map((c) => typeof c))}`);
      o.m.click(rowStarting(o.m, w('en').google) as FakeElement);
      const closer = sheetCalls.at(-1);
      assert(typeof closer === 'function' && dialog(o.m), 'no closer while the sheet is open');
      await act(async () => closer?.());
      assert(!dialog(o.m) && sheetCalls.at(-1) === null, 'the closer did not close it');
    } finally {
      closeAll(o);
    }
  });

  await check('U13 Join: an Add email whose right code answers join opens the question with the other account\'s name and day, what moves and what closes; Join posts the id as token; expired, refused and a failure each said; success closes it with the done line', async () => {
    const JOIN_ID = 'Sm9pbi1xdWVzdGlvbi0x0w';
    const summary = { name: 'Dana', createdAt: '2026-11-03T09:00:00.000Z', plan: { calendars: 2, events: 5, ways: ['email', 'google'], google: 'stays', partner: 'ends', plan: 'moves' } };
    for (const l of LOCALES) {
      const t = w(l);
      const o = open(l, VIEW());
      await settle();
      try {
        routes['POST /api/signin-methods/email/add'] = () => json({ ok: true });
        o.m.click(button(o.m, t.emailAdd) as FakeElement);
        o.m.input(inputOf(o.m), ADDRESS);
        o.m.submit(formOf(o.m));
        await settle();
        o.m.input(inputOf(o.m), '123456');
        routes['POST /api/signin-methods/email/confirm'] = () => json({ ok: false, error: 'join', joinId: JOIN_ID, summary }, 409);
        o.m.submit(formOf(o.m));
        await settle();
        const d = dialog(o.m) as FakeElement;
        assert(d && d.getAttribute('aria-label') === say(l, 'join.title'), `${l}: the question ${d && flat(d)}`);
        const date = new Intl.DateTimeFormat(l, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' }).format(new Date(summary.createdAt));
        const text = flat(d);
        assert(text.includes(say(l, 'join.question', { kind: 'email', name: 'Dana', date })), `${l}: the question line ${text}`);
        for (const key of ['calendars', 'wayEmail', 'wayGoogle', 'googleStays', 'partnerEnds', 'plan', 'closes']) {
          assert(text.includes(say(l, `join.${key}`, { calendars: 2, events: 5 })), `${l}: no ${key} line in ${text}`);
        }
        assert(!text.includes(say(l, 'join.partner')) || say(l, 'join.partnerEnds').includes(say(l, 'join.partner')), `${l}: a partner line for a partner that ends`);
        const joinButton = () => button(o.m, say(l, 'join.join')) as FakeElement;
        for (const [answer, key, stays] of [
          [() => json({ ok: false, error: 'failed' }, 500), 'failed', true],
          [() => json({ ok: false, error: 'expired' }, 410), 'join.expired', false],
        ] as const) {
          routes['POST /api/signin-methods/join'] = answer;
          o.m.click(joinButton());
          await settle();
          assert(alertsIn(dialog(o.m) as FakeElement).includes(say(l, key)) && joinButton().hasAttribute('disabled') === !stays, `${l}: ${key}: ${show(alertsIn(dialog(o.m) as FakeElement))}`);
          if (!stays) {
            o.m.click(button(o.m, t.cancel) as FakeElement);
            o.m.click(button(o.m, t.emailAdd) as FakeElement);
            o.m.input(inputOf(o.m), ADDRESS);
            o.m.submit(formOf(o.m));
            await settle();
            o.m.input(inputOf(o.m), '123456');
            o.m.submit(formOf(o.m));
            await settle();
          }
        }
        const sent = last('/api/signin-methods/join');
        assert(sent?.url === '/api/signin-methods/join?user_id=7' && show(sent.body) === show({ token: JOIN_ID }) && sent.credentials === 'same-origin', `${l}: the answer ${show(sent)}`);
        routes['POST /api/signin-methods/join'] = () => json({ ok: true, methods: methodsOf(VIEW({ email: { address: ADDRESS }, google: { address: 'dana@gmail.com' } })) });
        o.m.click(joinButton());
        await settle();
        assert(!dialog(o.m) && rowStarting(o.m, t.email) && statusLine(o.m).includes(say(l, 'join.done')), `${l}: after ${show(statusLine(o.m))}`);
      } finally {
        closeAll(o);
      }
    }
  });

  await check('U14 the last way: the only durable way shows its address with no Remove and says why (Google or email); a removal the server refuses (last-way) says the same; with no chat, adding an email says the notice went by email', async () => {
    for (const l of LOCALES) {
      const t = w(l);
      for (const [kind, label] of [['email', t.email], ['google', t.google]] as const) {
        const o = open(l, VIEW({ telegram: false, chat: false, lastWay: kind, [kind]: { address: ADDRESS }, session: kind }));
        await settle();
        try {
          assert(!rowStarting(o.m, label) && page(o.m).includes(t.lastWay) && page(o.m).includes(ADDRESS), `${l} ${kind}: ${page(o.m)} ${show(buttons(o.m).map(flat))}`);
        } finally {
          closeAll(o);
        }
      }
      const raced = open(l, VIEW({ telegram: false, chat: false, email: { address: ADDRESS }, google: { address: 'd@example.org' }, session: 'email' }));
      await settle();
      try {
        raced.m.click(rowStarting(raced.m, t.email) as FakeElement);
        routes['POST /api/signin-methods/remove'] = () => json({ ok: false, error: 'last-way' }, 409);
        raced.m.click(button(raced.m, t.remove) as FakeElement);
        await settle();
        assert(dialog(raced.m) && alertsIn(dialog(raced.m) as FakeElement).includes(t.lastWay), `${l}: last-way ${show(alertsIn(dialog(raced.m) as FakeElement))}`);
      } finally {
        closeAll(raced);
      }
      const noChat = open(l, VIEW({ telegram: false, chat: false, google: { address: 'd@example.org' }, lastWay: 'google', session: 'google' }));
      await settle();
      try {
        routes['POST /api/signin-methods/email/add'] = () => json({ ok: true });
        noChat.m.click(button(noChat.m, t.emailAdd) as FakeElement);
        noChat.m.input(inputOf(noChat.m), ADDRESS);
        noChat.m.submit(formOf(noChat.m));
        await settle();
        noChat.m.input(inputOf(noChat.m), '123456');
        routes['POST /api/signin-methods/email/confirm'] = () => json({ ok: true, methods: methodsOf(VIEW({ telegram: false, chat: false, google: { address: 'd@example.org' }, email: { address: ADDRESS } })) });
        noChat.m.submit(formOf(noChat.m));
        await settle();
        assert(statusLine(noChat.m).includes(say(l, 'noticeSentEmail', { kind: 'email' })) && !statusLine(noChat.m).includes(say(l, 'added', { kind: 'email' })), `${l}: the notice line ${show(statusLine(noChat.m))}`);
      } finally {
        closeAll(noChat);
      }
    }
  });

  await check('U15 a sign-in that is over an hour old (the route answers 403 stale-sign-in, matched by body.error and never by status alone): each add button turns into its Sign in again label with the note, and its next press signs out then opens /signin; Add email closes its sheet; Join keeps its sheet with its own label; a WhatsApp session shows the WhatsApp hint instead; a plain 403 and the Mini App show none of it', async () => {
    const gateWords = (l: Locale) => (messages[l].pageGate as Record<string, string>).browserBody;
    const stale = () => json({ ok: false, error: 'stale-sign-in' }, 403);
    const JOIN_ID = 'Sm9pbi1xdWVzdGlvbi0x0w';
    const summary = { name: 'Dana', createdAt: '2026-11-03T09:00:00.000Z', plan: { calendars: 2, events: 5, ways: ['email'], google: 'stays', partner: 'ends', plan: 'moves' } };
    for (const l of LOCALES) {
      const t = w(l);
      const signin = l === 'en' ? '/signin' : `/${l}/signin`;
      const leaves = async (o: { m: Mounted }, label: string) => {
        calls.length = 0;
        routes['POST /api/auth/signout'] = () => json({ ok: true });
        o.m.click(button(o.m, label) as FakeElement);
        await settle();
        const out = calls.findIndex((c) => c.url.split('?')[0] === '/api/auth/signout');
        assert(out === 0 && calls.length === 1 && show(assigned) === show([signin]), `${l}: ${label}: the press ${show(calls.map((c) => c.url))} ${show(assigned)}`);
      };

      // Add Google, Add email and Turn on all learn of it from one press and turn into their labels
      const g = open(l, VIEW({ googleFromCalendar: 'off', session: 'google' }));
      await settle();
      try {
        routes['POST /api/auth/google/add-link'] = stale;
        g.m.click(button(g.m, t.googleAdd) as FakeElement);
        await settle();
        assert(!button(g.m, t.googleAdd) && button(g.m, t.googleSignInAgain) && button(g.m, t.emailSignInAgain) && button(g.m, t.turnOnSignInAgain), `${l}: the labels ${show(buttons(g.m).map(flat))}`);
        assert(!button(g.m, t.emailAdd) && !button(g.m, t.turnOn), `${l}: a plain label is left ${show(buttons(g.m).map(flat))}`);
        assert(statusLine(g.m).includes(t.staleNote) && alertsIn(g.m.container).length === 0 && !dialog(g.m), `${l}: the note ${show(statusLine(g.m))}`);
        assert(!page(g.m).includes(gateWords(l)), `${l}: the WhatsApp hint on a Google session`);
        await leaves(g, t.turnOnSignInAgain);
      } finally {
        closeAll(g);
      }

      // Add email: the stale answer to the code request closes the sheet and the row turns into its label
      const e = open(l, VIEW({ session: 'email' }));
      await settle();
      try {
        e.m.click(button(e.m, t.emailAdd) as FakeElement);
        e.m.input(inputOf(e.m), ADDRESS);
        routes['POST /api/signin-methods/email/add'] = stale;
        e.m.submit(formOf(e.m));
        await settle();
        assert(!dialog(e.m) && button(e.m, t.emailSignInAgain) && !button(e.m, t.emailAdd) && statusLine(e.m).includes(t.staleNote), `${l}: add email ${page(e.m)}`);
        await leaves(e, t.emailSignInAgain);
      } finally {
        closeAll(e);
      }
      // ... and so does the stale answer to the right code, when the hour ran out between the two
      const c = open(l, VIEW({ session: 'google' }));
      await settle();
      try {
        routes['POST /api/signin-methods/email/add'] = () => json({ ok: true });
        c.m.click(button(c.m, t.emailAdd) as FakeElement);
        c.m.input(inputOf(c.m), ADDRESS);
        c.m.submit(formOf(c.m));
        await settle();
        c.m.input(inputOf(c.m), '123456');
        routes['POST /api/signin-methods/email/confirm'] = stale;
        c.m.submit(formOf(c.m));
        await settle();
        assert(!dialog(c.m) && button(c.m, t.emailSignInAgain) && statusLine(c.m).includes(t.staleNote), `${l}: confirm ${page(c.m)}`);
      } finally {
        closeAll(c);
      }

      // Join keeps its question open, with its own label
      const j = open(l, VIEW({ session: 'email' }));
      await settle();
      try {
        routes['POST /api/signin-methods/email/add'] = () => json({ ok: true });
        j.m.click(button(j.m, t.emailAdd) as FakeElement);
        j.m.input(inputOf(j.m), ADDRESS);
        j.m.submit(formOf(j.m));
        await settle();
        j.m.input(inputOf(j.m), '123456');
        routes['POST /api/signin-methods/email/confirm'] = () => json({ ok: false, error: 'join', joinId: JOIN_ID, summary }, 409);
        j.m.submit(formOf(j.m));
        await settle();
        routes['POST /api/signin-methods/join'] = stale;
        j.m.click(button(j.m, say(l, 'join.join')) as FakeElement);
        await settle();
        assert(dialog(j.m) && !button(j.m, say(l, 'join.join')) && button(j.m, t.joinSignInAgain) && alertsIn(dialog(j.m) as FakeElement).includes(t.staleNote), `${l}: join ${show(buttons(j.m).map(flat))}`);
        await leaves(j, t.joinSignInAgain);
      } finally {
        closeAll(j);
      }

      // A WhatsApp session can only ask for a new link: the hint, never the sign-in label
      const wa = open(l, VIEW({ session: 'wa', googleFromCalendar: 'off' }));
      await settle();
      try {
        routes['POST /api/auth/google/add-link'] = stale;
        wa.m.click(button(wa.m, t.googleAdd) as FakeElement);
        await settle();
        assert(statusLine(wa.m).includes(gateWords(l)) && !page(wa.m).includes(t.staleNote), `${l}: the WhatsApp hint ${show(statusLine(wa.m))}`);
        assert(button(wa.m, t.googleAdd) && button(wa.m, t.emailAdd) && button(wa.m, t.turnOn) && !buttons(wa.m).some((b) => [t.googleSignInAgain, t.emailSignInAgain, t.turnOnSignInAgain].includes(flat(b))), `${l}: wa labels ${show(buttons(wa.m).map(flat))}`);
      } finally {
        closeAll(wa);
      }

      // Turn on's own route answers it too (calendar-on): the same three labels and the note
      const on = open(l, VIEW({ googleFromCalendar: 'off', session: 'google' }));
      await settle();
      try {
        routes['POST /api/signin-methods/calendar-on'] = stale;
        on.m.click(button(on.m, t.turnOn) as FakeElement);
        await settle();
        assert(!button(on.m, t.turnOn) && !button(on.m, t.googleAdd) && !button(on.m, t.emailAdd) && button(on.m, t.turnOnSignInAgain) && button(on.m, t.googleSignInAgain) && button(on.m, t.emailSignInAgain), `${l}: turn on labels ${show(buttons(on.m).map(flat))}`);
        assert(statusLine(on.m).includes(t.staleNote) && alertsIn(on.m.container).length === 0, `${l}: turn on note ${show(statusLine(on.m))}`);
        await leaves(on, t.googleSignInAgain);
      } finally {
        closeAll(on);
      }

      // Another 403 (suspended) is the group's plain failure, never the stale labels
      const plain = open(l, VIEW({ session: 'google' }));
      await settle();
      try {
        routes['POST /api/auth/google/add-link'] = () => json({ ok: false, error: 'suspended' }, 403);
        plain.m.click(button(plain.m, t.googleAdd) as FakeElement);
        await settle();
        assert(alertsIn(plain.m.container).includes(t.failed) && button(plain.m, t.googleAdd) && !button(plain.m, t.googleSignInAgain) && !statusLine(plain.m).includes(t.staleNote), `${l}: a plain 403 ${page(plain.m)}`);
      } finally {
        closeAll(plain);
      }

      // Inside the Mini App the server never asks (initData wins); a stale answer there is no reason to sign in again
      const mini = open(l, VIEW(), { telegram: true });
      await settle();
      try {
        routes['POST /api/auth/google/add-link'] = stale;
        mini.m.click(button(mini.m, t.googleAdd) as FakeElement);
        await settle();
        assert(button(mini.m, t.googleAdd) && !button(mini.m, t.googleSignInAgain) && !page(mini.m).includes(t.staleNote) && alertsIn(mini.m.container).includes(t.failed), `${l}: the Mini App ${page(mini.m)}`);
      } finally {
        closeAll(mini);
      }

      // ... Turn on included
      const miniOn = open(l, VIEW({ googleFromCalendar: 'off' }), { telegram: true });
      await settle();
      try {
        routes['POST /api/signin-methods/calendar-on'] = stale;
        miniOn.m.click(button(miniOn.m, t.turnOn) as FakeElement);
        await settle();
        assert(button(miniOn.m, t.turnOn) && !button(miniOn.m, t.turnOnSignInAgain) && !page(miniOn.m).includes(t.staleNote) && alertsIn(miniOn.m.container).includes(t.failed), `${l}: the Mini App, Turn on ${page(miniOn.m)}`);
      } finally {
        closeAll(miniOn);
      }
    }
  });

  await check('U9 no log line holds an address, a code or the link\'s token', () => {
    const leaked = appLogs.filter((line) => line.includes(ADDRESS) || /\b123456\b/.test(line) || line.includes(LINK_TOKEN));
    assert(appLogs.length > 0 && leaked.length === 0, `${appLogs.length} lines, leaked ${show(leaked)}`);
  });

  await check('U10 the words: every key the group reads is in en, he and ru; none is left unread; the group writes no copy of its own', () => {
    const file = 'app/[locale]/(app)/settings/SignInMethods.tsx';
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Nested messages (the Join question's, join.*) as dotted paths
    const flatten = (o: Row, prefix = ''): Record<string, unknown> =>
      Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.entries(flatten(v as Row, `${prefix}${k}.`)) : [[`${prefix}${k}`, v]])));
    const words = (l: Locale) => flatten(w(l) as Row);
    const keys = Object.keys(words('en')).sort();
    for (const l of LOCALES) assert(show(Object.keys(words(l)).sort()) === show(keys), `${l}: other keys than en`);
    for (const l of LOCALES) for (const k of keys) assert(typeof words(l)[k] === 'string' && String(words(l)[k]).trim() !== '', `${l}: ${k} is empty`);
    const read = [...src.matchAll(/\bt(?:\.rich)?\('([\w.]+)'/g)].map((m) => m[1]);
    assert(read.length > 20, `only ${read.length} reads found`);
    for (const k of read) assert(keys.includes(k), `${k} is read but is not a message`);
    // The question's lines are read by their key (t(`join.${line.key}`)), each named in JoinLine (src/lib/join-summary.ts)
    const union = /key: ((?:'\w+'(?: \| )?)+);/.exec(fs.readFileSync(path.join(ROOT, 'src/lib/join-summary.ts'), 'utf8'));
    const lineKeys = union ? [...union[1].matchAll(/'(\w+)'/g)].map((m) => `join.${m[1]}`) : [];
    assert(lineKeys.length === 8 && src.includes('t(`join.${line.key}`'), `the question's lines: ${show(lineKeys)}`);
    const unread = keys.filter((k) => !src.includes(`'${k}'`) && !lineKeys.includes(k));
    assert(unread.length === 0, `keys nothing reads: ${show(unread)}`);
    assert(show(jsxCopy(file, src)) === '[]', `copy in the TSX: ${show(jsxCopy(file, src))}`);
  });

  await check('U11 TextField: the email and code kinds read left to right with their keyboard and autofill; the default field is exactly what it was', () => {
    const Field = TextField as unknown as (p: Row) => ReactElement;
    const html = (p: Row) => renderToString(createElement(Field, { label: 'Notes', value: 'Bring the form', onChange: () => undefined, placeholder: 'Add notes', ...p }));
    assert(html({}) === '<input class="ch-form-field" aria-label="Notes" placeholder="Add notes" dir="auto" type="text" enterKeyHint="done" autoComplete="off" value="Bring the form"/>', `the default ${html({})}`);
    const email = html({ kind: 'email' });
    assert(/dir="ltr"/.test(email) && /type="email"/.test(email) && /inputMode="email"/.test(email) && /autoComplete="email"/.test(email) && /autoCapitalize="none"/.test(email) && /spellCheck="false"/.test(email), `email ${email}`);
    const code = html({ kind: 'code', maxLength: 6 });
    assert(/dir="ltr"/.test(code) && /type="text"/.test(code) && /inputMode="numeric"/.test(code) && /autoComplete="one-time-code"/.test(code) && /maxLength="6"/.test(code), `code ${code}`);
  });

  await check('U12 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  // Not console.error: this file's console is intercepted (React's warnings), which would hide the failure
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
