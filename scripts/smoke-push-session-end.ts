// Smoke test for ending browser devices with the sessions (6c-2 spec §2.4, §3.7; plan Task 6).
//
// What it pins:
//   - sign out on all devices, removing a sign-in way, a suspension and a ban delete the account's browser devices in
//     the same write that moves sessionsValidAfter (a failing delete rolls the whole write back), and then re-sync the
//     account's event-alerts cache entry;
//   - Remove keeps the device it was pressed on (the endpoint the browser sends), and only that one of the account's,
//     and only for a web session (a Mini App Remove keeps none); an endpoint the server would not accept keeps none and
//     the removal still goes ahead; a removal that changes nothing keeps every device;
//   - a Telegram account (no device) is written as before: its cache entry is not rewritten;
//   - every writer of sessionsValidAfter in src/ and app/ deletes devices (a fence for a new writer: any key, shorthand,
//     assignment or raw-SQL column outside a where / select / orderBy; E10b pins what the detector reads as a write);
//   - no log line or Sentry capture holds an endpoint.
//
// Real: the signout-all and remove routes, identities, user-moderation, devices, the reminder cache, api-auth. Faked at
// the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, error capture, the chats, fetch. No network,
// no DB.
//
// Run with the fake env of scripts/ci-smokes.sh: $RUN smoke-push-session-end

import fs from 'fs';
import path from 'path';
import {
  assert, baseUser, body, check, DAY, DB, everyCapture, everyLog, fakePrisma, identityRow, initDataFor, installSigninWorld, load, redisStore,
  report, request, resetWorld, ROOT, sessionCookie, show, type Row,
} from './lib/signin-world';

const ADMIN = 1;
const ADMIN_TG = 111111111;
const W = 50; // made on famcal.bot: a Google way and an email way, no chat, three devices
const P = 51; // made on famcal.bot: an email way only, one device
const T = 60; // Telegram, no device
const T_TG = 600000060;

const EP = (n: string) => `https://fcm.googleapis.com/fcm/send/smoke-${n}`;
const device = (id: string, userId: number, n: string): Row => ({
  id, userId, endpoint: EP(n), p256dh: 'B'.repeat(87), auth: 'A'.repeat(22), createdAt: new Date(Date.now() - DAY),
});
/** The ids of an account's devices now, sorted. */
const devicesOf = (userId: number): string[] => (DB.pushDevice ?? []).filter(d => d.userId === userId).map(d => d.id).sort();
const user = (id: number): Row => DB.user.find(u => u.id === id) as Row;
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Whether this source writes User.sessionsValidAfter, read from code with its comments dropped and its strings blanked:
 * a key `sessionsValidAfter:` or a shorthand `{ sessionsValidAfter }` in any object that is not a where / select /
 * orderBy (also under AND / OR / NOT / some / every / none / is / isNot and inside an array there), an assignment
 * `x.sessionsValidAfter = ...`, or the quoted column "sessionsValidAfter" in raw SQL. A read of the property
 * (`user.sessionsValidAfter`) and a destructuring (`const { sessionsValidAfter } = user`) are not writes.
 */
function writesSessionsValidAfter(source: string): boolean {
  // One pass: `kept` has the comments blanked, `skeleton` also the insides of strings (so a brace or a name in a string is not code)
  let kept = '';
  let skeleton = '';
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    const blank = c === '\n' ? '\n' : ' ';
    if (state === 'line') {
      if (c === '\n') state = 'code';
      kept += blank; skeleton += blank;
    } else if (state === 'block') {
      if (c === '*' && next === '/') { kept += '  '; skeleton += '  '; i++; state = 'code'; } else { kept += blank; skeleton += blank; }
    } else if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; kept += blank; skeleton += blank; }
      else if (c === '/' && next === '*') { state = 'block'; kept += '  '; skeleton += '  '; i++; }
      else {
        if (c === "'" || c === '"' || c === '`') state = c;
        kept += c; skeleton += c;
      }
    } else {
      // inside a string: kept as written, blanked in the skeleton; a quote not escaped closes it, and a ' or " one ends with its line
      if (c === '\\') { kept += c + (next ?? ''); skeleton += ' ' + (next === '\n' ? '\n' : ' '); i++; }
      else if (c === state) { state = 'code'; kept += c; skeleton += c; }
      else if (c === '\n' && state !== '`') { state = 'code'; kept += c; skeleton += c; }
      else { kept += c; skeleton += blank; }
    }
  }
  if (/"sessionsValidAfter"/.test(kept)) return true;
  const READ_KEYS = new Set(['where', 'select', 'orderBy', 'having', 'cursor']);
  const THROUGH_KEYS = new Set(['AND', 'OR', 'NOT', 'some', 'every', 'none', 'is', 'isNot']);
  for (const m of skeleton.matchAll(/\bsessionsValidAfter\b/g)) {
    const at = m.index ?? 0;
    const before = skeleton.slice(0, at).trimEnd();
    const after = skeleton.slice(at + m[0].length).trimStart();
    if (before.endsWith('.')) {
      if (/^=(?!=)/.test(after)) return true; // x.sessionsValidAfter = ...
      continue; // a read of the property
    }
    const isKey = after.startsWith(':');
    const isShorthand = /[{,]$/.test(before) && /^[,}]/.test(after);
    if (!isKey && !isShorthand) continue;
    if (isShorthand && /\b(?:const|let|var)\s*\{[^{}]*$/.test(before)) continue; // a destructuring
    if (writeContext(skeleton, at, READ_KEYS, THROUGH_KEYS)) return true;
  }
  return false;
}

/** Walks out of the object holding the name: true when the first object with a key of its own is not a read. */
function writeContext(code: string, at: number, readKeys: Set<string>, throughKeys: Set<string>): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = code[i];
    if (c === '}' || c === ']' || c === ')') { depth++; continue; }
    if (c !== '{' && c !== '[' && c !== '(') continue;
    if (depth > 0) { depth--; continue; }
    if (c === '(') return true; // reached a call with no read key on the way: an object handed over as it is
    const key = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(code.slice(0, i))?.[1];
    if (key !== undefined) {
      if (readKeys.has(key)) return false;
      if (throughKeys.has(key)) continue;
      return true; // data, create, update, set ...
    }
    // An object with no key: an array element (go on out), or a standalone object (`= {`, `return {`)
    if (c === '{' && !/[\[,]\s*$/.test(code.slice(0, i))) return true;
  }
  return true;
}

async function main() {
  await installSigninWorld();
  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const signoutAll = await load('app/api/auth/signout-all/route.ts');
  const removeRoute = await load('app/api/signin-methods/remove/route.ts');
  const moderation = await load('src/lib/user-moderation.ts');

  const CACHE = REDIS_KEYS.REMINDER_USERS as string;
  /** An event-alerts cache entry as the hourly rebuild writes it (reminder-cache.ts CachedReminderUser). */
  const entry = (id: number, name: string, telegramId: string): Row => ({
    id, telegramId, googleToken: '', calendarAssignments: null, defaultReminderMinutes: null, language: 'en', name,
    pickupRemindersEnabled: true, calendarSource: 'NATIVE', pairingId: null, location: 'Tel Aviv',
  });
  const cached = (): Row[] => JSON.parse(redisStore.get(CACHE) ?? '[]') as Row[];

  function seed(): void {
    resetWorld();
    DB.user = [
      baseUser({ id: ADMIN, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }),
      baseUser({ id: W, name: 'Wren', remindersEnabled: true }),
      baseUser({ id: P, name: 'Pia', remindersEnabled: true }),
      baseUser({ id: T, name: 'Tom', telegramId: BigInt(T_TG), remindersEnabled: true }),
    ];
    DB.signInIdentity = [
      identityRow({ userId: W, kind: 'google', subject: 'g-wren-0050', address: 'wren@gmail.com' }),
      identityRow({ userId: W, kind: 'email', subject: 'wren@example.com', address: 'wren@example.com' }),
      identityRow({ userId: P, kind: 'email', subject: 'pia@example.com', address: 'pia@example.com' }),
    ];
    DB.blockedIdentifier = [];
    DB.pushDevice = [device('d-w1', W, 'w1'), device('d-w2', W, 'w2'), device('d-w3', W, 'w3'), device('d-p1', P, 'p1')];
    // As if the alerts cache had admitted W (Task 9): the writer's re-sync must take it out once W has no device.
    // T's entry is a sentinel: a re-sync would rewrite its name to Tom's.
    redisStore.set(CACHE, JSON.stringify([entry(W, 'wren-entry', ''), entry(T, 'sentinel', String(T_TG))]));
  }
  const cookieOf = (userId: number) => sessionCookie(userId, 'email');
  const remove = async (userId: number, b: Row) =>
    removeRoute.POST(request(`/api/signin-methods/remove?user_id=${userId}`, { body: b, cookie: await cookieOf(userId) }));
  /** Runs `fn` with every pushDevice.deleteMany failing, as a dropped connection would. */
  const withFailingDelete = async (fn: () => Promise<unknown>): Promise<void> => {
    const real = fakePrisma.pushDevice.deleteMany;
    fakePrisma.pushDevice.deleteMany = async () => { throw Object.assign(new Error('connection reset (smoke)'), { code: 'P1001' }); };
    try {
      await fn();
    } finally {
      fakePrisma.pushDevice.deleteMany = real;
    }
  };

  await check('E1 sign out on all devices deletes every device of the account in the same write, another account\'s stay, and the account\'s alert entry is re-synced', async () => {
    seed();
    const res = await signoutAll.POST(request(`/api/auth/signout-all?user_id=${W}`, { body: {}, cookie: await cookieOf(W) }));
    assert(res.status === 200 && (await body(res)).ok === true, `status ${res.status} ${show(await body(res))}`);
    assert(user(W).sessionsValidAfter instanceof Date, 'sessionsValidAfter did not move');
    assert(show(devicesOf(W)) === '[]' && show(devicesOf(P)) === show(['d-p1']), `devices ${show(DB.pushDevice)}`);
    assert(!cached().some(e => e.id === W), `W's alert entry stayed: ${show(cached())}`);
    assert(cached().find(e => e.id === T)?.name === 'sentinel', 'another account\'s entry was rewritten');
  });

  await check('E2 a Telegram account signs out on all devices as before: sessionsValidAfter moves, no device of anyone goes, and its alert entry is not rewritten', async () => {
    seed();
    const res = await signoutAll.POST(request('/api/auth/signout-all', { body: { user_id: T_TG, initData: initDataFor(T_TG) } }));
    assert(res.status === 200, `status ${res.status}`);
    assert(user(T).sessionsValidAfter instanceof Date, 'not signed out');
    assert(DB.pushDevice.length === 4, `devices ${show(DB.pushDevice.map(d => d.id))}`);
    assert(cached().find(e => e.id === T)?.name === 'sentinel', `T's entry was rewritten: ${show(cached())}`);
  });

  await check('E3 the sign-out is one write: when the device delete fails, sessionsValidAfter stays as it was and the answer is 500', async () => {
    seed();
    let status = 0;
    await withFailingDelete(async () => {
      const res = await signoutAll.POST(request(`/api/auth/signout-all?user_id=${W}`, { body: {}, cookie: await cookieOf(W) }));
      status = res.status;
    });
    assert(status === 500, `status ${status}`);
    assert(user(W).sessionsValidAfter === null && devicesOf(W).length === 3, `written anyway: ${show(user(W).sessionsValidAfter)} ${show(devicesOf(W))}`);
  });

  await check('E4 Remove keeps the device it was pressed on (the endpoint the browser sent) and deletes the account\'s others, in the same write; the alert entry is re-synced', async () => {
    seed();
    const res = await remove(W, { which: 'google', endpoint: EP('w2') });
    const answer = await body(res);
    assert(res.status === 200 && answer.ok === true, `status ${res.status} ${show(answer)}`);
    assert(!DB.signInIdentity.some(i => i.userId === W && i.kind === 'google') && user(W).sessionsValidAfter instanceof Date, 'the way was not removed');
    assert(show(devicesOf(W)) === show(['d-w2']) && show(devicesOf(P)) === show(['d-p1']), `devices ${show(DB.pushDevice.map(d => d.id))}`);
    assert(!cached().some(e => e.id === W), `W's alert entry stayed: ${show(cached())}`);
  });

  await check('E5 Remove with no endpoint (no subscription in this browser) deletes every device of the account; naming another account\'s device keeps none of this account\'s and touches nothing of the other\'s', async () => {
    seed();
    let res = await remove(W, { which: 'google' });
    assert(res.status === 200 && devicesOf(W).length === 0 && devicesOf(P).length === 1, `no endpoint: ${res.status} ${show(DB.pushDevice.map(d => d.id))}`);
    seed();
    res = await remove(W, { which: 'email', endpoint: EP('p1') });
    assert(res.status === 200 && devicesOf(W).length === 0 && show(devicesOf(P)) === show(['d-p1']), `another account's endpoint: ${res.status} ${show(DB.pushDevice.map(d => d.id))}`);
  });

  await check('E6 Remove with an endpoint the server would not accept (not https, not a URL, too long, a host that is not a push service, not a string) keeps no device: the way is removed, every session ends, every device of the account is deleted, and one line says so without the endpoint', async () => {
    for (const endpoint of ['http://push.example/ep', 'not a url', `https://push.example/${'a'.repeat(1100)}`, 'https://push.example.test/send/smoke-bad', 42, { url: EP('w1') }]) {
      seed();
      const lines = everyLog.length;
      const res = await remove(W, { which: 'google', endpoint });
      const answer = await body(res);
      assert(res.status === 200 && answer.ok === true, `${show(endpoint).slice(0, 40)}: ${res.status} ${show(answer)}`);
      assert(!DB.signInIdentity.some(i => i.userId === W && i.kind === 'google') && user(W).sessionsValidAfter instanceof Date, `${show(endpoint).slice(0, 40)}: the way was not removed`);
      assert(devicesOf(W).length === 0 && show(devicesOf(P)) === show(['d-p1']), `${show(endpoint).slice(0, 40)}: devices ${show(DB.pushDevice.map(d => d.id))}`);
      const said = everyLog.slice(lines).filter(l => l.includes('kept no device'));
      assert(show(said) === show([`[signin-methods] user ${W}: kept no device: endpoint not valid`]), `${show(endpoint).slice(0, 40)}: the line ${show(said)}`);
      assert(!everyLog.slice(lines).some(l => l.includes('push.example') || l.includes('not a url')), `${show(endpoint).slice(0, 40)}: a log line holds the endpoint`);
    }
    seed();
    const lines = everyLog.length;
    await remove(W, { which: 'google' });
    assert(!everyLog.slice(lines).some(l => l.includes('kept no device')), 'an absent endpoint logged the not-valid line');
  });

  await check('E6b a Mini App (initData) Remove that sends an endpoint keeps no device either: only a web session stays signed in, so only its browser keeps one', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: T, kind: 'google', subject: 'g-tom-0060', address: 'tom@gmail.com' }));
    DB.pushDevice.push(device('d-t1', T, 't1'), device('d-t2', T, 't2'));
    const res = await removeRoute.POST(request(`/api/signin-methods/remove?user_id=${T_TG}`, { body: { which: 'google', endpoint: EP('t1') }, initData: initDataFor(T_TG) }));
    const answer = await body(res);
    assert(res.status === 200 && answer.ok === true, `status ${res.status} ${show(answer)}`);
    assert(!DB.signInIdentity.some(i => i.userId === T && i.kind === 'google') && user(T).sessionsValidAfter instanceof Date, 'the way was not removed');
    assert(devicesOf(T).length === 0, `a Mini App Remove kept a device: ${show(devicesOf(T))}`);
  });

  await check('E7 a removal that changes nothing keeps every device: the last way (409), and a calendar switch already off (none)', async () => {
    seed();
    const last = await remove(P, { which: 'email' });
    assert(last.status === 409 && show(devicesOf(P)) === show(['d-p1']), `last way: ${last.status} ${show(devicesOf(P))}`);
    user(W).googleCalendarSignIn = false;
    const none = await remove(W, { which: 'calendar-google' });
    assert(none.status === 200 && devicesOf(W).length === 3 && user(W).sessionsValidAfter === null, `none: ${none.status} ${show(devicesOf(W))}`);
  });

  await check('E8 a suspension deletes the account\'s devices in its write and re-syncs its entry; a failing delete leaves the account unsuspended; a Telegram account\'s entry is not rewritten', async () => {
    seed();
    await moderation.suspendUser(W, ADMIN, 'smoke');
    assert(user(W).suspendedAt instanceof Date && user(W).sessionsValidAfter instanceof Date, 'not suspended');
    assert(devicesOf(W).length === 0 && devicesOf(P).length === 1, `devices ${show(DB.pushDevice.map(d => d.id))}`);
    assert(!cached().some(e => e.id === W), `W's entry stayed: ${show(cached())}`);
    seed();
    let threw = false;
    await withFailingDelete(async () => {
      try { await moderation.suspendUser(W, ADMIN, 'smoke'); } catch { threw = true; }
    });
    assert(threw && user(W).suspendedAt === null && user(W).sessionsValidAfter === null && devicesOf(W).length === 3, `a failed delete: threw ${threw}, ${show(user(W).suspendedAt)}`);
    seed();
    await moderation.suspendUser(T, ADMIN, null);
    assert(cached().find(e => e.id === T)?.name === 'sentinel', `T's entry was rewritten: ${show(cached())}`);
  });

  await check('E9 a ban deletes the devices of every account it signs out, in the same write: by account, and a bare ban of an address another account holds; other accounts keep theirs', async () => {
    seed();
    await moderation.banIdentifier({ userId: W }, ADMIN, null);
    assert(user(W).sessionsValidAfter instanceof Date && devicesOf(W).length === 0 && show(devicesOf(P)) === show(['d-p1']), `by account: ${show(DB.pushDevice.map(d => d.id))}`);
    assert(!cached().some(e => e.id === W) && cached().find(e => e.id === T)?.name === 'sentinel', `cache ${show(cached())}`);
    seed();
    await moderation.banIdentifier({ email: 'pia@example.com' }, ADMIN, null);
    assert(user(P).sessionsValidAfter instanceof Date && devicesOf(P).length === 0 && devicesOf(W).length === 3, `bare ban: ${show(DB.pushDevice.map(d => d.id))}`);
  });

  await check('E10 [fence] every write of sessionsValidAfter in src/ and app/ deletes devices: the writers are signout-all, identities and user-moderation (suspend and ban), and each calls deleteDevicesOf', () => {
    const files: string[] = [];
    for (const dir of ['src', 'app']) {
      for (const rel of fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(rel)) continue;
        const file = path.join(dir, rel);
        if (writesSessionsValidAfter(read(file))) files.push(file.split(path.sep).join('/'));
      }
    }
    const want = ['app/api/auth/signout-all/route.ts', 'src/lib/user-moderation.ts', 'src/services/web-signin/identities.ts'];
    assert(show(files.sort()) === show(want), `writers of sessionsValidAfter: ${show(files.sort())}; a new one must delete the account's devices in its write and be added here`);
    for (const file of want) assert(read(file).includes('deleteDevicesOf('), `${file} does not delete devices`);
    assert((read('src/lib/user-moderation.ts').match(/deleteDevicesOf\(/g) ?? []).length >= 2, 'user-moderation: the suspension and the ban each delete devices');
  });

  await check('E10b [fence self-test] the detector reads any key, shorthand, assignment or raw-SQL column as a write, and a where / select / orderBy (also under AND / OR / NOT and in an array) or a comment, string or property read as no write', () => {
    const writes = [
      'tx.user.update({ where: { id }, data: { sessionsValidAfter: new Date() } })',
      'tx.user.update({ where: { id }, data: { sessionsValidAfter: at } })',
      'tx.user.update({ where: { id }, data: { sessionsValidAfter: null } })',
      'tx.user.updateMany({ data: { sessionsValidAfter: { set: at } }, where: { id: { in: ids } } })',
      'tx.user.update({ where: { id }, data: { name, sessionsValidAfter } })',
      'tx.user.update({ where: { id }, data: { sessionsValidAfter, name } })',
      'tx.user.create({ data: { name, sessionsValidAfter: at } })',
      'tx.user.upsert({ where: { id }, create: { sessionsValidAfter: at }, update: {} })',
      'tx.user.upsert({ where: { id }, create: {}, update: { sessionsValidAfter: at } })',
      'const data = { sessionsValidAfter: at }; await tx.user.update({ where: { id }, data })',
      'row.sessionsValidAfter = at',
      'await tx.$executeRaw`UPDATE "User" SET "sessionsValidAfter" = now() WHERE id = ${id}`',
      'await prisma.$executeRawUnsafe(\'UPDATE "User" SET "sessionsValidAfter" = now()\')',
    ];
    const noWrites = [
      'prisma.user.findMany({ where: { sessionsValidAfter: { not: null } } })',
      'prisma.user.findMany({ where: { AND: [{ id }, { sessionsValidAfter: { lt: at } }] } })',
      'prisma.user.findMany({ where: { OR: [{ id }, { NOT: { sessionsValidAfter: null } }] } })',
      'prisma.user.findFirst({ where: { id }, select: { id: true, sessionsValidAfter: true } })',
      'prisma.user.findMany({ orderBy: { sessionsValidAfter: \'desc\' } })',
      'if (session.signedInAt < user.sessionsValidAfter.getTime()) return',
      'const same = a.sessionsValidAfter === b.sessionsValidAfter',
      'const { sessionsValidAfter } = user',
      "// data: { sessionsValidAfter: now } in a comment\nconst x = 1",
      '/* data: { sessionsValidAfter: new Date() } */ const y = 2',
      "const text = 'data: { sessionsValidAfter: now }'",
    ];
    for (const code of writes) assert(writesSessionsValidAfter(code), `not read as a write: ${code}`);
    for (const code of noWrites) assert(!writesSessionsValidAfter(code), `read as a write: ${code}`);
  });

  await check('E11 no log line or Sentry capture of the run holds an endpoint', () => {
    const leaks = everyLog.filter(l => l.includes('fcm.googleapis.com') || l.includes('smoke-w') || l.includes('smoke-p'));
    assert(leaks.length === 0, `log leaks ${show(leaks)}`);
    assert(!everyCapture.some(c => show(c).includes('fcm.googleapis.com')), 'a capture holds an endpoint');
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
