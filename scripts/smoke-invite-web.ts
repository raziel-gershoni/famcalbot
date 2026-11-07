// Smoke test for the partner invite on the web (web sign-up spec 2026-11-03 §2.14, §3.7; plan 6c-1 Task 11).
//
// What it pins:
//   - the landing for an invite is /{locale}/invite/{token}, with no user_id, and every other finish is the calendar
//     (Task 4's smoke pins cleanInviteToken itself);
//   - a browser signed in on famcal.bot accepts with its cookie (no initData): the pairing is made and the inviter told;
//     a session that was ended gets 401 with the cookie cleared, and one for another account 401, with nothing paired;
//   - Accept and the invite's own POST and DELETE come only from famcal.bot (another Origin, or none: 403), and a
//     same-site invite still works;
//   - an inviter with no chat: the accept works, nothing is sent, and the skip is logged; the chat accept's notice
//     failure is logged too (no empty catch);
//   - signed out, the round trip lands on the invite through each way: Telegram and Google (the invite in the start
//     route's flow record), an email code (in the email flow's record), and a sign-up by email and by Google (carried
//     into the sign-up record); never in the provider's URL or a cookie's value;
//   - a token that is not one is dropped at the start (Telegram, Google, email) and the finish is the calendar;
//   - an invite revoked, or accepted by someone else, while its visitor signs up: the account is still made, with no
//     pairing, and lands on the invite, whose page then shows its invalid card (Review Focus 4);
//   - the token is in no console line and no capture; Sentry drops it from URLs, queries, JSON and form bodies, the
//     invite page's path, breadcrumbs and transaction names.
//
// Real: the pair routes, pairing-service (getInviteByToken, the invite page's one read), pair-handler, the start, callback, request, verify and sign-up routes,
// oidc-route, flow, the email code and its email, identities, google-signin, createAccount, finishSignIn, the session
// cookie, verifyUserAuth, the Origin guard, the limits, the Sentry scrubber. Faked at the boundaries
// (scripts/lib/signin-world.ts): Prisma and Redis in memory, the rate limiter, error capture, Telegram and WhatsApp
// (every send recorded), the OIDC exchange (scripted claims), analytics, fetch (Resend answered and recorded). No
// network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-invite-web

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import {
  assert, baseUser, body, check, DB, drainAfter, everyCapture, everyLog, flowCookie, identityRow, initDataFor, installSigninWorld,
  load, logs, mails, redisStore, report, request, resetWorld, ROOT, sent, sessionCookie, show, stubModule, world, type Row,
} from './lib/signin-world';

const TAL = 9; // Telegram, English: the inviter
const TAL_TG = 111111111;
const NOA = 7; // made on famcal.bot, Google and email ways, Russian, no chat
const DANA = 42; // made on famcal.bot, an email way, Hebrew, no chat
const TOKEN = 'a1'.repeat(32); // an invite token as createInvite makes it: 64 lowercase hex
const DAY = 86_400_000;

function seed(o: { inviter?: number } = {}): void {
  resetWorld();
  DB.user = [
    baseUser({ id: TAL, name: 'Tal', telegramId: BigInt(TAL_TG) }),
    baseUser({ id: NOA, name: 'Noa', language: 'ru', location: '' }),
    baseUser({ id: DANA, name: 'Dana', language: 'he', location: '' }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: NOA, kind: 'email', subject: 'noa@example.com', address: 'noa@example.com' }),
    identityRow({ userId: NOA, kind: 'google', subject: 'g-noa', address: 'noa@gmail.com' }),
    identityRow({ userId: DANA, kind: 'email', subject: 'dana@example.com', address: 'dana@example.com' }),
  ];
  DB.pairingInvite = [{
    id: 'inv-1', token: TOKEN, inviterUserId: o.inviter ?? TAL, createdAt: new Date(Date.now() - DAY),
    expiresAt: new Date(Date.now() + 6 * DAY), acceptedAt: null, revokedAt: null, acceptedByUserId: null,
  }];
  DB.pairing = [];
  DB.nativeCalendar = [];
}
const userRow = (id: number): Row => DB.user.find(u => u.id === id) as Row;
const location = (res: Row): string => res.headers.get('location') ?? '';
const pathOf = (url: string): string => {
  const u = new URL(url, 'https://famcal.bot');
  return `${u.pathname}${u.search}`;
};
/** The sign-in flow records in Redis (one per start), as stored */
const flowRecords = (): Row[] => [...redisStore.entries()].filter(([k]) => k.startsWith('signin:flow:')).map(([, v]) => JSON.parse(v));
function cookieOf(res: Row, name: string): string {
  const value = res.cookies.get(name)?.value;
  assert(value, `no ${name} cookie on the answer`);
  return `${name}=${value}`;
}
function codeIn(mail: Row | undefined): string {
  const m = /\b(\d{6})\b/.exec(JSON.stringify(mail?.body ?? {}));
  assert(m, `no 6-digit code in the mail: ${show(mail?.body)}`);
  return m[1];
}

async function main() {
  await installSigninWorld();
  stubModule('src/services/analytics-service.ts', {
    addBreadcrumb: () => undefined,
    setUserContext: () => undefined,
    trackActivityAsync: () => undefined,
    trackActivity: async () => undefined,
    ACTIVITY_RETENTION_DAYS: 90,
    ACTIVITY_PURGE_BATCH: 5000,
    purgeOldActivity: async () => 0,
  });
  const accept = await load('app/api/pair/accept/route.ts');
  const inviteRoute = await load('app/api/pair/invite/route.ts');
  const tgStart = await load('app/api/auth/telegram/start/route.ts');
  const tgCallback = await load('app/api/auth/telegram/callback/route.ts');
  const gStart = await load('app/api/auth/google/start/route.ts');
  const gCallback = await load('app/api/auth/google/callback/route.ts');
  const emailRequest = await load('app/api/auth/email/request/route.ts');
  const emailVerify = await load('app/api/auth/email/verify/route.ts');
  const signupRoute = await load('app/api/auth/signup/route.ts');
  const { SESSION_COOKIE_NAME, validateSessionToken } = await load('src/lib/session-auth.ts');
  const { SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');
  const { issueCode } = await load('src/services/web-signin/email-code.ts');
  const { emailKey, normalizeEmail } = await load('src/services/web-signin/email-address.ts');
  const scrub = await load('src/lib/sentry-scrub.ts');
  const { getInviteByToken } = await load('src/services/pairing-service.ts');
  // The invite page itself (W13): its translator and the request's cookies are the only things it takes from Next
  const nodeRequire = createRequire(__filename);
  const messages: Row = Object.fromEntries(['en', 'he', 'ru'].map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${l}.json`), 'utf8'))]));
  const { createTranslator } = nodeRequire('next-intl');
  stubModule(path.relative(ROOT, nodeRequire.resolve('next-intl/server')), {
    __esModule: true,
    getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => createTranslator({ locale, namespace, messages: messages[locale] }),
  });
  stubModule(path.relative(ROOT, nodeRequire.resolve('next/headers')), {
    __esModule: true,
    cookies: async () => ({ get: () => undefined }),
  });
  const InvitePage = (await load('app/[locale]/(app)/invite/[token]/page.tsx')).default as (props: Row) => Promise<import('react').ReactElement>;

  const acceptAs = (userId: number, auth: { cookie?: string; initData?: string }, extra: Row = {}) =>
    accept.POST(request(`/api/pair/accept?user_id=${userId}`, { body: { token: TOKEN }, cookie: auth.cookie, initData: auth.initData, ...extra }));
  /** A start route, then the provider's answer to its callback: the start's answer, the flow records it made, the callback's answer */
  async function startThenBack(provider: 'telegram' | 'google', query: string) {
    const start = await (provider === 'telegram' ? tgStart : gStart).GET(request(`/api/auth/${provider}/start?${query}`));
    const state = new URL(location(start)).searchParams.get('state') ?? '';
    const cookie = cookieOf(start, SIGNIN_COOKIE_NAME);
    const records = flowRecords();
    const back = await (provider === 'telegram' ? tgCallback : gCallback).GET(request(`/api/auth/${provider}/callback?code=c-1&state=${encodeURIComponent(state)}`, { cookie }));
    return { start, cookie, records, back };
  }
  /** "Email me a code" with this body, the mail it sent after the answer, then the code back: the verify's answer and body */
  async function emailRoundTrip(requestBody: Row) {
    const asked = await emailRequest.POST(request('/api/auth/email/request', { body: requestBody }));
    assert(asked.status === 200 && (await body(asked)).ok === true, `the request: ${asked.status} ${show(await body(asked))}`);
    const cookie = cookieOf(asked, SIGNIN_COOKIE_NAME);
    const records = flowRecords();
    await drainAfter();
    const verified = await emailVerify.POST(request('/api/auth/email/verify', { body: { code: codeIn(mails.at(-1)) }, cookie }));
    return { records, verified, answer: await body(verified) };
  }

  await check('W1 an invite lands on /{locale}/invite/{token} with no user_id, anything else on the calendar (a token that is not one is no invite)', async () => {
    const { appPageUrl, landingPage } = await load('src/lib/web-session.ts');
    assert(appPageUrl('he', { invite: TOKEN }, 7) === `https://famcal.bot/he/invite/${TOKEN}`, appPageUrl('he', { invite: TOKEN }, 7));
    assert(appPageUrl('en', { invite: TOKEN }, 7) === `https://famcal.bot/en/invite/${TOKEN}`, 'English has no prefix');
    assert(show(landingPage(TOKEN)) === show({ invite: TOKEN }) && landingPage(undefined) === 'dashboard' && landingPage('nope') === 'dashboard', 'landingPage');
  });

  await check('W2 a browser signed in on famcal.bot accepts with its cookie alone (no initData): the pairing is made, the answer names the inviter, the inviter is told in Telegram', async () => {
    seed();
    const res = await acceptAs(NOA, { cookie: await sessionCookie(NOA, 'google') });
    const b = await body(res);
    assert(res.status === 200 && b.success === true && b.partner?.name === 'Tal', `${res.status} ${show(b)}`);
    const pairing = DB.pairing[0];
    assert(DB.pairing.length === 1 && pairing.status === 'ACTIVE' && pairing.inviterUserId === TAL && pairing.inviteeUserId === NOA, `pairings ${show(DB.pairing)}`);
    assert(userRow(TAL).pairingId === pairing.id && userRow(NOA).pairingId === pairing.id, 'the two are not linked');
    assert(sent.length === 1 && sent[0].chatId === String(TAL_TG), `sent ${show(sent)}`);
  });

  await check('W3 a session that was ended gets 401 with the session cookie cleared, and a session for another account 401; nothing is paired', async () => {
    seed();
    userRow(NOA).sessionsValidAfter = new Date();
    const ended = await acceptAs(NOA, { cookie: await sessionCookie(NOA, 'google') });
    assert(ended.status === 401 && ended.cookies.get(SESSION_COOKIE_NAME)?.value === '', `ended: ${ended.status} ${show(ended.cookies.get(SESSION_COOKIE_NAME))}`);
    userRow(NOA).sessionsValidAfter = null;
    const other = await acceptAs(NOA, { cookie: await sessionCookie(DANA, 'email') });
    assert(other.status === 401, `another account's cookie: ${other.status}`);
    assert(DB.pairing.length === 0 && DB.pairingInvite[0].acceptedAt === null, `paired ${show(DB.pairing)}`);
  });

  await check('W4 Accept, and the invite\'s POST and DELETE, come only from famcal.bot: another Origin or none is 403 with nothing changed; a same-site invite still works', async () => {
    seed();
    const cookie = await sessionCookie(NOA, 'google');
    const evil = await acceptAs(NOA, { cookie }, { origin: 'https://evil.example' });
    assert(evil.status === 403 && (await body(evil)).error === 'cross_site', `accept from another site: ${evil.status} ${show(await body(evil))}`);
    const bare = await acceptAs(NOA, { cookie }, { origin: null });
    assert(bare.status === 403, `accept with no Origin: ${bare.status}`);
    assert(DB.pairing.length === 0 && DB.pairingInvite[0].acceptedAt === null, 'a refused accept paired');
    const dana = await sessionCookie(DANA, 'email');
    const make = await inviteRoute.POST(request(`/api/pair/invite?user_id=${DANA}`, { body: {}, cookie: dana, origin: 'https://evil.example' }));
    assert(make.status === 403 && DB.pairingInvite.length === 1, `invite POST from another site: ${make.status}, ${DB.pairingInvite.length} invites`);
    const revoke = await inviteRoute.DELETE(request(`/api/pair/invite?user_id=${TAL}`, { method: 'DELETE', body: {}, initData: initDataFor(TAL_TG), origin: 'https://evil.example' }));
    assert(revoke.status === 403 && DB.pairingInvite[0].revokedAt === null, `invite DELETE from another site: ${revoke.status}`);
    const own = await inviteRoute.POST(request(`/api/pair/invite?user_id=${DANA}`, { body: {}, cookie: dana }));
    const ownBody = await body(own);
    assert(own.status === 200 && ownBody.success === true && String(ownBody.url).includes('/he/invite/'), `a same-site invite: ${own.status} ${show(ownBody)}`);
  });

  await check('W5 an inviter with no chat: the accept works, nothing is sent, and the skip is logged; the chat accept logs a failed notice (no empty catch)', async () => {
    seed({ inviter: DANA });
    const res = await acceptAs(TAL_TG, { initData: initDataFor(TAL_TG) });
    assert(res.status === 200 && (await body(res)).success === true, `${res.status} ${show(await body(res))}`);
    assert(sent.length === 0, `sent ${show(sent)}`);
    assert(logs.some(l => l === `[pair] inviter ${DANA} has no chat; accept notice not sent`), `logs ${show(logs)}`);
    const handler = fs.readFileSync(path.join(ROOT, 'src/services/telegram/pair-handler.ts'), 'utf8');
    assert(!/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(handler), 'pair-handler.ts still has an empty .catch(() => {})');
  });

  await check('W6 signed out, through Telegram: the start route keeps the invite in its flow record (not in Telegram\'s URL, not as the cookie), and the callback signs in and lands on /en/invite/<token>', async () => {
    seed();
    world.claims = { telegramId: BigInt(TAL_TG) };
    const { start, cookie, records, back } = await startThenBack('telegram', `locale=en&invite=${TOKEN}`);
    assert(records.length === 1 && records[0].invite === TOKEN, `the record ${show(records)}`);
    assert(!location(start).includes(TOKEN) && !cookie.includes(TOKEN), `the token rode the redirect or the cookie: ${location(start)}`);
    assert(pathOf(location(back)) === `/en/invite/${TOKEN}`, `landed on ${location(back)}`);
    const session = validateSessionToken(back.cookies.get(SESSION_COOKIE_NAME)?.value ?? '');
    assert(session?.userId === TAL && session.method === 'tg', `session ${show(session)}`);
  });

  await check('W7 signed out, through Google (an account with a Google way): lands on /ru/invite/<token>', async () => {
    seed();
    world.claims = { sub: 'g-noa', email: 'noa@gmail.com', emailVerified: true };
    const { records, back } = await startThenBack('google', `locale=ru&invite=${TOKEN}`);
    assert(records[0]?.invite === TOKEN && pathOf(location(back)) === `/ru/invite/${TOKEN}`, `${show(records)} → ${location(back)}`);
    assert(validateSessionToken(back.cookies.get(SESSION_COOKIE_NAME)?.value ?? '')?.userId === NOA, 'not signed in as Noa');
  });

  await check('W8 signed out, through an email code: the request keeps the invite in the email flow\'s record, and the right code lands on /ru/invite/<token>', async () => {
    seed();
    const { records, verified, answer } = await emailRoundTrip({ email: 'noa@example.com', locale: 'ru', invite: TOKEN });
    assert(records.length === 1 && records[0].kind === 'email' && records[0].invite === TOKEN, `the record ${show(records)}`);
    assert(answer.ok === true && pathOf(String(answer.redirect)) === `/ru/invite/${TOKEN}`, `${verified.status} ${show(answer)}`);
  });

  await check('W9 signed out, a sign-up by email: the right sign-up code carries the invite into the sign-up record, and Create account lands on /he/invite/<token>', async () => {
    seed();
    const address = 'shira@example.com';
    const key = emailKey(normalizeEmail(address));
    await issueCode({ purpose: 'signup', emailKey: key, address, userId: null, locale: 'he' });
    const cookie = await flowCookie({ kind: 'email', emailKey: key, locale: 'he', invite: TOKEN });
    const verified = await emailVerify.POST(request('/api/auth/email/verify', { body: { code: codeIn(mails.at(-1)) }, cookie }));
    const v = await body(verified);
    assert(v.ok === true && pathOf(String(v.redirect)) === '/he/signup', `the code: ${verified.status} ${show(v)}`);
    assert(flowRecords().some(r => r.kind === 'signup' && r.invite === TOKEN), `the sign-up record ${show(flowRecords())}`);
    const made = await signupRoute.POST(request('/api/auth/signup', { body: { name: 'Shira', gender: 'female' }, cookie: cookieOf(verified, SIGNIN_COOKIE_NAME) }));
    const m = await body(made);
    assert(m.ok === true && pathOf(String(m.redirect)) === `/he/invite/${TOKEN}`, `Create account: ${made.status} ${show(m)}`);
  });

  await check('W10 signed out, a sign-up with Google: the callback carries the invite into the sign-up record, and Create account lands on /he/invite/<token>', async () => {
    seed();
    world.claims = { sub: 'g-new', email: 'new.person@gmail.com', emailVerified: true };
    const { back } = await startThenBack('google', `locale=he&invite=${TOKEN}`);
    assert(new URL(location(back), 'https://famcal.bot').pathname === '/he/signup', `the callback went to ${location(back)}`);
    assert(flowRecords().some(r => r.kind === 'signup' && r.invite === TOKEN), `the sign-up record ${show(flowRecords())}`);
    const made = await signupRoute.POST(request('/api/auth/signup', { body: { name: 'Avi', gender: 'male' }, cookie: cookieOf(back, SIGNIN_COOKIE_NAME) }));
    const m = await body(made);
    assert(m.ok === true && pathOf(String(m.redirect)) === `/he/invite/${TOKEN}`, `Create account: ${made.status} ${show(m)}`);
  });

  await check('W11 a token that is not one is dropped at every start (Telegram, Google, email): no invite in the record, and the finish is the calendar', async () => {
    for (const bad of [TOKEN.toUpperCase(), TOKEN.slice(2), '..%2Fdashboard', '%2F%2Fevil.example']) {
      seed();
      world.claims = { telegramId: BigInt(TAL_TG) };
      const t = await startThenBack('telegram', `locale=en&invite=${bad}`);
      assert(t.records.length === 1 && !('invite' in t.records[0]) && pathOf(location(t.back)) === `/en/dashboard?user_id=${TAL}`, `Telegram ${bad}: ${show(t.records)} → ${location(t.back)}`);
      seed();
      world.claims = { sub: 'g-noa', email: 'noa@gmail.com', emailVerified: true };
      const g = await startThenBack('google', `locale=ru&invite=${bad}`);
      assert(!('invite' in g.records[0]) && pathOf(location(g.back)) === `/ru/dashboard?user_id=${NOA}`, `Google ${bad}: ${location(g.back)}`);
    }
    seed();
    const e = await emailRoundTrip({ email: 'noa@example.com', locale: 'ru', invite: TOKEN.toUpperCase() });
    assert(!('invite' in e.records[0]) && pathOf(String(e.answer.redirect)) === `/ru/dashboard?user_id=${NOA}`, `email: ${show(e.records)} → ${show(e.answer)}`);
  });

  await check('W12 Sentry drops the token: from a URL and its query (string, object, pairs), a JSON or form body (and cut-off JSON), the invite page\'s path, the transaction name and the browser\'s breadcrumbs; the rest is kept', () => {
    const event = scrub.scrubServerEvent({
      request: {
        url: `https://famcal.bot/api/auth/google/start?locale=he&invite=${TOKEN}`,
        query_string: `locale=he&invite=${TOKEN}&invited=1`,
        data: JSON.stringify({ email: 'x@example.com', locale: 'he', invite: TOKEN }),
      },
      contexts: { nextjs: { request_path: `/he/invite/${TOKEN}` } },
    });
    assert(!show(event).includes(TOKEN), `the server event: ${show(event)}`);
    assert(String(event.request.query_string).includes('locale=he') && String(event.request.query_string).includes('invited=1'), `the rest: ${event.request.query_string}`);
    const obj = scrub.scrubServerEvent({ request: { query_string: { invite: TOKEN, locale: 'ru' } } }).request.query_string;
    assert(show(obj) === show({ invite: '[scrubbed]', locale: 'ru' }), `object ${show(obj)}`);
    const pairs = scrub.scrubServerEvent({ request: { query_string: [['invite', TOKEN], ['locale', 'ru']] } }).request.query_string;
    assert(show(pairs) === show([['invite', '[scrubbed]'], ['locale', 'ru']]), `pairs ${show(pairs)}`);
    for (const data of [`invite=${TOKEN}&locale=he`, `{"locale":"he","invite":"${TOKEN}`]) {
      const out = scrub.scrubServerEvent({ request: { data } }).request.data;
      assert(!String(out).includes(TOKEN) && String(out).includes('locale'), `body ${show(out)}`);
    }
    assert(scrub.scrubUrl(`https://famcal.bot/he/invite/${TOKEN}`) === 'https://famcal.bot/he/invite/[scrubbed]', scrub.scrubUrl(`https://famcal.bot/he/invite/${TOKEN}`));
    const transaction = scrub.scrubServerTransaction({ transaction: `GET /he/invite/${TOKEN}` });
    assert(transaction.transaction === 'GET /he/invite/[scrubbed]', `transaction ${transaction.transaction}`);
    const browser = scrub.scrubBrowserEvent({
      request: { url: `https://famcal.bot/invite/${TOKEN}` },
      breadcrumbs: [
        { category: 'navigation', data: { from: '/signin', to: `/he/invite/${TOKEN}` } },
        { category: 'fetch', data: { url: `/api/auth/telegram/start?locale=he&invite=${TOKEN}` } },
      ],
    });
    assert(!show(browser).includes(TOKEN), `the browser event: ${show(browser)}`);
  });

  await check('W13 an invite revoked, or accepted by someone else, while its visitor signs up with Google: Create account still makes the account, with no pairing, and lands on /he/invite/<token>, whose page shows its invalid card (getInviteByToken answers null)', async () => {
    for (const ending of ['revoked', 'used'] as const) {
      seed();
      world.claims = { sub: `g-${ending}`, email: `${ending}.person@gmail.com`, emailVerified: true };
      const { back } = await startThenBack('google', `locale=he&invite=${TOKEN}`);
      assert(new URL(location(back), 'https://famcal.bot').pathname === '/he/signup', `${ending}: the callback went to ${location(back)}`);
      if (ending === 'revoked') {
        DB.pairingInvite[0].revokedAt = new Date();
      } else {
        const taken = await acceptAs(DANA, { cookie: await sessionCookie(DANA, 'email') });
        assert(taken.status === 200 && (await body(taken)).success === true, `Dana's accept: ${taken.status} ${show(await body(taken))}`);
      }
      const pairings = DB.pairing.length;
      const made = await signupRoute.POST(request('/api/auth/signup', { body: { name: 'Avi', gender: 'male' }, cookie: cookieOf(back, SIGNIN_COOKIE_NAME) }));
      const m = await body(made);
      assert(m.ok === true && pathOf(String(m.redirect)) === `/he/invite/${TOKEN}`, `${ending}: Create account ${made.status} ${show(m)}`);
      const fresh = DB.user.filter(u => ![TAL, NOA, DANA].includes(u.id));
      assert(fresh.length === 1 && !fresh[0].pairingId, `${ending}: the new account ${show(fresh)}`);
      assert(DB.pairing.length === pairings && !DB.pairing.some(p => p.inviteeUserId === fresh[0].id || p.inviterUserId === fresh[0].id), `${ending}: paired ${show(DB.pairing)}`);
      assert((await getInviteByToken(TOKEN)) === null, `${ending}: the invite page would still offer Accept`);
      // End to end: the page Create account landed on renders the invalid card, with its way home, and no Accept
      const el = await InvitePage({ params: Promise.resolve({ locale: 'he', token: TOKEN }) });
      const html = renderToString(createElement(NextIntlClientProvider, { locale: 'he', messages: messages.he, timeZone: 'Asia/Jerusalem' } as never, el));
      const invalid = messages.he.invite.invalid;
      assert(html.includes('role="alert"') && html.includes(invalid.title) && html.includes('href="/he"') && html.includes(invalid.home), `${ending}: the page did not render the invalid card: ${html.slice(0, 300)}`);
      assert(!html.includes(TOKEN), `${ending}: the invalid page holds the token`);
    }
  });

  await check('W14 no console line or capture of the run holds the token', () => {
    const lines = everyLog.filter(l => l.includes(TOKEN));
    const reports = everyCapture.filter(c => show(c).includes(TOKEN));
    assert(lines.length === 0 && reports.length === 0, `leaked: ${show(lines)} ${show(reports)}`);
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
