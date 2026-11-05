// Smoke test for Google Calendar's Finish here (web sign-up spec 2026-11-03 §2.10, §3.10; plan 6c-1 Task 10): the finish
// page after Google's consent asks POST /api/oauth/claim { token, peek: true } whether this browser's session is the
// account that started the consent, and Finish here posts the waiting connection's id to POST /api/oauth/claim
// { token }, which commits it only for that account. The id is only ever in a body, never in a URL (there is no GET).
//
// What it pins:
//   - the check answers { mine } and nothing else (no-store): true only for the owner's live session; false with no
//     session, another account's session, a tampered cookie, a session that was ended (sessionsValidAfter), an id that
//     is no id, and an entry that is gone; it never uses the entry up; the route has no GET;
//   - POST, the owner's session: the token is committed on the owner (encrypted googleRefreshToken, the scopes, the
//     connected flag the Mini App polls, the reminder cache and the setup nudges), the entry is used up, and the answer
//     names the page the chat claim leads to (Select calendars for a connect, Calendars for a copy to Google) with the
//     owner's DB id;
//   - POST, another account's session: the entry is used up and nothing is connected on either account (not_owner);
//     the owner's own press after it says expired;
//   - POST with no session, or an ended one (its cookie cleared): signed-out, the entry stays, and the chat claim
//     (Telegram's /start gc_<id>) still connects it;
//   - the check or the claim from another site, or with no id: refused, and the entry stays;
//   - a commit that throws half-way: 'failed', captured with the user id;
//   - the waiting connection's id reaches no console line and no capture.
//
// Real: both routes, google-connect.ts (the park, the peek, the claim, the commit, the Telegram claim), user-service,
// verifyUserAuth, the session cookie, the Origin guard, the encryption. Faked at the boundaries
// (scripts/lib/signin-world.ts): Prisma and Redis in memory, the rate limiter, error capture, the admin notifier,
// Telegram (every send recorded). The commit's own follow-ups (the reminder cache, the setup nudges, the Google read
// cache's stamp, the copies to Google, analytics) are stood in for and recorded: smoke-google-connect.ts runs them for
// real. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-finish-here

import {
  assert, baseUser, body, captured, check, DB, everyCapture, everyLog, installSigninWorld, load, redisStore, report, request,
  resetWorld, sent, sessionCookie, show, stubModule, type Row,
} from './lib/signin-world';

const NOA = 7; // made on famcal.bot: no chat, Hebrew
const TAL = 9; // Telegram, English
const TAL_TG = 111111111;
const READ = 'https://www.googleapis.com/auth/calendar.readonly';
const EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const SYNC = 'https://www.googleapis.com/auth/calendar.app.created';

/** What the commit's stood-in follow-ups were asked to do, in order */
const followUps: string[] = [];
/** The reminder cache refuses: the commit throws after the token is saved */
let commitFails = false;
/** Every waiting-connection id this run made, for the log check */
const ids: string[] = [];

function seed(): void {
  resetWorld();
  followUps.length = 0;
  commitFails = false;
  DB.user = [
    baseUser({ id: NOA, name: 'Noa', language: 'he', location: '' }),
    baseUser({ id: TAL, name: 'Tal', telegramId: BigInt(TAL_TG) }),
  ];
}
const userRow = (id: number): Row => DB.user.find(u => u.id === id) as Row;
const pendingKeys = (): string[] => [...redisStore.keys()].filter(k => k.startsWith('oauth:pending:'));

async function main() {
  await installSigninWorld();
  stubModule('src/services/reminder-cache.ts', {
    syncReminderCacheEntry: async (user: Row) => {
      if (commitFails) throw new Error('the reminder cache refused (smoke)');
      followUps.push(`reminder-cache:${user.id}`);
    },
    removeUserFromCache: async () => undefined,
    getEarlyAdoptionMode: async () => false,
    getGlobalRemindersEnabled: async () => true,
  });
  stubModule('src/services/setup-tracks.ts', {
    clearGoogleTracks: async (id: number) => void followUps.push(`setup-tracks:${id}`),
    setupTrackKeys: () => [],
  });
  stubModule('src/services/calendar-read/google.ts', { stampGoogleCache: async (id: number) => void followUps.push(`stamp:${id}`) });
  stubModule('src/services/google-sync/links.ts', {
    enableSyncLink: async (id: number, sync: Row) => {
      followUps.push(`enable-sync:${id}:${sync.nativeCalendarId}`);
      return { status: 'created', linkId: 'link-1' };
    },
    restoreSyncLinks: async (id: number) => void followUps.push(`restore-sync:${id}`),
    syncCopyFilter: async () => null,
    syncCopyCalendarIds: async () => [],
  });
  stubModule('src/services/analytics-service.ts', {
    addBreadcrumb: () => undefined,
    setUserContext: () => undefined,
    trackActivityAsync: (id: number, action: string) => void followUps.push(`activity:${id}:${action}`),
    trackActivity: async () => undefined,
    ACTIVITY_RETENTION_DAYS: 90,
    ACTIVITY_PURGE_BATCH: 5000,
    purgeOldActivity: async () => 0,
  });
  const route = await load('app/api/oauth/claim/route.ts');
  const connect = await load('src/services/google-connect.ts');
  const { decrypt } = await load('src/utils/encryption.ts');
  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const { SESSION_COOKIE_NAME } = await load('src/lib/session-auth.ts');

  const park = async (owner: number, grant: Row = { scopes: [READ, EVENTS] }): Promise<string> => {
    const id: string = await connect.createPendingGoogleToken(owner, `rt-${owner}`, grant);
    ids.push(id);
    return id;
  };
  const ask = (id: string, cookie?: string, extra: Row = {}) => route.POST(request('/api/oauth/claim', { body: { token: id, peek: true }, cookie, ...extra }));
  const finish = (id: unknown, cookie?: string, extra: Row = {}) => route.POST(request('/api/oauth/claim', { body: { token: id }, cookie, ...extra }));
  const tokenOf = (id: number): string => (userRow(id).googleRefreshToken ? decrypt(userRow(id).googleRefreshToken) : '');

  await check('#1 the check (POST { token, peek: true }) says { mine: true } for the owner\'s live session and { mine: false } for no session, another account, a tampered cookie, an ended session, an id that is no id and a used entry; never anything else, never cached, and it never uses the entry up; the route has no GET, so the id is never in a URL', async () => {
    seed();
    assert(!('GET' in route), 'the route still has a GET handler');
    const id = await park(NOA);
    const noa = await sessionCookie(NOA, 'google');
    const yes = await ask(id, noa);
    assert(yes.status === 200 && show(await body(yes)) === show({ mine: true }), `the owner: ${yes.status} ${show(await body(yes))}`);
    assert(yes.headers.get('cache-control') === 'no-store', `cache-control ${yes.headers.get('cache-control')}`);
    const others: [string, string | undefined][] = [['no session', undefined], ['another account', await sessionCookie(TAL, 'google')], ['a tampered cookie', `${noa}x`]];
    for (const [label, cookie] of others) {
      const answer = await body(await ask(id, cookie));
      assert(show(answer) === show({ mine: false }), `${label}: ${show(answer)}`);
    }
    assert(show(await body(await ask('short', noa))) === show({ mine: false }), 'an id that is no id');
    userRow(NOA).sessionsValidAfter = new Date();
    assert(show(await body(await ask(id, noa))) === show({ mine: false }), 'an ended session');
    userRow(NOA).sessionsValidAfter = null;
    assert(pendingKeys().length === 1, `the checks used the entry up: ${show(pendingKeys())}`);
    redisStore.delete(pendingKeys()[0]);
    assert(show(await body(await ask(id, noa))) === show({ mine: false }), 'a used entry');
  });

  await check('#2 POST with the owner\'s session commits the connect: the token on the owner (encrypted), the scopes, the connected flag, the reminder cache and the nudges; the entry is used up; the answer names Select calendars with the owner\'s DB id, in the owner\'s language', async () => {
    seed();
    const id = await park(NOA);
    const res = await finish(id, await sessionCookie(NOA, 'email'));
    const b = await body(res);
    assert(res.status === 200 && b.ok === true && b.page === 'select-calendars' && b.userId === NOA, `${res.status} ${show(b)}`);
    assert(b.redirect === `https://famcal.bot/he/select-calendars?user_id=${NOA}`, `redirect ${b.redirect}`);
    assert(tokenOf(NOA) === `rt-${NOA}` && userRow(NOA).googleRefreshToken !== `rt-${NOA}`, 'the token is not saved, encrypted, on the owner');
    assert(show(userRow(NOA).googleScopes) === show([READ, EVENTS]), `scopes ${show(userRow(NOA).googleScopes)}`);
    assert(redisStore.has(REDIS_KEYS.googleConnected(NOA)), 'no connected flag for the Mini App\'s poll');
    for (const step of [`reminder-cache:${NOA}`, `setup-tracks:${NOA}`, `stamp:${NOA}`, `activity:${NOA}:calendar_connected`]) {
      assert(followUps.includes(step), `the commit did not run ${step}: ${show(followUps)}`);
    }
    assert(pendingKeys().length === 0, 'the entry is still there');
  });

  await check('#3 POST for a copy-to-Google consent turns the copy on and names Calendars, as the chat claim\'s button does', async () => {
    seed();
    const id = await park(NOA, { scopes: [READ, EVENTS, SYNC], sync: { nativeCalendarId: 'cal-1', googleAccount: null } });
    const b = await body(await finish(id, await sessionCookie(NOA, 'google')));
    assert(b.ok === true && b.page === 'calendars' && b.redirect === `https://famcal.bot/he/calendars?user_id=${NOA}`, show(b));
    assert(followUps.includes(`enable-sync:${NOA}:cal-1`) && followUps.includes(`restore-sync:${NOA}`), show(followUps));
  });

  await check('#4 POST with another account\'s session uses the entry up and connects nothing on either account (not_owner); the owner\'s press after it says expired', async () => {
    seed();
    const id = await park(NOA);
    const res = await finish(id, await sessionCookie(TAL, 'tg'));
    assert(res.status === 403 && show(await body(res)) === show({ ok: false, error: 'not_owner' }), `${res.status} ${show(await body(res))}`);
    assert(tokenOf(NOA) === '' && tokenOf(TAL) === '' && pendingKeys().length === 0 && followUps.length === 0, `connected ${show([tokenOf(NOA), tokenOf(TAL), followUps])}`);
    const late = await finish(id, await sessionCookie(NOA, 'google'));
    assert(late.status === 410 && (await body(late)).error === 'expired', `the owner after it: ${late.status} ${show(await body(late))}`);
  });

  await check('#5 POST with no session, or an ended one (its cookie cleared), is signed-out and leaves the entry, which the chat claim still connects (Telegram\'s /start gc_<id>)', async () => {
    seed();
    const id = await park(TAL);
    const none = await finish(id);
    assert(none.status === 401 && show(await body(none)) === show({ ok: false, error: 'signed-out' }), `no session: ${none.status} ${show(await body(none))}`);
    userRow(TAL).sessionsValidAfter = new Date();
    const ended = await finish(id, await sessionCookie(TAL, 'tg'));
    assert(ended.status === 401 && (await body(ended)).error === 'signed-out', `ended: ${ended.status} ${show(await body(ended))}`);
    assert(ended.cookies.get(SESSION_COOKIE_NAME)?.value === '', `the ended cookie is not cleared: ${show(ended.cookies.get(SESSION_COOKIE_NAME))}`);
    assert(pendingKeys().length === 1 && tokenOf(TAL) === '', 'a signed-out press used the entry up or connected');
    await connect.handleGoogleConnectTelegram(TAL_TG, TAL_TG, id, 'en');
    assert(tokenOf(TAL) === `rt-${TAL}` && pendingKeys().length === 0, 'the chat claim did not connect it');
    assert(sent.length === 1 && sent[0].chatId === String(TAL_TG) && sent[0].text.includes('Google Calendar is connected'), `the chat reply ${show(sent)}`);
  });

  await check('#5b a session signed in over an hour ago: the check says { mine: false, stale: true }, the claim is 403 stale-sign-in (the session cookie is not cleared) and leaves the entry, which the chat claim still connects; a session from 59 minutes ago commits', async () => {
    seed();
    const MIN = 60_000;
    const id = await park(NOA);
    const stale = await sessionCookie(NOA, 'google', Date.now() - 61 * MIN);
    const peeked = await ask(id, stale);
    assert(peeked.status === 200 && show(await body(peeked)) === show({ mine: false, stale: true }), `the check: ${peeked.status} ${show(await body(peeked))}`);
    const other = await ask(id, await sessionCookie(TAL, 'google', Date.now() - 61 * MIN));
    assert(show(await body(other)) === show({ mine: false }), `another account's stale session says nothing of staleness: ${show(await body(other))}`);
    const refused = await finish(id, stale);
    assert(refused.status === 403 && show(await body(refused)) === show({ ok: false, error: 'stale-sign-in' }), `the claim: ${refused.status} ${show(await body(refused))}`);
    assert(!refused.cookies.get(SESSION_COOKIE_NAME)?.value, `the session cookie was touched: ${show(refused.cookies.get(SESSION_COOKIE_NAME))}`);
    assert(pendingKeys().length === 1 && tokenOf(NOA) === '' && followUps.length === 0, 'a stale press used the entry up or connected');
    const fresh = await sessionCookie(NOA, 'google', Date.now() - 59 * MIN);
    assert(show(await body(await ask(id, fresh))) === show({ mine: true }), 'a 59-minute session is not the owner');
    const ok = await finish(id, fresh);
    assert(ok.status === 200 && (await body(ok)).ok === true && tokenOf(NOA) === `rt-${NOA}` && pendingKeys().length === 0, `59 minutes: ${ok.status} ${show(await body(ok))}`);
    const lines = everyLog.filter(l => l.startsWith('[recent-sign-in]'));
    assert(show(lines) === show([
      `[recent-sign-in] user ${NOA}: oauth-claim-check refused: the google sign-in is not recent`,
      `[recent-sign-in] user ${NOA}: oauth-claim refused: the google sign-in is not recent`,
    ]), `log ${show(lines)}`);
    // The same on a Telegram account: the stale press leaves the entry for the chat claim, which connects it
    const mine = await park(TAL);
    const staleTal = await sessionCookie(TAL, 'tg', Date.now() - 61 * MIN);
    const second = await finish(mine, staleTal);
    assert(second.status === 403 && pendingKeys().length === 1, `the second stale press ${second.status}`);
    await connect.handleGoogleConnectTelegram(TAL_TG, TAL_TG, mine, 'en');
    assert(tokenOf(TAL) === `rt-${TAL}` && pendingKeys().length === 0, 'the chat claim did not connect it after a stale press');
  });

  await check('#6 the check or the claim from another site, with no Origin, or with no id is refused, and the entry stays', async () => {
    seed();
    const id = await park(NOA);
    const cookie = await sessionCookie(NOA, 'google');
    const peekEvil = await ask(id, cookie, { origin: 'https://evil.example' });
    assert(peekEvil.status === 403 && (await body(peekEvil)).error === 'cross_site', `the check from another site: ${peekEvil.status} ${show(await body(peekEvil))}`);
    const evil = await finish(id, cookie, { origin: 'https://evil.example' });
    assert(evil.status === 403 && (await body(evil)).error === 'cross_site', `another site: ${evil.status} ${show(await body(evil))}`);
    const bare = await finish(id, cookie, { origin: null });
    assert(bare.status === 403, `no Origin: ${bare.status}`);
    const empty = await route.POST(request('/api/oauth/claim', { body: {}, cookie }));
    assert(empty.status === 400 && (await body(empty)).error === 'expired', `no id: ${empty.status} ${show(await body(empty))}`);
    assert(pendingKeys().length === 1 && tokenOf(NOA) === '', 'a refused press touched the entry');
  });

  await check('#7 a commit that throws half-way answers failed (500), captured with the user id', async () => {
    seed();
    const id = await park(NOA);
    commitFails = true;
    const res = await finish(id, await sessionCookie(NOA, 'google'));
    assert(res.status === 500 && (await body(res)).error === 'failed', `${res.status} ${show(await body(res))}`);
    assert(captured.some(c => c.context === 'google-connect-claim' && c.extra?.user_id === NOA), `captured ${show(captured)}`);
  });

  await check('#8 no console line or capture of the run holds a waiting connection\'s id', () => {
    assert(ids.length >= 7, `only ${ids.length} ids were made`);
    const lines = everyLog.filter(l => ids.some(id => l.includes(id)));
    const reports = everyCapture.filter(c => ids.some(id => show(c).includes(id)));
    assert(lines.length === 0 && reports.length === 0, `leaked: ${show(lines)} ${show(reports)}`);
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
