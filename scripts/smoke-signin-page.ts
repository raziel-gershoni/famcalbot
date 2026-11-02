// Smoke test for /signin and /signin/add-google (plan 6b Task 8; spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md
// §2.7, §2.9, §2.11, §3): the pages as Next runs them on the server (next-intl's server API over the real messages, the
// request's cookies and next/navigation's redirect stood in for), and the email form and the add-Google button in real
// React on the small fake DOM with a scripted fetch. Redis and Prisma are in memory. No network.
//
//  - P1 the ways: only the configured ones (Telegram, Google, email), Telegram's with its approval note and Google's with
//    Google's G mark, each start a plain link to its /api/auth/<way>/start in the page's language; none configured says so
//    and offers the start buttons; the page is per request and kept out of search
//  - P2 a valid session cookie sends /signin to the calendar (/{locale}/dashboard?user_id=); a tampered cookie, the old
//    cookie's name, no cookie, or a status in the query does not
//  - P3 the outcomes: no account (WhatsApp's settings link, the start buttons, another way), several, suspended and
//    blocked (the contact address), taken and has-one (a refused Add Google), and restart, failed and unavailable as an
//    alert above the ways; an unknown status is ignored
//  - P4 the email form: the address to /api/auth/email/request with the page's language, one answer for every address,
//    the code to /api/auth/email/verify, the redirect (same site only); a wrong code, too many wrong codes (limited), a
//    failed check, a restart, a blocked account, a failed request; the buttons wait while a request is out and work again
//    after it; no log line holds the address or the code
//  - P5 inside Telegram, in its own browser (TelegramWebviewProxy) and in the Mini App's webview (Telegram.WebApp.initData
//    non-empty): no OIDC flow starts (no link to /api/auth/..., nothing fetched or navigated on a tap); the Telegram way
//    opens Telegram's app link, Google says to open the page in a browser and shows its address, email still works;
//    outside Telegram the same page links both start routes
//  - P6 /signin/add-google?token=: names the account (read with getUserById) and never uses the link up (the key is the
//    token's sha256, as Task 6 stores it); Continue posts the token to add-start and goes to Google; a used or late link
//    (on the page, or at Continue) says to start again from Settings; a token that isn't one is never looked up; Redis
//    failing says so, and the token is in no log line
//  - P7 the CSS: the fields 16 px or more, every way, link and field at least 44 px, Google's button in Google's colours
//    (tokens, light and dark, readable), the reduced-motion spinner, and the kit's lint
//
// Run with the fake env (never the real one), from the repo root: bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6b/run-smoke.sh smoke-signin-page

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactElement } from 'react';
import { lintCss } from './lib/css-lint';
import { elements, fakeTelegram, fakeWindow, FakeElement, FakeText, installWindow, mount, type FakeNode, type Mounted } from './lib/fake-dom';
import { assert, check, decodeEntities, EMOJI, finish, LOCALES, load, messages, RAW_KEY, render, request, show, stub, stubIntlServer, textOf, type Locale, type Row } from './lib/site-harness';

const nodeRequire = createRequire(__filename);
const { NextIntlClientProvider, createTranslator } = nodeRequire('next-intl');
const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
const prefix = (l: Locale) => (l === 'en' ? '' : `/${l}`);
const attrs = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => m[1]);
const attr = (a: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(a)?.[1];
const word = (l: Locale, key: string, values: Row = {}): string => createTranslator({ locale: l, messages: messages[l] })(key, values);
const S = (l: Locale) => messages[l].site.signin as Row;
// 32 characters of base64url, the shape Task 6's createAddGoogleLink makes; Redis holds only its sha256
const TOKEN = 'Q2hlY2tpbmctdGhlLWFkZC1saW5rMDEy';
const linkKey = (token: string) => `signin:add-google:${createHash('sha256').update(token).digest('hex')}`;

// ---- The boundaries ----

process.env.SESSION_SECRET = 'smoke-only-session-secret-'.padEnd(64, 'x');
function configure(ways: { telegram?: boolean; google?: boolean; email?: boolean }) {
  // Google sign-in must have its own client: oidc.ts refuses an id equal to the calendar client's GOOGLE_CLIENT_ID (the fake env's 'fake')
  const set = (name: string, on: boolean | undefined) => {
    if (on) process.env[name] = name.startsWith('GOOGLE_SIGNIN') ? 'fake-signin-client' : 'fake';
    else delete process.env[name];
  };
  set('TELEGRAM_LOGIN_CLIENT_ID', ways.telegram);
  set('TELEGRAM_LOGIN_CLIENT_SECRET', ways.telegram);
  set('GOOGLE_SIGNIN_CLIENT_ID', ways.google);
  set('GOOGLE_SIGNIN_CLIENT_SECRET', ways.google);
  set('RESEND_API_KEY', ways.email);
}

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
const jar = new Map<string, string>();
const store = new Map<string, unknown>();
const redisGets: string[] = [];
let redisFails = false;
const users = new Map<number, { id: number; name: string }>([[7, { id: 7, name: 'Dana' }], [8, { id: 8, name: '' }]]);
const lookups: number[] = [];

// Every console line, to see that none holds an address, a code or a token (and that React says nothing)
const logs: string[] = [];
for (const level of ['info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
    original(...args);
  };
}
const ours = (line: string) => /^\[(?:signin|add-google|add-google-page)\]/.test(line);

// ---- The fake fetch ----

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
const lastCall = (path: string) => calls.filter((c) => c.url.split('?')[0] === path).at(-1);

// ---- The fake DOM ----

const assigned: string[] = [];
function visible(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement && node.localName === 'style') return '';
  return node.childNodes.map(visible).join('');
}
// Collapse plain whitespace only: a no-break space stays (Russian binds its one-letter words with one), so the text matches the messages
const flat = (node: FakeNode) => visible(node).replace(/[ \t\r\n\f\v]+/g, ' ').trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const byClass = (m: Mounted, cls: string) => elements(m.container).filter((e) => e.className.split(' ').includes(cls));
const way = (m: Mounted, name: string) => byClass(m, 'site-signin-way').find((e) => e.getAttribute('data-way') === name);
const buttonByText = (m: Mounted, text: string) => elements(m.container).find((e) => e.localName === 'button' && flat(e) === text);
const alerts = (m: Mounted) => elements(m.container).filter((e) => e.getAttribute('role') === 'alert').map(flat);
// The fake DOM keeps attribute names as React wrote them (inputMode); a browser reads HTML attribute names without case
const attrOf = (el: FakeElement, name: string) => [...el.attributes].find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
const inputOf = (m: Mounted) => elements(m.container).find((e) => e.localName === 'input') as FakeElement;
const formOf = (m: Mounted) => elements(m.container).find((e) => e.localName === 'form') as FakeElement;

async function main() {
  stubIntlServer();
  stub(nodeRequire.resolve('next/headers'), { __esModule: true, cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined) }) });
  stub(nodeRequire.resolve('next/navigation'), {
    ...nodeRequire('next/navigation'),
    redirect: (to: string) => {
      throw new Redirected(to);
    },
  });
  stub('src/utils/redis.ts', {
    redis: {
      get: async (key: string) => {
        redisGets.push(key);
        if (redisFails) throw new Error('redis is down');
        return store.get(key) ?? null;
      },
      getdel: async () => {
        throw new Error('the page must never use the link up');
      },
    },
  });
  // The page names the account through the repo's one helper (getUserById)
  stub('src/services/user-service.ts', {
    getUserById: async (id: number) => {
      lookups.push(id);
      return users.get(id) ?? null;
    },
  });
  // add-google.ts (which the page reads the link through) also holds the Google callback's finishing step: its session,
  // identity and notice modules are not under test here and must never run from a page
  const never = (what: string) => async () => {
    throw new Error(`the page must never ${what}`);
  };
  stub('src/lib/web-session.ts', { finishSignIn: never('finish a sign-in'), signInPageUrl: () => '' });
  stub('src/services/web-signin/identities.ts', { addIdentity: never('add a way') });
  stub('src/services/web-signin/notice.ts', { sendSignInNotice: never('send a notice') });

  const { default: SignInPage, generateMetadata, dynamic } = await load('app/[locale]/(site)/signin/page.tsx');
  const { default: AddGooglePage, dynamic: addDynamic } = await load('app/[locale]/(site)/signin/add-google/page.tsx');
  const { SignInClient } = await load('app/[locale]/(site)/signin/SignInClient.tsx');
  const { AddGoogleClient } = await load('app/[locale]/(site)/signin/add-google/AddGoogleClient.tsx');
  const { createSessionToken, SESSION_COOKIE_NAME } = await load('src/lib/session-auth.ts');

  // The server render runs without a browser: the fake window a client check installed (and never removes) is taken away for its length
  const wrap = async (locale: Locale, el: ReactElement) => {
    const g = globalThis as Row;
    const browser = { window: g.window, document: g.document };
    delete g.window;
    delete g.document;
    try {
      return await render(h(AppRouterContext.Provider, { value: router }, h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, el) as unknown as ReactElement));
    } finally {
      if (browser.window) g.window = browser.window;
      if (browser.document) g.document = browser.document;
    }
  };
  async function pageOf(Page: (p: Row) => Promise<ReactElement>, locale: Locale, query: Row = {}): Promise<{ html: string } | { redirect: string }> {
    request.locale = locale;
    try {
      const el = await Page({ params: Promise.resolve({ locale }), searchParams: Promise.resolve(query) });
      return { html: await wrap(locale, el) };
    } catch (err) {
      if (err instanceof Redirected) return { redirect: err.to };
      throw err;
    }
  }
  const htmlOf = async (Page: (p: Row) => Promise<ReactElement>, locale: Locale, query: Row = {}) => {
    const r = await pageOf(Page, locale, query);
    assert('html' in r, `${locale} ${show(query)}: redirected to ${(r as { redirect: string }).redirect}`);
    return r.html;
  };
  const signin = (locale: Locale, query: Row = {}) => htmlOf(SignInPage, locale, query);
  const common = (locale: Locale, html: string, where: string) => {
    assert(html.includes('class="site-header"') && html.includes('class="site-footer"'), `${where} ${locale}: not in the site's chrome`);
    assert(!EMOJI.test(html.replace(/https:\/\/wa\.me\/[^"\s]+/g, '')), `${where} ${locale}: an emoji`);
    assert(!RAW_KEY.test(textOf(html).replace(/famcal\.bot\S*|t\.me\/\S+|wa\.me\/\S+/g, '')), `${where} ${locale}: a raw key in ${textOf(html).match(RAW_KEY)?.[0]}`);
  };
  const ways = (html: string) => attrs(html, '(?:a|button)').filter((a) => /\bsite-signin-way\b/.test(attr(a, 'class') ?? ''));
  /** The markup of the first <a> whose data-way is `name`, up to its </a>. */
  const anchorMarkup = (html: string, name: string) => {
    const at = html.search(new RegExp(`<a [^>]*data-way="${name}"`));
    return at < 0 ? '' : html.slice(at, html.indexOf('</a>', at));
  };

  await check('P1 the ways: only the configured ones, in order (Telegram with its approval note, Google with its G mark, email), each start a plain link to its start route in the page\'s language; none configured says so with the start buttons; per request, noindex', async () => {
    assert(dynamic === 'force-dynamic' && addDynamic === 'force-dynamic', `dynamic: ${dynamic}, ${addDynamic}`);
    for (const locale of LOCALES) {
      const s = S(locale);
      jar.clear();
      configure({ telegram: true, google: true, email: true });
      const all = await signin(locale);
      common(locale, all, '/signin');
      assert(show(ways(all).map((a) => attr(a, 'data-way'))) === show(['telegram', 'google', 'email']), `${locale}: the ways ${show(ways(all).map((a) => attr(a, 'data-way')))}`);
      const href = (name: string) => decodeEntities(attr(ways(all).find((a) => attr(a, 'data-way') === name) ?? '', 'href') ?? '');
      assert(href('telegram') === `/api/auth/telegram/start?locale=${locale}` && href('google') === `/api/auth/google/start?locale=${locale}`, `${locale}: ${href('telegram')} ${href('google')}`);
      const text = textOf(all);
      for (const w of [s.title, s.lead, s.telegram, s.telegramNote, s.google, s.email, s.existingOnly]) assert(text.includes(w), `${locale}: no "${w}"`);
      const google = anchorMarkup(all, 'google');
      assert(google.includes('viewBox="0 0 48 48"') && google.includes('#4285F4') && google.includes('#EA4335'), `${locale}: Google's way has no G mark: ${google}`);
      assert(/class="lucide lucide-send/.test(anchorMarkup(all, 'telegram')), `${locale}: Telegram's way has no Lucide icon`);
      assert(!/role="alert"/.test(all), `${locale}: an alert with no status`);

      configure({ email: true });
      const emailOnly = await signin(locale);
      assert(show(ways(emailOnly).map((a) => attr(a, 'data-way'))) === show(['email']), `${locale}: email only ${show(ways(emailOnly).map((a) => attr(a, 'data-way')))}`);
      assert(!textOf(emailOnly).includes(s.telegramNote), `${locale}: Telegram's note without Telegram`);

      configure({});
      const none = await signin(locale);
      assert(ways(none).length === 0 && textOf(none).includes(s.none) && !textOf(none).includes(s.existingOnly), `${locale}: nothing configured`);
      const starts = attrs(none, 'a').filter((a) => /\bsite-start\b/.test(attr(a, 'class') ?? '') && !/site-starts-compact/.test(a));
      assert(starts.filter((a) => attr(a, 'data-channel')).length >= 4, `${locale}: the start buttons (the header's two and the page's two): ${starts.length}`);
    }
    const meta = await generateMetadata({ params: Promise.resolve({ locale: 'he' }) });
    assert(meta.robots?.index === false && meta.robots?.follow === false && !meta.alternates && meta.title === S('he').metaTitle, `metadata ${show(meta)}`);
  });

  await check('P2 a valid session cookie sends /signin straight to the calendar in the page\'s language; a tampered cookie, the old cookie\'s name, no cookie, or a status in the query renders the page', async () => {
    assert(SESSION_COOKIE_NAME === '__Host-famcal_session', `the cookie is ${SESSION_COOKIE_NAME}`);
    configure({ telegram: true });
    const token = createSessionToken(7, 'google', Date.now());
    for (const locale of LOCALES) {
      jar.clear();
      jar.set(SESSION_COOKIE_NAME, token);
      const r = await pageOf(SignInPage, locale);
      assert('redirect' in r && r.redirect === `/${locale}/dashboard?user_id=7`, `${locale}: ${show(r)}`);
      assert('html' in (await pageOf(SignInPage, locale, { status: 'no-account' })), `${locale}: a status was redirected away`);
      jar.set(SESSION_COOKIE_NAME, `${token.slice(0, -3)}abc`);
      assert('html' in (await pageOf(SignInPage, locale)), `${locale}: a tampered cookie redirected`);
      jar.clear();
      jar.set('famcal_session', token);
      assert('html' in (await pageOf(SignInPage, locale)), `${locale}: the old cookie name redirected`);
      jar.clear();
      assert('html' in (await pageOf(SignInPage, locale)), `${locale}: no cookie redirected`);
    }
  });

  await check('P3 the outcomes in en, he and ru: no account (WhatsApp\'s settings link, new here with the start buttons, another way), several, suspended and blocked (the contact address as a mail link), taken and has-one (a refused Add Google) stand instead of the ways; restart, failed and unavailable are an alert above them; an unknown status is ignored', async () => {
    jar.clear();
    configure({ telegram: true, google: true, email: true });
    for (const locale of LOCALES) {
      const s = S(locale);
      const st = s.status as Row;
      const noAccount = await signin(locale, { status: 'no-account' });
      common(locale, noAccount, 'no-account');
      for (const w of [st.noAccount.title, st.noAccount.body, st.noAccount.whatsapp, st.noAccount.whatsappButton, st.noAccount.newHere, s.retry]) assert(textOf(noAccount).includes(w), `${locale} no-account: no "${w}"`);
      const hrefs = attrs(noAccount, 'a').map((a) => decodeEntities(attr(a, 'href') ?? ''));
      assert(hrefs.includes('https://wa.me/972548524687?text=settings') && hrefs.includes(`${prefix(locale)}/signin`), `${locale} no-account: ${show(hrefs)}`);
      assert(ways(noAccount).length === 0, `${locale} no-account: the ways show`);
      for (const [status, key] of [['several', 'several'], ['suspended', 'suspended'], ['blocked', 'blocked'], ['taken', 'taken'], ['has-one', 'hasOne']] as const) {
        const html = await signin(locale, { status });
        common(locale, html, status);
        assert(textOf(html).includes(st[key].title) && ways(html).length === 0, `${locale} ${status}: ${textOf(html).slice(0, 200)}`);
        if (status === 'suspended' || status === 'blocked') assert(html.includes('href="mailto:privacy@famcal.bot"') && textOf(html).includes('privacy@famcal.bot'), `${locale} ${status}: no contact address`);
        else assert(textOf(html).includes(st[key].body), `${locale} ${status}: the body`);
        assert(attrs(html, 'a').some((a) => decodeEntities(attr(a, 'href') ?? '') === `${prefix(locale)}/signin`), `${locale} ${status}: no way back to the ways`);
      }
      for (const status of ['restart', 'failed', 'unavailable'] as const) {
        const html = await signin(locale, { status });
        assert(new RegExp(`<p class="site-signin-notice" role="alert">${st[status].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`).test(decodeEntities(html)), `${locale} ${status}: no alert`);
        assert(ways(html).length === 3, `${locale} ${status}: the ways are gone`);
      }
      const unknown = await signin(locale, { status: 'nope' });
      assert(!/role="alert"/.test(unknown) && ways(unknown).length === 3, `${locale}: an unknown status shows something`);
    }
  });

  /** The sign-in client in a browser: plain, in Telegram's own browser (inApp), or in the Mini App's webview (miniApp: Telegram.WebApp.initData is set). */
  function openClient(locale: Locale, opts: { inApp?: boolean; miniApp?: boolean } = {}) {
    installWindow();
    assigned.length = 0;
    fakeWindow.location = { hash: '', origin: 'https://famcal.bot', href: 'https://famcal.bot/signin', assign: (u: string) => void assigned.push(u) };
    if (opts.inApp) fakeWindow.TelegramWebviewProxy = {};
    else delete fakeWindow.TelegramWebviewProxy;
    fakeWindow.Telegram = opts.miniApp ? { WebApp: fakeTelegram([], '7.7') } : undefined;
    const props = { ways: { telegram: true, google: true, email: true }, telegramAppUrl: 'https://t.me/family_calendar_telegram_bot?start=dashboard', pageAddress: `famcal.bot${prefix(locale)}/signin` };
    return mount(h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, h(SignInClient, props)) as unknown as ReactElement);
  }

  // P6 renders server pages, so it runs before any client check: the first client mount loads react-dom/client, whose dispatcher
  // then takes over react-dom's preload during a server render (the header's priority image) and the render fails.
  await check('P6 /signin/add-google?token=: names the account (getUserById) and leaves the link unused (read by the token\'s sha256); a used or late link says to start again from Settings; a token that isn\'t one is never looked up; a Redis failure says so; Google not configured says so; the token is in no log line', async () => {
    configure({ google: true });
    for (const locale of LOCALES) {
      const a = S(locale).addGoogle as Row;
      store.clear();
      store.set(linkKey(TOKEN), { userId: 7 });
      redisGets.length = 0;
      const ok = await htmlOf(AddGooglePage, locale, { token: TOKEN });
      common(locale, ok, 'add-google');
      assert(decodeEntities(ok).includes(word(locale, 'site.signin.addGoogle.title', { name: 'Dana' })) && textOf(ok).includes(a.body), `${locale}: the account is not named`);
      assert(store.has(linkKey(TOKEN)) && show(redisGets) === show([linkKey(TOKEN)]), `${locale}: the link was used up or read oddly: ${show(redisGets)}`);
      assert(lookups.at(-1) === 7, `${locale}: the lookup ${show(lookups.at(-1))}`);
      assert(/<button [^>]*data-way="google"/.test(ok) && ok.includes('viewBox="0 0 48 48"'), `${locale}: no Google button`);
      store.set(linkKey(TOKEN), { userId: 8 });
      assert(decodeEntities(await htmlOf(AddGooglePage, locale, { token: TOKEN })).includes(a.titleNoName), `${locale}: a nameless account`);

      store.clear();
      const gone = textOf(await htmlOf(AddGooglePage, locale, { token: TOKEN }));
      assert(gone.includes(a.expiredTitle) && gone.includes(a.expired), `${locale}: a used link ${gone.slice(0, 200)}`);
      redisGets.length = 0;
      for (const t of [undefined, '', '../../etc', 'short', 'Q2hlY2tpbmctdGhlLWFkZC1saW5r', `${TOKEN}x`, ['a', 'b']]) {
        const html = textOf(await htmlOf(AddGooglePage, locale, t === undefined ? {} : { token: t }));
        assert(html.includes(a.expiredTitle), `${locale}: ${show(t)} is not refused`);
      }
      assert(redisGets.length === 0, `${locale}: a token that isn't one was looked up: ${show(redisGets)}`);

      redisFails = true;
      const failed = textOf(await htmlOf(AddGooglePage, locale, { token: TOKEN }));
      redisFails = false;
      assert(failed.includes(a.loadFailed), `${locale}: a Redis failure ${failed.slice(0, 200)}`);

      configure({});
      store.set(linkKey(TOKEN), { userId: 7 });
      const off = await htmlOf(AddGooglePage, locale, { token: TOKEN });
      assert(textOf(off).includes(a.unavailable) && !/data-way="google"/.test(off), `${locale}: Google not configured`);
      configure({ google: true });
    }
    const leaked = logs.filter((l) => l.includes(TOKEN));
    assert(leaked.length === 0, `a log line holds the token: ${show(leaked)}`);
  });

  await check('P4 the email form: the address (trimmed) and the language to the request route, the one answer, the code (digits only) to the verify route, the redirect; wrong, limited, failed, restart, blocked and a failed request each said; the buttons wait while a request is out; no log line holds the address or the code', async () => {
    for (const locale of LOCALES) {
      const s = S(locale);
      const m = openClient(locale);
      try {
        m.click(way(m, 'email') as FakeElement);
        const email = inputOf(m);
        assert(email.getAttribute('type') === 'email' && attrOf(email, 'inputmode') === 'email' && attrOf(email, 'autocomplete') === 'email' && email.getAttribute('dir') === 'ltr', `${locale}: the email field ${show([...email.attributes])}`);
        const submit = () => way(m, 'submit') as FakeElement;
        assert(submit().hasAttribute('disabled'), `${locale}: Send is on with no address`);
        m.input(email, '  dana@gmail.com ');
        let release: (r: Response) => void = () => undefined;
        routes = { 'POST /api/auth/email/request': () => new Promise<Response>((resolve) => void (release = resolve)) };
        m.submit(formOf(m));
        await settle();
        assert(submit().hasAttribute('disabled') && submit().getAttribute('aria-busy') === 'true' && flat(submit()).includes(s.emailSending), `${locale}: no busy state while the request is out`);
        assert(buttonByText(m, s.otherWays)?.hasAttribute('disabled'), `${locale}: Other ways works while the request is out`);
        await act(async () => release(json({ ok: true })));
        await settle();
        const sent = lastCall('/api/auth/email/request');
        assert(sent && show(sent.body) === show({ email: 'dana@gmail.com', locale }) && sent.headers['Content-Type'] === 'application/json' && sent.credentials === 'same-origin', `${locale}: the request ${show(sent)}`);
        assert(flat(m.container).includes(s.emailSent), `${locale}: no generic answer`);
        const code = inputOf(m);
        assert(attrOf(code, 'inputmode') === 'numeric' && attrOf(code, 'autocomplete') === 'one-time-code' && attrOf(code, 'maxlength') === '6', `${locale}: the code field ${show([...code.attributes])}`);
        m.input(code, '12a34567');
        assert(code.value === '123456', `${locale}: the code is ${code.value}`);

        routes = { 'POST /api/auth/email/verify': () => json({ ok: false, error: 'wrong' }, 400) };
        m.submit(formOf(m));
        await settle();
        assert(alerts(m).includes(s.codeWrong) && !submit().hasAttribute('disabled'), `${locale}: wrong: ${show(alerts(m))}`);
        assert(show(lastCall('/api/auth/email/verify')?.body) === show({ code: '123456' }), `${locale}: the verify body`);

        // Too many wrong codes has its own words; a failed check and an answer the page doesn't know say the request failed
        routes = { 'POST /api/auth/email/verify': () => json({ ok: false, error: 'limited' }, 429) };
        m.submit(formOf(m));
        await settle();
        assert(alerts(m).includes(s.codeLimited) && !alerts(m).includes(s.requestFailed) && !submit().hasAttribute('disabled'), `${locale}: limited: ${show(alerts(m))}`);
        for (const [status, body] of [[500, { ok: false, error: 'failed' }], [418, { ok: false, error: 'something-new' }]] as const) {
          routes = { 'POST /api/auth/email/verify': () => json(body, status) };
          m.submit(formOf(m));
          await settle();
          assert(alerts(m).includes(s.requestFailed) && !alerts(m).includes(s.codeLimited), `${locale}: ${body.error}: ${show(alerts(m))}`);
        }

        routes = { 'POST /api/auth/email/verify': () => json({ ok: true, redirect: 'https://evil.example/x' }) };
        m.submit(formOf(m));
        await settle();
        assert(assigned.length === 0 && alerts(m).includes(s.requestFailed), `${locale}: a redirect off the site was followed: ${show(assigned)}`);

        routes = { 'POST /api/auth/email/verify': () => json({ ok: true, redirect: `/${locale}/dashboard?user_id=7` }) };
        m.submit(formOf(m));
        await settle();
        assert(show(assigned) === show([`/${locale}/dashboard?user_id=7`]), `${locale}: the redirect ${show(assigned)}`);
      } finally {
        m.unmount();
      }

      // A restart goes back to the address (kept), a blocked account to its page, a failed request says so
      const r = openClient(locale);
      try {
        r.click(way(r, 'email') as FakeElement);
        r.input(inputOf(r), 'dana@gmail.com');
        routes = { 'POST /api/auth/email/request': () => json({}, 500) };
        r.submit(formOf(r));
        await settle();
        assert(alerts(r).includes(s.requestFailed) && inputOf(r).getAttribute('type') === 'email', `${locale}: a failed request: ${show(alerts(r))}`);
        routes = {
          'POST /api/auth/email/request': () => {
            throw new TypeError('Failed to fetch');
          },
        };
        r.submit(formOf(r));
        await settle();
        assert(alerts(r).includes(s.requestFailed) && !(way(r, 'submit') as FakeElement).hasAttribute('disabled'), `${locale}: a network failure`);
        routes = { 'POST /api/auth/email/request': () => json({ ok: true }) };
        r.submit(formOf(r));
        await settle();
        // Send a new code: the same address again
        const before = calls.length;
        r.click(buttonByText(r, s.codeAgain) as FakeElement);
        await settle();
        assert(calls.length === before + 1 && show(lastCall('/api/auth/email/request')?.body) === show({ email: 'dana@gmail.com', locale }), `${locale}: a new code`);
        r.input(inputOf(r), '654321');
        routes = { 'POST /api/auth/email/verify': () => json({ ok: false, error: 'restart' }, 400) };
        r.submit(formOf(r));
        await settle();
        assert(inputOf(r).getAttribute('type') === 'email' && inputOf(r).value === 'dana@gmail.com' && alerts(r).includes(s.codeRestart), `${locale}: restart ${show(alerts(r))}`);
        // Back at the address, ask again (the request route answers), then the code
        routes = { 'POST /api/auth/email/request': () => json({ ok: true }) };
        r.submit(formOf(r));
        await settle();
        r.input(inputOf(r), '654321');
        routes = { 'POST /api/auth/email/verify': () => json({ ok: false, error: 'blocked' }, 403) };
        r.submit(formOf(r));
        await settle();
        assert(show(assigned) === show([`${prefix(locale)}/signin?status=blocked`]), `${locale}: blocked ${show(assigned)}`);
      } finally {
        r.unmount();
      }
    }
    const leaked = logs.filter((l) => /dana@gmail\.com|123456|654321/.test(l));
    assert(leaked.length === 0, `a log line holds the address or a code: ${show(leaked)}`);
  });

  await check('P5 inside Telegram, in its own browser and in the Mini App\'s webview: no OIDC flow starts; the Telegram way is Telegram\'s app link with its own note, Google says to open the page in a browser and shows its address (no Google link), email still works; outside Telegram both start routes are linked', async () => {
    const appLink = 'https://t.me/family_calendar_telegram_bot?start=dashboard';
    for (const locale of LOCALES) {
      const s = S(locale);
      for (const where of ['browser', 'miniapp'] as const) {
        calls.length = 0;
        const m = openClient(locale, where === 'browser' ? { inApp: true } : { miniApp: true });
        try {
          const telegram = way(m, 'telegram') as FakeElement;
          assert(telegram.getAttribute('href') === appLink && flat(telegram) === s.telegramInApp, `${locale} ${where}: Telegram ${telegram.getAttribute('href')} "${flat(telegram)}"`);
          assert(flat(m.container).includes(s.telegramInAppNote) && !flat(m.container).includes(s.telegramNote), `${locale} ${where}: Telegram's note`);
          assert(!way(m, 'google'), `${locale} ${where}: a Google link inside Telegram`);
          const notice = byClass(m, 'site-signin-notice')[0];
          assert(notice && flat(notice).includes(s.googleInApp) && flat(notice).includes(`famcal.bot${prefix(locale)}/signin`), `${locale} ${where}: Google's notice ${notice && flat(notice)}`);
          assert(way(m, 'email'), `${locale} ${where}: no email way`);
          // No OIDC flow: no link to a start route anywhere, and tapping Telegram's way asks the server for nothing and navigates nowhere in this page
          const starts = elements(m.container).filter((e) => (e.getAttribute('href') ?? '').startsWith('/api/auth/'));
          assert(starts.length === 0, `${locale} ${where}: a start route is linked: ${show(starts.map((e) => e.getAttribute('href')))}`);
          m.click(telegram);
          await settle();
          assert(calls.length === 0 && assigned.length === 0, `${locale} ${where}: a tap started something: ${show(calls.map((c) => c.url))} ${show(assigned)}`);
        } finally {
          m.unmount();
          delete fakeWindow.TelegramWebviewProxy;
          fakeWindow.Telegram = undefined;
        }
      }
    }
    // The contrast: in a plain browser the same page links both start routes, so the check above cannot pass for a page that never renders them
    const plain = openClient('en');
    try {
      assert(way(plain, 'telegram')?.getAttribute('href') === '/api/auth/telegram/start?locale=en' && way(plain, 'google')?.getAttribute('href') === '/api/auth/google/start?locale=en', 'a plain browser does not link the start routes');
    } finally {
      plain.unmount();
    }
  });

  await check('P6b /signin/add-google Continue (real React): posts the token and goes to Google; a failure says so and the button works again; a late link at Continue says to start again from Settings; the token is in no log line', async () => {
    configure({ google: true });
    for (const locale of LOCALES) {
      const a = S(locale).addGoogle as Row;
      // Continue
      installWindow();
      assigned.length = 0;
      fakeWindow.location = { hash: '', origin: 'https://famcal.bot', href: 'https://famcal.bot/signin', assign: (u: string) => void assigned.push(u) };
      const m = mount(h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, h(AddGoogleClient, { token: TOKEN })) as unknown as ReactElement);
      try {
        const button = () => way(m, 'google') as FakeElement;
        routes = { 'POST /api/auth/google/add-start': () => json({ error: 'internal' }, 500) };
        m.click(button());
        await settle();
        assert(alerts(m).includes(a.failed) && !button().hasAttribute('disabled'), `${locale}: a failure ${show(alerts(m))}`);
        routes = { 'POST /api/auth/google/add-start': () => json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }) };
        m.click(button());
        await settle();
        const posted = lastCall('/api/auth/google/add-start');
        assert(posted && show(posted.body) === show({ token: TOKEN }) && posted.headers['Content-Type'] === 'application/json', `${locale}: add-start ${show(posted)}`);
        assert(show(assigned) === show(['https://accounts.google.com/o/oauth2/v2/auth?client_id=x']), `${locale}: Google ${show(assigned)}`);
      } finally {
        m.unmount();
      }
      // A link that went late between the page and Continue (the button stays busy once Google is being opened, so this is a page of its own)
      for (const status of [410, 404]) {
        routes = { 'POST /api/auth/google/add-start': () => json({ error: 'expired' }, status) };
        const again = mount(h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, h(AddGoogleClient, { token: TOKEN })) as unknown as ReactElement);
        try {
          again.click(way(again, 'google') as FakeElement);
          await settle();
          assert(alerts(again).includes(a.expired) && !way(again, 'google'), `${locale}: a late link (${status}) at Continue ${show(alerts(again))}`);
        } finally {
          again.unmount();
        }
      }
    }
    const leaked = logs.filter((l) => l.includes(TOKEN));
    assert(leaked.length === 0, `a log line holds the token: ${show(leaked)}`);
  });

  await check('P7 the CSS: the kit\'s lint; the fields 16 px or more; every way, link, field and the header\'s Sign in at least 44 px; Google\'s button in Google\'s colours as tokens, light and dark, with its label readable (4.5:1); the spinner only without reduced motion', async () => {
    const { SITE_CSS, GOOGLE_BUTTON } = await load('src/site/site-css.ts');
    const { APP_THEME_CSS } = await load('components/app-ui/theme.ts');
    const own: string = SITE_CSS.slice(APP_THEME_CSS.length);
    assert(lintCss(own).length === 0, show(lintCss(own)));
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(own)?.[1];
    const px = (body: string | undefined, property: string) => Number(new RegExp(`(?:^|[\\s;])${property}:\\s*(\\d+)px`).exec(body ?? '')?.[1] ?? NaN);
    for (const selector of ['.site-field', '.site-field-code']) assert(px(rule(selector), 'font-size') >= 16, `${selector}: ${rule(selector)}`);
    for (const selector of ['.site-signin-way', '.site-signin-link', '.site-field', '.site-signin-header']) assert(px(rule(selector), 'min-block-size') >= 44, `${selector}: ${rule(selector)}`);
    assert(show(GOOGLE_BUTTON) === show({ light: { bg: '#ffffff', text: '#1f1f1f', border: '#747775' }, dark: { bg: '#131314', text: '#e3e3e3', border: '#8e918f' } }), `Google's colours ${show(GOOGLE_BUTTON)}`);
    const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/.exec(own)?.[1] ?? '';
    for (const [name, value] of [['bg', GOOGLE_BUTTON.light.bg], ['text', GOOGLE_BUTTON.light.text], ['border', GOOGLE_BUTTON.light.border]]) assert(own.includes(`--site-google-${name}: ${value};`), `light --site-google-${name}`);
    for (const [name, value] of [['bg', GOOGLE_BUTTON.dark.bg], ['text', GOOGLE_BUTTON.dark.text], ['border', GOOGLE_BUTTON.dark.border]]) assert(dark.includes(`--site-google-${name}: ${value};`), `dark --site-google-${name}`);
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const theme of ['light', 'dark'] as const) assert(ratio(GOOGLE_BUTTON[theme].text, GOOGLE_BUTTON[theme].bg) >= 4.5, `${theme}: Google's label at ${ratio(GOOGLE_BUTTON[theme].text, GOOGLE_BUTTON[theme].bg).toFixed(2)}:1`);
    assert(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.site-spin \{\s*animation:/.test(own) && !/(?:^|\n)\.site-spin \{/.test(own), 'the spinner turns under reduced motion');
  });

  await check('P8 React and the pages logged nothing of their own beyond the expected request failures', () => {
    const unexpected = logs.filter((l) => !ours(l) && !l.startsWith('Detected multiple renderers') && !l.startsWith('(node:'));
    assert(unexpected.length === 0, show(unexpected.slice(0, 5)));
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
