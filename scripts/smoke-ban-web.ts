// Smoke test for bans that cover web accounts (web sign-up spec 2026-11-03 §2.8, §2.15, §3.8; plan 6c-1 Task 2).
//
// What it pins:
//   - a ban by the account's database id:
//     - records each identifier the account has, one row each (Telegram id, WhatsApp number, Google account id,
//       sign-in address);
//     - ends the web sessions of the account and primes the cache keys;
//   - a bare ban of a Google id or an address signs out the account that holds it;
//   - isIdentifierBlocked and signInRefusal see the new kinds, and finishSignIn refuses them;
//   - an unban (by the account, or by one entry of the list) clears the rows and the keys;
//   - the list shows a Google id by its last 4 and an address masked;
//   - the admin route:
//     - takes { user_id } for a browser-only account;
//     - refuses the admin's own account (SELF_BAN) and answers NOT_FOUND for no such account;
//     - unbans by an entry's id;
//   - the users list says Web for an account with no chat;
//   - adding a way (Add Google, Add email) refuses a banned Google account or address;
//   - no log line or Sentry report holds an identifier or a name, and user-moderation prints no argument object.
//
// Real: user-moderation, identities, web-session, add-google, the blocklist, user-overrides and Add email routes, the
// panel's reachLabel. Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, error capture,
// the chats, fetch (Resend recorded). No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-ban-web

import fs from 'fs';
import path from 'path';
import {
  assert, baseUser, body, check, DB, everyCapture, everyLog, fakePrisma, identityRow, initDataFor, installSigninWorld, load, logs, mails,
  redisStore, report, request, resetWorld, ROOT, sent, show, type Row,
} from './lib/signin-world';

const ADMIN = 9;
const ADMIN_TG = 111111111;
const W = 50; // made on famcal.bot: a Google way and an email way, no chat
const T = 60; // Telegram and WhatsApp, and an email way
const T_TG = 666000060;
const T_PHONE = '+972500000060';
const V = 70; // made on famcal.bot with an email code only
const Q = 80; // Telegram only; adds ways in Settings
const Q_TG = 800000080;
/** The identifiers and names of the run: none may reach a log line or a Sentry report. */
const VALUES = [
  'g-web-0050', 'web@example.com', 'web@gmail.com', String(T_TG), T_PHONE, 't@example.com', 'v@example.com', 'g-gone-0001',
  'gone@example.com', 'Gone@Example.com', 'g-fresh-0080', 'fresh@gmail.com', 'other@gmail.com', 'Wren', 'Vera', 'Quinn',
];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const user = (id: number): Row => DB.user.find(u => u.id === id) as Row;
/** The blocklist rows now (a function, so a check's earlier length test does not narrow a later one for tsc). */
const blockedCount = (): number => DB.blockedIdentifier.length;
const blockedKeys = (): string[] => [...redisStore.keys()].filter(k => k.startsWith('blocked:')).sort();

function seed(): void {
  resetWorld();
  DB.user = [
    baseUser({ id: ADMIN, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }),
    baseUser({ id: W, name: 'Wren' }),
    baseUser({ id: T, name: 'Tom', telegramId: BigInt(T_TG), whatsappPhone: T_PHONE, messagingPlatform: 'all' }),
    baseUser({ id: V, name: 'Vera' }),
    baseUser({ id: Q, name: 'Quinn', telegramId: BigInt(Q_TG) }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: W, kind: 'google', subject: 'g-web-0050', address: 'web@gmail.com' }),
    identityRow({ userId: W, kind: 'email', subject: 'web@example.com', address: 'web@example.com' }),
    identityRow({ userId: T, kind: 'email', subject: 't@example.com', address: 't@example.com' }),
    identityRow({ userId: V, kind: 'email', subject: 'v@example.com', address: 'v@example.com' }),
  ];
  DB.blockedIdentifier = [];
}

async function main() {
  await installSigninWorld();
  const moderation = await load('src/lib/user-moderation.ts');
  const { signInRefusal, finishSignIn, signInPageUrl } = await load('src/lib/web-session.ts');
  const { SESSION_COOKIE_NAME } = await load('src/lib/session-auth.ts');
  const { emailKey, maskEmail } = await load('src/services/web-signin/email-address.ts');
  const { finishAddGoogle } = await load('src/services/web-signin/add-google.ts');
  const blocklistRoute = await load('app/api/admin/users/blocklist/route.ts');
  const overridesRoute = await load('app/api/admin/user-overrides/route.ts');
  const addRoute = await load('app/api/signin-methods/email/add/route.ts');
  const confirmRoute = await load('app/api/signin-methods/email/confirm/route.ts');
  const { reachLabel } = await import('../app/[locale]/(app)/admin-panel/data/format');
  const mailKey = (address: string) => `blocked:email:${emailKey(address)}`;
  const adminInit = initDataFor(ADMIN_TG);
  const post = async (b: Row): Promise<{ status: number; body: Row }> => {
    const res = await blocklistRoute.POST(request('/api/admin/users/blocklist', { body: { ...b, initData: adminInit } }));
    return { status: res.status, body: await body(res) };
  };

  await check('#1 a ban by the database id of a browser-only account records its Google account and its sign-in address, one row each; its web sessions end; both cache keys are set; the log names the user and the kinds only', async () => {
    seed();
    const result = await moderation.banIdentifier({ userId: W }, ADMIN, 'spam');
    assert(show(result) === show({ kinds: ['google', 'email'] }), `kinds ${show(result)}`);
    const rows = DB.blockedIdentifier;
    assert(rows.length === 2 && rows.some(r => r.googleSub === 'g-web-0050' && r.email === null) && rows.some(r => r.email === 'web@example.com' && r.googleSub === null), `rows ${show(rows)}`);
    assert(rows.every(r => r.telegramId === null && r.whatsappPhone === null && r.bannedBy === ADMIN && r.bannedReason === 'spam'), `rows ${show(rows)}`);
    assert(user(W).sessionsValidAfter instanceof Date && user(T).sessionsValidAfter === null && user(V).sessionsValidAfter === null, 'not only W was signed out');
    assert(show(blockedKeys()) === show(['blocked:google:g-web-0050', mailKey('web@example.com')].sort()), `keys ${show(blockedKeys())}`);
    assert(logs.includes(`[Moderation] Admin ${ADMIN} banned user ${W}: google, email`), `logs ${show(logs)}`);
  });

  await check('#2 a ban by the database id of a chat account records its Telegram id, WhatsApp number and address; a second ban updates the reason and adds no row', async () => {
    seed();
    const result = await moderation.banIdentifier({ userId: T }, ADMIN, null);
    assert(show(result) === show({ kinds: ['telegram', 'whatsapp', 'email'] }), `kinds ${show(result)}`);
    const rows = DB.blockedIdentifier;
    assert(rows.length === 3 && rows.some(r => String(r.telegramId) === String(T_TG)) && rows.some(r => r.whatsappPhone === T_PHONE) && rows.some(r => r.email === 't@example.com'), `rows ${show(rows)}`);
    assert(user(T).sessionsValidAfter instanceof Date && user(W).sessionsValidAfter === null, 'the wrong account was signed out');
    assert(show(blockedKeys()) === show([`blocked:tg:${T_TG}`, `blocked:wa:${T_PHONE}`, mailKey('t@example.com')].sort()), `keys ${show(blockedKeys())}`);
    await moderation.banIdentifier({ userId: T }, ADMIN, 'again');
    assert(blockedCount() === 3 && DB.blockedIdentifier.every(r => r.bannedReason === 'again'), `after a second ban ${show(DB.blockedIdentifier)}`);
  });

  await check('#3 isIdentifierBlocked answers for a banned Google account and address, not for others, and a database hit primes its key again', async () => {
    seed();
    await moderation.banIdentifier({ userId: W }, ADMIN, null);
    for (const key of blockedKeys()) redisStore.delete(key);
    assert((await moderation.isIdentifierBlocked({ googleSub: 'g-web-0050' })) === true, 'the Google account');
    assert((await moderation.isIdentifierBlocked({ email: 'web@example.com' })) === true, 'the address');
    assert((await moderation.isIdentifierBlocked({ googleSub: 'g-other', email: 'other@example.com' })) === false, 'others');
    assert(show(blockedKeys()) === show(['blocked:google:g-web-0050', mailKey('web@example.com')].sort()), `primed ${show(blockedKeys())}`);
  });

  await check('#4 signInRefusal reads the account\'s ways: a bare ban of an address, or of a Google account, signs out the account that holds it and refuses it; finishSignIn answers blocked with no session cookie', async () => {
    seed();
    assert((await signInRefusal(user(V))) === null && (await signInRefusal(user(W))) === null, 'an account in good standing was refused');
    const bare = await moderation.banIdentifier({ email: 'v@example.com' }, ADMIN, null);
    assert(show(bare) === show({ kinds: ['email'] }), `kinds ${show(bare)}`);
    assert(user(V).sessionsValidAfter instanceof Date && user(W).sessionsValidAfter === null, 'the holder of the address was not signed out');
    assert((await signInRefusal(user(V))) === 'blocked', 'a banned email way');
    await moderation.banIdentifier({ googleSub: 'g-web-0050' }, ADMIN, null);
    assert(user(W).sessionsValidAfter instanceof Date && (await signInRefusal(user(W))) === 'blocked', 'a banned Google way');
    assert(logs.includes(`[Moderation] Admin ${ADMIN} banned identifiers: email`) && logs.includes(`[Moderation] Admin ${ADMIN} banned identifiers: google`), `logs ${show(logs)}`);
    const res = await finishSignIn(user(V), 'email', { respond: 'json' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert(res.status === 403 && show(await body(res)) === show({ ok: false, status: 'blocked' }) && !new RegExp(`${SESSION_COOKIE_NAME}=[^;]`).test(setCookie), `finishSignIn ${res.status} ${setCookie}`);
  });

  await check('#4b a sign-in with an existing account whose Google address was banned through another account\'s email way is refused (spec §2.8); a ban of the address as the account\'s own email way is not checked twice', async () => {
    seed();
    assert((await signInRefusal(user(W))) === null, 'W refused before any ban');
    await moderation.banIdentifier({ email: 'web@gmail.com' }, ADMIN, null);
    assert((await signInRefusal(user(W))) === 'blocked', 'the Google way\'s address is banned and W can sign in');
    assert((await signInRefusal(user(V))) === null && (await signInRefusal(user(T))) === null, 'an unrelated account was refused');
    const res = await finishSignIn(user(W), 'google', { respond: 'json' });
    assert(res.status === 403 && show(await body(res)) === show({ ok: false, status: 'blocked' }), `finishSignIn ${res.status}`);
  });

  await check('#5 an unban by the account clears its rows and keys and lets it sign in; an unban by one entry\'s id clears that entry only; an unknown entry is NOT_FOUND; the logs name the user or the entry and the kinds', async () => {
    seed();
    await moderation.banIdentifier({ userId: W }, ADMIN, null);
    await moderation.banIdentifier({ userId: T }, ADMIN, null);
    const off = await moderation.unbanIdentifier({ userId: W }, ADMIN);
    assert(show(off) === show({ kinds: ['google', 'email'] }), `kinds ${show(off)}`);
    assert(blockedCount() === 3 && !DB.blockedIdentifier.some(r => r.googleSub === 'g-web-0050' || r.email === 'web@example.com'), `rows ${show(DB.blockedIdentifier)}`);
    assert(!blockedKeys().includes('blocked:google:g-web-0050') && !blockedKeys().includes(mailKey('web@example.com')), `keys ${show(blockedKeys())}`);
    assert((await signInRefusal(user(W))) === null, 'W is still refused');
    const phoneRow = DB.blockedIdentifier.find(r => r.whatsappPhone === T_PHONE) as Row;
    const one = await moderation.unbanIdentifier({ entryId: phoneRow.id }, ADMIN);
    assert(show(one) === show({ kinds: ['whatsapp'] }) && blockedCount() === 2, `entry ${show(one)} ${show(DB.blockedIdentifier)}`);
    assert(!blockedKeys().includes(`blocked:wa:${T_PHONE}`) && blockedKeys().includes(`blocked:tg:${T_TG}`), `keys ${show(blockedKeys())}`);
    let missing: unknown = null;
    try {
      await moderation.unbanIdentifier({ entryId: 999 }, ADMIN);
    } catch (error) {
      missing = error;
    }
    assert(missing instanceof moderation.BanTargetError && (missing as Row).code === 'NOT_FOUND', `an unknown entry: ${show(missing)}`);
    assert(logs.includes(`[Moderation] Admin ${ADMIN} unbanned user ${W}: google, email`) && logs.includes(`[Moderation] Admin ${ADMIN} unbanned entry ${phoneRow.id}: whatsapp`), `logs ${show(logs)}`);
  });

  await check('#6 the list: each entry\'s kind and how it is shown (the Telegram id and the number in full, a Google account by the last 4 of its id, an address masked), and never the Google id or the address itself', async () => {
    seed();
    await moderation.banIdentifier({ userId: W }, ADMIN, 'spam');
    await moderation.banIdentifier({ userId: T }, ADMIN, null);
    const list: Row[] = await moderation.listBlockedIdentifiers();
    const shown = list.map(e => `${e.kind}:${e.shown}`).sort();
    const want = [`email:${maskEmail('t@example.com')}`, `email:${maskEmail('web@example.com')}`, 'google:•••0050', `telegram:${T_TG}`, `whatsapp:${T_PHONE}`].sort();
    assert(show(shown) === show(want), `shown ${show(shown)}`);
    const text = show(list);
    assert(!text.includes('g-web-0050') && !text.includes('web@example.com') && !text.includes('t@example.com'), `the list holds an identifier: ${text}`);
    assert(list.every(e => Object.keys(e).sort().join() === 'bannedBy,bannedReason,createdAt,id,kind,shown'), `entry fields ${show(list.map(e => Object.keys(e)))}`);
  });

  await check('#7 the admin route: Block by user_id works for a browser-only account and answers its kinds; the admin\'s own account is SELF_BAN; no such account is NOT_FOUND; the GET is masked; Unblock by entryId; no target at all is 400', async () => {
    seed();
    const own = await post({ action: 'ban', user_id: ADMIN, reason: 'oops' });
    assert(own.status === 400 && own.body.error === 'SELF_BAN' && blockedCount() === 0, `own ${own.status} ${show(own.body)}`);
    const web = await post({ action: 'ban', user_id: W, reason: 'spam' });
    assert(web.status === 200 && web.body.success === true && show(web.body.kinds) === show(['google', 'email']) && blockedCount() === 2, `web ${web.status} ${show(web.body)}`);
    const nobody = await post({ action: 'ban', user_id: 4242 });
    assert(nobody.status === 404 && nobody.body.error === 'NOT_FOUND', `nobody ${nobody.status} ${show(nobody.body)}`);
    const listed = await blocklistRoute.GET(request('/api/admin/users/blocklist', { initData: adminInit }));
    const entries = (await body(listed)).blocklist as Row[];
    assert(listed.status === 200 && show(entries.map(e => e.kind).sort()) === show(['email', 'google']) && !show(entries).includes('g-web-0050') && !show(entries).includes('web@example.com'), `GET ${show(entries)}`);
    const google = entries.find(e => e.kind === 'google') as Row;
    const unban = await post({ action: 'unban', entryId: google.id });
    assert(unban.status === 200 && blockedCount() === 1 && DB.blockedIdentifier[0].email === 'web@example.com', `unban ${unban.status} ${show(DB.blockedIdentifier)}`);
    const none = await post({ action: 'ban' });
    assert(none.status === 400 && none.body.error !== 'SELF_BAN', `no target ${none.status} ${show(none.body)}`);
  });

  await check('#8 the users list carries hasChat (false for an account with no Telegram and no WhatsApp), reachLabel words a row Web, WhatsApp or nothing, and the new admin words exist in en, he and ru', async () => {
    seed();
    const res = await overridesRoute.GET(request('/api/admin/user-overrides?list=all', { initData: adminInit }));
    const rows = (await body(res)).users as Row[];
    const chat = (id: number) => rows.find(r => r.id === id)?.hasChat;
    assert(res.status === 200 && chat(W) === false && chat(V) === false && chat(T) === true && chat(Q) === true && chat(ADMIN) === true, `hasChat ${show(rows.map(r => [r.id, r.hasChat]))}`);
    assert(reachLabel({ telegramId: null, hasChat: false }) === 'users.web' && reachLabel({ telegramId: null, hasChat: true }) === 'users.whatsapp' && reachLabel({ telegramId: 5, hasChat: true }) === null, 'reachLabel');
    for (const locale of ['en', 'he', 'ru']) {
      const admin = JSON.parse(read(`messages/${locale}.json`)).admin;
      for (const key of ['users.web', 'blocked.google', 'blocked.email']) {
        const value: unknown = key.split('.').reduce((o: Row | undefined, k) => o?.[k], admin);
        assert(typeof value === 'string' && value.trim() !== '', `${locale}: admin.${key} is missing`);
      }
      assert(/Google/.test(admin.blocked.intro) && /Google/.test(admin.profile.account.blockBody), `${locale}: the blocked intro and the Block sheet don't name Google`);
    }
  });

  await check('#9 adding a way checks the new way: Add Google with a banned Google account, or with a banned verified address, goes to status=blocked with no way and no notice; an unbanned one is added; Add email\'s right code for a banned address answers 403 blocked with no way', async () => {
    seed();
    await moderation.banIdentifier({ googleSub: 'g-gone-0001' }, ADMIN, null);
    await moderation.banIdentifier({ email: 'gone@example.com' }, ADMIN, null);
    const flow = { kind: 'add-google', state: 's', nonce: 'n', codeVerifier: 'v', locale: 'en', userId: Q };
    const blockedPage = signInPageUrl('en', 'blocked');
    for (const claims of [{ sub: 'g-gone-0001', email: 'other@gmail.com', emailVerified: true }, { sub: 'g-fresh-0080', email: 'Gone@Example.com', emailVerified: true }]) {
      const res = await finishAddGoogle(flow, claims);
      assert(res.headers.get('location') === blockedPage && !DB.signInIdentity.some(i => i.userId === Q), `${claims.sub}: ${res.headers.get('location')}`);
    }
    assert(sent.length === 0, `a refused add sent ${show(sent)}`);
    const fine = await finishAddGoogle(flow, { sub: 'g-fresh-0080', email: 'fresh@gmail.com', emailVerified: true });
    assert(fine.headers.get('location') !== blockedPage && DB.signInIdentity.some(i => i.userId === Q && i.kind === 'google' && i.subject === 'g-fresh-0080'), `fine ${fine.headers.get('location')}`);
    const auth = { initData: initDataFor(Q_TG) };
    const asked = await addRoute.POST(request(`/api/signin-methods/email/add?user_id=${Q_TG}`, { ...auth, body: { email: 'Gone@Example.com' } }));
    assert(asked.status === 200, `add ${asked.status} ${show(await body(asked))}`);
    const code = /\b(\d{6})\b/.exec(JSON.stringify(mails[mails.length - 1]?.body ?? {}))?.[1] ?? '';
    assert(code !== '', 'no code was mailed');
    const sentBefore = sent.length;
    const confirmed = await confirmRoute.POST(request(`/api/signin-methods/email/confirm?user_id=${Q_TG}`, { ...auth, body: { code } }));
    assert(confirmed.status === 403 && (await body(confirmed)).error === 'blocked', `confirm ${confirmed.status} ${show(await body(confirmed))}`);
    assert(!DB.signInIdentity.some(i => i.userId === Q && i.kind === 'email') && sent.length === sentBefore, 'a banned address became a way, or a notice went out');
  });

  await check('#9b a database failure during a ban answers 500 and reaches the log and Sentry by its kind only, never the Google id or the address in the error text', async () => {
    seed();
    const real = fakePrisma.blockedIdentifier.upsert;
    fakePrisma.blockedIdentifier.upsert = async () => {
      throw Object.assign(new Error('Invalid prisma.blockedIdentifier.upsert() invocation: email: "web@example.com" googleSub: "g-web-0050"'), { code: 'P1001' });
    };
    let res: { status: number; body: Row };
    try {
      res = await post({ action: 'ban', user_id: W });
    } finally {
      fakePrisma.blockedIdentifier.upsert = real;
    }
    assert(res.status === 500, `status ${res.status} ${show(res.body)}`);
    assert(!everyLog.some(l => l.includes('web@example.com') || l.includes('g-web-0050')), `log leak ${show(everyLog.filter(l => l.includes('web@example.com') || l.includes('g-web-0050')))}`);
    assert(!everyCapture.some(c => show(c).includes('web@example.com') || show(c).includes('g-web-0050')), 'Sentry leak');
    assert(everyCapture.some(c => show(c).includes('P1001')), `the failure was not captured: ${show(everyCapture)}`);
  });

  await check('#10 no log line or Sentry report of the run holds an identifier or a name, and user-moderation prints no argument object', () => {
    const leaks = everyLog.filter(l => VALUES.some(v => l.includes(v)));
    assert(leaks.length === 0, `log leaks ${show(leaks)}`);
    const reported = everyCapture.filter(c => VALUES.some(v => show(c).includes(v)));
    assert(reported.length === 0, `Sentry leaks ${show(reported)}`);
    assert(!/console\.\w+\([^\n]*,\s*(args|target)\s*\)/.test(read('src/lib/user-moderation.ts')), 'a console line in user-moderation prints the ban\'s arguments');
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
