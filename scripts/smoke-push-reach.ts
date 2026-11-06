// Smoke test for the one reach rule of reminders and alerts (6c-2 spec §2.3, §3.5; plan Task 7): canReachByPush and
// reachableForReminders, the device count riding in the reads already there (getUserById, the partner summary, the
// admin profile), isPingable, and a fence that no reminder gate reads a bare Telegram id any more.
//
// Real: reach.ts, user-service, types, ownership, the admin user-overrides route. Faked at the boundaries
// (scripts/lib/signin-world.ts): Prisma (with _count) and Redis in memory, error capture, the chats, fetch. No network,
// no DB. The VAPID keys are a pair made here (web-push's generateVAPIDKeys), never real ones.
//
// Run with the fake env of scripts/ci-smokes.sh: $RUN smoke-push-reach

import fs from 'fs';
import path from 'path';
import webpush from 'web-push';
import {
  assert, baseUser, body, check, DAY, DB, initDataFor, installSigninWorld, load, report, request, resetWorld, ROOT, show, type Row,
} from './lib/signin-world';

const VAPID = webpush.generateVAPIDKeys();
const pushOn = () => { process.env.VAPID_PUBLIC_KEY = VAPID.publicKey; process.env.VAPID_PRIVATE_KEY = VAPID.privateKey; };
const pushOff = () => { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; };

const ADMIN = 1;
const ADMIN_TG = 111111111;
const W = 50; // no chat, two devices
const V = 51; // no chat, no device
const T = 60; // Telegram
const T_TG = 600000060;
const A = 70; // WhatsApp only, with a device row (a race; WhatsApp alone reaches nobody here)

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const device = (id: string, userId: number): Row => ({
  id, userId, endpoint: `https://fcm.googleapis.com/fcm/send/smoke-${id}`, p256dh: 'B'.repeat(87), auth: 'A'.repeat(22), createdAt: new Date(Date.now() - DAY),
});

function seed(): void {
  resetWorld();
  pushOn();
  DB.user = [
    baseUser({ id: ADMIN, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }),
    baseUser({ id: W, name: 'Wren', pairingId: 'pair-tw' }),
    baseUser({ id: V, name: 'Vera' }),
    baseUser({ id: T, name: 'Tom', telegramId: BigInt(T_TG), pairingId: 'pair-tw' }),
    baseUser({ id: A, name: 'Ava', whatsappPhone: '+972500000070', messagingPlatform: 'whatsapp' }),
  ];
  DB.pairing = [{ id: 'pair-tw', status: 'ACTIVE', inviterUserId: T, inviteeUserId: W, acceptedAt: new Date(), unlinkedAt: null, unlinkedByUserId: null, createdAt: new Date() }];
  DB.pushDevice = [device('w-1', W), device('w-2', W), device('a-1', A)];
  const now = new Date();
  DB.subscription = [W, V, T, A].map((userId, i) => ({
    id: i + 1, userId, plan: 'FREE', status: 'TRIALING', trialStartedAt: new Date(now.getTime() - DAY), trialEndsAt: new Date(now.getTime() + 13 * DAY),
    currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, compedBy: null, compedAt: null, compReason: null, telegramPaymentChargeId: null,
    createdAt: now, updatedAt: now,
  }));
  DB.usageCounter = [W, V, T, A].map((userId, i) => ({
    id: i + 1, userId, textSummariesUsed: 0, voiceSummariesUsed: 0, voiceEventsCreated: 0, remindersTriggered: 0, cycleStartDate: now, updatedAt: now,
  }));
}

async function main() {
  await installSigninWorld();
  const reach = await load('src/services/web-push/reach.ts');
  const { getUserById } = await load('src/services/user-service.ts');
  const { convertPrismaUserToConfig } = await load('src/types.ts');
  const { getActivePartnerSummary, isPingable } = await load('src/services/native-reminders/ownership.ts');
  const overridesRoute = await load('app/api/admin/user-overrides/route.ts');

  await check('R1 canReachByPush: no chat and a device, with browser notifications configured; never with Telegram or WhatsApp, with no device, or with push off; a cached entry\'s empty Telegram id is none', () => {
    seed();
    const cases: [string, Row, boolean][] = [
      ['no chat, 1 device', { telegramId: null, pushDeviceCount: 1 }, true],
      ['no chat (undefined ids), 2 devices', { telegramId: undefined, whatsappPhone: undefined, whatsappBsuid: undefined, pushDeviceCount: 2 }, true],
      ['a cached entry: telegramId \'\'', { telegramId: '', pushDeviceCount: 1 }, true],
      ['no chat, no device', { telegramId: null, pushDeviceCount: 0 }, false],
      ['Telegram and a device', { telegramId: BigInt(5), pushDeviceCount: 1 }, false],
      ['Telegram as a string', { telegramId: '5', pushDeviceCount: 1 }, false],
      ['WhatsApp phone and a device', { telegramId: null, whatsappPhone: '+972500000070', pushDeviceCount: 1 }, false],
      ['WhatsApp BSUID and a device', { telegramId: null, whatsappBsuid: 'IL.1', pushDeviceCount: 1 }, false],
    ];
    for (const [label, user, want] of cases) assert(reach.canReachByPush(user) === want, `${label}: ${!want}`);
    pushOff();
    assert(reach.canReachByPush({ telegramId: null, pushDeviceCount: 3 }) === false, 'push off: no VAPID keys');
    process.env.VAPID_PUBLIC_KEY = VAPID.publicKey;
    assert(reach.canReachByPush({ telegramId: null, pushDeviceCount: 3 }) === false, 'push off: only the public key');
    pushOn();
  });

  await check('R2 reachableForReminders: Telegram as before (any id type, \'\' is none), or a push device with no chat; WhatsApp alone and no channel are not; pushDeviceCountOf reads a row\'s _count and nothing else', () => {
    seed();
    const yes: Row[] = [{ telegramId: 5 }, { telegramId: BigInt(5) }, { telegramId: '5' }, { telegramId: 5, pushDeviceCount: 0 }, { telegramId: null, pushDeviceCount: 1 }];
    const no: Row[] = [{ telegramId: null }, { telegramId: '' }, {}, { telegramId: null, whatsappPhone: '+972500000070', pushDeviceCount: 1 }, { telegramId: null, pushDeviceCount: 0 }];
    for (const u of yes) assert(reach.reachableForReminders(u) === true, `should reach ${show(u)}`);
    for (const u of no) assert(reach.reachableForReminders(u) === false, `should not reach ${show(u)}`);
    pushOff();
    assert(reach.reachableForReminders({ telegramId: null, pushDeviceCount: 1 }) === false && reach.reachableForReminders({ telegramId: 5 }) === true, 'push off');
    pushOn();
    const counts: [unknown, number][] = [[{ _count: { pushDevices: 3 } }, 3], [{ _count: { pushDevices: 0 } }, 0], [{ _count: {} }, 0], [{}, 0], [null, 0], [undefined, 0], [{ _count: { pushDevices: -1 } }, 0]];
    for (const [row, n] of counts) assert(reach.pushDeviceCountOf(row) === n, `pushDeviceCountOf(${show(row)})`);
    assert(show(reach.PUSH_DEVICE_COUNT) === show({ _count: { select: { pushDevices: true } } }), 'PUSH_DEVICE_COUNT');
  });

  await check('R3 getUserById carries the device count in its one read (PUSH_DEVICE_COUNT), and the config holds no _count; a row read without the count leaves pushDeviceCount unset', async () => {
    seed();
    const w = await getUserById(W);
    const v = await getUserById(V);
    assert(w.pushDeviceCount === 2 && !('_count' in w), `W ${show({ count: w.pushDeviceCount, keys: Object.keys(w).filter(k => k.startsWith('_')) })}`);
    assert(v.pushDeviceCount === 0, `V ${show(v.pushDeviceCount)}`);
    const plain = convertPrismaUserToConfig(DB.user.find(u => u.id === T));
    assert(!('pushDeviceCount' in plain) && !('_count' in plain), `a row without the count: ${show(Object.keys(plain).filter(k => /count/i.test(k)))}`);
  });

  await check('R4 the partner summary carries the partner\'s WhatsApp ids and device count, with no _count', async () => {
    seed();
    const p = await getActivePartnerSummary(T, 'pair-tw');
    assert(p?.id === W && p.pushDeviceCount === 2 && p.whatsappPhone === null && p.whatsappBsuid === null && !('_count' in p), `summary ${show(p)}`);
    const q = await getActivePartnerSummary(W, 'pair-tw');
    assert(q?.id === T && q.pushDeviceCount === 0 && String(q.telegramId) === String(T_TG), `summary ${show(q)}`);
  });

  await check('R5 isPingable: Telegram as before (suspended or unreachable is not); a push device with no chat is; no device, WhatsApp alone, or push off is not', () => {
    seed();
    assert(isPingable({ telegramId: BigInt(5) }) && !isPingable({ telegramId: BigInt(5), suspendedAt: new Date() }) && !isPingable({ telegramId: BigInt(5), unreachableSince: new Date() }), 'Telegram');
    assert(isPingable({ telegramId: null, pushDeviceCount: 1 }) && !isPingable({ telegramId: null, pushDeviceCount: 1, suspendedAt: new Date() }), 'push');
    assert(!isPingable({ telegramId: null, pushDeviceCount: 0 }) && !isPingable({ telegramId: null }) && !isPingable({ telegramId: null, whatsappPhone: '+972500000070', pushDeviceCount: 1 }), 'no channel');
    pushOff();
    assert(!isPingable({ telegramId: null, pushDeviceCount: 1 }), 'push off');
    pushOn();
  });

  await check('R6 the admin profile says whom reminders can reach (remindable): Telegram, or no chat with a device; not with none, not WhatsApp alone', async () => {
    seed();
    const get = async (id: number) => {
      const res = await overridesRoute.GET(request(`/api/admin/user-overrides?user_id=${id}`, { initData: initDataFor(ADMIN_TG) }));
      const answer = await body(res);
      assert(res.status === 200, `${id}: ${res.status} ${show(answer)}`);
      return answer.user as Row;
    };
    const got = { w: (await get(W)).remindable, v: (await get(V)).remindable, t: (await get(T)).remindable, a: (await get(A)).remindable };
    assert(show(got) === show({ w: true, v: false, t: true, a: false }), `remindable ${show(got)}`);
    assert(!show(await get(W)).includes('fcm.googleapis.com'), 'the profile carries an endpoint');
  });

  await check('R7 [fence] no reminder or alert gate reads a bare Telegram id: each goes through reachableForReminders, and each read that feeds one carries PUSH_DEVICE_COUNT', () => {
    const support = read('src/services/native-reminders/support.ts');
    assert(!/function hasTelegram\(/.test(support) && (support.match(/reachableForReminders\(/g) ?? []).length >= 2 && /'no_channel'/.test(support) && !/'no_telegram'/.test(support), 'support.ts');
    const ownership = read('src/services/native-reminders/ownership.ts');
    assert(/isPingable = \(user: Pingable\): boolean =>\s*reachableForReminders\(user\)/.test(ownership) && /\.\.\.PUSH_DEVICE_COUNT/.test(ownership), 'ownership.ts');
    assert(!/partner\.telegramId === null/.test(read('src/services/native-reminders/resolve.ts')), 'resolve.ts targetFor');
    assert(!/partner\.telegramId === null/.test(read('src/services/native-calendar/event-store.ts')), 'event-store.ts');
    const info = read('src/services/calendar-write/item-info.ts');
    assert(!/user\.telegramId === null \|\|/.test(info) && !/ctx\.partner\.telegramId !== null/.test(info) && (info.match(/reachableForReminders\(/g) ?? []).length >= 2, 'item-info.ts');
    assert((read('src/services/native-reminders/actions.ts').match(/\.\.\.PUSH_DEVICE_COUNT/g) ?? []).length >= 2, 'actions.ts: the reachable read and notifyDone\'s');
    assert(/include: PUSH_DEVICE_COUNT/.test(read('src/services/user-service.ts')), 'user-service.ts getUserById');
    const access = read('app/[locale]/(app)/admin-panel/views/profile/FeatureAccess.tsx');
    assert(!/person\.telegramId !== null/.test(access) && /shown: person\.remindable/.test(access), 'FeatureAccess.tsx');
  });

  pushOff();
  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
