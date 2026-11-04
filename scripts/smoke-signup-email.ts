// Smoke test for the email sign-up code (6c-1 plan, Task 4; spec docs/superpowers/specs/2026-11-03-web-sign-up-design.md
// §2.2, §2.5, §3.1, §3.2, §8 "Sign-up" and "Email budget"): POST /api/auth/email/request's after() for an address on no
// account, POST /api/auth/email/verify's sign-up branch, email-code.ts's 'signup' purpose, the sign-up email, the
// limits' sign-up share (counted for real), identities.ts's findWayByAddress, and flow.ts's sign-up record with its invite
// (src/lib/invite-token.ts).
//
//  - U1 with Turnstile, an address on no account gets a sign-up code at the address typed (normalised), in the page's
//    language (Hebrew right to left), kept as a keyed hash with its address and no account; the answer, its cookie and
//    the work before it are those of an address on an account
//  - U2 a right sign-up code answers { ok: true, redirect: https://famcal.bot/<locale>/signup } with a new famcal_signin
//    cookie (set, not cleared) for the flow { kind: 'signup', way: 'email', subject, address, locale }; the email flow
//    is used up, no session is made, and the old cookie can't be used again
//  - U3 without Turnstile, an address on no account is mailed nothing (6b's line), and its code check is "wrong"
//  - U4 a wrong sign-up code is a wrong code (counted for the address), and the right one still works after it; a wrong
//    code for an account's address asks no sign-up code
//  - U5 the 4th sign-up code from one client address is refused (no mail, the reason logged); another address gets one
//  - U6 the 31st sign-up code of the UTC day is refused and the admin told once; a sign-in code still goes out; the
//    sign-up codes are counted inside the day's 90
//  - U7 a right sign-up code for an address an account signs in with by now signs in as that account; for one a
//    Google way shows (in another case) it answers 'exists' with way 'google', no session and no sign-up flow; the
//    request never told
//  - U8 findWayByAddress: the email way first, a Google way by its stored address in any case, nothing else
//  - U10 capitals and spaces name the same address: an account's address typed so gets its sign-in code, never a
//    sign-up; a new address typed so starts a sign-up for its normalised form, which a later request then finds
//  - U11 a sign-up code entered in another browser (no famcal_signin cookie) answers 'restart' and makes nothing; the
//    first browser can still use it
//  - U12 cleanInviteToken (src/lib/invite-token.ts) and inviteOf: a sign-up record keeps a clean invite and drops a bad one
//  - U9 (run last) no console line or error report holds an address or a code
//
// Real: both routes, turnstile.ts, email-code, email-send, limits, flow, identities, fetch-retry, the session cookie and
// finishSignIn. Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, error capture, the
// admin notifier, Next's after(), and fetch (siteverify passes, Resend recorded). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-signup-email

import crypto from 'crypto';
import path from 'path';
import { createRequire } from 'module';
import {
  adminWarnings, assert, baseUser, body, check, DB, drainAfter, everyCapture, everyLog, identityRow, installSigninWorld,
  load, mails, prismaCalls, redisStore, report, request, resetWorld, ROOT, show, siteverifyCalls, type Row,
} from './lib/signin-world';

const nodeRequire = createRequire(__filename);
const SITE_KEY = '1x00000000000000000000AA';
const SECRET = 'smoke-signup-turnstile-secret-0001';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX-signup';
/** A partner invite token as pairing-service makes it: 64 lowercase hex characters. */
const INVITE = '0123456789abcdef'.repeat(4);
const MESSAGES: Row = {
  en: nodeRequire(path.join(ROOT, 'messages/en.json')),
  he: nodeRequire(path.join(ROOT, 'messages/he.json')),
  ru: nodeRequire(path.join(ROOT, 'messages/ru.json')),
};

function turnstile(on: boolean) {
  if (on) {
    process.env.TURNSTILE_SITE_KEY = SITE_KEY;
    process.env.TURNSTILE_SECRET = SECRET;
  } else {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET;
  }
}

/** 7 Kai (a Google way, its address as Google wrote it), 8 Noa (an email way, Hebrew). */
function seed() {
  resetWorld();
  DB.user = [
    baseUser({ id: 7, name: 'Kai', telegramId: BigInt(5550007) }),
    baseUser({ id: 8, name: 'Noa', telegramId: BigInt(5550008), language: 'he' }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: 7, kind: 'google', subject: 'google-sub-0007', address: 'Kai.Cohen@Gmail.com' }),
    identityRow({ userId: 8, kind: 'email', subject: 'noa@example.com', address: 'noa@example.com' }),
  ];
  DB.blockedIdentifier = [];
}

const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

async function main() {
  turnstile(false);
  await installSigninWorld();
  const retry = await load('src/utils/fetch-retry.ts');
  retry.__useRetryForTests({ sleep: async () => undefined, random: () => 0 });
  const requestRoute = await load('app/api/auth/email/request/route.ts');
  const verifyRoute = await load('app/api/auth/email/verify/route.ts');
  const { SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');
  const { SESSION_COOKIE_NAME, validateSessionToken } = await load('src/lib/session-auth.ts');
  const { emailKey } = await load('src/services/web-signin/email-address.ts');
  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const { findWayByAddress } = await load('src/services/web-signin/identities.ts');

  const typed: string[] = [];
  const codes = new Set<string>();
  const ask = async (email: string, o: { ip?: string | null; locale?: string } = {}) => {
    typed.push(email.trim());
    const res: Row = await requestRoute.POST(request('/api/auth/email/request', { body: { email, locale: o.locale ?? 'en', token: TOKEN }, ip: o.ip }));
    const value = res.cookies.get(SIGNIN_COOKIE_NAME)?.value as string | undefined;
    return { status: res.status as number, body: await body(res as Response), cookie: value ? `${SIGNIN_COOKIE_NAME}=${value}` : undefined };
  };
  /** Asks for a code, runs the after() work, and returns the email it sent (null when none) and the code in it. */
  const codeFor = async (email: string, o: { ip?: string | null; locale?: string } = {}) => {
    const before = mails.length;
    const asked = await ask(email, o);
    await drainAfter();
    const mail = mails.length > before ? mails[mails.length - 1] : null;
    const code = mail ? (/\b(\d{6})\b/.exec(String(mail.body.text))?.[1] ?? null) : null;
    if (code) codes.add(code);
    return { ...asked, mail, code };
  };
  const verify = async (cookie: string | undefined, code: string) => {
    const res: Row = await verifyRoute.POST(request('/api/auth/email/verify', { body: { code }, cookie }));
    return { res, status: res.status as number, body: await body(res as Response) };
  };
  const flows = () => [...redisStore.entries()].filter(([k]) => k.startsWith('signin:flow:')).map(([, v]) => JSON.parse(v) as Row);
  const sessionOf = (res: Row) => {
    const value = res.cookies.get(SESSION_COOKIE_NAME)?.value as string | undefined;
    return value ? validateSessionToken(value) : null;
  };

  await check('U1 with Turnstile, an address on no account gets a sign-up code at the address typed (normalised), in the page\'s language (Hebrew right to left), kept as a keyed hash with its address and no account; the answer, its cookie and the work before it are those of an address on an account', async () => {
    seed();
    turnstile(true);
    const known = await ask('noa@example.com', { locale: 'he' });
    const knownWork = { prisma: prismaCalls.length, siteverify: siteverifyCalls.length };
    const unknown = await ask('  New.Person@Example.com ', { locale: 'he', ip: '198.51.100.20' });
    const unknownWork = { prisma: prismaCalls.length - knownWork.prisma, siteverify: siteverifyCalls.length - knownWork.siteverify };
    assert(known.status === 200 && unknown.status === 200 && show(known.body) === show({ ok: true }) && show(unknown.body) === show(known.body), `answers ${show([known, unknown])}`);
    assert(known.cookie && unknown.cookie, 'a flow cookie for both');
    assert(show(knownWork) === show({ prisma: 0, siteverify: 1 }) && show(unknownWork) === show(knownWork), `the work before the answer: ${show({ knownWork, unknownWork })}`);
    assert(mails.length === 0, 'mailed before the answer');
    await drainAfter();
    assert((mails.length as number) === 2, `mails ${mails.length}`);
    const signup = mails.find((m) => m.to[0] === 'new.person@example.com');
    assert(signup, `no sign-up mail: ${show(mails.map((m) => m.to))}`);
    const code = /\b(\d{6})\b/.exec(String(signup.body.text))?.[1];
    assert(code, 'no code in the sign-up mail');
    codes.add(code);
    const he = MESSAGES.he.signinEmail.signup;
    assert(he && signup.body.subject === he.subject.replace('{code}', code), `subject ${signup.body.subject}`);
    const html = String(signup.body.html);
    assert(html.includes('dir="rtl"') && html.includes(he.heading) && String(signup.body.text).includes(he.body) && String(signup.body.text).includes(he.ignore), 'the Hebrew sign-up mail');
    const raw = redisStore.get(REDIS_KEYS.signinCode('signup', emailKey('new.person@example.com')));
    const record = raw ? (JSON.parse(raw) as Row) : null;
    assert(raw && record && /^[0-9a-f]{64}$/.test(record.hash) && record.address === 'new.person@example.com' && !('userId' in record) && !raw.includes(code), `the record ${raw}`);
    assert(!redisStore.has(REDIS_KEYS.signinCode('signin', emailKey('new.person@example.com'))), 'a sign-in code for an address on no account');
  });

  await check('U2 a right sign-up code answers { ok: true, redirect: /<locale>/signup } with a new famcal_signin cookie (set, not cleared) for the sign-up flow; the email flow is used up, no session is made, the old cookie can\'t be used again', async () => {
    seed();
    turnstile(true);
    const sent = await codeFor('new.person@example.com');
    assert(sent.code, 'no code');
    const before = flows();
    assert(before.length === 1 && before[0].kind === 'email', `flows before ${show(before)}`);
    const r = await verify(sent.cookie, sent.code);
    assert(r.status === 200 && show(r.body) === show({ ok: true, redirect: 'https://famcal.bot/en/signup' }), `${r.status} ${show(r.body)}`);
    const next = r.res.cookies.get(SIGNIN_COOKIE_NAME) as Row | undefined;
    assert(next?.value && `${SIGNIN_COOKIE_NAME}=${next.value}` !== sent.cookie && Number(next.maxAge) > 0 && next.path === '/api/auth' && next.httpOnly === true, `the new flow cookie ${show(next)}`);
    assert(!sessionOf(r.res), 'a session for an address with no account');
    const after = flows();
    const f = after[0] ?? {};
    assert(after.length === 1 && f.kind === 'signup' && f.way === 'email' && f.subject === 'new.person@example.com' && f.address === 'new.person@example.com' && f.locale === 'en' && typeof f.startedAt === 'number', `flows after ${show(after)}`);
    const again = await verify(sent.cookie, sent.code);
    assert(again.body.ok === false && again.body.error === 'restart', `the old email flow again: ${show(again.body)}`);
    const he = await codeFor('dalia@example.com', { locale: 'he', ip: '198.51.100.40' });
    assert(he.code, 'no Hebrew code');
    const rh = await verify(he.cookie, he.code);
    assert(show(rh.body) === show({ ok: true, redirect: 'https://famcal.bot/he/signup' }), `Hebrew ${show(rh.body)}`);
  });

  await check('U3 without Turnstile an address on no account is mailed nothing (6b\'s line), and a code check for it is "wrong"', async () => {
    seed();
    turnstile(false);
    const mark = everyLog.length;
    const r = await codeFor('new.person@example.com');
    assert(r.status === 200 && show(r.body) === show({ ok: true }) && r.cookie && !r.mail, `${r.status} ${show(r.body)} mail ${show(r.mail?.to)}`);
    assert(siteverifyCalls.length === 0, 'Cloudflare was asked without Turnstile');
    assert(everyLog.slice(mark).some((l) => l.includes('no account signs in with this address; no code sent')), `no line: ${show(everyLog.slice(mark))}`);
    const v = await verify(r.cookie, '123456');
    assert(v.body.ok === false && v.body.error === 'wrong', `the check ${show(v.body)}`);
  });

  await check('U4 a wrong sign-up code is a wrong code (counted for the address) and the right one still works after it; a wrong code for an account\'s address asks no sign-up code', async () => {
    seed();
    turnstile(true);
    const sent = await codeFor('new.person@example.com');
    assert(sent.code, 'no code');
    const wrong = await verify(sent.cookie, wrongOf(sent.code));
    assert(wrong.body.ok === false && wrong.body.error === 'wrong' && !sessionOf(wrong.res), `wrong ${show(wrong.body)}`);
    assert(redisStore.get(`signin:lim:wrong-email-day:${emailKey('new.person@example.com')}`) === '1', 'the wrong sign-up code was not counted');
    const right = await verify(sent.cookie, sent.code);
    assert(right.body.ok === true, `the right code after a wrong one: ${show(right.body)}`);
    const known = await codeFor('noa@example.com', { ip: '198.51.100.21' });
    assert(known.code, 'no sign-in code');
    await verify(known.cookie, wrongOf(known.code));
    assert(!redisStore.has(REDIS_KEYS.signinCodeTries('signup', emailKey('noa@example.com'))), 'a sign-up code was tried for an account\'s address');
  });

  await check('U5 the 4th sign-up code from one client address is refused (no mail, the reason logged, the same answer); another address still gets one', async () => {
    seed();
    turnstile(true);
    for (let i = 1; i <= 3; i++) {
      const r = await codeFor(`ip-${i}@example.com`, { ip: '198.51.100.7' });
      assert(r.mail && r.code, `sign-up code ${i} not sent`);
    }
    const mark = everyLog.length;
    const fourth = await codeFor('ip-4@example.com', { ip: '198.51.100.7' });
    assert(fourth.status === 200 && show(fourth.body) === show({ ok: true }) && fourth.cookie && !fourth.mail, `the 4th: ${show(fourth.body)} mail ${show(fourth.mail?.to)}`);
    assert(everyLog.slice(mark).some((l) => l.includes('no sign-up code (signup-ip-day)')), `no reason: ${show(everyLog.slice(mark))}`);
    const other = await codeFor('ip-5@example.com', { ip: '198.51.100.8' });
    assert(other.mail, 'another address got no sign-up code');
  });

  await check('U6 the 31st sign-up code of the UTC day is refused and the admin told once; a sign-in code still goes out; sign-up codes are counted inside the day\'s 90', async () => {
    seed();
    turnstile(true);
    for (let i = 1; i <= 30; i++) {
      const r = await codeFor(`day-${i}@example.com`, { ip: `198.51.100.${Math.ceil(i / 3)}` });
      assert(r.mail, `sign-up code ${i} not sent`);
    }
    assert(adminWarnings.length === 0, `the admin was told early: ${show(adminWarnings)}`);
    const mark = everyLog.length;
    const over = await codeFor('day-31@example.com', { ip: '198.51.100.11' });
    assert(over.status === 200 && show(over.body) === show({ ok: true }) && !over.mail, `the 31st: ${show(over.body)} mail ${show(over.mail?.to)}`);
    assert(everyLog.slice(mark).some((l) => l.includes('no sign-up code (signup-day)')), `no reason: ${show(everyLog.slice(mark))}`);
    const later = await codeFor('day-32@example.com', { ip: '198.51.100.12' });
    assert(!later.mail, 'the 32nd was sent');
    assert((adminWarnings.length as number) === 1 && adminWarnings[0].context === 'signin-signup-budget' && !/@/.test(adminWarnings[0].message), `admin messages ${show(adminWarnings)}`);
    const signin = await codeFor('noa@example.com', { ip: '198.51.100.13' });
    assert(signin.mail && signin.mail.to[0] === 'noa@example.com', 'the sign-in code did not go out after the sign-up share was spent');
    const today = new Date().toISOString().slice(0, 10);
    assert(redisStore.get(`signin:lim:daily-send:${today}`) === '31', `the 90's count is ${redisStore.get(`signin:lim:daily-send:${today}`)}, want 30 sign-up codes + 1 sign-in code`);
  });

  await check('U7 a right sign-up code for an address an account signs in with by now signs in as that account; for one a Google way shows (in another case) it answers "exists" with way google, no session and no sign-up flow; the request never told', async () => {
    seed();
    turnstile(true);
    const late = await codeFor('late@example.com');
    assert(late.code, 'no code');
    DB.signInIdentity.push(identityRow({ userId: 7, kind: 'email', subject: 'late@example.com', address: 'late@example.com' }));
    const signedIn = await verify(late.cookie, late.code);
    const session = sessionOf(signedIn.res);
    assert(signedIn.body.ok === true && String(signedIn.body.redirect).includes('user_id=7') && session?.userId === 7 && session.method === 'email', `signed in: ${show(signedIn.body)} ${show(session)}`);
    assert(!flows().some((f) => f.kind === 'signup'), 'a sign-up flow for an address on an account');

    const google = await codeFor('kai.cohen@gmail.com', { ip: '198.51.100.30' });
    assert(google.status === 200 && show(google.body) === show({ ok: true }) && google.mail && google.code, 'the request told, or mailed nothing, for an address a Google way shows');
    const exists = await verify(google.cookie, google.code);
    assert(show(exists.body) === show({ ok: false, error: 'exists', way: 'google' }), `exists ${show(exists.body)}`);
    assert(!sessionOf(exists.res) && exists.res.cookies.get(SIGNIN_COOKIE_NAME)?.value === '', 'a session, or the flow cookie not cleared');
    assert(!flows().some((f) => f.kind === 'signup'), 'a sign-up flow for an address a Google way shows');
  });

  await check('U8 findWayByAddress: the email way first, a Google way by its stored address in any case, nothing for another address', async () => {
    seed();
    assert(show(await findWayByAddress('noa@example.com')) === show({ kind: 'email', userId: 8 }), 'the email way');
    assert(show(await findWayByAddress('kai.cohen@gmail.com')) === show({ kind: 'google', userId: 7 }), 'the Google way in another case');
    assert((await findWayByAddress('kai.cohen@gmail.co')) === null && (await findWayByAddress('nobody@example.com')) === null, 'another address');
    DB.signInIdentity.push(identityRow({ userId: 9, kind: 'google', subject: 'google-sub-0009', address: 'both@example.com' }));
    DB.signInIdentity.push(identityRow({ userId: 10, kind: 'email', subject: 'both@example.com', address: 'both@example.com' }));
    assert(show(await findWayByAddress('both@example.com')) === show({ kind: 'email', userId: 10 }), 'the email way is not first');
  });

  await check('U10 capitals and spaces name the same address: " Noa@Example.COM " gets the account\'s sign-in code and signs in as it, never a sign-up; "New@Example.com" starts a sign-up for new@example.com, and once an account has that way a code request for "new@example.com" is that account\'s sign-in code', async () => {
    seed();
    turnstile(true);
    const known = await codeFor(' Noa@Example.COM ', { ip: '198.51.100.50' });
    assert(known.mail && known.mail.to[0] === 'noa@example.com' && known.code, `the account's address: ${show(known.mail?.to)}`);
    assert(!redisStore.has(REDIS_KEYS.signinCode('signup', emailKey('noa@example.com'))), 'a sign-up code for an account\'s address');
    const signedIn = await verify(known.cookie, known.code);
    assert(signedIn.body.ok === true && sessionOf(signedIn.res)?.userId === 8 && !flows().some((f) => f.kind === 'signup'), `signed in: ${show(signedIn.body)}`);
    const fresh = await codeFor('New@Example.com', { ip: '198.51.100.51' });
    assert(fresh.mail && fresh.mail.to[0] === 'new@example.com' && fresh.code, `no sign-up code for New@Example.com: ${show(fresh.mail?.to)}`);
    const started = await verify(fresh.cookie, fresh.code);
    const f = flows().find((x) => x.kind === 'signup');
    assert(started.body.ok === true && f?.subject === 'new@example.com' && f.address === 'new@example.com', `the sign-up flow ${show(f)}`);
    // The account Task 5's Create account makes from this flow: its email way is the flow's subject and address
    DB.user.push(baseUser({ id: 11, name: 'New' }));
    DB.signInIdentity.push(identityRow({ userId: 11, kind: 'email', subject: f.subject, address: f.address }));
    // A minute later (the address's 1 a minute: the typed text is normalised first, so it is the same address key)
    redisStore.delete(`signin:lim:email-minute:${emailKey('new@example.com')}`);
    const later = await codeFor('new@example.com', { ip: '198.51.100.52' });
    assert(later.mail && later.mail.to[0] === 'new@example.com' && later.code && redisStore.has(REDIS_KEYS.signinCode('signin', emailKey('new@example.com'))), `the later request: ${show(later.mail?.to)}`);
    const back = await verify(later.cookie, later.code);
    assert(back.body.ok === true && sessionOf(back.res)?.userId === 11, `signed in as the new account: ${show(back.body)}`);
  });

  await check('U11 a sign-up code entered in another browser (no famcal_signin cookie) answers "restart" and makes nothing: no session, no sign-up flow, the code untouched; the first browser can still enter it within its 10 minutes and reach /signup', async () => {
    seed();
    turnstile(true);
    const sent = await codeFor('other.browser@example.com', { ip: '198.51.100.60' });
    assert(sent.code && sent.cookie, 'no code');
    const users = DB.user.length;
    const key = emailKey('other.browser@example.com');
    const elsewhere = await verify(undefined, sent.code);
    assert(show(elsewhere.body) === show({ ok: false, error: 'restart' }) && !sessionOf(elsewhere.res), `browser B: ${show(elsewhere.body)}`);
    assert(DB.user.length === users && !flows().some((f) => f.kind === 'signup'), 'browser B made something');
    assert(redisStore.has(REDIS_KEYS.signinCode('signup', key)) && !redisStore.has(REDIS_KEYS.signinCodeTries('signup', key)), 'browser B touched the code');
    const here = await verify(sent.cookie, sent.code);
    assert(show(here.body) === show({ ok: true, redirect: 'https://famcal.bot/en/signup' }), `browser A after B: ${show(here.body)}`);
    assert(flows().some((f) => f.kind === 'signup' && f.subject === 'other.browser@example.com'), 'no sign-up flow in browser A');
  });

  await check('U12 the invite a sign-up carries: cleanInviteToken keeps 64 lowercase hex and nothing else; inviteOf reads it from a record and drops a bad one; a stored sign-up reads back with a clean invite, without a bad one, and a sign-up of an unknown way reads as nothing', async () => {
    seed();
    const { cleanInviteToken } = await load('src/lib/invite-token.ts');
    const { inviteOf, takeFlow } = await load('src/services/web-signin/flow.ts');
    assert(cleanInviteToken(INVITE) === INVITE, 'a real token is dropped');
    for (const bad of [INVITE.toUpperCase(), INVITE.slice(1), `${INVITE}0`, ` ${INVITE}`, `../${INVITE.slice(3)}`, 'g'.repeat(64), 64, null, undefined, [INVITE]]) {
      assert(cleanInviteToken(bad) === null, `kept ${show(bad)}`);
      assert(show(inviteOf({ invite: bad })) === '{}', `inviteOf kept ${show(bad)}`);
    }
    assert(show(inviteOf({ invite: INVITE })) === show({ invite: INVITE }) && show(inviteOf({})) === '{}', 'inviteOf');
    const flowId = 'A'.repeat(43);
    const cookie = `${SIGNIN_COOKIE_NAME}=${flowId}`;
    const recordKey = REDIS_KEYS.signinFlow(crypto.createHash('sha256').update(flowId).digest('hex'));
    const startedAt = Date.now();
    const base = { kind: 'signup', way: 'email', subject: 'new.person@example.com', address: 'new.person@example.com', locale: 'he' };
    const cases: [unknown, Row][] = [[INVITE, { invite: INVITE }], [`${INVITE}0`, {}], [undefined, {}]];
    for (const [invite, want] of cases) {
      redisStore.set(recordKey, JSON.stringify({ ...base, startedAt, ...(invite === undefined ? {} : { invite }) }));
      const flow = await takeFlow(request('/api/auth/signup', { cookie }), ['signup']);
      assert(show(flow) === show({ ...base, ...want, startedAt }), `the sign-up read back (invite ${show(invite)}): ${show(flow)}`);
    }
    redisStore.set(recordKey, JSON.stringify({ ...base, startedAt, way: 'telegram' }));
    assert((await takeFlow(request('/api/auth/signup', { cookie }), ['signup'])) === null, 'a sign-up of an unknown way');
  });

  await check('U9 no console line or error report holds an address or a code', () => {
    const addresses = [...new Set(typed.map((a) => a.toLowerCase()))];
    const codeRes = [...codes].map((c) => new RegExp(`\\b${c}\\b`));
    const holds = (text: string) => addresses.some((a) => text.toLowerCase().includes(a)) || codeRes.some((re) => re.test(text)) || text.includes(TOKEN) || text.includes(SECRET);
    const lines = everyLog.filter(holds);
    assert(lines.length === 0, `console lines: ${show(lines.slice(0, 5))}`);
    const reports = everyCapture.filter((c) => holds(show(c)));
    assert(reports.length === 0, `error reports: ${show(reports.slice(0, 5))}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
