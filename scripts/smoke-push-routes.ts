// Smoke test for the notification-device routes and the `push` page prop (web push spec 2026-11-05 §3.2; plan 6c-2 Task 3):
// POST/DELETE /api/push/devices, POST /api/push/devices/check, and src/services/web-push/page-props.ts.
//
// What it pins:
//   - subscribe: a new endpoint needs a sign-in from the last hour (403 stale-sign-in, nothing stored); an endpoint the
//     account already has does not; one another account holds moves here (with the hour) and leaves the other account
//     without it; an account with a chat (Telegram, WhatsApp) is refused 409 has-chat; a bad body is 400 and stores
//     nothing; only the three fields are handed on; a stored device is followed, after the answer, by one "Notifications
//     are on" notification in the account's language (kind 'test', the home's absolute URL), and a failed send is captured
//     without touching the answer;
//   - the front of all three routes: another origin or a body that is not JSON is refused first, no cookie is 401, a
//     Telegram initData request is 401 (a Mini App is refused), push off (no VAPID keys) is 503 for subscribe and check
//     while an unsubscribe still works, and the 21st request of an account's minute is 429 under the push limiter keyed by
//     the proved account;
//   - check: true only for an endpoint this account holds; another account's endpoint and an unknown one get the same
//     answer byte for byte; it asks for no recent sign-in;
//   - unsubscribe: removes only the caller's own device, answers the same for another account's endpoint and for none, and
//     asks for no recent sign-in;
//   - no log line, capture or answer holds an endpoint or a key (a store that fails with the endpoint in its message is
//     captured by its kind only);
//   - the `push` prop: null for Telegram's initData and for an account with a chat; for a no-chat session its key (null while
//     push is off, and then no devices are counted), whether the sign-in is within the hour, and its device count; a failed
//     count is captured and reads as none;
//   - wiring: page-data hands both props the session's proved-at, the page-data route passes it, SettingsClient takes
//     the prop, the limiter is 20 a minute, bot.push is in en, he and ru with no emoji.
//
// Real: the three routes, request.ts, page-props.ts, verifyUserAuth, the session cookie, the helper for the hour
// (recent-sign-in.ts), config.ts, bot-messages and the messages files. Faked at the boundaries (scripts/lib/signin-world.ts):
// Prisma and Redis in memory, the rate limiter (this smoke's own, which records and can refuse), error capture, Next's
// after(). Stood in for, because they are other tasks' modules: devices.ts (an in-memory store with the contract's
// signatures and a validator that follows the contract) and send.ts (records the notifications). No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh (the plan's $RUN runner):
//   $RUN smoke-push-routes

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import {
  assert, baseUser, body, check, DB, drainAfter, everyCapture, everyLog, initDataFor, installSigninWorld, load, report,
  request, resetWorld, ROOT, sessionCookie, show, stubModule, type Row,
} from './lib/signin-world';

const nodeRequire = createRequire(__filename);
const HOUR = 3_600_000;
const BASE = 'https://famcal.bot';

const DANA = 50; // no chat, English
const NOAM = 51; // no chat, Hebrew
const RUTH = 52; // no chat, Russian
const TAL = 9; // Telegram
const TAL_TG = 111111111;
const WANDA = 60; // WhatsApp phone
const BOAZ = 61; // WhatsApp BSUID

process.env.VAPID_PUBLIC_KEY = 'smoke-public-key-not-a-real-one';
process.env.VAPID_PRIVATE_KEY = 'smoke-private-key-not-a-real-one';

// ---- The stand-ins for Task 1's devices.ts and Task 2's send.ts ----

interface Device { userId: number; endpoint: string; p256dh: string; auth: string }
const devices: Device[] = [];
const addCalls: { userId: number; input: Row }[] = [];
let addFails: Error | null = null;
let countFails = false;
let countCalls = 0;
const sends: { userId: number; input: Row }[] = [];
let sendFails = false;
/** The limiter's calls: [limiter name, identifier], and whether the next ones are refused. */
const limiterCalls: [string, string][] = [];
let limited = false;

const B64URL = /^[A-Za-z0-9_-]+$/;
/** The contract's validator: an https endpoint of at most 1024 characters, keys base64url (p256dh 80-100, auth 16-32). */
function isValidDeviceInput(x: unknown): boolean {
  const o = x as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  return typeof o?.endpoint === 'string' && o.endpoint.startsWith('https://') && o.endpoint.length <= 1024
    && typeof o.keys?.p256dh === 'string' && B64URL.test(o.keys.p256dh) && o.keys.p256dh.length >= 80 && o.keys.p256dh.length <= 100
    && typeof o.keys.auth === 'string' && B64URL.test(o.keys.auth) && o.keys.auth.length >= 16 && o.keys.auth.length <= 32;
}

let seq = 0;
const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
const fresh = (): { endpoint: string; keys: { p256dh: string; auth: string } } => ({
  endpoint: `https://push.example.test/send/secret-endpoint-token-${++seq}`,
  keys: { p256dh: `${P256DH.slice(0, 80)}${String(seq).padStart(7, 'k')}`, auth: `${AUTH.slice(0, 16)}${String(seq).padStart(6, 'x')}` },
});
/** Every endpoint and key value this run made, so the end can check that none reached a log line or a capture. */
const secrets = new Set<string>();
const mint = () => {
  const d = fresh();
  secrets.add(d.endpoint).add(d.keys.p256dh).add(d.keys.auth);
  return d;
};

const MESSAGES: Record<string, Row> = Object.fromEntries(
  ['en', 'he', 'ru'].map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]),
);
const EMOJI = /\p{Extended_Pictographic}/u;

function seed(): void {
  resetWorld();
  devices.length = 0;
  addCalls.length = 0;
  sends.length = 0;
  limiterCalls.length = 0;
  addFails = null;
  countFails = false;
  countCalls = 0;
  sendFails = false;
  limited = false;
  process.env.VAPID_PUBLIC_KEY = 'smoke-public-key-not-a-real-one';
  process.env.VAPID_PRIVATE_KEY = 'smoke-private-key-not-a-real-one';
  DB.user = [
    baseUser({ id: DANA, name: 'Dana', language: 'en' }),
    baseUser({ id: NOAM, name: 'Noam', language: 'he' }),
    baseUser({ id: RUTH, name: 'Ruth', language: 'ru' }),
    baseUser({ id: TAL, name: 'Tal', language: 'en', telegramId: BigInt(TAL_TG) }),
    baseUser({ id: WANDA, name: 'Wanda', messagingPlatform: 'whatsapp', whatsappPhone: '+972500000060' }),
    baseUser({ id: BOAZ, name: 'Boaz', messagingPlatform: 'whatsapp', whatsappBsuid: 'IL.1234567890' }),
  ];
}

/** How many notifications went (a function, so the compiler does not narrow the array's length across the awaits). */
const sentCount = (): number => sends.length;
const own = (userId: number): string[] => devices.filter(d => d.userId === userId).map(d => d.endpoint);
const url = (userId: number, tail = '') => `/api/push/devices${tail}?user_id=${userId}`;

async function main() {
  await installSigninWorld();
  // The push limiter, as this smoke's own: records [name, identifier] and refuses on demand (the world's allows everything)
  const limiter = (name: string) => ({ name });
  stubModule('src/lib/rate-limit.ts', {
    commandRateLimiter: limiter('command'), settingsRateLimiter: limiter('settings'), generalRateLimiter: limiter('general'),
    tokenPollRateLimiter: limiter('token-poll'), calendarRateLimiter: limiter('calendar'), reminderActionRateLimiter: limiter('reminder-action'),
    calendarWriteRateLimiter: limiter('calendar-write'), pushDeviceRateLimiter: limiter('push-device'),
    checkRateLimit: async (l: { name: string }, id: string) => {
      limiterCalls.push([l.name, String(id)]);
      return { success: !limited, limit: 20, remaining: limited ? 0 : 19, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });
  stubModule('src/services/web-push/devices.ts', {
    MAX_DEVICES: 10,
    isValidDeviceInput,
    addDevice: async (userId: number, input: Row) => {
      addCalls.push({ userId, input });
      if (addFails) throw addFails;
      const held = devices.find(d => d.endpoint === input.endpoint);
      const moved = held !== undefined && held.userId !== userId;
      if (held) {
        held.userId = userId;
        held.p256dh = input.keys.p256dh;
        held.auth = input.keys.auth;
      } else {
        devices.push({ userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth });
      }
      return { moved, count: own(userId).length };
    },
    isOwnDevice: async (userId: number, endpoint: string) => devices.some(d => d.userId === userId && d.endpoint === endpoint),
    deleteOwnDevice: async (userId: number, endpoint: string) => {
      const i = devices.findIndex(d => d.userId === userId && d.endpoint === endpoint);
      if (i >= 0) devices.splice(i, 1);
      return i >= 0;
    },
    countDevices: async (userId: number) => {
      countCalls++;
      if (countFails) throw new Error('the count failed (smoke)');
      return own(userId).length;
    },
  });
  stubModule('src/services/web-push/send.ts', {
    sendWebPush: async (user: Row, input: Row) => {
      if (sendFails) throw new Error('the push service is down (smoke)');
      sends.push({ userId: user.id, input });
      return { sent: own(user.id).length, total: own(user.id).length, retriable: false };
    },
  });
  const post = await load('app/api/push/devices/route.ts');
  const checkRoute = await load('app/api/push/devices/check/route.ts');
  const { pushPropsFor } = await load('src/services/web-push/page-props.ts');
  const { NextRequest } = nodeRequire('next/server');

  const cookieOf = (userId: number, method = 'email', ageMs = 60_000) => sessionCookie(userId, method, Date.now() - ageMs);
  const subscribe = async (userId: number, d: Row, o: { cookie?: string; ageMs?: number; method?: string } = {}) =>
    post.POST(request(url(userId), { body: d, cookie: o.cookie ?? await cookieOf(userId, o.method, o.ageMs) }));
  const check_ = async (userId: number, endpoint: unknown, ageMs?: number) =>
    checkRoute.POST(request(url(userId, '/check'), { body: { endpoint }, cookie: await cookieOf(userId, 'email', ageMs) }));
  const unsubscribe = async (userId: number, endpoint: unknown, ageMs?: number) =>
    post.DELETE(request(url(userId), { method: 'DELETE', body: { endpoint }, cookie: await cookieOf(userId, 'email', ageMs) }));

  await check('subscribe: a no-chat account with a fresh session stores the device and answers { ok, count }; only the three fields are handed on, and it is one more device each time', async () => {
    seed();
    const d = mint();
    const res = await subscribe(DANA, { ...d, evil: 'x', keys: { ...d.keys, extra: 1 } });
    assert(res.status === 200 && show(await body(res)) === show({ ok: true, count: 1 }), `${res.status} ${show(await body(res))}`);
    assert(show(addCalls[0]) === show({ userId: DANA, input: { endpoint: d.endpoint, keys: { p256dh: d.keys.p256dh, auth: d.keys.auth } } }), `handed on: ${show(addCalls[0])}`);
    const second = mint();
    const again = await subscribe(DANA, second);
    assert(show(await body(again)) === show({ ok: true, count: 2 }), `second: ${show(await body(again))}`);
    assert(own(DANA).length === 2, 'two devices');
  });

  await check('subscribe: after the answer, one "Notifications are on" notification (kind test, the account\'s language, the home\'s absolute URL); nothing is sent before the answer is made', async () => {
    seed();
    for (const [id, lang, prefix] of [[DANA, 'en', '/en'], [NOAM, 'he', '/he'], [RUTH, 'ru', '/ru']] as const) {
      sends.length = 0;
      const res = await subscribe(id, mint());
      assert(res.status === 200, `${lang}: ${res.status}`);
      assert(sentCount() === 0, `${lang}: a notification went before the after() task ran`);
      await drainAfter();
      assert(sentCount() === 1, `${lang}: ${sentCount()} notifications`);
      const { userId, input } = sends[0];
      const bot = MESSAGES[lang].bot.push;
      assert(userId === id && input.kind === 'test' && input.lang === lang, `${lang}: ${show(sends[0])}`);
      assert(input.title === bot.turnedOn && input.body === bot.turnedOnBody, `${lang}: the words ${show(input)}`);
      assert(input.url === `${BASE}${prefix}/dashboard?user_id=${id}`, `${lang}: the url ${input.url}`);
      assert(typeof input.tag === 'string' && input.tag.length > 0 && input.silent === undefined, `${lang}: the tag ${show(input)}`);
      assert(typeof input.onlyEndpoint === 'string' && input.onlyEndpoint.startsWith('https://'), `${lang}: the reply goes to every device ${show(input)}`);
    }
  });

  await check('subscribe: a notification that fails to send is captured (push-turned-on, a warning) and the answer was already 200', async () => {
    seed();
    sendFails = true;
    const before = everyCapture.length;
    const res = await subscribe(DANA, mint());
    assert(res.status === 200, `${res.status}`);
    await drainAfter();
    const caught = everyCapture.slice(before);
    assert(caught.length === 1 && caught[0].context === 'push-turned-on' && caught[0].extra.user_id === DANA, `captured: ${show(caught)}`);
  });

  await check('subscribe: a new endpoint with a session proved over an hour ago is 403 stale-sign-in and nothing is stored or sent; an endpoint the account already has needs no hour (200, and no second device)', async () => {
    seed();
    const d = mint();
    const stale = await subscribe(DANA, d, { ageMs: 3 * HOUR });
    assert(stale.status === 403 && show(await body(stale)) === show({ ok: false, error: 'stale-sign-in' }), `${stale.status} ${show(await body(stale))}`);
    await drainAfter();
    assert(devices.length === 0 && addCalls.length === 0 && sends.length === 0, 'something was stored or sent');
    await subscribe(DANA, d);
    await drainAfter();
    assert(own(DANA).length === 1, 'the fresh sign-in stored it');
    const re = await subscribe(DANA, d, { ageMs: 3 * HOUR });
    assert(re.status === 200 && show(await body(re)) === show({ ok: true, count: 1 }), `re-subscribe: ${re.status} ${show(await body(re))}`);
    // Just inside the hour passes, as the helper's own edge says (smoke-recent-sign-in)
    const near = await subscribe(NOAM, mint(), { ageMs: HOUR - 60_000 });
    assert(near.status === 200, `59 minutes: ${near.status}`);
  });

  await check('subscribe: an endpoint another account holds moves here with a fresh sign-in (the other account loses it); with a stale one it is refused and the other account keeps it', async () => {
    seed();
    const d = mint();
    await subscribe(NOAM, d);
    const stale = await subscribe(DANA, d, { ageMs: 2 * HOUR });
    assert(stale.status === 403 && own(NOAM).length === 1 && own(DANA).length === 0, `stale: ${stale.status} ${show(devices)}`);
    const lines = everyLog.length;
    const moved = await subscribe(DANA, d);
    assert(moved.status === 200 && own(DANA).length === 1 && own(NOAM).length === 0, `moved: ${moved.status} ${show(devices)}`);
    assert(everyLog.slice(lines).some(l => l === `[push] user ${DANA}: device moved here from another account (1 on this account)`), `the line: ${show(everyLog.slice(lines))}`);
  });

  await check('subscribe: an account with a chat is refused 409 has-chat before anything is read or stored (Telegram, a WhatsApp phone, a WhatsApp BSUID), and the line says why', async () => {
    seed();
    for (const [id, method] of [[TAL, 'tg'], [WANDA, 'wa'], [BOAZ, 'wa']] as const) {
      const lines = everyLog.length;
      const res = await subscribe(id, mint(), { method });
      assert(res.status === 409 && show(await body(res)) === show({ ok: false, error: 'has-chat' }), `${id}: ${res.status} ${show(await body(res))}`);
      assert(everyLog.slice(lines).includes(`[push] user ${id}: subscribe refused: the account has a chat`), `${id}: ${show(everyLog.slice(lines))}`);
    }
    assert(devices.length === 0 && addCalls.length === 0, 'a device was stored');
  });

  await check('subscribe: a body that is not a device (not JSON, empty, an endpoint that is not a string, no keys) is 400 bad-input and stores nothing', async () => {
    seed();
    const cookie = await cookieOf(DANA);
    const raw = new NextRequest(`${BASE}${url(DANA)}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{not json' });
    const cases: Row[] = [{ body: {}, cookie }, { body: { endpoint: 5, keys: {} }, cookie }, { body: { endpoint: 'https://x.example/a' }, cookie }, { body: { endpoint: 'http://push.example.test/x', keys: { p256dh: P256DH, auth: AUTH } }, cookie }];
    const answers = [await post.POST(raw), ...(await Promise.all(cases.map(c => post.POST(request(url(DANA), c)))))];
    for (const res of answers) assert(res.status === 400 && show(await body(res)) === show({ ok: false, error: 'bad-input' }), `${res.status} ${show(await body(res))}`);
    assert(devices.length === 0 && addCalls.length === 0, 'something was stored');
  });

  await check('subscribe: a refused endpoint on a host that is not a push service logs that host only (no path, no query, no keys); any other bad input says only "bad input"', async () => {
    seed();
    const lines = everyLog.length;
    const unknown = await subscribe(DANA, { endpoint: 'https://unknown-push.example.test/send/path-secret-zzz?token=query-secret-qqq', keys: { p256dh: 'x', auth: 'y' } });
    const known = await subscribe(DANA, { endpoint: 'https://fcm.googleapis.com/fcm/send/path-secret-fcm', keys: { p256dh: 'x', auth: 'y' } });
    const notUrl = await subscribe(DANA, { endpoint: 'not a url', keys: { p256dh: 'x', auth: 'y' } });
    for (const res of [unknown, known, notUrl]) assert(res.status === 400, `${res.status}`);
    const got = everyLog.slice(lines).filter(l => l.startsWith('[push]'));
    assert(show(got) === show([
      `[push] user ${DANA}: subscribe refused: unknown push service unknown-push.example.test`,
      `[push] user ${DANA}: subscribe refused: bad input`,
      `[push] user ${DANA}: subscribe refused: bad input`,
    ]), `lines: ${show(got)}`);
    assert(!got.join('\n').match(/secret|token|keys/), 'a path, a query or a key reached the log');
    assert(devices.length === 0 && addCalls.length === 0, 'something was stored');
  });

  await check('the front: another origin or none is 403 cross_site and a body that is not JSON is 415, each before the limiter or the session is asked; no cookie is 401; the wrong account\'s id is 401', async () => {
    seed();
    const cookie = await cookieOf(DANA);
    const d = mint();
    for (const route of [(r: Row) => post.POST(r), (r: Row) => checkRoute.POST(r), (r: Row) => post.DELETE(r)]) {
      const none = await route(request(url(DANA), { body: d, cookie, origin: null }));
      assert(none.status === 403 && (await body(none)).error === 'cross_site', `no origin: ${none.status}`);
      const other = await route(request(url(DANA), { body: d, cookie, origin: 'https://evil.example' }));
      assert(other.status === 403 && (await body(other)).error === 'cross_site', `other origin: ${other.status}`);
      const form = await route(new NextRequest(`${BASE}${url(DANA)}`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: BASE, cookie }, body: JSON.stringify(d) }));
      assert(form.status === 415 && (await body(form)).error === 'json_only', `not JSON: ${form.status}`);
    }
    assert(limiterCalls.length === 0, `the limiter was asked before the origin check: ${show(limiterCalls)}`);
    const anon = await post.POST(request(url(DANA), { body: d }));
    assert(anon.status === 401, `no cookie: ${anon.status}`);
    const wrong = await post.POST(request(url(NOAM), { body: d, cookie }));
    assert(wrong.status === 401, `another account's id: ${wrong.status}`);
    assert(devices.length === 0, 'something was stored');
  });

  await check('the front: a Telegram initData request is refused (401) on all three routes, even from an account that exists, and nothing is stored; initData next to a valid cookie is ignored (the cookie still proves the person)', async () => {
    seed();
    const initData = initDataFor(TAL_TG);
    const d = mint();
    for (const [route, tail, method] of [[post.POST, '', 'POST'], [checkRoute.POST, '/check', 'POST'], [post.DELETE, '', 'DELETE']] as const) {
      const res = await route(request(url(TAL, tail), { method, body: d, initData }));
      assert(res.status === 401, `${method}${tail}: ${res.status}`);
    }
    assert(devices.length === 0, 'something was stored');
    const both = await post.POST(request(url(DANA), { body: mint(), cookie: await cookieOf(DANA), initData }));
    assert(both.status === 200, `a cookie with initData: ${both.status}`);
  });

  await check('push off (no VAPID keys): subscribe and check are 503 push-off, nothing stored; an unsubscribe still removes the device', async () => {
    seed();
    const d = mint();
    await subscribe(DANA, d);
    process.env.VAPID_PRIVATE_KEY = '';
    const sub = await subscribe(DANA, mint());
    assert(sub.status === 503 && show(await body(sub)) === show({ ok: false, error: 'push-off' }), `subscribe: ${sub.status} ${show(await body(sub))}`);
    const chk = await check_(DANA, d.endpoint);
    assert(chk.status === 503 && (await body(chk)).error === 'push-off', `check: ${chk.status}`);
    assert(own(DANA).length === 1, 'a device was added while off');
    const del = await unsubscribe(DANA, d.endpoint);
    assert(del.status === 200 && own(DANA).length === 0, `unsubscribe: ${del.status} ${show(devices)}`);
    process.env.VAPID_PRIVATE_KEY = 'smoke-private-key-not-a-real-one';
  });

  await check('the limiter: all three routes ask the push limiter keyed by the proved account (u<id>), and a spent bucket is 429 before anything is read or stored', async () => {
    seed();
    const d = mint();
    await subscribe(DANA, d);
    await check_(DANA, d.endpoint);
    await unsubscribe(DANA, d.endpoint);
    assert(show(limiterCalls) === show([['push-device', `u${DANA}`], ['push-device', `u${DANA}`], ['push-device', `u${DANA}`]]), `the limiter's calls: ${show(limiterCalls)}`);
    limited = true;
    const e = mint();
    const lines = everyLog.length;
    for (const res of [await subscribe(DANA, e), await check_(DANA, e.endpoint), await unsubscribe(DANA, e.endpoint)]) assert(res.status === 429, `${res.status}`);
    assert(devices.length === 0, 'a limited request stored something');
    assert(show(everyLog.slice(lines)) === show([`[push] user ${DANA}: push-devices refused: too many requests`, `[push] user ${DANA}: push-devices-check refused: too many requests`, `[push] user ${DANA}: push-devices-delete refused: too many requests`]), `the lines: ${show(everyLog.slice(lines))}`);
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/rate-limit.ts'), 'utf8');
    assert(/export const pushDeviceRateLimiter = new Ratelimit\(\{[^}]*slidingWindow\(20, '1 m'\)[^}]*prefix: 'ratelimit:push-device'/s.test(source), 'rate-limit.ts: the limiter is not 20 a minute under its own prefix');
  });

  await check('check: true for this account\'s own endpoint; false for another account\'s and for an unknown one, and those two answers are the same bytes; a session over an hour old is fine', async () => {
    seed();
    const mine = mint();
    const theirs = mint();
    await subscribe(DANA, mine);
    await subscribe(NOAM, theirs);
    const a = await check_(DANA, mine.endpoint, 5 * HOUR);
    assert(a.status === 200 && show(await body(a)) === show({ ok: true, mine: true }), `own: ${a.status} ${show(await body(a))}`);
    const other = await check_(DANA, theirs.endpoint);
    const unknown = await check_(DANA, 'https://push.example.test/send/nobody-has-this');
    assert(other.status === 200 && unknown.status === 200, `${other.status} ${unknown.status}`);
    assert((await other.clone().text()) === (await unknown.clone().text()) && show(await body(other)) === show({ ok: true, mine: false }), `another's ${await other.clone().text()} vs unknown ${await unknown.clone().text()}`);
    for (const bad of [undefined, 5, '', 'x'.repeat(1025)]) {
      const res = await check_(DANA, bad);
      assert(res.status === 400 && (await body(res)).error === 'bad-input', `${show(bad)?.slice(0, 20)}: ${res.status}`);
    }
  });

  await check('unsubscribe: removes only the caller\'s own device; another account\'s endpoint and an unknown one change nothing and answer 200 { ok: true } like a real removal; a stale session may remove; a bad body is 400', async () => {
    seed();
    const mine = mint();
    const theirs = mint();
    await subscribe(DANA, mine);
    await subscribe(NOAM, theirs);
    const lines = everyLog.length;
    const foreign = await unsubscribe(DANA, theirs.endpoint);
    assert(foreign.status === 200 && show(await body(foreign)) === show({ ok: true }) && own(NOAM).length === 1, `another account's: ${foreign.status} ${show(devices.map(d => d.userId))}`);
    const none = await unsubscribe(DANA, 'https://push.example.test/send/none');
    assert(none.status === 200 && show(await body(none)) === show({ ok: true }), `unknown: ${none.status}`);
    const gone = await unsubscribe(DANA, mine.endpoint, 9 * HOUR);
    assert(gone.status === 200 && show(await body(gone)) === show({ ok: true }) && own(DANA).length === 0, `own, stale session: ${gone.status} ${show(devices.map(d => d.userId))}`);
    assert(everyLog.slice(lines).filter(l => l.startsWith('[push]')).join('|') === `[push] user ${DANA}: device not found; nothing removed|[push] user ${DANA}: device not found; nothing removed|[push] user ${DANA}: device removed`, `lines: ${show(everyLog.slice(lines))}`);
    for (const bad of [undefined, 7, '']) {
      const res = await unsubscribe(DANA, bad);
      assert(res.status === 400 && (await body(res)).error === 'bad-input', `${show(bad)}: ${res.status}`);
    }
  });

  await check('a store that fails with the endpoint in its message is 500 failed, captured by its kind only (no endpoint, key or message), and nothing leaks into the answer', async () => {
    seed();
    const d = mint();
    addFails = Object.assign(new Error(`Invalid prisma.pushDevice.upsert() invocation: endpoint: "${d.endpoint}" p256dh: "${d.keys.p256dh}"`), { code: 'P2002' });
    const before = everyCapture.length;
    const res = await subscribe(DANA, d);
    assert(res.status === 500 && show(await body(res)) === show({ ok: false, error: 'failed' }), `${res.status} ${show(await body(res))}`);
    const caught = everyCapture.slice(before);
    assert(caught.length === 1 && caught[0].context === 'push-devices' && caught[0].message === 'push-devices: Error P2002' && caught[0].extra.user_id === DANA, `captured: ${show(caught)}`);
    await drainAfter();
    assert(sends.length === 0, 'a notification went after a failed store');
  });

  await check('pushPropsFor: null for Telegram\'s initData (no session) and for every account with a chat; a no-chat session gets the key, whether it was proved within the hour, and the device count', async () => {
    seed();
    const chatty = [{ id: TAL, telegramId: BigInt(TAL_TG) }, { id: WANDA, telegramId: null, whatsappPhone: '+972500000060' }, { id: BOAZ, telegramId: null, whatsappBsuid: 'IL.1' }];
    for (const user of chatty) assert((await pushPropsFor(user, { provedAt: Date.now() })) === null, `${user.id}: a chat account got props`);
    assert((await pushPropsFor({ id: DANA, telegramId: null }, null)) === null, 'initData got props');
    assert(countCalls === 0, 'devices were counted for a null prop');
    await subscribe(DANA, mint());
    await subscribe(DANA, mint());
    const now = Date.now();
    const props = await pushPropsFor({ id: DANA, telegramId: null }, { provedAt: now - 5 * 60_000 });
    assert(show(props) === show({ key: 'smoke-public-key-not-a-real-one', recentSignIn: true, devices: 2 }), `${show(props)}`);
    const old = await pushPropsFor({ id: DANA, telegramId: null }, { provedAt: now - 2 * HOUR });
    assert(old?.recentSignIn === false && old.devices === 2, `old: ${show(old)}`);
    const none = await pushPropsFor({ id: NOAM, telegramId: null, whatsappPhone: null, whatsappBsuid: null }, { provedAt: now });
    assert(none?.devices === 0 && none.key !== null, `no devices: ${show(none)}`);
  });

  await check('pushPropsFor: while push is off the key is null and no devices are counted (no query); a count that fails is captured (push-page-props) and reads as no devices', async () => {
    seed();
    process.env.VAPID_PUBLIC_KEY = '  ';
    const off = await pushPropsFor({ id: DANA, telegramId: null }, { provedAt: Date.now() });
    assert(show(off) === show({ key: null, recentSignIn: true, devices: 0 }) && countCalls === 0, `off: ${show(off)} counted ${countCalls}`);
    process.env.VAPID_PUBLIC_KEY = 'smoke-public-key-not-a-real-one';
    countFails = true;
    const before = everyCapture.length;
    const failed = await pushPropsFor({ id: DANA, telegramId: null }, { provedAt: Date.now() });
    assert(failed?.devices === 0 && failed.key !== null, `failed: ${show(failed)}`);
    const caught = everyCapture.slice(before);
    assert(caught.length === 1 && caught[0].context === 'push-page-props' && caught[0].extra.user_id === DANA, `captured: ${show(caught)}`);
    // by its kind only: the raw error's message (a Prisma error's can print the query's values) never reaches the capture
    assert(caught[0].message === 'push-page-props: Error' && !String(caught[0].message).includes('the count failed'), `the capture holds the error's message: ${show(caught[0].message)}`);
  });

  await check('pushPropsFor: a user row that carries its device count (pushDeviceCount, a number) is not counted by a query, even at zero or while a count would fail; a user without it is counted', async () => {
    seed();
    await subscribe(DANA, mint());
    const queries = countCalls;
    const withCount = await pushPropsFor({ id: DANA, telegramId: null, pushDeviceCount: 7 }, { provedAt: Date.now() });
    assert(withCount?.devices === 7, `the row's count was not used: ${show(withCount)}`);
    const zero = await pushPropsFor({ id: DANA, telegramId: null, pushDeviceCount: 0 }, { provedAt: Date.now() });
    assert(zero?.devices === 0, `a zero count was counted again: ${show(zero)}`);
    countFails = true;
    const before = everyCapture.length;
    const failing = await pushPropsFor({ id: DANA, telegramId: null, pushDeviceCount: 3 }, { provedAt: Date.now() });
    assert(failing?.devices === 3 && everyCapture.length === before, `a row with its count touched the failing query: ${show(failing)}`);
    countFails = false;
    assert(countCalls === queries, `a user with pushDeviceCount made ${countCalls - queries} count queries`);
    const without = await pushPropsFor({ id: DANA, telegramId: null }, { provedAt: Date.now() });
    assert(without?.devices === 1 && countCalls === queries + 1, `a user without the count was not counted once: ${show(without)} ${countCalls - queries}`);
  });

  await check('wiring: page-data hands the dashboard and Settings props the push prop from the session, the page-data route passes the proved-at of a session (null for initData), SettingsClient takes the prop, and the three routes share one front', () => {
    const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const pageData = read('src/lib/page-data.ts');
    assert((pageData.match(/pushPropsFor\(user, session\)/g) ?? []).length === 2, 'page-data: pushPropsFor(user, session) is not asked by both pages');
    assert(/return dashboard\(user, urlUserId, locale, session\)/.test(pageData) && /return settings\(user, urlUserId, userLocale, session\)/.test(pageData), 'page-data: the session is not passed on');
    assert((pageData.match(/^\s+push,$/gm) ?? []).length === 2, 'page-data: push is not in both props');
    assert(/push: PushPageProps \| null;/.test(pageData), 'DashboardPageProps has no push');
    const route = read('app/api/page-data/route.ts');
    assert(/auth\.via === 'session' \? \{ provedAt: auth\.session\.provedAt \} : null/.test(route) && /loadPageData\(.*, session\)/.test(route), 'the page-data route does not pass the session');
    assert(/push\?: PushPageProps \| null;/.test(read('app/[locale]/(app)/settings/SettingsClient.tsx')), 'SettingsClient takes no push prop');
    for (const rel of ['app/api/push/devices/route.ts', 'app/api/push/devices/check/route.ts']) {
      const text = read(rel);
      assert(/pushFront\(request, '[a-z-]+', \{ needsPushOn: (true|false) \}\)/.test(text), `${rel}: no pushFront`);
      assert(!/verifyUserAuth|refuseCrossSite/.test(text.replace(/^\s*\/\/.*$/gm, '')), `${rel}: its own auth, not the shared front`);
    }
    const deleteSource = read('app/api/push/devices/route.ts').split('export async function DELETE')[1];
    assert(/needsPushOn: false/.test(deleteSource) && !/refuseStaleSignIn/.test(deleteSource), 'DELETE: asks push on, or the hour');
    assert(/export async function POST/.test(read('app/api/push/devices/route.ts')) && /isOwnDevice\(userId, body\.endpoint\)/.test(read('app/api/push/devices/route.ts')), 'POST: the hour is not tied to a new endpoint');
  });

  await check('copy: bot.push.turnedOn and turnedOnBody are in en, he and ru, differ per language, and hold no emoji', () => {
    const seen = new Set<string>();
    for (const lang of ['en', 'he', 'ru']) {
      const words = MESSAGES[lang].bot.push;
      for (const key of ['turnedOn', 'turnedOnBody']) {
        assert(typeof words?.[key] === 'string' && words[key].length > 0, `${lang}.${key} is missing`);
        assert(!EMOJI.test(words[key]), `${lang}.${key} has an emoji`);
        seen.add(words[key]);
      }
    }
    assert(seen.size === 6, 'two languages share a text');
    assert(/[א-ת]/.test(MESSAGES.he.bot.push.turnedOn) && /[Ѐ-ӿ]/.test(MESSAGES.ru.bot.push.turnedOn), 'he or ru is not in its own letters');
  });

  await check('no endpoint, key or token of this run is in a console line, a capture or an answer\'s text', () => {
    const haystack = `${everyLog.join('\n')}\n${show(everyCapture)}`;
    for (const secret of secrets) assert(!haystack.includes(secret), `a secret reached a log or a capture: ${secret.slice(0, 40)}`);
    assert(secrets.size > 10, 'the run made too few secrets to mean anything');
  });

  report();
}

main().catch(err => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
