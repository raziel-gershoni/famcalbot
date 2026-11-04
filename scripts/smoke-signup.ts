// Smoke test for web sign-up (spec docs/superpowers/specs/2026-11-03-web-sign-up-design.md §2.2, §2.3, §2.6, §2.20,
// §2.22, §3.3, §3.4, §3.8, §8 "Sign-up"; plan 6c-1 Task 5): the end of a Google or email-code sign-in that found no
// account.
//
//  - S1 Google `new` (no Google way with this sub, no account holding this address's calendar key, no way showing the
//    address): the callback goes to /{locale}/signup with a live famcal_signin whose record holds the way, the sub, the
//    address, the language and the invite (a malformed invite dropped); no session, no account
//  - S2 a calendar holder that doesn't match (a disagreeing live check, its switch off, another Google way) keeps
//    no-account, and two holders keep several, with the flow cookie cleared and no sign-up record
//  - S3 a verified address that is another account's email way: status=exists-email, no sign-up
//  - S4 bans at Google: a banned sub, a banned address (sign-up), a banned verified address at a sign-in
//  - S5 the record: GET reads it without using it up; Create account takes it (one use); no cookie, or another kind's
//    flow (left alone), is restart; GET is no-store
//  - S6 the record lives 10 minutes
//  - S7 the name: cleanName's rule, refused before the record is touched
//  - S8 a way taken in the meantime: taken
//  - S9 / S10 the account: one user, one way, one primary FamCal calendar, the page's language, the session's method
//  - S11 bans at Create account (a Google sub, a Google sign-up's address, an email address)
//  - S12 5 new accounts a day per IPv4 address or IPv6 /48; no address is not counted and is logged
//  - S13 an address already in use, both ways round: exists, on GET and on Create account
//  - S14 Create account from another site is refused and the record stays
//  - S15 a sign-up record under the cookie is not a Google flow: the callback says restart and leaves it
//  - S16 a browser that holds a session but no sign-up record: GET and Create account are restart, and nothing is made
//  - S17 the new-accounts cap's store failing (Redis down) is failed (503), not limit, and nothing is made
//  - S18 a Sentry error event of POST /api/auth/signup holds no name (its body as an object, JSON, cut-off JSON or a form)
//  - S19 no console line or Sentry report holds an address, a sub, a name or a cookie value
//
// Real: the Google callback, oidc-route, google-signin, calendar-account, identities, flow, signup, the signup route,
// user-service's createAccount, the native calendar onboarding, user-moderation, limits, finishSignIn, session-auth,
// sentry-scrub.
// Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory (Redis with its expiry clock),
// error capture, Telegram, the OIDC exchange (scripted claims), the calendar's Google account, fetch. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-signup

import crypto from 'crypto';
import {
  advanceRedis, assert, baseUser, body, check, DB, everyCapture, everyLog, fakeRedis, flowCookie, identityRow,
  fakePrisma, installSigninWorld, load, logs, redisStore, report, request, resetWorld, show, world, type Row,
} from './lib/signin-world';

const TAL = 9;
const TAL_TG = 111111111;
const NOA = 7;
const NOA_TG = 222222222;
const DANA = { sub: 'g-dana-sub-7781', email: 'dana@gmail.com' };
const NAME = 'Dana Levi';
const INVITE = 'ab'.repeat(32);

async function main() {
  await installSigninWorld();
  /** A module this task adds: null (logged) until it exists, so every check runs and says what is missing. */
  const soft = async (rel: string): Promise<Row | null> => {
    try {
      return await load(rel);
    } catch (error) {
      console.error(`[smoke] ${rel} did not load: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      return null;
    }
  };
  const callbackRoute = await load('app/api/auth/google/callback/route.ts');
  const account = await load('src/services/web-signin/calendar-account.ts');
  const { SESSION_COOKIE_NAME, createSessionToken, validateSessionToken } = await load('src/lib/session-auth.ts');
  const { SIGNIN_COOKIE_NAME, peekFlow } = await load('src/services/web-signin/flow.ts');
  const signupRoute = await soft('app/api/auth/signup/route.ts');
  const signup = await soft('src/services/web-signin/signup.ts');
  const need = (mod: Row | null, what: string): Row => {
    assert(mod, `${what} does not exist yet`);
    return mod;
  };

  const KEY_TAL: string = account.googleAccountKey('tal@gmail.com');

  function seed(): void {
    resetWorld();
    DB.user = [
      baseUser({ id: TAL, name: 'Tal', telegramId: BigInt(TAL_TG), googleRefreshToken: 'rt-tal', googleAccountKey: KEY_TAL }),
      baseUser({ id: NOA, name: 'Noa', telegramId: BigInt(NOA_TG) }),
    ];
    DB.signInIdentity = [identityRow({ userId: NOA, kind: 'email', subject: 'noa@example.com', address: 'noa@example.com' })];
    DB.nativeCalendar = [];
    DB.blockedIdentifier = [];
    world.accounts = { 'rt-tal': 'tal@gmail.com' };
  }
  const userRow = (id: number): Row => DB.user.find(u => u.id === id) as Row;
  const usersNamed = (name: string): Row[] => DB.user.filter(u => u.name === name);
  const ban = (row: Row): void => {
    DB.blockedIdentifier = [{ id: 1, telegramId: null, whatsappPhone: null, googleSub: null, email: null, reason: null, createdAt: new Date(), ...row }];
  };

  const location = (res: Row): string => res.headers.get('location') ?? '';
  const setCookie = (res: Row, name: string): string => ((res.headers.getSetCookie?.() ?? []) as string[]).find(c => c.startsWith(`${name}=`)) ?? '';
  const flowValue = (res: Row): string => setCookie(res, SIGNIN_COOKIE_NAME).split(';')[0].slice(SIGNIN_COOKIE_NAME.length + 1);
  const flowCleared = (res: Row): boolean => {
    const c = setCookie(res, SIGNIN_COOKIE_NAME);
    return /^famcal_signin=;/.test(c) && /Max-Age=0/i.test(c);
  };
  /** The flow record a famcal_signin value names, or null. */
  const recordOf = (value: string): Row | null => {
    const raw = redisStore.get(`signin:flow:${crypto.createHash('sha256').update(value).digest('hex')}`);
    return raw === undefined ? null : JSON.parse(raw);
  };
  const anySignUpRecord = (): boolean => [...redisStore.entries()].some(([k, v]) => k.startsWith('signin:flow:') && v.includes('"signup"'));
  const sessionOf = (res: Row) => {
    const value = res.cookies.get(SESSION_COOKIE_NAME)?.value;
    return value ? validateSessionToken(value) : null;
  };

  let flows = 0;
  /** "Continue with Google" back on the callback with these claims (verified), from a sign-in begun in `locale`. */
  const googleCallback = async (claims: Row, o: { locale?: string; invite?: unknown } = {}) => {
    const state = `st-${++flows}`;
    const cookie = await flowCookie({ kind: 'google', state, nonce: `n-${flows}`, codeVerifier: 'v'.repeat(43), locale: o.locale ?? 'en', ...(o.invite !== undefined ? { invite: o.invite } : {}) });
    world.claims = { emailVerified: true, ...claims };
    return callbackRoute.GET(request(`/api/auth/google/callback?code=c-${flows}&state=${state}`, { cookie }));
  };
  /** A sign-up record as the callback or the email verify leaves it, and its cookie header. */
  const signUpFlow = (o: Row = {}) => flowCookie({ kind: 'signup', way: 'google', subject: DANA.sub, address: DANA.email, locale: 'en', ...o });
  const view = async (cookie?: string) => body(await need(signupRoute, 'GET /api/auth/signup').GET(request('/api/auth/signup', { cookie })));
  const create = (cookie: string | undefined, b: unknown, o: { ip?: string | null; origin?: string | null } = {}) =>
    need(signupRoute, 'POST /api/auth/signup').POST(request('/api/auth/signup', { body: b, cookie, ...o }));

  // ---- Google: when it asks for sign-up ----

  await check('S1 a Google sign-in no account holds in any way starts the sign-up: the callback goes to /en/signup with a live famcal_signin (43 characters, HttpOnly, Secure, Lax, Path=/api/auth, 10 minutes) whose record holds the way, the sub, the address and the language; no session, no account, no way; the invite rides along in Hebrew, and a malformed one is dropped', async () => {
    seed();
    const users = DB.user.length;
    const res = await googleCallback(DANA);
    assert(location(res) === 'https://famcal.bot/en/signup', `location ${location(res)}`);
    const cookie = setCookie(res, SIGNIN_COOKIE_NAME);
    const value = flowValue(res);
    assert(/^[A-Za-z0-9_-]{43}$/.test(value) && /Path=\/api\/auth/i.test(cookie) && /Max-Age=600/i.test(cookie) && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=lax/i.test(cookie), `famcal_signin ${cookie}`);
    const record = recordOf(value);
    assert(record?.kind === 'signup' && record.way === 'google' && record.subject === DANA.sub && record.address === DANA.email && record.locale === 'en' && typeof record.startedAt === 'number' && !('invite' in record), `record ${show(record)}`);
    assert(!sessionOf(res) && DB.user.length === users && DB.signInIdentity.length === 1, 'an account, a way or a session was made');
    const he = await googleCallback(DANA, { locale: 'he', invite: INVITE });
    assert(location(he) === 'https://famcal.bot/he/signup' && recordOf(flowValue(he))?.invite === INVITE, `he ${location(he)} ${show(recordOf(flowValue(he)))}`);
    const bad = await googleCallback(DANA, { invite: 'not-a-token' });
    const badRecord = recordOf(flowValue(bad));
    assert(badRecord?.kind === 'signup' && !('invite' in badRecord), `a malformed invite rode along: ${show(badRecord)}`);
  });

  await check('S2 a calendar holder that does not match keeps the no-account page (a live check that disagrees, its switch off, another Google way), and two holders keep several: no sign-up record, the flow cookie cleared, no session', async () => {
    const cases: [string, () => void, string][] = [
      ['a live check that disagrees', () => { world.accounts['rt-tal'] = 'someone@gmail.com'; }, 'no-account'],
      ['a holder whose sign-in switch is off', () => { userRow(TAL).googleCalendarSignIn = false; }, 'no-account'],
      ['a holder that has another Google way', () => { DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-old', address: 'old@gmail.com' })); }, 'no-account'],
      ['two holders', () => { DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL })); }, 'several'],
    ];
    for (const [name, setup, status] of cases) {
      seed();
      setup();
      const res = await googleCallback({ sub: 'g-tal-new', email: 'tal@gmail.com' });
      assert(location(res) === `https://famcal.bot/en/signin?status=${status}`, `${name}: ${location(res)}`);
      assert(flowCleared(res) && !anySignUpRecord() && !sessionOf(res), `${name}: a sign-up record, a live cookie or a session`);
    }
  });

  await check('S3 a Google sign-in whose verified address is another account\'s email way lands on /signin?status=exists-email: no sign-up record, no session, and that email way is not touched', async () => {
    seed();
    const res = await googleCallback({ sub: 'g-noa', email: 'noa@example.com' });
    assert(location(res) === 'https://famcal.bot/en/signin?status=exists-email', `location ${location(res)}`);
    assert(flowCleared(res) && !anySignUpRecord() && !sessionOf(res) && DB.signInIdentity[0].lastUsedAt === null, 'a record, a session, or the way touched');
  });

  await check('S4 bans at Google: a banned Google sub and a banned address (a would-be sign-up), and a sign-in by an existing Google way whose verified address is banned, each land on status=blocked with no record and no session', async () => {
    for (const [name, row] of [['sub', { googleSub: DANA.sub }], ['address', { email: DANA.email }]] as const) {
      seed();
      ban(row);
      const res = await googleCallback(DANA);
      assert(location(res) === 'https://famcal.bot/en/signin?status=blocked' && flowCleared(res) && !anySignUpRecord() && !sessionOf(res), `${name}: ${location(res)}`);
    }
    seed();
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal.work@gmail.com' }));
    ban({ email: 'tal.work@gmail.com' });
    const res = await googleCallback({ sub: 'g-tal', email: 'tal.work@gmail.com' });
    assert(location(res) === 'https://famcal.bot/en/signin?status=blocked' && !sessionOf(res), `sign-in: ${location(res)}`);
  });

  // ---- The record ----

  await check('S5 the record: GET reads it without using it up ({ way, address }, twice, no-store); Create account takes it, so a second one, and a GET after it, are restart; no cookie is restart; another kind\'s flow under the cookie is restart and is left for its own step', async () => {
    seed();
    const cookie = await signUpFlow();
    const first = await need(signupRoute, 'GET /api/auth/signup').GET(request('/api/auth/signup', { cookie }));
    assert((first.headers.get('cache-control') ?? '').includes('no-store'), `cache ${first.headers.get('cache-control')}`);
    assert(show(await body(first)) === show({ way: 'google', address: DANA.email }) && show(await view(cookie)) === show({ way: 'google', address: DANA.email }), 'the view');
    const made = await body(await create(cookie, { name: NAME }));
    assert(made.ok === true, `made ${show(made)}`);
    const again = await body(await create(cookie, { name: NAME }));
    assert(show(again) === show({ ok: false, status: 'restart' }) && usersNamed(NAME).length === 1, `again ${show(again)}`);
    assert(show(await view(cookie)) === show({ restart: true }), 'GET after the take');
    assert(show(await view()) === show({ restart: true }) && show(await body(await create(undefined, { name: NAME }))) === show({ ok: false, status: 'restart' }), 'no cookie');
    const emailFlow = await flowCookie({ kind: 'email', emailKey: 'k'.repeat(32), locale: 'en' });
    assert(show(await view(emailFlow)) === show({ restart: true }) && show(await body(await create(emailFlow, { name: NAME }))) === show({ ok: false, status: 'restart' }), 'an email flow');
    assert((await peekFlow(request('/api/auth/email/verify', { cookie: emailFlow }), 'email'))?.emailKey === 'k'.repeat(32), 'the email flow was used up');
  });

  await check('S6 the record lives 10 minutes: after them GET and Create account are restart and no account is made', async () => {
    seed();
    const cookie = await signUpFlow();
    advanceRedis(601_000);
    assert(show(await view(cookie)) === show({ restart: true }), 'GET after 10 minutes');
    assert(show(await body(await create(cookie, { name: NAME }))) === show({ ok: false, status: 'restart' }) && usersNamed(NAME).length === 0, 'Create account after 10 minutes');
  });

  await check('S7 the name: trimmed, 1 to 60 characters (counted as characters, so 60 emoji pass); empty, blank, 61 characters, a C0 or C1 control, a direction mark, override or isolate, Arabic\'s letter mark, a zero-width character, a lone surrogate, or not text is refused with status=name (400) before the record is touched: it still answers, and a good name then works', async () => {
    const s = need(signup, 'signup.ts');
    assert(s.cleanName('  דנה לוי  ') === 'דנה לוי' && s.cleanName('x'.repeat(60)) === 'x'.repeat(60) && s.cleanName('😀'.repeat(60)) === '😀'.repeat(60) && s.cleanName('Дана') === 'Дана', 'a good name refused');
    const bad: unknown[] = [
      '', '   ', 'x'.repeat(61), '😀'.repeat(61), 'Da\u0007na', 'Da\nna', 'Da\u007Fna', 'Da\u0085na', 'Da\u202Ena', 'Da\u202Ana', 'Da\u2066na', 'Da\u2069na',
      'Da\u200Ena', 'Da\u200Fna', 'Da\u061Cna', 'Da\u200Bna', 'Da\u200Dna', 'Da\u2060na', 'Da\uFEFFna', 'Da\u2028na', 'Da\uD800na', 42, null, ['Dana'],
    ];
    for (const input of bad) assert(s.cleanName(input) === null, `cleanName accepted ${show(input)}`);
    seed();
    const cookie = await signUpFlow();
    for (const input of [...bad, undefined]) {
      const res = await create(cookie, input === undefined ? {} : { name: input });
      const answer = await body(res);
      assert(res.status === 400 && show(answer) === show({ ok: false, status: 'name' }), `${show(input)}: ${res.status} ${show(answer)}`);
    }
    assert(show(await view(cookie)) === show({ way: 'google', address: DANA.email }) && DB.user.length === 2, 'a refused name used the record or made an account');
    assert((await body(await create(cookie, { name: `  ${NAME} ` }))).ok === true && usersNamed(NAME).length === 1, 'a good name after the refusals');
  });

  await check('S8 a way taken in the meantime (another account got this Google sub, under another address) is status=taken: no session, the flow cookie cleared, still one way with that sub', async () => {
    seed();
    const cookie = await signUpFlow();
    DB.signInIdentity.push(identityRow({ userId: NOA, kind: 'google', subject: DANA.sub, address: 'dana.old@gmail.com' }));
    const res = await create(cookie, { name: NAME });
    assert(show(await body(res)) === show({ ok: false, status: 'taken' }) && !sessionOf(res) && flowCleared(res), `taken ${show(await body(res))}`);
    assert(DB.signInIdentity.filter(i => i.subject === DANA.sub).length === 1, 'a second way with that sub');
  });

  // ---- The account ----

  await check('S9 the account, Google: one user (the trimmed name, no Telegram or WhatsApp, the page\'s language he), one Google way (the sub and the address), one primary FamCal calendar; the session cookie for it with method google; the answer names /he/dashboard; the flow cookie cleared', async () => {
    seed();
    const cookie = await signUpFlow();
    const res = await create(cookie, { name: ` ${NAME} `, locale: 'he' });
    const answer = await body(res);
    const [user] = usersNamed(NAME);
    assert(user && DB.user.length === 3, `users ${show(DB.user.map(u => u.name))}`);
    assert(user.telegramId == null && user.whatsappPhone == null && user.whatsappBsuid == null && user.language === 'he', `user ${show(user)}`);
    assert(show(answer) === show({ ok: true, redirect: `https://famcal.bot/he/dashboard?user_id=${user.id}` }), `answer ${show(answer)}`);
    const session = sessionOf(res);
    assert(session?.userId === user.id && session.method === 'google', `session ${show(session)}`);
    const ways = DB.signInIdentity.filter(i => i.userId === user.id);
    assert(ways.length === 1 && ways[0].kind === 'google' && ways[0].subject === DANA.sub && ways[0].address === DANA.email, `ways ${show(ways)}`);
    const calendars = (DB.nativeCalendar ?? []).filter(c => c.ownerUserId === user.id);
    assert(calendars.length === 1, `calendars ${show(calendars)}`);
    assert(flowCleared(res), 'the flow cookie stays');
  });

  await check('S10 the account, email: one user in the sign-in\'s language when the page sends none (or one that is not ours), one email way (the normalised address as subject and address), one calendar, the session with method email', async () => {
    for (const locale of [undefined, 'xx']) {
      seed();
      const cookie = await signUpFlow({ way: 'email', subject: 'rivka@example.com', address: 'rivka@example.com', locale: 'ru' });
      const res = await create(cookie, locale === undefined ? { name: 'Rivka' } : { name: 'Rivka', locale });
      const [user] = usersNamed('Rivka');
      assert(user && user.language === 'ru' && (await body(res)).redirect === `https://famcal.bot/ru/dashboard?user_id=${user.id}`, `${show(locale)}: ${show(user)} ${show(await body(res))}`);
      const session = sessionOf(res);
      assert(session?.userId === user.id && session.method === 'email', `session ${show(session)}`);
      const ways = DB.signInIdentity.filter(i => i.userId === user.id);
      assert(ways.length === 1 && ways[0].kind === 'email' && ways[0].subject === 'rivka@example.com' && ways[0].address === 'rivka@example.com', `ways ${show(ways)}`);
      assert((DB.nativeCalendar ?? []).filter(c => c.ownerUserId === user.id).length === 1, 'calendars');
    }
  });

  // ---- Refusals ----

  await check('S11 bans at Create account (one that came in the 10 minutes): a banned Google sub, a Google sign-up whose address is banned, and a banned email address are status=blocked (403) with no account and no session, and the record is used; a refused attempt takes no place in the 5 a day of its address (5 banned attempts, then an unbanned sign-up from the same address is made)', async () => {
    const cases: [string, Row, Row][] = [
      ['Google sub', {}, { googleSub: DANA.sub }],
      ['Google address', {}, { email: DANA.email }],
      ['email address', { way: 'email', subject: 'rivka@example.com', address: 'rivka@example.com' }, { email: 'rivka@example.com' }],
    ];
    for (const [name, flow, row] of cases) {
      seed();
      const cookie = await signUpFlow(flow);
      ban(row);
      const res = await create(cookie, { name: NAME });
      assert(res.status === 403 && show(await body(res)) === show({ ok: false, status: 'blocked' }) && usersNamed(NAME).length === 0 && !sessionOf(res), `${name}: ${res.status} ${show(await body(res))}`);
      assert(show(await view(cookie)) === show({ restart: true }), `${name}: the record survived`);
    }
    // The ban is read before the cap counts the attempt: 5 refused attempts from one address leave its next, unbanned sign-up its place
    seed();
    ban({ googleSub: DANA.sub });
    for (let i = 1; i <= 5; i++) {
      const refused = await create(await signUpFlow(), { name: NAME }, { ip: '198.51.100.9' });
      assert(refused.status === 403, `banned attempt #${i}: ${refused.status}`);
    }
    const unbanned = await create(await signUpFlow({ way: 'email', subject: 'rivka@example.com', address: 'rivka@example.com' }), { name: 'Rivka' }, { ip: '198.51.100.9' });
    assert(show(await body(unbanned)).startsWith('{"ok":true') && usersNamed('Rivka').length === 1, `the 6th attempt, unbanned, from the same address: ${unbanned.status} ${show(await body(unbanned))}`);
  });

  await check('S12 new accounts per internet address: 5 a day from one IPv4 address, the 6th is status=limit with no account; IPv6 counts by its /48 (5 from different /64s of one /48, the 6th refused, another /48 still works); no address skips the count and logs it', async () => {
    seed();
    const make = async (i: number, ip: string | null) => {
      const cookie = await signUpFlow({ way: 'email', subject: `p${i}@example.com`, address: `p${i}@example.com` });
      return body(await create(cookie, { name: `Person ${i}` }, { ip }));
    };
    for (let i = 1; i <= 5; i++) assert((await make(i, '198.51.100.7')).ok === true, `IPv4 #${i}`);
    assert(show(await make(6, '198.51.100.7')) === show({ ok: false, status: 'limit' }) && usersNamed('Person 6').length === 0, 'the 6th from one IPv4 address');
    for (let i = 1; i <= 5; i++) assert((await make(10 + i, `2001:db8:abcd:${i}::1`)).ok === true, `IPv6 #${i}`);
    assert(show(await make(16, '2001:db8:abcd:6::1')) === show({ ok: false, status: 'limit' }) && usersNamed('Person 16').length === 0, 'the 6th from one /48');
    assert((await make(17, '2001:db8:abce:1::1')).ok === true, 'another /48');
    logs.length = 0;
    for (let i = 0; i < 7; i++) assert((await make(20 + i, null)).ok === true, `no address #${i}`);
    assert(logs.some(l => l.includes('[signup] no client address; the account cap is not counted')), `logs ${show(logs.filter(l => l.startsWith('[signup]')))}`);
  });

  await check('S13 an address already in use, both ways round: a Google sign-up whose address another account now signs in with by email code (exists email), and an email sign-up whose address another account\'s Google way shows (exists google), on GET and on Create account, with no account', async () => {
    seed();
    const google = await signUpFlow();
    DB.signInIdentity.push(identityRow({ userId: NOA, kind: 'email', subject: DANA.email, address: DANA.email }));
    assert(show(await view(google)) === show({ exists: 'email' }), `GET ${show(await view(google))}`);
    assert(show(await body(await create(google, { name: NAME }))) === show({ ok: false, status: 'exists', way: 'email' }) && usersNamed(NAME).length === 0, 'Create account, Google');
    seed();
    const email = await signUpFlow({ way: 'email', subject: 'tal.work@gmail.com', address: 'tal.work@gmail.com' });
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal.work@gmail.com' }));
    assert(show(await view(email)) === show({ exists: 'google' }), `GET ${show(await view(email))}`);
    assert(show(await body(await create(email, { name: NAME }))) === show({ ok: false, status: 'exists', way: 'google' }) && usersNamed(NAME).length === 0, 'Create account, email');
  });

  await check('S14 Create account from another site, or with no Origin, is refused (403) before anything is read, and the record stays', async () => {
    seed();
    const cookie = await signUpFlow();
    for (const origin of ['https://evil.example', null]) {
      const res = await create(cookie, { name: NAME }, { origin });
      assert(res.status === 403 && usersNamed(NAME).length === 0, `${origin}: ${res.status}`);
    }
    assert(show(await view(cookie)) === show({ way: 'google', address: DANA.email }), 'the record was used');
  });

  await check('S15 a sign-up record under the cookie is not a Google or Telegram flow: the Google callback says restart and leaves it for /signup', async () => {
    seed();
    const cookie = await signUpFlow();
    world.claims = { ...DANA, emailVerified: true };
    const res = await callbackRoute.GET(request('/api/auth/google/callback?code=c&state=s', { cookie }));
    assert(location(res) === 'https://famcal.bot/en/signin?status=restart', `location ${location(res)}`);
    assert(show(await view(cookie)) === show({ way: 'google', address: DANA.email }), 'the sign-up record was used');
  });

  await check('S16 a browser already signed in (a valid session cookie) but with no sign-up record: GET is restart, and Create account is restart with no account, no way and no new session cookie', async () => {
    seed();
    const users = DB.user.length;
    const ways = DB.signInIdentity.length;
    const session = `${SESSION_COOKIE_NAME}=${createSessionToken(TAL, 'google', Date.now())}`;
    assert(show(await view(session)) === show({ restart: true }), `GET ${show(await view(session))}`);
    const res = await create(session, { name: NAME });
    assert(show(await body(res)) === show({ ok: false, status: 'restart' }), `Create account ${show(await body(res))}`);
    assert(DB.user.length === users && DB.signInIdentity.length === ways && !res.cookies.get(SESSION_COOKIE_NAME), 'an account, a way or a session cookie was made');
  });

  await check('S17 the new-accounts cap with its store failing (Redis down at the count): status=failed (503), not limit; no account, no session, the flow cookie cleared', async () => {
    seed();
    const cookie = await signUpFlow({ way: 'email', subject: 'rivka@example.com', address: 'rivka@example.com' });
    const realEval = fakeRedis.eval;
    fakeRedis.eval = async (script: string, keys: string[], args: string[]) => {
      if (String(keys[0]).includes('accounts-ip-day')) throw new Error('Redis is down (smoke)');
      return realEval(script, keys, args);
    };
    try {
      const res = await create(cookie, { name: 'Rivka' });
      assert(res.status === 503 && show(await body(res)) === show({ ok: false, status: 'failed' }), `${res.status} ${show(await body(res))}`);
      assert(usersNamed('Rivka').length === 0 && !sessionOf(res) && flowCleared(res), 'an account, a session, or the flow cookie kept');
    } finally {
      fakeRedis.eval = realEval;
    }
  });

  await check('S20 createAccount failing on something unclassified (a transient database error): status=failed (500), the sign-up is put back under a new cookie with the time it had left, no account, no session, and pressing Create account again makes the account', async () => {
    seed();
    const cookie = await signUpFlow();
    const original = recordOf(cookie.split('=')[1]);
    const users = fakePrisma.user;
    const realCreate = users.create;
    users.create = async () => {
      throw Object.assign(new Error('Server has closed the connection (smoke)'), { code: 'P1017' });
    };
    let res: Response;
    try {
      res = await create(cookie, { name: NAME });
    } finally {
      users.create = realCreate;
    }
    assert(res.status === 500 && show(await body(res)) === show({ ok: false, status: 'failed' }) && usersNamed(NAME).length === 0 && !sessionOf(res), `${res.status} ${show(await body(res))}`);
    const value = flowValue(res);
    const back = recordOf(value);
    assert(/^[A-Za-z0-9_-]{43}$/.test(value) && back?.kind === 'signup' && back.subject === DANA.sub && back.startedAt === original?.startedAt, `put back ${show(back)} vs ${show(original)}`);
    const again = await create(`${SIGNIN_COOKIE_NAME}=${value}`, { name: NAME });
    assert((await body(again)).ok === true && usersNamed(NAME).length === 1, `again ${again.status} ${show(await body(again))}`);
  });

  await check('S18 a Sentry error event of POST /api/auth/signup holds no name: its body as an object or a JSON string loses the name, cut-off JSON and a form have it scrubbed; the language stays', async () => {
    const { scrubServerEvent } = await load('src/lib/sentry-scrub.ts');
    const dataOf = (data: unknown) => scrubServerEvent({ request: { url: 'https://famcal.bot/api/auth/signup', method: 'POST', data } }).request.data;
    const object = dataOf({ name: NAME, locale: 'he' });
    assert(show(object) === show({ locale: 'he' }), `object ${show(object)}`);
    const json = dataOf(JSON.stringify({ name: NAME, locale: 'he' }));
    assert(json === JSON.stringify({ locale: 'he' }), `JSON ${show(json)}`);
    const cut = dataOf(`{"locale":"he","name":"${NAME}","x":"a`);
    assert(String(cut) === '{"locale":"he","name":"[scrubbed]","x":"a', `cut-off JSON ${show(cut)}`);
    const form = dataOf(`name=${encodeURIComponent(NAME)}&locale=he`);
    assert(form === 'name=[scrubbed]&locale=he', `form ${show(form)}`);
  });

  await check('S19 no console line or Sentry report of the run holds an address, a Google sub, a name or a famcal_signin value', () => {
    const secrets = [DANA.email, DANA.sub, NAME, 'Rivka', 'rivka@example.com', 'tal.work@gmail.com', 'noa@example.com', 'p1@example.com'];
    const lines = [...everyLog, ...everyCapture.map(c => `${c.context} ${c.message} ${show(c.extra)}`)];
    const leaked = lines.filter(l => secrets.some(s => l.includes(s)) || /famcal_signin=[A-Za-z0-9_-]{43}/.test(l));
    assert(leaked.length === 0, `leaked ${show(leaked.slice(0, 5))}`);
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
