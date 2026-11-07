// Smoke test for Settings' Delete account, the route (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3; plan
// docs/superpowers/plans/2026-11-07-b-features.md Task 6): POST /api/account/delete.
//  - D1 from another site, or with no Origin: 403 before anything is read; nothing is deleted
//  - D2 a browser session proved over an hour ago: 403 stale-sign-in (a WhatsApp link's says whatsapp: true); nothing deleted
//  - D3 Telegram initData is never asked the hour, and deletes
//  - D4 no confirm, or one that is not exactly true: 400, nothing deleted
//  - D5 a suspended account: 403 (verifyUserAuth) with its cookie cleared, nothing deleted
//  - D6 an admin account: 403 admin, nothing deleted
//  - D7 a fresh session: the account goes (the row, its sign-in way by the cascade, its calendars), the partner is unlinked
//    with no unlinker recorded and their calendars turn private, the session cookie is cleared, one log line names the
//    user id and the way in
//  - D8 pressed again (a second tab): 404, with the cookie cleared
//  - D9 no console line or Sentry report holds an address or a name
// Real: the route, api-auth, recent-sign-in, same-origin, session-auth, user-moderation's hardDeleteUser (the copy worker
// finds no copies). Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, error capture, the
// chats, fetch. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh: $RUN smoke-account-delete

import {
  assert, baseUser, body, check, DB, everyCapture, everyLog, identityRow, initDataFor, installSigninWorld, load, logs, report, request, resetWorld, sessionCookie, show, type Row,
} from './lib/signin-world';

const ADMIN = 1;
const ADMIN_TG = 111111111;
const DANA = 7;
const DANA_TG = 700000007;
const NOA = 8;
const ZOE = 9;
const HOUR = 3_600_000;
const urlOf = (id: number) => `/api/account/delete?user_id=${id}`;
const cleared = (res: Response) => /__Host-famcal_session=(;|$)/.test(res.headers.get('set-cookie') ?? '');

function seed(): void {
  resetWorld();
  const tenDays = new Date(Date.now() - 10 * 24 * HOUR);
  DB.user = [
    baseUser({ id: ADMIN, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }),
    baseUser({ id: DANA, name: 'Dana Levi', telegramId: BigInt(DANA_TG), pairingId: 'pair-dn' }),
    baseUser({ id: NOA, name: 'Noa Cohen', pairingId: 'pair-dn' }),
    baseUser({ id: ZOE, name: 'Zoe', suspendedAt: new Date(Date.now() - HOUR) }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: DANA, kind: 'email', subject: 'dana@example.com', address: 'dana@example.com' }),
    identityRow({ userId: ZOE, kind: 'email', subject: 'zoe@example.com', address: 'zoe@example.com' }),
  ];
  DB.pairing = [{ id: 'pair-dn', status: 'ACTIVE', inviterUserId: NOA, inviteeUserId: DANA, acceptedAt: tenDays, unlinkedAt: null, unlinkedByUserId: null, createdAt: tenDays }];
  DB.nativeCalendar = [
    { id: 'cal-dana', ownerUserId: DANA, name: 'Dana', privacy: 'SHARED_EDITOR', isDeleted: false },
    { id: 'cal-noa', ownerUserId: NOA, name: 'Noa', privacy: 'SHARED_EDITOR', isDeleted: false },
  ];
  for (const table of ['nativeEvent', 'googleSyncLink', 'userActivity', 'userFeedback', 'usageCounter', 'payment', 'subscription', 'userFeatureOverride', 'oAuthState', 'pushDevice', 'pairingInvite']) DB[table] = [];
}
const there = (id: number) => DB.user.some((u) => u.id === id);

async function main() {
  await installSigninWorld();
  const route = await load('app/api/account/delete/route.ts');
  const post = (id: number, o: { body?: unknown; cookie?: string; initData?: string; origin?: string | null } = {}) =>
    route.POST(request(urlOf(id), { body: o.body ?? { confirm: true }, cookie: o.cookie, initData: o.initData, origin: o.origin }));

  await check('D1 from another site, or with no Origin: 403 before anything is read; nothing is deleted', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email');
    for (const origin of ['https://evil.example', null]) {
      const res = await post(DANA, { cookie, origin });
      assert(res.status === 403 && (await body(res)).error === 'cross_site', `${origin}: ${res.status} ${show(await body(res))}`);
    }
    assert(there(DANA), 'the account went');
  });

  await check('D2 a browser session proved over an hour ago: 403 stale-sign-in, a WhatsApp link\'s with whatsapp: true; nothing deleted', async () => {
    seed();
    const email = await post(DANA, { cookie: await sessionCookie(DANA, 'email', Date.now() - 2 * HOUR) });
    assert(email.status === 403 && show(await body(email)) === show({ ok: false, error: 'stale-sign-in' }), `email: ${email.status} ${show(await body(email))}`);
    const wa = await post(DANA, { cookie: await sessionCookie(DANA, 'wa', Date.now() - 2 * HOUR) });
    assert(wa.status === 403 && show(await body(wa)) === show({ ok: false, error: 'stale-sign-in', whatsapp: true }), `wa: ${wa.status} ${show(await body(wa))}`);
    assert(there(DANA), 'the account went');
  });

  await check('D3 Telegram initData is never asked the hour, and deletes', async () => {
    seed();
    const res = await post(DANA_TG, { initData: initDataFor(DANA_TG) });
    assert(res.status === 200 && (await body(res)).ok === true && !there(DANA), `${res.status} ${show(await body(res))}`);
    assert(logs.includes(`[account-delete] user ${DANA} deleted their account (telegram)`), `logs ${show(logs.filter((l) => l.startsWith('[account-delete]')))}`);
  });

  await check('D4 no confirm, or one that is not exactly true: 400, nothing deleted', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email');
    for (const b of [{}, { confirm: 'true' }, { confirm: 1 }, { confirm: false }, { confirm: null }]) {
      const res = await post(DANA, { cookie, body: b });
      assert(res.status === 400 && (await body(res)).error === 'confirm_required', `${show(b)}: ${res.status} ${show(await body(res))}`);
    }
    assert(there(DANA), 'the account went');
  });

  await check('D5 a suspended account: 403, its cookie cleared, nothing deleted', async () => {
    seed();
    const res = await post(ZOE, { cookie: await sessionCookie(ZOE, 'email') });
    assert(res.status === 403 && cleared(res) && there(ZOE), `${res.status} cleared ${cleared(res)}`);
  });

  await check('D6 an admin account: 403 admin, nothing deleted', async () => {
    seed();
    const res = await post(ADMIN_TG, { initData: initDataFor(ADMIN_TG) });
    assert(res.status === 403 && (await body(res)).error === 'admin' && there(ADMIN), `${res.status} ${show(await body(res))}`);
  });

  await check('D7 a fresh session: the account goes (the row, its sign-in way, its calendar), the partner is unlinked with no unlinker and their calendar turns private, the cookie is cleared, one log line', async () => {
    seed();
    const res = await post(DANA, { cookie: await sessionCookie(DANA, 'email') });
    assert(res.status === 200 && show(await body(res)) === show({ ok: true }) && cleared(res), `${res.status} ${show(await body(res))} cleared ${cleared(res)}`);
    assert(!there(DANA) && !DB.signInIdentity.some((i) => i.userId === DANA) && !DB.nativeCalendar.some((c) => c.ownerUserId === DANA), 'something of the account stayed');
    const pairing = DB.pairing.find((p) => p.id === 'pair-dn') as Row | undefined;
    const noa = DB.user.find((u) => u.id === NOA) as Row;
    assert(pairing?.status === 'UNLINKED' && pairing.unlinkedByUserId === null && noa.pairingId === null, `pairing ${show(pairing)}, Noa ${noa.pairingId}`);
    assert(DB.nativeCalendar.find((c) => c.id === 'cal-noa')?.privacy === 'PRIVATE', 'the partner\'s calendar is still shared');
    assert(logs.filter((l) => l.startsWith('[account-delete]')).join('|') === `[account-delete] user ${DANA} deleted their account (session)`, `logs ${show(logs.filter((l) => l.startsWith('[account-delete]')))}`);
  });

  await check('D8 pressed again (a second tab): 404, with the cookie cleared', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email');
    assert((await post(DANA, { cookie })).status === 200, 'the first press');
    const again = await post(DANA, { cookie });
    assert(again.status === 404 && cleared(again), `${again.status} cleared ${cleared(again)}`);
  });

  await check('D9 no console line or Sentry report holds an address or a name', () => {
    const secrets = ['dana@example.com', 'zoe@example.com', 'Dana Levi', 'Noa Cohen'];
    const leaks = [...everyLog, ...everyCapture.map((c) => `${c.context} ${c.message} ${show(c.extra)}`)].filter((l) => secrets.some((s) => l.includes(s)));
    assert(leaks.length === 0, `leaks ${show(leaks)}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
