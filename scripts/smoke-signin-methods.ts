// Smoke test for the sign-in ways in Settings (web sign-in spec 2026-11-02 §2.9, §2.10, §2.12, §2.13, §4; plan Task 6):
// GET /api/signin-methods, Add email (a code to the address; the way is made only when the code is right, and refused
// then when another account holds the address), Remove (every web session ends, this device gets a fresh cookie, any
// Google removal turns the calendar's Google account off), Add Google (a one-time link that only Continue uses up; then
// Google's callback attaches the account and signs that browser in), and the notice in the person's chat.
//
// The same address typed two ways (Add in Settings, Sign in on /signin) is one emailKey, through Task 5's real request
// and verify routes; a Kelvin-sign look-alike is refused in both (Review Focus RF3). A suspended or banned account gets
// no way and no notice from Add Google (R5); the same account adding the same Google account again gets no second
// notice (R10); Remove keeps a WhatsApp link's own expiry (R4).
//
// Real: the routes (Settings', and Task 5's sign-in request and verify), identities, notice, add-google, google-signin,
// Task 4's Google callback (oidc-route), the session cookie, verifyUserAuth, signInRefusal, the Origin guard,
// the flow cookie, the email address rules, the limits, the code and its email. Faked at the boundaries
// (scripts/lib/signin-world.ts): Prisma and Redis in memory, the rate limiter, error capture, Telegram and WhatsApp,
// the OIDC exchange, the calendar's Google account, and fetch (Resend answered and recorded, the rest blocked).
// No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6b/run-smoke.sh smoke-signin-methods

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import {
  assert, baseUser, body, captured, check, DB, drainAfter, everyCapture, everyLog, everyMail, flowCookie, identityRow, initDataFor,
  installSigninWorld, load, logs, mails, prismaCalls, redisStore, report, request, resetWorld, ROOT, sent, sessionCookie, show, world, type Row,
} from './lib/signin-world';

const nodeRequire = createRequire(__filename);
const TAL = 9;
const TAL_TG = 111111111;
const NOA = 7;
const NOA_TG = 222222222;
const DANA = 42;
const DANA_PHONE = '+972500000042';

function seed(): void {
  resetWorld();
  DB.user = [
    baseUser({ id: TAL, name: 'Tal', telegramId: BigInt(TAL_TG) }),
    baseUser({ id: NOA, name: 'Noa', telegramId: BigInt(NOA_TG), language: 'ru' }),
    baseUser({ id: DANA, name: 'Dana', messagingPlatform: 'whatsapp', whatsappPhone: DANA_PHONE, language: 'he' }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: NOA, kind: 'email', subject: 'noa@example.com', address: 'noa@example.com' }),
    identityRow({ userId: NOA, kind: 'google', subject: 'g-noa', address: 'noa@gmail.com' }),
  ];
}

/** sent.length, not narrowed by an earlier `sent.length === 0` check (tsc would read a later `=== 1` as impossible). */
const sentCount = (): number => sent.length;
const userRow = (id: number): Row => DB.user.find(u => u.id === id) as Row;
const identitiesOf = (id: number): Row[] => (DB.signInIdentity ?? []).filter(i => i.userId === id);
const location = (res: Row): string => res.headers.get('location') ?? '';
/** Where a redirect goes, path and query (an absolute landing carries its locale prefix, English included: src/lib/web-session.ts). */
const pathOf = (res: Row): string => {
  const url = new URL(location(res), 'https://famcal.bot');
  return `${url.pathname}${url.search}`;
};
function codeIn(mail: Row): string {
  const m = /\b(\d{6})\b/.exec(JSON.stringify(mail.body));
  assert(m, `no 6-digit code in the mail: ${show(mail.body)}`);
  return m[1];
}

async function main() {
  await installSigninWorld();
  const methodsRoute = await load('app/api/signin-methods/route.ts');
  const addRoute = await load('app/api/signin-methods/email/add/route.ts');
  const confirmRoute = await load('app/api/signin-methods/email/confirm/route.ts');
  const removeRoute = await load('app/api/signin-methods/remove/route.ts');
  const calendarOnRoute = await load('app/api/signin-methods/calendar-on/route.ts');
  const { googleAccountKey } = await load('src/services/web-signin/account-key.ts');
  const KEY_TAL: string = googleAccountKey('tal@gmail.com');
  const KEY_ID: string = KEY_TAL.split(':')[0];
  const addLinkRoute = await load('app/api/auth/google/add-link/route.ts');
  const addStartRoute = await load('app/api/auth/google/add-start/route.ts');
  const callbackRoute = await load('app/api/auth/google/callback/route.ts');
  const requestRoute = await load('app/api/auth/email/request/route.ts');
  const verifyRoute = await load('app/api/auth/email/verify/route.ts');
  const addGoogle = await load('src/services/web-signin/add-google.ts');
  const { SESSION_COOKIE_NAME, SESSION_TTL_SEC, createSessionToken, validateSessionToken } = await load('src/lib/session-auth.ts');
  const { SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');
  const { emailKey, normalizeEmail } = await load('src/services/web-signin/email-address.ts');

  type Auth = { initData?: string; cookie?: string };
  const tal: Auth = { initData: initDataFor(TAL_TG) };
  const noa: Auth = { initData: initDataFor(NOA_TG) };
  const addTokens: string[] = [];

  const list = (userId: number, auth: Auth) => methodsRoute.GET(request(`/api/signin-methods?user_id=${userId}`, auth));
  const addEmail = (userId: number, email: unknown, auth: Auth, extra: Row = {}) =>
    addRoute.POST(request(`/api/signin-methods/email/add?user_id=${userId}`, { ...auth, body: { email }, ...extra }));
  const confirm = (userId: number, code: string, auth: Auth) =>
    confirmRoute.POST(request(`/api/signin-methods/email/confirm?user_id=${userId}`, { ...auth, body: { code } }));
  const remove = (userId: number, which: unknown, auth: Auth, extra: Row = {}) =>
    removeRoute.POST(request(`/api/signin-methods/remove?user_id=${userId}`, { ...auth, body: { which }, ...extra }));
  const addLink = (userId: number, auth: Auth, extra: Row = {}) =>
    addLinkRoute.POST(request(`/api/auth/google/add-link?user_id=${userId}`, { ...auth, body: {}, ...extra }));
  const addStart = (token: string, extra: Row = {}) => addStartRoute.POST(request('/api/auth/google/add-start', { body: { token }, ...extra }));
  const callback = (state: string, cookie?: string) =>
    callbackRoute.GET(request(`/api/auth/google/callback?code=c-1&state=${encodeURIComponent(state)}`, { cookie }));
  const tokenOf = (url: string) => {
    const token = new URL(url).searchParams.get('token') ?? '';
    addTokens.push(token);
    return token;
  };
  /** Add email up to the mail: the code that went to the address. */
  const startAdd = async (userId: number, email: string, auth: Auth): Promise<string> => {
    const res = await addEmail(userId, email, auth);
    assert(res.status === 200 && (await body(res)).ok === true, `add ${email}: ${res.status} ${show(await body(res))}`);
    return codeIn(mails[mails.length - 1]);
  };
  /** Settings' Add Google, then Continue on the page: Google's state and this browser's flow cookie. */
  const continueAddGoogle = async (userId: number, auth: Auth) => {
    const token = tokenOf((await body(await addLink(userId, auth))).url);
    const start = await addStart(token);
    assert(start.status === 200, `add-start ${start.status} ${show(await body(start))}`);
    const url = new URL((await body(start)).url);
    return { state: url.searchParams.get('state') ?? '', cookie: `${SIGNIN_COOKIE_NAME}=${start.cookies.get(SIGNIN_COOKIE_NAME)?.value}` };
  };
  /** The hashed address an account's Add email is waiting on (by the account's id, not its Telegram id). */
  const pendingKey = (userId: number): string => JSON.parse(String(redisStore.get(`signin:add-email:${userId}`))).emailKey;
  /** The address keys of the email flows in Redis: one per "Email me a code" on /signin. */
  const flowKeys = (): string[] =>
    [...redisStore.entries()].filter(([k]) => k.startsWith('signin:flow:')).map(([, v]) => JSON.parse(v).emailKey).filter(Boolean);
  /** A minute passes: "1 a minute per address" no longer holds back a second request for the same address. */
  const aMinutePasses = () => {
    for (const k of [...redisStore.keys()]) if (k.includes(':email-minute:')) redisStore.delete(k);
  };
  /** "Email me a code" on /signin with this text (Task 5's real route): its response, and the mail it sent after the answer (null when none). */
  const askForCode = async (email: string) => {
    const before = mails.length;
    const res = await requestRoute.POST(request('/api/auth/email/request', { body: { email, locale: 'en' } }));
    await drainAfter();
    return { res, mail: mails.length > before ? mails[mails.length - 1] : null };
  };

  // ---- The list ----

  await check('#1 GET lists the ways: Telegram on for a Telegram account, the Google and email ways with their addresses, the providers set up here; inside Telegram there is no session', async () => {
    seed();
    const res = await list(TAL_TG, tal);
    const b = await body(res);
    assert(res.status === 200, `status ${res.status} ${show(b)}`);
    assert(b.telegram === true && b.google === null && b.email === null && b.googleFromCalendar === null && b.session === null, `Tal ${show(b)}`);
    assert(show(b.providers) === show({ telegram: true, google: true, email: true }), `providers ${show(b.providers)}`);
    const n = await body(await list(NOA_TG, noa));
    assert(n.google?.address === 'noa@gmail.com' && n.email?.address === 'noa@example.com', `Noa ${show(n)}`);
  });

  await check('#2 GET names how this browser signed in: a Google session reads "google", a WhatsApp link "wa" (and a WhatsApp-only account has no Telegram)', async () => {
    seed();
    const g = await body(await list(TAL, { cookie: await sessionCookie(TAL, 'google') }));
    assert(g.session === 'google' && g.telegram === true, `google session ${show(g)}`);
    const wa = await body(await list(DANA, { cookie: await sessionCookie(DANA, 'wa') }));
    assert(wa.session === 'wa' && wa.telegram === false, `wa session ${show(wa)}`);
  });

  await check('#3 googleFromCalendar: "on" with a connected calendar, a current account key held by this account alone and the switch on; "off" with no key or a key of another key id (Turn on); null with the switch off, no connection, a Google way, or a key another account holds too', async () => {
    seed();
    const state = async () => (await body(await list(TAL_TG, tal))).googleFromCalendar;
    Object.assign(userRow(TAL), { googleRefreshToken: 'rt-tal', googleAccountKey: KEY_TAL });
    assert((await state()) === 'on', 'connected, keyed, switch on');
    userRow(TAL).googleCalendarSignIn = false;
    assert((await state()) === null, 'switch off');
    Object.assign(userRow(TAL), { googleCalendarSignIn: true, googleAccountKey: null });
    assert((await state()) === 'off', 'no key yet');
    userRow(TAL).googleAccountKey = `${KEY_ID === 'deadbeef' ? 'cafebabe' : 'deadbeef'}:${'0'.repeat(64)}`;
    assert((await state()) === 'off', 'a key of another key id');
    userRow(TAL).googleAccountKey = KEY_TAL;
    DB.user.push(baseUser({ id: 50, name: 'Family', telegramId: BigInt(555555555), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL }));
    assert((await state()) === null, 'a key another account holds too (a shared Google account)');
    userRow(50).googleCalendarSignIn = false;
    assert((await state()) === 'on', 'the other holder turned its switch off');
    userRow(50).googleCalendarSignIn = true;
    userRow(50).googleRefreshToken = '';
    assert((await state()) === 'on', 'the other holder disconnected');
    userRow(TAL).googleRefreshToken = '';
    assert((await state()) === null, 'no connection');
    userRow(TAL).googleRefreshToken = 'rt-tal';
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal@gmail.com' }));
    const withWay = await body(await list(TAL_TG, tal));
    assert(withWay.googleFromCalendar === null && withWay.google?.address === 'tal@gmail.com', `with a Google way ${show(withWay)}`);
    seed();
    Object.assign(userRow(TAL), { googleRefreshToken: 'rt-tal', googleAccountKey: KEY_TAL });
    prismaCalls.length = 0;
    await list(NOA_TG, noa);
    assert(!prismaCalls.includes('user.count'), 'an account with no calendar connection made the holders count');
  });

  await check('#4 [guard] GET needs the proved account: no credential is 401, and a session for Tal cannot read Noa', async () => {
    seed();
    assert((await list(TAL, {})).status === 401, 'no credential');
    assert((await list(NOA, { cookie: await sessionCookie(TAL, 'google') })).status === 401, "Tal's cookie for Noa");
  });

  // ---- Add email ----

  await check('#5 Add email mails a 6-digit code to the address as typed after trimming and lowercasing, and makes no way yet; Redis never holds the code itself', async () => {
    seed();
    const res = await addEmail(TAL_TG, '  Tal@Example.COM ', tal);
    assert(res.status === 200 && (await body(res)).ok === true, `status ${res.status} ${show(await body(res))}`);
    assert(mails.length === 1 && show(mails[0].to) === show(['tal@example.com']), `mails ${show(mails.map(m => m.to))}`);
    const code = codeIn(mails[0]);
    const stored = [...redisStore.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    assert(!new RegExp(`\\b${code}\\b`).test(stored), `Redis holds the code in plain:\n${stored}`);
    assert(identitiesOf(TAL).length === 0, 'a way was made before the code');
  });

  await check('#6 the right code makes the email way and answers the new list; a wrong one does not; the chat gets the notice with the address masked; the code is then used up', async () => {
    seed();
    const code = await startAdd(TAL_TG, 'tal@example.com', tal);
    const wrong = await confirm(TAL_TG, code === '000000' ? '111111' : '000000', tal);
    assert(wrong.status === 400 && (await body(wrong)).error === 'wrong', `wrong ${wrong.status} ${show(await body(wrong))}`);
    assert(identitiesOf(TAL).length === 0 && sent.length === 0, 'a wrong code made a way or a notice');
    const right = await confirm(TAL_TG, code, tal);
    const b = await body(right);
    assert(right.status === 200 && b.ok === true && b.methods?.email?.address === 'tal@example.com', `right ${right.status} ${show(b)}`);
    const [way] = identitiesOf(TAL);
    assert(way?.kind === 'email' && way.subject === 'tal@example.com' && way.address === 'tal@example.com', `way ${show(way)}`);
    assert(sentCount() === 1 && sent[0].platform === 'telegram' && sent[0].chatId === String(TAL_TG), `notices ${show(sent)}`);
    assert(sent[0].text.includes('t•••@example.com') && !sent[0].text.includes('tal@example.com'), `notice text ${sent[0].text}`);
    assert(sent[0].text.includes('Settings → Sign in on the web → Remove'), `the notice does not name the Settings path: ${sent[0].text}`);
    const again = await confirm(TAL_TG, code, tal);
    assert(again.status === 410 && (await body(again)).error === 'restart', `reused ${again.status} ${show(await body(again))}`);
  });

  await check('#7 an address another account signs in with is mailed like any other, and refused only after its code is right (taken): no way, no notice, the other account untouched', async () => {
    seed();
    const code = await startAdd(TAL_TG, 'noa@example.com', tal);
    const res = await confirm(TAL_TG, code, tal);
    assert(res.status === 409 && (await body(res)).error === 'taken', `status ${res.status} ${show(await body(res))}`);
    assert(identitiesOf(TAL).length === 0 && sent.length === 0, `made ${show(identitiesOf(TAL))} sent ${show(sent)}`);
    assert(identitiesOf(NOA).some(i => i.kind === 'email' && i.subject === 'noa@example.com'), "Noa's way changed");
  });

  await check('#8 an account that already has an email way gets has-one, and nothing is mailed', async () => {
    seed();
    const res = await addEmail(NOA_TG, 'noa2@example.com', noa);
    assert(res.status === 409 && (await body(res)).error === 'has-one' && mails.length === 0, `status ${res.status} ${show(await body(res))}, mails ${mails.length}`);
  });

  await check('#9 what is not an ASCII address is refused (invalid) with no mail: no @, empty, not a string, and a Kelvin sign (U+212A) in the local part', async () => {
    seed();
    for (const email of ['not-an-email', '', 42, 'taKl@example.com']) {
      const res = await addEmail(TAL_TG, email, tal);
      assert(res.status === 400 && (await body(res)).error === 'invalid', `${show(email)}: ${res.status} ${show(await body(res))}`);
    }
    assert(mails.length === 0, `mailed ${show(mails.map(m => m.to))}`);
  });

  await check('#10 [guard] a POST from another site or with no Origin is refused (403): no mail, no pending add, no removal, no link', async () => {
    seed();
    const evil = await addEmail(TAL_TG, 'tal@example.com', tal, { origin: 'https://evil.example' });
    const none = await addEmail(TAL_TG, 'tal@example.com', tal, { origin: null });
    assert(evil.status === 403 && none.status === 403, `add: ${evil.status}, ${none.status}`);
    assert(mails.length === 0 && ![...redisStore.keys()].some(k => k.startsWith('signin:add-email:')), 'an add went through');
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'email', subject: 'tal@example.com', address: 'tal@example.com' }));
    const rm = await remove(TAL_TG, 'email', tal, { origin: 'https://evil.example' });
    assert(rm.status === 403 && identitiesOf(TAL).length === 1 && userRow(TAL).sessionsValidAfter === null, `remove ${rm.status}`);
    const link = await addLink(TAL_TG, tal, { origin: 'https://evil.example' });
    assert(link.status === 403 && ![...redisStore.keys()].some(k => k.startsWith('signin:add-google:')), `add-link ${link.status}`);
  });

  await check('#11 Add email mails at most 3 addresses a day for one account: the 4th is refused (limit) and not mailed', async () => {
    seed();
    for (const n of [1, 2, 3]) {
      const res = await addEmail(TAL_TG, `tal${n}@example.com`, tal);
      assert(res.status === 200, `address ${n}: ${res.status} ${show(await body(res))}`);
    }
    const fourth = await addEmail(TAL_TG, 'tal4@example.com', tal);
    assert(fourth.status === 429 && (await body(fourth)).error === 'limit' && mails.length === 3, `4th: ${fourth.status} ${show(await body(fourth))}, mails ${mails.length}`);
  });

  await check('#12 a WhatsApp-only account gets the notice on WhatsApp, in its own language (Hebrew), the address masked', async () => {
    seed();
    const dana: Auth = { cookie: await sessionCookie(DANA, 'wa') };
    const code = await startAdd(DANA, 'dana@example.com', dana);
    const res = await confirm(DANA, code, dana);
    assert(res.status === 200, `confirm ${res.status} ${show(await body(res))}`);
    assert(sent.length === 1 && sent[0].platform === 'whatsapp' && sent[0].chatId === DANA_PHONE, `sent ${show(sent)}`);
    assert(sent[0].text.includes('d•••@example.com') && /[֐-׿]/.test(sent[0].text), `text ${sent[0].text}`);
    assert(sent[0].text.includes('הגדרות ← כניסה מהדפדפן ← הסרה'), `the Hebrew notice does not name the Settings path: ${sent[0].text}`);
  });

  await check('#13 a notice that fails to send is logged and captured, and the way is still made and answered', async () => {
    seed();
    world.telegramFails = true;
    const code = await startAdd(TAL_TG, 'tal@example.com', tal);
    const res = await confirm(TAL_TG, code, tal);
    assert(res.status === 200 && (await body(res)).ok === true, `confirm ${res.status} ${show(await body(res))}`);
    assert(identitiesOf(TAL).length === 1, 'no way');
    assert(logs.some(l => l.includes('[signin-notice] user 9')), `logs ${show(logs)}`);
    assert(captured.some(c => c.context === 'signin-notice' && c.extra.user_id === TAL), `captured ${show(captured)}`);
  });

  // ---- Remove ----

  await check('#14 removing a way signs out every web session: the old cookie is refused after, this device gets a fresh one (same method, signed in now) that works', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'email', subject: 'tal@example.com', address: 'tal@example.com' }));
    const old = await sessionCookie(TAL, 'google', Date.now() - 60_000);
    const res = await remove(TAL, 'email', { cookie: old });
    const b = await body(res);
    assert(res.status === 200 && b.ok === true && b.methods?.email === null, `remove ${res.status} ${show(b)}`);
    assert(identitiesOf(TAL).length === 0, `ways ${show(identitiesOf(TAL))}`);
    const validAfter = userRow(TAL).sessionsValidAfter;
    assert(validAfter instanceof Date, `sessionsValidAfter ${show(validAfter)}`);
    const fresh = res.cookies.get(SESSION_COOKIE_NAME)?.value;
    assert(fresh, 'no fresh cookie');
    const session = validateSessionToken(fresh);
    assert(session?.userId === TAL && session.method === 'google' && session.signedInAt >= validAfter.getTime(), `fresh ${show(session)} after ${validAfter.toISOString()}`);
    const withOld = await list(TAL, { cookie: old });
    assert(withOld.status >= 400, `the old cookie still works: ${withOld.status}`);
    const withFresh = await list(TAL, { cookie: `${SESSION_COOKIE_NAME}=${fresh}` });
    assert(withFresh.status === 200, `the fresh cookie: ${withFresh.status} ${show(await body(withFresh))}`);
    assert(userRow(TAL).googleCalendarSignIn === true, 'an email removal turned the calendar Google account off');
  });

  await check('#15 removing Google turns the calendar Google account off too, and so does removing the calendar row before its first use; inside Telegram no cookie is set', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal@gmail.com' }));
    const res = await remove(TAL_TG, 'google', tal);
    assert(res.status === 200 && (await body(res)).methods?.google === null, `remove google ${res.status} ${show(await body(res))}`);
    assert(identitiesOf(TAL).length === 0 && userRow(TAL).googleCalendarSignIn === false && userRow(TAL).sessionsValidAfter instanceof Date, `row ${show(userRow(TAL))}`);
    assert(!res.cookies.get(SESSION_COOKIE_NAME)?.value, 'a Telegram request got a session cookie');
    seed();
    Object.assign(userRow(TAL), { googleRefreshToken: 'rt-tal', googleAccountKey: KEY_TAL });
    const cal = await remove(TAL_TG, 'calendar-google', tal);
    const cb = await body(cal);
    assert(cal.status === 200 && cb.methods?.googleFromCalendar === null && userRow(TAL).googleCalendarSignIn === false, `calendar-google ${cal.status} ${show(cb)}`);
    assert(identitiesOf(NOA).length === 2, "another account's ways were touched");
  });

  await check('#16 [guard] Telegram and WhatsApp cannot be removed here: any other "which" is 400 and changes nothing; the log says only that an unknown way was refused, never the text sent', async () => {
    seed();
    for (const which of ['telegram', 'whatsapp', '', undefined, 'secret-way-xyz']) {
      const res = await remove(TAL_TG, which, tal);
      assert(res.status === 400 && (await body(res)).error === 'invalid', `${show(which)}: ${res.status} ${show(await body(res))}`);
    }
    assert(userRow(TAL).sessionsValidAfter === null && userRow(TAL).googleCalendarSignIn === true, `row ${show(userRow(TAL))}`);
    assert(logs.some(l => l.includes('refused a removal of an unknown way')) && !logs.some(l => l.includes('secret-way-xyz')), `logs ${show(logs)}`);
  });

  // ---- Add Google ----

  await check('#17 Add Google answers a one-time famcal.bot link in the person\'s language (?token=; English unprefixed, Hebrew under /he); Redis keeps only its hash; has-one for an account with a Google way, unavailable without the sign-in client', async () => {
    seed();
    const res = await addLink(TAL_TG, tal);
    const b = await body(res);
    assert(res.status === 200 && typeof b.url === 'string' && b.url.startsWith('https://famcal.bot/signin/add-google?token='), `link ${res.status} ${show(b)}`);
    const he = await body(await addLink(DANA, { cookie: await sessionCookie(DANA, 'wa') }));
    assert(typeof he.url === 'string' && he.url.startsWith('https://famcal.bot/he/signin/add-google?token='), `Hebrew link ${show(he)}`);
    tokenOf(he.url);
    const token = tokenOf(b.url);
    assert(/^[A-Za-z0-9_-]{32}$/.test(token), `token ${token}`);
    const stored = [...redisStore.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    assert(!stored.includes(token) && [...redisStore.keys()].some(k => k.startsWith('signin:add-google:')), `Redis:\n${stored}`);
    const n = await addLink(NOA_TG, noa);
    assert(n.status === 409 && (await body(n)).error === 'has-one', `Noa ${n.status} ${show(await body(n))}`);
    world.oidc.google = false;
    const off = await addLink(TAL_TG, tal);
    assert(off.status === 409 && (await body(off)).error === 'unavailable', `off ${off.status} ${show(await body(off))}`);
  });

  await check('#18 only Continue uses the link up: looking at it (the page) twice keeps it; add-start answers Google\'s URL with the flow cookie; a second Continue is expired', async () => {
    seed();
    const token = tokenOf((await body(await addLink(TAL_TG, tal))).url);
    assert(show(await addGoogle.peekAddGoogleToken(token)) === show({ userId: TAL }), 'first look');
    assert(show(await addGoogle.peekAddGoogleToken(token)) === show({ userId: TAL }), 'second look');
    const start = await addStart(token);
    const sb = await body(start);
    assert(start.status === 200 && new URL(sb.url).host === 'accounts.google.com', `add-start ${start.status} ${show(sb)}`);
    assert(start.cookies.get(SIGNIN_COOKIE_NAME)?.value, 'no flow cookie');
    const again = await addStart(token);
    assert(again.status === 410 && (await body(again)).error === 'expired', `again ${again.status} ${show(await body(again))}`);
    assert(await addGoogle.peekAddGoogleToken(token) === null && await addGoogle.peekAddGoogleToken('not-a-token') === null, 'a used link still reads');
  });

  await check('#19 [guard] a Continue from another site is refused and leaves the link usable', async () => {
    seed();
    const token = tokenOf((await body(await addLink(TAL_TG, tal))).url);
    const evil = await addStart(token, { origin: 'https://evil.example' });
    assert(evil.status === 403, `evil ${evil.status}`);
    assert((await addStart(token)).status === 200, 'the link was used up by the refused request');
  });

  await check('#20 Google\'s answer to Add Google attaches the account (sub, the verified address, used now), sends the masked notice, signs this browser in as that account, and clears the flow cookie', async () => {
    seed();
    const { state, cookie } = await continueAddGoogle(TAL_TG, tal);
    world.claims = { sub: 'g-tal', email: 'tal@gmail.com', emailVerified: true };
    const res = await callback(state, cookie);
    assert(pathOf(res) === '/en/dashboard?user_id=9', `location ${location(res)}; captured ${show(captured)}`);
    const session = validateSessionToken(res.cookies.get(SESSION_COOKIE_NAME)?.value ?? '');
    assert(session?.userId === TAL && session.method === 'google', `session ${show(session)}`);
    const [way] = identitiesOf(TAL);
    assert(way?.kind === 'google' && way.subject === 'g-tal' && way.address === 'tal@gmail.com' && way.lastUsedAt instanceof Date, `way ${show(way)}`);
    assert(sent.length === 1 && sent[0].chatId === String(TAL_TG) && sent[0].text.includes('t•••@gmail.com') && !sent[0].text.includes('tal@gmail.com'), `sent ${show(sent)}`);
    assert(!res.cookies.get(SIGNIN_COOKIE_NAME)?.value, `flow cookie ${show(res.cookies.get(SIGNIN_COOKIE_NAME))}`);
  });

  await check('#21 a Google account another FamCal account signs in with is refused (status=taken): nothing attached, no notice, no session', async () => {
    seed();
    const { state, cookie } = await continueAddGoogle(TAL_TG, tal);
    world.claims = { sub: 'g-noa', email: 'noa@gmail.com', emailVerified: true };
    const res = await callback(state, cookie);
    assert(location(res).includes('status=taken'), `location ${location(res)}`);
    assert(identitiesOf(TAL).length === 0 && sent.length === 0 && !res.cookies.get(SESSION_COOKIE_NAME)?.value, `ways ${show(identitiesOf(TAL))} sent ${show(sent)}`);
  });

  await check('#22 an address Google has not verified is refused (status=failed), nothing attached', async () => {
    seed();
    const { state, cookie } = await continueAddGoogle(TAL_TG, tal);
    world.claims = { sub: 'g-tal', email: 'tal@gmail.com', emailVerified: false };
    const res = await callback(state, cookie);
    assert(location(res).includes('status=failed') && identitiesOf(TAL).length === 0 && sent.length === 0, `location ${location(res)}`);
  });

  await check('#23 [guard] a callback without this browser\'s flow says start again (restart); a state that is not the flow\'s says restart too (Task 4\'s handleOidcCallback), and the flow is then used up', async () => {
    seed();
    world.claims = { sub: 'g-tal', email: 'tal@gmail.com', emailVerified: true };
    assert(location(await callback('anything')).includes('status=restart'), 'no flow cookie');
    const { state, cookie } = await continueAddGoogle(TAL_TG, tal);
    assert(location(await callback(`${state}x`, cookie)).includes('status=restart'), 'a wrong state');
    assert(location(await callback(state, cookie)).includes('status=restart'), 'the flow worked twice');
    assert(identitiesOf(TAL).length === 0, `ways ${show(identitiesOf(TAL))}`);
  });

  await check('#24 a later "Continue with Google" with the added account signs in and moves its last-used date, with no notice; a Google account nobody added signs nobody in and starts the sign-up (web sign-up spec §3.3), no account yet', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal@gmail.com' }));
    world.claims = { sub: 'g-tal', email: 'tal@gmail.com', emailVerified: true };
    const res = await callback('st-1', await flowCookie({ kind: 'google', state: 'st-1', nonce: 'n-1', codeVerifier: 'v'.repeat(43), locale: 'en' }));
    assert(pathOf(res) === '/en/dashboard?user_id=9', `location ${location(res)}; captured ${show(captured)}`);
    assert(identitiesOf(TAL)[0].lastUsedAt instanceof Date && sent.length === 0, `way ${show(identitiesOf(TAL))} sent ${show(sent)}`);
    world.claims = { sub: 'g-nobody', email: 'nobody@gmail.com', emailVerified: true };
    const none = await callback('st-2', await flowCookie({ kind: 'google', state: 'st-2', nonce: 'n-2', codeVerifier: 'w'.repeat(43), locale: 'en' }));
    assert(pathOf(none) === '/en/signup' && DB.user.length === 3, `location ${location(none)}`);
  });

  // ---- Remove keeps a WhatsApp link's expiry (ruling R4) ----

  await check('#25 [R4] a WhatsApp link session that removes a way gets a fresh cookie that keeps the link\'s own expiry and only the seconds left (never renewed); a web session\'s fresh cookie gets a full new life', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: DANA, kind: 'email', subject: 'dana@example.com', address: 'dana@example.com' }));
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const old = `${SESSION_COOKIE_NAME}=${createSessionToken(DANA, 'wa', Date.now() - 60_000, { exp })}`;
    const res = await remove(DANA, 'email', { cookie: old });
    assert(res.status === 200 && (await body(res)).ok === true, `remove ${res.status} ${show(await body(res))}`);
    const cookie = res.cookies.get(SESSION_COOKIE_NAME);
    const session = validateSessionToken(cookie?.value ?? '');
    assert(session?.method === 'wa' && session.exp === exp, `exp ${session?.exp}, wanted ${exp}`);
    assert(typeof cookie?.maxAge === 'number' && cookie.maxAge > 3500 && cookie.maxAge <= 3600, `maxAge ${cookie?.maxAge}`);
    const again = await list(DANA, { cookie: `${SESSION_COOKIE_NAME}=${cookie?.value}` });
    assert(again.status === 200, `the cookie it got is refused: ${again.status}`);
    seed();
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'email', subject: 'tal@example.com', address: 'tal@example.com' }));
    const web = await remove(TAL, 'email', { cookie: await sessionCookie(TAL, 'google') });
    const fresh = validateSessionToken(web.cookies.get(SESSION_COOKIE_NAME)?.value ?? '');
    assert(fresh?.method === 'google' && fresh.exp - fresh.iat === SESSION_TTL_SEC.web, `web session ${show(fresh)}`);
  });

  // ---- addIdentity's answers (ruling R10) and a refused account (ruling R5) ----

  await check('#26 [R10] Add Google with the Google account this same account already holds signs it in with no second notice and adds no row (kept)', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal@gmail.com' }));
    world.claims = { sub: 'g-tal', email: 'tal@gmail.com', emailVerified: true };
    const cookie = await flowCookie({ kind: 'add-google', state: 'st-k', nonce: 'n-k', codeVerifier: 'k'.repeat(43), locale: 'en', userId: TAL });
    const res = await callback('st-k', cookie);
    assert(pathOf(res) === '/en/dashboard?user_id=9', `location ${location(res)}; captured ${show(captured)}`);
    assert(sent.length === 0 && identitiesOf(TAL).length === 1, `sent ${show(sent)} ways ${show(identitiesOf(TAL))}`);
    assert(validateSessionToken(res.cookies.get(SESSION_COOKIE_NAME)?.value ?? '')?.userId === TAL, 'no session');
  });

  await check('#27 an account that got a Google way between the link and the callback is refused there (status=has-one): the second Google account is not attached, no notice, no session', async () => {
    seed();
    const { state, cookie } = await continueAddGoogle(TAL_TG, tal);
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-old', address: 'old@gmail.com' }));
    world.claims = { sub: 'g-new', email: 'tal@gmail.com', emailVerified: true };
    const res = await callback(state, cookie);
    assert(location(res).includes('status=has-one'), `location ${location(res)}`);
    assert(identitiesOf(TAL).length === 1 && sent.length === 0 && !res.cookies.get(SESSION_COOKIE_NAME)?.value, `ways ${show(identitiesOf(TAL))} sent ${show(sent)}`);
  });

  await check('#28 [R5] a banned account (its Telegram id is on the block list) or a suspended one gets no Google way and no notice from Add Google: the callback lands on its page (status=blocked / suspended), with no session', async () => {
    for (const refusal of ['blocked', 'suspended']) {
      seed();
      const { state, cookie } = await continueAddGoogle(TAL_TG, tal);
      if (refusal === 'blocked') DB.blockedIdentifier = [{ id: 1, telegramId: BigInt(TAL_TG), whatsappPhone: null, createdAt: new Date() }];
      else userRow(TAL).suspendedAt = new Date();
      world.claims = { sub: 'g-tal', email: 'tal@gmail.com', emailVerified: true };
      const res = await callback(state, cookie);
      assert(location(res).includes(`status=${refusal}`), `${refusal}: location ${location(res)}`);
      assert(identitiesOf(TAL).length === 0 && sent.length === 0 && !res.cookies.get(SESSION_COOKIE_NAME)?.value, `${refusal}: ways ${show(identitiesOf(TAL))} sent ${show(sent)}`);
    }
  });

  // ---- The same address typed two ways (Review Focus RF3), through Task 5's real request and verify routes ----

  await check('#29 [RF3] Add typed "  Dana@Example.COM " and Sign in typed "dana@example.com" are one emailKey: the sign-in code goes to the stored address, and the right code signs that account in (in its own language)', async () => {
    seed();
    const dana: Auth = { cookie: await sessionCookie(DANA, 'wa') };
    const code = await startAdd(DANA, '  Dana@Example.COM ', dana);
    const added = pendingKey(DANA);
    assert(added === emailKey('dana@example.com'), 'the pending Add email is under another key than the normalised address');
    assert((await confirm(DANA, code, dana)).status === 200, 'Add email did not finish');
    assert(identitiesOf(DANA)[0]?.subject === 'dana@example.com', `way ${show(identitiesOf(DANA))}`);
    aMinutePasses();
    const asked = await askForCode('dana@example.com');
    assert(asked.res.status === 200 && (await body(asked.res)).ok === true, `request ${asked.res.status}`);
    assert(asked.mail && show(asked.mail.to) === show(['dana@example.com']), `mailed ${show(asked.mail?.to)}`);
    assert(show(flowKeys()) === show([added]), `flow keys ${show(flowKeys())}, Add email's ${added}`);
    const verify = await verifyRoute.POST(request('/api/auth/email/verify', {
      body: { code: codeIn(asked.mail) },
      cookie: `${SIGNIN_COOKIE_NAME}=${asked.res.cookies.get(SIGNIN_COOKIE_NAME)?.value}`,
    }));
    const vb = await body(verify);
    assert(verify.status === 200 && vb.ok === true && String(vb.redirect).includes('/he/dashboard?user_id=42'), `verify ${verify.status} ${show(vb)}`);
    const session = validateSessionToken(verify.cookies.get(SESSION_COOKIE_NAME)?.value ?? '');
    assert(session?.userId === DANA && session.method === 'email', `session ${show(session)}`);
  });

  await check('#30 [RF3] the reverse: Add typed "tal@example.com" and Sign in typed "  TAL@Example.com " are one emailKey, and the code goes to the stored address', async () => {
    seed();
    const code = await startAdd(TAL_TG, 'tal@example.com', tal);
    const added = pendingKey(TAL);
    assert((await confirm(TAL_TG, code, tal)).status === 200, 'Add email did not finish');
    assert(added === emailKey(normalizeEmail('  TAL@Example.com ')), 'the two spellings have two keys');
    aMinutePasses();
    const asked = await askForCode('  TAL@Example.com ');
    assert(asked.mail && show(asked.mail.to) === show(['tal@example.com']), `mailed ${show(asked.mail?.to)}`);
    assert(show(flowKeys()) === show([added]), `flow keys ${show(flowKeys())}, Add email's ${added}`);
  });

  await check('#31 [RF3] a Kelvin-sign look-alike (ta + U+212A + l@example.com) is refused in both: Add answers invalid with no mail, and Sign in mails nothing to the ASCII address it lowercases to (takl@example.com) while the real address still gets its code', async () => {
    seed();
    DB.user.push(baseUser({ id: 50, name: 'Kay', telegramId: BigInt(555555555) }));
    DB.signInIdentity.push(identityRow({ userId: 50, kind: 'email', subject: 'takl@example.com', address: 'takl@example.com' }));
    const kelvin = 'taKl@example.com';
    const add = await addEmail(TAL_TG, kelvin, tal);
    assert(add.status === 400 && (await body(add)).error === 'invalid' && mails.length === 0, `add ${add.status} ${show(await body(add))}, mails ${mails.length}`);
    const asked = await askForCode(kelvin);
    assert(asked.res.status === 200 && (await body(asked.res)).ok === true && asked.mail === null && mails.length === 0, `sign in ${asked.res.status}, mails ${show(mails.map(m => m.to))}`);
    assert(!flowKeys().includes(emailKey('takl@example.com')), "the Kelvin address got the ASCII look-alike's key");
    const control = await askForCode('takl@example.com');
    assert(control.mail && show(control.mail.to) === show(['takl@example.com']), `the real address: ${show(control.mail?.to)}`);
  });

  // ---- Words and logs ----

  await check('#32 the notice names Settings\' path in the words of the Settings screen, in all three catalogues: "Sign in on the web" / "Remove", "כניסה מהדפדפן" / "הסרה", «Вход через браузер» / «Убрать»', async () => {
    const read = (lang: string): Row => JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${lang}.json`), 'utf8')).signinNotice;
    const want: Record<string, string[]> = {
      en: ['Settings → Sign in on the web → Remove'],
      he: ['הגדרות ← כניסה מהדפדפן ← הסרה'],
      ru: ['«Настройки» → «Вход через браузер» → «Убрать»'],
    };
    for (const lang of ['en', 'he', 'ru']) {
      const notice = read(lang);
      for (const key of ['addedGoogle', 'addedEmail', 'calendarGoogle']) {
        assert(want[lang].every(w => String(notice[key]).includes(w)), `${lang}.${key}: ${notice[key]}`);
      }
    }
  });

  await check('#33 a body that is not JSON is logged as a fact (never the parse message) and read as no body: Add email answers invalid and mails nothing', async () => {
    seed();
    const res = await addRoute.POST(request(`/api/signin-methods/email/add?user_id=${TAL_TG}`, { method: 'POST', ...tal }));
    assert(res.status === 400 && (await body(res)).error === 'invalid' && mails.length === 0, `status ${res.status} ${show(await body(res))}`);
    assert(logs.some(l => l.includes('[signin-methods] the body is not JSON')) && !logs.some(l => /unexpected end of json|json input/i.test(l)), `logs ${show(logs)}`);
  });

  await check('#34 [guard] a code issued to another account for the same address does not add the way here: Tal and Noa both start Add email for one address, Noa asks second, so Tal posting the code (Noa\'s) gets 410 restart, with no email way and no notice for Tal', async () => {
    seed();
    DB.signInIdentity = DB.signInIdentity.filter(i => !(i.userId === NOA && i.kind === 'email'));
    await startAdd(TAL_TG, 'shared@example.com', tal);
    aMinutePasses();
    const noasCode = await startAdd(NOA_TG, 'shared@example.com', noa);
    const res = await confirm(TAL_TG, noasCode, tal);
    assert(res.status === 410 && (await body(res)).error === 'restart', `Tal with Noa's code: ${res.status} ${show(await body(res))}`);
    assert(identitiesOf(TAL).length === 0 && sent.length === 0, `Tal's ways ${show(identitiesOf(TAL))}, notices ${show(sent)}`);
    assert(!identitiesOf(NOA).some(i => i.kind === 'email'), "the code was used up for Noa's way by Tal's request");
  });

  await check('#35 [guard] email/confirm from another site or with no Origin is refused (403): the way is not made, no notice, the pending Add email stays, and the code still works from this site', async () => {
    seed();
    const code = await startAdd(TAL_TG, 'tal@example.com', tal);
    const evil = await confirmRoute.POST(request(`/api/signin-methods/email/confirm?user_id=${TAL_TG}`, { ...tal, body: { code }, origin: 'https://evil.example' }));
    const none = await confirmRoute.POST(request(`/api/signin-methods/email/confirm?user_id=${TAL_TG}`, { ...tal, body: { code }, origin: null }));
    assert(evil.status === 403 && none.status === 403, `confirm: ${evil.status}, ${none.status}`);
    assert(identitiesOf(TAL).length === 0 && sent.length === 0, `made ${show(identitiesOf(TAL))} sent ${show(sent)}`);
    assert(redisStore.has(`signin:add-email:${TAL}`), 'the pending Add email was taken by a refused request');
    const ok = await confirm(TAL_TG, code, tal);
    assert(ok.status === 200 && identitiesOf(TAL).length === 1, `from this site ${ok.status} ${show(await body(ok))}`);
  });

  await check('#36 the wrong-code limits count on email/confirm and block it: each wrong code moves the address\'s and the IP\'s counters; after 10 wrong for the address, even the right code is 429 (limit) and makes no way', async () => {
    seed();
    const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000');
    const counter = (prefix: string): number => {
      const keys = [...redisStore.keys()].filter(k => k.startsWith(prefix));
      return keys.length === 0 ? 0 : Number(redisStore.get(keys[0]));
    };
    assert(counter('signin:lim:wrong-email-day:') === 0 && counter('signin:lim:wrong-ip-hour:') === 0, 'counters before');
    let code = '';
    let wrong = 0;
    for (const tries of [4, 4, 2]) {
      aMinutePasses();
      code = await startAdd(TAL_TG, 'limit@example.com', tal);
      for (let i = 0; i < tries; i++) {
        const res = await confirm(TAL_TG, wrongOf(code), tal);
        assert(res.status === 400 && (await body(res)).error === 'wrong', `wrong ${wrong + 1}: ${res.status} ${show(await body(res))}`);
        wrong++;
        assert(counter('signin:lim:wrong-email-day:') === wrong && counter('signin:lim:wrong-ip-hour:') === wrong, `counters after ${wrong}: ${counter('signin:lim:wrong-email-day:')}, ${counter('signin:lim:wrong-ip-hour:')}`);
      }
    }
    const blocked = await confirm(TAL_TG, code, tal);
    assert(blocked.status === 429 && (await body(blocked)).error === 'limit', `right code after 10 wrong: ${blocked.status} ${show(await body(blocked))}`);
    assert(identitiesOf(TAL).length === 0 && sent.length === 0, `made ${show(identitiesOf(TAL))} sent ${show(sent)}`);
  });

  await check('#37 [guard] removing a way the account does not hold (or the calendar switch already off) changes nothing and signs nobody out; one that removes something still does', async () => {
    seed();
    const noEmail = await remove(TAL_TG, 'email', tal);
    assert(noEmail.status === 200 && userRow(TAL).sessionsValidAfter === null, `email with none: ${noEmail.status}, sessionsValidAfter ${show(userRow(TAL).sessionsValidAfter)}`);
    userRow(TAL).googleCalendarSignIn = false;
    const off = await remove(TAL_TG, 'calendar-google', tal);
    const noGoogle = await remove(TAL_TG, 'google', tal);
    assert(off.status === 200 && noGoogle.status === 200 && userRow(TAL).sessionsValidAfter === null, `switch off: sessionsValidAfter ${show(userRow(TAL).sessionsValidAfter)}`);
    assert(logs.some(l => l.includes('[signin] user 9: the email way was not there')), `logs ${show(logs)}`);
    userRow(TAL).googleCalendarSignIn = true;
    const on = await remove(TAL_TG, 'calendar-google', tal);
    assert(on.status === 200 && userRow(TAL).googleCalendarSignIn === false && userRow(TAL).sessionsValidAfter instanceof Date, `switch on: ${show(userRow(TAL))}`);
  });

  await check('#38 a mail that fails to send answers failed (500) and leaves no pending Add email behind', async () => {
    seed();
    world.resendFails = true;
    const res = await addEmail(TAL_TG, 'down@example.com', tal);
    assert(res.status === 500 && (await body(res)).error === 'failed', `status ${res.status} ${show(await body(res))}`);
    assert(![...redisStore.keys()].some(k => k.startsWith('signin:add-email:')), 'a pending Add email points at an address with no code');
    assert(![...redisStore.keys()].some(k => k.startsWith('signin:code:')), 'a code was kept that never reached the person');
  });

  // ---- Turn on ----

  const calendarOn = (userId: number, auth: Auth, extra: Row = {}) =>
    calendarOnRoute.POST(request(`/api/signin-methods/calendar-on?user_id=${userId}`, { ...auth, body: {}, ...extra }));
  const seedOff = (): void => {
    seed();
    Object.assign(userRow(TAL), { googleRefreshToken: 'rt-tal', googleAccountKey: null });
    world.accounts = { 'rt-tal': 'Tal@Gmail.com' };
  };

  await check('#40 Turn on: the route answers on with the new list (the calendar row on), keys the account by the live address, sends no notice, ends no session and sets no cookie; Google is asked once, with the calendar token', async () => {
    seedOff();
    const res = await calendarOn(TAL_TG, tal);
    const b = await body(res);
    assert(res.status === 200 && b.ok === true && b.methods?.googleFromCalendar === 'on', `status ${res.status} ${show(b)}`);
    assert(userRow(TAL).googleAccountKey === KEY_TAL && userRow(TAL).sessionsValidAfter === null && sent.length === 0, `row ${show(userRow(TAL))} sent ${show(sent)}`);
    assert(!res.cookies.get(SESSION_COOKIE_NAME)?.value && show(world.googleAsks) === show(['rt-tal']), `asks ${show(world.googleAsks)}`);
    const again = await calendarOn(TAL_TG, tal);
    assert(again.status === 409 && (await body(again)).error === 'not-offered' && world.googleAsks.length === 1, `second press ${again.status} ${show(await body(again))}`);
  });

  await check('#41 Turn on: shared (409) keeps nothing; reconnect (409) for a dead token; failed (502) for an unavailable Google; each logged with the user id and the kind only', async () => {
    seedOff();
    DB.user.push(baseUser({ id: 50, name: 'Family', telegramId: BigInt(555555555), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL }));
    const shared = await calendarOn(TAL_TG, tal);
    assert(shared.status === 409 && (await body(shared)).error === 'shared' && userRow(TAL).googleAccountKey === null, `shared ${shared.status} ${show(await body(shared))}`);
    seedOff();
    world.accounts['rt-tal'] = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    const dead = await calendarOn(TAL_TG, tal);
    assert(dead.status === 409 && (await body(dead)).error === 'reconnect' && userRow(TAL).googleAccountKey === null, `dead ${dead.status} ${show(await body(dead))}`);
    seedOff();
    world.accounts['rt-tal'] = Object.assign(new Error('backend error'), { response: { status: 503, data: {} } });
    const down = await calendarOn(TAL_TG, tal);
    assert(down.status === 502 && (await body(down)).error === 'failed' && userRow(TAL).googleAccountKey === null, `down ${down.status} ${show(await body(down))}`);
    assert(logs.some(l => l.includes('[signin] user 9: calendar account turn on: failed')), `logs ${show(logs)}`);
  });

  await check('#42 [guard] Turn on from another site or with no Origin is 403, a form or text body is 415, no credential is 401, another account\'s cookie is 401: no Google call and no key in any of them', async () => {
    seedOff();
    const { NextRequest } = nodeRequire('next/server');
    const evil = await calendarOn(TAL_TG, tal, { origin: 'https://evil.example' });
    const none = await calendarOn(TAL_TG, tal, { origin: null });
    assert(evil.status === 403 && none.status === 403, `origin: ${evil.status}, ${none.status}`);
    const form = await calendarOnRoute.POST(new NextRequest(`https://famcal.bot/api/signin-methods/calendar-on?user_id=${TAL_TG}`, {
      method: 'POST',
      headers: { origin: 'https://famcal.bot', 'content-type': 'application/x-www-form-urlencoded', 'x-telegram-init-data': tal.initData ?? '' },
      body: 'a=b',
    }));
    assert(form.status === 415, `form ${form.status}`);
    assert((await calendarOn(TAL_TG, {})).status === 401, 'no credential');
    assert((await calendarOn(NOA, { cookie: await sessionCookie(TAL, 'google') })).status === 401, "Tal's cookie for Noa");
    assert(world.googleAsks.length === 0 && userRow(TAL).googleAccountKey === null, `asked ${show(world.googleAsks)} key ${userRow(TAL).googleAccountKey}`);
  });

  await check('#43 Turn on acts on the proved account only (the id in the URL is not the account); a body that is not JSON is logged as a fact and the press still works; the route has the settings limiter and the Origin guard its neighbours have', async () => {
    seedOff();
    Object.assign(userRow(NOA), { googleRefreshToken: 'rt-noa', googleAccountKey: null });
    world.accounts['rt-noa'] = 'noa@gmail.com';
    const res = await calendarOnRoute.POST(request(`/api/signin-methods/calendar-on?user_id=${NOA_TG}`, { method: 'POST', ...tal }));
    assert(res.status === 401 || res.status === 403, `Tal for Noa's id: ${res.status}`);
    assert(userRow(NOA).googleAccountKey === null, "Noa's key was written");
    const ok = await calendarOnRoute.POST(request(`/api/signin-methods/calendar-on?user_id=${TAL_TG}`, { method: 'POST', ...tal }));
    assert(ok.status === 200 && userRow(TAL).googleAccountKey === KEY_TAL, `tal ${ok.status}`);
    assert(logs.some(l => l.includes('[signin-methods] the body is not JSON')) && !logs.some(l => /unexpected end of json|json input/i.test(l)), `logs ${show(logs)}`);
    const src = fs.readFileSync(path.join(ROOT, 'app/api/signin-methods/calendar-on/route.ts'), 'utf8');
    assert(src.includes('settingsRateLimiter') && src.includes('refuseCrossSite(request)'), 'the route lacks the settings limiter or the Origin guard its neighbours have');
  });

  await check('#39 no console line and no capture holds an email address, a sign-in code or an Add Google token', () => {
    const text = [...everyLog, ...everyCapture.map(c => `${c.context} ${c.message} ${show(c.extra)}`)].join('\n').toLowerCase();
    const addresses = ['tal@example.com', 'noa@example.com', 'dana@example.com', 'takl@example.com', 'tal@gmail.com', 'noa@gmail.com', 'old@gmail.com', 'nobody@gmail.com', 'noa2@example.com', 'shared@example.com', 'limit@example.com', 'down@example.com'];
    const found = addresses.filter(a => text.includes(a));
    const codes = everyMail.map(codeIn).filter(code => new RegExp(`\\b${code}\\b`).test(text));
    const tokens = addTokens.filter(t => t && text.includes(t.toLowerCase()));
    assert(found.length === 0 && codes.length === 0 && tokens.length === 0, `leaked: ${show({ found, codes, tokens })}`);
  });

  report();
}

// The harness captures console.*, so a crash is written straight to stdout.
main().catch(err => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
