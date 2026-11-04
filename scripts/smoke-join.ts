// Smoke test for Join (web sign-up spec 2026-11-03 §2.9, §3.6, §8 "Join"; plan Task 7): Settings' Add Google and Add
// email may end on a way that an account made on famcal.bot holds (W, no chat). Instead of 6b's `taken`, the person is
// asked whether to join W into this account (T), with what moves; the answer runs the WhatsApp merge, taught that W may
// have no chat (mergeIntoAccount, its decisions from mergePlan).
//
// What it pins:
//   - offered only after Add Google (Google's answer) or Add email (the right code) proves the way, and only for a W
//     with no chat that isn't T's partner, neither suspended nor banned; every other case is still `taken`;
//   - the question: its id kept only as a hash, bound to T, 10 minutes, used once; the add-Google page shows it to T's
//     session only;
//   - the dry run equals the merge: both paired, either paired, both with Google, ways of the same kind, a paid plan;
//   - T keeps its Telegram and WhatsApp ids and messagingPlatform; W's trial never replaces T's plan;
//   - the notice goes to T (its chat) and W's sessions end with W;
//   - expired, used and another account's questions are refused; nothing is joined without a question;
//   - no console line or capture holds an address, a question id or a name.
//
// Real: the routes (Add Google's link, Continue and callback; Add email's add and confirm; Join), finishAddGoogle,
// join.ts, account-linking's merge, identities, notice, verifyUserAuth, signInRefusal, the session and flow cookies.
// Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, the rate limiter, error capture,
// Telegram and WhatsApp, the OIDC exchange, and fetch (Resend answered and recorded, the rest blocked). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root: bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-join

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  assert, baseUser, body, captured, check, DB, everyCapture, everyLog, identityRow, initDataFor, installSigninWorld, load,
  logs, mails, redisStore, report, request, resetWorld, ROOT, sent, sessionCookie, show, world, type Row,
} from './lib/signin-world';

const TAL = 9; // T: Telegram
const TAL_TG = 111111111;
const DANA = 21; // W: made on famcal.bot, Google and email ways, no chat
const NOA = 7; // another Telegram account that signs in with Google
const NOA_TG = 222222222;
const PAZ = 31; // Dana's partner
const QAI = 41; // Tal's partner
const SHIR = 51; // T on WhatsApp only
const SHIR_PHONE = '+972500000051';
const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
const DANA_MADE = new Date('2026-11-03T09:00:00.000Z');

const trial = (id: string, userId: number, endsInDays: number): Row => ({
  id, userId, plan: 'FREE', status: 'TRIALING', trialStartedAt: days(endsInDays - 14), trialEndsAt: days(endsInDays),
  currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, compedBy: null, compedAt: null, compReason: null,
  telegramPaymentChargeId: null, createdAt: days(-20), updatedAt: days(-20),
});
const paid = (id: string, userId: number, endsInDays: number): Row => ({
  ...trial(id, userId, -30), plan: 'PRO', status: 'ACTIVE', currentPeriodStart: days(endsInDays - 30), currentPeriodEnd: days(endsInDays),
  telegramPaymentChargeId: `charge-${id}`,
});
const calendar = (id: string, ownerUserId: number, name: string, o: Row = {}): Row => ({
  id, ownerUserId, name, color: '#039BE5', labels: [], rules: [], privacy: 'PRIVATE', isDeleted: false, personName: null,
  personEnglishName: null, personGender: null, createdAt: days(-20), updatedAt: days(-20), ...o,
});
const event = (id: string, calendarId: string, creatorUserId: number, o: Row = {}): Row => ({
  id, calendarId, creatorUserId, title: id, startsAt: days(2), endsAt: days(2), allDay: false, timeZone: 'Asia/Jerusalem',
  rrule: null, exdates: [], kind: 'EVENT', forUserId: null, isDeleted: false, createdAt: days(-5), updatedAt: days(-5), ...o,
});
const pairing = (id: string, inviterUserId: number, inviteeUserId: number): Row => ({
  id, status: 'ACTIVE', inviterUserId, inviteeUserId, acceptedAt: days(-10), unlinkedAt: null, unlinkedByUserId: null, createdAt: days(-10),
});

function seed(): void {
  resetWorld();
  DB.user = [
    baseUser({ id: TAL, name: 'Tal', telegramId: BigInt(TAL_TG) }),
    baseUser({ id: DANA, name: 'Dana', location: '', remindersEnabled: false, createdAt: DANA_MADE, updatedAt: DANA_MADE }),
    baseUser({ id: NOA, name: 'Noa', telegramId: BigInt(NOA_TG) }),
    baseUser({ id: PAZ, name: 'Paz', telegramId: BigInt(333333333) }),
    baseUser({ id: QAI, name: 'Qai', telegramId: BigInt(444444444) }),
    baseUser({ id: SHIR, name: 'Shir', messagingPlatform: 'whatsapp', whatsappPhone: SHIR_PHONE, language: 'he' }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: DANA, kind: 'google', subject: 'g-dana', address: 'dana@gmail.com' }),
    identityRow({ userId: DANA, kind: 'email', subject: 'dana@example.com', address: 'dana@example.com' }),
    identityRow({ userId: NOA, kind: 'google', subject: 'g-noa', address: 'noa@gmail.com' }),
  ];
  DB.nativeCalendar = [
    calendar('cal-t', TAL, 'Tal', { labels: ['primary', 'yours'] }),
    calendar('cal-w', DANA, 'Dana', { labels: ['primary', 'yours'] }),
    calendar('cal-w-kids', DANA, 'Kids', { labels: ['kids'] }),
    calendar('cal-shir', SHIR, 'Shir', { labels: ['primary', 'yours'] }),
  ];
  DB.nativeEvent = [
    event('ev-t', 'cal-t', TAL),
    event('ev-w1', 'cal-w', DANA),
    event('ev-w2', 'cal-w', DANA, { kind: 'REMINDER' }),
    event('ev-w3', 'cal-w-kids', DANA),
    event('ev-w-gone', 'cal-w', DANA, { isDeleted: true }),
    event('ev-shir', 'cal-shir', SHIR),
  ];
  DB.subscription = [trial('sub-t', TAL, 10), trial('sub-w', DANA, 13), trial('sub-shir', SHIR, 5)];
  DB.pairing = [];
}

const userRow = (id: number): Row | undefined => DB.user.find(u => u.id === id);
const waysOf = (id: number): string[] => (DB.signInIdentity ?? []).filter(i => i.userId === id).map(i => `${i.kind}:${i.subject}`).sort();
const joinKeys = (): string[] => [...redisStore.keys()].filter(k => k.startsWith('signin:join:'));
const location = (res: Row): string => res.headers.get('location') ?? '';
const pathOf = (res: Row): string => {
  const url = new URL(location(res), 'https://famcal.bot');
  return url.pathname;
};
function codeIn(mail: Row): string {
  const m = /\b(\d{6})\b/.exec(JSON.stringify(mail.body));
  assert(m, `no 6-digit code in the mail: ${show(mail.body)}`);
  return m[1];
}

async function main() {
  await installSigninWorld();
  const addRoute = await load('app/api/signin-methods/email/add/route.ts');
  const confirmRoute = await load('app/api/signin-methods/email/confirm/route.ts');
  const joinRoute = await load('app/api/signin-methods/join/route.ts');
  const addLinkRoute = await load('app/api/auth/google/add-link/route.ts');
  const addStartRoute = await load('app/api/auth/google/add-start/route.ts');
  const callbackRoute = await load('app/api/auth/google/callback/route.ts');
  const join = await load('src/services/web-signin/join.ts');
  const { SESSION_COOKIE_NAME, validateSessionToken } = await load('src/lib/session-auth.ts');
  const { SIGNIN_COOKIE_NAME } = await load('src/services/web-signin/flow.ts');
  const methodsRoute = await load('app/api/signin-methods/route.ts');

  type Auth = { initData?: string; cookie?: string };
  const tal: Auth = { initData: initDataFor(TAL_TG) };
  const joinIds: string[] = [];

  /** Settings' Add Google, Continue, then Google's answer for `claims`: the callback's response. */
  const addGoogle = async (userId: number, auth: Auth, claims: Row) => {
    const link = await addLinkRoute.POST(request(`/api/auth/google/add-link?user_id=${userId}`, { ...auth, body: {} }));
    const token = new URL((await body(link)).url).searchParams.get('token') ?? '';
    const start = await addStartRoute.POST(request('/api/auth/google/add-start', { body: { token } }));
    assert(start.status === 200, `add-start ${start.status} ${show(await body(start))}`);
    const state = new URL((await body(start)).url).searchParams.get('state') ?? '';
    const flow = `${SIGNIN_COOKIE_NAME}=${start.cookies.get(SIGNIN_COOKIE_NAME)?.value}`;
    world.claims = claims;
    return callbackRoute.GET(request(`/api/auth/google/callback?code=c-1&state=${encodeURIComponent(state)}`, { cookie: flow }));
  };
  const danaGoogle = { sub: 'g-dana', email: 'dana@gmail.com', emailVerified: true };
  /** Settings' Add email up to the right code: the confirm route's response. */
  const addEmail = async (userId: number, auth: Auth, email: string, code?: string) => {
    const res = await addRoute.POST(request(`/api/signin-methods/email/add?user_id=${userId}`, { ...auth, body: { email } }));
    assert(res.status === 200, `add ${res.status} ${show(await body(res))}`);
    const right = codeIn(mails[mails.length - 1]);
    return confirmRoute.POST(request(`/api/signin-methods/email/confirm?user_id=${userId}`, { ...auth, body: { code: code ?? right } }));
  };
  /** The question's id from the callback's landing (/en/signin/add-google/join?token=<id>). */
  const joinIdOf = (res: Row): string => {
    const id = new URL(location(res), 'https://famcal.bot').searchParams.get('token') ?? '';
    joinIds.push(id);
    return id;
  };
  const answer = (userId: number, auth: Auth, token: unknown, extra: Row = {}) =>
    joinRoute.POST(request(`/api/signin-methods/join?user_id=${userId}`, { ...auth, body: { token }, ...extra }));
  /** The browser Google's callback signed in: its session cookie. */
  const cookieOf = (res: Row): Auth => ({ cookie: `${SESSION_COOKIE_NAME}=${res.cookies.get(SESSION_COOKIE_NAME)?.value}` });

  // ---- Offered only after the proof, only for an account with no chat ----

  await check('#1 Add Google ending on the Google account of an account made on famcal.bot (no chat): the callback signs this browser in as Tal and lands on the Join question; no way is attached and no notice is sent yet; the question is kept only as its hash, bound to Tal, for 10 minutes', async () => {
    seed();
    const res = await addGoogle(TAL_TG, tal, danaGoogle);
    assert(pathOf(res) === '/en/signin/add-google/join', `location ${location(res)}; captured ${show(captured)}`);
    const id = joinIdOf(res);
    assert(/^[A-Za-z0-9_-]{22}$/.test(id), `the question id ${id}`);
    const session = validateSessionToken(res.cookies.get(SESSION_COOKIE_NAME)?.value ?? '');
    assert(session?.userId === TAL && session.method === 'google', `session ${show(session)}`);
    assert(show(waysOf(TAL)) === '[]' && show(waysOf(DANA)) === show(['email:dana@example.com', 'google:g-dana']) && sent.length === 0, `ways ${show(waysOf(TAL))} sent ${show(sent)}`);
    const keys = joinKeys();
    assert(keys.length === 1 && keys[0] === `signin:join:${crypto.createHash('sha256').update(id).digest('hex')}` && !keys[0].includes(id), `keys ${show(keys)}`);
    const record = JSON.parse(String(redisStore.get(keys[0])));
    assert(record.tUserId === TAL && record.wUserId === DANA && record.summary.name === 'Dana' && record.summary.createdAt === DANA_MADE.toISOString(), `record ${show(record)}`);
    const src = fs.readFileSync(path.join(ROOT, 'src/services/web-signin/join.ts'), 'utf8');
    assert(/JOIN_TTL_SEC = 10 \* 60/.test(src) && src.includes('{ ex: JOIN_TTL_SEC }'), 'the question is not kept for 10 minutes');
  });

  await check('#2 Add email ending on that account\'s address: the right code answers join (409) with the question\'s id and its summary; no way, no notice', async () => {
    seed();
    const res = await addEmail(TAL_TG, tal, 'dana@example.com');
    const b = await body(res);
    assert(res.status === 409 && b.ok === false && b.error === 'join' && typeof b.joinId === 'string' && b.summary?.name === 'Dana', `confirm ${res.status} ${show(b)}`);
    joinIds.push(b.joinId);
    assert(show(waysOf(TAL)) === '[]' && sent.length === 0 && joinKeys().length === 1, `ways ${show(waysOf(TAL))} sent ${show(sent)}`);
  });

  await check('#3 no question, still taken: the holder has Telegram (Noa) or WhatsApp; the two are partners; the holder is suspended or banned (its Google account on the blocklist)', async () => {
    // The banned holder is answered by Task 2's blocklist check, before addIdentity: `blocked`, never the Join question
    const cases: Array<[string, () => void, Row, string?]> = [
      ['the holder has Telegram', () => undefined, { sub: 'g-noa', email: 'noa@gmail.com', emailVerified: true }],
      ['the holder has WhatsApp', () => { userRow(DANA)!.whatsappPhone = '+972500000021'; }, danaGoogle],
      ['the two are partners', () => {
        DB.pairing.push(pairing('pair-td', TAL, DANA));
        userRow(TAL)!.pairingId = 'pair-td';
        userRow(DANA)!.pairingId = 'pair-td';
      }, danaGoogle],
      ['the holder is suspended', () => { userRow(DANA)!.suspendedAt = new Date(); }, danaGoogle],
      ['the holder is banned', () => { DB.blockedIdentifier = [{ id: 1, telegramId: null, whatsappPhone: null, googleSub: 'g-dana', email: null, createdAt: new Date() }]; }, danaGoogle, 'blocked'],
    ];
    for (const [name, setUp, claims, status = 'taken'] of cases) {
      seed();
      setUp();
      const res = await addGoogle(TAL_TG, tal, claims);
      assert(location(res).includes(`status=${status}`) && joinKeys().length === 0 && sent.length === 0, `${name}: ${location(res)} keys ${show(joinKeys())}`);
      if (status === 'taken') assert(logs.some(l => l.startsWith('[join] user 9: no join offered for user')), `${name}: logs ${show(logs)}`);
    }
    seed();
    userRow(DANA)!.suspendedAt = new Date();
    const res = await addEmail(TAL_TG, tal, 'dana@example.com');
    assert(res.status === 409 && (await body(res)).error === 'taken' && joinKeys().length === 0, `email: ${res.status} ${show(await body(res))}`);
  });

  await check('#4 nothing is joined without a question: a wrong code asks nothing; an id never offered, a malformed one and none are expired (410); another site is 403 and no credential 401, each before any merge', async () => {
    seed();
    const wrong = await addEmail(TAL_TG, tal, 'dana@example.com', '000000');
    assert(wrong.status === 400 && joinKeys().length === 0, `wrong ${wrong.status} ${show(await body(wrong))}`);
    for (const token of [crypto.randomBytes(16).toString('base64url'), 'not-an-id', undefined]) {
      const res = await answer(TAL_TG, tal, token);
      assert(res.status === 410 && (await body(res)).error === 'expired', `${show(token)}: ${res.status} ${show(await body(res))}`);
    }
    const question = await addGoogle(TAL_TG, tal, danaGoogle);
    const id = joinIdOf(question);
    const evil = await answer(TAL_TG, tal, id, { origin: 'https://evil.example' });
    const nobody = await answer(TAL_TG, {}, id);
    assert(evil.status === 403 && nobody.status === 401 && userRow(DANA) && joinKeys().length === 1, `evil ${evil.status} nobody ${nobody.status}`);
  });

  // ---- The answer ----

  await check('#5 Join merges: the answer lists Tal\'s ways; Dana\'s row is gone; her calendars, events and ways are Tal\'s (her email too: Tal had none); Tal keeps its Telegram id and messagingPlatform, and its own trial (Dana\'s longer trial never replaces it); the notice goes to Tal\'s chat; the question is then used up', async () => {
    seed();
    const question = await addGoogle(TAL_TG, tal, danaGoogle);
    const id = joinIdOf(question);
    const browser = cookieOf(question);
    const res = await answer(TAL, browser, id);
    const b = await body(res);
    assert(res.status === 200 && b.ok === true && b.methods?.google?.address === 'dana@gmail.com' && b.methods?.email?.address === 'dana@example.com', `answer ${res.status} ${show(b)}; captured ${show(captured)}`);
    assert(!userRow(DANA), 'Dana is still there');
    assert(show(waysOf(TAL)) === show(['email:dana@example.com', 'google:g-dana']), `Tal's ways ${show(waysOf(TAL))}`);
    const talCalendars = DB.nativeCalendar.filter(c => c.ownerUserId === TAL).map(c => c.id);
    for (const ev of ['ev-w1', 'ev-w2', 'ev-w3']) {
      const row = DB.nativeEvent.find(e => e.id === ev);
      assert(row && talCalendars.includes(row.calendarId) && row.creatorUserId === TAL, `${ev}: ${show(row)}`);
    }
    const t = userRow(TAL)!;
    assert(String(t.telegramId) === String(TAL_TG) && t.messagingPlatform === 'telegram' && t.whatsappPhone === null && t.name === 'Tal', `Tal ${show(t)}`);
    const subs = DB.subscription.filter(s => s.userId === TAL);
    assert(subs.length === 1 && subs[0].id === 'sub-t' && !DB.subscription.some(s => s.id === 'sub-w'), `subscriptions ${show(DB.subscription)}`);
    assert(sent.length === 1 && sent[0].platform === 'telegram' && sent[0].chatId === String(TAL_TG), `notices ${show(sent)}`);
    assert(sent[0].text.includes('d•••@gmail.com') && !sent[0].text.includes('dana@gmail.com') && sent[0].text.includes('privacy@famcal.bot'), `notice ${sent[0].text}`);
    const again = await answer(TAL, browser, id);
    assert(again.status === 410 && (await body(again)).error === 'expired', `again ${again.status}`);
  });

  await check('#6 Dana\'s sessions end with Dana: her browser\'s cookie names no account after the join (404, cookie cleared)', async () => {
    seed();
    const danaBrowser: Auth = { cookie: await sessionCookie(DANA, 'google') };
    const before = await methodsRoute.GET(request(`/api/signin-methods?user_id=${DANA}`, danaBrowser));
    assert(before.status === 200, `before ${before.status}`);
    const question = await addGoogle(TAL_TG, tal, danaGoogle);
    const res = await answer(TAL, cookieOf(question), joinIdOf(question));
    assert(res.status === 200, `answer ${res.status} ${show(await body(res))}`);
    const after = await methodsRoute.GET(request(`/api/signin-methods?user_id=${DANA}`, danaBrowser));
    assert(after.status === 404 && after.headers.get('set-cookie')?.includes(`${SESSION_COOKIE_NAME}=;`), `after ${after.status} ${after.headers.get('set-cookie')}`);
  });

  // ---- The dry run equals the merge ----

  type Scenario = { name: string; setUp: () => void; via: 'google' | 'email'; want: Row };
  const scenarios: Scenario[] = [
    {
      name: 'both paired (Dana with Paz, Tal with Qai)',
      via: 'email',
      setUp: () => {
        DB.pairing.push(pairing('pair-dp', DANA, PAZ), pairing('pair-tq', QAI, TAL));
        Object.assign(userRow(DANA)!, { pairingId: 'pair-dp' });
        Object.assign(userRow(PAZ)!, { pairingId: 'pair-dp' });
        Object.assign(userRow(TAL)!, { pairingId: 'pair-tq' });
        Object.assign(userRow(QAI)!, { pairingId: 'pair-tq' });
      },
      want: { partner: 'ends' },
    },
    {
      name: 'only Dana paired',
      via: 'email',
      setUp: () => {
        DB.pairing.push(pairing('pair-dp', DANA, PAZ));
        Object.assign(userRow(DANA)!, { pairingId: 'pair-dp' });
        Object.assign(userRow(PAZ)!, { pairingId: 'pair-dp' });
      },
      want: { partner: 'moves' },
    },
    {
      name: 'only Tal paired',
      via: 'google',
      setUp: () => {
        DB.pairing.push(pairing('pair-tq', QAI, TAL));
        Object.assign(userRow(TAL)!, { pairingId: 'pair-tq' });
        Object.assign(userRow(QAI)!, { pairingId: 'pair-tq' });
      },
      want: { partner: 'none' },
    },
    {
      name: 'both with Google Calendar',
      via: 'google',
      setUp: () => {
        userRow(DANA)!.googleRefreshToken = 'enc-rt-dana';
        userRow(TAL)!.googleRefreshToken = 'enc-rt-tal';
      },
      want: { google: 'stays' },
    },
    {
      name: 'only Dana with Google Calendar',
      via: 'email',
      setUp: () => { userRow(DANA)!.googleRefreshToken = 'enc-rt-dana'; },
      want: { google: 'moves' },
    },
    {
      name: 'ways of the same kind (Tal has an email way of its own)',
      via: 'google',
      setUp: () => { DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'email', subject: 'tal@example.com', address: 'tal@example.com' })); },
      want: { ways: ['google'] },
    },
    {
      name: 'Dana pays for a plan that runs longer',
      via: 'email',
      setUp: () => { DB.subscription = DB.subscription.filter(s => s.id !== 'sub-w').concat(paid('sub-w', DANA, 20)); },
      want: { plan: 'moves' },
    },
  ];

  /** What the merge did, read from the rows before and after, in the plan's own terms. */
  const observe = (before: Row, after: Row): Row => {
    const talCalendars = after.calendars.filter((c: Row) => c.ownerUserId === TAL).map((c: Row) => c.id);
    const wEvents = before.events.filter((e: Row) => before.wCalendars.includes(e.calendarId) && !e.isDeleted).map((e: Row) => e.id);
    const landed = wEvents.filter((id: string) => talCalendars.includes(after.events.find((e: Row) => e.id === id)?.calendarId));
    const wPairing = before.dana.pairingId;
    return {
      calendars: before.wCalendars.length,
      events: landed.length === wEvents.length ? wEvents.length : -1,
      ways: after.talWays.filter((k: string) => !before.talWays.includes(k)),
      google: !before.dana.googleRefreshToken ? 'none' : after.tal.googleRefreshToken === before.dana.googleRefreshToken ? 'moves' : 'stays',
      partner: !wPairing ? 'none' : after.tal.pairingId === wPairing ? 'moves' : after.pairings.find((p: Row) => p.id === wPairing)?.status === 'UNLINKED' ? 'ends' : '?',
      plan: after.subs.find((s: Row) => s.userId === TAL)?.id === before.wSub ? 'moves' : 'stays',
    };
  };
  const snapshot = () => ({
    dana: { ...(userRow(DANA) ?? {}) },
    tal: { ...userRow(TAL)! },
    wCalendars: DB.nativeCalendar.filter(c => c.ownerUserId === DANA && !c.isDeleted).map(c => c.id),
    events: DB.nativeEvent.map(e => ({ ...e })),
    calendars: DB.nativeCalendar.map(c => ({ ...c })),
    talWays: (DB.signInIdentity ?? []).filter(i => i.userId === TAL).map(i => i.kind).sort(),
    pairings: DB.pairing.map(p => ({ ...p })),
    subs: DB.subscription.map(s => ({ ...s })),
    wSub: DB.subscription.find(s => s.userId === DANA)?.id,
  });

  await check('#7 the question shows what the merge then does, in every case: both paired, either paired, both with Google, only Dana with Google, ways of the same kind, a paid plan that runs longer', async () => {
    const problems: string[] = [];
    for (const s of scenarios) {
      seed();
      s.setUp();
      let summary: Row;
      let id: string;
      let auth: Auth;
      if (s.via === 'google') {
        const res = await addGoogle(TAL_TG, tal, danaGoogle);
        id = joinIdOf(res);
        summary = JSON.parse(String(redisStore.get(joinKeys()[0]))).summary;
        auth = cookieOf(res);
      } else {
        const res = await addEmail(TAL_TG, tal, 'dana@example.com');
        const b = await body(res);
        id = b.joinId;
        joinIds.push(id);
        summary = b.summary;
        auth = tal;
      }
      const before = snapshot();
      const res = await answer(s.via === 'google' ? TAL : TAL_TG, auth, id);
      if (res.status !== 200) {
        problems.push(`${s.name}: answer ${res.status} ${show(await body(res))}`);
        continue;
      }
      const did = observe(before, snapshot());
      if (show(did) !== show(summary.plan)) problems.push(`${s.name}: asked ${show(summary.plan)}, did ${show(did)}`);
      for (const [key, value] of Object.entries(s.want)) {
        if (show(summary.plan[key]) !== show(value)) problems.push(`${s.name}: ${key} ${show(summary.plan[key])}, want ${show(value)}`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  // ---- What T keeps ----

  await check('#8 T keeps its own chat: a WhatsApp-only Shir keeps her phone and messagingPlatform, has no Telegram, and gets the notice on WhatsApp in Hebrew; a Tal on both chats stays on both', async () => {
    seed();
    const shir: Auth = { cookie: await sessionCookie(SHIR, 'wa') };
    const res = await addEmail(SHIR, shir, 'dana@example.com');
    const b = await body(res);
    assert(res.status === 409 && b.error === 'join', `confirm ${res.status} ${show(b)}`);
    const done = await answer(SHIR, shir, b.joinId);
    joinIds.push(b.joinId);
    assert(done.status === 200, `answer ${done.status} ${show(await body(done))}`);
    const row = userRow(SHIR)!;
    assert(row.whatsappPhone === SHIR_PHONE && row.messagingPlatform === 'whatsapp' && row.telegramId === null && !userRow(DANA), `Shir ${show(row)}`);
    assert(sent.length === 1 && sent[0].platform === 'whatsapp' && sent[0].chatId === SHIR_PHONE && /[֐-׿]/.test(sent[0].text), `sent ${show(sent)}`);
    seed();
    Object.assign(userRow(TAL)!, { whatsappPhone: '+972500000009', messagingPlatform: 'all' });
    const both = await addEmail(TAL_TG, tal, 'dana@example.com');
    const joined = await answer(TAL_TG, tal, (await body(both)).joinId);
    assert(joined.status === 200 && userRow(TAL)!.whatsappPhone === '+972500000009' && userRow(TAL)!.messagingPlatform === 'all', `Tal ${show(userRow(TAL))}`);
  });

  // ---- Refused at the answer ----

  await check('#9 refused at the answer (409), nothing joined: another account answers Tal\'s question (and uses it up, so Tal\'s answer is then 410); Dana got Telegram meanwhile; the two paired meanwhile; the proved Google way moved to another account or was removed meanwhile', async () => {
    seed();
    const question = await addGoogle(TAL_TG, tal, danaGoogle);
    const id = joinIdOf(question);
    const noa = await answer(NOA_TG, { initData: initDataFor(NOA_TG) }, id);
    assert(noa.status === 409 && (await body(noa)).error === 'refused' && userRow(DANA), `Noa ${noa.status}`);
    const late = await answer(TAL, cookieOf(question), id);
    assert(late.status === 410, `Tal after Noa ${late.status}`);
    for (const meanwhile of ['telegram', 'paired', 'moved', 'removed'] as const) {
      seed();
      const q = await addGoogle(TAL_TG, tal, danaGoogle);
      const logsBefore = logs.length;
      if (meanwhile === 'telegram') userRow(DANA)!.telegramId = BigInt(555555555);
      else if (meanwhile === 'moved') DB.signInIdentity.find(i => i.userId === DANA && i.kind === 'google')!.userId = NOA;
      else if (meanwhile === 'removed') DB.signInIdentity = DB.signInIdentity.filter(i => !(i.userId === DANA && i.kind === 'google'));
      else {
        DB.pairing.push(pairing('pair-td', TAL, DANA));
        userRow(TAL)!.pairingId = 'pair-td';
        userRow(DANA)!.pairingId = 'pair-td';
      }
      const res = await answer(TAL, cookieOf(q), joinIdOf(q));
      assert(res.status === 409 && (await body(res)).error === 'refused' && userRow(DANA) && show(waysOf(TAL)) === '[]', `${meanwhile}: ${res.status} ${show(await body(res))}`);
      if (meanwhile === 'moved' || meanwhile === 'removed') {
        assert(logs.slice(logsBefore).some(l => l.includes('refused (the google way is no longer the other account\'s)')), `${meanwhile}: logs ${show(logs.slice(logsBefore))}`);
      }
    }
  });

  await check('#10 the add-Google page reads the question for Tal\'s session only, without using it up: peekJoin answers the summary for Tal, null for Noa and for a bad id, and the question still works', async () => {
    seed();
    const question = await addGoogle(TAL_TG, tal, danaGoogle);
    const id = joinIdOf(question);
    const forTal = await join.peekJoin(TAL, id);
    assert(forTal?.name === 'Dana' && forTal.plan?.calendars === 2 && forTal.plan?.events === 3, `Tal ${show(forTal)}`);
    assert((await join.peekJoin(NOA, id)) === null && (await join.peekJoin(TAL, 'x')) === null, 'another account or a bad id read it');
    assert((await join.peekJoin(TAL, id))?.name === 'Dana' && joinKeys().length === 1, 'the peek used it up');
  });

  // ---- The words ----

  await check('#11 the question\'s words are in all three catalogues with the same keys: settings.signIn.join (the question, what moves) and site.signin.addGoogle.join (the page\'s buttons); the joined notices name Settings\' path and privacy@famcal.bot', async () => {
    const read = (lang: string): Row => JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${lang}.json`), 'utf8'));
    const en = read('en');
    const settingsKeys = Object.keys(en.settings.signIn.join).sort();
    const siteKeys = Object.keys(en.site.signin.addGoogle.join).sort();
    for (const key of ['calendars', 'wayGoogle', 'wayEmail', 'google', 'googleStays', 'partner', 'partnerEnds', 'plan', 'question', 'closes', 'join', 'joining', 'done', 'expired', 'refused', 'title', 'movesTitle']) {
      assert(settingsKeys.includes(key), `settings.signIn.join.${key} is missing`);
    }
    const path3: Record<string, string> = { en: 'Settings → Sign in on the web → Remove', he: 'הגדרות ← כניסה מהדפדפן ← הסרה', ru: '«Настройки» → «Вход через браузер» → «Убрать»' };
    for (const lang of ['en', 'he', 'ru']) {
      const m = read(lang);
      assert(show(Object.keys(m.settings.signIn.join).sort()) === show(settingsKeys) && show(Object.keys(m.site.signin.addGoogle.join).sort()) === show(siteKeys), `${lang}: other keys`);
      for (const arg of ['{name}', '{date}', '{kind,']) assert(String(m.settings.signIn.join.question).replace(/\{kind, /, '{kind,').includes(arg), `${lang} question lacks ${arg}`);
      for (const key of ['joinedGoogle', 'joinedEmail']) {
        const text = String(m.signinNotice[key]);
        assert(text.includes(path3[lang]) && text.includes('privacy@famcal.bot') && text.includes('{address}'), `${lang}.signinNotice.${key}: ${text}`);
      }
    }
  });

  await check('#12 no console line and no capture holds an email address, a question id or Dana\'s name', () => {
    const text = [...everyLog, ...everyCapture.map(c => `${c.context} ${c.message} ${show(c.extra)}`)].join('\n');
    const lower = text.toLowerCase();
    const addresses = ['dana@gmail.com', 'dana@example.com', 'noa@gmail.com', 'tal@example.com'].filter(a => lower.includes(a));
    const ids = joinIds.filter(id => id && text.includes(id));
    const names = /\bDana\b/.test(text);
    assert(addresses.length === 0 && ids.length === 0 && !names, `leaked: ${show({ addresses, ids, names })}`);
  });

  report();
}

// The harness captures console.*, so a crash is written straight to stdout.
main().catch(err => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
