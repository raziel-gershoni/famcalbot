// Smoke test for "the Google account a calendar is connected from also signs in" (web sign-in spec 2026-11-02 §2.17;
// plan Task 7): the keyed hash of the account (googleAccountKey), the match at a Google sign-in (one account, its
// switch on, a live connection and no Google way yet, and Google asked again with that account's calendar token,
// whose primary calendar must be the verified address right now), the notice, the cases that fall back to the
// no-account page (a live check that disagrees, a dead token, two accounts, the switch off, a Google way already,
// no verified address, no key, an account whose switch is off not counting toward "several", a suspended or banned
// account answered with no way and no notice), a Google that does not answer being "try again" (failed) and not
// "no account", removal turning it off, Settings' three states for the calendar's account (on, off, none), and Turn on
// (turnOnCalendarAccount: the key of a connection made before is made only when its owner presses it, after one live
// read; no startup pass exists).
// The connect commit and the disconnect are pinned in smoke-google-connect.ts and smoke-google-disconnect.ts, which
// fake those paths already; the merge's half is Task 1's (#66 of smoke-account-merge.ts).
//
// Real: calendar-account, account-key, google-signin, identities, notice, the Google callback, finishSignIn, the
// session cookie, the flow cookie. Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory,
// error capture, Telegram, the OIDC exchange, the calendar's Google account (syncGoogle(token).account()), fetch.
// No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6b/run-smoke.sh smoke-signin-calendar-match

import fs from 'fs';
import path from 'path';
import {
  assert, baseUser, body, captured, check, DB, everyCapture, everyLog, flowCookie, identityRow, initDataFor, installSigninWorld,
  load, logs, prismaCalls, report, request, resetWorld, ROOT, sent, show, world, type Row,
} from './lib/signin-world';

const TAL = 9;
const TAL_TG = 111111111;
const NOA = 7;

async function main() {
  await installSigninWorld();
  const account = await load('src/services/web-signin/calendar-account.ts');
  const signin = await load('src/services/web-signin/google-signin.ts');
  const identities = await load('src/services/web-signin/identities.ts');
  const callbackRoute = await load('app/api/auth/google/callback/route.ts');
  const methodsRoute = await load('app/api/signin-methods/route.ts');
  const { SESSION_COOKIE_NAME, validateSessionToken } = await load('src/lib/session-auth.ts');

  const KEY_TAL: string = account.googleAccountKey('tal@gmail.com');
  const KEY_ID: string = account.googleAccountKeyId();
  const OLD_ID = KEY_ID === 'deadbeef' ? 'cafebabe' : 'deadbeef';

  function seed(): void {
    resetWorld();
    DB.user = [
      baseUser({ id: TAL, name: 'Tal', telegramId: BigInt(TAL_TG), googleRefreshToken: 'rt-tal', googleAccountKey: KEY_TAL }),
      baseUser({ id: NOA, name: 'Noa', telegramId: BigInt(222222222) }),
    ];
    DB.signInIdentity = [];
    world.accounts = { 'rt-tal': 'Tal@Gmail.com' };
  }
  const userRow = (id: number): Row => DB.user.find(u => u.id === id) as Row;
  const identitiesOf = (id: number): Row[] => (DB.signInIdentity ?? []).filter(i => i.userId === id);
  const claims = (o: Row = {}): Row => ({ sub: 'g-new', email: 'tal@gmail.com', emailVerified: true, ...o });
  const location = (res: Row): string => res.headers.get('location') ?? '';
  /** Where a redirect goes, path and query (an absolute landing carries its locale prefix, English included: src/lib/web-session.ts). */
  const pathOf = (res: Row): string => {
    const url = new URL(location(res), 'https://famcal.bot');
    return `${url.pathname}${url.search}`;
  };
  let flows = 0;
  /** "Continue with Google" through the callback, with these claims: the response. */
  const signInWithGoogle = async (c: Row) => {
    const state = `st-${++flows}`;
    const cookie = await flowCookie({ kind: 'google', state, nonce: `n-${flows}`, codeVerifier: 'v'.repeat(43), locale: 'en' });
    world.claims = c;
    return callbackRoute.GET(request(`/api/auth/google/callback?code=c-${flows}&state=${state}`, { cookie }));
  };

  // ---- The key ----

  await check('#1 the key: the same for any case and spacing of the address, <key id>:<64 hex>, no address in it; another SESSION_SECRET gives another id and value; none without SESSION_SECRET', () => {
    const k = account.googleAccountKey('Tal@Gmail.com');
    assert(k === account.googleAccountKey('  tal@gmail.com ') && /^[0-9a-f]{8}:[0-9a-f]{64}$/.test(k) && k.startsWith(`${KEY_ID}:`), `key ${k}`);
    assert(account.googleAccountKey('other@gmail.com') !== k, 'two addresses, one key');
    assert(!k.includes('tal'), 'the key holds the address');
    const secret = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = 'another-secret';
      const other = account.googleAccountKey('tal@gmail.com');
      assert(other !== k && !other.startsWith(`${KEY_ID}:`) && account.googleAccountKeyId() !== KEY_ID, `another secret ${other}`);
      process.env.SESSION_SECRET = '';
      assert(account.googleAccountKey('tal@gmail.com') === null && account.googleAccountKeyId() === null, 'a key without SESSION_SECRET');
    } finally {
      process.env.SESSION_SECRET = secret;
    }
  });

  // ---- The match ----

  await check('#2 one account on that Google account, live check agreeing: "Continue with Google" signs it in, makes the Google way (used now) and sends the calendar notice, masked; Google asked once with its calendar token', async () => {
    seed();
    const res = await signInWithGoogle(claims());
    assert(pathOf(res) === '/en/dashboard?user_id=9', `location ${location(res)}; captured ${show(captured)}`);
    const session = validateSessionToken(res.cookies.get(SESSION_COOKIE_NAME)?.value ?? '');
    assert(session?.userId === TAL && session.method === 'google', `session ${show(session)}`);
    const [way] = identitiesOf(TAL);
    assert(way?.kind === 'google' && way.subject === 'g-new' && way.address === 'tal@gmail.com' && way.lastUsedAt instanceof Date, `way ${show(way)}`);
    assert(sent.length === 1 && sent[0].chatId === String(TAL_TG) && sent[0].text.includes('t•••@gmail.com') && sent[0].text.includes('the account your calendar is connected from'), `sent ${show(sent)}`);
    assert(show(world.googleAsks) === show(['rt-tal']), `asks ${show(world.googleAsks)}`);
  });

  await check('#3 the next sign-in finds the way it made: no Google call, no second notice', async () => {
    seed();
    await signin.resolveGoogleSignIn(claims());
    world.googleAsks.length = 0;
    sent.length = 0;
    const res = await signInWithGoogle(claims());
    assert(pathOf(res) === '/en/dashboard?user_id=9' && world.googleAsks.length === 0 && sent.length === 0, `location ${location(res)} asks ${show(world.googleAsks)} sent ${show(sent)}`);
  });

  await check('#4 a live check that disagrees (the calendar now on another account) is no-account: no way, no notice, and the callback lands on the no-account page', async () => {
    seed();
    world.accounts['rt-tal'] = 'other@gmail.com';
    const r = await signin.resolveGoogleSignIn(claims());
    assert(show(r) === show({ status: 'no-account' }), `result ${show(r)}`);
    assert(identitiesOf(TAL).length === 0 && sent.length === 0 && show(world.googleAsks) === show(['rt-tal']), `ways ${show(identitiesOf(TAL))} sent ${show(sent)}`);
    assert(location(await signInWithGoogle(claims())).includes('status=no-account'), 'callback');
  });

  await check('#5 a dead connection (Google refuses the token) is no-account, logged and captured with the user id', async () => {
    seed();
    world.accounts['rt-tal'] = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    const r = await signin.resolveGoogleSignIn(claims());
    assert(show(r) === show({ status: 'no-account' }) && identitiesOf(TAL).length === 0, `result ${show(r)}`);
    assert(captured.some(c => c.context === 'google-account-check' && c.extra.user_id === TAL), `captured ${show(captured)}`);
    assert(logs.some(l => l.includes('[google-account] user 9')), `logs ${show(logs)}`);
  });

  await check('#5b Google not answering (a 503, a rate limit, an unknown error) is failed ("try again"), not no-account: no way, no notice, logged and captured with the user id only; the callback lands on status=failed', async () => {
    for (const err of [
      Object.assign(new Error('backend error'), { response: { status: 503, data: {} } }),
      Object.assign(new Error('rate limit'), { response: { status: 429, data: {} } }),
      new Error('socket hang up'),
    ]) {
      seed();
      world.accounts['rt-tal'] = err;
      const r = await signin.resolveGoogleSignIn(claims());
      assert(show(r) === show({ status: 'failed' }) && identitiesOf(TAL).length === 0 && sent.length === 0, `${err.message}: result ${show(r)}`);
      assert(captured.some(c => c.context === 'google-account-check' && c.extra.user_id === TAL), `captured ${show(captured)}`);
      assert(logs.some(l => l.includes('[google-account] user 9') && l.includes('(unavailable)')), `logs ${show(logs)}`);
      assert(location(await signInWithGoogle(claims())).includes('status=failed'), `callback ${err.message}`);
    }
    seed();
    world.accounts['rt-tal'] = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    assert(show(await signin.resolveGoogleSignIn(claims())) === show({ status: 'no-account' }), 'a dead token stays no-account');
    assert(logs.some(l => l.includes('[google-account] user 9') && l.includes('(token)')), `logs ${show(logs)}`);
  });

  await check('#6 two FamCal accounts on one Google account (a shared family account) is several, with no Google call; an account whose calendar is disconnected does not count', async () => {
    seed();
    DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL }));
    const r = await signin.resolveGoogleSignIn(claims());
    assert(show(r) === show({ status: 'several' }) && world.googleAsks.length === 0 && (DB.signInIdentity ?? []).length === 0, `result ${show(r)} asks ${show(world.googleAsks)}`);
    assert(location(await signInWithGoogle(claims())).includes('status=several'), 'callback');
    seed();
    DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: '', googleAccountKey: KEY_TAL }));
    const one = await signin.resolveGoogleSignIn(claims());
    assert(one.user?.id === TAL, `result ${show(one)}`);
  });

  await check('#7 the switch off (googleCalendarSignIn) is no-account, with no Google call (the query asks only for accounts with it on)', async () => {
    seed();
    userRow(TAL).googleCalendarSignIn = false;
    const r = await signin.resolveGoogleSignIn(claims());
    assert(show(r) === show({ status: 'no-account' }) && world.googleAsks.length === 0, `result ${show(r)} asks ${show(world.googleAsks)}`);
  });

  await check('#8 an account that already has a Google way (another Google account) is no-account, with no Google call', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-old', address: 'old@gmail.com' }));
    const r = await signin.resolveGoogleSignIn(claims());
    assert(show(r) === show({ status: 'no-account' }) && world.googleAsks.length === 0 && identitiesOf(TAL).length === 1, `result ${show(r)}`);
  });

  await check('#9 no verified address (unverified, or none) is no-account before any account lookup', async () => {
    seed();
    for (const c of [claims({ emailVerified: false }), claims({ email: null })]) {
      prismaCalls.length = 0;
      const r = await account.matchCalendarAccount(c);
      assert(show(r) === show({ status: 'no-account' }) && !prismaCalls.includes('user.findMany'), `${show(c)}: ${show(r)} calls ${show(prismaCalls)}`);
    }
  });

  await check('#10 a row with no key yet, or a key made under another SESSION_SECRET, does not match: no account holds this address\'s current key, so the sign-up is offered (new, web sign-up spec §3.3), with no Google call', async () => {
    for (const key of [null, `${OLD_ID}:${'0'.repeat(64)}`]) {
      seed();
      userRow(TAL).googleAccountKey = key;
      const r = await signin.resolveGoogleSignIn(claims());
      assert(show(r) === show({ status: 'new' }) && world.googleAsks.length === 0 && identitiesOf(TAL).length === 0, `key ${key}: ${show(r)}`);
    }
  });

  await check('#11 a suspended account is answered (finishSignIn shows its page), and nothing is attached or sent', async () => {
    seed();
    userRow(TAL).suspendedAt = new Date();
    const r = await signin.resolveGoogleSignIn(claims());
    assert(r.user?.id === TAL && identitiesOf(TAL).length === 0 && sent.length === 0, `result ${show(r)}`);
    assert(location(await signInWithGoogle(claims())).includes('status=suspended'), 'callback');
  });

  await check('#12 Settings shows the calendar row before its first use; removing the way it made, or the row itself, turns the switch off and the match stops (the key goes with it, so nothing holds the Google account any more: new)', async () => {
    seed();
    const list = async () => body(await methodsRoute.GET(request(`/api/signin-methods?user_id=${TAL_TG}`, { initData: initDataFor(TAL_TG) })));
    assert((await list()).googleFromCalendar === 'on', 'before the first use');
    await signin.resolveGoogleSignIn(claims());
    const after = await list();
    assert(after.google?.address === 'tal@gmail.com' && after.googleFromCalendar === null, `after ${show(after)}`);
    await identities.removeSignInMethod(TAL, 'google');
    assert(identitiesOf(TAL).length === 0 && userRow(TAL).googleCalendarSignIn === false, `row ${show(userRow(TAL))}`);
    world.googleAsks.length = 0;
    const again = await signin.resolveGoogleSignIn(claims());
    assert(show(again) === show({ status: 'new' }) && world.googleAsks.length === 0 && identitiesOf(TAL).length === 0, `again ${show(again)}`);
    seed();
    await identities.removeSignInMethod(TAL, 'calendar-google');
    assert(userRow(TAL).googleCalendarSignIn === false && show(await signin.resolveGoogleSignIn(claims())) === show({ status: 'new' }), 'calendar row removed');
  });

  // ---- No startup pass; Settings' states; Turn on ----

  const OLD_KEY = `${OLD_ID}:${'0'.repeat(64)}`;
  const stateOf = async (id: number): Promise<unknown> => {
    const user = await (await load('src/services/user-service.ts')).getUserById(id);
    return (await identities.listSignInMethods(user)).googleFromCalendar;
  };

  await check('#13 [guard] no startup pass: instrumentation.ts starts no key pass and nothing in the app calls Google per connection at boot; the pass is gone from calendar-account', () => {
    const text = fs.readFileSync(path.join(ROOT, 'instrumentation.ts'), 'utf8');
    for (const word of ['fillGoogleAccountKeys', 'calendar-account', 'web-signin', 'syncGoogle', 'providerConfigured']) {
      assert(!text.includes(word), `instrumentation.ts mentions ${word}`);
    }
    assert(!('fillGoogleAccountKeys' in account), 'calendar-account still exports the startup pass');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('fillGoogleAccountKeys')) found.push(rel);
      }
    };
    for (const dir of ['src', 'app', 'components']) walk(dir);
    assert(found.length === 0, `still named in ${show(found)}`);
  });

  await check('#14 Settings\' calendar state: on (a current key, this account the only holder), off (no key, or a key of another key id: Turn on), none (a Google way, the switch off, no connection, or a key several accounts hold)', async () => {
    seed();
    assert((await stateOf(TAL)) === 'on', 'current key, sole holder');
    for (const key of [null, OLD_KEY]) {
      userRow(TAL).googleAccountKey = key;
      assert((await stateOf(TAL)) === 'off', `key ${key}`);
    }
    userRow(TAL).googleAccountKey = KEY_TAL;
    userRow(TAL).googleCalendarSignIn = false;
    assert((await stateOf(TAL)) === null, 'switch off');
    userRow(TAL).googleAccountKey = null;
    assert((await stateOf(TAL)) === null, 'switch off, no key');
    Object.assign(userRow(TAL), { googleCalendarSignIn: true, googleAccountKey: KEY_TAL, googleRefreshToken: '' });
    assert((await stateOf(TAL)) === null, 'no connection');
    userRow(TAL).googleRefreshToken = 'rt-tal';
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal@gmail.com' }));
    assert((await stateOf(TAL)) === null, 'a Google way');
    seed();
    DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL }));
    assert((await stateOf(TAL)) === null && (await stateOf(10)) === null, 'a shared key shows no calendar row on either account');
    DB.user[2].googleCalendarSignIn = false;
    assert((await stateOf(TAL)) === 'on', 'the other holder turned its switch off: not a second holder');
    DB.user[2].googleCalendarSignIn = true;
    DB.user[2].googleRefreshToken = '';
    assert((await stateOf(TAL)) === 'on', 'the other holder disconnected: not a second holder');
  });

  await check('#15 Turn on: a dead token is reconnect, Google not answering (or naming nobody) is failed, a shared key is shared; each keeps nothing', async () => {
    const offRows = () => {
      seed();
      userRow(TAL).googleAccountKey = null;
    };
    offRows();
    world.accounts['rt-tal'] = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    assert((await account.turnOnCalendarAccount(TAL)) === 'reconnect' && userRow(TAL).googleAccountKey === null, 'dead token');
    assert(logs.some(l => l.includes('[signin] user 9: calendar account turn on: reconnect')), `logs ${show(logs)}`);
    offRows();
    world.accounts['rt-tal'] = Object.assign(new Error('backend error'), { response: { status: 503, data: {} } });
    assert((await account.turnOnCalendarAccount(TAL)) === 'failed' && userRow(TAL).googleAccountKey === null, 'unavailable Google');
    assert(logs.some(l => l.includes('[signin] user 9: calendar account turn on: failed')), `logs ${show(logs)}`);
    offRows();
    world.accounts['rt-tal'] = '';
    assert((await account.turnOnCalendarAccount(TAL)) === 'failed' && userRow(TAL).googleAccountKey === null, 'Google named nobody');
    offRows();
    DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL }));
    assert((await account.turnOnCalendarAccount(TAL)) === 'shared' && userRow(TAL).googleAccountKey === null && userRow(10).googleAccountKey === KEY_TAL, 'shared key');
    assert(logs.some(l => l.includes('[signin] user 9: calendar account turn on: shared')), `logs ${show(logs)}`);
  });

  await check('#16 Turn on: success keys the account (the hash of the live address, nothing else changes: no notice, no sessionsValidAfter); a holder whose switch is off or who disconnected is not "shared"; another key id is re-made', async () => {
    for (const key of [null, OLD_KEY]) {
      seed();
      userRow(TAL).googleAccountKey = key;
      DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL, googleCalendarSignIn: false }));
      DB.user.push(baseUser({ id: 11, name: 'Old', telegramId: BigInt(444444444), googleRefreshToken: '', googleAccountKey: KEY_TAL }));
      const r = await account.turnOnCalendarAccount(TAL);
      assert(r === 'on' && userRow(TAL).googleAccountKey === KEY_TAL, `key ${key}: ${r} ${userRow(TAL).googleAccountKey}`);
      assert(sent.length === 0 && userRow(TAL).sessionsValidAfter === null && identitiesOf(TAL).length === 0, `sent ${show(sent)}`);
      assert(show(world.googleAsks) === show(['rt-tal']) && (await stateOf(TAL)) === 'on', `asks ${show(world.googleAsks)}`);
    }
    assert(logs.some(l => l.includes('[signin] user 9: calendar account turn on: on')), `logs ${show(logs)}`);
  });

  await check('#16b Turn on is offered only in the off state: a keyed account, a Google way, the switch off, no connection, or no such user is not-offered, with no Google call', async () => {
    seed();
    assert((await account.turnOnCalendarAccount(TAL)) === 'not-offered', 'already on');
    userRow(TAL).googleAccountKey = null;
    DB.signInIdentity.push(identityRow({ userId: TAL, kind: 'google', subject: 'g-tal', address: 'tal@gmail.com' }));
    assert((await account.turnOnCalendarAccount(TAL)) === 'not-offered', 'a Google way');
    DB.signInIdentity.length = 0;
    userRow(TAL).googleCalendarSignIn = false;
    assert((await account.turnOnCalendarAccount(TAL)) === 'not-offered' && userRow(TAL).googleAccountKey === null, 'switch off');
    Object.assign(userRow(TAL), { googleCalendarSignIn: true, googleRefreshToken: '' });
    assert((await account.turnOnCalendarAccount(TAL)) === 'not-offered', 'no connection');
    assert((await account.turnOnCalendarAccount(999)) === 'not-offered', 'no such user');
    assert(world.googleAsks.length === 0, `asked Google ${show(world.googleAsks)}`);
  });

  await check('#16e Turn on keeps nothing while Google sign-in is not set up (a direct request, since Settings hides it): not-offered, no Google call', async () => {
    seed();
    userRow(TAL).googleAccountKey = null;
    world.oidc.google = false;
    assert((await account.turnOnCalendarAccount(TAL)) === 'not-offered' && userRow(TAL).googleAccountKey === null, 'Google sign-in off');
    assert(world.googleAsks.length === 0, `asked Google ${show(world.googleAsks)}`);
  });

  await check('#16c Turn on writes only over the token it read: a reconnect while Google was asked keeps the key its own connect wrote (failed), and a switch turned off meanwhile gets no key', async () => {
    seed();
    userRow(TAL).googleAccountKey = null;
    world.accounts['rt-tal'] = () => {
      Object.assign(userRow(TAL), { googleRefreshToken: 'rt-tal2', googleAccountKey: 'from-the-connect' });
      return 'tal@gmail.com';
    };
    assert((await account.turnOnCalendarAccount(TAL)) === 'failed' && userRow(TAL).googleAccountKey === 'from-the-connect', `key ${userRow(TAL).googleAccountKey}`);
    seed();
    userRow(TAL).googleAccountKey = null;
    world.accounts['rt-tal'] = () => {
      userRow(TAL).googleCalendarSignIn = false;
      return 'tal@gmail.com';
    };
    assert((await account.turnOnCalendarAccount(TAL)) === 'failed' && userRow(TAL).googleAccountKey === null, 'a switch turned off while Google was asked still got a key');
  });

  await check('#16d without SESSION_SECRET Turn on keeps nothing (failed)', async () => {
    seed();
    userRow(TAL).googleAccountKey = null;
    const secret = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = '';
      assert((await account.turnOnCalendarAccount(TAL)) === 'failed' && userRow(TAL).googleAccountKey === null, 'a key without SESSION_SECRET');
    } finally {
      process.env.SESSION_SECRET = secret;
    }
  });

  await check('#17 [guard] the sign-in modules make no raw fetch (every Google call is getGoogleAuth or googleFetch) and no timeout or retry of their own', () => {
    for (const file of ['src/services/web-signin/calendar-account.ts', 'src/services/web-signin/account-key.ts']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert(!/\bfetch\(/.test(source) && !source.includes('googleapis.com'), `${file} calls Google on its own`);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert(!/setTimeout|AbortSignal\.timeout|retry/i.test(code), `${file} has a timer or a retry of its own`);
    }
  });

  await check('#18 [R9] an account on the same Google account whose switch is off is not a second holder: the one with the switch on is matched (not "several"); with both off nobody is', async () => {
    seed();
    DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL, googleCalendarSignIn: false }));
    const r = await signin.resolveGoogleSignIn(claims());
    assert(r.user?.id === TAL && show(world.googleAsks) === show(['rt-tal']), `result ${show(r)} asks ${show(world.googleAsks)}`);
    seed();
    DB.user.push(baseUser({ id: 10, name: 'Family', telegramId: BigInt(333333333), googleRefreshToken: 'rt-family', googleAccountKey: KEY_TAL, googleCalendarSignIn: false }));
    userRow(TAL).googleCalendarSignIn = false;
    const none = await signin.resolveGoogleSignIn(claims());
    assert(show(none) === show({ status: 'no-account' }) && world.googleAsks.length === 0 && (DB.signInIdentity ?? []).length === 0, `result ${show(none)} asks ${show(world.googleAsks)}`);
  });

  await check('#19 [R5] a banned account (its Telegram id is on the block list) is answered, not matched: no Google way, no notice, and the callback lands on status=blocked with no session', async () => {
    seed();
    DB.blockedIdentifier = [{ id: 1, telegramId: BigInt(TAL_TG), whatsappPhone: null, createdAt: new Date() }];
    const r = await signin.resolveGoogleSignIn(claims());
    assert(r.user?.id === TAL && identitiesOf(TAL).length === 0 && sent.length === 0, `result ${show(r)} ways ${show(identitiesOf(TAL))} sent ${show(sent)}`);
    const res = await signInWithGoogle(claims());
    assert(location(res).includes('status=blocked') && !res.cookies.get(SESSION_COOKIE_NAME)?.value && identitiesOf(TAL).length === 0, `callback ${location(res)}`);
  });

  await check('#22 [finding 10] removing a Google way or the calendar\'s row clears the calendar account\'s key with the switch (it would serve no purpose); removing the email way touches neither; Add Google still works after', async () => {
    for (const which of ['google', 'calendar-google'] as const) {
      seed();
      await identities.removeSignInMethod(TAL, which);
      assert(userRow(TAL).googleCalendarSignIn === false && userRow(TAL).googleAccountKey === null, `${which}: ${show([userRow(TAL).googleCalendarSignIn, userRow(TAL).googleAccountKey])}`);
    }
    seed();
    const changed = await identities.removeSignInMethod(TAL, 'email');
    assert(changed === false && userRow(TAL).googleCalendarSignIn === true && userRow(TAL).googleAccountKey === KEY_TAL, `email: ${show([changed, userRow(TAL).googleCalendarSignIn, userRow(TAL).googleAccountKey])}`);
    seed();
    await identities.removeSignInMethod(TAL, 'calendar-google');
    const added = await identities.addIdentity(TAL, 'google', 'g-sub-1', 'tal@gmail.com');
    assert(added === 'added', `Add Google after the calendar row was removed: ${added}`);
  });

  await check('#21 no console line and no capture holds an address', () => {
    const text = [...everyLog, ...everyCapture.map(c => `${c.context} ${c.message} ${show(c.extra)}`)].join('\n').toLowerCase();
    const found = ['tal@gmail.com', 'other@gmail.com', 'old@gmail.com', 'a@gmail.com', 'b@example.org', 'c@example.net'].filter(a => text.includes(a));
    assert(found.length === 0, `leaked ${show(found)}`);
  });

  report();
}

main().catch(err => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
