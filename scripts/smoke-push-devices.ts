// Smoke test for the browser notifications' device store (spec docs/superpowers/specs/2026-11-05-web-push-design.md §3.1,
// §3.9; plan 6c-2 Task 1): src/services/web-push/config.ts and devices.ts, the PushDevice table and its migration.
//
// What it pins:
//   - config: push is on only with both VAPID variables set (blank is unset), the public key read at call time, the
//     contact claim is FamCal's own address, and the push services a device may point at;
//   - isValidDeviceInput: an https endpoint of a known push service (no port, no user info, at most 1024 characters),
//     p256dh 80-100 and auth 16-32 base64url characters; anything else is refused;
//   - addDevice: one row per endpoint; the same browser again keeps one row (new keys, a new turn-on time); an endpoint
//     another account holds moves to this one; an 11th device removes the oldest; every account touched is re-synced
//     in the event alert cache;
//   - isOwnDevice / deleteOwnDevice: only the caller's own row; deleteDevicesOf: one account or several, keeping the
//     endpoint named, inside a caller's transaction without a re-sync (the caller does it after the commit), and no
//     query for no account; devicesForSend: the four fields; deleteGoneDevice: deletes and re-syncs, never throws;
//   - afterDevicesChanged never throws: a failure is logged and reported by its kind only;
//   - no console line or Sentry field holds an endpoint or a key;
//   - the fence: only devices.ts reads or writes PushDevice rows; the schema's model and relation; the hand-written
//     migration (additions only, safe to run twice); the generated client knows the model.
//
// Real: devices.ts, config.ts, user-service.ts (getUserById), reminder-cache.ts (its Redis is the fake). Faked at the
// boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, error capture. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   $RUN smoke-push-devices

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import {
  assert, baseUser, captured, check, DB, everyCapture, everyLog, fakePrisma, installSigninWorld, load, logs, prismaCalls,
  report, resetWorld, ROOT, show, type Row,
} from './lib/signin-world';

const MIGRATION = '20261106000000_push_devices';
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DAY = 86_400_000;

const key65 = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url'); // 87 characters
};
const auth16 = () => crypto.randomBytes(16).toString('base64url'); // 22 characters
const FCM = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ';
const APPLE = 'https://web.push.apple.com/QGuQyavXutnMH7Yfc6PB9mxXzqrBm2rWvzGJ7oM8hGfTxwvW-5rNjzQZq0G9IBbx';
const MOZILLA = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABnYtEXAMPLEpushtoken_abc';
const WNS = 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAABexampleWnsToken%2bAbc%3d';
const P256DH = key65();
const AUTH = auth16();
const input = (endpoint: string, p256dh = P256DH, auth = AUTH) => ({ endpoint, keys: { p256dh, auth } });

/** Every endpoint and key of the run: none may reach a log line or a Sentry field. */
const SECRETS: string[] = [FCM, APPLE, MOZILLA, WNS, 'dQw4w9WgXcQ', 'QGuQyavXutnMH7', 'gAAAAABnYtEXAMPLE', 'BQYAAABexample', P256DH, AUTH];

/** The event alert cache re-syncs of a user: reminder-cache's own lines (an update, or a removal for one it doesn't admit). */
const syncsOf = (id: number) => logs.filter(l => l === `[Reminder Cache] Updated user ${id} in cache` || l === `[Reminder Cache] Removed user ${id} from cache`).length;

/** Every .ts/.tsx file under src/, app/ and components/, relative to the repo. */
function codeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const root of ['src', 'app', 'components']) walk(root);
  return out.sort();
}

function seed(): void {
  resetWorld();
  // 5: a web account with no chat; 6: another one; 8: a Telegram account with alerts on (the cache admits it)
  DB.user = [
    baseUser({ id: 5, name: 'Five', messagingPlatform: 'telegram' }),
    baseUser({ id: 6, name: 'Six' }),
    baseUser({ id: 8, name: 'Eight', telegramId: BigInt(5550008), remindersEnabled: true }),
  ];
  DB.pushDevice = [];
}
const rowsOf = (userId: number) => (DB.pushDevice ?? []).filter(r => r.userId === userId);

async function main() {
  await installSigninWorld();
  const config = await load('src/services/web-push/config.ts').catch(() => ({} as Row));
  const devices = await load('src/services/web-push/devices.ts').catch(() => ({} as Row));

  await check('D1 config: push is on only with both VAPID keys set (blank or spaces is unset), the keys trimmed and read at call time; the contact claim is mailto:privacy@famcal.bot; PUSH_ENV is the two names', () => {
    const both = { VAPID_PUBLIC_KEY: ' pub-key ', VAPID_PRIVATE_KEY: 'priv-key' };
    assert(show(config.PUSH_ENV) === show(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']), `PUSH_ENV ${show(config.PUSH_ENV)}`);
    const cases: [string, Row, string[]][] = [
      ['both', both, []],
      ['none', {}, ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']],
      ['blank public', { ...both, VAPID_PUBLIC_KEY: '   ' }, ['VAPID_PUBLIC_KEY']],
      ['empty private', { ...both, VAPID_PRIVATE_KEY: '' }, ['VAPID_PRIVATE_KEY']],
    ];
    for (const [label, env, missing] of cases) {
      assert(show(config.missingPushEnv(env)) === show(missing), `${label}: missing ${show(config.missingPushEnv(env))}`);
      assert(config.pushConfigured(env) === (missing.length === 0), `${label}: pushConfigured`);
      assert(config.vapidPublicKey(env) === (missing.length === 0 ? 'pub-key' : null), `${label}: vapidPublicKey ${show(config.vapidPublicKey(env))}`);
      assert(show(config.vapidKeys(env)) === show(missing.length === 0 ? { publicKey: 'pub-key', privateKey: 'priv-key' } : null), `${label}: vapidKeys`);
    }
    // The default is process.env, read at the call
    const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
    process.env.VAPID_PUBLIC_KEY = 'later-pub';
    process.env.VAPID_PRIVATE_KEY = 'later-priv';
    assert(config.vapidPublicKey() === 'later-pub', 'process.env is read at the call');
    delete process.env.VAPID_PRIVATE_KEY;
    assert(config.pushConfigured() === false, 'off once a key is gone');
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
    assert(config.vapidSubject() === 'mailto:privacy@famcal.bot', `subject ${config.vapidSubject()}`);
    assert(!/process\.env\.NEXT_PUBLIC_VAPID/.test(read('src/services/web-push/config.ts')), 'a NEXT_PUBLIC_ key');
  });

  await check('D2 isValidDeviceInput: an https endpoint of Google\'s, Apple\'s, Mozilla\'s or Microsoft\'s push service with base64url keys of the right lengths; any other host (a lookalike too), http, a port, user info, an endpoint over 1024 characters, a key too short, too long or not base64url, or any other shape is refused', () => {
    const good = [input(FCM), input(APPLE), input(MOZILLA), input(WNS), input(FCM, `${P256DH}=`, `${AUTH}==`)];
    for (const x of good) assert(devices.isValidDeviceInput(x) === true, `refused ${show(x)}`);
    const bad: [string, unknown][] = [
      ['null', null], ['a string', FCM], ['no keys', { endpoint: FCM }], ['keys not an object', { endpoint: FCM, keys: 'x' }],
      ['a number endpoint', { endpoint: 5, keys: { p256dh: P256DH, auth: AUTH } }],
      ['not a URL', input('fcm send')], ['http', input(FCM.replace('https:', 'http:'))],
      ['another host', input('https://example.test/fcm/send/abc')], ['a lookalike', input('https://fcm.googleapis.com.example.test/fcm/send/abc')],
      ['a name that ends like it', input('https://evilfcm.googleapis.com/fcm/send/abc')], ['a port', input('https://fcm.googleapis.com:8443/fcm/send/abc')],
      ['user info', input('https://user:pw@fcm.googleapis.com/fcm/send/abc')], ['over 1024', input(`${FCM}/${'a'.repeat(1000)}`)],
      ['p256dh short', input(FCM, 'abc')], ['p256dh long', input(FCM, `${P256DH}${'A'.repeat(20)}`)], ['p256dh not base64url', input(FCM, `${P256DH.slice(0, 80)}+/+/+/+`)],
      ['auth short', input(FCM, P256DH, 'abcdefghij')], ['auth long', input(FCM, P256DH, 'a'.repeat(40))], ['auth a number', { endpoint: FCM, keys: { p256dh: P256DH, auth: 7 } }],
    ];
    for (const [label, x] of bad) assert(devices.isValidDeviceInput(x) === false, `accepted ${label}`);
    assert(config.isPushServiceUrl(new URL(APPLE)) === true && config.isPushServiceUrl(new URL('https://push.apple.com.example.test/x')) === false, 'isPushServiceUrl');
    // isValidEndpoint is the endpoint half of the same rule (Remove a way reads it alone)
    for (const ok of [FCM, APPLE, MOZILLA, WNS]) assert(devices.isValidEndpoint(ok) === true, `isValidEndpoint refused ${ok.slice(0, 30)}`);
    for (const no of [5, null, 'fcm send', FCM.replace('https:', 'http:'), 'https://example.test/x', `${FCM}/${'a'.repeat(1000)}`]) assert(devices.isValidEndpoint(no) === false, `isValidEndpoint accepted ${show(no).slice(0, 30)}`);
  });

  await check('D3 addDevice: a new endpoint is one row (1 of 10); the same browser again keeps one row with its new keys and a new turn-on time; another account\'s endpoint moves (moved, both accounts re-synced); an 11th device removes the oldest and no other account\'s; one log line each, with ids and counts only', async () => {
    seed();
    const first = await devices.addDevice(5, input(FCM));
    assert(show(first) === show({ moved: false, count: 1 }) && rowsOf(5).length === 1, `first ${show(first)} ${show(rowsOf(5))}`);
    assert(rowsOf(5)[0].endpoint === FCM && rowsOf(5)[0].p256dh === P256DH && rowsOf(5)[0].auth === AUTH, 'the row holds the endpoint and keys');
    assert(syncsOf(5) === 1, `user 5 re-synced ${syncsOf(5)} times`);
    assert(logs.includes('[push-devices] user 5: a device turned on (1 of 10)'), `log ${show(logs)}`);
    // The same browser again: new keys, one row, a later turn-on time
    rowsOf(5)[0].createdAt = new Date(Date.now() - 3 * DAY);
    const newKey = key65();
    const again = await devices.addDevice(5, input(FCM, newKey));
    assert(show(again) === show({ moved: false, count: 1 }) && rowsOf(5).length === 1 && rowsOf(5)[0].p256dh === newKey, `again ${show(again)}`);
    assert(Date.now() - rowsOf(5)[0].createdAt.getTime() < 60_000, 'the turn-on time is now');
    // Another account turns the same browser on: the row moves
    logs.length = 0;
    const moved = await devices.addDevice(6, input(FCM));
    assert(show(moved) === show({ moved: true, count: 1 }) && rowsOf(5).length === 0 && rowsOf(6).length === 1, `moved ${show(moved)} ${show(DB.pushDevice)}`);
    assert(syncsOf(5) === 1 && syncsOf(6) === 1, `both re-synced: 5 ${syncsOf(5)}, 6 ${syncsOf(6)}`);
    assert(logs.includes('[push-devices] user 6: a device turned on (1 of 10), moved from user 5'), `log ${show(logs)}`);
    // Ten devices of user 5, then an 11th: the oldest goes, user 6's stays
    seed();
    DB.pushDevice = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, userId: 5, endpoint: `${APPLE}${i}`, p256dh: P256DH, auth: AUTH, createdAt: new Date(Date.now() - (20 - i) * DAY) }));
    DB.pushDevice.push({ id: 'other', userId: 6, endpoint: MOZILLA, p256dh: P256DH, auth: AUTH, createdAt: new Date(Date.now() - 30 * DAY) });
    const eleventh = await devices.addDevice(5, input(FCM));
    assert(show(eleventh) === show({ moved: false, count: 10 }) && rowsOf(5).length === 10, `eleventh ${show(eleventh)}`);
    assert(!rowsOf(5).some(r => r.id === 'd0') && rowsOf(5).some(r => r.endpoint === FCM) && rowsOf(6).length === 1, `the oldest (d0) should go: ${show(rowsOf(5).map(r => r.id))}`);
    assert(logs.includes('[push-devices] user 5: a device turned on (10 of 10); the oldest 1 removed'), `log ${show(logs)}`);
  });

  await check('D4 isOwnDevice and deleteOwnDevice: only the caller\'s own row; another account\'s endpoint and an unknown one are "not mine" alike and stay; a delete re-syncs', async () => {
    seed();
    DB.pushDevice = [
      { id: 'a', userId: 5, endpoint: FCM, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
      { id: 'b', userId: 6, endpoint: APPLE, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
    ];
    assert(await devices.isOwnDevice(5, FCM) === true, 'own');
    assert(await devices.isOwnDevice(5, APPLE) === false && await devices.isOwnDevice(5, MOZILLA) === false, 'another\'s and unknown');
    assert(await devices.deleteOwnDevice(5, APPLE) === false && DB.pushDevice.length === 2 && syncsOf(6) === 0, 'another account\'s device is not deleted');
    assert(await devices.deleteOwnDevice(5, FCM) === true && rowsOf(5).length === 0 && syncsOf(5) === 1, 'own deleted and re-synced');
    assert(await devices.deleteOwnDevice(5, FCM) === false, 'twice: nothing left');
  });

  await check('D5 deleteDevicesOf: one account or several, all their rows; keep spares that endpoint; inside a caller\'s transaction it re-syncs nothing (the caller does, after the commit); outside it re-syncs each; no account asks nothing', async () => {
    seed();
    const put = () => {
      DB.pushDevice = [
        { id: 'a', userId: 5, endpoint: FCM, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
        { id: 'b', userId: 5, endpoint: APPLE, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
        { id: 'c', userId: 6, endpoint: MOZILLA, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
        { id: 'd', userId: 8, endpoint: WNS, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
      ];
    };
    put();
    assert(await devices.deleteDevicesOf(5, { keep: APPLE }) === 1 && show(DB.pushDevice.map((r: Row) => r.id)) === show(['b', 'c', 'd']), `keep ${show(DB.pushDevice)}`);
    assert(syncsOf(5) === 1, 'outside a transaction: re-synced');
    put();
    logs.length = 0;
    const inTx = await fakePrisma.$transaction(async (tx: Row) => devices.deleteDevicesOf([5, 6], { tx }));
    assert(inTx === 3 && show(DB.pushDevice.map((r: Row) => r.id)) === show(['d']), `in a transaction ${inTx} ${show(DB.pushDevice)}`);
    assert(syncsOf(5) === 0 && syncsOf(6) === 0, 'inside a transaction: the caller re-syncs');
    put();
    assert(await devices.deleteDevicesOf([5, 6, 5], { keep: null }) === 3 && syncsOf(5) === 1 && syncsOf(6) === 1, 'several, each re-synced once');
    prismaCalls.length = 0;
    assert(await devices.deleteDevicesOf([]) === 0 && !prismaCalls.some(c => c.startsWith('pushDevice.')), `no account: ${show(prismaCalls)}`);
  });

  await check('D6 devicesForSend gives the four fields of the account\'s rows, oldest first; deleteGoneDevice deletes the row and re-syncs its account; a row already gone is a log line, never a throw', async () => {
    seed();
    DB.pushDevice = [
      { id: 'new', userId: 5, endpoint: APPLE, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
      { id: 'old', userId: 5, endpoint: FCM, p256dh: P256DH, auth: AUTH, createdAt: new Date(Date.now() - DAY) },
      { id: 'his', userId: 6, endpoint: MOZILLA, p256dh: P256DH, auth: AUTH, createdAt: new Date() },
    ];
    const got = await devices.devicesForSend(5);
    assert(show(got) === show([{ id: 'old', endpoint: FCM, p256dh: P256DH, auth: AUTH }, { id: 'new', endpoint: APPLE, p256dh: P256DH, auth: AUTH }]), `devicesForSend ${show(got)}`);
    await devices.deleteGoneDevice('old');
    assert(rowsOf(5).length === 1 && syncsOf(5) === 1, `gone ${show(rowsOf(5))}`);
    await devices.deleteGoneDevice('old');
    assert(logs.includes('[push-devices] device old was already gone') && captured.length === 0, `already gone: ${show(logs)} ${show(captured)}`);
  });

  await check('D7 afterDevicesChanged never throws: a failed account read is logged and reported by its kind only (no endpoint, even when the error\'s message holds one), and a change still answers', async () => {
    seed();
    DB.pushDevice = [{ id: 'a', userId: 5, endpoint: FCM, p256dh: P256DH, auth: AUTH, createdAt: new Date() }];
    const users = fakePrisma.user as Row;
    const real = users.findUnique;
    users.findUnique = async () => { throw Object.assign(new Error(`Invalid \`prisma.user.findUnique()\` invocation near ${FCM}`), { name: 'PrismaClientValidationError' }); };
    try {
      assert(await devices.deleteOwnDevice(5, FCM) === true, 'the delete still answers');
    } finally {
      users.findUnique = real;
    }
    assert(logs.some(l => l.startsWith('[push-devices] user 5: the alert cache entry was not synced: PrismaClientValidationError')), `log ${show(logs)}`);
    assert(captured.some(c => c.context === 'push-devices' && c.extra.user_id === 5), `captured ${show(captured)}`);
    await devices.afterDevicesChanged([404]);
    assert(logs.includes('[push-devices] user 404: no account, no alert cache entry to sync'), `a missing account: ${show(logs)}`);
  });

  await check('D8 no console line or Sentry field of the run holds an endpoint, a push service token or a key', () => {
    const text = show(everyLog) + show(everyCapture);
    const found = SECRETS.filter(s => text.includes(s));
    assert(found.length === 0, `leaked: ${found.map(s => s.slice(0, 24)).join(', ')}`);
  });

  await check('D9 the fence and the data: only src/services/web-push/devices.ts reads or writes PushDevice rows (no other .pushDevice and no raw "PushDevice"); the schema has the model and User.pushDevices; the migration makes the table, its unique endpoint, its user index and its cascading key, only adds, and is safe to run twice; the generated client knows the model', () => {
    const ALLOWED = 'src/services/web-push/devices.ts';
    const touching = codeFiles().filter(rel => /\.pushDevice\b/.test(read(rel)) || /"PushDevice"/.test(read(rel)));
    assert(touching.includes(ALLOWED), `devices.ts touches no PushDevice row (found ${show(touching)})`);
    const stray = touching.filter(rel => rel !== ALLOWED);
    assert(stray.length === 0, `PushDevice rows touched outside devices.ts: ${show(stray)}`);
    const schema = read('prisma/schema.prisma');
    const model = /model PushDevice \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    const lines = model.split('\n').map(l => l.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ')).filter(Boolean);
    for (const want of [
      'id String @id @default(cuid())', 'userId Int', 'user User @relation(fields: [userId], references: [id], onDelete: Cascade)',
      'endpoint String @unique', 'p256dh String', 'auth String', 'createdAt DateTime @default(now())', '@@index([userId])',
    ]) assert(lines.includes(want), `PushDevice lacks "${want}": ${show(lines)}`);
    const user = /model User \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    assert(/^\s*pushDevices\s+PushDevice\[\]\s*$/m.test(user), 'User has no pushDevices PushDevice[]');
    const file = path.join(ROOT, 'prisma/migrations', MIGRATION, 'migration.sql');
    assert(fs.existsSync(file), `no prisma/migrations/${MIGRATION}/migration.sql`);
    const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join(' ').replace(/\s+/g, ' ').trim();
    for (const want of [
      'CREATE TABLE IF NOT EXISTS "PushDevice" ( "id" TEXT NOT NULL, "userId" INTEGER NOT NULL, "endpoint" TEXT NOT NULL, "p256dh" TEXT NOT NULL, "auth" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id") );',
      'CREATE UNIQUE INDEX IF NOT EXISTS "PushDevice_endpoint_key" ON "PushDevice"("endpoint");',
      'CREATE INDEX IF NOT EXISTS "PushDevice_userId_idx" ON "PushDevice"("userId");',
      'DO $$ BEGIN ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;',
    ]) assert(sql.includes(want), `the migration lacks: ${want}`);
    assert(!/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i.test(sql.replace(/ON (DELETE|UPDATE) CASCADE/g, '')), `the migration does more than add: ${sql}`);
    const fields = Object.values((Prisma as unknown as Record<string, Record<string, string> | undefined>).PushDeviceScalarFieldEnum ?? {});
    assert(show(fields) === show(['id', 'userId', 'endpoint', 'p256dh', 'auth', 'createdAt']), `the generated client's PushDevice: ${show(fields)} (run npx prisma generate)`);
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
